import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInBatches } from '../src/reading-executor.js';
import type { ReadingSource } from '../src/reading.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'reading-batches-parity.json'),
    'utf8'
  )
) as { overlapSources: ReadingSource[] };

describe('readInBatches execution', () => {
  it('reads multiple batches, verifies quotes and builds an evidence bank', async () => {
    const asks: string[] = [];
    const result = await readInBatches(fixture.overlapSources, 300, async (_instruction, material) => {
      asks.push(material);
      const match = material.match(/\[(\d+)\][^\n]*\n(overlap row \d+)/);
      const source = Number(match?.[1] ?? 1);
      const quote = match?.[2] ?? 'missing';
      return JSON.stringify({
        analysis: '要点',
        evidence: [{ source, quote }],
        no_relevant_evidence: false
      });
    });
    expect(asks.length).toBe(2);
    expect(result.report.multiPass).toBe(true);
    expect(result.report.findings).toBe(2);
    // 证据银行按 **token 预算**（budget 300 × share 0.6 = 180 token）截断：一条记录约占 115，
    // 因此只留得下 1 条；被截断的那条必须在 accounting 里有下落（dropped），不能无声丢失。
    expect(result.bank).toHaveLength(1);
    expect(result.bank.every((item) => item.origin_batch >= 1)).toBe(true);
    expect(result.report.evidence_accounting?.dropped).toBe(1);
    expect(result.report.evidence_accounting?.unaccounted).toEqual([]);
  });

  it('keeps unread batches as deferred pages when partial reading is allowed', async () => {
    const result = await readInBatches(
      fixture.overlapSources,
      300,
      async (_instruction, material) => {
        const match = material.match(/\[(\d+)\][^\n]*\n(overlap row \d+)/);
        const source = Number(match?.[1] ?? 1);
        const quote = match?.[2] ?? 'missing';
        return JSON.stringify({
          analysis: '要点',
          evidence: [{ source, quote }],
          no_relevant_evidence: false
        });
      },
      { maxBatches: 1, allowPartial: true }
    );
    expect(result.report.batches).toBe(1);
    expect(result.deferredBatches).toBeGreaterThan(0);
    expect(result.deferredPages.length).toBeGreaterThan(0);
    expect(result.readPages.length).toBeGreaterThan(0);
    expect(new Set([...result.readPages, ...result.deferredPages]).size).toBe(
      new Set(fixture.overlapSources.map((source) => source.page)).size
    );
    expect(result.report.evidence_accounting?.unaccounted).toEqual([]);
  });

  it('compresses analyses but keeps every verified evidence record in the bank', async () => {
    const sources: ReadingSource[] = Array.from({ length: 10 }, (_, index) => ({
      document_id: 'doc',
      page: index + 1,
      name: 'doc',
      text: `第 ${index + 1} 页的独特事实。${'限定条件与说明。'.repeat(80)}`
    }));
    const reduceCalls: string[] = [];
    const result = await readInBatches(
      sources,
      1200,
      async (instruction, material) => {
        if (instruction.includes('READING_REDUCE')) {
          reduceCalls.push(material);
          return JSON.stringify({ analysis: '合并后的分析要点。'.repeat(20) });
        }
        const match = material.match(/\[(\d+)\][^\n]*\n([^\n]+)/);
        const source = Number(match?.[1] ?? 1);
        const quote = match?.[2] ?? 'missing';
        return JSON.stringify({
          analysis: '分'.repeat(780),
          evidence: [{ source, quote }],
          no_relevant_evidence: false
        });
      },
      { maxBatches: 12 }
    );
    expect(reduceCalls.length).toBeGreaterThan(0);
    expect(result.report.reduce_layers).toBeGreaterThan(0);
    expect(result.findings.length).toBeLessThan(result.sourceFindings.length);
    expect(result.sourceFindings).toHaveLength(10);
    // 预算 1200 token × 0.6 = 720 token：每条证据（整行中文摘引）都超过这个额度，
    // 因此银行为空；但每条都被 accounting 记为 dropped（不是无声丢失）。
    expect(result.bank.length).toBe(0);
    expect(result.report.evidence_accounting?.dropped).toBeGreaterThan(0);
    expect(result.report.evidence_accounting?.unaccounted).toEqual([]);
  });

  it('stops reading when the request is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = readInBatches(
      fixture.overlapSources,
      300,
      async (_instruction, material) => {
        calls += 1;
        controller.abort();
        const match = material.match(/\[(\d+)\][^\n]*\n(overlap row \d+)/);
        return JSON.stringify({
          analysis: '要点',
          evidence: [{ source: Number(match?.[1] ?? 1), quote: match?.[2] ?? 'missing' }],
          no_relevant_evidence: false
        });
      },
      { signal: controller.signal }
    );
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('retries with repair feedback and accepts the corrected batch', async () => {
    let calls = 0;
    const result = await readInBatches(fixture.overlapSources, 300, async (_instruction, material) => {
      calls += 1;
      const match = material.match(/\[(\d+)\][^\n]*\n(overlap row \d+)/);
      const source = Number(match?.[1] ?? 1);
      const quote = match?.[2] ?? 'missing';
      if (calls === 1) {
        return JSON.stringify({
          analysis: '要点',
          evidence: [{ source, quote: 'INVENTED' }],
          no_relevant_evidence: false
        });
      }
      return JSON.stringify({
        analysis: '修正后的要点',
        evidence: [{ source, quote }],
        no_relevant_evidence: false
      });
    });
    expect(calls).toBe(3);
    expect(result.findings[0]?.analysis).toBe('修正后的要点');
  });
});

