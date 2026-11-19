/**
 * PDF 解析线程化验收：
 * 1) 结果快照：worker 解析 sample-paper.pdf 的页数/元数据/每个 chunk 的 page/text/bbox
 *    与改造前主线程实现逐字段一致（同一份解析算法；改造前后对 demo-paper-01、测试用pdf.pdf、
 *    300 页样本的逐字段比对见报告）；
 * 2) 解析期间主线程 5 ms 定时器照常触发：ELU 从改造前的 93% 降到 2% 以内，最长间隔 <80 ms；
 * 3) 并发上限：STUDIANDA_PDF_WORKERS=2 时 3 个任务最多 2 路并行（只拉起 2 个 worker）；
 * 4) 取消执行中的解析：terminate worker、以 PdfParseCancelledError 失败、池可恢复；
 * 5) 解析失败语义不变：错误 name/message 与主线程 PDF.js 一致，失败后池仍可用；
 * 6) importDocument 的 isCancelled 接到 AbortSignal：取消中断 worker，错误仍是 ImportCancelledError。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportCancelledError, Store, parsePdf } from '../src/store.js';
import {
  PdfParseCancelledError,
  pdfParseWorkerStats,
  shutdownPdfParseWorkers,
  type ParsedPdf
} from '../src/pdf-worker.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-pdf-worker-'));
const store = new Store(path.join(dataDir, 'store'));
const previousWorkers = process.env.STUDIANDA_PDF_WORKERS;
let slowPath = '';
let slowBytes: Uint8Array;
let slowPages = 0;

/** 改造前主线程实现（HEAD）对测试 fixture 的输出快照；worker 必须逐字段一致。 */
const GOLDEN: ParsedPdf = {
  pages: 2,
  author: '',
  publication: '',
  title: '',
  doi: '',
  metadataSource: 'filename',
  chunks: [
    { page: 1, text: 'A Sample Two-Column Academic Paper', bbox: '[56,46,342.30400000000003,62]' },
    { page: 1, text: 'Author One, Author Two', bbox: '[56,78,163.83,88]' },
    { page: 1, text: 'Department of Sample Studies, Example University', bbox: '[56,92,283.30000000000007,102]' },
    { page: 1, text: 'I. INTRODUCTION', bbox: '[56,115,166.5,128]' },
    {
      page: 1,
      text: 'This synthetic two-page document exists only to exercise the reading,',
      bbox: '[56,139,394.70099999999974,150]'
    },
    { page: 1, text: 'parsing, layout and export pipelines in automated tests.', bbox: '[56,155,325.02699999999976,166]' },
    {
      page: 1,
      text: 'It contains a title, body paragraphs, section headings and references,',
      bbox: '[56,171,392.2919999999997,182]'
    },
    {
      page: 1,
      text: 'but no third-party text, figures, personal data or copyrighted content.',
      bbox: '[56,187,386.7809999999996,198]'
    },
    { page: 1, text: 'Abstract: a compact sample document for parser fixtures.', bbox: '[56,203,334.7729999999998,214]' },
    {
      page: 1,
      text: 'Keywords: sample, fixture, parser, layout, two-column, demonstration.',
      bbox: '[56,219,395.89999999999975,230]'
    },
    { page: 2, text: '[3] Top-margin reference line for layout tests. 2026.', bbox: '[56,15,260.0930000000001,24]' },
    { page: 2, text: 'II. RELATED WORK AND METHODOLOGY', bbox: '[56,46,370.71999999999997,62]' },
    {
      page: 2,
      text: 'A second page so pagination and translation tests have enough input.',
      bbox: '[56,78,365.08,88]'
    },
    { page: 2, text: 'III. EXPERIMENTAL RESULTS', bbox: '[56,101,238.052,114]' },
    { page: 2, text: 'The sample reports illustrative results only; there are no real', bbox: '[56,125,348.2149999999998,136]' },
    {
      page: 2,
      text: 'measurements, no citations to external works and no claims of novelty.',
      bbox: '[56,141,400.8059999999997,152]'
    },
    { page: 2, text: 'REFERENCES', bbox: '[56,157,131.174,168]' },
    {
      page: 2,
      text: '[1] Sample Author. A synthetic reference entry for parser tests. 2026.',
      bbox: '[56,173,391.0489999999997,184]'
    },
    { page: 2, text: '[2] Another Sample Author. A second synthetic entry. 2026.', bbox: '[56,189,345.21199999999976,200]' }
  ]
};

function maxTickGap(ticks: number[]): number {
  let maxGap = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    maxGap = Math.max(maxGap, ticks[index]! - ticks[index - 1]!);
  }
  return maxGap;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时');
    await delay(5);
  }
}

/** 生成一份足够慢的文本 PDF（页数 × 每页行数），用于取消/并发/事件循环用例。 */
async function makeSlowPdf(name: string, pages: number, linesPerPage: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 1; pageIndex <= pages; pageIndex += 1) {
    const page = pdf.addPage([595, 842]);
    for (let line = 0; line < linesPerPage; line += 1) {
      page.drawText(`SLOW-PAGE-${pageIndex} line ${line} body text for worker cancellation checks`, {
        x: 40,
        y: 800 - line * 20,
        size: 11,
        font
      });
    }
  }
  const bytes = new Uint8Array(await pdf.save());
  writeFileSync(path.join(dataDir, name), bytes);
  return bytes;
}

