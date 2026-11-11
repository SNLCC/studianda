import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { diagnoseZotero, listZoteroItems } from '../src/zotero.js';

const token = 'zotero-diagnose-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-diagnose-'));
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
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

/** 替身 fetch：记录请求 URL，按 handler 决定状态码与 JSON。 */
function mockFetch(
  handler: (url: string) => { status?: number; body?: unknown } = () => ({
    status: 200,
    body: []
  })
): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const result = handler(url);
    return new Response(JSON.stringify(result.body ?? []), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return urls;
}

function useLocalMode(): void {
  store.updateSettings({
    'zotero.mode': 'local',
    'zotero.library_type': 'users',
    'zotero.library_id': '0'
  });
}

describe('Zotero quick search', () => {
  it('sends q with limit=25 and start to the items endpoint', async () => {
    useLocalMode();
    const urls = mockFetch();
    await listZoteroItems(store, secrets, '', 25, '  量子 力学  ');
    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url).toContain('/items/top');
    expect(url).toContain('limit=25');
    expect(url).toContain('start=25');
    expect(url).toContain('q=');
    expect(new URL(url).searchParams.get('q')).toBe('量子 力学');
    // 搜索词会 trim，空搜索不发送 q。
    urls.length = 0;
    await listZoteroItems(store, secrets, '', 0, '   ');
    expect(urls[0]).not.toContain('q=');
  });

  it('caps the search term at 500 characters', async () => {
    useLocalMode();
    const urls = mockFetch();
    await listZoteroItems(store, secrets, '', 0, 'x'.repeat(600));
    const q = new URL(urls[0]!).searchParams.get('q') ?? '';
    expect(q.length).toBe(500);
  });

  it('keeps the legacy overrideLocalBase as the 5th positional argument', async () => {
    useLocalMode();
    const urls = mockFetch();
    await listZoteroItems(store, secrets, '', 0, 'http://127.0.0.1:24567/api');
    expect(urls[0]).toContain('http://127.0.0.1:24567/api/users/0/items/top');
    expect(urls[0]).not.toContain('q=');
  });

  it('validates q/start/collection on the HTTP route', async () => {
    useLocalMode();
    mockFetch();
    const ok = await server.inject({
      method: 'GET',
      url: '/api/v1/zotero/items?start=0&q=标题',
      headers: headers()
    });
    expect(ok.statusCode).toBe(200);

    const longQuery = await server.inject({
      method: 'GET',
      url: `/api/v1/zotero/items?q=${'x'.repeat(501)}`,
      headers: headers()
    });
    expect(longQuery.statusCode).toBe(400);

    const badStart = await server.inject({
      method: 'GET',
      url: '/api/v1/zotero/items?start=-1',
      headers: headers()
    });
    expect(badStart.statusCode).toBe(400);

    const badCollection = await server.inject({
      method: 'GET',
      url: '/api/v1/zotero/items?collection=abc',
      headers: headers()
    });
    expect(badCollection.statusCode).toBe(400);
  });
});

describe('Zotero connection diagnosis', () => {
  it('reports a readable local Zotero without leaking keys', async () => {
    useLocalMode();
    secrets.set('zotero.api_key', 'local-secret-key');
    const urls = mockFetch(() => ({ status: 200, body: [] }));
    const result = await diagnoseZotero(store, secrets);
    expect(urls[0]).toContain('/collections?format=json&limit=1');
    expect(result.mode).toBe('local');
    expect(result.mode_name).toBe('本机 Zotero');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('本机 Zotero 可读');
    expect(JSON.stringify(result)).not.toContain('local-secret-key');
  });

  it('reports a local failure without throwing', async () => {
    useLocalMode();
    mockFetch(() => ({ status: 403, body: [] }));
    const result = await diagnoseZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('403');
    expect(result.detail.join('\n')).toContain('错误');
  });

  it('diagnoses the cloud probe and never includes the API key', async () => {
    store.updateSettings({
      'zotero.mode': 'cloud',
      'zotero.library_type': 'users',
      'zotero.library_id': '1234567'
    });
    secrets.set('zotero.api_key', 'cloud-secret-key');
    const urls = mockFetch(() => ({ status: 200, body: [] }));
    const result = await diagnoseZotero(store, secrets);
    expect(urls[0]).toContain('https://api.zotero.org/users/1234567/collections');
    expect(result.mode).toBe('cloud');
    expect(result.mode_name).toBe('Zotero 云端');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('连接可用');
    const detail = result.detail.join('\n');
    expect(detail).toContain('https://api.zotero.org/users/1234567');
    expect(detail).toContain('探测耗时');
    expect(JSON.stringify(result)).not.toContain('cloud-secret-key');
  });

  it('reports a cloud failure from the probe', async () => {
    store.updateSettings({
      'zotero.mode': 'cloud',
      'zotero.library_type': 'users',
      'zotero.library_id': '1234567'
    });
    secrets.set('zotero.api_key', 'cloud-secret-key');
    mockFetch(() => ({ status: 403, body: [] }));
    const result = await diagnoseZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('403');
    expect(JSON.stringify(result)).not.toContain('cloud-secret-key');
  });

  it('strips credentials from the WebDAV address in the diagnosis detail', async () => {
    store.updateSettings({
      'zotero.mode': 'webdav',
      'zotero.library_type': 'users',
      'zotero.library_id': '1234567',
      'zotero.webdav_url': 'https://davuser:davpassword@dav.example.com/dav/zotero',
      'zotero.webdav_user': 'davuser'
    });
    secrets.set('zotero.api_key', 'cloud-secret-key');
    mockFetch(() => ({ status: 200, body: [] }));
    const result = await diagnoseZotero(store, secrets);
    expect(result.mode).toBe('webdav');
    expect(result.detail.join('\n')).toContain('dav.example.com');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('davpassword');
    expect(serialized).not.toContain('cloud-secret-key');
  });

  it('serves the diagnosis over HTTP', async () => {
    useLocalMode();
    mockFetch(() => ({ status: 200, body: [] }));
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/zotero/diagnose',
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'local',
      mode_name: '本机 Zotero',
      ok: true
    });
  });
});
