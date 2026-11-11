import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { getSpeechConfig } from '../src/speech.js';
import { Store } from '../src/store.js';

const token = 'speech-config-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-speech-config-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({
  token,
  version: 'test-version',
  store,
  secrets
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

describe('PUT /api/v1/speech/config', () => {
  it('persists the selected model-service connection ids for ASR and TTS', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/speech/config',
      headers: headers(),
      payload: {
        asr_mode: 'model',
        asr_connection_id: 'conn-asr',
        asr_model: 'asr-model',
        tts_mode: 'model',
        tts_connection_id: 'conn-tts',
        tts_model: 'tts-model'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      asr_mode: 'model',
      asr_connection_id: 'conn-asr',
      asr_model: 'asr-model',
      tts_mode: 'model',
      tts_connection_id: 'conn-tts',
      tts_model: 'tts-model'
    });

    // 刷新设置页时读取的是 GET：它必须回显同一条平台连接，否则下拉框会退回“选择平台”。
    const again = await server.inject({
      method: 'GET',
      url: '/api/v1/speech/config',
      headers: headers()
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      asr_connection_id: 'conn-asr',
      tts_connection_id: 'conn-tts'
    });
    expect(getSpeechConfig(store, secrets)).toMatchObject({
      asr_connection_id: 'conn-asr',
      tts_connection_id: 'conn-tts'
    });
  });

  it('keeps the saved connection ids when other speech options change', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/speech/config',
      headers: headers(),
      payload: { auto_read: true, input_enabled: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      auto_read: true,
      input_enabled: true,
      asr_connection_id: 'conn-asr',
      tts_connection_id: 'conn-tts'
    });
  });
});