/** 从材料里取第一条来源编号与紧随其后的那一行原文（测试替身模型的统一口径）。 */
function quoteOf(material: string): { source: number; quote: string } {
  const match = material.match(/\[(\d+)\][^\n]*\n([^\n]+)/);
  return { source: Number(match?.[1] ?? 1), quote: match?.[2] ?? 'missing' };
}

interface MemoryCheckpoint {
  entries: Map<string, unknown>;
  load(stage: string): unknown | null;
  save(stage: string, value: unknown): void;
}

function memoryCheckpoint(): MemoryCheckpoint {
  const entries = new Map<string, unknown>();
  return {
    entries,
    load: (stage) => entries.get(stage) ?? null,
    save: (stage, value) => {
      entries.set(stage, value);
    }
  };
}

describe('readInBatches 检查点复用（内容寻址）', () => {
  const pages: ReadingSource[] = Array.from({ length: 4 }, (_, index) => ({
    document_id: 'doc',
    page: index + 1,
    name: 'doc',
    text: `第 ${index + 1} 页的独特内容。`
  }));
  const countingAsk = (counter: { calls: number }) => async (_instruction: string, material: string) => {
    counter.calls += 1;
    const { source, quote } = quoteOf(material);
    return JSON.stringify({
      analysis: `要点${source}`,
      evidence: [{ source, quote }],
      no_relevant_evidence: false
    });
  };

  it('同一输入第二次执行不再调用模型，且证据银行与首次一致', async () => {
    const checkpoint = memoryCheckpoint();
    const firstCounter = { calls: 0 };
    const first = await readInBatches(pages, 70, countingAsk(firstCounter), {
      checkpoint,
      identity: 'q1',
      overlap: 0
    });
    expect(first.report.batches).toBe(2);
    expect(firstCounter.calls).toBe(2);
    expect(first.report.resumed_batches).toBe(0);
    expect(checkpoint.entries.size).toBe(2);

    const second = await readInBatches(
      pages,
      70,
      async () => {
        throw new Error('模型不应被再次调用');
      },
      { checkpoint, identity: 'q1', overlap: 0 }
    );
    expect(second.report.resumed_batches).toBe(2);
    expect(second.findings).toHaveLength(2);
    expect(second.bank).toEqual(first.bank);
    expect(second.report.findings).toBe(2);
  });

  it('存档只放派生记录与逐字证据，不放整页原文', async () => {
    const checkpoint = memoryCheckpoint();
    await readInBatches(pages, 70, countingAsk({ calls: 0 }), {
      checkpoint,
      identity: 'q1',
      overlap: 0
    });
    const allowedKeys = new Set([
      'analysis',
      'evidence',
      'no_relevant_evidence',
      'dimension_hits',
      'dimension_reported',
      'documents'
    ]);
    for (const value of checkpoint.entries.values()) {
      const record = value as Record<string, unknown>;
      expect(Object.keys(record).every((key) => allowedKeys.has(key))).toBe(true);
      // 整页原文不进存档（逐字摘引属于核验产物，可以带）。
      expect(JSON.stringify(record)).not.toContain('第 2 页的独特内容。');
    }
  });

  it('identity 变了就不复用（换问题/模型后重新读）', async () => {
    const checkpoint = memoryCheckpoint();
    await readInBatches(pages, 70, countingAsk({ calls: 0 }), {
      checkpoint,
      identity: 'q1',
      overlap: 0
    });
    const counter = { calls: 0 };
    const other = await readInBatches(pages, 70, countingAsk(counter), {
      checkpoint,
      identity: 'q2',
      overlap: 0
    });
    expect(counter.calls).toBe(2);
    expect(other.report.resumed_batches).toBe(0);
  });

  it('页文本变了，至少那一批不复用（校订后必须重读）', async () => {
    const checkpoint = memoryCheckpoint();
    await readInBatches(pages, 70, countingAsk({ calls: 0 }), {
      checkpoint,
      identity: 'q1',
      overlap: 0
    });
    const edited = pages.map((row, index) =>
      index === 0 ? { ...row, text: '第 1 页已被校订的独特内容。' } : row
    );
    const counter = { calls: 0 };
    const third = await readInBatches(edited, 70, countingAsk(counter), {
      checkpoint,
      identity: 'q1',
      overlap: 0
    });
    expect(third.report.resumed_batches).toBeLessThan(2);
    expect(counter.calls).toBeGreaterThan(0);
  });

  it('损坏/越界的存档不被信任：重新读而不是直接用', async () => {
    const checkpoint = memoryCheckpoint();
    // 伪造一条「看起来像记录」但摘引在原文里不存在的存档。
    checkpoint.save(
      `batch:${'0'.repeat(32)}`,
      {
        analysis: '假的要点',
        evidence: [{ source: 1, quote: '这句原文不存在' }],
        no_relevant_evidence: false
      }
    );
    const counter = { calls: 0 };
    const result = await readInBatches(pages, 70, countingAsk(counter), {
      checkpoint,
      identity: 'q1',
      overlap: 0
    });
    expect(counter.calls).toBe(2);
    expect(result.report.resumed_batches).toBe(0);
  });
});

