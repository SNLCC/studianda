import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPlatformCapabilities,
  fetchConnectionModelsDetailed,
  modelServicesImpact,
  resolveModelCapacity,
  saveModelServices,
  validateModelServiceUrl
} from '../src/model-services.js';
import {
  ModelResponseFormatError,
  responseText,
  taskThinkingOptions
} from '../src/model-protocol.js';
import { chatInputLimit } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-layer-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seed(connection: {
  id: string;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  capacityMode?: 'auto' | 'manual';
}): void {
  saveModelServices(store, {
    connections: [
      {
        id: connection.id,
        name: '测试连接',
        platform: 'custom',
        baseUrl: connection.baseUrl,
        models: [
          {
            id: connection.model,
            name: connection.model,
            capabilities: ['chat'],
            source: 'user',
            enabled: true,
            ...(connection.contextWindow !== undefined
              ? { context_window: connection.contextWindow }
              : {}),
            ...(connection.capacityMode ? { capacity_mode: connection.capacityMode } : {})
          }
        ]
      }
    ],
    routing: { chat: { connectionId: connection.id, model: connection.model } }
  });
}

describe('官方模型元数据', () => {
  it('DeepSeek 官方模型没有平台容量时使用官方登记值并抬高输出预留', () => {
    store.updateSettings({
      'reading.context_window': '65536',
      'reading.output_reserve': '4096'
    });
    seed({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
    const capacity = resolveModelCapacity(store, 'chat');
    expect(capacity?.contextWindow).toBe(1_000_000);
    expect(capacity?.outputReserve).toBe(16384);
    expect(capacity?.source).toContain('官方文档');
    expect(chatInputLimit(store)).toBe(1_000_000 - 16384 - 1024);
  });

  it('手动容量优先于官方快照', () => {
    seed({
      id: 'deepseek-manual',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      contextWindow: 32768,
      capacityMode: 'manual'
    });
    const capacity = resolveModelCapacity(store, 'chat');
    expect(capacity?.contextWindow).toBe(32768);
    expect(capacity?.source).toBeUndefined();
  });

  it('MiniMax/MiMo 的官方语音模型会补进获取模型列表并带用途与来源', async () => {
    seed({ id: 'minimax', baseUrl: 'https://api.minimax.io/v1', model: 'chat-model' });
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ data: [{ id: 'chat-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'minimax');
    expect(detailed.models).toContain('asr-1.0');
    expect(detailed.models).toContain('speech-2.8-hd');
    expect(detailed.metadata['asr-1.0']?.capabilities).toEqual(['asr']);
    expect(detailed.metadata['speech-2.8-hd']?.capabilities).toEqual(['tts']);
    expect(detailed.metadata['speech-2.8-hd']?.source).toContain('官方文档');
  });
});

describe('服务地址校验', () => {
  it('拒绝远程 http、账号密码、查询参数与具体接口路径', () => {
    expect(() => validateModelServiceUrl('http://example.com/v1')).toThrow('本机或局域网');
    expect(() => validateModelServiceUrl('https://user:pass@example.com/v1')).toThrow(
      '账号密码'
    );
    expect(() => validateModelServiceUrl('https://example.com/v1?x=1')).toThrow('查询参数');
    expect(() =>
      validateModelServiceUrl('https://example.com/v1/chat/completions')
    ).toThrow('接口根地址');
  });

  it('允许本机/局域网 http，并去掉末尾斜杠', () => {
    expect(validateModelServiceUrl('http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/v1'
    );
    expect(validateModelServiceUrl('http://192.168.1.9:8000/v1')).toBe(
      'http://192.168.1.9:8000/v1'
    );
  });
});

describe('删除平台连接时解绑相关配置', () => {
  it('清空路由、解析/语音 connection_id 与平台密钥', () => {
    seed({ id: 'conn-remove', baseUrl: 'https://api.example.com/v1', model: 'm' });
    secrets.set('platform.conn-remove.api_key', 'k');
    store.updateSettings({
      'parsing.connection_id': 'conn-remove',
      'speech.asr_connection_id': 'conn-remove',
      'speech.tts_connection_id': 'conn-remove'
    });
    saveModelServices(
      store,
      { connections: [], routing: { chat: { connectionId: 'conn-remove', model: 'm' } } },
      secrets
    );
    expect(store.getSettings()['parsing.connection_id']).toBe('');
    expect(store.getSettings()['speech.asr_connection_id']).toBe('');
    expect(store.getSettings()['speech.tts_connection_id']).toBe('');
    expect(secrets.has('platform.conn-remove.api_key')).toBe(false);
    expect(store.getSettings()['model.routing']).not.toContain('conn-remove');
  });
});

describe('thinking 发送规则', () => {
  it('DeepSeek 官方：任务型关闭、最终回答开启', () => {
    expect(taskThinkingOptions('https://api.deepseek.com/v1', true, false)).toEqual({
      thinking: { type: 'disabled' }
    });
    expect(taskThinkingOptions('https://api.deepseek.com/v1', false, false)).toEqual({
      thinking: { type: 'enabled' }
    });
  });

  it('其它平台：只有用户显式开启且是任务型调用才发 disabled', () => {
    expect(taskThinkingOptions('https://api.example.com/v1', true, true)).toEqual({
      thinking: { type: 'disabled' }
    });
    expect(taskThinkingOptions('https://api.example.com/v1', false, true)).toEqual({});
    expect(taskThinkingOptions('https://api.example.com/v1', true, false)).toEqual({});
  });
});

describe('响应解析', () => {
  it('支持 content 数组块拼接', () => {
    expect(
      responseText({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '第一段' },
                { type: 'output_text', text: '第二段' }
              ]
            }
          }
        ]
      })
    ).toBe('第一段第二段');
  });

  it('截断/拒答/只有推理/空正文都如实报错', () => {
    expect(() =>
      responseText({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] })
    ).toThrow(ModelResponseFormatError);
    expect(() =>
      responseText({ choices: [{ message: { refusal: 'no', content: 'x' } }] })
    ).toThrow('拒绝');
    expect(() =>
      responseText({ choices: [{ message: { content: '', reasoning_content: '思考' } }] })
    ).toThrow('仅返回推理');
    expect(() => responseText({ choices: [] })).toThrow('choices');
    expect(() => responseText(null)).toThrow('JSON');
  });
});

