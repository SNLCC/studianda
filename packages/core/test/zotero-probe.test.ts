import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { probeZotero, webdavFailureMessage, zoteroFailureMessage } from '../src/zotero.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-probe-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
}

interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface FetchCall {
  url: string;
  method: string;
  authorization: string;
}

const API_KEY = 'probe-cloud-secret-key';
const DAV_PASSWORD = 'probe-dav-secret-password';
const DAV_ORIGIN = 'https://dav.example.test/';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  store.updateSettings({
    'zotero.mode': 'local',
    'zotero.library_type': 'users',
    'zotero.library_id': '0',
    'zotero.webdav_url': 'https://dav.example.test/zotero',
    'zotero.webdav_user': ''
  });
  secrets.clear('zotero.api_key');
  secrets.clear('zotero.webdav_password');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => StubReply): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: FetchInit) => {
    const url = String(input);
    const headers = init?.headers ?? {};
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.Authorization ?? ''
    });
    const reply = handler(url);
    return new Response(JSON.stringify(reply.body ?? []), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) }
    });
  });
  return calls;
}

function useLocalMode(): void {
  store.updateSettings({
    'zotero.mode': 'local',
    'zotero.library_type': 'users',
    'zotero.library_id': '0'
  });
}

function useCloudMode(): void {
  store.updateSettings({
    'zotero.mode': 'cloud',
    'zotero.library_type': 'users',
    'zotero.library_id': '1234567'
  });
  secrets.set('zotero.api_key', API_KEY);
}

function useWebdavMode(webdavUrl = 'https://dav.example.test/zotero'): void {
  store.updateSettings({
    'zotero.mode': 'webdav',
    'zotero.library_type': 'users',
    'zotero.library_id': '1234567',
    'zotero.webdav_url': webdavUrl,
    'zotero.webdav_user': 'dav-user'
  });
  secrets.set('zotero.api_key', API_KEY);
  secrets.set('zotero.webdav_password', DAV_PASSWORD);
}