describe('readInBatches foreign 页补读', () => {
  const baseSources = (): ReadingSource[] => [
    { document_id: 'doc', page: 1, name: 'doc', text: '第一页讲背景。' },
    { document_id: 'doc', page: 2, name: 'doc', text: '第二页讲方法。' }
  ];
  const page3: ReadingSource = {
    document_id: 'doc',
    page: 3,
    name: 'doc',
    text: '第三页的独特句子。'
  };

  it('引到本批没读到的一页时按需补读并重跑本批（不消耗 3 次重试）', async () => {
    const sources = baseSources();
    const materials: string[] = [];
    const loaded: number[] = [];
    let calls = 0;
    const result = await readInBatches(
      sources,
      1000,
      async (_instruction, material) => {
        calls += 1;
        materials.push(material);
        if (calls === 1) {
          return JSON.stringify({
            analysis: '第一次要点',
            evidence: [{ source: 1, quote: page3.text }],
            no_relevant_evidence: false
          });
        }
        return JSON.stringify({
          analysis: '补读后的要点',
          evidence: [{ source: 3, quote: page3.text }],
          no_relevant_evidence: false
        });
      },
      {
        locate: (quote) => (quote === page3.text ? 3 : null),
        loadPage: (page) => {
          loaded.push(page);
          return page === 3 ? page3 : null;
        }
      }
    );
    expect(calls).toBe(2);
    expect(loaded).toEqual([3]);
    expect(result.report.batches).toBe(1);
    expect(result.findings[0]?.analysis).toBe('补读后的要点');
    // 补读页并入全局来源，编号 = 新长度，证据保留这个编号。
    expect(sources).toHaveLength(3);
    expect(result.bank).toHaveLength(1);
    expect(result.bank[0]?.source).toBe(3);
    expect(result.bank[0]?.page).toBe(3);
    expect(materials[1]).toContain('第三页的独特句子。');
    expect(materials[1]).toContain('本批补充');
    expect(result.readPages).toContain(3);
  });

  it('没有 loadPage 时如实报错（不把「读漏了」伪装成已核对）', async () => {
    const sources = baseSources();
    await expect(
      readInBatches(
        sources,
        1000,
        async () =>
          JSON.stringify({
            analysis: '要点',
            evidence: [{ source: 1, quote: page3.text }],
            no_relevant_evidence: false
          }),
        { locate: () => 3 }
      )
    ).rejects.toThrow(/没有提供按页补读能力/);
    expect(sources).toHaveLength(2);
  });
});

