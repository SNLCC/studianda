import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingChatConfig } from '../src/reading-chat.js';
import {
  needsConversationContext,
  prepareQaConversation,
  qaHistoryMessages,
  pickQaCompactionChunk,
  resetQaCompactionBackoff,
  retrievalQueryForConversation,
  trimQaHistory
} from '../src/qa-context.js';
import { Store } from '../src/store.js';

/**
 * 独立问答的完整历史 + 超预算摘要压缩（agent-harness 式上下文）。
 *
 * 用真实 Store（临时目录）+ 模拟模型服务（vi.stubGlobal('fetch')）；
 * 不联网，也不会真的写到用户数据目录。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-qa-context-'));
let store: Store;

const config: ReadingChatConfig = {
  baseUrl: 'https://model.example.com/v1',
  apiKey: 'test-key',
  model: 'chat-model'
};

const SUMMARY = '压缩摘要：用户问过甲文献的核心概念，已得到定义与边界两个结论。';

function longText(tag: string, chars = 1500): string {
  return `${tag}：${'价值信念的边界与测量口径'.repeat(Math.ceil(chars / 11)).slice(0, chars)}`;
}

function shortText(tag: string, chars = 40): string {
  return `${tag}：${'补充说明'.repeat(Math.ceil(chars / 4)).slice(0, chars)}`;
}

function seedSession(pairs: Array<[string, string]>): string {
  const session = store.createQaSession('上下文测试');
  for (const [question, answer] of pairs) {
    store.appendQaMessage({ sessionId: session.id, role: 'user', content: question });
    store.appendQaMessage({
      sessionId: session.id,
      role: 'assistant',
      content: answer,
      response: { answer, sources: [] },
      answered: true
    });
  }
  return session.id;
}

/** 模拟模型：摘要调用返回固定摘要，并记录请求体。 */
function stubModel(overrides?: { fail?: boolean }): Array<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      captured.push(body);
      if (overrides?.fail) {
        throw new TypeError('网络不可用');
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: SUMMARY } }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      );
    })
  );
  return captured;
}

beforeAll(() => {
  store = new Store(dataDir);
});