describe('Zotero probe mode-aware failures', () => {
  it('reports a cloud 403 with API Key guidance, never the local comm switch', async () => {
    useCloudMode();
    stubFetch(() => ({ status: 403, body: [] }));
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('cloud');
    expect(result.requestedMode).toBe('cloud');
    expect(result.actualMode).toBe('cloud');
    expect(result.message).toBe(zoteroFailureMessage(403, 'cloud'));
    expect(result.message).toContain('API Key');
    expect(result.message).not.toContain('本机');
    expect(result.message).not.toContain('通信');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('reports a local 403 with the Zotero comm switch guidance, not API Key permissions', async () => {
    useLocalMode();
    stubFetch(() => ({ status: 403, body: [] }));
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('local');
    expect(result.message).toBe(zoteroFailureMessage(403, 'local'));
    expect(result.message).toContain('允许其他应用与 Zotero 通信');
    expect(result.message).not.toContain('API Key');
  });

  it('keeps the successful local path unchanged', async () => {
    useLocalMode();
    const calls = stubFetch(() => ({ status: 200, body: [] }));
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('local');
    expect(result.requestedMode).toBe('local');
    expect(result.actualMode).toBe('local');
    expect(result.message).toBe('本机 Zotero 可读。');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/collections?format=json&limit=1');
  });
});

describe('Zotero probe WebDAV check', () => {
  it('reports a WebDAV 401 as a credential problem next to a readable cloud library', async () => {
    useWebdavMode();
    const calls = stubFetch((url) =>
      url.startsWith(DAV_ORIGIN) ? { status: 401, body: {} } : { status: 200, body: [] }
    );
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('webdav');
    expect(result.requestedMode).toBe('webdav');
    // WebDAV 模式的分类/条目仍从 api.zotero.org 读取，实际探测端点是 cloud。
    expect(result.actualMode).toBe('cloud');
    expect(result.webdav).toMatchObject({ checked: true, ok: false, status: 401 });
    expect(result.message).toContain('WebDAV');
    expect(result.message).toContain('账号或应用密码');
    expect(result.message).toBe(
      `Zotero 云端可读，但 WebDAV 附件不可用：${webdavFailureMessage(401)}`
    );
    // 凭据只放在 Basic 认证头里，消息与明细都不泄漏。
    const davCall = calls.find((call) => call.url.startsWith(DAV_ORIGIN));
    expect(davCall?.method).toBe('PROPFIND');
    expect(davCall?.authorization).toBe(
      `Basic ${Buffer.from(`dav-user:${DAV_PASSWORD}`).toString('base64')}`
    );
    expect(davCall?.url).not.toContain('dav-user');
    expect(JSON.stringify(result)).not.toContain(DAV_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('passes only when both the cloud library and the WebDAV collection are reachable', async () => {
    useWebdavMode();
    stubFetch((url) =>
      url.startsWith(DAV_ORIGIN) ? { status: 207, body: {} } : { status: 200, body: [] }
    );
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(true);
    expect(result.webdav).toMatchObject({ checked: true, ok: true, status: 207 });
    expect(result.message).toContain('WebDAV');
    expect(JSON.stringify(result)).not.toContain(DAV_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('falls back to HEAD when the server rejects PROPFIND', async () => {
    useWebdavMode();
    const calls = stubFetch((url) =>
      url.startsWith(DAV_ORIGIN) ? { status: 405, body: {} } : { status: 200, body: [] }
    );
    const result = await probeZotero(store, secrets);
    const davMethods = calls
      .filter((call) => call.url.startsWith(DAV_ORIGIN))
      .map((call) => call.method);
    expect(davMethods).toEqual(['PROPFIND', 'HEAD']);
    expect(result.webdav?.checked).toBe(true);
    // 405 后 HEAD 仍然 405：判为不可用，但消息是 WebDAV 的说明而不是云端错误。
    expect(result.ok).toBe(false);
    expect(result.webdav?.status).toBe(405);
  });

  it('separates WebDAV network errors from credential errors', async () => {
    useWebdavMode();
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).startsWith(DAV_ORIGIN)) throw new TypeError('fetch failed');
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.webdav).toMatchObject({ checked: true, ok: false, status: 0 });
    expect(result.message).toContain('连接不上 WebDAV 服务器');
    expect(result.message).not.toContain('账号或应用密码');
    expect(JSON.stringify(result)).not.toContain(DAV_PASSWORD);
  });

  it('asks for the WebDAV credentials when they are missing', async () => {
    useWebdavMode();
    secrets.clear('zotero.webdav_password');
    const calls = stubFetch(() => ({ status: 200, body: [] }));
    const result = await probeZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.webdav).toMatchObject({ checked: false, ok: false });
    expect(result.message).toContain('WebDAV 账号与应用密码');
    // 没有凭据时不发 WebDAV 请求，只探测 Zotero API。
    expect(calls.some((call) => call.url.startsWith(DAV_ORIGIN))).toBe(false);
  });

  it('strips URL-embedded credentials before probing and reporting', async () => {
    useWebdavMode(`https://dav-user:${DAV_PASSWORD}@dav.example.test/zotero`);
    const calls = stubFetch((url) =>
      url.startsWith(DAV_ORIGIN) ? { status: 207, body: {} } : { status: 200, body: [] }
    );
    const result = await probeZotero(store, secrets);
    const davCall = calls.find((call) => call.url.startsWith(DAV_ORIGIN));
    expect(davCall).toBeTruthy();
    expect(davCall?.url).not.toContain(DAV_PASSWORD);
    expect(davCall?.url).not.toContain('dav-user');
    expect(JSON.stringify(result)).not.toContain(DAV_PASSWORD);
    expect(result.detail?.join('\n') ?? '').not.toContain(DAV_PASSWORD);
  });
});
