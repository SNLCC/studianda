import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '@studianda/shared';
import type { SecretStore } from '../src/secrets.js';
import type { Store } from '../src/store.js';
import { documentMentions, escapeLike, likeContains, queryTerms, searchableTextState } from '../src/mentions.js';
import { answerQuestion } from '../src/chat.js';
import { clearRouteCache, routeQuestion } from '../src/question-route.js';

/**
 * 路由兜底（query_terms / document_mentions / searchable_text_state
 * + question_route 的 history/缓存）的回归测试。
 *
 * 这里用替身 Store 而不是真的建库：被测逻辑只依赖 chunks、page_edits 与文献页数，
 * 走真库会把这些口径藏在 SQL 里，反而看不出「命中到底是哪一路给的」。
 * 模型配置统一走环境变量覆盖（无界面运行/调试用），避免每个用例都造模型服务连接。
 */

const MODEL_ENV_KEYS = [
  'STUDIANDA_MODEL_BASE_URL',
  'STUDIANDA_MODEL_NAME',
  'STUDIANDA_MODEL_API_KEY'
] as const;

beforeEach(() => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'http://127.0.0.1:9999/v1';
  process.env.STUDIANDA_MODEL_NAME = 'mock-model';
});

afterEach(() => {
  for (const key of MODEL_ENV_KEYS) delete process.env[key];
});

interface StoreStubOptions {
  chunks?: string[];
  pageEdits?: Record<number, string>;
  pages?: number;
}

function storeStub(options: StoreStubOptions = {}): Store {
  const chunks = options.chunks ?? [];
  const edits = options.pageEdits ?? {};
  const pages = options.pages ?? 1;
  return {
    getSettings: () => ({}),
    getDocument: () => ({ id: 'doc-1', pages, currentPage: 1, name: 'paper.pdf' }),
    listChunks: () =>
      chunks.map((text, index) => ({
        id: `c${index + 1}`,
        documentId: 'doc-1',
        page: index + 1,
        text
      })),
    getPageEdit: (_documentId: string, page: number) => {
      const text = edits[page];
      if (!text) return null;
      return { text, origin: 'ocr', boxes: '', version: 'v1' };
    }
  } as unknown as Store;
}

function secretsStub(): SecretStore {
  return { get: () => undefined } as unknown as SecretStore;
}

interface RouteModelReply {
  document: boolean;
  search: boolean;
  reason: string;
  reply: string;
  reading?: string;
  confidence?: number;
  pages?: number[];
}

function routeResponse(reply: RouteModelReply): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(reply) } }]
    })
  } as unknown as Response;
}

function routeConfigStore(): Store {
  return {
    getSettings: () => ({}),
    getDocument: () => ({ id: 'doc-1', pages: 3, currentPage: 1, name: 'paper.pdf' })
  } as unknown as Store;
}

describe('queryTerms', () => {
  it('剥掉问题脚手架，先给出整段术语', () => {
    expect(queryTerms('什么是信念伦理？')[0]).toBe('信念伦理');
    expect(queryTerms('请解释一下信念伦理')[0]).toBe('信念伦理');
    expect(queryTerms('这篇文献的论证结构如何')[0]).toBe('论证结构');
  });

  it('纯脚手架不产生术语，因此不会命中每一页', () => {
    expect(queryTerms('什么')).toEqual([]);
    expect(queryTerms('请问一下')).toEqual([]);
  });

  it('英文术语小写化，少于三字符的英文 run 不作为术语', () => {
    const terms = queryTerms('What is Value Conviction');
    expect(terms).toContain('value');
    expect(terms).toContain('conviction');
    expect(terms).not.toContain('is');
  });

  it('有上限且顺序确定', () => {
    const terms = queryTerms('概念界定与理论依据与限定条件与反例异议', 5);
    expect(terms).toHaveLength(5);
    expect(queryTerms('概念界定与理论依据', 5)).toEqual(queryTerms('概念界定与理论依据', 5));
  });
});

describe('LIKE 口径', () => {
  it('转义 % _ \\，术语里的通配符只当普通字符', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
    expect(likeContains('样本含量 50% 以上', '50%')).toBe(true);
    expect(likeContains('任意文本', '%')).toBe(false);
  });

  it('ASCII 大小写不敏感（对齐 SQLite LIKE）', () => {
    expect(likeContains('Value Conviction', 'value conviction')).toBe(true);
  });
});

