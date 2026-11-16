import { afterEach, describe, expect, it, vi } from 'vitest';
import { callChatModel, type ReadingChatConfig } from '../src/reading-chat.js';
import {
  DEEPSEEK_THINKING_RESERVE,
  MINIMAX_THINKING_RESERVE,
  chatOutputOptions,
  finishReasonMessage,
  reasoningEffortOptions,
  thinkingOptions
} from '../src/model-protocol.js';

/**
 * DeepSeek 思考模式（官方文档 2026-11 版）：
 * - 思考默认开启、effort 默认 high，`temperature` 在思考模式下不生效；
 * - 思维链 token 计入 completion，`max_tokens` 限制的正是 completion 生成量；
 * - `reasoning_effort` 只对官方地址有意义，没配置时不发（沿用平台默认）。
 *
 * 这里锁住：过程性调用关闭思考、最终回答保留思考并按需加输出预留、非官方地址一个字都不多发。
 */

const DEEPSEEK = 'https://api.deepseek.com/v1';
const LOCAL = 'https://model.test/v1';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function recordBodies(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    return jsonResponse({ choices: [{ message: { content: '回答' }, finish_reason: 'stop' }] });
  });
  return bodies;
}

function deepseekConfig(extra: Partial<ReadingChatConfig> = {}): ReadingChatConfig {
  return { baseUrl: DEEPSEEK, apiKey: 'k', model: 'deepseek-flash', ...extra };
}

describe('DeepSeek 思考参数', () => {
  it('最终回答：显式开启思考、发送强度、并为思维链加输出预留', async () => {
    const bodies = recordBodies();
    await callChatModel(deepseekConfig({ reasoningEffort: 'low' }), '系统', '材料', 1200);
    expect(bodies[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      max_tokens: 1200 + DEEPSEEK_THINKING_RESERVE
    });
  });

  it('任务型调用：关闭思考，且不加预留、不发强度', async () => {
    const bodies = recordBodies();
    await callChatModel(
      deepseekConfig({ reasoningEffort: 'max' }),
      '系统',
      '材料',
      600,
      undefined,
      undefined,
      undefined,
      undefined,
      '压缩会话',
      [],
      true
    );
    expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 600 });
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('非官方地址一个字都不多发（即使配了强度）', async () => {
    const bodies = recordBodies();
    await callChatModel(
      { baseUrl: LOCAL, apiKey: 'k', model: 'chat-model', reasoningEffort: 'low' },
      '系统',
      '材料',
      1200
    );
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies[0]).toMatchObject({ max_tokens: 1200 });
  });
});

describe('整段返回（不再流式）', () => {
  it('请求固定 stream:false，正文回调不会被调用', async () => {
    const bodies = recordBodies();
    const deltas: string[] = [];
    const answer = await callChatModel(
      deepseekConfig(),
      '系统',
      '材料',
      1200,
      undefined,
      (delta) => deltas.push(delta)
    );
    expect(answer).toBe('回答');
    expect(bodies[0]).toMatchObject({ stream: false });
    expect(deltas).toEqual([]);
  });

  it('只有推理没有正文时给出可执行提示', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        choices: [{ message: { content: '', reasoning_content: '想了很久' } }]
      })
    );
    await expect(callChatModel(deepseekConfig(), '系统', '材料', 1200)).rejects.toThrow(
      '仅返回推理'
    );
  });
});

describe('服务方内容安全审核', () => {
  it('DeepSeek 最终回答默认发送 safety_check=high', async () => {
    const bodies = recordBodies();
    await callChatModel(deepseekConfig(), '系统', '材料', 1200);
    expect(bodies[0]).toMatchObject({ safety_check: { level: 'high' } });
  });

  it('任务型调用不发送（避免审核拖慢与误拒原文）', async () => {
    const bodies = recordBodies();
    await callChatModel(
      deepseekConfig(),
      '系统',
      '材料',
      600,
      undefined,
      undefined,
      undefined,
      undefined,
      '核对论断',
      [],
      true
    );
    expect(bodies[0]).not.toHaveProperty('safety_check');
  });

  it('用户显式关闭后不发送', async () => {
    const bodies = recordBodies();
    await callChatModel(deepseekConfig({ safetyCheck: false }), '系统', '材料', 1200);
    expect(bodies[0]).not.toHaveProperty('safety_check');
  });

  it('非官方地址不发送', async () => {
    const bodies = recordBodies();
    await callChatModel(
      { baseUrl: LOCAL, apiKey: 'k', model: 'chat-model' },
      '系统',
      '材料',
      1200
    );
    expect(bodies[0]).not.toHaveProperty('safety_check');
  });
});

describe('输出预算与结束原因', () => {
  it('chatOutputOptions：只有「官方地址 + 开启思考」才加预留', () => {
    expect(chatOutputOptions(DEEPSEEK, 1200, true)).toEqual({
      max_tokens: 1200 + DEEPSEEK_THINKING_RESERVE
    });
    expect(chatOutputOptions(DEEPSEEK, 1200, false)).toEqual({ max_tokens: 1200 });
    expect(chatOutputOptions(LOCAL, 1200, true)).toEqual({ max_tokens: 1200 });
    // MiniMax 恒为开启思考，预留规则保持不变；但输出上限用官方推荐的 max_completion_tokens。
    expect(chatOutputOptions('https://api.minimax.cn/v1', 1200, false)).toMatchObject({
      max_completion_tokens: 1200 + MINIMAX_THINKING_RESERVE
    });
  });

  it('thinkingOptions 只对官方地址生效', () => {
    expect(thinkingOptions(DEEPSEEK, false)).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingOptions(DEEPSEEK, true)).toEqual({ thinking: { type: 'enabled' } });
    expect(thinkingOptions(LOCAL, false)).toEqual({});
  });

  it('reasoningEffortOptions 只在配置了强度且是官方地址时发送', () => {
    expect(reasoningEffortOptions(DEEPSEEK, 'low')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningEffortOptions(DEEPSEEK, undefined)).toEqual({});
    expect(reasoningEffortOptions(LOCAL, 'max')).toEqual({});
  });

  it('新 finish_reason 有各自的可执行提示，正常结束不报错', () => {
    expect(finishReasonMessage('stop')).toBeNull();
    expect(finishReasonMessage('tool_calls')).toBeNull();
    expect(finishReasonMessage('length')).toContain('输出上限');
    // 服务端资源不足是可重试的临时故障，不能显示成"没有返回正文"。
    expect(finishReasonMessage('insufficient_system_resource')).toContain('稍后重试');
    expect(finishReasonMessage('content_filter')).toContain('内容安全');
    expect(finishReasonMessage('aborted')).toContain('中断');
  });
});
