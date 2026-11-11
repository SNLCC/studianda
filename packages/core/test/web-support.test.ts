import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 聊天级测试：问题路由与阅读链都替身化（本任务只验证联网补查记账/notice，不跑真实阅读）。
vi.mock('../src/question-route.js', () => ({
  routeQuestion: vi.fn(async () => ({
    document: true,
    search: false,
    reason: '测试：直接读文献',
    reply: '',
    modelPlan: false,
    plan: null
  }))
}));
vi.mock('../src/reading-chat.js', () => ({
  answerWithReading: vi.fn(),
  answerWithCorpus: vi.fn(),
  callChatModel: vi.fn()
}));

import type { ChatRequest, ChatResponse } from '@studianda/shared';
import type { ClaimRoute } from '../src/audit.js';
import { answerQuestion } from '../src/chat.js';
import { saveModelServices } from '../src/model-services.js';
import { answerWithReading } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { saveSearchConfig } from '../src/web-search.js';
import { autoSourceQueries, mergeWebReviews, whyNotOnline } from '../src/web-support.js';

function routeFixture(
  claim: number,
  claim_type: string,
  extra: Partial<ClaimRoute> = {}
): ClaimRoute {
  return {
    claim,
    claim_type,
    evidence_standard: 'SCHOLARLY',
    suggested: '学术资料',
    source_order: ['文献原文', '学术资料'],
    needs_external: true,
    blocked_external: ['学术资料'],
    reason: '按性质需要外部依据',
    ...extra
  };
}

describe('whyNotOnline', () => {
  it('仅文献优先：不发送任何外部请求', () => {
    expect(whyNotOnline('document_only', { status: '已按论断缺口查证（2 条网页依据）' })).toBe(
      '说明：设置里「智能来源」选的是「仅文献」，本轮不发送任何外部请求，因此没有联网核验。'
    );
  });

  it('已查证：说明这一节仍是模型知识', () => {
    expect(whyNotOnline(undefined, { status: '已按论断缺口查证（2 条网页依据）' })).toBe(
      '说明：本轮已按论断缺口查证（已按论断缺口查证（2 条网页依据））；这一节仍是模型自身的知识，不是网页结论。'
    );
    expect(whyNotOnline(undefined, { status: '已查证，但没有取得可用网页依据' })).toContain(
      '本轮已按论断缺口查证'
    );
  });

  it('未发起：把原因写清楚', () => {
    expect(whyNotOnline(undefined, { status: '未发起：需要你先确认联网搜索（本轮没有自动弹确认）' })).toBe(
      '说明：本轮没有发起联网查证——需要你先确认联网搜索（本轮没有自动弹确认）'
    );
  });

  it('用户关闭联网 / 未同意新增搜索 / 无外部论断 / 查证未完成', () => {
    expect(whyNotOnline(undefined, { status: '用户已关闭联网搜索，未发起' })).toBe(
      '说明：联网搜索在设置里是关闭的，本轮没有发出任何请求，因此没有联网核验。'
    );
    expect(whyNotOnline(undefined, { status: '用户未同意新增搜索，保留文献结论' })).toBe(
      '说明：链路判断这一处需要外部依据并要求查证，但没有获得同意，因此保留文献结论、没有联网。'
    );
    expect(whyNotOnline(undefined, { status: '未发起：本轮没有需要外部依据的论断' })).toBe(
      '说明：本轮没有发起联网查证——本轮没有需要外部依据的论断'
    );
    expect(whyNotOnline(undefined, { status: '查证未完成：连接超时' })).toBe(
      '说明：本轮尝试过联网查证，但没有完成（连接超时）。'
    );
  });

  it('没有记录时如实兜底，不猜原因', () => {
    expect(whyNotOnline(undefined, undefined)).toBe(
      '说明：本轮没有联网核验；应用没有记下"为什么没查"，因此这里不猜原因。'
    );
    expect(whyNotOnline(undefined, { status: '未发起' })).toBe(
      '说明：本轮没有联网核验；应用没有记下"为什么没查"，因此这里不猜原因。'
    );
  });
});

