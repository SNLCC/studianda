/**
 * OCR 线程化验收：
 * 1) worker 取图与主线程渲染「同图」（PNG 字节一致）——识别输入不变，文本/行框才不会变；
 * 2) 整页 OCR 的文本/行框仍按同一套归一化产出（含遮罩前的整页行落库）；
 * 3) 多页 OCR 期间主线程事件循环不被阻塞（5 ms 定时器照常触发），且默认 2 路并行；
 * 4) 取消能中断正在识别的页：实例被 terminate、不写缓存、下一次识别可恢复。
 *
 * 真实 tesseract 需要已下载的语言数据（本仓库/CI 离线环境没有），
 * 这里用 vi.mock 的确定性识别结果验证「取图 + 归一化 + 并发 + 取消」链路；
 * 真实 OCR 的文字一致性由 1) 的「同图」保证（同图 → 同一 tesseract 输入 → 同样输出）。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorkerMock = vi.fn();
vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args)
}));

import {
  ensureAutoOcr,
  ocrEnginePoolStats,
  recognizePage,
  renderPdfPage,
  RENDER_LIMITS,
  shutdownOcrEnginePool
} from '../src/ocr.js';
import {
  ocrRenderWorkerStats,
  renderPageOffMainThread,
  shutdownOcrRenderWorkers
} from '../src/ocr-worker.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-worker-'));
const langDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-worker-langs-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const previousLangPath = process.env.STUDIANDA_OCR_LANG_PATH;
const previousWorkers = process.env.STUDIANDA_OCR_WORKERS;
let textDocumentId = '';
let ocrDocumentId = '';
let multiDocumentId = '';
let cancelDocumentId = '';

const FAKE_LINES = [
  { text: 'Fake OCR line one', confidence: 92, bbox: { x0: 100, y0: 120, x1: 900, y1: 160 } },
  { text: 'Fake OCR line two', confidence: 85, bbox: { x0: 100, y0: 170, x1: 800, y1: 210 } }
];
const FAKE_BLOCKS = {
  text: FAKE_LINES.map((line) => line.text).join('\n'),
  blocks: [
    {
      paragraphs: [
        {
          lines: FAKE_LINES.map((line) => ({
            text: line.text,
            confidence: line.confidence,
            bbox: line.bbox
          }))
        }
      ]
    }
  ]
};

function sha(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function goodEngine(): {
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  return {
    recognize: vi.fn(async () => ({ data: structuredClone(FAKE_BLOCKS) })),
    terminate: vi.fn(async () => undefined)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writePdf(name: string, build: (pdf: PDFDocument) => Promise<void>): Promise<string> {
  const pdf = await PDFDocument.create();
  await build(pdf);
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file);
  return document.id;
}

function maxTickGap(ticks: number[]): number {
  let maxGap = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    maxGap = Math.max(maxGap, ticks[index]! - ticks[index - 1]!);
  }
  return maxGap;
}

beforeAll(async () => {
  // 假语言数据（>100KB 阈值）只用于让 ensureOcrLanguageData 通过；识别由 mock 完成。
  for (const lang of ['eng', 'chi_sim']) {
    writeFileSync(path.join(langDir, `${lang}.traineddata`), Buffer.alloc(200_000, 1));
  }
  process.env.STUDIANDA_OCR_LANG_PATH = langDir;
  process.env.STUDIANDA_OCR_WORKERS = '2';
  saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: false });

  textDocumentId = await writePdf('text-pages.pdf', async (pdf) => {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 3; index += 1) {
      const page = pdf.addPage([595, 842]);
      for (let line = 0; line < 24; line += 1) {
        page.drawText(`Parity page ${index + 1} line ${line}`, {
          x: 40,
          y: 800 - line * 28,
          size: 12,
          font
        });
      }
    }
  });
  ocrDocumentId = await writePdf('ocr-onepage.pdf', async (pdf) => {
    pdf.addPage([595, 842]);
  });
  multiDocumentId = await writePdf('ocr-multipage.pdf', async (pdf) => {
    for (let index = 0; index < 6; index += 1) pdf.addPage([595, 842]);
  });
  cancelDocumentId = await writePdf('ocr-cancel.pdf', async (pdf) => {
    pdf.addPage([595, 842]);
    pdf.addPage([595, 842]);
  });
});

beforeEach(async () => {
  // 每个用例从空池开始：否则上一个用例缓存的 tesseract 实例会让 mock 行为串台。
  await shutdownOcrEnginePool();
  await shutdownOcrRenderWorkers();
  createWorkerMock.mockReset();
});

afterAll(async () => {
  await shutdownOcrEnginePool();
  await shutdownOcrRenderWorkers();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(langDir, { recursive: true, force: true });
  if (previousLangPath === undefined) delete process.env.STUDIANDA_OCR_LANG_PATH;
  else process.env.STUDIANDA_OCR_LANG_PATH = previousLangPath;
  if (previousWorkers === undefined) delete process.env.STUDIANDA_OCR_WORKERS;
  else process.env.STUDIANDA_OCR_WORKERS = previousWorkers;
});

describe('OCR 取图线程化', () => {
  it('worker 渲染与主线程渲染同图：PNG 字节一致、尺寸一致', async () => {
    const pdfPath = store.getDocumentPath(textDocumentId);
    expect(pdfPath).toBeTruthy();
    for (const page of [1, 2, 3]) {
      const fromMain = await renderPdfPage(textDocumentId, page, store, 2, 'ocr');
      const fromWorker = await renderPageOffMainThread({
        pdfPath: pdfPath as string,
        page,
        scale: 2,
        maxScale: RENDER_LIMITS.ocr.maxScale,
        maxLongEdge: RENDER_LIMITS.ocr.maxLongEdge,
        minScale: 0.05
      });
      expect(fromWorker.width).toBe(fromMain.width);
      expect(fromWorker.height).toBe(fromMain.height);
      expect(sha(fromWorker.png)).toBe(sha(fromMain.png));
    }
    // 同一页重复请求复用同一个取图 worker，不重复付启动成本。
    expect(ocrRenderWorkerStats().spawned).toBe(1);
    expect(ocrRenderWorkerStats().completed).toBe(3);
  }, 120_000);

  it('整页 OCR 文本与行框与改造前一致（同一套归一化，落库整页未裁剪行）', async () => {
    createWorkerMock.mockImplementation(async () => goodEngine());
    const result = await recognizePage(store, secrets, ocrDocumentId, 1, 2);
    const width = result.image.width;
    const height = result.image.height;
    // A4 595×842 在 ocr 用途下 scale=2：1190×1684（与主线程 renderPdfPage 一致）。
    expect({ width, height }).toEqual({ width: 1190, height: 1684 });
    expect(result.lines).toEqual(
      FAKE_LINES.map((line) => ({
        text: line.text,
        confidence: line.confidence / 100,
        bbox: [
          line.bbox.x0 / width,
          line.bbox.y0 / height,
          line.bbox.x1 / width,
          line.bbox.y1 / height
        ]
      }))
    );
    expect(result.text).toBe(FAKE_LINES.map((line) => line.text).join('\n'));
    expect(result.engine).toBe('tesseract.js:eng+chi_sim');
    const saved = store.getPageEdit(ocrDocumentId, 1);
    expect(saved?.origin).toBe('ocr');
    expect(saved?.text).toBe(FAKE_LINES.map((line) => line.text).join('\n'));
    expect(JSON.parse(saved?.boxes ?? '[]')).toHaveLength(FAKE_LINES.length);
  }, 120_000);

  it('多页 OCR：主线程 5ms 定时器照常触发，默认 2 个实例并行', async () => {
    let active = 0;
    let maxActive = 0;
    let recognizeStarts = 0;
    createWorkerMock.mockImplementation(async () => ({
      recognize: vi.fn(async () => {
        active += 1;
        recognizeStarts += 1;
        maxActive = Math.max(maxActive, active);
        await delay(120);
        active -= 1;
        return { data: structuredClone(FAKE_BLOCKS) };
      }),
      terminate: vi.fn(async () => undefined)
    }));
    saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: true });

    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 5);
    let done: number[] = [];
    const start = performance.now();
    try {
      done = await ensureAutoOcr(store, secrets, multiDocumentId);
    } finally {
      clearInterval(timer);
    }
    const wallMs = performance.now() - start;
    const stats = {
      wallMs: Math.round(wallMs),
      ticks: ticks.length,
      maxGapMs: maxTickGap(ticks),
      maxActive,
      recognizeStarts,
      renderWorkers: ocrRenderWorkerStats().spawned,
      engines: ocrEnginePoolStats().instances
    };
    console.log('OCR_EVENT_LOOP ' + JSON.stringify(stats));

    expect(done).toEqual([1, 2, 3, 4, 5, 6]);
    expect(recognizeStarts).toBe(6);
    // 2 个 tesseract 实例并行（每页 mock 识别 120 ms）：6 页分 3 波。
    expect(maxActive).toBe(2);
    // 关键断言：OCR 期间主线程事件循环没有被占住（与 backup worker 同一手法）。
    expect(ticks.length).toBeGreaterThan(10);
    expect(stats.maxGapMs).toBeLessThan(80);
    for (const page of [1, 2, 3, 4, 5, 6]) {
      expect(store.getPageEdit(multiDocumentId, page)?.origin).toBe('ocr');
    }
  }, 120_000);

  it('取消中断正在识别的页：实例被终止、不写缓存、下一次识别可恢复', async () => {
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const hungEngine = {
      recognize: vi.fn(() => {
        startedResolve?.();
        return new Promise<never>(() => {
          // 永远不 settle：模拟一页很慢的识别，取消必须能立刻结束它。
        });
      }),
      terminate: vi.fn(async () => undefined)
    };
    createWorkerMock.mockImplementationOnce(async () => hungEngine);

    const controller = new AbortController();
    const pending = recognizePage(store, secrets, cancelDocumentId, 1, 2, {
      signal: controller.signal
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow('本机 OCR 已取消');

    expect(hungEngine.terminate).toHaveBeenCalledTimes(1);
    expect(ocrEnginePoolStats().instances).toBe(0);
    expect(ocrRenderWorkerStats().busy).toBe(0);
    // 取消的页不落缓存（不把半截/未完成结果当原文）。
    expect(store.getPageEdit(cancelDocumentId, 1)).toBeNull();

    // 取消后池可恢复：新实例正常识别并把结果写入缓存。
    createWorkerMock.mockImplementation(async () => goodEngine());
    const result = await recognizePage(store, secrets, cancelDocumentId, 1, 2);
    expect(result.text).toBe(FAKE_LINES.map((line) => line.text).join('\n'));
    expect(store.getPageEdit(cancelDocumentId, 1)?.origin).toBe('ocr');
    expect(ocrEnginePoolStats().instances).toBe(1);
  }, 120_000);
});
