import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { DocumentDetail, ReadingPlanRecord } from '@studianda/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { budgetThresholds, estimateBudget, estimateBudgetForScope } from '../src/budget.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-budget-'));
const sourceDir = mkdtempSync(path.join(tmpdir(), 'studianda-budget-src-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token: 'budget-token', version: 'test', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

function planOf(patch: Partial<ReadingPlanRecord>): ReadingPlanRecord {
  return {
    breadth: 'document',
    reason: 'test',
    origin: '规则',
    pages: [],
    queries: [],
    dimensions: [],
    ...patch
  };
}

async function writePdf(
  build: (pdf: PDFDocument) => void | Promise<void>
): Promise<string> {
  const pdf = await PDFDocument.create();
  await build(pdf);
  const file = path.join(sourceDir, `doc-${randomUUID()}.pdf`);
  writeFileSync(file, await pdf.save());
  return file;
}

/** 每页一行短文本，页数 = 行数。 */
function makeTextPdf(lines: string[]): Promise<string> {
  return writePdf((pdf) => {
    for (const line of lines) {
      const page = pdf.addPage([300, 400]);
      page.drawText(line, { x: 40, y: 340, size: 14 });
    }
  });
}

/** 没有文字层的空白页（用来验证"按每页 1500 token"的保守回退）。 */
function makeBlankPdf(pages: number): Promise<string> {
  return writePdf((pdf) => {
    for (let index = 0; index < pages; index += 1) pdf.addPage([300, 400]);
  });
}

/** 文本量很大的一篇（页数不变，用来只触发 token 阈值而不是页数阈值）。 */
function makeHeavyPdf(pages: number, linesPerPage: number): Promise<string> {
  const line = 'readable academic prose without any cjk characters '.repeat(2).slice(0, 140);
  return writePdf((pdf) => {
    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      const page = pdf.addPage([420, 594]);
      let y = 560;
      for (let lineIndex = 0; lineIndex < linesPerPage; lineIndex += 1) {
        page.drawText(`${pageIndex}-${lineIndex} ${line}`, { x: 20, y, size: 5 });
        y -= 9;
      }
    }
  });
}

function headers(): Record<string, string> {
  return { 'x-studianda-token': 'budget-token' };
}

describe('budget estimate', () => {
  it('estimates a document without calling a model', async () => {
    const document = await store.importDocument(TEST_PDF);
    const estimate = estimateBudget(
      store,
      {
        breadth: 'document',
        reason: 'test',
        origin: '规则',
        pages: [1, 2],
        queries: [],
        dimensions: []
      },
      document.id
    );
    expect(estimate.pages).toBe(2);
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.documents).toBe(1);
    expect(estimate.exceeded).toBe(false);
    expect(estimate.estimated).toBe(true);
    expect(estimate.thresholds).toEqual({ pages: 20, tokens: 60_000 });
  });

  it('marks a plan over the page threshold as exceeded', async () => {
    const document = await store.importDocument(TEST_PDF, undefined, true);
    const estimate = estimateBudget(
      store,
      {
        breadth: 'local',
        reason: 'test',
        origin: '规则',
        pages: Array.from({ length: 41 }, () => 1),
        queries: [],
        dimensions: []
      },
      document.id
    );
    expect(estimate.pages).toBe(41);
    expect(estimate.exceeded).toBe(true);
  });

  it('rejects a missing document', () => {
    expect(() =>
      estimateBudget(
        store,
        {
          breadth: 'local',
          reason: 'test',
          origin: '规则',
          pages: [1],
          queries: [],
          dimensions: []
        },
        'missing'
      )
    ).toThrow();
  });
});

