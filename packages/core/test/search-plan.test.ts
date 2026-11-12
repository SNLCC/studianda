import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { answerQuestion } from '../src/chat.js';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import {
  createSearchPlan,
  consumeSearchPlan,
  getSearchConfig,
  redactSearchText,
  resetSearchPlans,
  saveSearchConfig
} from '../src/web-search.js';

const token = 'search-plan-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-search-plan-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSearchPlans();
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function configureSearch(overrides: Record<string, unknown> = {}): void {
  saveSearchConfig(store, secrets, {
    provider: 'deepseek',
    base_url: 'https://search.test',
    api_key: 'search-key',
    permission: 'auto',
    planner: false,
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
  secrets.set('platform.chat-conn.api_key', 'k-1');
}

/** 替身 fetch：DeepSeek Search 返回两条结果，模型返回固定答案/规划。 */
function mockWebFetch(
  plannerQueries = ['alpha beta']
): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ url, body });
    if (url.includes('search.test/v1/tools/search')) {
      const query = String(body.query ?? '');
      return new Response(
        JSON.stringify({
          results: [
            { url: 'https://example.org/a', title: 'A', snippet: `A: ${query}` },
            { url: 'https://example.org/b', title: 'B', snippet: `B: ${query}` }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    if (system.includes('搜索规划器')) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ queries: plannerQueries }) } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '联网答案' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return calls;
}

beforeAll(() => {
  configureSearch();
  configureChatModel();
});

describe('redactSearchText', () => {
  it('removes emails, urls and long digit runs', () => {
    const redacted = redactSearchText(
      '联系 a.b@example.com 或看 https://example.org/x 订单 1234567890'
    );
    expect(redacted).toContain('[邮箱]');
    expect(redacted).toContain('[网址]');
    expect(redacted).toContain('[数字]');
    expect(redacted).not.toContain('a.b@example.com');
    expect(redacted).not.toContain('https://example.org/x');
    expect(redacted).not.toContain('1234567890');
  });
});

describe('createSearchPlan', () => {
  it('builds redacted local keyword queries when the planner is off', async () => {
    configureSearch({ planner: false });
    const plan = await createSearchPlan(store, secrets, {
      question: '量子纠缠 与 123456789 邮箱 q@example.com 网址 https://x.test/a'
    });
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(plan.method).toBe('本地关键词提取');
    expect(plan.review).toBe(false);
    expect(plan.provider).toBe('deepseek');
    expect(plan.planner_destination).toBe('本机');
    expect(plan.inputs).toContain('question');
    expect(plan.warning).toContain('不等于完全匿名');
    const joined = plan.queries.join(' ');
    expect(joined).not.toContain('q@example.com');
    expect(joined).not.toContain('https://x.test');
    expect(joined).not.toContain('123456789');
  });

  it('uses the chat model planner and reports its destination', async () => {
    configureSearch({ planner: true, privacy_mode: 'question' });
    configureChatModel();
    const calls = mockWebFetch(['alpha beta', 'gamma delta']);
    const plan = await createSearchPlan(store, secrets, {
      question: '请查最新的量子纠缠进展',
      documentId: 'doc-1'
    });
    expect(plan.method).toContain('模型规划');
    expect(plan.queries).toEqual(['alpha beta', 'gamma delta']);
    expect(plan.planner_destination).toBe('https://model.test/v1');
    expect(calls[0]!.url).toContain('model.test/v1/chat/completions');
    const system = ((calls[0]!.body.messages as Array<{ content: string }>)[0]?.content ?? '');
    expect(system).toContain('搜索规划器');
  });

  it('keeps keywords-only fully local and never asks the chat model to plan', async () => {
    // 隐私模式 P1-9：即使配置里开了模型规划，keywords-only 也必须只做本地关键词提取。
    configureSearch({ planner: true, privacy_mode: 'keywords-only' });
    configureChatModel();
    const calls = mockWebFetch();
    const plan = await createSearchPlan(store, secrets, {
      question: '请查最新的量子纠缠进展，并核对 123456789',
      selection: '量子纠缠实验的逐字选文'
    });
    expect(plan.method).toBe('本地关键词提取');
    expect(plan.planner_destination).toBe('本机');
    expect(plan.queries.length).toBeGreaterThan(0);
    // 一个模型请求都不能发出：问题/选文只在本机被提取成关键词。
    expect(calls).toEqual([]);
    configureSearch();
  });

  it('returns an empty plan instead of throwing when there is nothing to search', async () => {
    // 用户报告（bug 10）：会话里发「你好」不应报「搜索计划生成失败」。
    // 规划结果清洗后没有主体词时返回合法空计划，客户端据此直接不联网提问。
    configureSearch({ planner: true, privacy_mode: 'question' });
    configureChatModel();
    mockWebFetch(['   ']);
    const plan = await createSearchPlan(store, secrets, { question: '你好' });
    expect(plan.queries).toEqual([]);
    expect(plan.token).toBe('');
    expect(plan.review).toBe(false);
    expect(plan.method).toContain('模型规划');
    expect(plan.warning).toContain('没有可公开搜索的主题词');
    expect(plan.warning).toContain('不联网');
    configureSearch();
  });

  it('treats an empty planner result as "nothing to search" (寒暄 like 你好)', async () => {
    configureSearch({ planner: true, privacy_mode: 'question' });
    configureChatModel();
    const calls = mockWebFetch([]);
    const plan = await createSearchPlan(store, secrets, { question: '你好' });
    expect(plan.queries).toEqual([]);
    expect(plan.token).toBe('');
    expect(plan.review).toBe(false);
    expect(plan.method).toContain('模型规划');
    expect(plan.warning).toContain('不联网');
    // 规划模型确实被问过（但不是把「你好」拿去联网搜索）。
    expect(calls[0]?.url).toContain('model.test/v1/chat/completions');
    configureSearch();
  });

  it('falls back to local keyword extraction when the planner format is invalid', async () => {
    configureSearch({ planner: true, privacy_mode: 'question' });
    configureChatModel();
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '这里不是 JSON' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const plan = await createSearchPlan(store, secrets, { question: '量子纠缠的最新实验进展' });
    expect(plan.method).toContain('本地关键词提取');
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.queries.join(' ')).toContain('量子纠缠');
    configureSearch();
  });

  it('rejects when online search is not allowed', async () => {
    configureSearch({ permission: 'off' });
    await expect(
      createSearchPlan(store, secrets, { question: '最新进展' })
    ).rejects.toThrow('允许联网搜索');
    configureSearch();
  });
});

