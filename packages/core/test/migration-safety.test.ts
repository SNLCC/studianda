import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/backup.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-migration-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('migration safety', () => {
  it('backs up an old database before upgrading and upgrades in a transaction', async () => {
    // 先建一个"当前版本"的库，再把版本号改回 17，模拟旧库升级。
    const first = new Store(dataDir);
    first.close();

    const raw = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
    raw.exec("UPDATE schema_meta SET value = '17' WHERE key = 'schema_version'");
    raw.close();

    const reopened = new Store(dataDir);
    try {
      const backupDir = path.join(dataDir, 'migration-backups');
      const files = readdirSync(backupDir).filter(
        (name) => name.startsWith('reader-before-v17-') && name.endsWith('.sqlite3')
      );
      expect(files.length).toBeGreaterThan(0);
      expect(statSync(path.join(backupDir, files[0]!)).size).toBeGreaterThan(0);

      const check = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
      try {
        const row = check
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as { value?: string } | undefined;
        expect(row?.value).toBe('19');
      } finally {
        check.close();
      }
    } finally {
      reopened.close();
    }
  });

  it('does not include migration backups in user backup archives', async () => {
    const store = new Store(dataDir);
    try {
      const result = await createSnapshot(store);
      expect(result.entries.some((entry) => entry.startsWith('migration-backups/'))).toBe(false);
    } finally {
      store.close();
    }
  });
});