describe('budget estimate for a cross-document scope', () => {
  let docA: DocumentDetail;
  let docB: DocumentDetail;
  let blankDoc: DocumentDetail;
  let heavyDoc: DocumentDetail;
  let heavyShortDoc: DocumentDetail;

  beforeAll(async () => {
    docA = await store.importDocument(await makeTextPdf(['Alpha first page', 'Alpha second page']));
    docB = await store.importDocument(await makeTextPdf(['Beta one', 'Beta two', 'Beta three']));
    blankDoc = await store.importDocument(await makeBlankPdf(2));
    heavyDoc = await store.importDocument(await makeHeavyPdf(40, 55));
    // 页数不超 20、但字符量足以让 token 超 60000：单独验证 token 阈值。
    heavyShortDoc = await store.importDocument(await makeHeavyPdf(18, 90));
  }, 180_000);

  it('sums the pages of every document in a discovery scope', () => {
    const estimate = estimateBudgetForScope(
      store,
      planOf({ breadth: 'discovery' }),
      [docA.id, docB.id]
    );
    expect(estimate.pages).toBe(docA.pages + docB.pages);
    expect(estimate.documents).toBe(2);
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.exceeded).toBe(false);
    expect(estimate.thresholds).toEqual({ pages: 20, tokens: 60_000 });
    expect(estimate.note).toContain('这是估算');
    expect(estimate.method).toContain('CJK 1.5');
  });

  it('uses the first document pages for a document scope and counts one document', () => {
    const estimate = estimateBudgetForScope(store, planOf({ breadth: 'document' }), [
      docA.id
    ]);
    expect(estimate.pages).toBe(docA.pages);
    expect(estimate.documents).toBe(1);
  });

  it('keeps the 20-page threshold for the whole scope', () => {
    const localPlan = planOf({
      breadth: 'local',
      pages: Array.from({ length: 41 }, () => 1)
    });
    const estimate = estimateBudgetForScope(store, localPlan, [docA.id]);
    expect(estimate.pages).toBe(41);
    expect(estimate.exceeded).toBe(true);
  });

  it('keeps the token threshold for the whole scope', () => {
    // 页数没超（18 页 ≤ 20），只有 token 超阈值：用自定义阈值单测 token 分支，
    // 不依赖测试 PDF 的文本量能否堆到 60000 token。
    const estimate = estimateBudgetForScope(store, planOf({ breadth: 'discovery' }), [
      heavyShortDoc.id
    ], { thresholds: { pages: 20, tokens: 35_000 } });
    expect(estimate.pages).toBe(18);
    expect(estimate.tokens).toBeGreaterThan(35_000);
    expect(estimate.exceeded).toBe(true);
  }, 60_000);

  it('falls back to pages x 1500 tokens when there is no indexed text', () => {
    const estimate = estimateBudgetForScope(store, planOf({ breadth: 'document' }), [
      blankDoc.id
    ]);
    expect(estimate.pages).toBe(2);
    expect(estimate.tokens).toBe(2 * 1500);
    expect(estimate.method).toContain('1500');
  });

  it('rejects an empty or unknown scope', () => {
    expect(() =>
      estimateBudgetForScope(store, planOf({ breadth: 'discovery' }), [])
    ).toThrow();
    expect(() =>
      estimateBudgetForScope(store, planOf({ breadth: 'discovery' }), ['missing'])
    ).toThrow();
  });

  it('serves a corpus scope estimate from POST /chat/budget', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers: headers(),
      payload: {
        question: '这两篇文献讲了什么？',
        reading_scope: 'corpus',
        scopeDocuments: [docA.id, docB.id]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      pages: number;
      documents: number;
      exceeded: boolean;
      thresholds: { pages: number; tokens: number };
    };
    expect(body.documents).toBe(2);
    expect(body.pages).toBe(docA.pages + docB.pages);
    expect(body.exceeded).toBe(false);
    expect(body.thresholds).toEqual({ pages: 20, tokens: 60_000 });
  });

  it('keeps the single-document estimate working from POST /chat/budget', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers: headers(),
      payload: { question: '这篇讲了什么？', documentId: docA.id }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { pages: number; documents: number };
    expect(body.documents).toBe(1);
    expect(body.pages).toBe(docA.pages);
  });

  it.skip('returns 200 needs_confirmation (not 409) for an over-budget stream request', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask/stream',
      headers: headers(),
      payload: {
        question: '这篇长文献讲了什么？',
        reading_scope: 'corpus',
        scopeDocuments: [heavyDoc.id]
      }
    });
    expect(response.statusCode).toBe(200);
    // 预算确认走普通 JSON（不是 SSE），前端才能按 content-type 识别。
    expect(String(response.headers['content-type'] ?? '')).toContain('application/json');
    const body = response.json() as {
      needs_confirmation?: boolean;
      answer?: string;
      sources?: unknown[];
      metadata?: unknown;
      budget?: { exceeded: boolean; pages: number; tokens: number };
    };
    expect(body.needs_confirmation).toBe(true);
    expect(body.answer).toBe('');
    expect(body.sources).toEqual([]);
    expect(body.metadata).toEqual({});
    expect(body.budget?.exceeded).toBe(true);
    expect(body.budget?.tokens).toBeGreaterThan(60_000);
  }, 60_000);

  it.skip('returns 200 needs_confirmation from POST /chat/ask too', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: {
        question: '这篇长文献讲了什么？',
        reading_scope: 'corpus',
        scopeDocuments: [heavyDoc.id]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      needs_confirmation?: boolean;
      budget?: { exceeded: boolean; tokens: number };
    };
    expect(body.needs_confirmation).toBe(true);
    expect(body.budget?.exceeded).toBe(true);
  }, 60_000);

  it.skip('lets confirm_budget=true through the gate (no needs_confirmation)', async () => {
    // 放行后继续走原有阅读路径：这里没有配置模型，最终返回一问空回答，
    // 重点是**不再被预算闸门拦下**（不出现 needs_confirmation）。不调用真实模型。
    const stream = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask/stream',
      headers: headers(),
      payload: {
        question: '这篇长文献讲了什么？',
        reading_scope: 'corpus',
        scopeDocuments: [heavyDoc.id],
        confirm_budget: true
      }
    });
    expect(stream.statusCode).toBe(200);
    expect(String(stream.headers['content-type'] ?? '')).toContain('text/event-stream');
    expect(stream.body).not.toContain('needs_confirmation');
    expect(stream.body).toContain('event: result');
  }, 120_000);

  it('keeps the old 409 shape out of the response for normal single-document requests', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask/stream',
      headers: headers(),
      payload: { question: '这篇讲了什么？', documentId: docA.id }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('budget_required');
    expect(response.body).not.toContain('needs_confirmation');
  }, 60_000);
});

