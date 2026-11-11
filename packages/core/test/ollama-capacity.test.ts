import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { fetchConnectionModelsDetailed, saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * Ollama 容量补全：
 * `/models` 不带容量时用 `/api/show`（model_info.*.context_length / 顶层 context_length），
 * 仍未补到的再 `/api/ps` 兜底；非 Ollama 连接不调用；失败静默。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ollama-capacity-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.updateSettings({ 'model.services': '[]', 'model.routing': '{}' });
});

interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Reply): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const reply = handler(url, init);
      return new Response(
        reply.raw !== undefined
          ? reply.raw
          : reply.body === undefined
            ? null
            : JSON.stringify(reply.body),
        {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' }
        }
      );
    })
  );
  return urls;
}

function seedOllama(
  baseUrl = 'http://127.0.0.1:11434/v1',
  platform = 'ollama'
): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'o1',
        name: 'Ollama',
        platform,
        baseUrl,
        models: []
      }
    ],
    routing: {}
  });
}

describe('Ollama 容量补全', () => {
  it('uses /api/show model_info, top-level context_length, then /api/ps fallback', async () => {
    seedOllama();
    const urls = mockFetch((url, init) => {
      if (url.endsWith('/models')) {
        return { body: { data: [{ id: 'llama3' }, { id: 'qwen' }, { id: 'gemma' }] } };
      }
      if (url.endsWith('/api/show')) {
        const name = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model;
        if (name === 'llama3') {
          return { body: { model_info: { 'llama.context_length': 131_072 } } };
        }
        if (name === 'qwen') {
          return { body: { context_length: 32_768 } };
        }
        return { body: { model_info: { 'gemma.context_length': 'bad' } } };
      }
      if (url.endsWith('/api/ps')) {
        return { body: { models: [{ name: 'gemma', context_length: 65_536 }] } };
      }
      return { status: 404, body: {} };
    });

    const result = await fetchConnectionModelsDetailed(store, secrets, 'o1');
    expect(result.models).toEqual(['llama3', 'qwen', 'gemma']);
    expect(result.metadata).toEqual({
      llama3: { contextWindow: 131_072, capacitySource: 'Ollama 本机元数据' },
      qwen: { contextWindow: 32_768, capacitySource: 'Ollama 本机元数据' },
      gemma: { contextWindow: 65_536, capacitySource: 'Ollama 本机元数据' }
    });
    // /v1 被去掉；show 每个缺容量模型一次；ps 只查一次。
    expect(urls.filter((url) => url === 'http://127.0.0.1:11434/api/show')).toHaveLength(3);
    expect(urls.filter((url) => url === 'http://127.0.0.1:11434/api/ps')).toHaveLength(1);
    // 已有容量的模型不会重复补查（models 全部来自 /models，均缺容量，这里验证 show 次数上限）。
    expect(urls.filter((url) => url.endsWith('/models'))).toHaveLength(1);
  });

  it('falls back to /api/ps when /api/show returns 500', async () => {
    seedOllama('http://192.168.1.9:11434', 'custom');
    mockFetch((url) => {
      if (url.endsWith('/models')) {
        return { body: { data: [{ id: 'm1' }, { id: 'm2' }] } };
      }
      if (url.endsWith('/api/show')) return { status: 500, body: {} };
      if (url.endsWith('/api/ps')) {
        return {
          body: {
            models: [
              { name: 'm1', context_length: 200_000 },
              { model: 'm2', context_length: 100_000 }
            ]
          }
        };
      }
      return { status: 404, body: {} };
    });
    const result = await fetchConnectionModelsDetailed(store, secrets, 'o1');
    expect(result.metadata.m1?.contextWindow).toBe(200_000);
    expect(result.metadata.m2?.contextWindow).toBe(100_000);
    expect(result.metadata.m1?.capacitySource).toBe('Ollama 本机元数据');
  });

  it('leaves metadata empty when show/ps give no valid value (silent)', async () => {
    seedOllama();
    const urls = mockFetch((url) => {
      if (url.endsWith('/models')) return { body: { data: [{ id: 'a' }] } };
      if (url.endsWith('/api/show')) {
        return {
          body: {
            model_info: {
              'a.context_length': 8191,
              'b.context_length': 10_000.5,
              'c.context_length': '131072'
            },
            context_length: 4_000_001
          }
        };
      }
      if (url.endsWith('/api/ps')) {
        return {
          status: 501,
          body: {
            models: [{ name: 'a', context_length: 1000 }]
          }
        };
      }
      return { status: 404, body: {} };
    });
    const result = await fetchConnectionModelsDetailed(store, secrets, 'o1');
    expect(result.models).toEqual(['a']);
    expect(result.metadata).toEqual({});
    expect(urls.some((url) => url.endsWith('/api/ps'))).toBe(true);
  });

  it('does not call show/ps for non-Ollama connections', async () => {
    saveModelServices(store, {
      connections: [
        { id: 'c1', name: 'OpenAI 兼容', platform: 'custom', baseUrl: 'https://plat.test/v1', models: [] }
      ],
      routing: {}
    });
    const urls = mockFetch(() => ({ body: { data: [{ id: 'x' }, { id: 'y' }] } }));
    const result = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(result.models).toEqual(['x', 'y']);
    expect(result.metadata).toEqual({});
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/models');
  });

  it('never throws when show/ps network or JSON parsing fails', async () => {
    seedOllama();
    mockFetch((url) => {
      if (url.endsWith('/models')) return { body: { data: [{ id: 'a' }] } };
      if (url.endsWith('/api/show')) return { raw: 'not-json' };
      if (url.endsWith('/api/ps')) throw new Error('network down');
      return { status: 404, body: {} };
    });
    const result = await fetchConnectionModelsDetailed(store, secrets, 'o1');
    expect(result.models).toEqual(['a']);
    expect(result.metadata).toEqual({});
  });
});