beforeEach(() => {
  resetQaCompactionBackoff();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetQaCompactionBackoff();
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('prepareQaConversation：完整历史与压缩', () => {
  it('历史装得下时：完整保留原文、不调用模型压缩', async () => {
    stubModel();
    const sessionId = seedSession([
      ['问题一', '回答一'],
      ['问题二', '回答二']
    ]);
    // 最后一条是服务端本轮刚落库的用户消息：不能重复进历史。
    store.appendQaMessage({ sessionId, role: 'user', content: '当前问题' });
    const session = store.getQaSession(sessionId);
    expect(session).not.toBeNull();
    const conversation = await prepareQaConversation({
      store,
      session: session!,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题\n库内检索原文片段：甲',
      question: '当前问题',
      inputLimit: 12000
    });
    expect(conversation.stats.compacted).toBe(0);
    expect(conversation.stats.dropped).toBe(0);
    expect(conversation.summaryBlock).toBe('');
    expect(conversation.prior.map((row) => row.content)).toEqual([
      '问题一',
      '回答一',
      '问题二',
      '回答二'
    ]);
    expect(conversation.prior.some((row) => row.content === '当前问题')).toBe(false);
    // 没触发压缩时不调用模型。
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('历史超预算时：旧轮次压缩成摘要并落库，后续轮次复用摘要不再重复压缩', async () => {
    const captured = stubModel();
    const sessionId = seedSession([
      [longText('问题一'), longText('回答一')],
      [longText('问题二'), longText('回答二')],
      [longText('问题三'), longText('回答三')],
      [shortText('问题四'), shortText('回答四')],
      [shortText('问题五'), shortText('回答五')]
    ]);
    store.appendQaMessage({ sessionId, role: 'user', content: '当前问题' });
    const session = store.getQaSession(sessionId)!;
    const conversation = await prepareQaConversation({
      store,
      session,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题\n库内检索原文片段：甲文献第一页',
      question: '当前问题',
      inputLimit: 12000
    });

    // 触发了一次压缩：调用 1 次模型、摘要落库、旧消息不再以原文进上下文。
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(conversation.stats.compacted).toBeGreaterThan(0);
    expect(conversation.summaryBlock).toContain(SUMMARY);
    expect(conversation.prior.length).toBeLessThan(10);
    expect(conversation.prior.length).toBeGreaterThan(0);
    const firstCall = captured[0]!;
    const messages = (firstCall.messages ?? []) as Array<{ role: string; content: string }>;
    expect(messages.some((message) => message.content.includes('会话历史压缩器'))).toBe(true);
    expect(messages.map((message) => message.content).join('\n')).toContain('问题一');

    const stored = store.getQaSession(sessionId)!;
    expect(stored.contextSummary).toContain(SUMMARY);
    expect(stored.summaryUpto).toBeGreaterThan(0);
    expect(stored.compacted).toBe(true);

    // 下一轮：摘要已在会话里，剩余历史装得下 → 不再调用模型压缩。
    const again = await prepareQaConversation({
      store,
      session: stored,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：追问\n库内检索原文片段：甲文献第一页',
      question: '追问',
      inputLimit: 12000
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(again.summaryBlock).toContain(SUMMARY);
    expect(again.stats.summary_used).toBe(true);
    expect(again.stats.compacted).toBe(0);
  });

  it('压缩调用失败时：不阻断回答，按容量从最旧丢弃并如实返回 dropped', async () => {
    stubModel({ fail: true });
    const sessionId = seedSession([
      [longText('问题一'), longText('回答一')],
      [longText('问题二'), longText('回答二')],
      [longText('问题三'), longText('回答三')]
    ]);
    store.appendQaMessage({ sessionId, role: 'user', content: '当前问题' });
    const session = store.getQaSession(sessionId)!;
    const conversation = await prepareQaConversation({
      store,
      session,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题\n库内检索原文片段：甲文献第一页',
      question: '当前问题',
      inputLimit: 12000
    });
    expect(conversation.stats.compacted).toBe(0);
    expect(conversation.stats.dropped).toBeGreaterThan(0);
    expect(conversation.summaryBlock).toBe('');
    expect(conversation.prior.length).toBeLessThan(6);
    // 失败时不写摘要，下一次仍可再尝试压缩。
    expect(store.getQaSession(sessionId)!.contextSummary).toBe('');
  });

  it('没有模型配置时不做摘要调用，只按容量丢弃', async () => {
    stubModel();
    const sessionId = seedSession([
      [longText('问题一'), longText('回答一')],
      [longText('问题二'), longText('回答二')]
    ]);
    const session = store.getQaSession(sessionId)!;
    const conversation = await prepareQaConversation({
      store,
      session,
      config: null,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题',
      question: '当前问题',
      inputLimit: 3000
    });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(conversation.stats.dropped).toBeGreaterThan(0);
  });
});

describe('历史还原与裁剪的细节', () => {
  it('失败/占位回答不进入上下文，空消息也跳过', () => {
    const messages = [
      { id: 1, sessionId: 's', role: 'user' as const, content: '问题', response: null, answered: true, created: '' },
      { id: 2, sessionId: 's', role: 'assistant' as const, content: '回答', response: null, answered: true, created: '' },
      { id: 3, sessionId: 's', role: 'assistant' as const, content: '回答未完成：网络错误', response: null, answered: false, created: '' },
      { id: 4, sessionId: 's', role: 'user' as const, content: '   ', response: null, answered: true, created: '' }
    ];
    expect(qaHistoryMessages(messages)).toEqual([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' }
    ]);
  });

  it('trimQaHistory 按整轮丢弃，不留下没有提问的回答', () => {
    const kept = trimQaHistory(
      [
        { role: 'user', content: '很旧的问题' },
        { role: 'assistant', content: '很旧的回答' },
        { role: 'user', content: '新的问题' },
        { role: 'assistant', content: '新的回答' }
      ],
      60
    );
    expect(kept.dropped).toBe(1);
    expect(kept.kept.map((row) => row.content)).toEqual(['新的问题', '新的回答']);
  });

  it('pickQaCompactionChunk 只取最旧的一段，材料里带角色标签', () => {
    const rows = [
      { id: 1, sessionId: 's', role: 'user' as const, content: '旧问题', response: null, answered: true, created: '' },
      { id: 2, sessionId: 's', role: 'assistant' as const, content: '旧回答', response: null, answered: true, created: '' },
      { id: 3, sessionId: 's', role: 'user' as const, content: '新问题', response: null, answered: true, created: '' }
    ];
    const chunk = pickQaCompactionChunk(rows, '', 12000);
    expect(chunk).not.toBeNull();
    expect(chunk!.rows.length).toBeGreaterThan(0);
    expect(chunk!.material).toContain('用户：旧问题');
    expect(chunk!.material).toContain('助手：旧回答');
  });

  it('压缩块不会以没有回答的 user 消息结尾（多个容量下都成立）', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      sessionId: 's',
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText(`消息${index + 1}`, 500),
      response: null,
      answered: true,
      created: ''
    }));
    let sawBoundaryCase = false;
    for (const limit of [2600, 3000, 3600, 4200, 4800, 5400, 6000, 7000, 8000, 9000, 12000]) {
      const chunk = pickQaCompactionChunk(rows, '', limit);
      if (!chunk) continue;
      expect(chunk.rows.at(-1)?.role).not.toBe('user');
      if (chunk.rows.length < 8) sawBoundaryCase = true;
    }
    // 至少要覆盖到「按容量截断」的情况，避免测试形同虚设。
    expect(sawBoundaryCase).toBe(true);
  });
});

describe('追问检索、容量说明与压缩失败退避', () => {
  it('只有短问题/含指代词的问题才把会话上文拼进检索查询', () => {
    const history = [
      { question: 'value belief 是什么', answer: '它是一种稳定的信念。' },
      { question: '它和态度有什么区别', answer: '文中说态度更宽泛。' }
    ];
    expect(needsConversationContext('那它的测量口径呢？')).toBe(true);
    expect(needsConversationContext('请解释一下这')).toBe(true);
    const augmented = retrievalQueryForConversation('那它的测量口径呢？', history);
    expect(augmented).toContain('会话上文');
    expect(augmented).toContain('value belief 是什么');
    expect(augmented).toContain('那它的测量口径呢？');

    // 长且自足的问题不拼上文（避免把旧话题的检索词带进来）。
    const standalone = '请比较康德与休谟在道德动机问题上的核心差异，并引用原文说明';
    expect(needsConversationContext(standalone)).toBe(false);
    expect(retrievalQueryForConversation(standalone, history)).toBe(standalone);
    // 没有历史时原样返回。
    expect(retrievalQueryForConversation('它呢？', [])).toBe('它呢？');
  });

  it('容量丢弃时生成给模型看的说明（不能假装看到过被丢的历史）', async () => {
    stubModel();
    const sessionId = seedSession([
      [longText('问题一'), longText('回答一')],
      [longText('问题二'), longText('回答二')]
    ]);
    store.appendQaMessage({ sessionId, role: 'user', content: '当前问题' });
    const session = store.getQaSession(sessionId)!;
    const conversation = await prepareQaConversation({
      store,
      session,
      config: null,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题',
      question: '当前问题',
      inputLimit: 1200
    });
    expect(conversation.stats.dropped).toBeGreaterThan(0);
    expect(conversation.omittedBlock).toContain('容量限制');
    expect(conversation.omittedBlock).toContain('不要假装看到过');
  });

  it('压缩失败后进入冷却：紧接着的下一轮不再重复发起注定失败的摘要调用', async () => {
    stubModel({ fail: true });
    const sessionId = seedSession([
      [longText('问题一'), longText('回答一')],
      [longText('问题二'), longText('回答二')],
      [longText('问题三'), longText('回答三')]
    ]);
    store.appendQaMessage({ sessionId, role: 'user', content: '当前问题' });
    const session = store.getQaSession(sessionId)!;
    const first = await prepareQaConversation({
      store,
      session,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题\n库内检索原文片段：甲',
      question: '当前问题',
      inputLimit: 12000
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(first.stats.dropped).toBeGreaterThan(0);

    const second = await prepareQaConversation({
      store,
      session: store.getQaSession(sessionId)!,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题\n库内检索原文片段：甲',
      question: '当前问题',
      inputLimit: 12000
    });
    // 冷却期内不再发起第二次注定失败的压缩调用。
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(second.stats.compacted).toBe(0);
  });

  it('压缩提示词：保留依据但不保留旧引用编号（避免跨轮编号串台）', async () => {
    const captured = stubModel();
    const sessionId = seedSession([
      [longText('问题一'), longText('回答一')],
      [longText('问题二'), longText('回答二')],
      [longText('问题三'), longText('回答三')]
    ]);
    store.appendQaMessage({ sessionId, role: 'user', content: '当前问题' });
    await prepareQaConversation({
      store,
      session: store.getQaSession(sessionId)!,
      config,
      baseSystem: '你是本地文献库问答助手。',
      user: '问题：当前问题\n库内检索原文片段：甲',
      question: '当前问题',
      inputLimit: 12000
    });
    const body = captured[0]!;
    const system = ((body.messages ?? []) as Array<{ role: string; content: string }>)
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain('不要保留 [数字] 引用编号');
    expect(system).toContain('只根据给定内容压缩，不编造、不添加新结论');
  });
});