describe('documentMentions', () => {
  it('索引片段命中即判定术语出现在文献里', () => {
    const guard = documentMentions(
      storeStub({ chunks: ['本文讨论价值信念，即 value conviction 的含义。'] }),
      'doc-1',
      '什么是价值信念'
    );
    expect(guard.hit).toBe(true);
    expect(guard.matched).toContain('价值信念');
    expect(guard.chunks).toBe(1);
    expect(guard.hasText).toBe(true);
  });

  it('扫描页的整页 OCR/校订文本（page_edits）也参与核对', () => {
    const guard = documentMentions(
      storeStub({ chunks: [], pageEdits: { 2: 'OCR 结果：本文讨论价值信念的含义。' }, pages: 3 }),
      'doc-1',
      '什么是价值信念'
    );
    expect(guard.hit).toBe(true);
    expect(guard.matched).toContain('价值信念');
    expect(guard.pageEdits).toBe(1);
    expect(guard.hasText).toBe(true);
  });

  it('术语确实不在文献里时如实返回未命中（不猜）', () => {
    const guard = documentMentions(
      storeStub({ chunks: ['本文讨论完全无关的内容。'], pageEdits: { 1: '另一段无关文字' } }),
      'doc-1',
      '什么是价值信念'
    );
    expect(guard.hit).toBe(false);
    expect(guard.matched).toEqual([]);
    expect(guard.terms.length).toBeGreaterThan(0);
    expect(guard.hasText).toBe(true);
  });

  it('文献完全没有可检索文字时 hasText 为假（界面据此提示读全篇/OCR）', () => {
    const guard = documentMentions(storeStub({ chunks: [], pageEdits: {}, pages: 2 }), 'doc-1', '什么是价值信念');
    expect(guard.hit).toBe(false);
    expect(guard.hasText).toBe(false);
  });

  it('searchable_text_state 同时统计 chunks 与 page_edits', () => {
    const state = searchableTextState(
      storeStub({ chunks: ['a', 'b'], pageEdits: { 1: 'ocr 文本' }, pages: 2 }),
      'doc-1'
    );
    expect(state).toEqual({ chunks: 2, pageEdits: 1, hasText: true });
  });
});

describe('routeQuestion（history / 缓存 / 页码校验）', () => {
  const baseInput: ChatRequest = {
    question: '什么是价值信念',
    documentId: 'doc-1',
    page: 1
  };

  beforeEach(() => {
    clearRouteCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearRouteCache();
  });

  it('把最近 3 轮历史（答案截断 2000 字）发给模型', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const longAnswer = '答'.repeat(3000);
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return routeResponse({ document: true, search: false, reason: '读文献', reply: '' });
    });
    await routeQuestion(routeConfigStore(), secretsStub(), {
      ...baseInput,
      history: [
        { question: '第 1 问', answer: '第 1 答' },
        { question: '第 2 问', answer: '第 2 答' },
        { question: '第 3 问', answer: '第 3 答' },
        { question: '第 4 问', answer: longAnswer }
      ],
      source_policy: 'auto'
    });
    expect(bodies).toHaveLength(1);
    const messages = bodies[0]!.messages as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages[1]!.content) as {
      history: Array<{ role: string; content: string }>;
      knowledge_allowed: boolean;
    };
    // 只带最近 3 轮（第 1 问被截掉），且顺序保持 user/assistant 交替。
    expect(payload.history.map((row) => row.content)).not.toContain('第 1 问');
    expect(payload.history.map((row) => row.content)).toContain('第 2 问');
    expect(payload.history.map((row) => row.content)).toContain('第 3 问');
    expect(payload.history.map((row) => row.content)).toContain('第 4 问');
    const lastAnswer = payload.history[payload.history.length - 1];
    expect(lastAnswer?.role).toBe('assistant');
    expect(lastAnswer?.content).toHaveLength(2000);
    expect(payload.knowledge_allowed).toBe(true);
  });

  it('同一提问在 10 分钟内只判断一次（缓存命中不重复调用）', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return routeResponse({ document: true, search: false, reason: '读文献', reply: '' });
    });
    const store = routeConfigStore();
    const secrets = secretsStub();
    const first = await routeQuestion(store, secrets, baseInput);
    const second = await routeQuestion(store, secrets, { ...baseInput });
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    // 换了问题就是又一次判断（缓存不能把两句话混成一句）。
    await routeQuestion(store, secrets, { ...baseInput, question: '作者如何论证价值信念' });
    expect(calls).toBe(2);
  });

  it('document_only 时知识权限为假、search 不越权', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return routeResponse({ document: true, search: true, reason: '模型要求搜索', reply: '' });
    });
    const route = await routeQuestion(routeConfigStore(), secretsStub(), {
      ...baseInput,
      source_policy: 'document_only'
    });
    const messages = body!.messages as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages[1]!.content) as {
      knowledge_allowed: boolean;
      search_allowed: boolean;
    };
    expect(payload.knowledge_allowed).toBe(false);
    expect(payload.search_allowed).toBe(false);
    expect(route.search).toBe(false);
  });

  it('模型给的页码超出文献页数时退回整篇（不读不存在的页）', async () => {
    vi.stubGlobal('fetch', async () =>
      routeResponse({
        document: true,
        search: false,
        reason: '只看第 9 页',
        reply: '',
        reading: 'local',
        confidence: 0.95,
        pages: [9]
      })
    );
    const route = await routeQuestion(routeConfigStore(), secretsStub(), baseInput);
    expect(route.plan?.breadth).toBe('document');
    expect(route.plan?.pages).toEqual([]);
    expect(route.plan?.reason).toContain('超出文献页数');
  });

  it('页码在范围内时保留 local 计划', async () => {
    vi.stubGlobal('fetch', async () =>
      routeResponse({
        document: true,
        search: false,
        reason: '只看第 2 页',
        reply: '',
        reading: 'local',
        confidence: 0.95,
        pages: [2]
      })
    );
    const route = await routeQuestion(routeConfigStore(), secretsStub(), baseInput);
    expect(route.plan?.breadth).toBe('local');
    expect(route.plan?.pages).toEqual([2]);
  });
});

