import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';

/**
 * 大 JSON 响应的 gzip 压缩：JSON.stringify + gzip 在 worker_threads 固定池中执行。
 * 支持两种模式：
 * - buffer：worker 一次返回完整 gzip buffer（小 payload / 回退）；
 * - stream：worker 用 gzip 流分块 postMessage，主线程边收边写（大 payload，chunked）。
 * 线程复用；worker 异常/超时/不可克隆分派时任务失败，由调用方回退同步 buffer。
 */

const WORKER_CODE = `
(async () => {
  const { parentPort } = await import('node:worker_threads');
  const { gzipSync, createGzip } = await import('node:zlib');
  parentPort.on('message', (task) => {
    try {
      const json = JSON.stringify(task.data);
      if (task.mode === 'stream') {
        const gzip = createGzip();
        gzip.on('data', (chunk) => {
          // chunk 是 Buffer：若独占底层 ArrayBuffer 则直接转移，否则复制出独立 ArrayBuffer。
          const arrayBuffer =
            chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
              ? chunk.buffer
              : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          parentPort.postMessage({ type: 'chunk', chunk: arrayBuffer }, [arrayBuffer]);
        });
        gzip.on('end', () => {
          parentPort.postMessage({ ok: true, streamed: true });
        });
        gzip.on('error', (error) => {
          parentPort.postMessage({ ok: false, error: String(error && error.message || error) });
        });
        gzip.end(json);
      } else {
        const buffer = gzipSync(Buffer.from(json, 'utf8'));
        parentPort.postMessage({ ok: true, buffer });
      }
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error && error.message || error) });
    }
  });
})().catch(() => {
  process.exitCode = 1;
});
`;

const TASK_TIMEOUT_MS = 60000;
/** 大 payload 的粗略阈值：数组元素总数超过该值走流式。 */
export const STREAM_ARRAY_THRESHOLD = 500;
/** payload 估算字节阈值：超过则走流式（避免少量条目但超长字符串仍走完整 buffer）。 */
export const STREAM_BYTE_THRESHOLD = 2 * 1024 * 1024;

type TaskMode = 'buffer' | 'stream';

interface PoolTask {
  mode: TaskMode;
  data: unknown;
  onChunk?: (chunk: Buffer) => void;
  resolve: (buffer: Buffer | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  task: PoolTask | null;
  uses: number;
}

let workerPool: PoolWorker[] = [];
let taskQueue: PoolTask[] = [];

let workerCompressions = 0;
let fallbackCompressions = 0;
let syncCompressions = 0;
let workersSpawned = 0;
let poolReuses = 0;
let streamChunks = 0;
let streamBytes = 0;
let streamAborts = 0;

export function getJsonGzipStats(): {
  worker: number;
  fallback: number;
  sync: number;
  workersSpawned: number;
  poolReuses: number;
  streamChunks: number;
  streamBytes: number;
  streamAborts: number;
  activeWorkers: number;
  queued: number;
} {
  return {
    worker: workerCompressions,
    fallback: fallbackCompressions,
    sync: syncCompressions,
    workersSpawned,
    poolReuses,
    streamChunks,
    streamBytes,
    streamAborts,
    activeWorkers: workerPool.filter((entry) => entry.busy).length,
    queued: taskQueue.length
  };
}

/** 记录一次「已开始写出 chunk 后失败」的流式中断（调用方负责 destroy 连接）。 */
export function recordStreamAbort(bytesWritten: number): void {
  streamAborts += 1;
  // 已写出的字节数已由 chunk 接收统计进 streamBytes，这里不重复累加。
  void bytesWritten;
}

function poolSize(): number {
  const raw = Number(process.env.STUDIANDA_JSON_WORKER_POOL);
  if (Number.isFinite(raw)) return Math.min(4, Math.max(1, Math.trunc(raw)));
  return Math.min(2, Math.max(1, cpus().length));
}

/** 估算 JSON 总字节：递归累加字符串长度 + 数组元素数×固定开销，不做 JSON.stringify。 */
export function estimateJsonBytes(value: unknown, budget = STREAM_BYTE_THRESHOLD): number {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (bytes >= budget || depth > 8) return;
    if (typeof current === 'string') {
      bytes += current.length * 2;
      return;
    }
    if (typeof current === 'number' || typeof current === 'boolean' || current == null) {
      bytes += 8;
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) return;
      seen.add(current);
      bytes += current.length * 2;
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current === 'object') {
      if (seen.has(current)) return;
      seen.add(current);
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (bytes >= budget) return;
        bytes += key.length * 2 + 4;
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return bytes;
}

/**
 * 是否走流式：数组元素数 > 阈值，或估算 JSON 字节数 > 阈值（两者均为轻量遍历，
 * 不做完整 JSON.stringify）。覆盖「少量条目但字符串很大」的 payload。
 */
export function shouldStreamGzip(data: unknown): boolean {
  let count = 0;
  let estimatedBytes = 0;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): void => {
    if (
      count > STREAM_ARRAY_THRESHOLD ||
      estimatedBytes > STREAM_BYTE_THRESHOLD ||
      depth > 8
    ) {
      return;
    }
    if (typeof value === 'string') {
      estimatedBytes += value.length * 2;
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      estimatedBytes += 8;
      return;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return;
      seen.add(value);
      count += value.length;
      estimatedBytes += value.length * 2;
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (count > STREAM_ARRAY_THRESHOLD || estimatedBytes > STREAM_BYTE_THRESHOLD) return;
        estimatedBytes += key.length * 2 + 4;
        visit(child, depth + 1);
      }
    }
  };
  visit(data, 0);
  return count > STREAM_ARRAY_THRESHOLD || estimatedBytes > STREAM_BYTE_THRESHOLD;
}