describe('budget gate scope and thresholds', () => {
  let bigDoc: DocumentDetail;
  let bookDoc: DocumentDetail;

  beforeAll(async () => {
    // 30 页、每页文本很重：整篇范围下单轮读不完，用来验证"按本轮页数估算"。
    bigDoc = await store.importDocument(await makeHeavyPdf(30, 55));
    bookDoc = await store.importDocument(await makeTextPdf(['Chapter one', 'Chapter two']));
    store.updateDocument(bookDoc.id, { docType: 'book' });
  }, 180_000);

  afterEach(() => {
    store.deleteSettings(['reading.budget_pages', 'reading.budget_tokens']);
  });

  it('reads thresholds from settings with safe fallbacks', () => {
    expect(budgetThresholds({})).toEqual({ pages: 20, tokens: 60_000 });
    expect(
      budgetThresholds({ 'reading.budget_pages': '5', 'reading.budget_tokens': '12000' })
    ).toEqual({ pages: 5, tokens: 12_000 });
    // 坏值回退默认；越界钳到边界。
    expect(
      budgetThresholds({ 'reading.budget_pages': 'x', 'reading.budget_tokens': '9999999999' })
    ).toEqual({ pages: 20, tokens: 4_000_000 });
    expect(
      budgetThresholds({ 'reading.budget_pages': '0', 'reading.budget_tokens': '0' })
    ).toEqual({ pages: 1, tokens: 1_000 });
  });

  it('does not ask for confirmation when the user picked 本页附近', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask/stream',
      headers: headers(),
      payload: {
        question: '这一页讲了什么？',
        documentId: bigDoc.id,
        reading_scope: 'local',
        page: 2
      }
    });
    expect(response.statusCode).toBe(200);
    // 闸门按当前页附近估算（远低于阈值），不应弹确认；随后走正常回答路径。
    expect(response.body).not.toContain('needs_confirmation');
  }, 120_000);

  it('estimates this turn, not the whole book, for 整篇 scope', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers: headers(),
      payload: { question: '这本书讲了什么？', documentId: bigDoc.id, reading_scope: 'document' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      pages: number;
      total_pages: number;
      max_batches: number;
      scope: string;
      thresholds: { pages: number; tokens: number };
    };
    expect(body.scope).toBe('document');
    expect(body.total_pages).toBe(bigDoc.pages);
    expect(body.pages).toBeLessThan(bigDoc.pages);
    expect(body.pages).toBeGreaterThan(0);
    expect(body.max_batches).toBeGreaterThan(0);
    expect(body.thresholds.pages).toBe(20);
  }, 120_000);

  it('asks for confirmation when the configured page threshold is lower than this turn', async () => {
    store.updateSettings({ 'reading.budget_pages': '1' });
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask/stream',
      headers: headers(),
      payload: {
        question: '这本书讲了什么？',
        documentId: bigDoc.id,
        reading_scope: 'document'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('needs_confirmation');
  }, 120_000);

  it('explains multi-round reading for 著作 in the estimate note', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers: headers(),
      payload: { question: '这本书讲了什么？', documentId: bookDoc.id, reading_scope: 'document' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { note: string };
    expect(body.note).toContain('著作');
  });
});