describe('consumeSearchPlan', () => {
  it('can be reused for an idempotent retry within 10 minutes', async () => {
    configureSearch();
    const request = { question: '为什么天空是蓝的', documentId: 'doc-1', selection: '天空' };
    const plan = await createSearchPlan(store, secrets, request);
    const body = { ...request, search_token: plan.token };
    expect(consumeSearchPlan(store, secrets, body)).toEqual(plan.queries);
    // 重发同一请求（继续阅读/失败重试）应复用，而不是报"已消费"。
    expect(consumeSearchPlan(store, secrets, body)).toEqual(plan.queries);
  });

  it('rejects and drops a token when the question changed', async () => {
    configureSearch();
    const plan = await createSearchPlan(store, secrets, { question: '问题甲' });
    expect(() =>
      consumeSearchPlan(store, secrets, { question: '问题乙', search_token: plan.token })
    ).toThrow('搜索计划已过期或配置/问题已改变，请重新确认');
    // 指纹不符会被清掉：原始请求也不能再用。
    expect(() =>
      consumeSearchPlan(store, secrets, { question: '问题甲', search_token: plan.token })
    ).toThrow('搜索计划已过期或配置/问题已改变，请重新确认');
  });

  it('rejects an expired token', async () => {
    configureSearch();
    const plan = await createSearchPlan(store, secrets, { question: '多久过期' });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expect(() =>
        consumeSearchPlan(store, secrets, { question: '多久过期', search_token: plan.token })
      ).toThrow('搜索计划已过期或配置/问题已改变，请重新确认');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown token', () => {
    expect(() =>
      consumeSearchPlan(store, secrets, { question: 'x', search_token: 'bogus' })
    ).toThrow('搜索计划已过期或配置/问题已改变，请重新确认');
  });
});

