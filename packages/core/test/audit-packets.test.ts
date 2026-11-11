import { describe, expect, it } from 'vitest';
import { passages, select, type AuditOriginal } from '../src/audit-packets.js';
import { cost } from '../src/reading.js';

/**
 * 审计定向原文包的回归测试。
 *
 * 这些用例盯的是「哪一段原文进了包」而不是模型输出：选段错了，核对就变成了
 * 拿无关原文给论断背书——那比不做核对更糟。
 */

function originalsOf(rows: Array<Partial<AuditOriginal> & { text: string }>): AuditOriginal[] {
  return rows.map((row, index) => ({
    document_id: 'doc-1',
    page: index + 1,
    source_type: 'document',
    ...row
  }));
}

function verifiedQuotes(context: string): Array<Record<string, unknown>> {
  return (JSON.parse(context) as { verified_quotes: Array<Record<string, unknown>> }).verified_quotes;
}

describe('passages', () => {
  it('小于切片宽度时整段返回', () => {
    expect(passages('短文本', 600)).toEqual([[0, 3, '短文本']]);
    expect(passages('', 600)).toEqual([]);
  });

  it('边界优先落在换行之后，并保留重叠', () => {
    expect(passages('abc\ndef', 6, 2)).toEqual([
      [0, 4, 'abc\n'],
      [2, 7, 'c\ndef']
    ]);
  });

  it('没有换行/句号时硬切，重叠计入下一片', () => {
    expect(passages('abcdefghij', 6, 2)).toEqual([
      [0, 6, 'abcdef'],
      [4, 10, 'efghij']
    ]);
  });

  it('中文句号也算边界（只从半程之后找，避免切出极短尾巴）', () => {
    const text = '甲'.repeat(400) + '。' + '乙'.repeat(400);
    const chunks = passages(text, 600, 150);
    expect(chunks[0]?.[1]).toBe(401);
    expect(chunks[0]?.[2].endsWith('。')).toBe(true);
    // 偏移切片必须与原文逐字一致（这是“逐字摘引”的地基）。
    for (const [start, end, piece] of chunks) {
      expect(text.slice(start, end)).toBe(piece);
    }
  });

  it('最后一段之后停止，不会产生空片段', () => {
    const chunks = passages('甲'.repeat(700), 600, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(([, , piece]) => piece.length > 0)).toBe(true);
  });
});

describe('select', () => {
  it('紧预算时只保留被引用来源（cited-first）', () => {
    const text1 = '概念界定指对某个术语的说明。';
    const text2 = '无关内容。';
    const originals = originalsOf([{ text: text1 }, { text: text2 }]);
    // 预算恰好够第一条（被引用来源）的片段：第二条只能被拒绝。
    const firstItem = {
      source: 1,
      quote: text1,
      evidence_key: 'E1',
      offset_start: 0,
      offset_end: text1.length,
      source_type: 'document'
    };
    const budget = cost(JSON.stringify({ verified_quotes: [firstItem] }));
    const result = select('概念界定 [1]', originals, new Set([1, 2]), budget);
    expect(result.report.selected_passages).toBe(1);
    expect(result.report.sources).toEqual([1]);
    expect(verifiedQuotes(result.context)).toHaveLength(1);
    expect(result.index.E1?.quote).toBe(text1);
  });

  it('把被引用来源排在未被引用来源之前（即使后者词面也命中）', () => {
    const originals = originalsOf([{ text: '无关内容。' }, { text: '概念界定指说明。' }]);
    const single = { source: 2, quote: '概念界定指说明。' };
    const budget = cost(
      JSON.stringify({
        verified_quotes: [
          {
            ...single,
            evidence_key: 'E1',
            offset_start: 0,
            offset_end: 8,
            source_type: 'document'
          }
        ]
      })
    );
    const result = select('概念界定 [2]', originals, new Set([1, 2]), budget);
    expect(result.report.sources).toEqual([2]);
  });

  it('相邻片段保留跨边界的限定条件（adjacent qualifier）', () => {
    const head = '被引用的论断，说明概念界定是基础。';
    const first = head + '甲'.repeat(500 - head.length) + '\n';
    const qualifier = '然而，这一结论只在样本足够大时成立。';
    const text = first + qualifier + '乙'.repeat(300);
    const originals = originalsOf([{ text }]);
    const result = select('概念界定 [1]', originals, new Set([1]), 100_000);
    expect(result.report.selected_passages).toBeGreaterThan(1);
    expect(result.report.sources).toEqual([1]);
    const quotes = verifiedQuotes(result.context).map((item) => String(item.quote));
    expect(quotes.some((quote) => quote.includes('然而'))).toBe(true);
    // 每一条的 offset 切片都必须逐字等于 quote。
    for (const item of Object.values(result.index)) {
      expect(text.slice(item.offset_start, item.offset_end)).toBe(item.quote);
    }
  });

  it('预算不超：装不下就停，不静默超容量', () => {
    const text = '甲'.repeat(3000);
    const originals = originalsOf([{ text }]);
    const result = select('问题 [1]', originals, new Set([1]), 500);
    expect(cost(result.context)).toBeLessThanOrEqual(500);
    expect(result.report.available_passages).toBeGreaterThan(0);
    expect(result.report.mode).toBe('按论断选取原文片段，非全书穷尽核查');
  });

  it('预算为 0 时返回空包，而不是编一段原文', () => {
    const originals = originalsOf([{ text: '概念界定指说明。' }]);
    const result = select('概念界定 [1]', originals, new Set([1]), 0);
    expect(result.report.selected_passages).toBe(0);
    expect(result.report.sources).toEqual([]);
    expect(result.index).toEqual({});
    expect(verifiedQuotes(result.context)).toEqual([]);
  });

  it('cited 只认 allowed 内的编号；越界来源被忽略', () => {
    const originals = originalsOf([{ text: '概念界定指说明。' }, { text: '另一段无关文字。' }]);
    // 紧预算：只够被引用那一侧的第一条，用来证明 [99] 不会把候选带进来、[2] 优先于 [1]。
    const budget = cost(
      JSON.stringify({
        verified_quotes: [
          {
            source: 2,
            quote: '另一段无关文字。',
            evidence_key: 'E1',
            offset_start: 0,
            offset_end: 8,
            source_type: 'document'
          }
        ]
      })
    );
    const result = select('只引用 [2]，还写了越界的 [99]', originals, new Set([1, 2]), budget);
    expect(result.report.sources).toEqual([2]);
    expect(result.report.available_passages).toBe(2);
    expect(Object.values(result.index).every((item) => item.source <= 2)).toBe(true);
  });

  it('report/index/context 三者一致：index 的 key 就是 evidence_key', () => {
    const originals = originalsOf([{ text: '概念界定指对术语的说明。' }, { text: '理论依据来自原文。' }]);
    const result = select('概念 [1]，依据 [2]', originals, new Set([1, 2]), 100_000);
    const items = Object.values(result.index);
    expect(result.report.selected_passages).toBe(items.length);
    expect(verifiedQuotes(result.context)).toEqual(items);
    for (const [key, item] of Object.entries(result.index)) {
      expect(key).toBe(item.evidence_key);
      expect(item.evidence_key).toMatch(/^E\d+$/);
    }
    expect(result.report.sources).toEqual([...new Set(items.map((item) => item.source))].sort((a, b) => a - b));
  });
});
