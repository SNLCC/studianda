import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { inputBudget, inputBudgetFor } from '../src/capacity.js';
import { resolveModelCapacity, saveModelServices } from '../src/model-services.js';
import { callChatModel, chatInputLimit } from '../src/reading-chat.js';
import { Store } from '../src/store.js';

/**
 * 模型容量元数据与任务思考设置。
 *
 * 口径：
 * - 模型条目可以带 `context_window`（8192–4000000）、`capacity_mode`、`task_thinking`、
 *   `capacity_source`；
 * - 只有 `capacity_mode='manual'` 且窗口合法时才覆盖全局容量；auto/未配置/越界一律沿用全局；
 * - `task_thinking` 本版本只保存与展示，**不**发送平台私有参数（callChatModel 请求体没有
 *   `thinking` 字段，默认行为不变）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-capacity-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.updateSettings({
    'reading.context_window': '',
    'reading.output_reserve': '',
    'model.services': '[]',
    'model.routing': '{}'
  });
});

interface ModelSeed {
  context_window?: number;
  capacity_mode?: 'auto' | 'manual';
  task_thinking?: boolean;
  capacity_source?: string;
}

function seedChatModel(seed: ModelSeed): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'c1',
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://model.test/v1',
        models: [
          {
            id: 'm1',
            name: 'm1',
            capabilities: ['chat'],
            source: 'user',
            enabled: true,
            ...seed
          }
        ]
      }
    ],
    routing: { chat: { connectionId: 'c1', model: 'm1' } }
  });
}

describe('resolveModelCapacity', () => {
  it('按 routing.chat 返回容量字段（合法窗口/手动模式/任务思考/来源）', () => {
    seedChatModel({
      context_window: 128_000,
      capacity_mode: 'manual',
      task_thinking: true,
      capacity_source: '官方文档（2026-09-16）'
    });
    expect(resolveModelCapacity(store)).toEqual({
      contextWindow: 128_000,
      capacityMode: 'manual',
      taskThinking: true,
      source: '官方文档（2026-09-16）'
    });
  });

  it('未绑定模型时返回 null（默认行为完全走全局设置）', () => {
    expect(resolveModelCapacity(store)).toBeNull();
  });

  it('窗口越界当作没有元数据（contextWindow 省略），其余字段照常返回', () => {
    seedChatModel({ context_window: 4096, capacity_mode: 'manual', task_thinking: false });
    const capacity = resolveModelCapacity(store);
    expect(capacity).not.toBeNull();
    expect(capacity?.contextWindow).toBeUndefined();
    expect(capacity?.capacityMode).toBe('manual');
    expect(capacity?.taskThinking).toBe(false);
  });

  it('按 kind 解析（embedding 路由存在时 chat 仍为 null）', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'c1',
          name: '测试平台',
          platform: 'custom',
          baseUrl: 'https://model.test/v1',
          models: [
            {
              id: 'e1',
              name: 'e1',
              capabilities: ['embedding'],
              source: 'user',
              enabled: true,
              context_window: 32_000,
              capacity_mode: 'auto'
            }
          ]
        }
      ],
      routing: { embedding: { connectionId: 'c1', model: 'e1' } }
    });
    expect(resolveModelCapacity(store, 'chat')).toBeNull();
    expect(resolveModelCapacity(store, 'embedding')).toEqual({
      contextWindow: 32_000,
      capacityMode: 'auto'
    });
  });
});

describe('inputBudgetFor', () => {
  const base = { contextWindow: 65_536, outputReserve: 4096 };

  it('没有覆盖时与 inputBudget 完全一致', () => {
    expect(inputBudgetFor(base)).toBe(inputBudget(base));
    expect(inputBudgetFor(base, undefined)).toBe(inputBudget(base));
    expect(inputBudget(base)).toBe(65_536 - 4096 - 1024);
  });

  it('合法的手动窗口替换 contextWindow 后沿用同一口径', () => {
    expect(inputBudgetFor(base, 128_000)).toBe(128_000 - 4096 - 1024);
    expect(inputBudgetFor(base, 8192)).toBe(8192 - 4096 - 1024);
  });

  it('越界/非整数覆盖被忽略（退回全局窗口，不让坏值卡死阅读）', () => {
    expect(inputBudgetFor(base, 1000)).toBe(inputBudget(base));
    expect(inputBudgetFor(base, 5_000_000)).toBe(inputBudget(base));
    expect(inputBudgetFor(base, 12_000.5)).toBe(inputBudget(base));
    expect(inputBudgetFor(base, Number.NaN)).toBe(inputBudget(base));
  });

  it('极小窗口仍受 1024 下限保护', () => {
    expect(inputBudgetFor({ contextWindow: 8192, outputReserve: 4096 }, 8192)).toBe(3072);
    expect(inputBudget({ contextWindow: 8192, outputReserve: 7000 })).toBe(1024);
  });
});

describe('chatInputLimit 使用模型手动容量', () => {
  it('manual + 合法窗口：覆盖全局设置', () => {
    store.updateSettings({
      'reading.context_window': '65536',
      'reading.output_reserve': '4096'
    });
    seedChatModel({ context_window: 128_000, capacity_mode: 'manual' });
    expect(chatInputLimit(store)).toBe(128_000 - 4096 - 1024);
  });

  it('auto：模型带 context_window 时按模型容量', () => {
    store.updateSettings({
      'reading.context_window': '65536',
      'reading.output_reserve': '4096'
    });
    seedChatModel({ context_window: 128_000, capacity_mode: 'auto' });
    expect(chatInputLimit(store)).toBe(128_000 - 4096 - 1024);
  });

  it('未配置模型 / manual 但窗口越界：沿用全局设置', () => {
    store.updateSettings({
      'reading.context_window': '65536',
      'reading.output_reserve': '4096'
    });
    expect(chatInputLimit(store)).toBe(65_536 - 4096 - 1024);
    seedChatModel({ context_window: 100, capacity_mode: 'manual' });
    expect(chatInputLimit(store)).toBe(65_536 - 4096 - 1024);
  });
});

describe('task_thinking 不改变请求（默认行为不变）', () => {
  it('callChatModel 请求体没有 thinking 字段（本版本只保存设置，不发送私有参数）', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      void init;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '回答' } }] })
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await callChatModel(
      { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'mock' },
      '系统指令',
      '材料'
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('thinking');
  });
});
