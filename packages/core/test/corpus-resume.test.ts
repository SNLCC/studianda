import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@studianda/shared';
import { answerQuestion } from '../src/chat.js';
import { cost } from '../src/reading.js';
import { answerWithCorpus } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 跨文献「继续阅读」：第一轮到批次上限后要把任务真的存下来（提示与能力一致），
 * 第二轮只补读未读页，靠任务里的派生记录与逐字证据合并，不重读已读部分。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-resume-'));
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
    page.drawText(name, { x: 20, y: 20, size: 8, font });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return document.id;
}

/** 每页都有唯一标记，便于断言"已读页没有被重读"。 */
function pageText(marker: string): string {
  return `${marker}模型内容。` + '说明段落。'.repeat(220);
}

const PAGE_MARKERS: Record<string, string[]> = {};
/** 只放得下一页的原文预算：一页一批，单轮上限 1 批时必然延期。 */
let readBudget = 700;

/** 从批次材料里取第一段原文，作为模型"逐字摘引"返回（保证能通过核验）。 */
function quoteFromMaterial(user: string): string {
  const match = /\[1\][^\n]*\n([^\n]{4,})/.exec(user);
  return (match?.[1] ?? '').trim().slice(0, 60);
}

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
    // 材料不是 JSON：按没有证据处理。
  }
  return null;
}

