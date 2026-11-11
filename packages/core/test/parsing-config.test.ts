import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MINERU_AGENT_BASE,
  MINERU_ONLINE_BASE,
  ParsingConfigError,
  getParsingConfig,
  parsingConfigForUse,
  resolveVisionProfile,
  saveParsingConfig
} from '../src/parsing-config.js';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-parsing-config-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parsing config', () => {
  it('starts with local parsing and no key', () => {
    expect(getParsingConfig(store, secrets)).toMatchObject({
      mode: 'local',
      allow_remote: false,
      auto_ocr: false,
      has_key: false
    });
  });

  it('keeps auto OCR opt-in', () => {
    expect(getParsingConfig(store, secrets).auto_ocr).toBe(false);
    const saved = saveParsingConfig(store, secrets, { auto_ocr: true });
    expect(saved.auto_ocr).toBe(true);
    expect(getParsingConfig(store, secrets).auto_ocr).toBe(true);
    saveParsingConfig(store, secrets, { auto_ocr: false });
    expect(getParsingConfig(store, secrets).auto_ocr).toBe(false);
  });

  it('requires an address for independent parsing services', () => {
    expect(() => saveParsingConfig(store, secrets, { mode: 'custom' })).toThrow(
      ParsingConfigError
    );
  });

  it('stores a custom parsing service key without exposing it', () => {
    const saved = saveParsingConfig(store, secrets, {
      mode: 'custom',
      service_url: 'https://parser.example.com/parse',
      service_key: 'secret-token',
      allow_remote: true
    });
    expect(saved).toMatchObject({
      mode: 'custom',
      service_url: 'https://parser.example.com/parse',
      allow_remote: true,
      has_key: true
    });
    expect(JSON.stringify(saved)).not.toContain('secret-token');
  });

  it('fixes official MinerU online/agent endpoints', () => {
    expect(() =>
      saveParsingConfig(store, secrets, { mode: 'mineru_online', service_key: 'token' })
    ).not.toThrow();
    expect(getParsingConfig(store, secrets).service_url).toBe(MINERU_ONLINE_BASE);

    saveParsingConfig(store, secrets, { mode: 'mineru_agent' });
    expect(getParsingConfig(store, secrets).service_url).toBe(MINERU_AGENT_BASE);
  });

  it('resolves the vision model from the selected model-service connection first', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'conn-vision',
          name: '视觉平台',
          platform: 'custom',
          baseUrl: 'http://127.0.0.1:8080/v1',
          models: []
        },
        {
          id: 'conn-chat',
          name: '会话平台',
          platform: 'custom',
          baseUrl: 'https://chat.example.com/v1',
          models: []
        }
      ],
      routing: { chat: { connectionId: 'conn-chat', model: 'chat-model' } }
    });
    const saved = saveParsingConfig(store, secrets, {
      mode: 'vision',
      connection_id: 'conn-vision',
      model: 'vision-model',
      allow_remote: false
    });
    expect(saved).toMatchObject({ mode: 'vision', connection_id: 'conn-vision' });
    const profile = resolveVisionProfile(store, secrets, saved);
    expect(profile).toMatchObject({
      baseUrl: 'http://127.0.0.1:8080/v1',
      source: 'connection'
    });
    // 本机连接不需要勾"允许远程"也能用于识别。
    expect(parsingConfigForUse(store, secrets).mode).toBe('vision');
  });

  it('still requires allow_remote when the vision connection is remote', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'conn-remote',
          name: '远程视觉平台',
          platform: 'custom',
          baseUrl: 'https://vision.example.com/v1',
          models: []
        }
      ],
      routing: {}
    });
    const saved = saveParsingConfig(store, secrets, {
      mode: 'vision',
      connection_id: 'conn-remote',
      model: 'vision-model',
      allow_remote: false
    });
    const profile = resolveVisionProfile(store, secrets, saved);
    expect(profile).toMatchObject({ baseUrl: 'https://vision.example.com/v1' });
    let thrown: unknown;
    try {
      parsingConfigForUse(store, secrets);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ParsingConfigError);
    expect((thrown as ParsingConfigError).status).toBe(403);
  });

  it('falls back to the chat routing when no parsing connection is chosen', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'conn-chat',
          name: '会话平台',
          platform: 'custom',
          baseUrl: 'http://127.0.0.1:9090/v1',
          models: []
        }
      ],
      routing: { chat: { connectionId: 'conn-chat', model: 'chat-model' } }
    });
    const saved = saveParsingConfig(store, secrets, {
      mode: 'vision',
      connection_id: '',
      model: 'vision-model',
      allow_remote: false
    });
    expect(resolveVisionProfile(store, secrets, saved)).toMatchObject({
      baseUrl: 'http://127.0.0.1:9090/v1',
      source: 'routing'
    });
    expect(parsingConfigForUse(store, secrets).mode).toBe('vision');
  });
});
