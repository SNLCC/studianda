import { afterEach, describe, expect, it, vi } from 'vitest';
import { callChatModel, type ReadingChatConfig } from '../src/reading-chat.js';
import { collectModelUsage } from '../src/model-usage.js';

/**
 * 单轮 token 用量收集：
 * - 供应商返回 usage → 用真实值（estimated=false）；
 * - 没返回 → 按字符估算并标记 estimated=true；
 * - 流式响应里夹带的 usage chunk 也要计入。
 */

const config: ReadingChatConfig = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'k',
  model: 'mock'
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('模型 token 用量收集', () => {
  it('非流式：供应商返回 usage 时用真实值', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        choices: [{ message: { content: '回答正文' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
      })
    );
    const collected = await collectModelUsage(() =>
      callChatModel(config, '系统提示', '材料正文')
    );
    expect(collected.result).toBe('回答正文');
    expect(collected.usage).toMatchObject({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      calls: 1,
      estimated: false
    });
  });

  it('非流式：没返回 usage 时按字符估算并标记 estimated', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ choices: [{ message: { content: '这是一段估算用的回答正文' } }] })
    );
    const collected = await collectModelUsage(() =>
      callChatModel(config, '系统提示', '材料正文')
    );
    expect(collected.usage?.estimated).toBe(true);
    expect(collected.usage?.calls).toBe(1);
    expect(collected.usage?.input_tokens).toBeGreaterThan(0);
    expect(collected.usage?.output_tokens).toBeGreaterThan(0);
    expect(collected.usage?.total_tokens).toBe(
      (collected.usage?.input_tokens ?? 0) + (collected.usage?.output_tokens ?? 0)
    );
  });

  it('非流式：记录命中上下文缓存的 token（DeepSeek 字段）', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        choices: [{ message: { content: '回答正文' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200
        }
      })
    );
    const collected = await collectModelUsage(() =>
      callChatModel(config, '系统提示', '材料正文')
    );
    // 缓存命中是输入的一部分：输入总数不变，只是多一个可展示的明细。
    expect(collected.usage).toMatchObject({
      input_tokens: 1000,
      cached_tokens: 800,
      output_tokens: 20
    });
  });

  it('非流式：也认 OpenAI 风格的 cached_tokens 明细', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        choices: [{ message: { content: '回答正文' } }],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 320 }
        }
      })
    );
    const collected = await collectModelUsage(() =>
      callChatModel(config, '系统提示', '材料正文')
    );
    expect(collected.usage).toMatchObject({ input_tokens: 500, cached_tokens: 320 });
  });

  it('供应商没有缓存字段时不写 cached_tokens（界面不会显示“缓存命中 0”）', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        choices: [{ message: { content: '回答正文' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 }
      })
    );
    const collected = await collectModelUsage(() =>
      callChatModel(config, '系统提示', '材料正文')
    );
    expect(collected.usage).not.toHaveProperty('cached_tokens');
  });

  it('没有模型调用时没有 usage', async () => {
    const collected = await collectModelUsage(async () => 42);
    expect(collected.usage).toBeUndefined();
  });
});