function createWorker(): PoolWorker {
  workersSpawned += 1;
  const entry: PoolWorker = {
    worker: new Worker(WORKER_CODE, { eval: true }),
    busy: false,
    task: null,
    uses: 0
  };
  entry.worker.on('message', (message: unknown) => {
    const task = entry.task;
    if (!task) return;
    const payload = message as {
      type?: string;
      chunk?: Uint8Array | ArrayBuffer;
      ok?: boolean;
      buffer?: Uint8Array;
      streamed?: boolean;
      error?: string;
    };
    if (
      payload?.type === 'chunk' &&
      (payload.chunk instanceof ArrayBuffer || payload.chunk instanceof Uint8Array)
    ) {
      task.started = true;
      const chunkBuffer =
        payload.chunk instanceof ArrayBuffer
          ? Buffer.from(payload.chunk)
          : Buffer.from(payload.chunk);
      streamChunks += 1;
      streamBytes += chunkBuffer.length;
      try {
        task.onChunk?.(chunkBuffer);
      } catch (error) {
        failTask(entry, error instanceof Error ? error : new Error(String(error)), false);
      }
      return;
    }
    if (payload?.ok && payload.buffer instanceof Uint8Array) {
      completeTask(entry, Buffer.from(payload.buffer));
      return;
    }
    if (payload?.ok && payload.streamed) {
      completeTask(entry, null);
      return;
    }
    failTask(entry, new Error(payload?.error ?? 'worker gzip failed'), false);
  });
  entry.worker.on('error', (error) => {
    failTask(entry, error instanceof Error ? error : new Error(String(error)), true);
  });
  entry.worker.on('exit', (code) => {
    if (entry.task) {
      failTask(entry, new Error(`worker exited (${code})`), true);
    }
    const index = workerPool.indexOf(entry);
    if (index >= 0) workerPool.splice(index, 1);
    try {
      entry.worker.terminate();
    } catch {
      // 忽略
    }
    pumpQueue();
  });
  return entry;
}

function completeTask(entry: PoolWorker, buffer: Buffer | null): void {
  const task = entry.task;
  if (!task) return;
  clearTimeout(task.timer);
  entry.task = null;
  entry.busy = false;
  workerCompressions += 1;
  if (entry.uses > 0) poolReuses += 1;
  entry.uses += 1;
  task.resolve(buffer);
  pumpQueue();
}

function failTask(entry: PoolWorker, error: Error, replaceWorker: boolean): void {
  const task = entry.task;
  entry.task = null;
  entry.busy = false;
  if (replaceWorker) {
    const index = workerPool.indexOf(entry);
    if (index >= 0) workerPool.splice(index, 1);
    try {
      entry.worker.terminate();
    } catch {
      // 忽略
    }
  }
  if (task) {
    clearTimeout(task.timer);
    task.reject(error);
  }
  pumpQueue();
}

function assignTask(entry: PoolWorker, task: PoolTask): void {
  entry.task = task;
  entry.busy = true;
  try {
    entry.worker.postMessage({ mode: task.mode, data: task.data });
  } catch (error) {
    entry.task = null;
    entry.busy = false;
    clearTimeout(task.timer);
    task.reject(error instanceof Error ? error : new Error(String(error)));
    pumpQueue();
  }
}

