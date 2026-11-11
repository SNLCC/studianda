import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@studianda/shared';
import { answerWithCorpus, answerWithReading } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let firstDoc = '';
let secondDoc = '';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importPdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([300, 400]);
    // 每份样张写入不同文字，避免字节完全相同被重复检测当成同一篇。
    page.drawText(name, { x: 20, y: 20, size: 8, font });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return document.id;
}

/** 从批次材料里取第一段原文，作为模型"逐字摘引"返回（保证能通过核验）。 */
function quoteFromMaterial(user: string): string {
  const match = /\[1\][^\n]*\n([^\n]{4,})/.exec(user);
  return (match?.[1] ?? '').trim().slice(0, 60);
}

interface CallCounts {
  batch: number;
  synthesis: number;
  audit: number;
}

function mockModel(): CallCounts {
  const counts: CallCounts = { batch: 0, synthesis: 0, audit: 0 };
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    // 审计请求会带独立的证据 system 消息；指令在后面，因此要把所有 system 拼起来判断。
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = '';
    if (system.includes('READING_BATCH')) {
      counts.batch += 1;
      const quote = quoteFromMaterial(user);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
      counts.audit += 1;
      const evidence = firstAuditEvidence(user);
      content = JSON.stringify({
        claims: [
          {
            claim: 1,
            verdict: 'supported',
            reason: '原文支持',
            claim_type: 'DOCUMENT_INTERPRETATION',
            evidence_standard: 'GROUNDED',
            evidence: evidence ? [evidence] : []
          }
        ]
      });
    } else {
      counts.synthesis += 1;
      content = '跨文献回答：这批文献给出了相关论述。';
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return counts;
}

/** 从审计材料里取一条已给原文，作为 supported 的逐字证据。 */
function firstAuditEvidence(user: string): { source: number; quote: string } | null {
  const start = user.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(user.slice(start)) as {
      evidence_index?: unknown;
      verified_quotes?: unknown;
    };
    const list = Array.isArray(parsed.verified_quotes)
      ? parsed.verified_quotes
      : Array.isArray(parsed.evidence_index)
        ? parsed.evidence_index
        : [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const item = row as { source?: unknown; quote?: unknown };
      if (typeof item.quote === 'string' && item.quote.trim().length >= 4) {
        return {
          source: typeof item.source === 'number' ? item.source : 1,
          quote: item.quote.trim().slice(0, 120)
        };
      }
    }
  } catch {
    // 材料不是 JSON（或半截）：按没有证据处理。
  }
  return null;
}

const config = {
  baseUrl: 'https://model.example.com/v1',
  apiKey: 'k-1',
  model: 'chat-model'
};

beforeAll(async () => {
  firstDoc = await importPdf('first.pdf', 2);
  secondDoc = await importPdf('second.pdf', 2);
  store.savePageTextEdit(firstDoc, 1, '甲文献第一页：讨论模型的定义。');
  store.savePageTextEdit(firstDoc, 2, '甲文献第二页：补充说明。');
  store.savePageTextEdit(secondDoc, 1, '乙文献第一页：也讨论模型训练。');
  store.savePageTextEdit(secondDoc, 2, '乙文献第二页：结论。');
}, 120_000);