describe('autoSourceQueries', () => {
  it('按论断性质生成查询词并返回 claims，去重、最多 3 条', () => {
    const result = autoSourceQueries(
      [
        routeFixture(1, 'CONCEPT_DEFINITION'),
        routeFixture(2, 'HISTORICAL_FACT'),
        routeFixture(3, 'SCHOLARLY_POSITION'),
        routeFixture(4, 'BIBLIOGRAPHIC_FACT')
      ],
      ['情感主义'],
      '情感主义是什么',
      { limit: 3 }
    );
    expect(result.queries).toEqual([
      '情感主义 的概念界定依据',
      '情感主义 的史实依据',
      '情感主义 的学术立场依据'
    ]);
    expect(result.claims).toEqual([1, 2, 3, 4]);
    expect(result.reason).toBe('本轮有 4 处论断按性质需要外部依据，文献里没有提供');
  });

  it('同一性质重复出现时查询词去重，但 claims 仍逐条记账', () => {
    const result = autoSourceQueries(
      [routeFixture(1, 'CONCEPT_DEFINITION'), routeFixture(2, 'CONCEPT_DEFINITION')],
      ['模型'],
      '模型是什么'
    );
    expect(result.queries).toEqual(['模型 的概念界定依据']);
    expect(result.claims).toEqual([1, 2]);
  });

  it('没有缺口且问题没要求外部资料：空查询 + 如实 reason', () => {
    expect(autoSourceQueries([], ['模型'], '模型')).toEqual({
      queries: [],
      claims: [],
      reason: '本轮没有需要外部依据的论断'
    });
  });

  it('问题本身要外部资料：提议一个查询词（仍要过权限门）', () => {
    expect(
      autoSourceQueries(undefined, ['最新', '研究'], '帮我查一下最新研究', {
        searchRequested: true
      })
    ).toEqual({
      queries: ['最新'],
      claims: [],
      reason: '这一问需要外部资料（判断模型给出的结论）',
      requested: true
    });
  });

  it('问题里没有可用术语：不编造查询词', () => {
    expect(
      autoSourceQueries(undefined, [], '', { searchRequested: true })
    ).toEqual({
      queries: [],
      claims: [],
      reason: '问题里没有可用于搜索的术语，未发起'
    });
  });

  it('blocked_external 为空但 needs_external 为真也算缺口（TS 授权口径的补丁，注释说明）', () => {
    const result = autoSourceQueries(
      [routeFixture(7, 'CURRENT_INFORMATION', { blocked_external: [] })],
      ['模型'],
      '模型最新进展'
    );
    expect(result.claims).toEqual([7]);
    expect(result.queries).toEqual(['模型 的时效性信息依据']);
  });

  it('文献已足够（needs_external=false 且无 blocked）不算缺口', () => {
    const result = autoSourceQueries(
      [routeFixture(1, 'DOCUMENT_INTERPRETATION', { needs_external: false, blocked_external: [] })],
      ['模型'],
      '模型'
    );
    expect(result.queries).toEqual([]);
    expect(result.reason).toBe('本轮没有需要外部依据的论断');
  });

  it('没有问题术语时退回原问题作为 base（截断 60 字）', () => {
    const result = autoSourceQueries(
      [routeFixture(1, 'CONCEPT_DEFINITION')],
      [],
      '这是一个很长的问题'.repeat(10)
    );
    expect(result.queries[0]!.startsWith('这是一个很长的问题')).toBe(true);
    expect(result.queries[0]!.length).toBeLessThanOrEqual(60 + ' 的概念界定依据'.length);
  });
});

describe('mergeWebReviews', () => {
  function report(overrides: {
    status: '已进行模型证据支持复核' | '部分段落未完成复核';
    claim: number;
    issue: string;
    removed: number;
    reused: number;
    groups: number;
    scopeGroup: string;
    history_dropped?: number;
  }): Parameters<typeof mergeWebReviews>[0] {
    return {
      status: overrides.status,
      issues: [overrides.issue],
      claims: [
        {
          claim: overrides.claim,
          text: `第 ${overrides.claim} 段`,
          verdict: 'supported'
        }
      ],
      routing: [routeFixture(overrides.claim, 'CONCEPT_DEFINITION')],
      page_mentions_removed: [{ claim: overrides.removed, text: `第 ${overrides.removed} 段页码` }],
      reused_claims: overrides.reused,
      audit_groups: overrides.groups,
      evidence_scope: { mode: '按论断选取原文片段，非全书穷尽核查', groups: [overrides.scopeGroup] },
      ...(overrides.history_dropped !== undefined
        ? { history_dropped: overrides.history_dropped }
        : {})
    };
  }

  it('claim/页码/问题编号按 offset 平移，计数相加', () => {
    const previous = report({
      status: '已进行模型证据支持复核',
      claim: 1,
      issue: '段落 1：缺证',
      removed: 1,
      reused: 2,
      groups: 1,
      scopeGroup: 'g1'
    });
    const current = report({
      status: '已进行模型证据支持复核',
      claim: 1,
      issue: '段落 1：摘引不匹配',
      removed: 1,
      reused: 1,
      groups: 2,
      scopeGroup: 'g2',
      history_dropped: 2
    });
    const merged = mergeWebReviews(previous, current, 10);
    expect(merged.status).toBe('已进行模型证据支持复核');
    expect(merged.claims.map((claim) => claim.claim)).toEqual([1, 11]);
    expect(merged.issues).toEqual(['段落 1：缺证', '段落 11：摘引不匹配']);
    expect(merged.page_mentions_removed?.map((row) => row.claim)).toEqual([1, 11]);
    expect(merged.reused_claims).toBe(3);
    expect(merged.audit_groups).toBe(3);
    expect(merged.routing?.map((plan) => plan.claim)).toEqual([1, 11]);
    expect(merged.evidence_scope?.groups).toEqual(['g1', 'g2']);
    expect(merged.history_dropped).toBe(2);
  });

  it('任一未完成则状态降为「部分段落未完成复核」', () => {
    const previous = report({
      status: '已进行模型证据支持复核',
      claim: 1,
      issue: '段落 1：缺证',
      removed: 1,
      reused: 0,
      groups: 1,
      scopeGroup: 'g1'
    });
    const current = report({
      status: '部分段落未完成复核',
      claim: 2,
      issue: '段落 2：未返回结论',
      removed: 2,
      reused: 0,
      groups: 1,
      scopeGroup: 'g2'
    });
    expect(mergeWebReviews(previous, current, 5).status).toBe('部分段落未完成复核');
  });
});

