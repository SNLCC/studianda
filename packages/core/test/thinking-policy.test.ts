import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adaptiveThinkingReserve,
  THINKING_RESERVE_CEILING,
  THINKING_RESERVE_FLOOR
} from '../src/model-protocol.js';
import {
  observedReasoningTokens,
  recordReasoningTokens,
  resetReasoningSamples
} from '../src/model-usage.js';
import {
  collectModelUsage,
  recordModelUsage,
  resetThroughputSamples
} from '../src/model-usage.js';
import { callChatModel, type ReadingChatConfig } from '../src/reading-chat.js';

const deepseek = (overrides: Partial<ReadingChatConfig> = {}): ReadingChatConfig =>
  ({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'k',
    model: 'deepseek-chat',
    ...overrides
  }) as ReadingChatConfig;

interface Captured {
  body: Record<string, unknown>;
}

/** 拦截 fetch，记录请求体，返回固定 usage。 */
function stubFetch(usage: Record<string, unknown> | null = null): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '正文' } }],
        ...(usage ? { usage } : {})
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return captured;
}

beforeEach(() => {
  resetThroughputSamples();
  resetReasoningSamples();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('思考策略：批次精读开思考，机械调用关思考', () => {
  it('任务型默认关闭思考（审计/修复口径不变）', async () => {
    const captured = stubFetch();
    await callChatModel(deepseek(), 'S', 'U', 800, undefined, undefined, undefined, undefined, '', [], true);
    const body = captured[0]!.body;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('批次精读显式开思考，但强度压到 low', async () => {
    const captured = stubFetch();
    await callChatModel(
      deepseek(),
      'S',
      'U',
      800,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      [],
      true,
      true
    );
    const body = captured[0]!.body;
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
    // 开思考时要为思维链留出输出空间。
    expect(Number(body.max_tokens)).toBeGreaterThan(800);
  });

  it('用户配了强度时，批次精读按配置而不是 low', async () => {
    const captured = stubFetch();
    await callChatModel(
      deepseek({ reasoningEffort: 'high' }),
      'S',
      'U',
      800,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      [],
      true,
      true
    );
    expect(captured[0]!.body.reasoning_effort).toBe('high');
  });
});

describe('思维链预留：从常量改到观测自适应', () => {
  it('样本不足时退回平台常量', () => {
    expect(adaptiveThinkingReserve(null, 4096)).toBe(4096);
    expect(observedReasoningTokens()).toBeNull();
  });

  it('样本够了取 p90 × 1.2，并夹在上下限之间', () => {
    for (const value of [200, 300, 400, 500, 3000]) recordReasoningTokens(value);
    const observed = observedReasoningTokens()!;
    expect(observed.samples).toBe(5);
    expect(observed.p90).toBe(3000);
    expect(adaptiveThinkingReserve(observed, 4096)).toBe(3600);
    // 极端小样本不会把预留压到 0，极端大样本也不会无限膨胀。
    expect(adaptiveThinkingReserve({ p90: 1, samples: 9 }, 4096)).toBe(THINKING_RESERVE_FLOOR);
    expect(adaptiveThinkingReserve({ p90: 400_000, samples: 9 }, 4096)).toBe(
      THINKING_RESERVE_CEILING
    );
  });

  it('自适应预留真的进到请求体的 max_tokens 里', async () => {
    for (const value of [2000, 2000, 2000]) recordReasoningTokens(value);
    const captured = stubFetch();
    await callChatModel(
      deepseek(),
      'S',
      'U',
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      [],
      false
    );
    // p90 = 2000 → 预留 2400 → max_tokens = 3400
    expect(captured[0]!.body.max_tokens).toBe(3400);
  });
});

describe('思维链用量可观测', () => {
  it('usage.reasoning_tokens 计入本轮用量（已含在 output 里，不重复加）', async () => {
    stubFetch({
      prompt_tokens: 100,
      completion_tokens: 500,
      completion_tokens_details: { reasoning_tokens: 320 }
    });
    const { usage } = await collectModelUsage(() =>
      callChatModel(deepseek(), 'S', 'U', 800, undefined, undefined, undefined, undefined, '', [], false)
    );
    expect(usage?.reasoning_tokens).toBe(320);
    expect(usage?.output_tokens).toBe(500);
    expect(usage?.total_tokens).toBe(600);
  });

  it('不思考的轮次不写 reasoning_tokens（界面不多一行"思考 0"）', async () => {
    stubFetch({ prompt_tokens: 100, completion_tokens: 50 });
    const { usage } = await collectModelUsage(() =>
      callChatModel(deepseek(), 'S', 'U', 800, undefined, undefined, undefined, undefined, '', [], true)
    );
    expect(usage?.reasoning_tokens).toBeUndefined();
    recordModelUsage('a', 'b', { input: 1, output: 1 });
  });
});