describe('跨文献阅读走逐批管线', () => {
  it('按 discovery 排序逐篇读取，返回逐篇页数与候选/选中数', async () => {
    mockModel();
    const progress: number[] = [];
    const result = (await answerWithCorpus(
      store,
      secrets,
      config,
      '模型训练',
      '',
      [firstDoc, secondDoc],
      6000,
      undefined,
      undefined,
      false,
      undefined,
      (done) => progress.push(done)
    )) as ChatResponse;

    expect(result.reading_scope).toBe('corpus');
    expect(result.plan?.breadth).toBe('discovery');
    expect(result.answer).toContain('跨文献回答');
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) {
      expect([firstDoc, secondDoc]).toContain(source.documentId);
    }
    const coverage = result.coverage!;
    expect(coverage.candidate_documents).toBe(2);
    expect(coverage.selected_documents).toBe(2);
    expect(coverage.documents).toHaveLength(2);
    // 当前文献（传入的第一篇）永远第一；另一篇按命中数排序。
    expect(coverage.discovery?.ordered_ids[0]).toBe(firstDoc);
    expect(coverage.discovery?.hit_documents).toBe(1);
    expect(coverage.discovery?.scores[secondDoc]).toBeGreaterThan(0);
    expect(coverage.discovery?.scores[firstDoc]).toBe(0);
    expect(coverage.full_extracted_text).toBe(true);
    expect(coverage.indexed_pages).toBe(4);
    expect(coverage.total_pages).toBe(4);
    for (const report of coverage.documents!) {
      expect(report.read_pages).toHaveLength(2);
      expect(report.missing_pages).toHaveLength(0);
      expect(report.whole_document).toBe(true);
    }
    expect(progress.length).toBeGreaterThan(0);
  });

  it('单轮批次上限触发延期，并对延期页里的命中页补读', async () => {
    store.updateSettings({ 'reading.max_read_batches': '1' });
    try {
      const long = '模型内容。' + '说明段落。'.repeat(400);
      for (const documentId of [firstDoc, secondDoc]) {
        for (let page = 1; page <= 2; page += 1) {
          store.savePageTextEdit(documentId, page, `${long}第${page}页。`);
        }
      }
      const counts = mockModel();
      const result = (await answerWithCorpus(
        store,
        secrets,
        config,
        '模型',
        '',
        [firstDoc, secondDoc],
        6000
      )) as ChatResponse;
      expect(counts.batch).toBeGreaterThanOrEqual(2);
      expect(result.notice ?? '').toContain('补读');
      expect(result.coverage?.documents?.length).toBe(2);
    } finally {
      store.updateSettings({ 'reading.max_read_batches': '12' });
      store.savePageTextEdit(firstDoc, 1, '甲文献第一页：讨论模型的定义。');
      store.savePageTextEdit(firstDoc, 2, '甲文献第二页：补充说明。');
      store.savePageTextEdit(secondDoc, 1, '乙文献第一页：也讨论模型训练。');
      store.savePageTextEdit(secondDoc, 2, '乙文献第二页：结论。');
    }
  }, 120_000);

  it('文本疑似乱码的页进入质量报告，且不再宣称读到全篇', async () => {
    // 坏字符占比 > 2%：应被 text_quality 判为可疑。
    store.savePageTextEdit(firstDoc, 1, `${'正常文字。'.repeat(10)}${'\uFFFD'.repeat(4)}`);
    try {
      mockModel();
      const result = (await answerWithCorpus(
        store,
        secrets,
        config,
        '模型训练',
        '',
        [firstDoc, secondDoc],
        6000
      )) as ChatResponse;
      expect(result.coverage?.quality_pages).toContain(1);
      expect(result.coverage?.full_extracted_text).toBe(false);
      expect(result.notice ?? '').toContain('乱码');
      const report = result.coverage?.documents?.find(
        (item) => item.document_id === firstDoc
      );
      expect(report?.quality_pages).toContain(1);
    } finally {
      store.savePageTextEdit(firstDoc, 1, '甲文献第一页：讨论模型的定义。');
    }
  });

  it('单篇读后缺口检索会补读未读的相关页', async () => {
    try {
      mockModel();
      const result = await answerWithReading(
        store,
        secrets,
        config,
        '模型',
        '',
        firstDoc,
        1,
        {
          breadth: 'local',
          reason: '测试局部阅读',
          origin: '规则',
          pages: [1],
          // 只在规划查询词里出现的术语：读前 sweep 不会覆盖，留给读后缺口检索。
          queries: ['补充'],
          dimensions: []
        },
        6000,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'fast'
      );
      expect(result?.notice ?? '').toContain('补读');
    } finally {
      // 不改动页面文本；这里只验证读后缺口检索的触发路径。
    }
  });
});