describe('chat 级：外部论断但本轮没有联网时如实记账/notice', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-web-support-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();

  beforeEach(() => {
    saveModelServices(store, {
      connections: [
        {
          id: 'chat-conn',
          name: '测试平台',
          platform: 'custom',
          baseUrl: 'http://127.0.0.1:9/v1',
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
    saveSearchConfig(store, secrets, {
      provider: 'deepseek',
      base_url: 'https://search.test',
      api_key: 'search-key',
      permission: 'review'
    });
    vi.mocked(answerWithReading).mockReset();
    vi.mocked(answerWithReading).mockResolvedValue({
      answer: '文献回答',
      sources: [],
      notice: '原有通知：分批阅读完成。',
      audit: {
        status: '已进行模型证据支持复核',
        issues: [],
        claims: [
          { claim: 1, text: '第一段需要外部依据的论断', verdict: 'supported' },
          { claim: 2, text: '第二段论断', verdict: 'supported' }
        ],
        routing: [
          routeFixture(1, 'CONCEPT_DEFINITION'),
          routeFixture(2, 'HISTORICAL_FACT')
        ]
      }
    } as unknown as ChatResponse);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
    return {
      question: '情感主义是什么',
      documentId: 'doc-1',
      page: 1,
      reading_scope: 'document',
      ...overrides
    };
  }

  it('仅文献：不发起，notice 说明原因，覆盖原 notice 不丢失', async () => {
    const result = await answerQuestion(store, secrets, request({ source_policy: 'document_only' }));
    expect(result.coverage?.auto_source_search?.status).toContain('仅文献');
    expect(result.coverage?.auto_source_search?.approved).toBe(false);
    expect(result.notice).toContain('原有通知：分批阅读完成。');
    expect(result.notice).toContain('「仅文献」');
    expect(result.notice).not.toContain('已按审计来源建议逐段补查');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('review 权限且未确认：不发起，status/notice 如实', async () => {
    const result = await answerQuestion(store, secrets, request());
    expect(result.coverage?.auto_source_search?.status).toBe(
      '未发起：需要你先确认是否允许联网补查（本轮没有自动弹确认）'
    );
    expect(result.coverage?.auto_source_search?.approved).toBe(false);
    expect(result.coverage?.auto_source_search?.queries.length).toBeGreaterThan(0);
    expect(result.notice).toContain('需要你先确认是否允许联网补查');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('auto 权限且能取到网页：记账「已按论断缺口查证」并保留原 notice', async () => {
    saveSearchConfig(store, secrets, {
      provider: 'deepseek',
      base_url: 'https://search.test',
      permission: 'auto'
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('search.test/v1/tools/search')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  url: 'https://example.org/a',
                  title: '参考资料 A',
                  snippet: '关于情感主义的界定。'
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 500 });
      })
    );
    const result = await answerQuestion(store, secrets, request());
    const auto = result.coverage?.auto_source_search;
    expect(auto?.approved).toBe(true);
    // 两个论断各生成一个查询词，各取到 1 条结果。
    expect(auto?.results).toBe(2);
    expect(auto?.status).toContain('已按论断缺口查证');
    expect(result.sources.filter((source) => source.kind === 'web')).toHaveLength(2);
    expect(result.notice).toContain('原有通知：分批阅读完成。');
    expect(result.notice).toContain('已按审计来源建议逐段补查 2 条网页结果。');
  });
});