function pumpQueue(): void {
  while (taskQueue.length > 0) {
    let idle = workerPool.find((entry) => !entry.busy);
    if (!idle) {
      if (workerPool.length < poolSize()) {
        idle = createWorker();
        workerPool.push(idle);
      } else {
        return;
      }
    }
    const task = taskQueue.shift()!;
    assignTask(idle, task);
  }
}

function enqueueTask(
  task: Pick<PoolTask, 'mode' | 'data' | 'onChunk'>
): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    const fullTask: PoolTask = {
      ...task,
      resolve,
      reject,
      started: false,
      timer: setTimeout(() => {
        const entry = workerPool.find((item) => item.task === fullTask);
        if (entry) failTask(entry, new Error('worker gzip timeout'), true);
        else {
          taskQueue = taskQueue.filter((item) => item !== fullTask);
          reject(new Error('worker gzip timeout'));
        }
      }, TASK_TIMEOUT_MS)
    };
    taskQueue.push(fullTask);
    pumpQueue();
  });
}

export function gzipJsonSync(data: unknown): Buffer {
  syncCompressions += 1;
  return gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
}

/** 关闭/重置 worker 池（测试用；也会清空统计）。 */
export function resetJsonGzipStats(): void {
  for (const entry of workerPool) {
    if (entry.task) {
      clearTimeout(entry.task.timer);
      entry.task.reject(new Error('worker pool reset'));
      entry.task = null;
    }
    try {
      entry.worker.terminate();
    } catch {
      // 忽略
    }
  }
  for (const task of taskQueue) {
    clearTimeout(task.timer);
    task.reject(new Error('worker pool reset'));
  }
  workerPool = [];
  taskQueue = [];
  workerCompressions = 0;
  fallbackCompressions = 0;
  syncCompressions = 0;
  workersSpawned = 0;
  poolReuses = 0;
  streamChunks = 0;
  streamBytes = 0;
  streamAborts = 0;
}

/**
 * 异步压缩 JSON 为完整 buffer：优先 worker 池；失败回退同步。
 * 环境变量 STUDIANDA_DISABLE_JSON_WORKER=1 可强制同步（测试/诊断用）。
 */
export async function gzipJsonForResponse(data: unknown): Promise<{
  buffer: Buffer;
  via: 'worker' | 'fallback' | 'sync';
}> {
  if (process.env.STUDIANDA_DISABLE_JSON_WORKER === '1') {
    return { buffer: gzipJsonSync(data), via: 'sync' };
  }
  try {
    const buffer = await enqueueTask({ mode: 'buffer', data });
    if (!buffer) throw new Error('worker returned no buffer');
    return { buffer, via: 'worker' };
  } catch {
    fallbackCompressions += 1;
    return { buffer: gzipJsonSync(data), via: 'fallback' };
  }
}

export interface StreamGzipResult {
  via: 'worker' | 'fallback' | 'sync';
  /** 是否已经开始向外写出 chunk（true 时不能回退完整 buffer）。 */
  started: boolean;
}

/**
 * 流式压缩 JSON：worker 边压缩边 postMessage 分块，调用方通过 onChunk 边收边写。
 * worker 在写出任何 chunk 之前失败 → 抛错（调用方可回退完整 buffer）；
 * 已写出 chunk 后失败 → 抛错（调用方只能中断连接）。
 */
export async function streamGzipJsonForResponse(
  data: unknown,
  onChunk: (chunk: Buffer) => void
): Promise<StreamGzipResult> {
  if (process.env.STUDIANDA_DISABLE_JSON_WORKER === '1') {
    const buffer = gzipJsonSync(data);
    onChunk(buffer);
    return { via: 'sync', started: true };
  }
  let started = false;
  try {
    await enqueueTask({
      mode: 'stream',
      data,
      onChunk: (chunk) => {
        started = true;
        onChunk(chunk);
      }
    });
    return { via: 'worker', started };
  } catch (error) {
    fallbackCompressions += 1;
    if (started) throw error;
    // 尚未写出任何 chunk：回退完整 buffer，由调用方决定如何发送。
    const buffer = gzipJsonSync(data);
    return { via: 'fallback', started: false };
  }
}

/** 供回退路径使用：同步生成完整 buffer 并返回（不自动写出）。 */
export function bufferForFallback(data: unknown): Buffer {
  return gzipJsonSync(data);
}
