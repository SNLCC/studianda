/**
 * PDF 解析 worker（运行在 node:worker_threads 线程里，不在 Core 主线程）。
 *
 * 为什么只搬「解析」而不搬「落库」：
 * - 导入一份几百页 PDF 时主线程实测被 PDF.js 的 getTextContent + 行合并/双栏排序占满
 *   （300 页 / 11 MB：墙钟 2.4–2.6 s、主线程 ELU 93–94%、5 ms 定时器只有 81% 触发），
 *   期间任何 HTTP 请求、SSE 推送、进度轮询都在排队；
 * - 落库/FTS 的写入顺序是 `retrieval_revision`、`chunks`、`chunks_fts` 的既有语义，必须在
 *   主线程按原时序执行（见 store.writeChunks），所以 worker 只返回解析结果。
 *
 * 输入/输出模型：
 * - 静态输入（每次 spawn 传一次 workerData）：pdfjs 入口绝对路径、CMap/标准字体/wasm 目录
 *   file URL、`pdfParseHelpers` 与 `orderPageLines` 的源码（同一份纯函数源码，避免两套算法）；
 * - 每个任务（postMessage）：`{ id, bytes }`，bytes 是 PDF 原始字节的独立副本（结构化克隆，
 *   不转移调用方 buffer——`importZoteroDocument` 等调用方解析后还要用它算 sha256/写盘）；
 * - 结果：`{ type:'result', id, parsed }`，parsed = `{ pages, author, publication, title, doi,
 *   metadataSource, chunks }`，与改造前 `parsePdf` 的返回逐字段一致。
 *
 * `pdfParseWorkerMain` 会被序列化（Function#toString）后作为 eval worker 执行，因此必须
 * 自包含：不引用模块作用域里的变量，依赖只用 eval worker 自带的 `module.require`（与
 * ocr-worker / backup-worker 同一手法）。这样源码模式与打包后的单文件 dist/index.js 都能用。
 * 依赖用 `module.require` 而不是 `require`：esbuild 打包 ESM 时会把源码里的 `require`
 * 改写成只支持静态依赖的 `__require` shim，序列化后在 worker 里不可用。
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import type { MetadataSource } from '@studianda/shared';
import { pdfParseHelpers } from './pdf-metadata.js';
import { orderPageLines } from './structure.js';

/** 解析出的索引分块：与 `chunks(page,text,bbox)` 一一对应。 */
export interface ParsedChunk {
  page: number;
  text: string;
  bbox: string;
}

/** 单篇 PDF 的解析结果；字段与改造前 `parsePdf` 返回完全一致。 */
export interface ParsedPdf {
  pages: number;
  author: string;
  publication: string;
  title: string;
  doi: string;
  /** 题录字段的实际来源（文件名/PDF 内嵌元数据/首页 DOI）。 */
  metadataSource: MetadataSource;
  chunks: ParsedChunk[];
}

/** worker 启动时的静态依赖（主线程解析一次，随每次 spawn 传入）。 */
export interface PdfParseWorkerStaticInput {
  /** pdfjs ESM 入口绝对路径（eval worker 没有模块 URL，不能按包名解析）。 */
  pdfjsPath: string;
  /** PDF.js 的 CMap / 标准字体 / wasm 目录（file:// URL，字符串可结构化克隆）。 */
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
  /** `pdfParseHelpers` 的源码（主线程与 worker 共用同一份纯函数实现）。 */
  helpersSource: string;
  /** `structure.orderPageLines` 的源码（阅读顺序只有一份实现）。 */
  orderPageLinesSource: string;
}

export interface PdfParseTaskInput {
  id: number;
  /** PDF 原始字节；结构化克隆投递，不转移（调用方解析后还要用）。 */
  bytes: Uint8Array;
}

export type PdfParseWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; parsed: ParsedPdf }
  | { type: 'error'; id: number; name: string; message: string; code?: string | number };

/** 主线程传给 worker 的错误（id=0 表示 worker 启动阶段失败）。 */
interface WorkerErrorPayload {
  type: 'error';
  id: number;
  name: string;
  message: string;
  code?: string | number;
}

