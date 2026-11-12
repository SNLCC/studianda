import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-order-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function dbOf(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function manualOrders(store: Store): Array<{ id: string; folder_path: string; manual_order: number }> {
  return dbOf(store)
    .prepare('SELECT id, folder_path, manual_order FROM notes ORDER BY manual_order ASC, rowid ASC')
    .all() as unknown as Array<{ id: string; folder_path: string; manual_order: number }>;
}

describe('schema 18 → 19：notes.manual_order 迁移与回填', () => {
  it('旧库升级加列、按 rowid 递增回填，升级后顺序稳定且重开不变', () => {
    const dir = path.join(root, 'migrate-v18');
    mkdirSync(dir, { recursive: true });
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    raw.exec('CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT)');
    raw.exec("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '18')");
    raw.exec(
      `CREATE TABLE notes(
         id TEXT PRIMARY KEY,
         document_id TEXT,
         page INTEGER,
         quote TEXT,
         content TEXT,
         external_key TEXT DEFAULT '',
         folder_path TEXT DEFAULT '',
         tags TEXT DEFAULT '[]',
         created TEXT DEFAULT CURRENT_TIMESTAMP,
         deleted INTEGER DEFAULT 0
       )`
    );
    // 故意让 created 逆序：回填必须按 rowid 而不是 created。
    raw.exec(
      "INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path, tags, created) VALUES ('m1', '', 0, '', '第一', '', '', '[]', '2026-03-03')"
    );
    raw.exec(
      "INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path, tags, created) VALUES ('m2', '', 0, '', '第二', '', '', '[]', '2026-02-02')"
    );
    raw.exec(
      "INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path, tags, created) VALUES ('m3', '', 0, '', '第三', '', 'a', '[]', '2026-01-01')"
    );
    raw.close();

    const store = new Store(dir);
    try {
      const db = dbOf(store);
      const version = (
        db
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as { value?: string } | undefined
      )?.value;
      expect(version).toBe('19');
      const columns = (db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).toContain('manual_order');
      // 迁移后版本已写入，重开不再重复回填。
      const orders = manualOrders(store);
      expect(orders.map((row) => row.id)).toEqual(['m1', 'm2', 'm3']);
      expect(orders.map((row) => Number(row.manual_order))).toEqual([1, 2, 3]);
      expect(store.listStandaloneNotes().map((note) => note.id)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      store.close();
    }

    const reopened = new Store(dir);
    try {
      const db = dbOf(reopened);
      const version = (
        db
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as { value?: string } | undefined
      )?.value;
      expect(version).toBe('19');
      expect(reopened.listStandaloneNotes().map((note) => note.id)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      reopened.close();
    }
  });
});

describe('notes.manual_order：新建位置与 listStandaloneNotes 排序', () => {
  it('新建笔记取当前文件夹 MAX(manual_order)+1；按 folder_path/manual_order 升序返回', () => {
    const store = storeAt('order-create');
    try {
      const a = store.createNote({ documentId: '', page: 0, content: 'A' });
      const b = store.createNote({ documentId: '', page: 0, content: 'B' });
      const c = store.createNote({ documentId: '', page: 0, content: 'C' });
      const orders = manualOrders(store);
      expect(orders.map((row) => [row.id, Number(row.manual_order)])).toEqual([
        [a.id, 1],
        [b.id, 2],
        [c.id, 3]
      ]);
      expect(store.listStandaloneNotes().map((note) => note.id)).toEqual([a.id, b.id, c.id]);

      // 子文件夹独立计数：仍从 1 开始。
      const d = store.createNote({ documentId: '', page: 0, content: 'D', folderPath: 'sub' });
      const e = store.createNote({ documentId: '', page: 0, content: 'E', folderPath: 'sub' });
      expect(
        manualOrders(store)
          .filter((row) => row.folder_path === 'sub')
          .map((row) => [row.id, Number(row.manual_order)])
      ).toEqual([
        [d.id, 1],
        [e.id, 2]
      ]);
      // 文件夹整体按 folder_path 升序，文件夹内按 manual_order 升序。
      expect(store.listStandaloneNotes().map((note) => note.id)).toEqual([
        a.id,
        b.id,
        c.id,
        d.id,
        e.id
      ]);
    } finally {
      store.close();
    }
  });

  it('reorderStandaloneNotes 按 ids 顺序写 manual_order；跨文件夹不串扰、非法 id 忽略、重开持久化', () => {
    const dir = path.join(root, 'order-reorder');
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    const ids: string[] = [];
    let otherFolderId = '';
    try {
      for (const content of ['一', '二', '三', '四']) {
        ids.push(store.createNote({ documentId: '', page: 0, content }).id);
      }
      const otherFolder = store.createNote({ documentId: '', page: 0, content: '其它', folderPath: 'x' });
      otherFolderId = otherFolder.id;
      const reordered = store.reorderStandaloneNotes('', [
        ids[2]!,
        ids[0]!,
        otherFolder.id,
        'missing-note',
        ids[3]!,
        ids[1]!
      ]);
      expect(reordered.ok).toBe(true);
      // 只处理属于根目录的 id；返回其目标顺序。
      expect(reordered.notes.map((note) => note.id)).toEqual([
        ids[2]!,
        ids[0]!,
        ids[3]!,
        ids[1]!
      ]);
      expect(reordered.notes.every((note) => note.folderPath === '')).toBe(true);
      expect(store.listStandaloneNotes().map((note) => note.id)).toEqual([
        ids[2]!,
        ids[0]!,
        ids[3]!,
        ids[1]!,
        otherFolder.id
      ]);
      // 其它文件夹内的笔记位置不变。
      const otherRow = dbOf(store)
        .prepare('SELECT manual_order FROM notes WHERE id = ?')
        .get(otherFolder.id) as { manual_order?: number } | undefined;
      expect(Number(otherRow?.manual_order ?? 0)).toBe(1);
    } finally {
      store.close();
    }

    const reopened = new Store(dir);
    try {
      expect(reopened.listStandaloneNotes().map((note) => note.id)).toEqual([
        ids[2]!,
        ids[0]!,
        ids[3]!,
        ids[1]!,
        otherFolderId
      ]);
    } finally {
      reopened.close();
    }
  });
});