describe('readInBatches 压缩层检查点（reduce:）', () => {
  const longSources: ReadingSource[] = Array.from({ length: 10 }, (_, index) => ({
    document_id: 'doc',
    page: index + 1,
    name: 'doc',
    text: `第 ${index + 1} 页的独特事实。${'限定条件与说明。'.repeat(80)}`
  }));

  const makeAsk = (counters: { batches: number; reduces: number }) =>
    async (instruction: string, material: string) => {
      if (instruction.includes('READING_REDUCE')) {
        counters.reduces += 1;
        return JSON.stringify({ analysis: '合并分析要点。'.repeat(20) });
      }
      counters.batches += 1;
      const { source, quote } = quoteOf(material);
      return JSON.stringify({
        analysis: '分'.repeat(780),
        evidence: [{ source, quote }],
        no_relevant_evidence: false
      });
    };

  it('同一输入第二次执行复用 reduce 存档，不再调用模型', async () => {
    const checkpoint = memoryCheckpoint();
    const firstCounters = { batches: 0, reduces: 0 };
    const first = await readInBatches(longSources, 1200, makeAsk(firstCounters), {
      maxBatches: 12,
      checkpoint,
      identity: 'r1'
    });
    expect(firstCounters.reduces).toBeGreaterThan(0);
    expect(first.report.reduce_layers).toBeGreaterThan(0);
    expect(first.report.resumed_reduces).toBe(0);
    expect([...checkpoint.entries.keys()].some((key) => key.startsWith('reduce:'))).toBe(true);

    const secondCounters = { batches: 0, reduces: 0 };
    const second = await readInBatches(longSources, 1200, makeAsk(secondCounters), {
      maxBatches: 12,
      checkpoint,
      identity: 'r1'
    });
    expect(secondCounters.batches).toBe(0);
    expect(secondCounters.reduces).toBe(0);
    expect(second.report.resumed_batches).toBe(longSources.length);
    expect(second.report.resumed_reduces).toBeGreaterThan(0);
    expect(second.resumed_reduces).toBeGreaterThan(0);
    expect(second.findings).toEqual(first.findings);
    expect(second.bank).toEqual(first.bank);
    expect(second.report.reduce_layers).toBe(first.report.reduce_layers);
  });

  it('identity 变了就不复用（批次与压缩都要重读）', async () => {
    const checkpoint = memoryCheckpoint();
    await readInBatches(longSources, 1200, makeAsk({ batches: 0, reduces: 0 }), {
      maxBatches: 12,
      checkpoint,
      identity: 'r1'
    });
    const counters = { batches: 0, reduces: 0 };
    const other = await readInBatches(longSources, 1200, makeAsk(counters), {
      maxBatches: 12,
      checkpoint,
      identity: 'r2'
    });
    expect(counters.batches).toBeGreaterThan(0);
    expect(counters.reduces).toBeGreaterThan(0);
    expect(other.report.resumed_reduces).toBe(0);
    expect(other.report.resumed_batches).toBe(0);
  });

  it('损坏的 reduce 存档不被信任：重新调用模型而不是直接用', async () => {
    const checkpoint = memoryCheckpoint();
    await readInBatches(longSources, 1200, makeAsk({ batches: 0, reduces: 0 }), {
      maxBatches: 12,
      checkpoint,
      identity: 'r1'
    });
    // 把 reduce: 存档改成不完整内容（缺 analysis）：必须被识别为无效并重新压缩。
    for (const [key] of checkpoint.entries) {
      if (key.startsWith('reduce:')) checkpoint.entries.set(key, { analysis: '' });
    }
    const counters = { batches: 0, reduces: 0 };
    const third = await readInBatches(longSources, 1200, makeAsk(counters), {
      maxBatches: 12,
      checkpoint,
      identity: 'r1'
    });
    expect(counters.batches).toBe(0);
    expect(counters.reduces).toBeGreaterThan(0);
    expect(third.report.resumed_reduces).toBe(0);
  });
});