declare const module: { require: (id: string) => unknown };

/**
 * worker 线程入口。必须自包含（见文件头说明），不要引用模块级常量/函数。
 */
export async function pdfParseWorkerMain(staticInput: PdfParseWorkerStaticInput): Promise<void> {
  const workerThreads = module.require('node:worker_threads') as typeof import('node:worker_threads');
  const parentPort = workerThreads.parentPort;
  if (!parentPort) throw new Error('PDF 解析 worker 缺少 parentPort');
  const fs = module.require('node:fs') as typeof import('node:fs');
  const nodeUrl = module.require('node:url') as typeof import('node:url');
  // pdfjs 只有 ESM 构建：用 indirect import 加载。不能直接写 `await import(...)`——
  // 本函数会被 toString 后到 worker 里执行，而 vitest/构建工具会把源码里的 dynamic import
  // 改写成模块级 SSR helper（序列化后在 worker 里不存在）。
  const importModule = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<unknown>;
  const pdfjs = (await importModule(
    nodeUrl.pathToFileURL(staticInput.pdfjsPath).href
  )) as typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  // 主线程投递的纯函数源码（同一份实现，见文件头）。
  const evalFactory = new Function(
    `return (${staticInput.helpersSource})();`
  ) as () => ReturnType<typeof pdfParseHelpers>;
  const helpers = evalFactory();
  const evalOrder = new Function(`return (${staticInput.orderPageLinesSource});`) as () => typeof orderPageLines;
  const orderLines = evalOrder();

  /**
   * PDF.js 在 Node 中默认把 file:// URL 直接交给 fs，导致 GBK 等 CMap 读取失败，
   * 中文文本会被拆成标点/数字碎片。这里改为按本地路径读取内置 CMap 和标准字体。
   * 与改造前 store.ts 的 DiskBinaryDataFactory 同实现（worker 入口必须自包含，故内联）。
   */
  class DiskBinaryDataFactory {
    private readonly cMapUrl: string | null;
    private readonly standardFontDataUrl: string | null;
    private readonly wasmUrl: string | null;

    constructor({
      cMapUrl = null,
      standardFontDataUrl = null,
      wasmUrl = null
    }: {
      cMapUrl?: string | null;
      standardFontDataUrl?: string | null;
      wasmUrl?: string | null;
    }) {
      this.cMapUrl = cMapUrl;
      this.standardFontDataUrl = standardFontDataUrl;
      this.wasmUrl = wasmUrl;
    }

    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const base =
        kind === 'cMapUrl'
          ? this.cMapUrl
          : kind === 'standardFontDataUrl'
            ? this.standardFontDataUrl
            : kind === 'wasmUrl'
              ? this.wasmUrl
              : null;
      if (!base) throw new Error(`missing ${kind}`);
      return new Uint8Array(fs.readFileSync(nodeUrl.fileURLToPath(`${base}${filename}`)));
    }
  }

  /** 与改造前 store.parsePdf 页级算法逐行一致（第 642–770 行）。 */
  const parse = async (bytes: Uint8Array): Promise<ParsedPdf> => {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableFontFace: true,
      useSystemFonts: true,
      useWorkerFetch: false,
      BinaryDataFactory: DiskBinaryDataFactory,
      cMapUrl: staticInput.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: staticInput.standardFontDataUrl,
      wasmUrl: staticInput.wasmUrl
    });
    try {
      const pdf = await loadingTask.promise;
      const pages = pdf.numPages;
      let author = '';
      let publication = '';
      let title = '';
      let doi = '';
      let metadataDoi = '';
      try {
        const metadata = await pdf.getMetadata();
        const info = metadata.info as { Author?: unknown; Title?: unknown } | undefined;
        if (info && typeof info.Author === 'string') author = info.Author.trim().slice(0, 200);
        if (info && typeof info.Title === 'string') title = info.Title.trim().slice(0, 240);
        publication = helpers.publicationFromMetadata(metadata);
        metadataDoi = helpers.normalizeDoi(
          helpers.metadataString(metadata, [
            'prism:doi',
            'prism:DOI',
            'dc:identifier',
            'dc:source'
          ])
        );
        if (metadataDoi && !/^10\.\d{4,9}\//.test(metadataDoi)) metadataDoi = '';
        doi = metadataDoi;
      } catch {
        author = '';
        publication = '';
        title = '';
        doi = '';
        metadataDoi = '';
      }

      const chunks: ParsedChunk[] = [];
      for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const lines: Array<{
          text: string;
          x0: number;
          y0: number;
          x1: number;
          y1: number;
          baseline: number;
          ended: boolean;
        }> = [];
        let current: (typeof lines)[number] | null = null;

        for (const item of content.items) {
          if (!('str' in item) || !item.str) continue;
          const [, , , , x, y] = item.transform as [number, number, number, number, number, number];
          const width = item.width ?? 0;
          const height = item.height ?? 0;
          const startsNewLine =
            current == null ||
            Math.abs(current.baseline - y) > 2 ||
            current.ended ||
            (x - current.x1 > 20 && item.str.trim().length > 0);
          if (startsNewLine) {
            if (current) lines.push(current);
            current = {
              text: '',
              x0: x,
              y0: y,
              x1: x + width,
              y1: y + height,
              baseline: y,
              ended: false
            };
          }
          const line = current as NonNullable<typeof current>;
          line.text += item.str;
          line.x0 = Math.min(line.x0, x);
          line.y0 = Math.min(line.y0, y);
          line.x1 = Math.max(line.x1, x + width);
          line.y1 = Math.max(line.y1, y + height);
          line.ended = Boolean(item.hasEOL);
        }
        if (current) lines.push(current);

        // 阅读顺序与引用定位/目录共用 structure.orderPageLines（左栏整栏 → 右栏，
        // 跨栏标题分段；单栏按 y,x）。这里先把行换成左上原点的页面点坐标再排序。
        // 用 viewport.convertToViewportPoint 而不是手写 height - y：旋转页（90/180/270）
        // 的坐标轴会互换，手写换算会把 bbox 落到页面外。
        const boxOf = (line: (typeof lines)[number]): [number, number, number, number] => {
          const corners = [
            viewport.convertToViewportPoint(line.x0, line.y0),
            viewport.convertToViewportPoint(line.x1, line.y1)
          ];
          return [
            Math.min(corners[0]![0], corners[1]![0]),
            Math.min(corners[0]![1], corners[1]![1]),
            Math.max(corners[0]![0], corners[1]![0]),
            Math.max(corners[0]![1], corners[1]![1])
          ];
        };
        const ordered = orderLines(
          lines.map((line) => ({ line, bbox: boxOf(line) })),
          viewport.width
        );
        for (const { line } of ordered) {
          const text = line.text.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const bbox = boxOf(line);
          for (let start = 0; start < text.length; start += 1000) {
            chunks.push({
              page: pageNumber,
              text: text.slice(start, start + 1200),
              bbox: JSON.stringify(bbox)
            });
          }
        }
      }

      if (!doi) {
        for (const chunk of chunks) {
          doi = helpers.extractDoi(chunk.text);
          if (doi) break;
        }
      }
      // 来源按「实际被 importDocument 使用的字段」判断：作者/发表处/DOI 来自 PDF 内嵌元数据
      // （Info 字典或 XMP）→ pdf_xmp；只用首页正文识别到 DOI → pdf_first_page；否则只有文件名。
      const metadataSource: MetadataSource =
        author || publication || metadataDoi
          ? 'pdf_xmp'
          : doi
            ? 'pdf_first_page'
            : 'filename';
      return { pages, author, publication, title, doi, metadataSource, chunks };
    } finally {
      // 解析失败时也释放 pdfjs 文档（worker 常驻，不能把失败文档留在内存里）。
      await loadingTask.destroy();
    }
  };

  const describeError = (error: unknown): WorkerErrorPayload => {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return {
        type: 'error',
        id: 0,
        name: error.name || 'Error',
        message: error.message || String(error),
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {})
      };
    }
    return { type: 'error', id: 0, name: 'Error', message: String(error) };
  };

  parentPort.on('message', (task: PdfParseTaskInput) => {
    void parse(task.bytes).then(
      (parsed) => {
        parentPort.postMessage({ type: 'result', id: task.id, parsed });
      },
      (error) => {
        parentPort.postMessage({ ...describeError(error), id: task.id });
      }
    );
  });
  parentPort.postMessage({ type: 'ready' });
}

