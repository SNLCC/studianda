import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertEndpointTransport,
  assertNoUrlCredentials,
  isLocalOrLanHost
} from '../src/net-policy.js';
import { validateModelServiceUrl } from '../src/model-services.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { saveSpeechConfig } from '../src/speech.js';
import { Store } from '../src/store.js';
import { saveSearchConfig } from '../src/web-search.js';
import { saveZoteroConfig } from '../src/zotero.js';

/**
 * 出站地址策略（使用须知第 3 节）：远程端点只允许 HTTPS，HTTP 仅本机/局域网。
 *
 * 以前只有模型服务做了这项校验，搜索/解析/语音填 `http://<公网IP>` 时 Key 与页面
 * 图像会明文出站；这里锁住三处配置入口，避免回退。
 */
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-net-policy-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('出站地址策略', () => {
  it('识别本机与局域网主机', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '127.0.1.1',
      '192.168.1.9',
      '10.0.0.5',
      '172.20.1.2',
      'printer.local'
    ]) {
      expect(isLocalOrLanHost(host)).toBe(true);
    }
    for (const host of ['api.deepseek.com', '8.8.8.8', '172.32.0.1']) {
      expect(isLocalOrLanHost(host)).toBe(false);
    }
  });

  it('拒绝公网 http，允许公网 https 与本机 http', () => {
    expect(() => assertEndpointTransport('http://api.example.com', '搜索服务地址')).toThrow(
      /https/
    );
    expect(() => assertEndpointTransport('https://api.example.com', '搜索服务地址')).not.toThrow();
    expect(() => assertEndpointTransport('http://127.0.0.1:8080', '搜索服务地址')).not.toThrow();
    expect(() => assertEndpointTransport('http://192.168.1.2:8080', '搜索服务地址')).not.toThrow();
  });

  it('搜索配置不接受公网 http 地址', () => {
    expect(() =>
      saveSearchConfig(store, secrets, { base_url: 'http://search.example.com' })
    ).toThrow(/https/);
    expect(() =>
      saveSearchConfig(store, secrets, { base_url: 'https://search.example.com' })
    ).not.toThrow();
  });

  it('解析配置不接受公网 http 地址', () => {
    expect(() =>
      saveParsingConfig(store, secrets, {
        mode: 'custom',
        service_url: 'http://parse.example.com'
      })
    ).toThrow(/https/);
    expect(() =>
      saveParsingConfig(store, secrets, {
        mode: 'custom',
        service_url: 'https://parse.example.com'
      })
    ).not.toThrow();
  });

  it('语音配置不接受公网 http 地址', () => {
    expect(() =>
      saveSpeechConfig(store, secrets, {
        asr_mode: 'custom',
        asr_url: 'http://asr.example.com',
        asr_model: 'whisper'
      })
    ).toThrow(/https/);
    expect(() =>
      saveSpeechConfig(store, secrets, {
        asr_mode: 'custom',
        asr_url: 'https://asr.example.com',
        asr_model: 'whisper'
      })
    ).not.toThrow();
  });
});

describe('地址内嵌账号密码一律拒绝', () => {
  const CREDENTIALS_HINT = /不要把账号密码写在地址里/;

  it('共享校验：带 userinfo 拒绝，不带放行', () => {
    expect(() =>
      assertNoUrlCredentials(new URL('https://user:pass@api.example.com/v1'), '服务地址')
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      assertNoUrlCredentials(new URL('https://user@api.example.com/v1'), '服务地址')
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      assertNoUrlCredentials(new URL('https://api.example.com/v1'), '服务地址')
    ).not.toThrow();
  });

  it('模型服务地址', () => {
    expect(() => validateModelServiceUrl('https://user:pass@api.example.com/v1')).toThrow(
      CREDENTIALS_HINT
    );
    expect(validateModelServiceUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1'
    );
  });

  it('搜索服务地址', () => {
    expect(() =>
      saveSearchConfig(store, secrets, { base_url: 'https://user:pass@search.example.com' })
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      saveSearchConfig(store, secrets, { base_url: 'https://search.example.com' })
    ).not.toThrow();
  });

  it('Zotero WebDAV 地址', () => {
    const base = { mode: 'webdav' as const, library_type: 'users' as const, library_id: '123' };
    expect(() =>
      saveZoteroConfig(store, secrets, {
        ...base,
        webdav_url: 'https://user:pass@dav.example.com/dav/zotero'
      })
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      saveZoteroConfig(store, secrets, {
        ...base,
        webdav_url: 'https://dav.example.com/dav/zotero'
      })
    ).not.toThrow();
  });

  it('识别服务地址', () => {
    expect(() =>
      saveParsingConfig(store, secrets, {
        mode: 'custom',
        service_url: 'https://user:pass@parse.example.com/parse'
      })
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      saveParsingConfig(store, secrets, {
        mode: 'custom',
        service_url: 'https://parse.example.com/parse'
      })
    ).not.toThrow();
  });

  it('语音服务地址（ASR / TTS）', () => {
    expect(() =>
      saveSpeechConfig(store, secrets, {
        asr_mode: 'custom',
        asr_url: 'https://user:pass@asr.example.com/v1',
        asr_model: 'speech-model'
      })
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      saveSpeechConfig(store, secrets, {
        asr_mode: 'custom',
        asr_url: 'https://asr.example.com/v1',
        asr_model: 'speech-model'
      })
    ).not.toThrow();

    expect(() =>
      saveSpeechConfig(store, secrets, {
        tts_mode: 'custom',
        tts_url: 'https://user:pass@tts.example.com/v1',
        tts_model: 'speech-model'
      })
    ).toThrow(CREDENTIALS_HINT);
    expect(() =>
      saveSpeechConfig(store, secrets, {
        tts_mode: 'custom',
        tts_url: 'https://tts.example.com/v1',
        tts_model: 'speech-model'
      })
    ).not.toThrow();
  });
});