describe('plan consumption inside chat', () => {
  it('searches exactly the planned queries and answers from web results', async () => {
    configureSearch({ planner: false });
    configureChatModel();
    const calls = mockWebFetch();
    const question = '为什么天空是蓝的，联网查一下';
    const plan = await createSearchPlan(store, secrets, { question });
    const answer = await answerQuestion(store, secrets, {
      question,
      confirmSearch: true,
      search_token: plan.token
    });
    expect(answer.web_search).toBe(true);
    expect(answer.notice).toContain('已按确认的搜索计划');
    const searchCalls = calls.filter((call) => call.url.includes('search.test/v1/tools/search'));
    expect(searchCalls.length).toBe(plan.queries.length);
    expect(answer.answer).toBe('联网答案');
    // 仅联网回答也返回结构化网页来源（可点击回溯），不再只有域名分层。
    expect(answer.sources.length).toBeGreaterThan(0);
    expect(answer.sources.every((source) => source.kind === 'web' && Boolean(source.url))).toBe(
      true
    );
    expect(answer.sources[0]?.documentName).toBeTruthy();
  });

  it('requires explicit confirmation in review mode', async () => {
    configureSearch({ permission: 'review', planner: false });
    configureChatModel();
    mockWebFetch();
    const question = '为什么天空是蓝的，联网查一下';
    const plan = await createSearchPlan(store, secrets, { question });
    await expect(
      answerQuestion(store, secrets, { question, search_token: plan.token })
    ).rejects.toThrow('搜索计划需要确认后才能使用');
    const confirmed = await answerQuestion(store, secrets, {
      question,
      confirmSearch: true,
      search_token: plan.token
    });
    expect(confirmed.web_search).toBe(true);
    configureSearch();
  });

});

describe('HTTP endpoints', () => {
  it('serves a search plan', async () => {
    configureSearch({ planner: false });
    mockWebFetch();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/search-plan',
      headers: headers(),
      payload: { question: '量子纠缠 123456789' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      token: string;
      queries: string[];
      review: boolean;
      warning: string;
    };
    expect(body.token).toBeTruthy();
    expect(body.queries.length).toBeGreaterThan(0);
    expect(body.warning).toContain('不等于完全匿名');
  });

  it('returns an empty (no-search) plan instead of failing for greetings', async () => {
    configureSearch({ planner: true, privacy_mode: 'question' });
    configureChatModel();
    mockWebFetch([]);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/search-plan',
      headers: headers(),
      payload: { question: '你好' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; queries: string[]; warning: string };
    expect(body.queries).toEqual([]);
    expect(body.token).toBe('');
    expect(body.warning).toContain('不联网');
    configureSearch();
  });

  it('returns 403 when online search is off', async () => {
    configureSearch({ permission: 'off' });
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/search-plan',
      headers: headers(),
      payload: { question: '最新进展' }
    });
    expect(response.statusCode).toBe(403);
    configureSearch();
  });

  it('rejects an invalid search token on /chat/ask with a clear message', async () => {
    configureSearch({ planner: false });
    configureChatModel();
    mockWebFetch();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: {
        question: '为什么天空是蓝的，联网查一下',
        confirmSearch: true,
        search_token: 'bogus-token'
      }
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('搜索计划已过期或配置/问题已改变');
  });
});