/**
 * 并发槽数：默认 2，可配置（`STUDIANDA_PDF_WORKERS`，1–4），硬上限 4。
 * 每个 worker 常驻加载一份 pdfjs；内存 <4 GB 的机器自动降到 1，避免同时解析两篇大 PDF 撑爆。
 */
export const PDF_WORKER_DEFAULT_CONCURRENCY = 2;
export const PDF_WORKER_MAX_CONCURRENCY = 4;

/** 单篇解析超时：主线程已不阻塞，卡死时终止 worker 重来，而不是让池永久忙。 */
const PARSE_TASK_TIMEOUT_MS = 10 * 60_000;
/** 空闲 30 秒后释放解析 worker（下次导入按需重新拉起）。 */
const PARSE_WORKER_IDLE_MS = 30_000;

/** 并发槽数（环境变量 `STUDIANDA_PDF_WORKERS`，1–4；默认 2）。 */
export function pdfWorkerConcurrency(): number {
  const raw = (process.env.STUDIANDA_PDF_WORKERS ?? '').trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  const requested =
    Number.isInteger(parsed) && parsed >= 1 ? parsed : PDF_WORKER_DEFAULT_CONCURRENCY;
  const memoryLimited = os.totalmem() < 4 * 1024 ** 3 ? 1 : requested;
  return Math.max(1, Math.min(PDF_WORKER_MAX_CONCURRENCY, memoryLimited));
}

