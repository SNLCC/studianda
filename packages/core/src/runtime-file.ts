import { readFileSync, rmSync } from 'node:fs';

/**
 * 正常退出时删除自己写的 runtime.json。
 * 只删 pid 与当前进程一致的文件，避免慢退出的旧进程误删新实例刚写好的握手文件。
 */
export function removeOwnRuntimeFile(runtimePath: string, pid: number): void {
  try {
    const parsed = JSON.parse(readFileSync(runtimePath, 'utf8')) as { pid?: number };
    if (parsed.pid === pid) rmSync(runtimePath, { force: true });
  } catch {
    // 文件已不存在或内容损坏：无需处理。
  }
}
