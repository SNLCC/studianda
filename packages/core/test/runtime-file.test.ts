import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeOwnRuntimeFile } from '../src/runtime-file.js';

const dirs: string[] = [];
function tempFile(value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'studianda-runtime-'));
  dirs.push(dir);
  const file = path.join(dir, 'runtime.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Core 退出清理 runtime.json', () => {
  it('删除 pid 与当前进程一致的握手文件', () => {
    const file = tempFile({ pid: process.pid, port: 1, token: 'x' });
    removeOwnRuntimeFile(file, process.pid);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('不删除其它实例写的握手文件', () => {
    const file = tempFile({ pid: process.pid + 1, port: 2, token: 'y' });
    removeOwnRuntimeFile(file, process.pid);
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid + 1);
  });

  it('文件不存在或损坏时静默', () => {
    const file = tempFile({ pid: process.pid });
    writeFileSync(file, 'not json');
    expect(() => removeOwnRuntimeFile(file, process.pid)).not.toThrow();
    expect(() => removeOwnRuntimeFile(path.join(path.dirname(file), 'missing.json'), process.pid)).not.toThrow();
  });
});