/** 任务被取消（AbortSignal 触发）。上层据此区分「用户取消」与「解析失败」。 */
export class PdfParseCancelledError extends Error {
  constructor(message = 'PDF 解析已取消') {
    super(message);
    this.name = 'PdfParseCancelledError';
  }
}

export interface ParseTaskOptions {
  signal?: AbortSignal;
}

export interface PdfParseWorkerStats {
  workers: number;
  busy: number;
  queued: number;
  spawned: number;
  completed: number;
  failed: number;
  cancelled: number;
}

interface QueuedParseTask {
  task: PdfParseTaskInput;
  resolve: (parsed: ParsedPdf) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  slot?: ParseSlot;
  timer?: NodeJS.Timeout;
}

interface ParseSlot {
  worker: Worker;
  ready: boolean;
  current: QueuedParseTask | null;
}

const slots: ParseSlot[] = [];
const queue: QueuedParseTask[] = [];
const counters = { spawned: 0, completed: 0, failed: 0, cancelled: 0 };
let nextTaskId = 1;
let idleTimer: NodeJS.Timeout | null = null;
let staticInput: PdfParseWorkerStaticInput | null = null;
let workerSource: string | null = null;

function resolveStaticInput(): PdfParseWorkerStaticInput {
  if (!staticInput) {
    const require = createRequire(import.meta.url);
    const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
    staticInput = {
      pdfjsPath,
      cMapUrl: pathToFileURL(path.join(pdfjsRoot, 'cmaps') + path.sep).href,
      standardFontDataUrl: pathToFileURL(path.join(pdfjsRoot, 'standard_fonts') + path.sep).href,
      wasmUrl: pathToFileURL(path.join(pdfjsRoot, 'wasm') + path.sep).href,
      helpersSource: pdfParseHelpers.toString(),
      orderPageLinesSource: orderPageLines.toString()
    };
  }
  return staticInput;
}