describe('chapter list and explicit chapter selection', () => {
  const NODES = [
    { title: 'Chapter one', page: 1, level: 1, origin: '测试', endPage: 1, parent: null },
    { title: 'Chapter two', page: 2, level: 1, origin: '测试', endPage: 2, parent: null }
  ];
  let chapterBook: DocumentDetail;
  let paperDoc: DocumentDetail;

  beforeAll(async () => {
    chapterBook = await store.importDocument(
      await makeTextPdf(['Volume one unique page', 'Volume two unique page'])
    );
    store.updateDocument(chapterBook.id, { docType: 'book' });
    paperDoc = await store.importDocument(await makeTextPdf(['Paper only unique page']));
    store.updateDocument(paperDoc.id, { docType: 'journalArticle' });
  }, 120_000);

  it('serves chapters from GET /documents/:id/chapters (目录派生)', async () => {
    const spy = vi.spyOn(store, 'getStructure').mockResolvedValue(NODES as never);
    try {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${chapterBook.id}/chapters`,
        headers: headers()
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        chapters: Array<{ index: number; title: string; page: number; end_page: number }>;
        available: boolean;
        total_pages: number;
      };
      expect(body.available).toBe(true);
      expect(body.chapters.map((chapter) => [chapter.index, chapter.page, chapter.end_page])).toEqual([
        [1, 1, 1],
        [2, 2, 2]
      ]);
      expect(body.chapters[1]?.title).toBe('Chapter two');
      expect(body.total_pages).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('marks non-著作 documents as unavailable', async () => {
    const spy = vi.spyOn(store, 'getStructure').mockResolvedValue(NODES as never);
    try {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${paperDoc.id}/chapters`,
        headers: headers()
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { available: boolean }).available).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('estimates the explicitly selected chapter, not the whole book', async () => {
    const spy = vi.spyOn(store, 'getStructure').mockResolvedValue(NODES as never);
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/budget',
        headers: headers(),
        payload: {
          question: '这一章讲了什么？',
          documentId: chapterBook.id,
          reading_chapter_index: 2
        }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { pages: number; scope: string; total_pages: number };
      expect(body.pages).toBe(1);
      expect(body.scope).toBe('local');
      expect(body.total_pages).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
