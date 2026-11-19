import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATION_BACKUP_KEEP, Store } from '../src/store.js';

/**
 * 迁移快照（`migration-backups/reader-before-v<旧版本>-<时间戳>.sqlite3`）保留策略测试。
 *
 * 覆盖：
 * - 5 份历史快照 + 一次升级 → 迁移成功后只剩 N 份（N 从 store.ts 常量读取），
 *   且**本次刚生成的那份一定保留**（断言它能打开且 schema_version 是升级前版本）；
 * - 迁移失败 → 不做清理，历史快照一份不少（失败时快照是唯一救命稻草）；
 * - 目录里不符合命名规则的用户文件、以及 `backups/`（用户主动备份）完全不受影响；
 * - 已经在当前版本的库启动时，也会把超过上限的旧快照裁剪到 N 份。
 *
 * 夹具：先建一个当前版本的真实库（构造完整 schema），再把 schema_version 改回 25，
 * 用 `new Store(dir)` 触发真实 migrate()；历史快照是直接写入的占位文件（清理只看文件名，
 * 不读内容；只有本次新生成的快照会做可打开性断言）。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-retention-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 5 份历史快照：故意混用版本号，验证「最近」按名字里的时间戳排序而不是按版本号字符串。 */
const HISTORY_SNAPSHOTS = [
  'reader-before-v17-2025-01-01T00-00-00-000Z.sqlite3',
  'reader-before-v20-2025-06-01T00-00-00-000Z.sqlite3',
  'reader-before-v24-2025-09-01T00-00-00-000Z.sqlite3',
  'reader-before-v24-2025-10-01T00-00-00-000Z.sqlite3',
  'reader-before-v25-2025-11-01T00-00-00-000Z.sqlite3'
];

/** 不符合 `reader-before-v<数字>-*.sqlite3` 的用户文件：保留策略必须一个都不碰。 */
const USER_FILES_IN_BACKUP_DIR = [
  'README.md',
  // 版本号不是数字。
  'reader-before-vX-2025-01-01T00-00-00-000Z.sqlite3',
  // 缺时间戳（后缀不能为空）。
  'reader-before-v24-.sqlite3',
  // 不以 .sqlite3 结尾。
  'reader-before-v24-2025-01-01.sqlite3.bak',
  'manual-backup.sqlite3'
];

const USER_BACKUP_FILES = [
  'studianda-data-2026-01-01-000000.zip',
  // 即使命名像是迁移快照，也不在 migration-backups/ 里，绝不能被清理逻辑扫到。
  'reader-before-v24-2025-01-01T00-00-00-000Z.sqlite3'
];

/** 与自动命名规则一致的模式（迁移快照保留策略的唯一识别依据）。 */
const SNAPSHOT_NAME = /^reader-before-v\d+-.+\.sqlite3$/;

function newDataDir(label: string): string {
  return mkdtempSync(path.join(root, `${label}-`));
}

