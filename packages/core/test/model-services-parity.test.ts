import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelServiceConnection, ModelServicesConfig } from '@studianda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConnectionModelsDetailed,
  readModelServices,
  saveModelServices
} from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * `/models` 失败时把回退列表（已保存+官方语音）写回连接。
 */
let dataDir = '';
let store: Store;
let secrets: SecretStore;

function connection(
  id: string,
  name: string,
  baseUrl: string,
  models: ModelServiceConnection['models'] = [
    { id: 'chat-1', name: 'chat-1', capabilities: ['chat'], source: 'user', enabled: true }
  ]
): ModelServiceConnection {
  return { id, name, platform: 'custom', baseUrl, models };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-parity-'));
  store = new Store(dataDir);
  secrets = new SecretStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/models 失败回退写回连接', () => {
  const baseUrl = 'https://api.minimax.io/v1';

  function seed(): void {
    const config: ModelServicesConfig = {
      connections: [
        connection('c1', 'MiniMax', baseUrl, [
          {
            id: 'saved-chat',
            name: 'saved-chat',
            capabilities: ['chat'],
            source: 'user',
            enabled: true,
            context_window: 32000,
            capacity_source: '平台元数据'
          }
        ])
      ],
      routing: {}
    };
    saveModelServices(store, config, secrets);
  }

  function persistedModels(): ModelServiceConnection['models'] {
    return readModelServices(store).connections[0]?.models ?? [];
  }

  it('HTTP 500 回退后把已保存模型+官方语音预设写回 connection', async () => {
    seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }))
    );
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(detailed.notice).toContain('实时模型列表没有取到');
    const models = persistedModels();
    // 用户标注的模型保持原样（source=user、enabled=true、容量不丢）。
    expect(models.find((model) => model.name === 'saved-chat')).toMatchObject({
      source: 'user',
      enabled: true,
      capabilities: ['chat'],
      context_window: 32000
    });
    // 官方语音快照被追加为可添加项（preset、未启用、带用途/来源）。
    const preset = models.find((model) => model.name === 'speech-02-hd');
    expect(preset).toBeTruthy();
    expect(preset).toMatchObject({ source: 'preset', enabled: false, capabilities: ['tts'] });
    expect(preset?.metadata_url).toBeTruthy();
  });

  it('网络错误 / 非法 JSON 两种回退也写回', async () => {
    seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );
    await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(persistedModels().some((model) => model.name === 'speech-2.8-hd')).toBe(true);
  });

  it('成功路径不写回（列表交给界面选择后再保存）', async () => {
    seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'fresh-model' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(detailed.notice).toBeUndefined();
    const models = persistedModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe('saved-chat');
  });

  it('回退写回幂等：再次失败不会重复追加同一条目', async () => {
    seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 }))
    );
    await fetchConnectionModelsDetailed(store, secrets, 'c1');
    const first = persistedModels().length;
    await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(persistedModels().length).toBe(first);
  });
});
