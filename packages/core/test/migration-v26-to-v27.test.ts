import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/backup.js';
import { Store } from '../src/store.js';

/**
 * schema_version **26 → 27** 旧库升级验证（直接跑真实 `Store` 构造函数里的 migrate）。
 *
 * 本次迁移只做一件事：清空历史遗留表 `platform_connections`（旧版本曾把平台 API Key 的
 * Windows DPAPI 密文写在 value 的 `encrypted_key` 字段里；当前代码零读零写）。
 *
 * 选择：**保留表结构、只 DELETE 所有行**，不 DROP。原因：
 * - 旧版本回滚后若还有查询该表的代码，DROP 会直接报 "no such table"，DELETE 只是读到 0 行；
 * - `scripts/verify-migration.mjs` 也把「迁移不能删表」作为约束，保留表更符合既有回滚假设。
 *
 * 夹具手工构造 v26 旧库（schema_meta + 带 3 条密文行的 platform_connections），其余表由
 * `SCHEMA_SQL` 在迁移事务里创建。断言覆盖：
 * - 迁移后主库可读到 0 行、表仍存在、版本升到 27；
 * - 迁移前的 v26 快照仍保留旧密文（这是已知残留：回滚需要它，且不随用户备份 zip 外流）；
 * - 用户备份 zip 里的数据库快照中该表为 0 行（备份已不含历史密文数据）；
 * - 重复启动幂等：版本/行数/快照数量不再变化。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-v26-v27-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const CIPHERTEXT_HEADER = 'AQAAANCM';

function createLegacyV26Database(dir: string): void {
  const db = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
  try {
    db.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE platform_connections(
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '26')").run();
    const insert = db.prepare('INSERT INTO platform_connections(id, value) VALUES (?, ?)');
    for (const id of ['conn-alpha', 'conn-beta', 'conn-gamma']) {
      insert.run(
        id,
        JSON.stringify({
          name: `平台 ${id}`,
          provider: 'openai',
          base_url: 'https://api.example.com/v1',
          models: ['model-a'],
          encrypted_key: `${CIPHERTEXT_HEADER}${'0'.repeat(64)}`
        })
      );
    }
  } finally {
    db.close();
  }
}

function readOnlyDb(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
    | { n?: number }
    | undefined;
  return Number(row?.n ?? 0);
}

function readVersion(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return row?.value ?? null;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function migrationBackups(dir: string): string[] {
  const folder = path.join(dir, 'migration-backups');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith('reader-before-v') && name.endsWith('.sqlite3'))
    .sort();
}

describe('schema_version 26 → 27 迁移：清空 platform_connections 历史密钥密文', () => {
  it('迁移后行数为 0，表保留，备份 zip 里的数据库快照也不再含旧行', async () => {
    const dir = mkdtempSync(path.join(root, 'v26-'));
    let store: Store | null = null;
    try {
      createLegacyV26Database(dir);

      // ---- 迁移前：夹具是 v26 形态，3 条 encrypted_key 密文 ----
      const beforeDb = readOnlyDb(path.join(dir, 'reader.sqlite3'));
      try {
        expect(readVersion(beforeDb)).toBe('26');
        expect(countRows(beforeDb, 'platform_connections')).toBe(3);
        const stored = beforeDb
          .prepare('SELECT value FROM platform_connections WHERE id = ?')
          .get('conn-alpha') as { value: string };
        expect(JSON.parse(stored.value).encrypted_key).toContain(CIPHERTEXT_HEADER);
      } finally {
        beforeDb.close();
      }

      // ---- 触发真实迁移 ----
      store = new Store(dir);

      // 迁移后：表仍在（回滚兼容），但读到 0 行；版本升到 27。
      const afterDb = readOnlyDb(path.join(dir, 'reader.sqlite3'));
      try {
        expect(readVersion(afterDb)).toBe('27');
        expect(tableExists(afterDb, 'platform_connections')).toBe(true);
        expect(countRows(afterDb, 'platform_connections')).toBe(0);
      } finally {
        afterDb.close();
      }

      // 迁移前快照仍含旧密文：这是回滚所需，且 migration-backups/ 不进用户备份 zip
      // （见 backup.ts 的 EXCLUDED_DIRS），属于已知残留而不是本次要抹掉的备份内容。
      const backups = migrationBackups(dir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^reader-before-v26-/);
      const snapshotDb = readOnlyDb(path.join(dir, 'migration-backups', backups[0]!));
      try {
        expect(readVersion(snapshotDb)).toBe('26');
        expect(countRows(snapshotDb, 'platform_connections')).toBe(3);
      } finally {
        snapshotDb.close();
      }

      // ---- 用户备份：数据库快照里 platform_connections 也是 0 行 ----
      const snapshot = await createSnapshot(store);
      const archive = unzipSync(new Uint8Array(readFileSync(snapshot.backup.path)));
      expect(archive['reader.sqlite3']).toBeTruthy();
      const extracted = path.join(root, 'backup-snapshot.sqlite3');
      writeFileSync(extracted, archive['reader.sqlite3']!);
      const backupDb = readOnlyDb(extracted);
      try {
        expect(readVersion(backupDb)).toBe('27');
        expect(countRows(backupDb, 'platform_connections')).toBe(0);
      } finally {
        backupDb.close();
      }
      expect(snapshot.entries).toContain('reader.sqlite3');
    } finally {
      try {
        store?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('重复启动幂等：版本保持 27、行数保持 0、不再生成新的迁移快照', () => {
    const dir = mkdtempSync(path.join(root, 'idempotent-'));
    let store: Store | null = null;
    try {
      createLegacyV26Database(dir);
      store = new Store(dir);
      store.close();
      store = null;
      const backupsAfterFirstMigration = migrationBackups(dir);

      for (let round = 0; round < 2; round += 1) {
        store = new Store(dir);
        const db = readOnlyDb(path.join(dir, 'reader.sqlite3'));
        try {
          expect(readVersion(db)).toBe('27');
          expect(countRows(db, 'platform_connections')).toBe(0);
        } finally {
          db.close();
        }
        store.close();
        store = null;
      }

      expect(migrationBackups(dir)).toEqual(backupsAfterFirstMigration);
    } finally {
      try {
        store?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