function workerScript(): string {
  if (!workerSource) {
    // 与 backup-worker/ocr-worker 同一手法：worker 入口函数序列化后 eval，源码模式与打包产物共用。
    workerSource = `const { workerData } = require('node:worker_threads');
(${pdfParseWorkerMain.toString()})(workerData).catch((error) => {
  try {
    require('node:worker_threads').parentPort.postMessage({
      type: 'error',
      id: 0,
      name: (error && error.name) || 'Error',
      message: String((error && (error.stack || error.message)) || error)
    });
  } catch {
    // 连错误都上报失败时只能让 worker 退出，主线程通过 exit 事件感知。
  }
});`;
  }
  return workerSource;
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown(): void {
  if (idleTimer || queue.length > 0 || slots.some((slot) => slot.current)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (queue.length > 0 || slots.some((slot) => slot.current)) return;
    const idle = slots.splice(0, slots.length);
    for (const slot of idle) void slot.worker.terminate();
  }, PARSE_WORKER_IDLE_MS);
  idleTimer.unref?.();
}

/**
 * 空闲 worker 的引用计数：有任务在跑时 ref（进程别退出），空转时 unref
 * （Core 退出/测试进程收尾时不必等 30 秒空闲回收，也不会把常驻 worker 误当成泄漏）。
 */
function setIdleRef(slot: ParseSlot, idle: boolean): void {
  if (idle) slot.worker.unref();
  else slot.worker.ref();
}

function removeSlot(slot: ParseSlot): void {
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
}

function finishTask(item: QueuedParseTask, error: Error | null, parsed?: ParsedPdf): void {
  if (item.slot && item.slot.current === item) item.slot.current = null;
  const slot = item.slot;
  item.slot = undefined;
  if (item.timer) clearTimeout(item.timer);
  item.timer = undefined;
  if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
  item.onAbort = undefined;
  if (error) {
    if (error instanceof PdfParseCancelledError) counters.cancelled += 1;
    else counters.failed += 1;
    item.reject(error);
  } else {
    counters.completed += 1;
    item.resolve(parsed as ParsedPdf);
  }
  // 该 worker 现在空转、且没有排队任务：允许进程退出。
  if (slot && slots.includes(slot) && slot.current === null && queue.length === 0) {
    setIdleRef(slot, true);
  }
}

/** 取消/超时/崩溃时终止一个 worker，并把它手上的任务按指定错误结束。 */
function killSlot(slot: ParseSlot, error: Error): void {
  removeSlot(slot);
  const current = slot.current;
  if (current) finishTask(current, error);
  void slot.worker.terminate().catch(() => undefined);
  dispatchQueue();
  scheduleIdleShutdown();
}

