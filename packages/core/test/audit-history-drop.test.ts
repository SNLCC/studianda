import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditInstruction } from '../src/audit.js';
import { inputCost, messages } from '../src/request-budget.js';
import {
  auditGeneratedAnswer,
  historyDropNotice,
  prepareHistory
} from '../src/reading-chat.js';

/**
 * 审计阶段的历史丢弃计数（`AuditReport.history_dropped`）与 notice 合并口径。
 *
 * 盯三件事：① 审计请求因容量丢历史时累计轮数写进报告；② 没丢就不出现该字段；
 * ③ notice 把「最终回答」与「审计」两个阶段合成一条，不重复报同一件事。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchAnsweringAudit = () =>
  vi.fn(async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const material = request.messages[request.messages.length - 1]?.content ?? '';
    const start = material.indexOf('{');
    const parsed = JSON.parse(material.slice(start)) as {
      answer_lines?: Array<{ claim: number; text: string }>;
    };
    const claims = (parsed.answer_lines ?? []).map((line) => ({
      claim: line.claim,
      verdict: 'unsupported',
      reason: '缺证'
    }));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ claims }) } }] })
    } as unknown as Response;
  });

const config = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'mock' };
const answer = '第一段内容。\n第二段内容。';
const inputs = { evidenceIndex: [], originals: [] };

/** 20 轮、每轮很长的历史：任何小预算下都必然要丢。 */
const history = Array.from({ length: 20 }, (_, index) => ({
  question: `问题${index + 1}`.repeat(200),
  answer: `回答${index + 1}`.repeat(2000)
}));

describe('audit.history_dropped', () => {
  it('审计因容量丢历史时累计轮数并写进报告', async () => {
    vi.stubGlobal('fetch', fetchAnsweringAudit());
    const limit = 20000;
    const report = await auditGeneratedAnswer(
      config,
      answer,
      inputs,
      undefined,
      false,
      '',
      undefined,
      [],
      limit,
      history
    );
    // 用同一份指令/材料/预算复算期望值：审计内部也是按「剩余容量」从最旧丢。
    const instruction = auditInstruction(false, undefined);
    const material = JSON.stringify(
      {
        answer_lines: [
          { claim: 1, text: '第一段内容。' },
          { claim: 2, text: '第二段内容。' }
        ],
        evidence_index: []
      },
      null,
      2
    );
    const expected = prepareHistory(
      history,
      limit - inputCost(messages(instruction, material))
    ).dropped;
    expect(expected).toBeGreaterThan(0);
    expect(report.history_dropped).toBe(expected);
    // 审计正文语义不变：两段都照常核对（unsupported 是假模型给的判定）。
    expect(report.claims).toHaveLength(2);
    expect(report.claims.every((claim) => claim.verdict === 'unsupported')).toBe(true);
    expect(report.status).toBe('已进行模型证据支持复核');
  });

  it('没有丢历史时不出现 history_dropped 字段', async () => {
    vi.stubGlobal('fetch', fetchAnsweringAudit());
    const report = await auditGeneratedAnswer(
      config,
      answer,
      inputs,
      undefined,
      false,
      '',
      undefined,
      [],
      1_000_000,
      [{ question: '上一问', answer: '上一答' }]
    );
    expect(report.history_dropped).toBeUndefined();
    expect(report.claims).toHaveLength(2);
  });

  it('不传历史时与既有行为一致（无字段、claims 不变）', async () => {
    vi.stubGlobal('fetch', fetchAnsweringAudit());
    const report = await auditGeneratedAnswer(
      config,
      answer,
      inputs,
      undefined,
      false,
      '',
      undefined,
      [],
      20_000
    );
    expect(report.history_dropped).toBeUndefined();
    expect(report.claims).toHaveLength(2);
    expect(report.status).toBe('已进行模型证据支持复核');
  });

  it('多包审计取「最大丢弃轮数」而不是相加（同一份历史不重复计）', async () => {
    vi.stubGlobal('fetch', fetchAnsweringAudit());
    const lines = Array.from({ length: 15 }, (_, index) => `第 ${index + 1} 段内容。`).join(
      '\n'
    );
    const report = await auditGeneratedAnswer(
      config,
      lines,
      inputs,
      undefined,
      false,
      '',
      undefined,
      [],
      20000,
      history
    );
    expect(report.history_dropped).toBeGreaterThan(0);
    // 20 轮历史最多丢 20 轮；若把多个审计包的丢弃相加会 >20。
    expect(report.history_dropped).toBeLessThanOrEqual(20);
    expect(report.claims).toHaveLength(15);
  });
});

describe('historyDropNotice 合并口径', () => {
  it('两边都没丢时返回空串（调用方不 push）', () => {
    expect(historyDropNotice(0, 0)).toBe('');
    expect(historyDropNotice(0, undefined)).toBe('');
    expect(historyDropNotice(0, NaN)).toBe('');
  });

  it('只有最终回答丢：沿用原文案', () => {
    expect(historyDropNotice(2, 0)).toBe(
      '为容量省略了 2 轮历史（从最旧开始）；逐字证据未截断。'
    );
    expect(historyDropNotice(2, undefined)).toContain('为容量省略了 2 轮历史');
  });

  it('只有审计丢：明确说是审计阶段', () => {
    expect(historyDropNotice(0, 3)).toBe(
      '审计阶段为容量省略了 3 轮历史（从最旧开始）；逐字证据未截断。'
    );
  });

  it('两边都丢：合并成一条并分别说明，不重复报两遍', () => {
    const note = historyDropNotice(2, 3);
    expect(note).toContain('最终回答 2 轮、审计核对 3 轮');
    expect(note.match(/为容量省略了/g)).toHaveLength(1);
    expect(note).toContain('逐字证据未截断');
  });

  it('负数/小数/非有限值按 0 处理（计数只报真实发生的）', () => {
    expect(historyDropNotice(-3, -1)).toBe('');
    expect(historyDropNotice(2.9, 0)).toBe(
      '为容量省略了 2 轮历史（从最旧开始）；逐字证据未截断。'
    );
    expect(historyDropNotice(Number.POSITIVE_INFINITY, 0)).toBe('');
  });
});
