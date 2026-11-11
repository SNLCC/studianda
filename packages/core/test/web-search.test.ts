import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { getSearchConfig, saveSearchConfig, searchWeb } from '../src/web-search.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-search-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('web search', () => {
  it('defaults to deepseek with the official base url and review permission', () => {
    expect(getSearchConfig(store, secrets)).toMatchObject({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      permission: 'review'
    });
  });

  it('reads legacy brave/searxng settings as deepseek instead of throwing', () => {
    store.updateSettings({
      'search.provider': 'brave',
      'search.base_url': 'https://api.search.brave.com'
    });
    expect(getSearchConfig(store, secrets)).toMatchObject({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com'
    });

    store.updateSettings({
      'search.provider': 'searxng',
      'search.base_url': 'http://searx.test'
    });
    expect(getSearchConfig(store, secrets)).toMatchObject({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com'
    });
    // 只读迁移：读取本身不写回旧值。
    expect(store.getSettings()['search.provider']).toBe('searxng');

    // 下一次保存会把旧值落成合法的 deepseek 配置（只读迁移，不主动写回）。
    expect(saveSearchConfig(store, secrets, { permission: 'review' })).toMatchObject({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com'
    });
    expect(store.getSettings()['search.provider']).toBe('deepseek');
  });

  it('rejects removed providers and defaults the deepseek base url', () => {
    expect(() => saveSearchConfig(store, secrets, { provider: 'brave' as never })).toThrow(
      '不支持的搜索平台'
    );
    expect(() => saveSearchConfig(store, secrets, { provider: 'searxng' as never })).toThrow(
      '不支持的搜索平台'
    );
    expect(saveSearchConfig(store, secrets, { provider: 'deepseek', api_key: 'key' })).toMatchObject(
      {
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com',
        has_key: true
      }
    );
  });

  it('posts to the DeepSeek Search API and maps snippet/summary/content', async () => {
    saveSearchConfig(store, secrets, {
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      permission: 'review',
      api_key: 'key'
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: '<b>Snippet 标题</b>',
              url: 'https://example.com/a',
              snippet: '来自 snippet',
              summary: 'summary 不应覆盖 snippet',
              content: '正文',
              date: '2026-01-01',
              site_name: 'example'
            },
            {
              title: 'Summary 标题',
              url: 'https://example.com/b',
              snippet: '',
              summary: '来自 summary',
              content: '正文'
            },
            {
              title: 'Content 标题',
              url: 'https://example.com/c',
              summary: '',
              content: '来自 content'
            },
            { title: 'Bad', url: 'file:///etc/passwd', snippet: 'x' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    try {
      const results = await searchWeb(store, secrets, 'q'.repeat(200));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/tools/search');
      const init = calls[0]!.init!;
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer key');
      expect(headers['content-type']).toBe('application/json');
      const body = JSON.parse(String(init.body)) as {
        query: string;
        count: number;
        need_content: boolean;
      };
      expect(body.query).toBe('q'.repeat(128));
      expect(body.count).toBe(5);
      expect(body.need_content).toBe(false);

      expect(results.map((result) => result.url)).toEqual([
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c'
      ]);
      expect(results[0]).toMatchObject({
        title: 'Snippet 标题',
        snippet: '来自 snippet',
        kind: 'web'
      });
      expect(results[1]!.snippet).toBe('来自 summary');
      expect(results[2]!.snippet).toBe('来自 content');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows a custom deepseek base url override', async () => {
    saveSearchConfig(store, secrets, {
      provider: 'deepseek',
      base_url: 'https://search-proxy.test/',
      permission: 'review',
      api_key: 'key'
    });
    expect(getSearchConfig(store, secrets).base_url).toBe('https://search-proxy.test');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    try {
      await searchWeb(store, secrets, 'query');
      expect(urls).toEqual(['https://search-proxy.test/v1/tools/search']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the tavily provider and maps its content field', async () => {
    saveSearchConfig(store, secrets, {
      provider: 'tavily',
      permission: 'review',
      api_key: 'tavily-key'
    });
    expect(getSearchConfig(store, secrets)).toMatchObject({ provider: 'tavily', base_url: '' });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          results: [{ title: 'Tavily 标题', url: 'https://example.com/t', content: '摘要正文' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    try {
      const results = await searchWeb(store, secrets, 'query');
      expect(calls[0]?.url).toBe('https://api.tavily.com/search');
      const body = JSON.parse(String(calls[0]!.init!.body)) as { max_results: number };
      expect(body.max_results).toBe(5);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ title: 'Tavily 标题', snippet: '摘要正文', kind: 'web' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires a key for deepseek and rejects search when permission is off', async () => {
    saveSearchConfig(store, secrets, {
      provider: 'deepseek',
      permission: 'review',
      clear_key: true
    });
    await expect(searchWeb(store, secrets, 'query')).rejects.toThrow('请先配置搜索平台密钥');

    saveSearchConfig(store, secrets, { provider: 'deepseek', permission: 'off', api_key: 'key' });
    await expect(searchWeb(store, secrets, 'query')).rejects.toThrow('联网搜索已在隐私权限中关闭');
  });
});
