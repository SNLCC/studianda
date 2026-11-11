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

function sseResponse(rows: string[]): Response {
  const encoder = new TextEncoder();
  const body = rows.map((row) => `data: ${row}\n\n`).join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
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

  it('流式：usage chunk 夹在 SSE 里也计入', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '流式' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '回答' } }] }),
        JSON.stringify({
          choices: [],
          usage: { input_tokens: 88, output_tokens: 12, total_tokens: 100 }
        }),
        '[DONE]'
      ])
    );
    const deltas: string[] = [];
    const collected = await collectModelUsage(() =>
      callChatModel(config, '系统', '材料', 256, undefined, (delta) => deltas.push(delta))
    );
    expect(collected.result).toBe('流式回答');
    expect(deltas.join('')).toBe('流式回答');
    expect(collected.usage).toMatchObject({
      input_tokens: 88,
      output_tokens: 12,
      total_tokens: 100,
      calls: 1,
      estimated: false
    });
  });

  it('没有模型调用时没有 usage', async () => {
    const collected = await collectModelUsage(async () => 42);
    expect(collected.usage).toBeUndefined();
  });
});
