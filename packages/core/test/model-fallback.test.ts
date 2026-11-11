import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelServicesConfig } from '@studianda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchConnectionModels,
  fetchConnectionModelsDetailed,
  saveModelServices
} from '../src/model-services.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * `/models` 失败回退：
 * 不再直接抛错，返回“已保存模型 + 官方语音预设 + notice”，让界面能显示已有模型并如实提示。
 */
let dataDir = '';
let store: Store;
let secrets: SecretStore;
const originalFetch = globalThis.fetch;

const CONFIG: ModelServicesConfig = {
  connections: [
    {
      id: 'c1',
      name: 'MiniMax',
      platform: 'custom',
      baseUrl: 'https://api.minimax.io/v1',
      models: [
        {
          id: 'saved-chat',
          name: 'saved-chat',
          capabilities: ['chat'],
          source: 'user',
          enabled: true,
          context_window: 32000,
          capacity_source: '平台元数据'
        }
      ]
    }
  ],
  routing: { chat: { connectionId: 'c1', model: 'saved-chat' } }
};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-fallback-'));
  store = new Store(dataDir);
  secrets = new SecretStore();
  saveModelServices(store, CONFIG, secrets);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function mockResponse(options: {
  ok: boolean;
  status?: number;
  payload?: unknown;
}): void {
  globalThis.fetch = (async () => ({
    ok: options.ok,
    status: options.status ?? (options.ok ? 200 : 500),
    json: async () => options.payload
  })) as unknown as typeof fetch;
}

describe('/models fallback', () => {
  it('HTTP 500 时返回已保存模型 + 官方语音预设 + notice，不抛错', async () => {
    mockResponse({ ok: false, status: 500 });
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    // 已保存模型 + MiniMax 官方语音快照（speech-02-hd 等），不是空列表。
    expect(detailed.models).toContain('saved-chat');
    expect(detailed.models).toContain('speech-02-hd');
    expect(detailed.notice).toBeTruthy();
    expect(detailed.notice).toContain('实时模型列表没有取到');
    expect(detailed.notice).toContain('HTTP 500');
    // 已保存的容量与官方快照来源照常展示。
    expect(detailed.metadata['saved-chat']?.contextWindow).toBe(32000);
    expect(detailed.metadata['speech-02-hd']?.capabilities).toEqual(['tts']);

    // 旧接口（只要名字）同样走回退，不抛。
    await expect(fetchConnectionModels(store, secrets, 'c1')).resolves.toContain('saved-chat');
  });

  it('网络错误时也回退，notice 说明请求失败', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(detailed.models).toContain('saved-chat');
    expect(detailed.notice).toContain('请求失败');
  });

  it('成功路径不带 notice，字段行为不变', async () => {
    mockResponse({
      ok: true,
      payload: { data: [{ id: 'fresh-model', context_length: 128000 }] }
    });
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(detailed.notice).toBeUndefined();
    expect(detailed.models).toContain('fresh-model');
    // 官方语音快照在成功路径同样合并。
    expect(detailed.models).toContain('speech-02-hd');
    expect(detailed.metadata['fresh-model']?.contextWindow).toBe(128000);
  });

  it('server 端点两条分支：失败透传 notice，成功不出现 notice', async () => {
    const server = buildServer({ token: 'test-token', version: 'test', store, secrets });
    try {
      mockResponse({ ok: false, status: 503 });
      const failed = await server.inject({
        method: 'POST',
        url: '/api/v1/model-services/models',
        headers: { 'x-studianda-token': 'test-token' },
        payload: { connectionId: 'c1' }
      });
      expect(failed.statusCode).toBe(200);
      const failedBody = failed.json() as { models: string[]; notice?: string };
      expect(failedBody.models).toContain('saved-chat');
      expect(failedBody.notice).toContain('HTTP 503');

      // metadata 分支同样带 notice，且仍保留 models/metadata/updated 形状。
      const detailed = await server.inject({
        method: 'POST',
        url: '/api/v1/model-services/models',
        headers: { 'x-studianda-token': 'test-token' },
        payload: { connectionId: 'c1', metadata: true }
      });
      const detailedBody = detailed.json() as {
        models: string[];
        metadata: Record<string, unknown>;
        updated?: number;
        notice?: string;
      };
      expect(detailedBody.notice).toContain('实时模型列表没有取到');
      expect(detailedBody.metadata['saved-chat']).toBeTruthy();

      mockResponse({ ok: true, payload: { data: [{ id: 'ok-model' }] } });
      const ok = await server.inject({
        method: 'POST',
        url: '/api/v1/model-services/models',
        headers: { 'x-studianda-token': 'test-token' },
        payload: { connectionId: 'c1', metadata: true }
      });
      const okBody = ok.json() as { models: string[]; notice?: string };
      expect(okBody.models).toContain('ok-model');
      expect(okBody.notice).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
