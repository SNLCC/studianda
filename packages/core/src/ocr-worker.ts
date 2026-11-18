/**
 * OCR 取图 worker（运行在 node:worker_threads 线程里，不在 Core 主线程）。
 *
 * 为什么是「取图」而不是整条识别链：
 * - tesseract.js 自己就用 `new Worker()` 跑识别（见 node_modules/tesseract.js/src/worker/node/spawnWorker.js），
 *   识别从来不在主线程；再套一层 worker 只会让每个并发槽变成「取图线程 + tesseract 线程」两条线程、
 *   内存翻倍，取消时还要处理嵌套线程的清理。
 * - 实测主线程耗时几乎全在 pdfjs 光栅化（页面渲染 12–68 ms/页，事件循环最长停顿 77–109 ms）、
 *   其次是 tesseract 结果的结构化克隆（约 8 ms/页）；PNG 编码在主线程之外（长任务 75 ms 期间事件循环只停 16 ms），
 *   后处理（行框归一化 + 遮罩过滤 + 文本质量）实测 0.53 ms/页（见 ocr-worker.test.ts 与报告）。
 * 所以这里把「取图 + 预处理（缩放/裁区）+ PNG 编码」放进 worker 池，主线程只调度与落库；
 * 识别仍由 tesseract 自己的 worker 线程做，且主线程侧做了 N 个实例的池化（见 ocr.ts 的 OcrEnginePool）。
 *
 * 内存实测（本机 Windows / Node 24，8 页扫描图 PDF）：
 * - 2 个取图 worker 常驻约 +121 MB RSS（~60 MB/个），空闲 30 秒后自动回收；
 * - tesseract 核心（无语言数据）约 23 MB/实例；语言数据另计（本机未装语言包，未实测）。
 * 默认并发 2（`STUDIANDA_OCR_WORKERS`，1–4），内存 <4 GB 的机器自动降到 1。
 *
 * `ocrWorkerMain` 是常驻 worker 入口（接收多页任务、复用已加载的 pdfjs/canvas），
 * 会被序列化（Function#toString）后作为 eval worker 执行，因此必须自包含：
 * 不引用模块作用域里的变量，依赖只用 eval worker 自带的 `module.require`。
 * 依赖用 `module.require` 而不是 `require`：esbuild 打包 ESM 时会把源码里的 `require`
 * 改写成只支持静态依赖的 `__require` shim，序列化后在 worker 里不可用。
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import os from 'node:os';

/** 渲染任务输入（主线程 → worker）。与 ocr.ts 的 RENDER_LIMITS 解耦：上限由主线程传入，避免两处漂移。 */
export interface OcrRenderTaskInput {
  id: number;
  pdfPath: string;
  page: number;
  scale: number;
  maxScale: number;
  maxLongEdge: number;
  minScale: number;
  /** 给出时先渲染整页再按归一化坐标裁剪（区域 OCR）。 */
  region?: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrRenderWorkerStaticInput {
  canvasPath: string;
  pdfjsPath: string;
}

export type OcrRenderWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; width: number; height: number; png: Uint8Array }
  | { type: 'error'; id: number; message: string };

/** 主线程切到 worker 渲染/裁图的返回（png 为 PNG 字节，宽度高度为输出图尺寸）。 */
export interface RenderedImage {
  png: Buffer;
  width: number;
  height: number;
}

declare const module: { require: (id: string) => unknown };

/**
 * 常驻 worker 入口。必须自包含（见文件头说明），不要引用模块级常量/函数。
 *
 * 与备份 worker 不同，这里不靠 workerData 传任务：worker 启动一次、加载 pdfjs/canvas 后
 * 接收多页任务，避免每页都付 ~100–200 ms 的 worker 启动 + 模块加载成本。
 */
