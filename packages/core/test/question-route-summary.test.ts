import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouteCache, routeQuestion } from '../src/question-route.js';
import type { SecretStore } from '../src/secrets.js';
import type { Store } from '../src/store.js';

/**
 * 「是否在要求整篇概述」由路由模型语义判断（summary 字段），不是靠问法正则。
 * 这里只锁协议透传：模型给 summary=true/false，summaryIntent 原样带出；缺省按 false。
 */

const MODEL_ENV_KEYS = [
  'STUDIANDA_MODEL_BASE_URL',
  'STUDIANDA_MODEL_NAME',
  'STUDIANDA_MODEL_API_KEY'
];

beforeEach(() => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'http://127.0.0.1:9999/v1';
  process.env.STUDIANDA_MODEL_NAME = 'mock-model';
});

afterEach(() => {
  for (const key of MODEL_ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
  clearRouteCache();
});

function storeStub(): Store {
  return {
    getSettings: () => ({}),
    getDocument: () => ({ id: 'doc-1', pages: 3, currentPage: 1, name: 'paper.pdf' })
  } as unknown as Store;
}

function secretsStub(): SecretStore {
  return { get: () => undefined } as unknown as SecretStore;
}

function replyWith(extra: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              document: true,
              search: false,
              reason: '读文献',
              reply: '',
              reading: 'document',
              confidence: 0.9,
              pages: [],
              queries: ['概述'],
              ...extra
            })
          }
        }
      ]
    })
  }));
}

describe('路由模型的 summary 判断', () => {
  it('summary=true 时透传 summaryIntent（任意问法都可以，不靠正则）', async () => {
    replyWith({ summary: true });
    const route = await routeQuestion(storeStub(), secretsStub(), {
      question: '这部专著到底想讲清楚什么',
      documentId: 'doc-1',
      page: 1,
      source_policy: 'auto'
    });
    expect(route.summaryIntent).toBe(true);
  });

  it('summary=false 时不启用摘要短路', async () => {
    replyWith({ summary: false });
    const route = await routeQuestion(storeStub(), secretsStub(), {
      question: '第三章的论证有什么漏洞',
      documentId: 'doc-1',
      page: 1,
      source_policy: 'auto'
    });
    expect(route.summaryIntent).toBe(false);
  });

  it('模型没给 summary 字段时按 false 处理（保守走正常阅读）', async () => {
    replyWith({});
    const route = await routeQuestion(storeStub(), secretsStub(), {
      question: '作者为什么这样划分阶段',
      documentId: 'doc-1',
      page: 1,
      source_policy: 'auto'
    });
    expect(route.summaryIntent).toBe(false);
  });
});
