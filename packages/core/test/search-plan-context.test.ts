import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  consumeSearchPlan,
  createSearchPlan,
  resetSearchPlans,
  saveSearchConfig
} from '../src/web-search.js';

/**
 * 搜索计划里的笔记/批注上下文。
 *
 * 只按 `allow_notes` / `allow_annotations` 把 notes/annotations 的 `content`
 * 加进规划输入（最近 5 条、未删除），`allow_answer` / `allow_document` /
 * `allow_current_page` / `allow_surrounding` 尚未接入——这里同样不伪造。
 * 读取失败或没有内容不能阻断搜索计划，但输入必须脱敏后才外发。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-search-plan-context-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const db = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));

afterAll(() => {
  try {
    db.close();
  } catch {
    // 已关闭
  }
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSearchPlans();
});

function configure(overrides: Record<string, unknown> = {}): void {
  saveSearchConfig(store, secrets, {
    provider: 'deepseek',
    base_url: 'https://search.test',
    api_key: 'search-key',
    permission: 'auto',
    planner: true,
    // 这些用例验证「模型规划收到的输入」；keywords-only 已改为只做本地提取（P1-9），
    // 因此这里显式选 question 模式，模型规划才允许发生。
    privacy_mode: 'question',
    allow_question: false,
    allow_history: false,
    allow_selection: false,
    allow_notes: false,
    allow_annotations: false,
    ...overrides
  });
}

function configureChatModel(): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'chat-conn',
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://model.test/v1',
        models: [
          {
            id: 'chat-model',
            name: 'chat-model',
            capabilities: ['chat'],
            source: 'user',
            enabled: true
          }
        ]
      }
    ],
    routing: { chat: { connectionId: 'chat-conn', model: 'chat-model' } }
  });
}

/** 清掉某篇文献的笔记/批注并写入给定内容（notes/annotations 表由 Store 迁移建好）。 */
function seedContext(
  documentId: string,
  notes: string[] = [],
  annotations: string[] = []
): void {
  db.prepare('DELETE FROM notes WHERE document_id = ?').run(documentId);
  db.prepare('DELETE FROM annotations WHERE document_id = ?').run(documentId);
  notes.forEach((content, index) => {
    db.prepare(
      'INSERT INTO notes(id, document_id, page, quote, content, created, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(`n-${documentId}-${index}`, documentId, index + 1, '', content, `2026-01-01T00:00:0${index}Z`);
  });
  annotations.forEach((content, index) => {
    db.prepare(
      'INSERT INTO annotations(id, document_id, page, quote, content, rects, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(`a-${documentId}-${index}`, documentId, index + 1, '', content, '[]');
  });
}

/** 替身 fetch：只服务「搜索规划器」，返回固定 queries，并记录它收到的 user 文本。 */
function mockPlannerFetch(queries = ['alpha beta']): string[] {
  const userTexts: string[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    userTexts.push(messages.find((row) => row.role === 'user')?.content ?? '');
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ queries }) } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return userTexts;
}