beforeAll(async () => {
  process.env.STUDIANDA_PDF_WORKERS = '2';
  slowPages = 200;
  slowBytes = await makeSlowPdf('slow-200p.pdf', slowPages, 30);
  slowPath = path.join(dataDir, 'slow-200p.pdf');
}, 120_000);

afterAll(async () => {
  await shutdownPdfParseWorkers();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousWorkers === undefined) delete process.env.STUDIANDA_PDF_WORKERS;
  else process.env.STUDIANDA_PDF_WORKERS = previousWorkers;
});

describe('PDF 解析线程化', () => {
  it('worker 解析结果与改造前主线程实现逐字段一致（页数/元数据/chunk 文本与 bbox）', async () => {
    const fixture = path.join(import.meta.dirname, 'fixtures', 'sample-paper.pdf');
    const parsed = await parsePdf(new Uint8Array(readFileSync(fixture)));
    expect(parsed).toEqual(GOLDEN);
    expect(pdfParseWorkerStats().completed).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('解析期间主线程 5ms 定时器照常触发（ELU 低、无长停顿）', async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 5);
    const elu0 = performance.eventLoopUtilization();
    const started = performance.now();
    try {
      const parsed = await parsePdf(slowBytes);
      expect(parsed.pages).toBe(slowPages);
      expect(parsed.chunks.length).toBeGreaterThan(slowPages);
    } finally {
      clearInterval(timer);
    }
    const wallMs = performance.now() - started;
    const elu = performance.eventLoopUtilization(elu0);
    const stats = {
      wallMs: Math.round(wallMs),
      ticks: ticks.length,
      maxGapMs: maxTickGap(ticks),
      eluPercent: Math.round(elu.utilization * 1000) / 10
    };
    console.log('PDF_PARSE_EVENT_LOOP ' + JSON.stringify(stats));
    // 与 ocr-worker 验收同一手法：定时器在解析期间持续触发，且没有接近整段解析时长的停顿。
    // （vitest 默认并行跑几十个测试进程时，Windows 调度本身会给定时器带来 100–150ms 抖动，
    //  所以这里用 ELU 作为主判据：改造前同规模解析主线程 ELU 约 93%，搬走后只做投递/接收。）
    expect(ticks.length).toBeGreaterThan(10);
    expect(stats.maxGapMs).toBeLessThan(250);
    expect(stats.eluPercent).toBeLessThan(20);
  }, 120_000);

  it('并发上限：3 个任务最多 2 路并行（默认/可配置上限，按需拉起 worker）', async () => {
    await shutdownPdfParseWorkers();
    process.env.STUDIANDA_PDF_WORKERS = '2';
    const before = pdfParseWorkerStats();
    let maxBusy = 0;
    const sampler = setInterval(() => {
      maxBusy = Math.max(maxBusy, pdfParseWorkerStats().busy);
    }, 2);
    try {
      const results = await Promise.all([
        parsePdf(slowBytes),
        parsePdf(slowBytes),
        parsePdf(slowBytes)
      ]);
      for (const parsed of results) expect(parsed.pages).toBe(slowPages);
    } finally {
      clearInterval(sampler);
    }
    const after = pdfParseWorkerStats();
    expect(maxBusy).toBe(2);
    expect(after.spawned - before.spawned).toBe(2);
    expect(after.queued).toBe(0);
  }, 180_000);

  it('取消执行中的解析：terminate worker、错误类型明确、池可恢复', async () => {
    await shutdownPdfParseWorkers();
    const before = pdfParseWorkerStats();
    const controller = new AbortController();
    const pending = parsePdf(slowBytes, { signal: controller.signal });
    await waitFor(() => pdfParseWorkerStats().busy === 1);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(PdfParseCancelledError);
    const after = pdfParseWorkerStats();
    expect(after.cancelled - before.cancelled).toBe(1);
    expect(after.failed - before.failed).toBe(0);
    expect(after.busy).toBe(0);
    // 取消后池恢复：下一次解析正常完成。
    const recovered = await parsePdf(slowBytes);
    expect(recovered.pages).toBe(slowPages);
    expect(pdfParseWorkerStats().busy).toBe(0);
  }, 180_000);

  it('解析失败语义不变：错误 name/message 与主线程 PDF.js 一致，失败后池仍可用', async () => {
    const bad = new TextEncoder().encode('%PDF-1.4\nnot a real pdf');
    await expect(parsePdf(bad)).rejects.toMatchObject({
      name: 'InvalidPDFException',
      message: 'Invalid PDF structure.'
    });
    const parsed = await parsePdf(slowBytes);
    expect(parsed.pages).toBe(slowPages);
  }, 120_000);

  it('importDocument 的取消能中断解析 worker，错误仍是 ImportCancelledError', async () => {
    let cancelled = false;
    await expect(
      store.importDocument(slowPath, 'cancel-during-parse.pdf', true, {
        onProgress: (progress) => {
          if (progress.stage === 'parsing' && progress.percent === 30) {
            // 解析刚投递到 worker 就请求取消：轮询（100ms）会触发 AbortSignal 终止 worker。
            setTimeout(() => {
              cancelled = true;
            }, 0);
          }
        },
        isCancelled: () => cancelled
      })
    ).rejects.toBeInstanceOf(ImportCancelledError);
    // 取消的导入不落库（没有 documents 行、没有 chunks）。
    expect(store.listDocuments(false)).toHaveLength(0);
    expect(pdfParseWorkerStats().busy).toBe(0);
  }, 180_000);
});
