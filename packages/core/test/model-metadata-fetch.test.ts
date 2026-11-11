import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelServiceModel } from '@studianda/shared';
import {
  applyFetchedCapacity,
  fetchConnectionModels,
  fetchConnectionModelsDetailed,
  saveModelServices
} from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * `/models` 容量元数据自动解析。
 *
 * 平台命名不统一：容量字段可能是 `context_length` / `context_window` /
 * `max_context_length` / `max_model_len`，只认整数且 8192–4000000；
 * 解析结果用于“自动”容量来源，**不覆盖用户手动设置**。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-metadata-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const token = 'metadata-token';
const server = buildServer({ token, version: 'test', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.updateSettings({ 'model.services': '[]', 'model.routing': '{}' });
});

function seedConnection(): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'c1',
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://plat.test/v1',
        models: []
      }
    ],
    routing: {}
  });
  secrets.set('platform.c1.api_key', 'key-1');
}

function mockModels(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  );
}

describe('fetchConnectionModelsDetailed 解析容量字段', () => {
  it('接受 context_length/context_window/max_context_length/max_model_len，只认合法整数', async () => {
    seedConnection();
    mockModels({
      data: [
        { id: 'a', context_length: 128_000 },
        { id: 'b', context_window: 8192 },
        { id: 'c', max_context_length: 4_000_000 },
        { id: 'd', max_model_len: 8191 },
        { id: 'e', context_length: '128000' },
        { id: 'f', context_length: 10_000.5 },
        { id: 'g' },
        { id: 'h', context_length: 4_000_001 }
      ]
    });
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(detailed.models).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(detailed.metadata).toEqual({
      a: { contextWindow: 128_000, capacitySource: '平台 /models 元数据' },
      b: { contextWindow: 8192, capacitySource: '平台 /models 元数据' },
      c: { contextWindow: 4_000_000, capacitySource: '平台 /models 元数据' }
    });
  });

  it('支持 models[] 形状（id 或 name），并按首次出现去重/取第一个合法容量', async () => {
    seedConnection();
    mockModels({
      models: [
        { name: 'x', context_length: 200_000 },
        { id: 'y' },
        { name: 'z', context_length: 1024 }
      ]
    });
    const detailed = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(detailed.models).toEqual(['x', 'y', 'z']);
    expect(detailed.metadata.x?.contextWindow).toBe(200_000);
    expect(detailed.metadata.z).toBeUndefined();

    mockModels({
      data: [{ id: 'dup', context_length: 32_000 }],
      models: [{ id: 'dup', context_length: 64_000 }]
    });
    const deduped = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(deduped.models).toEqual(['dup']);
    expect(deduped.metadata.dup?.contextWindow).toBe(32_000);
  });

  it('没有容量字段/空响应时不写 metadata，也不抛错', async () => {
    seedConnection();
    mockModels({ data: [{ id: 'plain' }] });
    expect((await fetchConnectionModelsDetailed(store, secrets, 'c1')).metadata).toEqual({});

    mockModels({ unexpected: true });
    const empty = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(empty.models).toEqual([]);
    expect(empty.metadata).toEqual({});
  });

  it('wrapper 保持数组兼容（既有调用不变）', async () => {
    seedConnection();
    mockModels({ data: [{ id: 'a', context_length: 128_000 }, { id: 'b' }] });
    await expect(fetchConnectionModels(store, secrets, 'c1')).resolves.toEqual(['a', 'b']);
  });

  it('HTTP 失败回退为已保存模型 + notice；未知连接仍报错', async () => {
    seedConnection();
    mockModels({ error: 'nope' }, 500);
    // 实时列表失败不抛错，而是回退并如实说明。
    const fallback = await fetchConnectionModelsDetailed(store, secrets, 'c1');
    expect(fallback.notice).toContain('实时模型列表没有取到');
    expect(fallback.notice).toContain('HTTP 500');
    await expect(fetchConnectionModelsDetailed(store, secrets, 'missing')).rejects.toThrow(
      '平台连接不存在'
    );
  });
});

describe('server /model-services/models 的兼容形状', () => {
  function headers(): Record<string, string> {
    return { 'x-studianda-token': token };
  }

  it('默认返回 { models }（不带 metadata，旧 UI 不受影响）', async () => {
    seedConnection();
    mockModels({ data: [{ id: 'a', context_length: 128_000 }] });
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/model-services/models',
      headers: headers(),
      payload: { connectionId: 'c1' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { models: string[]; metadata?: unknown };
    expect(body.models).toEqual(['a']);
    expect(body).not.toHaveProperty('metadata');
  });

  it('metadata:true 返回 { models, metadata }', async () => {
    seedConnection();
    mockModels({ data: [{ id: 'a', context_length: 128_000 }, { id: 'b' }] });
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/model-services/models',
      headers: headers(),
      payload: { connectionId: 'c1', metadata: true }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: string[];
      metadata: Record<string, { contextWindow?: number; capacitySource: string }>;
    };
    expect(body.models).toEqual(['a', 'b']);
    expect(body.metadata.a).toEqual({
      contextWindow: 128_000,
      capacitySource: '平台 /models 元数据'
    });
    expect(body.metadata.b).toBeUndefined();
  });

  it('?metadata=true 查询参数同样返回元数据', async () => {
    seedConnection();
    mockModels({ data: [{ id: 'a', context_length: 128_000 }] });
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/model-services/models?metadata=true',
      headers: headers(),
      payload: { connectionId: 'c1' }
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { metadata?: unknown }).metadata).toBeTruthy();
  });
});

describe('applyFetchedCapacity（UI 纯函数）', () => {
  const metadata = {
    a: { contextWindow: 128_000, capacitySource: '平台 /models 元数据' },
    manual: { contextWindow: 256_000, capacitySource: '平台 /models 元数据' }
  };

  it('给 auto/未设置的模型写入容量字段；manual 不被覆盖', () => {
    const models: ModelServiceModel[] = [
      { id: 'a', name: 'a', capabilities: ['chat'], source: 'user', enabled: true },
      {
        id: 'manual',
        name: 'manual',
        capabilities: ['chat'],
        source: 'user',
        enabled: true,
        capacity_mode: 'manual',
        context_window: 9000,
        capacity_source: '手动指定'
      },
      { id: 'c', name: 'c', capabilities: ['chat'], source: 'user', enabled: true }
    ];
    const applied = applyFetchedCapacity(models, metadata);
    expect(applied[0]).toMatchObject({
      name: 'a',
      context_window: 128_000,
      capacity_mode: 'auto',
      capacity_source: '平台 /models 元数据'
    });
    // manual：原样保留（用户手动设置优先）。
    expect(applied[1]).toEqual(models[1]);
    // 没元数据的模型保持原样。
    expect(applied[2]).toEqual(models[2]);
    // 不改原数组。
    expect(models[0]).not.toHaveProperty('context_window');
  });

  it('空 metadata 时原样返回（逐项相等）', () => {
    const models: ModelServiceModel[] = [
      { id: 'a', name: 'a', capabilities: ['chat'], source: 'user', enabled: true }
    ];
    expect(applyFetchedCapacity(models, {})).toEqual(models);
  });
});
