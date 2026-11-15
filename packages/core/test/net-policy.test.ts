import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertEndpointTransport, isLocalOrLanHost } from '../src/net-policy.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { saveSpeechConfig } from '../src/speech.js';
import { Store } from '../src/store.js';
import { saveSearchConfig } from '../src/web-search.js';

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
