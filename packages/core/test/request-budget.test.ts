import { afterEach, describe, expect, it, vi } from 'vitest';
import { cost } from '../src/reading.js';
import {
  DEFAULT_EVIDENCE_LABEL,
  EVIDENCE_SYSTEM_PROMPT,
  IMAGE_RESERVE_COST,
  MESSAGE_FRAMING_COST,
  PER_MESSAGE_COST,
  PLAIN_SYSTEM_PREFIX,
  fits,
  inputCost,
  messages,
  prefix
} from '../src/request-budget.js';
import { callChatModel } from '../src/reading-chat.js';

/**
 * 请求容量口径与最后一道降级。
 *
 * 这里盯两件事：① 计的是**模型可见消息**（不是 JSON 转义长度），常量与逐条开销固定；
 * ② 装不下时 callChatModel **不发请求**、抛明确错误，绝不截断材料冒充成功。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('messages', () => {
  it('有证据时顺序为 system(证据提示) / user(证据) / system(指令) / prior / user(材料)', () => {
    const prior = [
      { role: 'user' as const, content: '历史问' },
      { role: 'assistant' as const, content: '历史答' }
    ];
    const rows = messages('指令', '材料', prior, '逐字证据', '证据标签');
    expect(rows.map((row) => row.role)).toEqual([
      'system',
      'user',
      'system',
      'user',
      'assistant',
      'user'
    ]);
    expect(rows[0]?.content).toBe(EVIDENCE_SYSTEM_PROMPT);
    expect(rows[1]?.content).toBe('证据标签：\n逐字证据');
    expect(rows[2]?.content).toBe('指令');
    expect(rows[3]?.content).toBe('历史问');
    expect(rows[4]?.content).toBe('历史答');
    expect(rows[5]?.content).toBe('材料');
  });

  it('没有证据时把指令并在固定 system 前缀里，证据为空串也走这一支', () => {
    expect(messages('指令', '材料').map((row) => row.content)).toEqual([
      PLAIN_SYSTEM_PREFIX + '指令',
      '材料'
    ]);
    expect(messages('指令', '材料', [], '').map((row) => row.content)).toEqual([
      PLAIN_SYSTEM_PREFIX + '指令',
      '材料'
    ]);
    // 默认标签固定。
    expect(DEFAULT_EVIDENCE_LABEL).toBe('文献原文参考');
  });
});

describe('inputCost', () => {
  it('256 + Σ(cost(content)+16) + 4096×图片数', () => {
    expect(MESSAGE_FRAMING_COST).toBe(256);
    expect(PER_MESSAGE_COST).toBe(16);
    expect(IMAGE_RESERVE_COST).toBe(4096);
    const rows = messages('指令', '材料');
    const expected =
      256 + (cost(rows[0]!.content) + 16) + (cost(rows[1]!.content) + 16);
    expect(inputCost(rows)).toBe(expected);
    expect(inputCost(rows, 2)).toBe(expected + 4096 * 2);
    expect(inputCost([])).toBe(256);
  });
});

describe('fits', () => {
  it('边界：恰好等于上限算装得下，少 1 就算装不下', () => {
    const instruction = '指令内容';
    const material = '材料内容'.repeat(20);
    const expected = inputCost(messages(instruction, material));
    expect(fits(instruction, material, expected)).toBe(true);
    expect(fits(instruction, material, expected - 1)).toBe(false);
  });

  it('带证据时按证据分支的消息形状计数', () => {
    const expected = inputCost(messages('指令', '材料', [], '证据'));
    expect(fits('指令', '材料', expected, '证据')).toBe(true);
    expect(fits('指令', '材料', expected - 1, '证据')).toBe(false);
  });
});

describe('prefix', () => {
  it('room<=0 返回空串；装得下就原样返回', () => {
    expect(prefix('任意文字', 0)).toBe('');
    expect(prefix('任意文字', -10)).toBe('');
    expect(prefix('短文本', 1000)).toBe('短文本');
    expect(prefix('', 100)).toBe('');
  });

  it('中文超长：结果是原串前缀且成本不超过 room', () => {
    const text = '这是一段很长的中文说明。'.repeat(100);
    const room = 100;
    const clipped = prefix(text, room);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.length).toBeLessThan(text.length);
    expect(text.startsWith(clipped)).toBe(true);
    expect(cost(clipped)).toBeLessThanOrEqual(room);
  });

  it('英文超长：按字符成本二分，不超 room', () => {
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(100);
    const room = 60;
    const clipped = prefix(text, room);
    expect(text.startsWith(clipped)).toBe(true);
    expect(cost(clipped)).toBeLessThanOrEqual(room);
    expect(cost(clipped + 'x')).toBeGreaterThan(room);
  });
});

describe('callChatModel 的请求容量闸门', () => {
  const config = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'mock' };
  const okFetch = (content: string) =>
    vi.fn(async (_url: string, init: { body: string }) => {
      void init;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content }, finish_reason: 'stop' }]
        })
      } as unknown as Response;
    });

  it('超限时不调用 fetch，并抛出含预计/上限的明确错误', async () => {
    const fetchMock = okFetch('不该返回');
    vi.stubGlobal('fetch', fetchMock);
    const system = '系统指令'.repeat(20);
    const material = '材料内容'.repeat(500);
    const expected = inputCost(messages(system, material));
    await expect(
      callChatModel(
        config,
        system,
        material,
        1200,
        undefined,
        undefined,
        undefined,
        expected - 1,
        '形成文献分析'
      )
    ).rejects.toThrow(
      new RegExp(
        `^形成文献分析：预计输入 ${expected}，有效输入上限 ${expected - 1}；当前问题或材料无法完整装入，未截断原文。$`
      )
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('恰好装下时正常调用一次 fetch（消息按 request_budget.messages 口径生成）', async () => {
    const fetchMock = okFetch('回答');
    vi.stubGlobal('fetch', fetchMock);
    const system = '系统指令';
    const material = '材料';
    const limit = inputCost(messages(system, material));
    const answer = await callChatModel(
      config,
      system,
      material,
      1200,
      undefined,
      undefined,
      undefined,
      limit
    );
    expect(answer).toBe('回答');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    // callChatModel 现在统一走 request_budget.messages（含固定 system 前缀，prior 为空）。
    expect(body.messages).toEqual(messages(system, material));
  });

  it('不传 inputLimit 时行为不变（兼容既有调用）', async () => {
    const fetchMock = okFetch('旧调用');
    vi.stubGlobal('fetch', fetchMock);
    const answer = await callChatModel(config, 's', 'u', 800);
    expect(answer).toBe('旧调用');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