describe('answerQuestion 路由兜底（未命中直接回复，route_note 如实说明）', () => {
  const input: ChatRequest = { question: '什么是价值信念', documentId: 'doc-1', page: 1 };
  const chattingStore = (texts: string[]): Store =>
    ({
      getSettings: () => ({}),
      getDocument: () => ({ id: 'doc-1', pages: 2, currentPage: 1, name: 'paper.pdf' }),
      listChunks: () =>
        texts.map((text, index) => ({ id: `c${index + 1}`, documentId: 'doc-1', page: 1, text })),
      getPageEdit: () => null,
      getPageText: () => texts.join('\n'),
      listDocuments: () => []
    }) as unknown as Store;

  beforeEach(() => {
    clearRouteCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearRouteCache();
  });

  it('核对过但没有命中：直接回复并说明核对过哪些术语', async () => {
    vi.stubGlobal('fetch', async () =>
      routeResponse({ document: false, search: false, reason: '闲聊', reply: '你好，有什么可以帮你？' })
    );
    const response = await answerQuestion(chattingStore(['本文讨论完全无关的内容。']), secretsStub(), input);
    expect(response.answer).toBe('你好，有什么可以帮你？');
    expect(response.sources).toEqual([]);
    expect(response.route_note).toContain('已用「');
    expect(response.route_note).toContain('没有找到相关表述');
    expect(response.routing?.document).toBe(false);
  });

  it('文献没有任何可检索文字：提示先读全篇/OCR', async () => {
    vi.stubGlobal('fetch', async () =>
      routeResponse({ document: false, search: false, reason: '闲聊', reply: '你好' })
    );
    const response = await answerQuestion(chattingStore([]), secretsStub(), input);
    expect(response.route_note).toContain('没有任何可检索的文字');
  });

  it('术语命中时不停在闲聊回复：强制继续阅读链路', async () => {
    vi.stubGlobal('fetch', async () =>
      routeResponse({ document: false, search: false, reason: '闲聊', reply: '你好，有什么可以帮你？' })
    );
    // 文献页数为 0 只让阅读链路立即返回 null，不影响本用例要断言的那一步：
    // 模型给的闲聊回复不能直接成为 answer（术语命中时必须先进入阅读链路）。
    const store = {
      getSettings: () => ({}),
      getDocument: () => ({ id: 'doc-1', pages: 0, currentPage: 1, name: 'paper.pdf', author: '', tags: [] }),
      getPageText: () => '',
      getPageEdit: () => null,
      listChunks: () => [{ id: 'c1', documentId: 'doc-1', page: 1, text: '本文讨论价值信念的含义。' }],
      listDerivedChunks: () => [],
      listNavigation: () => [],
      listDocuments: () => [],
      saveReadingTask: () => {},
      loadReadingTask: () => null,
      saveCheckpoint: () => {},
      loadCheckpoint: () => null,
      deleteReadingTask: () => {}
    } as unknown as Store;
    const response = await answerQuestion(store, secretsStub(), {
      question: '什么是价值信念',
      documentId: 'doc-1',
      page: 1,
      source_policy: 'auto'
    });
    expect(response.route_note).toContain('出现在本文献中');
    expect(response.routing?.document).toBe(true);
    expect(response.answer).not.toBe('你好，有什么可以帮你？');
  });
});
