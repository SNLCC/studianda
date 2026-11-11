import { afterEach, describe, expect, it, vi } from 'vitest';
import { cost } from '../src/reading.js';
import { messages, PER_MESSAGE_COST } from '../src/request-budget.js';
import {
  callChatModel,
  historyCitationRule,
  historyContextRules,
  prepareHistory
} from '../src/reading-chat.js';

/**
 * 多轮历史进入回答/审计。
 *
 * 盯三件事：① 历史只收 user/assistant 的非空内容并限长限量；② 超容量时**从最旧丢**、
 * 丢了几轮如实计数（调用方据此写 notice）；③ 历史确实作为 prior 进入请求体。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const pairs = [
  { question: '问一', answer: '答一' },
  { question: '问二', answer: '答二' },
  { question: '问三', answer: '答三' },
  { question: '问四', answer: '答四' }
];

describe('prepareHistory 过滤与格式', () => {
  it('问答对按原顺序转成 user/assistant；空内容不产生消息', () => {
    const prepared = prepareHistory([
      { question: '问一', answer: '答一' },
      { question: '', answer: '' },
      { question: '问二' }
    ]);
    expect(prepared.prior).toEqual([
      { role: 'user', content: '问一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '问二' }
    ]);
    expect(prepared.dropped).toBe(0);
  });

  it('也接受 {role,content} 形状；非法 role 与空内容丢弃', () => {
    const prepared = prepareHistory([
      { role: 'system', content: '系统指令' },
      { role: 'user', content: '  ' },
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' },
      { role: 'tool', content: '工具输出' }
    ]);
    expect(prepared.prior).toEqual([
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' }
    ]);
  });

  it('单条内容截到 4000 字；非对象/非法输入忽略', () => {
    const prepared = prepareHistory([
      null,
      '字符串',
      42,
      { question: '长'.repeat(5000), answer: undefined }
    ]);
    expect(prepared.prior).toHaveLength(1);
    expect(prepared.prior[0]!.role).toBe('user');
    expect(prepared.prior[0]!.content).toHaveLength(4000);
    expect(prepareHistory(undefined).prior).toEqual([]);
    expect(prepareHistory('not-array').prior).toEqual([]);
  });

  it('最多保留最近 20 条；被条数上限裁掉的部分按轮计入 dropped', () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      question: `问${index + 1}`,
      answer: `答${index + 1}`
    }));
    const prepared = prepareHistory(history);
    expect(prepared.prior).toHaveLength(20);
    // 25 轮 = 50 条；最近 20 条从「问16」开始，旧 30 条 = 15 轮被省略。
    expect(prepared.prior[0]).toEqual({ role: 'user', content: '问16' });
    expect(prepared.dropped).toBe(15);
  });
});

describe('prepareHistory 容量裁剪（从最旧丢）', () => {
  const messageCost = (content: string): number => cost(content) + PER_MESSAGE_COST;

  it('预算只够最后一轮时，保留最新一轮并如实报告丢了几轮', () => {
    const room = messageCost('问四') + messageCost('答四');
    const prepared = prepareHistory(pairs, room);
    expect(prepared.prior).toEqual([
      { role: 'user', content: '问四' },
      { role: 'assistant', content: '答四' }
    ]);
    expect(prepared.dropped).toBe(3);
  });

  it('预算为 0 / 负数时历史全丢（不静默：dropped 计数）', () => {
    expect(prepareHistory(pairs, 0)).toEqual({ prior: [], dropped: 4 });
    expect(prepareHistory(pairs, -100)).toEqual({ prior: [], dropped: 4 });
  });

  it('预算充足时不丢任何历史', () => {
    expect(prepareHistory(pairs, 1_000_000)).toEqual({
      prior: [
        { role: 'user', content: '问一' },
        { role: 'assistant', content: '答一' },
        { role: 'user', content: '问二' },
        { role: 'assistant', content: '答二' },
        { role: 'user', content: '问三' },
        { role: 'assistant', content: '答三' },
        { role: 'user', content: '问四' },
        { role: 'assistant', content: '答四' }
      ],
      dropped: 0
    });
  });

  it('丢整轮：不会留下没有提问的答', () => {
    // 只够最后两条消息里的一条：整轮一起丢，结果为空。
    const room = messageCost('答四');
    const prepared = prepareHistory(pairs, room);
    expect(prepared.prior).toEqual([]);
    expect(prepared.dropped).toBe(4);
  });
});

describe('callChatModel 透传 prior', () => {
  it('请求体包含历史，且顺序为 system→prior→user（与 request_budget.messages 一致）', async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: { body: string }) => {
        void init;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '回答' } }] })
        } as unknown as Response;
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    const prior = [
      { role: 'user' as const, content: '上一问' },
      { role: 'assistant' as const, content: '上一答' }
    ];
    const answer = await callChatModel(
      { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'mock' },
      '系统指令',
      '本轮材料',
      1200,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      prior
    );
    expect(answer).toBe('回答');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual(messages('系统指令', '本轮材料', prior));
    expect(body.messages.map((row) => row.content)).toContain('上一问');
    expect(body.messages.map((row) => row.content)).toContain('上一答');
  });

  it('不传 prior 时请求体仍只有 system+user（兼容既有调用）', async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: { body: string }) => {
        void init;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'ok' } }] })
        } as unknown as Response;
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    await callChatModel(
      { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'mock' },
      '系统',
      '材料'
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toHaveLength(2);
  });

  it('有历史时引用隔离规则只出现一次且空历史不追加', () => {
    expect(historyCitationRule(undefined)).toBe('');
    expect(historyCitationRule([])).toBe('');
    const rule = historyCitationRule([{ role: 'user', content: '上一问' }]);
    expect(rule).toContain('只属于当时那一轮');
    expect(rule).toContain('不能当作本轮引用');
    expect(rule).toContain('本轮引用只能指向本轮材料');
  });

  it('有摘要时追加「摘要不是证据」规则，没摘要时与引用规则一致', () => {
    const history = [{ question: '上一问', answer: '上一答' }];
    expect(historyContextRules(history, '')).toBe(historyCitationRule(history));
    const withSummary = historyContextRules(history, '早期摘要：用户关注测量口径。');
    expect(withSummary).toContain('早期摘要');
    expect(withSummary).toContain('不是文献原文/证据');
    expect(withSummary).toContain('不要从摘要里生成或沿用 [1][2]');
    expect(withSummary).toContain('只属于当时那一轮');
  });
});