describe('平台能力分类与赋值校验', () => {
  it('从平台元数据识别 embedding/rerank/tts/asr/vision', () => {
    expect(classifyPlatformCapabilities({ type: 'embedding' })).toEqual(['embedding']);
    expect(classifyPlatformCapabilities({ id: 'bge-reranker', sub_type: 'reranker' })).toEqual([
      'rerank'
    ]);
    expect(classifyPlatformCapabilities({ type: 'tts' })).toEqual(['tts']);
    expect(
      classifyPlatformCapabilities({
        id: 'speech-asr',
        sub_type: 'speech-to-text'
      })
    ).toEqual(['asr']);
    expect(
      classifyPlatformCapabilities({
        id: 'vision-model',
        architecture: { input_modalities: ['image'], output_modalities: ['text'] }
      })
    ).toEqual(['vision']);
  });

  it('模型能力明确不支持该用途时拒绝保存路由', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'tts-only',
          name: '语音平台',
          platform: 'custom',
          baseUrl: 'https://api.example.com/v1',
          models: [
            {
              id: 'tts-1',
              name: 'tts-1',
              capabilities: ['tts'],
              source: 'user',
              enabled: true
            }
          ]
        }
      ],
      routing: {}
    });
    expect(() =>
      saveModelServices(store, {
        routing: { chat: { connectionId: 'tts-only', model: 'tts-1' } }
      })
    ).toThrow('不支持');
  });

  it('删除前影响预览列出路由与解析/语音占用', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'impact-conn',
          name: '影响测试',
          platform: 'custom',
          baseUrl: 'https://api.example.com/v1',
          models: [
            {
              id: 'chat-1',
              name: 'chat-1',
              capabilities: ['chat'],
              source: 'user',
              enabled: true
            }
          ]
        }
      ],
      routing: { chat: { connectionId: 'impact-conn', model: 'chat-1' } }
    });
    store.updateSettings({ 'parsing.connection_id': 'impact-conn' });
    const impact = modelServicesImpact(store, 'impact-conn');
    expect(impact.kinds).toContain('chat');
    expect(impact.parsing).toBe(true);
    expect(impact.speechAsr).toBe(false);
  });
});
