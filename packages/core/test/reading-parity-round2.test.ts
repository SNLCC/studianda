import { describe, expect, it } from 'vitest';
import {
  evidenceAccounting,
  fitBank,
  TURN_READ_BATCHES,
  turnReadBatches,
  type EvidenceBankRecord,
  type ReadingFinding
} from '../src/reading-executor.js';
import { ledgerSummary, unrecordedLedger } from '../src/coverage.js';

function bankItem(key: string, quote: string): EvidenceBankRecord {
  return {
    source: 1,
    quote,
    evidence_key: key,
    origin_batch: 1
  };
}

function finding(evidences: Array<{ source: number; quote: string; evidence_key?: string }>): ReadingFinding {
  return {
    analysis: '本批要点',
    evidence: evidences,
    no_relevant_evidence: false,
    documents: []
  } as unknown as ReadingFinding;
}

describe('单轮批次硬上限', () => {
  it('常量是 12；用户设置更大时本轮实际仍最多 12 批', () => {
    expect(TURN_READ_BATCHES).toBe(12);
    expect(turnReadBatches(64)).toBe(12);
    expect(turnReadBatches(20)).toBe(12);
  });

  it('小于 12 时按用户设置；非法值退回 12；至少 1 批', () => {
    expect(turnReadBatches(5)).toBe(5);
    expect(turnReadBatches(0)).toBe(1);
    expect(turnReadBatches(Number.NaN)).toBe(12);
    expect(turnReadBatches(-3)).toBe(1);
  });
});

describe('fitBank 预算口径（token，与 Python room=int(budget*share) 一致）', () => {
  it('按 token 预算截断并如实报 dropped/dropped_keys', () => {
    const quote = '字'.repeat(300);
    const bank = [bankItem('a', quote), bankItem('b', quote), bankItem('c', quote)];
    // budget=1000 token，share=.6 → room=600 token；每条约 300 token，只装得下 1 条。
    const fitted = fitBank(bank, 1000);
    expect(fitted.report.available).toBe(3);
    expect(fitted.report.kept).toBe(1);
    expect(fitted.report.dropped).toBe(2);
    expect(fitted.report.dropped_keys).toEqual(['b', 'c']);
  });

  it('预算足够时不截断证据', () => {
    const bank = [bankItem('a', '短文'), bankItem('b', '短文')];
    const fitted = fitBank(bank, 100_000);
    expect(fitted.report.kept).toBe(2);
    expect(fitted.report.dropped).toBe(0);
    expect(fitted.report.dropped_keys).toEqual([]);
  });
});

describe('evidence_accounting 的 origin/dropped_keys', () => {
  it('能指认每条证据来自哪一批，并报出被容量截断的 key', () => {
    const findings = [
      finding([{ source: 1, quote: '甲'.repeat(50) }]),
      finding([
        { source: 2, quote: '乙'.repeat(50) },
        { source: 3, quote: '丙'.repeat(50) }
      ])
    ];
    const bank = [
      bankItem(
        `${1}\u001f${'甲'.repeat(50)}`,
        '甲'.repeat(50)
      )
    ];
    const accounting = evidenceAccounting(findings, bank, []);
    expect(accounting?.origin).toBeTruthy();
    const keys = Object.keys(accounting!.origin);
    expect(keys.length).toBe(3);
    // 第一条证据来自第 1 批，其余来自第 2 批（按 evidence_key 或来源+引文生成）。
    const firstKey = keys.find((key) => accounting!.origin[key]!.includes(1));
    expect(firstKey).toBeTruthy();
    const secondKey = keys.find((key) => accounting!.origin[key]!.includes(2));
    expect(secondKey).toBeTruthy();
    // 没有下落的两条进入 unaccounted（银行只留了一条且没有 dropped_keys）。
    expect(accounting!.unaccounted.length).toBe(2);
  });

  it('dropped_keys 里的证据不算无声丢失', () => {
    const findings = [finding([{ source: 1, quote: '甲'.repeat(40), evidence_key: 'k1' }])];
    const accounting = evidenceAccounting(findings, [], ['k1']);
    expect(accounting!.dropped_keys).toEqual(['k1']);
    expect(accounting!.unaccounted).toEqual([]);
  });
});

describe('ledgerSummary', () => {
  it('统计总数、各状态条数与读不了的页', () => {
    const rows = unrecordedLedger(
      [
        { code: 'D1', label: '概念' },
        { code: 'D2', label: '方法' }
      ],
      '未逐批记账'
    );
    rows[0]!.unreadable_pages = [3, 5];
    const summary = ledgerSummary(rows);
    expect(summary.total).toBe(2);
    expect(summary.by_status[rows[0]!.status]).toBe(2);
    expect(summary.unreadable_pages).toEqual([3, 5]);
  });
});
