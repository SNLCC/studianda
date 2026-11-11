import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * 跨进程单实例锁（SQLite 文件锁）：
 * - 同一数据目录同时只允许一个 Store/Core 打开；
 * - 正常 close 释放锁（锁库文件保留，但不再持有 OS 锁）；
 * - 崩溃/强杀后 OS 自动释放锁，下次启动无需按 PID 清理；
 * - 遗留的空锁库文件不会阻止启动。
 */
describe('数据目录单实例锁', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-instance-lock-'));
  const lockFile = path.join(dataDir, '.instance-lock.sqlite3');
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('第二个 Store 打开同一数据目录会被拒绝；close 后可再打开', () => {
    const first = new Store(dataDir);
    try {
      expect(() => new Store(dataDir)).toThrow(/正在被另一个 Studianda 进程使用/);
    } finally {
      first.close();
    }
    // 锁库文件保留（空库），但锁已释放；下次启动继续用同一个文件加锁。
    expect(existsSync(lockFile)).toBe(true);

    const reopened = new Store(dataDir);
    try {
      expect(reopened.getSettings()).toBeTypeOf('object');
    } finally {
      reopened.close();
    }
  });

  it('遗留的空锁库文件（上次崩溃）不会阻止启动', () => {
    writeFileSync(lockFile, '');
    const store = new Store(dataDir);
    try {
      expect(store.getSettings()).toBeTypeOf('object');
    } finally {
      store.close();
    }
  });
});
