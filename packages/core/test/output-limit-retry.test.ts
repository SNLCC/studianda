import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { answerOutputTokens, batchOutputTokens, callChatModel } from '../src/reading-chat.js';
import { collectModelUsage } from '../src/model-usage.js';
import { saveModelServices } from '../src/model-services.js';
import {
  DEEPSEEK_THINKING_RESERVE,
  MINIMAX_THINKING_RESERVE,
  nextOutputBudget,
  OUTPUT_LIMIT_MAX_ATTEMPTS,
  OUTPUT_LIMIT_RETRY_CEILING
} from '../src/model-protocol.js';
import { Store } from '../src/store.js';

/**
 * 输出上限（finish_reason=length）的自动重试：
 *
 * - MiniMax M3.1 Flash 强制开启思考且思维链计入 `max_tokens`：一次长文概括可能把整段
 *   预算烧在推理里，正文为空；此时放大正文预算重试一次，而不是整轮直接失败。
 * - 只对 `length` 重试；只返回推理/空正文等格式问题重试不会变好，照原样抛出。
 * - 被截断的请求同样计费：重试前的用量也要计入本轮 tokens（不能少报）。
 */

const MINIMAX = 'https://api.minimax.cn/v1';
const DEEPSEEK = 'https://api.deepseek.com/v1';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-output-limit-'));

function config(baseUrl: string) {
  return { baseUrl, apiKey: 'k', model: 'chat-model' };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** 按顺序返回响应，并记录每个请求体；第 N 个响应不够用时沿用最后一个。 */
function sequence(responses: unknown[]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  let index = 0;
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(
      init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    );
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return jsonResponse(payload);
  });
  return bodies;
}

