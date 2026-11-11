import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyFetchedCapacityToConnection,
  fetchConnectionModelsDetailed,
  readModelServices,
  saveModelServices
} from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const token = 'capacity-backfill-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-capacity-backfill-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });
const CONNECTION_ID = 'conn-1';

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function model(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: name,
    name,
    capabilities: ['chat'],
    source: 'preset',
    enabled: true,
    ...extra
  };
}

function saveConnection(models: Array<Record<string, unknown>>): void {
  saveModelServices(store, {
    connections: [
      {
        id: CONNECTION_ID,
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://models.test/v1',
        models,
        hasKey: false
      }
    ] as never,
    routing: {}
  });
}

function savedModel(name: string): Record<string, unknown> | undefined {
  return readModelServices(store).connections.find(
    (connection) => connection.id === CONNECTION_ID
  )?.models.find((item) => item.name === name) as unknown as Record<string, unknown> | undefined;
}

/** 替身 /models：只返回一行带 context_length 的模型。 */
function mockModelsEndpoint(contextLength = 128000): void {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    if (!url.includes('models.test/v1/models')) {
      return new Response('not found', { status: 404 });
    }
    return new Response(
      JSON.stringify({ data: [{ id: 'model-a', context_length: contextLength }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
}

const METADATA_SOURCE = '平台 /models 元数据';

beforeAll(() => {
  saveConnection([model('model-a')]);
});

describe('applyFetchedCapacityToConnection', () => {
  it('writes auto capacity for saved models but never overrides manual ones', () => {
    saveConnection([
      model('model-a'),
      model('model-b', {
        capacity_mode: 'manual',
        context_window: 65536,
        capacity_source: '手动'
      }),
      model('model-c')
    ]);
    const result = applyFetchedCapacityToConnection(store, CONNECTION_ID, {
      'model-a': { contextWindow: 200000, capacitySource: METADATA_SOURCE },
      'model-b': { contextWindow: 200000, capacitySource: METADATA_SOURCE }
      // model-c 无元数据
    });
    expect(result.updated).toBe(1);
    expect(savedModel('model-a')).toMatchObject({
      context_window: 200000,
      capacity_mode: 'auto',
      capacity_source: METADATA_SOURCE
    });
    // manual 绝不被覆盖。
    expect(savedModel('model-b')).toMatchObject({
      context_window: 65536,
      capacity_mode: 'manual',
      capacity_source: '手动'
    });
    // 无元数据保持原样（没有容量字段）。
    expect(savedModel('model-c')).not.toHaveProperty('context_window');
    // id/name 等原有字段保留。
    expect(savedModel('model-a')).toMatchObject({ id: 'model-a', name: 'model-a' });
  });

  it('does nothing for an unknown connection or unknown models', () => {
    saveConnection([model('model-a')]);
    const before = JSON.stringify(readModelServices(store));
    expect(
      applyFetchedCapacityToConnection(store, 'missing-conn', {
        'model-a': { contextWindow: 200000, capacitySource: METADATA_SOURCE }
      }).updated
    ).toBe(0);
    expect(
      applyFetchedCapacityToConnection(store, CONNECTION_ID, {
        'not-saved': { contextWindow: 200000, capacitySource: METADATA_SOURCE }
      }).updated
    ).toBe(0);
    expect(JSON.stringify(readModelServices(store))).toBe(before);
  });

  it('is idempotent for repeated pulls', () => {
    saveConnection([model('model-a')]);
    const metadata = {
      'model-a': { contextWindow: 200000, capacitySource: METADATA_SOURCE }
    };
    expect(applyFetchedCapacityToConnection(store, CONNECTION_ID, metadata).updated).toBe(1);
    const afterFirst = JSON.stringify(readModelServices(store));
    expect(applyFetchedCapacityToConnection(store, CONNECTION_ID, metadata).updated).toBe(0);
    expect(JSON.stringify(readModelServices(store))).toBe(afterFirst);
  });
});

describe('fetchConnectionModelsDetailed', () => {
  it('stays read-only: pulling the model list does not write capacity', async () => {
    saveConnection([model('model-a')]);
    const before = JSON.stringify(readModelServices(store));
    mockModelsEndpoint(64000);
    const detailed = await fetchConnectionModelsDetailed(store, secrets, CONNECTION_ID);
    expect(detailed.models).toContain('model-a');
    expect(detailed.metadata['model-a']?.contextWindow).toBe(64000);
    expect(JSON.stringify(readModelServices(store))).toBe(before);
  });
});

describe('POST /api/v1/model-services/models', () => {
  it('backfills capacity and returns updated when metadata is requested', async () => {
    saveConnection([model('model-a')]);
    mockModelsEndpoint(256000);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/model-services/models',
      headers: headers(),
      payload: { connectionId: CONNECTION_ID, metadata: true }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: string[];
      metadata: Record<string, { contextWindow: number }>;
      updated?: number;
    };
    expect(body.models).toContain('model-a');
    expect(body.metadata['model-a']?.contextWindow).toBe(256000);
    expect(body.updated).toBe(1);
    expect(savedModel('model-a')).toMatchObject({
      context_window: 256000,
      capacity_mode: 'auto',
      capacity_source: METADATA_SOURCE
    });

    // 再拉一次：幂等，updated=0，数据不变。
    const again = await server.inject({
      method: 'POST',
      url: '/api/v1/model-services/models',
      headers: headers(),
      payload: { connectionId: CONNECTION_ID, metadata: true }
    });
    expect((again.json() as { updated?: number }).updated).toBe(0);
  });

  it('keeps the default path read-only', async () => {
    saveConnection([model('model-a')]);
    const before = JSON.stringify(readModelServices(store));
    mockModelsEndpoint(256000);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/model-services/models',
      headers: headers(),
      payload: { connectionId: CONNECTION_ID }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Array.isArray(body.models)).toBe(true);
    expect(body).not.toHaveProperty('updated');
    expect(JSON.stringify(readModelServices(store))).toBe(before);
  });
});
