import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsingCheckResult } from '@studianda/shared';
import { checkParsingService, saveParsingConfig } from '../src/parsing-config.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-parsing-check-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const originalFetch = globalThis.fetch;
let fetchCalls = 0;

beforeAll(() => {
  // 自检必须只读：任何网络请求都计数并直接失败。
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('识别服务自检不应发起网络请求');
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function resetParsingSettings(): void {
  store.deleteSettings([
    'parsing.mode',
    'parsing.connection_id',
    'parsing.model',
    'parsing.service_url',
    'parsing.allow_remote',
    'parsing.mineru_online_model',
    'parsing.auto_ocr'
  ]);
}

describe('checkParsingService', () => {
  it('reports local mode as ready without any service address', () => {
    resetParsingSettings();
    const result = checkParsingService(store, secrets);
    expect(result).toMatchObject({ mode: 'local', ok: true, url: '', tier: '本机' });
    expect(result.message).toContain('不需要服务地址');
    expect(Array.isArray(result.detail)).toBe(true);
  });

  it('reports a missing vision model as not ready', () => {
    resetParsingSettings();
    saveParsingConfig(store, secrets, { mode: 'vision', allow_remote: true });
    const result = checkParsingService(store, secrets);
    expect(result.mode).toBe('vision');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('识别模型');
    expect(result.detail.join('\n')).toContain('未选择');
  });

  it('reports a configured vision service as ready', () => {
    resetParsingSettings();
    // 环境变量覆盖：给无界面运行/调试用；测试用它给 vision 一个（不会真正连上的）地址。
    process.env.STUDIANDA_MODEL_BASE_URL = 'http://127.0.0.1:9/v1';
    saveParsingConfig(store, secrets, {
      mode: 'vision',
      model: 'vis-model',
      allow_remote: true
    });
    try {
      const result = checkParsingService(store, secrets);
      expect(result).toMatchObject({
        mode: 'vision',
        ok: true,
        url: 'http://127.0.0.1:9/v1',
        tier: '本机'
      });
      expect(result.message).toContain('发送到所选视觉模型');
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
    }
  });

  it('reports an empty or invalid custom address as not ready', () => {
    resetParsingSettings();
    store.updateSettings({ 'parsing.mode': 'custom', 'parsing.service_url': '' });
    const empty = checkParsingService(store, secrets);
    expect(empty.ok).toBe(false);
    expect(empty.url).toBe('');
    expect(empty.message).toContain('请先填写');

    store.updateSettings({ 'parsing.service_url': 'ftp://example.com/parse' });
    const invalid = checkParsingService(store, secrets);
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain('http/https');
    expect(invalid.url).toBe('ftp://example.com/parse');
  });

  it('accepts a valid custom address and describes the service tier', () => {
    resetParsingSettings();
    store.updateSettings({
      'parsing.mode': 'custom',
      'parsing.service_url': 'http://192.168.1.20:8000/parse'
    });
    const result = checkParsingService(store, secrets);
    expect(result).toMatchObject({
      mode: 'custom',
      ok: true,
      url: 'http://192.168.1.20:8000/parse',
      tier: '局域网'
    });
    expect(result.message).toContain('/parse');
  });

  it('explains that MinerU online/agent have no read-only probe and upload a page PDF', () => {
    resetParsingSettings();
    saveParsingConfig(store, secrets, {
      mode: 'mineru_online',
      allow_remote: true,
      service_key: 'online-token'
    });
    const online = checkParsingService(store, secrets);
    expect(online.mode).toBe('mineru_online');
    expect(online.ok).toBe(false);
    expect(online.url).toContain('mineru.net');
    expect(online.tier).toBe('公网');
    expect(online.message).toContain('无法预先校验');
    expect(online.message).toContain('单页 PDF');

    resetParsingSettings();
    saveParsingConfig(store, secrets, { mode: 'mineru_agent', allow_remote: true });
    const agent = checkParsingService(store, secrets);
    expect(agent.mode).toBe('mineru_agent');
    expect(agent.ok).toBe(false);
    expect(agent.message).toContain('限频');
  });

  it('never performed a network request during the checks above', () => {
    expect(fetchCalls).toBe(0);
  });
});

describe('POST /api/v1/parsing/check', () => {
  it('returns the read-only check result over HTTP', async () => {
    resetParsingSettings();
    const server = buildServer({
      token: 'test-token',
      version: 'test-version',
      store,
      secrets
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/parsing/check',
        headers: { 'x-studianda-token': 'test-token' },
        payload: {}
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as ParsingCheckResult;
      expect(body).toMatchObject({ mode: 'local', ok: true, tier: '本机' });
      expect(typeof body.message).toBe('string');
      expect(Array.isArray(body.detail)).toBe(true);
    } finally {
      await server.close();
    }
    expect(fetchCalls).toBe(0);
  });
});