const truncatedOnce = {
  choices: [{ message: { content: '', reasoning_content: '把整篇都推理了一遍' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 100, completion_tokens: 5000, total_tokens: 5100 }
};
const answered = {
  choices: [{ message: { content: '概括结果' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 120, total_tokens: 220 }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('输出上限自动重试', () => {
  it('MiniMax：正文被思维链吃光后放大预算重试，返回第二次的正文', async () => {
    const bodies = sequence([truncatedOnce, answered]);
    const { result, usage } = await collectModelUsage(() =>
      callChatModel(config(MINIMAX), '系统', '材料', 1200)
    );
    expect(result).toBe('概括结果');
    expect(bodies).toHaveLength(2);
    // 官方输出上限字段用 max_completion_tokens（max_tokens 已弃用）。
    expect(bodies[0]!.max_completion_tokens).toBe(1200 + MINIMAX_THINKING_RESERVE);
    // 翻倍的是「正文预算」；思考预留仍由协议层固定叠加。
    expect(bodies[1]!.max_completion_tokens).toBe(2400 + MINIMAX_THINKING_RESERVE);
    expect(bodies[1]!.reasoning_split).toBe(true);
    // 最终回答不再沿用平台默认的 effort=max。
    expect(bodies[0]!.reasoning_effort).toBe('high');
    // 两次调用的 token 都要计入（第一次虽被截断，但真的花了）。
    expect(usage?.calls).toBe(2);
    expect(usage?.output_tokens).toBe(5120);
    expect(usage?.estimated).toBe(false);
  });

  it('MiniMax 任务型调用（批次/审计）用 low 思考深度，不再按默认 max 烧预算', async () => {
    const bodies = sequence([answered]);
    await callChatModel(
      config(MINIMAX),
      '系统',
      '材料',
      3000,
      undefined,
      undefined,
      undefined,
      undefined,
      '分批阅读',
      [],
      true
    );
    expect(bodies[0]!.reasoning_effort).toBe('low');
    expect(bodies[0]!.max_completion_tokens).toBe(3000 + MINIMAX_THINKING_RESERVE);
  });

  it('DeepSeek 思考模式：重试同样叠加思维链预留', async () => {
    const bodies = sequence([truncatedOnce, answered]);
    await callChatModel(config(DEEPSEEK), '系统', '材料', 1200);
    expect(bodies[1]!.max_tokens).toBe(2400 + DEEPSEEK_THINKING_RESERVE);
    expect(bodies[1]!.thinking).toEqual({ type: 'enabled' });
  });

  it('任务型调用：重试仍然关闭思考、不加预留', async () => {
    const bodies = sequence([truncatedOnce, answered]);
    await callChatModel(
      config(DEEPSEEK),
      '系统',
      '材料',
      600,
      undefined,
      undefined,
      undefined,
      undefined,
      '分批阅读',
      [],
      true
    );
    expect(bodies[1]!.max_tokens).toBe(1200);
    expect(bodies[1]!.thinking).toEqual({ type: 'disabled' });
  });

  it('两次都被截断：保留可执行提示，并说明已自动重试', async () => {
    const bodies = sequence([truncatedOnce, truncatedOnce]);
    const { usage } = await collectModelUsage(async () => {
      await expect(
        callChatModel(config(MINIMAX), '系统', '材料', 1200)
      ).rejects.toThrow(/输出上限[\s\S]*已自动放大输出预算并重试一次/);
    });
    expect(bodies).toHaveLength(OUTPUT_LIMIT_MAX_ATTEMPTS);
    expect(usage?.calls).toBe(2);
  });

  it('非 length 的空正文不重试：重试也不会变好', async () => {
    const bodies = sequence([
      {
        choices: [{ message: { content: '', reasoning_content: '只想了很久' }, finish_reason: 'stop' }]
      }
    ]);
    await expect(
      callChatModel(config(MINIMAX), '系统', '材料', 1200)
    ).rejects.toThrow('仅返回推理');
    expect(bodies).toHaveLength(1);
  });

  it('放大预算后的请求失败时，保留首次的「输出上限」提示', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      if (call === 1) return jsonResponse(truncatedOnce);
      return new Response('bad request', { status: 400 });
    });
    await expect(
      callChatModel(config(MINIMAX), '系统', '材料', 1200)
    ).rejects.toThrow('输出上限');
  });
});

describe('回答输出预算跟随模型容量', () => {
  const store = new Store(dataDir);
  afterAll(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  afterEach(() => {
    store.updateSettings({
      'reading.context_window': '',
      'reading.output_reserve': '',
      'model.services': '[]',
      'model.routing': '{}'
    });
  });

  it('默认用全局输出预留 4096，而不是老的固定 1200', () => {
    expect(answerOutputTokens(store)).toBe(4096);
    // 单批材料用不到上万 token：默认批次预算保持 3000，不改旧行为。
    expect(batchOutputTokens(store)).toBe(3000);
  });

  it('用户调大/调小输出预留时跟随（至少 1200）', () => {
    store.updateSettings({ 'reading.output_reserve': '8192' });
    expect(answerOutputTokens(store)).toBe(8192);
    store.updateSettings({ 'reading.output_reserve': '512' });
    expect(answerOutputTokens(store)).toBe(1200);
    // 输出预留必须小于上下文窗口的一半；窗口一起调大才生效。
    store.updateSettings({
      'reading.context_window': '262144',
      'reading.output_reserve': '32768'
    });
    expect(answerOutputTokens(store)).toBe(32768);
  });

  it('官方大输出模型（MiniMax）抬到 16384，避免概括被思维链吃光', () => {
    saveModelServices(store, {
      connections: [
        {
          id: 'c1',
          name: 'MiniMax',
          platform: 'minimax',
          baseUrl: MINIMAX,
          models: [
            {
              id: 'm1',
              name: 'MiniMax-M3.1-Flash',
              capabilities: ['chat'],
              source: 'user',
              enabled: true
            }
          ]
        }
      ],
      routing: { chat: { connectionId: 'c1', model: 'MiniMax-M3.1-Flash' } }
    });
    expect(answerOutputTokens(store)).toBe(16384);
    // 批次预算也随容量抬到 8192，避免个别批次的思维链吃光 3000 预算。
    expect(batchOutputTokens(store)).toBe(8192);
  });
});

describe('nextOutputBudget', () => {
  it('每次翻倍，封顶后不再增长', () => {
    expect(nextOutputBudget(1200)).toBe(2400);
    expect(nextOutputBudget(OUTPUT_LIMIT_RETRY_CEILING)).toBe(OUTPUT_LIMIT_RETRY_CEILING);
    expect(nextOutputBudget(OUTPUT_LIMIT_RETRY_CEILING * 2)).toBe(OUTPUT_LIMIT_RETRY_CEILING);
    expect(OUTPUT_LIMIT_MAX_ATTEMPTS).toBe(2);
  });
});