/** 记录每一轮批次材料，供"未重读已读页"断言使用。 */
function mockModel(): {
  batchMaterials: string[];
  calls: { batch: number; synthesis: number; audit: number };
} {
  const state = {
    batchMaterials: [] as string[],
    calls: { batch: 0, synthesis: 0, audit: 0 }
  };
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = '';
    if (system.includes('READING_BATCH')) {
      state.calls.batch += 1;
      state.batchMaterials.push(user);
      const quote = quoteFromMaterial(user);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
      state.calls.audit += 1;
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
      state.calls.synthesis += 1;
      content = '跨文献回答：这批文献给出了相关论述。';
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return state;
}

const config = {
  baseUrl: 'https://model.example.com/v1',
  apiKey: 'k-1',
  model: 'chat-model'
};

beforeAll(async () => {
  firstDoc = await importPdf('first.pdf', 2);
  secondDoc = await importPdf('second.pdf', 2);
  PAGE_MARKERS[firstDoc] = ['甲一页', '甲二页'];
  PAGE_MARKERS[secondDoc] = ['乙一页', '乙二页'];
  store.savePageTextEdit(firstDoc, 1, pageText(PAGE_MARKERS[firstDoc]![0]!));
  store.savePageTextEdit(firstDoc, 2, pageText(PAGE_MARKERS[firstDoc]![1]!));
  store.savePageTextEdit(secondDoc, 1, pageText(PAGE_MARKERS[secondDoc]![0]!));
  store.savePageTextEdit(secondDoc, 2, pageText(PAGE_MARKERS[secondDoc]![1]!));
  const pageCosts = [firstDoc, secondDoc].flatMap((documentId, documentIndex) =>
    PAGE_MARKERS[documentId]!.map((_, pageIndex) =>
      cost(
        `[${pageIndex + 1}] ${documentIndex === 0 ? 'first.pdf' : 'second.pdf'} 第${pageIndex + 1}页\n` +
          pageText(PAGE_MARKERS[documentId]![pageIndex]!)
      ) + 2
    )
  );
  readBudget = Math.ceil(Math.max(...pageCosts) * 1.4) + 4;
}, 120_000);

/** 第一轮：批次上限 1，可延期；返回任务编号。 */
async function startDeferredCorpusRun(): Promise<ChatResponse> {
  store.updateSettings({ 'reading.max_read_batches': '1' });
  const state = mockModel();
  const result = (await answerWithCorpus(
    store,
    secrets,
    config,
    '模型',
    '',
    [firstDoc, secondDoc],
    readBudget
  )) as ChatResponse;
  expect(state.calls.batch).toBeGreaterThanOrEqual(1);
  return result;
}

describe('跨文献继续阅读', () => {
  it('第一轮延期时真的保存任务，并在报告里如实标注部分阅读', async () => {
    const result = await startDeferredCorpusRun();
    expect(result.taskId).toBeTruthy();
    expect(result.unread_pages?.length ?? 0).toBeGreaterThan(0);
    expect(result.deferred_batches ?? 0).toBeGreaterThan(0);
    expect(result.notice ?? '').toContain('继续阅读');
    // 提示必须与能力一致：任务真的在库，能从文献的阅读任务列表里找到。
    const saved = store.loadReadingTask<{
      kind?: string;
      documentIds?: string[];
      unread_pages?: number[];
      sourceFindings?: unknown[];
    }>(result.taskId!);
    expect(saved?.payload.kind).toBe('corpus');
    expect(saved?.payload.documentIds).toEqual(expect.arrayContaining([firstDoc, secondDoc]));
    expect(saved?.payload.unread_pages?.length ?? 0).toBeGreaterThan(0);
    expect(saved?.payload.sourceFindings?.length ?? 0).toBeGreaterThan(0);
    const listed = store.listReadingTasks(firstDoc);
    expect(listed.some((task) => task.taskId === result.taskId)).toBe(true);
    expect(listed.find((task) => task.taskId === result.taskId)?.unreadPages.length).toBeGreaterThan(0);
    // 报告不能自相矛盾：有延期页的文献不能同时说"已读全篇"。
    const partialReports = (result.coverage?.documents ?? []).filter(
      (report) => (report.unread_pages?.length ?? 0) > 0
    );
    expect(partialReports.length).toBeGreaterThan(0);
    for (const report of partialReports) {
      expect(report.whole_document).toBe(false);
      expect(report.partial).toBe(true);
      expect(report.read_pages.length).toBeLessThan(report.total_pages);
    }
    expect(result.coverage?.full_extracted_text).toBe(false);
  }, 120_000);

  it('继续阅读只补读未读页，已读页不会重读，读完销掉任务', async () => {
    const first = await startDeferredCorpusRun();
    const taskId = first.taskId!;
    const firstRead = new Set(
      (first.coverage?.documents ?? []).flatMap((report) =>
        report.read_pages.map((page) => `${report.document_id}:${page}`)
      )
    );
    expect(firstRead.size).toBeGreaterThan(0);

    const state = mockModel();
    const second = (await answerWithCorpus(
      store,
      secrets,
      config,
      '模型',
      '',
      [firstDoc, secondDoc],
      readBudget,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      taskId
    )) as ChatResponse;

    // 第二轮交给模型的材料里，不能再出现第一轮已读页的标记。
    const resumeMaterials = state.batchMaterials;
    expect(resumeMaterials.length).toBeGreaterThan(0);
    for (const [documentId, markers] of Object.entries(PAGE_MARKERS)) {
      markers.forEach((marker, index) => {
        const page = index + 1;
        if (!firstRead.has(`${documentId}:${page}`)) return;
        for (const material of resumeMaterials) {
          expect(material).not.toContain(marker);
        }
      });
    }

    // 第二轮应把剩余页读完：任务销掉，报告可宣称读到全篇（无缺页/无质量页时）。
    const leftover = store.loadReadingTask(taskId);
    if ((second.unread_pages?.length ?? 0) === 0) {
      expect(leftover).toBeNull();
      expect(second.coverage?.full_extracted_text).toBe(true);
      for (const report of second.coverage?.documents ?? []) {
        expect(report.whole_document).toBe(true);
        expect(report.partial).toBe(false);
        expect(report.read_pages).toHaveLength(report.total_pages);
      }
    } else {
      // 还有页没读完时必须仍保留任务，且已读页比第一轮多（不做"重来一遍"的假进度）。
      expect(leftover).not.toBeNull();
      expect(second.unread_pages!.length).toBeLessThan(first.unread_pages!.length);
    }
  }, 120_000);

  it('带着任务编号从聊天入口续读时还原跨文献范围，不退化成单篇', async () => {
    const first = await startDeferredCorpusRun();
    const taskId = first.taskId!;
    // 模型配置走环境变量覆盖（无界面运行/调试用）；答案仍由 mockModel 提供。
    process.env.STUDIANDA_MODEL_BASE_URL = config.baseUrl;
    process.env.STUDIANDA_MODEL_NAME = config.model;
    process.env.STUDIANDA_MODEL_API_KEY = config.apiKey;
    try {
      mockModel();
      // 续读请求与单篇一致：只带 taskId（界面上"继续阅读"就是这么发的），没有 documentId/范围。
      const resumed = await answerQuestion(store, secrets, { question: '模型', taskId });
      expect(resumed.reading_scope).toBe('corpus');
      expect(resumed.sources.length).toBeGreaterThan(0);
      const documentIds = new Set(resumed.sources.map((source) => source.documentId));
      expect(documentIds.size).toBeGreaterThan(1);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      delete process.env.STUDIANDA_MODEL_API_KEY;
    }
  }, 120_000);

  it('页被切成多段时，续读按已读分段前进（不会每轮从头重读同一页）', async () => {
    // 预算压到一页要切成多段：只按"整页已读"跳过的话，续读每轮都会从同一页开头重来。
    const microBudget = 900;
    store.updateSettings({ 'reading.max_read_batches': '1' });
    try {
      mockModel();
      const first = (await answerWithCorpus(
        store,
        secrets,
        config,
        '模型',
        '',
        [firstDoc, secondDoc],
        microBudget
      )) as ChatResponse;
      const taskId = first.taskId!;
      expect(taskId).toBeTruthy();
      const before = store.loadReadingTask<{ readSegments?: unknown[] }>(taskId);
      const readBefore = (before?.payload.readSegments ?? []).length;
      expect(readBefore).toBeGreaterThan(0);

      mockModel();
      await answerWithCorpus(
        store,
        secrets,
        config,
        '模型',
        '',
        [firstDoc, secondDoc],
        microBudget,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        taskId
      );
      const after = store.loadReadingTask<{ readSegments?: unknown[] }>(taskId);
      // 已读分段必须增长（前进），而不是原地重来同样的第一批。
      const readAfter = (after?.payload.readSegments ?? []).length;
      expect(readAfter).toBeGreaterThan(readBefore);
    } finally {
      store.updateSettings({ 'reading.max_read_batches': '12' });
    }
  }, 180_000);
});
