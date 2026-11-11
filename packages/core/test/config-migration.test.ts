import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-config-migration-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('legacy parsing config migration', () => {
  it('reads old custom service connection_id as service_url without writing back', () => {
    store.updateSettings({
      'parsing.mode': 'custom',
      'parsing.connection_id': 'legacy-connection',
      'parsing.service_url': '',
      'model.services': JSON.stringify([
        {
          id: 'legacy-connection',
          name: '旧解析',
          platform: 'custom',
          baseUrl: 'https://legacy.example/v1',
          models: []
        }
      ])
    });

    const config = getParsingConfig(store, secrets);
    expect(config.mode).toBe('custom');
    expect(config.service_url).toBe('https://legacy.example/v1');
    expect(config.connection_id).toBe('');

    // 只读迁移：设置里仍然是旧结构，等待用户下一次保存。
    expect(store.getSettings()['parsing.connection_id']).toBe('legacy-connection');
    expect(store.getSettings()['parsing.service_url']).toBe('');
  });

  it('keeps an explicit service_url and only migrates when it is empty', () => {
    store.updateSettings({
      'parsing.mode': 'custom',
      'parsing.connection_id': 'legacy-connection',
      'parsing.service_url': 'https://explicit.example/parse'
    });
    const config = getParsingConfig(store, secrets);
    expect(config.service_url).toBe('https://explicit.example/parse');
    expect(config.connection_id).toBe('legacy-connection');
  });
});
