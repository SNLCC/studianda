/**
 * 备份 zip 压缩 worker（运行在 node:worker_threads 线程里，不在 Core 主线程）。
 *
 * 主线程只负责收集文件清单（zip 内名称 + 绝对路径 + 字节数）与输出路径，
 * 把清单通过 workerData 交给本模块的 `backupWorkerMain`；worker 线程逐个文件
 * 分块读入、用 fflate 流式 deflate 压缩、边压边写盘，并按「已处理字节/文件数」
 * 回报进度。整个资料目录不会一次性读进内存。
 *
 * 注意：`backupWorkerMain` 会被序列化（Function#toString）后作为 eval worker 执行，
 * 所以它必须保持自包含——不引用模块作用域里的其他变量，依赖只用 eval worker 自带的
 * `module.require`（见 backup.ts 的 compressInWorker）。这样源码模式与打包后的单文件
 * dist/index.js 都能使用同一个实现，不需要额外的构建产物。
 * 依赖用 `module.require` 而不是 `require`：esbuild 打包 ESM 时会把源码里的 `require`
 * 改写成只支持静态依赖的 `__require` shim，序列化后在 worker 里不可用。
 */

export interface BackupWorkerEntry {
  /** zip 内条目名：数据库快照用文件名，普通文件用相对路径（统一 `/`）。 */
  name: string;
  /** 绝对路径（普通文件在数据目录，数据库快照在本次 staging 目录）。 */
  path: string;
  /** 主线程 stat 出的字节数，用于进度估算。 */
  size: number;
}

export interface BackupWorkerInput {
  entries: BackupWorkerEntry[];
  /** 半成品 zip 的绝对路径；成功后由主线程原子改名到最终文件名。 */
  outputPath: string;
  /** fflate 的 require 绝对路径（eval worker 没有模块 URL，不能按包名解析）。 */
  fflatePath: string;
}

export type BackupWorkerMessage =
  | {
      type: 'progress';
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
    }
  | { type: 'done'; files: number; bytes: number; outputBytes: number }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

declare const module: { require: (id: string) => unknown };

/**
 * worker 线程入口。必须是自包含函数（见文件头说明），不要引用模块级常量/函数。
 */
export async function backupWorkerMain(input: BackupWorkerInput): Promise<void> {
  const workerThreads = module.require('node:worker_threads') as typeof import('node:worker_threads');
  const parentPort = workerThreads.parentPort;
  if (!parentPort) throw new Error('备份压缩 worker 缺少 parentPort');
  const fs = module.require('node:fs') as typeof import('node:fs');
  const fflate = module.require(input.fflatePath) as typeof import('fflate');

  const chunkBytes = 1024 * 1024;
  const filesTotal = input.entries.length;
  const bytesTotal = input.entries.reduce((sum, entry) => sum + entry.size, 0);
  let filesDone = 0;
  let bytesDone = 0;
  let outputBytes = 0;
  let lastProgressAt = 0;
  let cancelRequested = false;

  /**
   * 同步读取主线程投递的取消消息：压缩循环是同步的，等不到 message 事件派发，
   * 必须用 receiveMessageOnPort 在分块边界轮询；取消时优雅收尾（关 fd）再由主线程清理。
   */
  const cancelSeen = (): boolean => {
    const pending = workerThreads.receiveMessageOnPort(parentPort);
    if (pending && (pending.message as { type?: unknown }).type === 'cancel') {
      cancelRequested = true;
    }
    return cancelRequested;
  };

  const report = (): void => {
    const now = Date.now();
    if (now - lastProgressAt < 200) return;
    lastProgressAt = now;
    parentPort.postMessage({
      type: 'progress',
      filesDone,
      filesTotal,
      bytesDone,
      bytesTotal
    });
  };

  const output = fs.openSync(input.outputPath, 'w');
  try {
    try {
      const zip = new fflate.Zip((error, chunk) => {
        if (error) throw error;
        outputBytes += chunk.length;
        let written = 0;
        while (written < chunk.length) {
          written += fs.writeSync(output, chunk.subarray(written));
        }
      });
      const readBuffer = Buffer.allocUnsafe(chunkBytes);
      for (const entry of input.entries) {
        if (cancelSeen()) throw new Error('备份已取消');
        const deflate = new fflate.ZipDeflate(entry.name, { level: 6 });
        zip.add(deflate);
        const source = fs.openSync(entry.path, 'r');
        let fileBytes = 0;
        try {
          for (;;) {
            const read = fs.readSync(source, readBuffer, 0, chunkBytes, null);
            if (read <= 0) {
              deflate.push(readBuffer.subarray(0, 0), true);
              break;
            }
            deflate.push(readBuffer.subarray(0, read), false);
            fileBytes += read;
            if (Date.now() - lastProgressAt >= 200) {
              parentPort.postMessage({
                type: 'progress',
                filesDone,
                filesTotal,
                bytesDone: bytesDone + fileBytes,
                bytesTotal
              });
              lastProgressAt = Date.now();
            }
            if (cancelSeen()) throw new Error('备份已取消');
          }
        } finally {
          fs.closeSync(source);
        }
        bytesDone += fileBytes;
        filesDone += 1;
        lastProgressAt = 0;
        report();
      }
      zip.end();
      if (cancelSeen()) throw new Error('备份已取消');
      parentPort.postMessage({
        type: 'done',
        files: filesDone,
        bytes: bytesDone,
        outputBytes
      });
    } catch (error) {
      // 取消是正常收尾：回报 cancelled，主线程按 BackupCancelledError 处理并清理半成品。
      if (!cancelRequested) throw error;
      parentPort.postMessage({ type: 'cancelled' });
    }
  } finally {
    fs.closeSync(output);
  }
}
