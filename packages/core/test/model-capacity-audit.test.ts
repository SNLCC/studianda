import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { auditAnswer } from '../src/audit.js';
import { inputBudget, readCapacity } from '../src/capacity.js';
import { saveModelServices } from '../src/model-services.js';
import { cost } from '../src/reading.js';
import {
  auditGeneratedAnswer,
  auditPacketBudgetFor,
  chatInputLimit,
  synthesisRoomFor
} from '../src/reading-chat.js';
import { Store } from '../src/store.js';

/**
 * 手动模型容量对「审计分包预算」与「综合材料 room」的生效范围。
 *
 * 口径必须与最终回答一致（都走 `chatInputLimit`）：
 * - manual + 合法窗口：审计 packetBudget 与 synthesize room 跟随模型窗口；
 * - auto / 未配置模型 / 窗口越界：与原 `inputBudget(readCapacity(...))` 完全相等
 *   （即本次改动对默认行为零影响）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-capacity-audit-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.updateSettings({
    'reading.context_window': '65536',
    'reading.output_reserve': '4096',
    'model.services': '[]',
    'model.routing': '{}'
  });
});

/** 改动前的全局口径（作为等价性基准）。 */
function legacyInputLimit(): number {
  return inputBudget(readCapacity(store.getSettings()));
}

function legacyRoom(instruction: string): number {
  return Math.max(1024, legacyInputLimit() - cost(instruction) - 1024);
}

function seedModel(seed: {
  context_window?: number;
  capacity_mode?: 'auto' | 'manual';
}): void {
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

describe('auto / 未配置模型：与改动前完全等价', () => {
  it('未配置模型时两个口径都等于 inputBudget(readCapacity(settings))', () => {
    expect(auditPacketBudgetFor(store)).toBe(legacyInputLimit());
    expect(auditPacketBudgetFor(store)).toBe(chatInputLimit(store));
    expect(synthesisRoomFor(store, '系统指令')).toBe(legacyRoom('系统指令'));
  });

  it('auto 模型带 context_window：审计/综合口径按模型容量', () => {
    seedModel({ context_window: 128_000, capacity_mode: 'auto' });
    expect(auditPacketBudgetFor(store)).toBe(128_000 - 4096 - 1024);
    expect(synthesisRoomFor(store, '系统指令')).toBe(
      Math.max(1024, 128_000 - 4096 - 1024 - cost('系统指令') - 1024)
    );
  });

  it('manual 但窗口越界：退回全局口径', () => {
    seedModel({ context_window: 100, capacity_mode: 'manual' });
    expect(auditPacketBudgetFor(store)).toBe(legacyInputLimit());
    expect(synthesisRoomFor(store, '系统指令')).toBe(legacyRoom('系统指令'));
  });

  it('没有审计 store 时审计包预算退回原保守值 12000', () => {
    expect(auditPacketBudgetFor(undefined)).toBe(12000);
  });
});

describe('manual 合法窗口：审计预算与综合 room 跟随模型容量', () => {
  it('manual 放大（128k）：两个口径变大且等于同一公式', () => {
    seedModel({ context_window: 128_000, capacity_mode: 'manual' });
    const manualLimit = 128_000 - 4096 - 1024;
    expect(chatInputLimit(store)).toBe(manualLimit);
    expect(auditPacketBudgetFor(store)).toBe(manualLimit);
    expect(auditPacketBudgetFor(store)).toBeGreaterThan(legacyInputLimit());
    expect(synthesisRoomFor(store, '系统指令')).toBe(
      Math.max(1024, manualLimit - cost('系统指令') - 1024)
    );
  });

  it('manual 缩小（16k）：两个口径变小（比全局更保守）', () => {
    seedModel({ context_window: 16_384, capacity_mode: 'manual' });
    const manualLimit = 16_384 - 4096 - 1024;
    expect(auditPacketBudgetFor(store)).toBe(manualLimit);
    expect(auditPacketBudgetFor(store)).toBeLessThan(legacyInputLimit());
    expect(synthesisRoomFor(store, '系统指令')).toBe(
      Math.max(1024, manualLimit - cost('系统指令') - 1024)
    );
  });

  it('room 的 1024 下限逻辑保持不变（极短上限时仍 >= 1024）', () => {
    seedModel({ context_window: 8192, capacity_mode: 'manual' });
    // 8192 - 4096 - 1024 = 3072；再减指令成本仍应 >= 1024。
    expect(synthesisRoomFor(store, '很长'.repeat(2000))).toBe(1024);
  });
});

describe('审计结果语义不变', () => {
  const fetchAnsweringAudit = () =>
    vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const material = request.messages[request.messages.length - 1]?.content ?? '';
      const parsed = JSON.parse(material.slice(material.indexOf('{'))) as {
        answer_lines?: Array<{ claim: number; text: string }>;
      };
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  claims: (parsed.answer_lines ?? []).map((line) => ({
                    claim: line.claim,
                    verdict: 'unsupported',
                    reason: '缺证'
                  }))
                })
              }
            }
          ]
        })
      } as unknown as Response;
    });

  it('packetBudget 口径变化不影响 claims/status', async () => {
    const answer = '第一段内容。\n第二段内容。';
    vi.stubGlobal('fetch', fetchAnsweringAudit());
    const generated = await auditGeneratedAnswer(
      { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'mock' },
      answer,
      { evidenceIndex: [], originals: [] },
      undefined,
      false,
      '',
      undefined,
      [],
      12000
    );
    // 直接调 auditAnswer（不经过 packetBudget 口径）作为语义基准。
    const direct = await auditAnswer(
      answer,
      async () =>
        JSON.stringify({
          claims: [
            { claim: 1, verdict: 'unsupported', reason: '缺证' },
            { claim: 2, verdict: 'unsupported', reason: '缺证' }
          ]
        }),
      { evidenceIndex: [], originals: [] }
    );
    expect(generated.claims.map((claim) => claim.verdict)).toEqual(
      direct.claims.map((claim) => claim.verdict)
    );
    expect(generated.status).toBe(direct.status);
    expect(generated.claims).toHaveLength(2);
  });
});