function listSnapshots(dir: string): string[] {
  const folder = path.join(dir, 'migration-backups');
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SNAPSHOT_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readSchemaVersion(file: string): string | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/** 先建当前版本的真实库，再把版本号改回 25，模拟「下次启动需要升级」。 */
function createDowngradedDatabase(dir: string): void {
  const store = new Store(dir);
  store.close();
  const db = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
  try {
    db.exec("UPDATE schema_meta SET value = '25' WHERE key = 'schema_version'");
  } finally {
    db.close();
  }
}

/** 写入 5 份历史快照 + 若干不符合命名的用户文件（含一个命名像快照的目录）。 */
function seedBackupFolder(dir: string): void {
  const folder = path.join(dir, 'migration-backups');
  mkdirSync(folder, { recursive: true });
  for (const name of HISTORY_SNAPSHOTS) writeFileSync(path.join(folder, name), 'old snapshot');
  for (const name of USER_FILES_IN_BACKUP_DIR) {
    writeFileSync(path.join(folder, name), 'user file');
  }
  // 同名模式但是目录：保留策略只清理文件，不递归删用户目录。
  mkdirSync(path.join(folder, 'reader-before-v24-a-directory.sqlite3'), { recursive: true });
}

/** 用户主动创建的 backups/：本次改动绝不能动它。 */
function seedUserBackups(dir: string): string {
  const folder = path.join(dir, 'backups');
  mkdirSync(folder, { recursive: true });
  for (const name of USER_BACKUP_FILES) writeFileSync(path.join(folder, name), 'user backup');
  return folder;
}

function expectUserFilesUntouched(dir: string, userBackups: string): void {
  const folder = path.join(dir, 'migration-backups');
  for (const name of USER_FILES_IN_BACKUP_DIR) {
    expect(existsSync(path.join(folder, name)), `用户文件被删了：${name}`).toBe(true);
  }
  expect(
    existsSync(path.join(folder, 'reader-before-v24-a-directory.sqlite3')),
    '命名像快照的用户目录被删了'
  ).toBe(true);
  expect(readdirSync(userBackups).sort()).toEqual([...USER_BACKUP_FILES].sort());
}

describe('迁移快照保留策略', () => {
  it('5 份历史快照 + 一次升级后只剩 N 份，且本次新生成的快照被保留', () => {
    const dir = newDataDir('success');
    try {
      createDowngradedDatabase(dir);
      seedBackupFolder(dir);
      const userBackups = seedUserBackups(dir);
      const before = listSnapshots(dir);
      expect(before).toEqual([...HISTORY_SNAPSHOTS].sort());

      const store = new Store(dir); // 触发真实 25 → 27 迁移
      try {
        expect(store).toBeTruthy();
      } finally {
        store.close();
      }

      const after = listSnapshots(dir);
      expect(after).toHaveLength(MIGRATION_BACKUP_KEEP);
      // 本次升级新生成的快照：不在迁移前清单里，且版本号是升级前版本（25）。
      const created = after.filter((name) => !before.includes(name));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^reader-before-v25-/);
      // 保留的是「本次 + 最近两份历史」：2025-11-01 与 2025-10-01。
      expect(after).toEqual(
        [HISTORY_SNAPSHOTS[3]!, HISTORY_SNAPSHOTS[4]!, created[0]!].sort()
      );
      // 被删的只能是更早的自动快照，且本次快照确实是升级前版本的可回滚快照。
      expect(after).not.toContain(HISTORY_SNAPSHOTS[0]);
      expect(after).not.toContain(HISTORY_SNAPSHOTS[1]);
      expect(after).not.toContain(HISTORY_SNAPSHOTS[2]);
      expect(readSchemaVersion(path.join(dir, 'migration-backups', created[0]!))).toBe('25');

      expect(readSchemaVersion(path.join(dir, 'reader.sqlite3'))).toBe('27');
      expectUserFilesUntouched(dir, userBackups);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('迁移失败时不做清理：历史快照一份不少，本次尝试的快照也保留', () => {
    const dir = newDataDir('failure');
    try {
      createDowngradedDatabase(dir);
      // 让迁移在事务最后写 schema_version 时失败：此时迁移前快照已生成，事务会回滚。
      const db = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
      try {
        db.exec(
          "CREATE TRIGGER force_migration_failure BEFORE INSERT ON schema_meta " +
            "BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END"
        );
      } finally {
        db.close();
      }
      seedBackupFolder(dir);
      const userBackups = seedUserBackups(dir);

      expect(() => new Store(dir)).toThrow(/forced migration failure/);

      const after = listSnapshots(dir);
      // 清理没有执行：若误执行会裁到 N 份，这里必须保留全部 5 份历史。
      for (const name of HISTORY_SNAPSHOTS) expect(after).toContain(name);
      // 迁移前生成的本次快照也保留（失败时它是唯一救命稻草）。
      expect(after).toHaveLength(HISTORY_SNAPSHOTS.length + 1);
      const created = after.filter((name) => !HISTORY_SNAPSHOTS.includes(name));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^reader-before-v25-/);
      expect(readSchemaVersion(path.join(dir, 'migration-backups', created[0]!))).toBe('25');

      // 迁移失败：库版本保持升级前，事务已回滚。
      expect(readSchemaVersion(path.join(dir, 'reader.sqlite3'))).toBe('25');
      expectUserFilesUntouched(dir, userBackups);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已在当前版本启动（不产生新快照）时，也会把超过上限的旧快照裁剪到 N 份', () => {
    const dir = newDataDir('already-current');
    try {
      const first = new Store(dir);
      first.close();
      seedBackupFolder(dir);
      const userBackups = seedUserBackups(dir);

      const reopened = new Store(dir); // 当前版本：不迁移、不生成新快照，只清理历史
      reopened.close();

      const after = listSnapshots(dir);
      expect(after).toHaveLength(MIGRATION_BACKUP_KEEP);
      expect(after).toEqual(
        [HISTORY_SNAPSHOTS[2]!, HISTORY_SNAPSHOTS[3]!, HISTORY_SNAPSHOTS[4]!].sort()
      );
      expectUserFilesUntouched(dir, userBackups);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