function dispatchQueue(): void {
  if (queue.length === 0) return;
  clearIdleTimer();
  for (;;) {
    if (queue.length === 0) {
      scheduleIdleShutdown();
      return;
    }
    const item = queue[0]!;
    if (item.signal?.aborted) {
      queue.shift();
      finishTask(item, new PdfParseCancelledError());
      continue;
    }
    const slot = slots.find((candidate) => candidate.ready && candidate.current === null);
    if (slot) {
      queue.shift();
      slot.current = item;
      item.slot = slot;
      setIdleRef(slot, false);
      item.timer = setTimeout(() => {
        killSlot(slot, new Error('PDF 解析超时（600 秒）：已终止解析 worker，请重试。'));
      }, PARSE_TASK_TIMEOUT_MS);
      item.timer.unref?.();
      if (item.signal) {
        // 排队时的 onAbort 只负责出队；开始执行后换成「终止 worker」的监听（先摘掉旧的，避免泄漏）。
        if (item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        item.onAbort = () => {
          if (item.slot) killSlot(item.slot, new PdfParseCancelledError());
        };
        item.signal.addEventListener('abort', item.onAbort, { once: true });
      }
      slot.worker.postMessage(item.task);
      continue;
    }
    // 只为已排队任务按需扩容（不因为一个任务就预先拉起整池）。
    const needed = Math.min(
      pdfWorkerConcurrency(),
      queue.length + slots.filter((candidate) => candidate.current).length
    );
    if (slots.length < needed) {
      spawnSlot();
      continue;
    }
    return;
  }
}

function spawnSlot(): void {
  const worker = new Worker(workerScript(), {
    eval: true,
    workerData: resolveStaticInput(),
    // 不把 worker 的 log 混进 Core 日志；错误通过 message 通道回传。
    stdout: false,
    stderr: false
  });
  const slot: ParseSlot = { worker, ready: false, current: null };
  slots.push(slot);
  counters.spawned += 1;

  worker.on('message', (message: PdfParseWorkerMessage) => {
    if (message.type === 'ready') {
      slot.ready = true;
      dispatchQueue();
      scheduleIdleShutdown();
      return;
    }
    // 启动阶段失败（依赖解析/加载）：message.id 为 0，还没有任务可以挂靠，直接让整个池失败。
    if (!slot.ready) {
      workerFailed(new Error(message.type === 'error' ? message.message : 'PDF 解析 worker 启动失败'));
      return;
    }
    const current = slot.current;
    if (!current) return;
    // id 对不上说明是上一个被终止任务的迟到消息，忽略。
    if (message.id !== current.task.id) return;
    if (message.type === 'result') {
      finishTask(current, null, message.parsed);
    } else {
      const error = new Error(message.message);
      error.name = message.name;
      if (message.code !== undefined) (error as Error & { code?: unknown }).code = message.code;
      finishTask(current, error);
    }
    dispatchQueue();
    scheduleIdleShutdown();
  });

  const workerFailed = (error: Error): void => {
    if (!slots.includes(slot)) return;
    removeSlot(slot);
    const current = slot.current;
    if (current) finishTask(current, error);
    // worker 还没 ready 就挂了：多半是依赖解析/加载问题，排队任务不可能完成，全部如实失败。
    if (!slot.ready) {
      const pending = queue.splice(0, queue.length);
      for (const item of pending) finishTask(item, error);
    }
    dispatchQueue();
    scheduleIdleShutdown();
  };

  worker.on('error', (error) => {
    workerFailed(error instanceof Error ? error : new Error(String(error)));
  });
  worker.on('exit', (code) => {
    if (!slots.includes(slot)) return;
    workerFailed(new Error(`PDF 解析 worker 意外退出（exit code ${code}）`));
  });
}

function enqueueParse(task: PdfParseTaskInput, options?: ParseTaskOptions): Promise<ParsedPdf> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(new PdfParseCancelledError());
  return new Promise<ParsedPdf>((resolve, reject) => {
    const item: QueuedParseTask = { task, resolve, reject, signal };
    if (signal) {
      item.onAbort = () => {
        // 还在排队：直接出队失败；正在跑：onAbort 会被替换成终止 worker（见 dispatchQueue）。
        const index = queue.indexOf(item);
        if (index >= 0) {
          queue.splice(index, 1);
          finishTask(item, new PdfParseCancelledError());
        }
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
    }
    queue.push(item);
    dispatchQueue();
  });
}

/**
 * 在 worker 线程解析 PDF（导入路径用），返回与改造前 `store.parsePdf` 完全一致的结果。
 *
 * 并发上限见 `pdfWorkerConcurrency()`；worker 空闲 30 秒自动回收。
 * `signal` 触发时：排队任务直接出队失败，执行中的任务终止 worker 并以
 * `PdfParseCancelledError` 失败（导入据此映射成 `ImportCancelledError`）。
 */
export function parsePdfOffMainThread(
  bytes: Uint8Array,
  options?: ParseTaskOptions
): Promise<ParsedPdf> {
  return enqueueParse({ id: nextTaskId++, bytes }, options);
}

/** 测试/诊断用：worker 池当前状态。 */
export function pdfParseWorkerStats(): PdfParseWorkerStats {
  return {
    workers: slots.length,
    busy: slots.filter((slot) => slot.current !== null).length,
    queued: queue.length,
    ...counters
  };
}

/** 关闭解析 worker 池（测试收尾/应用退出）；排队任务以取消错误结束。 */
export async function shutdownPdfParseWorkers(): Promise<void> {
  clearIdleTimer();
  const pending = queue.splice(0, queue.length);
  for (const item of pending) finishTask(item, new PdfParseCancelledError('PDF 解析 worker 已关闭'));
  const idle = slots.splice(0, slots.length);
  await Promise.all(
    idle.map(async (slot) => {
      const current = slot.current;
      if (current) finishTask(current, new PdfParseCancelledError('PDF 解析 worker 已关闭'));
      await slot.worker.terminate().catch(() => undefined);
    })
  );
}
