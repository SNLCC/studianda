import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelServiceConnection, ModelServicesConfig } from '@studianda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { readModelServices, saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 删除模型连接后的降级：
 * 不是只清 connection_id 留下 model/vision 模式，而是明确改成可用状态并返回中文说明。
 */
let dataDir = '';
let store: Store;
let secrets: SecretStore;

function connection(id: string, name: string, baseUrl: string): ModelServiceConnection {
  return {
    id,
    name,
    platform: 'custom',
    baseUrl,
    models: [
      {
        id: 'chat-1',
        name: 'chat-1',
        // 一个模型同时标注三种用途，方便构造“删连接后三条用途都要降级”的场景。
        capabilities: ['chat', 'embedding', 'rerank'],
        source: 'user',
        enabled: true
      }
    ]
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-degrade-'));
  store = new Store(dataDir);
  secrets = new SecretStore();
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('deleting a model connection degrades references', () => {
  it('chat/embedding/rerank/语音/视觉全部改成可用状态并如实返回', () => {
    const config: ModelServicesConfig = {
      connections: [
        connection('c1', '主平台', 'https://api.primary.example/v1'),
        connection('c2', '备用平台', 'https://api.backup.example/v1')
      ],
      routing: {
        chat: { connectionId: 'c1', model: 'chat-1' },
        embedding: { connectionId: 'c1', model: 'chat-1' },
        rerank: { connectionId: 'c1', model: 'chat-1' }
      }
    };
    saveModelServices(store, config, secrets);
    store.updateSettings({
      'speech.asr_mode': 'model',
      'speech.asr_url': 'https://api.primary.example/v1',
      'speech.asr_model': 'chat-1',
      'speech.asr_connection_id': 'c1',
      // tts 指向未被删除的 c2：不应被误改。
      'speech.tts_mode': 'model',
      'speech.tts_url': 'https://api.backup.example/v1',
      'speech.tts_model': 'chat-1',
      'speech.tts_connection_id': 'c2',
      'parsing.mode': 'vision',
      'parsing.model': 'chat-1',
      'parsing.connection_id': 'c1',
      'parsing.service_url': ''
    });
    secrets.set('speech.asr_key', 'asr-key');
    secrets.set('speech.tts_key', 'tts-key');
    secrets.set('platform.c1.api_key', 'platform-key');

    const saved = saveModelServices(
      store,
      { connections: [connection('c2', '备用平台', 'https://api.backup.example/v1')], routing: {} },
      secrets
    );

    expect(saved.unbound.map((item) => item.kind)).toEqual([
      'chat',
      'embedding',
      'rerank',
      'speech:asr',
      'parsing'
    ]);
    expect(saved.unbound.map((item) => item.label)).toEqual([
      '会话模型',
      'Embedding',
      'Rerank',
      '语音识别',
      'PDF 与文字识别'
    ]);
    for (const item of saved.unbound) expect(item.result.trim().length).toBeGreaterThan(0);

    const settings = store.getSettings();
    expect(settings['speech.asr_mode']).toBe('system');
    expect(settings['speech.asr_url']).toBe('');
    expect(settings['speech.asr_model']).toBe('');
    expect(settings['speech.asr_connection_id']).toBe('');
    // 未指向被删平台的 tts 保持原样。
    expect(settings['speech.tts_mode']).toBe('model');
    expect(settings['speech.tts_connection_id']).toBe('c2');

    expect(settings['parsing.mode']).toBe('local');
    expect(settings['parsing.model']).toBe('');
    expect(settings['parsing.connection_id']).toBe('');
    // 视觉模型来自该平台：地址回填被删平台的 base_url（原 service_url 为空）。
    expect(settings['parsing.service_url']).toBe('https://api.primary.example/v1');

    expect(secrets.get('speech.asr_key') ?? '').toBe('');
    expect(secrets.get('speech.tts_key')).toBe('tts-key');
    expect(secrets.get('platform.c1.api_key') ?? '').toBe('');
  });

  it('解析服务保留用户原本填写且能用的独立地址', () => {
    saveModelServices(
      store,
      {
        connections: [
          connection('c1', '主平台', 'https://api.primary.example/v1'),
          connection('c2', '备用平台', 'https://api.backup.example/v1')
        ],
        routing: { chat: { connectionId: 'c1', model: 'chat-1' } }
      },
      secrets
    );
    store.updateSettings({
      'parsing.mode': 'custom',
      'parsing.connection_id': 'c1',
      'parsing.service_url': 'https://mineru.example/api'
    });
    const saved = saveModelServices(
      store,
      { connections: [connection('c2', '备用平台', 'https://api.backup.example/v1')], routing: {} },
      secrets
    );
    expect(saved.unbound.map((item) => item.kind)).toEqual(['chat', 'parsing']);
    expect(store.getSettings()['parsing.service_url']).toBe('https://mineru.example/api');
    expect(store.getSettings()['parsing.mode']).toBe('custom');
  });

  it('删除未被引用的连接不产生降级说明', () => {
    saveModelServices(
      store,
      {
        connections: [
          connection('c1', '主平台', 'https://api.primary.example/v1'),
          connection('c2', '备用平台', 'https://api.backup.example/v1')
        ],
        routing: { chat: { connectionId: 'c1', model: 'chat-1' } }
      },
      secrets
    );
    const saved = saveModelServices(
      store,
      { connections: [connection('c1', '主平台', 'https://api.primary.example/v1')], routing: {} },
      secrets
    );
    expect(saved.unbound).toEqual([]);
  });

  it('删除接口（PUT /model-services）把 unbound 透传给前端', async () => {
    saveModelServices(
      store,
      {
        connections: [connection('c1', '主平台', 'https://api.primary.example/v1')],
        routing: { chat: { connectionId: 'c1', model: 'chat-1' } }
      },
      secrets
    );
    const server = buildServer({ token: 'test-token', version: 'test', store, secrets });
    try {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/v1/model-services',
        headers: { 'x-studianda-token': 'test-token' },
        payload: { connections: [], routing: {} }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        unbound: Array<{ kind: string; label: string; result: string }>;
      };
      expect(body.unbound).toHaveLength(1);
      expect(body.unbound[0]).toMatchObject({ kind: 'chat', label: '会话模型' });
    } finally {
      await server.close();
    }
  });
});

/**
 * 删除单个模型（平台连接保留）时，其他模型调用/设置里的引用要自动清除，
 * 而不是留下"界面已选、调用报错"的悬空配置。
 */
describe('deleting a model unbinds references to it', () => {
  function model(name: string, capabilities: string[]): ModelServiceConnection['models'][number] {
    return { id: name, name, capabilities, source: 'user', enabled: true };
  }

  function seedWithModels(): void {
    saveModelServices(
      store,
      {
        connections: [
          {
            id: 'c1',
            name: '主平台',
            platform: 'custom',
            baseUrl: 'https://api.primary.example/v1',
            models: [
              model('chat-1', ['chat', 'translation']),
              model('emb-1', ['embedding']),
              model('vision-1', ['vision']),
              model('asr-1', ['asr']),
              model('tts-1', ['tts']),
              model('kept-1', ['chat'])
            ]
          },
          {
            id: 'c2',
            name: '备用平台',
            platform: 'custom',
            baseUrl: 'https://api.backup.example/v1',
            models: [model('chat-1', ['rerank'])]
          }
        ],
        routing: {
          chat: { connectionId: 'c1', model: 'chat-1' },
          translation: { connectionId: 'c1', model: 'chat-1' },
          vision: { connectionId: 'c1', model: 'vision-1' },
          // c2 里的同名模型不属于被删平台，不能被误清。
          rerank: { connectionId: 'c2', model: 'chat-1' }
        }
      },
      secrets
    );
    store.updateSettings({
      'speech.asr_mode': 'model',
      'speech.asr_url': 'https://api.primary.example/v1',
      'speech.asr_model': 'asr-1',
      'speech.asr_connection_id': 'c1',
      'speech.tts_mode': 'model',
      'speech.tts_url': 'https://api.primary.example/v1',
      'speech.tts_model': 'tts-1',
      'speech.tts_connection_id': 'c1',
      'parsing.mode': 'vision',
      'parsing.model': 'vision-1',
      'parsing.connection_id': 'c1',
      'parsing.service_url': ''
    });
    secrets.set('speech.asr_key', 'asr-key');
    secrets.set('speech.tts_key', 'tts-key');
    secrets.set('platform.c1.api_key', 'platform-key');
  }

  it('routing/语音/识别里的引用全部自动清除并如实返回', () => {
    seedWithModels();
    const config = readModelServices(store);
    const c1 = config.connections.find((item) => item.id === 'c1')!;
    const c2 = config.connections.find((item) => item.id === 'c2')!;
    const remaining = c1.models.filter((item) => item.name === 'kept-1');

    const saved = saveModelServices(
      store,
      {
        connections: [{ ...c1, models: remaining }, c2],
        routing: config.routing
      },
      secrets
    );

    // 被删模型占用的用途全部解绑；c2 的同名模型不受影响。
    expect(saved.routing).toEqual({
      rerank: { connectionId: 'c2', model: 'chat-1' }
    });
    expect(saved.unbound.map((item) => item.kind)).toEqual([
      'chat',
      'translation',
      'vision',
      'speech:asr',
      'speech:tts',
      'parsing'
    ]);
    for (const item of saved.unbound) expect(item.result.trim().length).toBeGreaterThan(0);

    const settings = store.getSettings();
    expect(settings['speech.asr_mode']).toBe('system');
    expect(settings['speech.asr_model']).toBe('');
    expect(settings['speech.asr_connection_id']).toBe('');
    expect(settings['speech.tts_mode']).toBe('system');
    expect(settings['speech.tts_model']).toBe('');
    expect(settings['speech.tts_connection_id']).toBe('');
    expect(secrets.get('speech.asr_key') ?? '').toBe('');
    expect(secrets.get('speech.tts_key') ?? '').toBe('');

    expect(settings['parsing.mode']).toBe('local');
    expect(settings['parsing.model']).toBe('');
    expect(settings['parsing.connection_id']).toBe('');

    // 平台连接与密钥保留（删的是模型，不是平台）。
    expect(secrets.get('platform.c1.api_key')).toBe('platform-key');
    expect(readModelServices(store).connections).toHaveLength(2);
  });

  it('删除未被引用的模型不改动任何配置', () => {
    seedWithModels();
    const config = readModelServices(store);
    const c1 = config.connections.find((item) => item.id === 'c1')!;
    const c2 = config.connections.find((item) => item.id === 'c2')!;
    const before = store.getSettings();

    const saved = saveModelServices(
      store,
      {
        connections: [
          { ...c1, models: c1.models.filter((item) => item.name !== 'emb-1') },
          c2
        ],
        routing: config.routing
      },
      secrets
    );

    expect(saved.unbound).toEqual([]);
    expect(saved.routing).toEqual(config.routing);
    expect(store.getSettings()['speech.asr_model']).toBe('asr-1');
    expect(store.getSettings()['parsing.model']).toBe('vision-1');
    expect(before['speech.asr_model']).toBe('asr-1');
  });

  it('非视觉模式的识别设置只清空悬空模型名，不改变识别方式', () => {
    saveModelServices(
      store,
      {
        connections: [
          {
            id: 'c1',
            name: '主平台',
            platform: 'custom',
            baseUrl: 'https://api.primary.example/v1',
            models: [model('vision-1', ['vision']), model('kept-1', ['chat'])]
          }
        ],
        routing: {}
      },
      secrets
    );
    store.updateSettings({
      'parsing.mode': 'custom',
      'parsing.connection_id': 'c1',
      'parsing.model': 'vision-1',
      'parsing.service_url': 'https://mineru.example/api'
    });

    const saved = saveModelServices(
      store,
      {
        connections: [
          {
            id: 'c1',
            name: '主平台',
            platform: 'custom',
            baseUrl: 'https://api.primary.example/v1',
            models: [model('kept-1', ['chat'])]
          }
        ],
        routing: {}
      },
      secrets
    );

    expect(saved.unbound).toEqual([]);
    expect(store.getSettings()['parsing.mode']).toBe('custom');
    expect(store.getSettings()['parsing.connection_id']).toBe('c1');
    expect(store.getSettings()['parsing.model']).toBe('');
  });

  it('删除模型时若其它赋值校验失败，不落库任何解绑结果', () => {
    saveModelServices(
      store,
      {
        connections: [
          {
            id: 'c1',
            name: '主平台',
            platform: 'custom',
            baseUrl: 'https://api.primary.example/v1',
            models: [model('keep-1', ['chat']), model('vision-old', ['vision'])]
          }
        ],
        routing: { vision: { connectionId: 'c1', model: 'vision-old' } }
      },
      secrets
    );
    store.updateSettings({
      'speech.asr_mode': 'model',
      'speech.asr_url': 'https://api.primary.example/v1',
      'speech.asr_model': 'vision-old',
      'speech.asr_connection_id': 'c1'
    });

    expect(() =>
      saveModelServices(
        store,
        {
          connections: [
            {
              id: 'c1',
              name: '主平台',
              platform: 'custom',
              baseUrl: 'https://api.primary.example/v1',
              models: [model('keep-1', ['chat'])]
            }
          ],
          // 同时提交一个跑不通的用途赋值：保存整体失败，删除模型的解绑结果也不能先落库。
          routing: {
            chat: { connectionId: 'c1', model: 'keep-1' },
            vision: { connectionId: 'c1', model: 'keep-1' }
          }
        },
        secrets
      )
    ).toThrow(/不支持/);

    expect(store.getSettings()['speech.asr_model']).toBe('vision-old');
    expect(readModelServices(store).routing).toEqual({
      vision: { connectionId: 'c1', model: 'vision-old' }
    });
  });

  it('删除模型的清理结果也通过 PUT /model-services 返回给前端', async () => {
    seedWithModels();
    const config = readModelServices(store);
    const c1 = config.connections.find((item) => item.id === 'c1')!;
    const c2 = config.connections.find((item) => item.id === 'c2')!;
    const server = buildServer({ token: 'test-token', version: 'test', store, secrets });
    try {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/v1/model-services',
        headers: { 'x-studianda-token': 'test-token' },
        payload: {
          connections: [
            { ...c1, models: c1.models.filter((item) => item.name === 'kept-1') },
            c2
          ],
          routing: config.routing
        }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        routing: Record<string, unknown>;
        unbound: Array<{ kind: string }>;
      };
      expect(body.routing).toEqual({ rerank: { connectionId: 'c2', model: 'chat-1' } });
      expect(body.unbound.map((item) => item.kind)).toContain('chat');
    } finally {
      await server.close();
    }
  });
});