describe('createSearchPlan 接入 notes/annotations', () => {
  it('allow_notes/allow_annotations=true 时规划输入含最近 5 条且已脱敏', async () => {
    configure({ allow_notes: true, allow_annotations: true });
    configureChatModel();
    seedContext(
      'doc-1',
      [
        '笔记1 最早',
        '笔记2',
        '笔记3',
        '笔记4',
        '笔记5 联系 a.b@example.com 或看 https://example.org/x 订单 1234567890',
        '笔记6 最新'
      ],
      ['批注A 提到某概念', '批注B 也提到']
    );
    const userTexts = mockPlannerFetch(['alpha beta']);
    const plan = await createSearchPlan(store, secrets, {
      question: '请查最新的量子纠缠进展',
      documentId: 'doc-1'
    });
    expect(plan.inputs).toEqual(['notes', 'annotations']);
    expect(plan.method).toContain('模型规划');
    const text = userTexts[0] ?? '';
    // 最近 5 条：笔记1 被挤掉；最新在前。
    expect(text).toContain('笔记6 最新');
    expect(text).not.toContain('笔记1 最早');
    expect(text.indexOf('笔记6 最新')).toBeLessThan(text.indexOf('笔记2'));
    expect(text).toContain('批注A');
    expect(text).toContain('批注B');
    // 脱敏：邮箱/网址/长数字都不可见。
    expect(text).toContain('[邮箱]');
    expect(text).toContain('[网址]');
    expect(text).toContain('[数字]');
    expect(text).not.toContain('a.b@example.com');
    expect(text).not.toContain('https://example.org/x');
    expect(text).not.toContain('1234567890');
  });

  it('关闭开关时不包含 notes/annotations（只发问题）', async () => {
    configure({ allow_question: true, allow_notes: false, allow_annotations: false });
    configureChatModel();
    seedContext('doc-1', ['不该外发的笔记'], ['不该外发的批注']);
    const userTexts = mockPlannerFetch();
    const plan = await createSearchPlan(store, secrets, {
      question: '只查问题的内容',
      documentId: 'doc-1'
    });
    expect(plan.inputs).toEqual(['question']);
    const text = userTexts[0] ?? '';
    expect(text).toContain('只查问题的内容');
    expect(text).not.toContain('不该外发的笔记');
    expect(text).not.toContain('不该外发的批注');
  });

  it('没有笔记/批注时不阻断，问题仍在输入里', async () => {
    configure({ allow_question: true, allow_notes: true, allow_annotations: true });
    configureChatModel();
    seedContext('doc-1', [], []);
    const userTexts = mockPlannerFetch();
    const plan = await createSearchPlan(store, secrets, {
      question: '没有上下文也要能规划',
      documentId: 'doc-1'
    });
    expect(plan.inputs).toEqual(['question']);
    expect(userTexts[0]).toContain('没有上下文也要能规划');
  });

  it('允许来源全关时仍按原逻辑报错（不因新增读取而吞掉错误）', async () => {
    configure({ allow_question: false, allow_notes: false, allow_annotations: false });
    configureChatModel();
    seedContext('doc-1', ['有笔记但没授权'], ['有批注但没授权']);
    await expect(
      createSearchPlan(store, secrets, { question: '无授权的问题', documentId: 'doc-1' })
    ).rejects.toThrow('没有获准用于搜索的内容');
  });

  it('笔记/批注读取失败不阻断（只是少了这一路输入）', async () => {
    configure({ allow_question: true, allow_notes: true, allow_annotations: true });
    configureChatModel();
    seedContext('doc-1', ['读不到的笔记'], ['读不到的批注']);
    vi.spyOn(store, 'listNotes').mockImplementation(() => {
      throw new Error('db 挂了');
    });
    vi.spyOn(store, 'listAnnotations').mockImplementation(() => {
      throw new Error('db 挂了');
    });
    const userTexts = mockPlannerFetch();
    const plan = await createSearchPlan(store, secrets, {
      question: '读取失败也要有答案',
      documentId: 'doc-1'
    });
    expect(plan.inputs).toEqual(['question']);
    expect(userTexts[0]).toContain('读取失败也要有答案');
  });

  it('笔记内容变化不影响搜索计划指纹（仍可复用已批准的计划）', async () => {
    configure({ allow_question: true, allow_notes: true });
    configureChatModel();
    seedContext('doc-1', ['第一版笔记']);
    mockPlannerFetch();
    const request = { question: '指纹不受笔记影响吗', documentId: 'doc-1' };
    const plan = await createSearchPlan(store, secrets, request);
    // 改笔记内容后再消费同一 token：指纹只含 question/documentId/selection/配置，不应失配。
    seedContext('doc-1', ['第二版笔记（改过了）']);
    expect(
      consumeSearchPlan(store, secrets, { ...request, search_token: plan.token })
    ).toEqual(plan.queries);
  });
});