export async function ocrWorkerMain(staticInput: OcrRenderWorkerStaticInput): Promise<void> {
  const workerThreads = module.require('node:worker_threads') as typeof import('node:worker_threads');
  const parentPort = workerThreads.parentPort;
  if (!parentPort) throw new Error('OCR 取图 worker 缺少 parentPort');
  const fs = module.require('node:fs') as typeof import('node:fs');
  const nodeUrl = module.require('node:url') as typeof import('node:url');
  const canvas = module.require(staticInput.canvasPath) as typeof import('@napi-rs/canvas');
  // pdfjs 只有 ESM 构建：用 indirect import 加载。不能直接写 `await import(...)`——
  // 本函数会被 toString 后到 worker 里执行，而 vitest/构建工具会把源码里的 dynamic import
  // 改写成模块级 SSR helper（如 __vite_ssr_dynamic_import__），序列化后在 worker 里不存在。
  const importModule = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<unknown>;
  const pdfjs = (await importModule(
    nodeUrl.pathToFileURL(staticInput.pdfjsPath).href
  )) as typeof import('pdfjs-dist/legacy/build/pdf.mjs');

  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

  /** 与 ocr.ts 的 renderPdfPage + cropRenderedRegion 同一套算法（上限/下限由主线程传入）。 */
  const render = async (task: OcrRenderTaskInput): Promise<RenderedImage> => {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(task.pdfPath)),
      disableFontFace: true,
      useSystemFonts: true
    });
    const pdf = await loadingTask.promise;
    try {
      if (!Number.isInteger(task.page) || task.page < 1 || task.page > pdf.numPages) {
        throw new Error('页码超出范围');
      }
      const pdfPage = await pdf.getPage(task.page);
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const longest = Math.max(baseViewport.width, baseViewport.height) || 1;
      // 乘 1-1e-9 让 cap 限定的边缘页在 Math.ceil 后仍不超过上限（与主线程实现一致）。
      const edgeScale = (task.maxLongEdge / longest) * (1 - 1e-9);
      const effectiveScale = Math.max(
        task.minScale,
        Math.min(task.scale, task.maxScale, edgeScale)
      );
      const viewport = pdfPage.getViewport({ scale: effectiveScale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const pageCanvas = canvas.createCanvas(width, height);
      const context = pageCanvas.getContext('2d');
      await pdfPage.render({
        canvasContext: context as never,
        canvas: pageCanvas as never,
        viewport
      }).promise;
      const png = await pageCanvas.encode('png');
      if (!task.region) return { png, width, height };
      const image = await canvas.loadImage(png);
      const sx = Math.min(width - 1, Math.max(0, Math.round(clamp01(task.region.x0) * width)));
      const sy = Math.min(height - 1, Math.max(0, Math.round(clamp01(task.region.y0) * height)));
      const ex = Math.min(width, Math.max(sx + 1, Math.round(clamp01(task.region.x1) * width)));
      const ey = Math.min(height, Math.max(sy + 1, Math.round(clamp01(task.region.y1) * height)));
      const cropWidth = Math.max(1, ex - sx);
      const cropHeight = Math.max(1, ey - sy);
      const cropCanvas = canvas.createCanvas(cropWidth, cropHeight);
      const cropContext = cropCanvas.getContext('2d');
      cropContext.drawImage(image, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      return { png: await cropCanvas.encode('png'), width: cropWidth, height: cropHeight };
    } finally {
      await loadingTask.destroy();
    }
  };

  parentPort.on('message', (task: OcrRenderTaskInput) => {
    void render(task).then(
      (image) => {
        // 拷贝一份独立 Uint8Array 再转移所有权：napi canvas 的 Buffer 可能来自池化内存，
        // 直接转移底层 ArrayBuffer 有把别的视图一起 detach 的风险。
        const bytes = new Uint8Array(image.png);
        parentPort.postMessage(
          { type: 'result', id: task.id, width: image.width, height: image.height, png: bytes },
          [bytes.buffer]
        );
      },
      (error) => {
        parentPort.postMessage({
          type: 'error',
          id: task.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    );
  });
  parentPort.postMessage({ type: 'ready' });
}

/**
 * 并发槽数（渲染 worker 与 tesseract 实例共用同一个上限）：
 * 默认 2，可配置，硬上限 4。内存很紧的机器（<4 GB）自动降到 1，避免多实例把内存打爆。
 */
export const OCR_WORKER_DEFAULT_CONCURRENCY = 2;
export const OCR_WORKER_MAX_CONCURRENCY = 4;

/** 单页渲染超时：主线程事件循环已经不会被它占住，卡死时终止 worker 重来，而不是让池永久忙。 */
const RENDER_TASK_TIMEOUT_MS = 180_000;
/** 空闲 30 秒后释放取图 worker（保留 tesseract 实例，避免反复加载语言数据）。 */
const RENDER_WORKER_IDLE_MS = 30_000;

/** 并发槽数（环境变量 `STUDIANDA_OCR_WORKERS`，1–4；默认 2）。 */
export function ocrWorkerConcurrency(): number {
  const raw = (process.env.STUDIANDA_OCR_WORKERS ?? '').trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  const requested =
    Number.isInteger(parsed) && parsed >= 1
      ? parsed
      : OCR_WORKER_DEFAULT_CONCURRENCY;
  const memoryLimited = os.totalmem() < 4 * 1024 ** 3 ? 1 : requested;
  return Math.max(1, Math.min(OCR_WORKER_MAX_CONCURRENCY, memoryLimited));
}

/** 任务被取消（AbortSignal 触发）。上层据此区分「用户取消」与「识别失败」。 */
export class OcrCancelledError extends Error {
  constructor(message = '本机 OCR 已取消') {
    super(message);
    this.name = 'OcrCancelledError';
  }
}

export interface RenderTaskOptions {
  signal?: AbortSignal;
}

export interface OcrRenderWorkerStats {
  workers: number;
  busy: number;
  queued: number;
  spawned: number;
  completed: number;
  failed: number;
  cancelled: number;
}

interface QueuedRenderTask {
  task: OcrRenderTaskInput;
  resolve: (image: RenderedImage) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  slot?: RenderSlot;
  timer?: NodeJS.Timeout;
}

interface RenderSlot {
  worker: Worker;
  ready: boolean;
  current: QueuedRenderTask | null;
}

const slots: RenderSlot[] = [];
const queue: QueuedRenderTask[] = [];
const counters = { spawned: 0, completed: 0, failed: 0, cancelled: 0 };
let nextTaskId = 1;
let idleTimer: NodeJS.Timeout | null = null;
let dependencyPaths: { canvasPath: string; pdfjsPath: string } | null = null;
let workerSource: string | null = null;

function resolveDependencyPaths(): { canvasPath: string; pdfjsPath: string } {
  if (!dependencyPaths) {
    const require = createRequire(import.meta.url);
    dependencyPaths = {
      canvasPath: require.resolve('@napi-rs/canvas'),
      pdfjsPath: require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
    };
  }
  return dependencyPaths;
}

function workerScript(): string {
  if (!workerSource) {
    // 与 backup-worker 同一手法：worker 入口函数序列化后 eval，源码模式与打包后的单文件都能用。
    workerSource = `const { workerData } = require('node:worker_threads');
(${ocrWorkerMain.toString()})(workerData).catch((error) => {
  try {
    require('node:worker_threads').parentPort.postMessage({
      type: 'error',
      id: 0,
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
  }, RENDER_WORKER_IDLE_MS);
  idleTimer.unref?.();
}

function removeSlot(slot: RenderSlot): void {
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
}

function finishTask(item: QueuedRenderTask, error: Error | null, image?: RenderedImage): void {
  if (item.slot && item.slot.current === item) item.slot.current = null;
  item.slot = undefined;
  if (item.timer) clearTimeout(item.timer);
  item.timer = undefined;
  if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
  item.onAbort = undefined;
  if (error) {
    if (error instanceof OcrCancelledError) counters.cancelled += 1;
    else counters.failed += 1;
    item.reject(error);
  } else {
    counters.completed += 1;
    item.resolve(image as RenderedImage);
  }
}

/** 取消/超时/崩溃时终止一个 worker，并把它手上的任务按指定错误结束。 */
function killSlot(slot: RenderSlot, error: Error): void {
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
      finishTask(item, new OcrCancelledError());
      continue;
    }
    const slot = slots.find((candidate) => candidate.ready && candidate.current === null);
    if (slot) {
      queue.shift();
      slot.current = item;
      item.slot = slot;
      item.timer = setTimeout(() => {
        killSlot(slot, new Error('PDF 页面渲染超时（180 秒）：已终止取图 worker，请重试。'));
      }, RENDER_TASK_TIMEOUT_MS);
      item.timer.unref?.();
      if (item.signal) {
        // 排队时的 onAbort 只负责出队；开始执行后换成「终止 worker」的监听（先摘掉旧的，避免泄漏）。
        if (item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        item.onAbort = () => {
          if (item.slot) killSlot(item.slot, new OcrCancelledError());
        };
        item.signal.addEventListener('abort', item.onAbort, { once: true });
      }
      slot.worker.postMessage(item.task);
      continue;
    }
    // 只为已排队任务按需扩容（不因为一个任务就预先拉起整池）。
    const needed = Math.min(ocrWorkerConcurrency(), queue.length + slots.filter((s) => s.current).length);
    if (slots.length < needed) {
      spawnSlot();
      continue;
    }
    return;
  }
}

function spawnSlot(): void {
  const paths = resolveDependencyPaths();
  const worker = new Worker(workerScript(), {
    eval: true,
    workerData: paths,
    // 不把 worker 的 log 混进 Core 日志；错误通过 message 通道回传。
    stdout: false,
    stderr: false
  });
  const slot: RenderSlot = { worker, ready: false, current: null };
  slots.push(slot);
  counters.spawned += 1;

  worker.on('message', (message: OcrRenderWorkerMessage) => {
    if (message.type === 'ready') {
      slot.ready = true;
      dispatchQueue();
      scheduleIdleShutdown();
      return;
    }
    // 启动阶段失败（依赖解析/加载）：message.id 为 0，还没有任务可以挂靠，直接让整个池失败。
    if (!slot.ready) {
      workerFailed(new Error(message.type === 'error' ? message.message : 'OCR 取图 worker 启动失败'));
      return;
    }
    const current = slot.current;
    if (!current) return;
    // id 对不上说明是上一个被终止任务的迟到消息，忽略。
    if (message.id !== current.task.id) return;
    if (message.type === 'result') {
      const bytes = message.png;
      finishTask(current, null, {
        png: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        width: message.width,
        height: message.height
      });
    } else {
      finishTask(current, new Error(message.message));
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
    workerFailed(new Error(`OCR 取图 worker 意外退出（exit code ${code}）`));
  });
}

function enqueueRender(task: OcrRenderTaskInput, options?: RenderTaskOptions): Promise<RenderedImage> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(new OcrCancelledError());
  return new Promise<RenderedImage>((resolve, reject) => {
    const item: QueuedRenderTask = { task, resolve, reject, signal };
    if (signal) {
      item.onAbort = () => {
        // 还在排队：直接出队失败；正在跑：onAbort 会被替换成终止 worker（见 dispatchQueue）。
        const index = queue.indexOf(item);
        if (index >= 0) {
          queue.splice(index, 1);
          finishTask(item, new OcrCancelledError());
        }
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
    }
    queue.push(item);
    dispatchQueue();
  });
}

/**
 * 在 worker 线程渲染 PDF 页（purpose 的像素上限由调用方传入），返回 PNG 与尺寸。
 * 与主线程 `renderPdfPage` 同算法：同一页同参数产出的 PNG 字节一致。
 */
export function renderPageOffMainThread(
  input: {
    pdfPath: string;
    page: number;
    scale: number;
    maxScale: number;
    maxLongEdge: number;
    minScale: number;
  },
  options?: RenderTaskOptions
): Promise<RenderedImage> {
  return enqueueRender({ id: nextTaskId++, ...input }, options);
}

/** 在 worker 线程渲染整页并裁出选区（区域 OCR 用），返回裁剪后的 PNG。 */
export function cropRegionOffMainThread(
  input: {
    pdfPath: string;
    page: number;
    region: { x0: number; y0: number; x1: number; y1: number };
    maxScale: number;
    maxLongEdge: number;
    minScale: number;
  },
  options?: RenderTaskOptions
): Promise<RenderedImage> {
  return enqueueRender({ id: nextTaskId++, scale: 2, ...input }, options);
}

/** 测试/诊断用：worker 池当前状态。 */
export function ocrRenderWorkerStats(): OcrRenderWorkerStats {
  return {
    workers: slots.length,
    busy: slots.filter((slot) => slot.current !== null).length,
    queued: queue.length,
    ...counters
  };
}

/** 关闭取图 worker 池（测试收尾/应用退出）；排队任务以取消错误结束。 */
export async function shutdownOcrRenderWorkers(): Promise<void> {
  clearIdleTimer();
  const pending = queue.splice(0, queue.length);
  for (const item of pending) finishTask(item, new OcrCancelledError('OCR 取图 worker 已关闭'));
  const idle = slots.splice(0, slots.length);
  await Promise.all(
    idle.map(async (slot) => {
      const current = slot.current;
      if (current) finishTask(current, new OcrCancelledError('OCR 取图 worker 已关闭'));
      await slot.worker.terminate().catch(() => undefined);
    })
  );
}
