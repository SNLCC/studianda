import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * 独占锁与启动完整性门禁：
 * - 应用运行期间，第二个 SQLite 连接读/写数据库应当失败（而不是静默并发写）；
 * - 正常关闭写 `clean_shutdown=1`，非正常关闭后下次启动会跑 `quick_check` 并记录结果。
 */
describe('Store 独占锁与启动完整性门禁', () => {
  const dirs: string[] = [];

  const makeDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studianda-lock-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 上偶发占用，忽略
      }
    }
  });

  it('运行期间第二个连接无法读库，关闭后可正常打开', () => {
    const dir = makeDir();
    const store = new Store(dir, { exclusiveLock: true });
    const dbPath = path.join(dir, 'reader.sqlite3');

    const second = new DatabaseSync(dbPath);
    expect(() => second.prepare('SELECT COUNT(*) AS n FROM documents').get()).toThrow(
      /locked/i
    );
    second.close();

    store.close();

    const reopened = new DatabaseSync(dbPath);
    expect(() => reopened.prepare('SELECT COUNT(*) AS n FROM documents').get()).not.toThrow();
    reopened.close();
  });

  it('正常关闭写入 clean_shutdown=1；下次启动标记回 0', () => {
    const dir = makeDir();
    const dbPath = path.join(dir, 'reader.sqlite3');
    const store = new Store(dir);
    expect(store.integrityOnStartup()).toBeNull();
    store.close();

    const raw = new DatabaseSync(dbPath);
    const row = raw
      .prepare("SELECT value FROM schema_meta WHERE key = 'clean_shutdown'")
      .get() as { value?: string } | undefined;
    expect(row?.value).toBe('1');
    raw.close();

    const next = new Store(dir);
    expect(next.integrityOnStartup()).toBeNull();
    next.close();
  });

  it('上次非正常关闭时，启动会跑 quick_check 并记录 ok', () => {
    const dir = makeDir();
    const dbPath = path.join(dir, 'reader.sqlite3');
    const store = new Store(dir);
    store.close();

    // 模拟崩溃/强杀：正常关闭标记被留在 0。
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'clean_shutdown'").run();
    raw.close();

    const next = new Store(dir);
    expect(next.integrityOnStartup()).toBe('ok');
    next.close();
  });

  it('运行期看门狗能检出外部截断（空闲期文件变化）', () => {
    const dir = makeDir();
    const dbPath = path.join(dir, 'reader.sqlite3');
    const store = new Store(dir, { exclusiveLock: true });

    // 独占锁挡不住裸写文件：模拟被外部进程截断。
    writeFileSync(dbPath, 'x');
    const result = store.checkIntegrityNow();
    // quick_check 可能因连接缓存仍返回 ok；文件在空闲期变化本身已足够标记篡改可疑。
    expect(result.length).toBeGreaterThan(0);
    expect(store.integrityStatus().tamperSuspected).toBe(true);
    store.close();
  });
});
