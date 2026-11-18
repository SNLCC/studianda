import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * schema_version **21 → 当前版本（24）** 旧库升级验证（直接跑真实 `Store` 构造函数里的 migrate）。
 *
 * 本夹具重点是 22 新增的逻辑项目两张基线表（后续 23 的语料会话表由 migration-v22-to-v23.test.ts
 * 单独覆盖；这里只断言一路升到当前版本且旧行不变）：
 * - `projects(id, name, description, archived_at, created_at, updated_at)` + `projects_name_unique`
 *   （NOCASE 唯一索引，名称大小写不敏感唯一）；
 * - `project_documents(project_id, document_id, added_at)`（主键联合唯一）+ `project_documents_document`。
 *
 * 夹具用 node:sqlite 手工构造 v21 旧库（documents/notes/annotations 是 v21 真实形态，notes/annotations
 * 已含 21 新增的 origin 列，但没有 22 的项目表），塞入固定数据后关库，再交给 `new Store(dir)` 触发真实迁移。
 * 断言覆盖：补建两表/索引、版本升到当前版本、旧行逐字不变、迁移前快照存在且是 v21、重复迁移幂等、
 * 迁移后项目接口可正常读写且大小写重名被拒。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-v21-v22-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DOC_ID = 'doc-v21';
const NOTE_ID = 'note-v21-ai';
const ANNOTATION_ID = 'ann-v21';

const DOCUMENT_COLUMNS =
  'id, name, pages, current_page, created, deleted, storage_kind, external_path, external_key, ' +
  'file_stamp, tags, author, publication, doi, title_key, sha256, size_bytes, path, doc_type, ' +
  'folder_id, manual_order';
const NOTE_COLUMNS =
  'id, document_id, page, quote, content, external_key, folder_path, tags, created, deleted, ' +
  'manual_order, origin';
const ANNOTATION_COLUMNS =
  'id, document_id, page, quote, content, rects, color, deleted, style, translation_excerpt, ' +
  'external_key, created, origin';

type Row = Record<string, unknown>;

/** 手工构造 v21 旧库：只有与本次迁移相关的表；其余基线表由 SCHEMA_SQL 补建。 */
function createLegacyV21Database(dir: string): void {
  const db = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
  try {
    db.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE documents(
        id TEXT PRIMARY KEY,
        name TEXT,
        pages INTEGER,
        current_page INTEGER DEFAULT 1,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted INTEGER DEFAULT 0,
        storage_kind TEXT DEFAULT 'copy',
        external_path TEXT DEFAULT '',
        external_key TEXT DEFAULT '',
        file_stamp TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        author TEXT DEFAULT '',
        publication TEXT DEFAULT '',
        doi TEXT DEFAULT '',
        title_key TEXT DEFAULT '',
        sha256 TEXT DEFAULT '',
        size_bytes INTEGER DEFAULT 0,
        path TEXT DEFAULT '',
        doc_type TEXT DEFAULT '',
        folder_id TEXT DEFAULT '',
        manual_order REAL DEFAULT 0
      );

      -- v21 的 notes/annotations 已经带 origin（20→21 迁移结果）。
      CREATE TABLE notes(
        id TEXT PRIMARY KEY,
        document_id TEXT,
        page INTEGER,
        quote TEXT,
        content TEXT,
        external_key TEXT DEFAULT '',
        folder_path TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted INTEGER DEFAULT 0,
        manual_order REAL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'user'
      );

      CREATE TABLE annotations(
        id TEXT PRIMARY KEY,
        document_id TEXT,
        page INTEGER,
        quote TEXT,
        content TEXT,
        rects TEXT,
        color TEXT,
        deleted INTEGER DEFAULT 0,
        style TEXT DEFAULT 'highlight',
        translation_excerpt TEXT DEFAULT '',
        external_key TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        origin TEXT NOT NULL DEFAULT 'user'
      );
    `);

    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '21')").run();

    db.prepare(
      `INSERT INTO documents(
         id, name, pages, current_page, created, deleted, storage_kind, external_path,
         external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
         size_bytes, path, doc_type, folder_id, manual_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      DOC_ID,
      'v21-老文献.pdf',
      3,
      2,
      '2026-02-01T00:00:00.000Z',
      0,
      'copy',
      '',
      '',
      'stamp-v21',
      '["旧库"]',
      '旧作者',
      '旧期刊',
      '10.1000/v21',
      'v21oldpdf',
      'sha256-v21',
      2048,
      'papers/v21.pdf',
      'journalArticle',
      '',
      5
    );

    db.prepare(
      `INSERT INTO notes(
         id, document_id, page, quote, content, external_key, folder_path, tags, created,
         deleted, manual_order, origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      NOTE_ID,
      DOC_ID,
      1,
      '旧原文摘录',
      'v21 的 AI 笔记正文',
      'ext-note-v21',
      '阅读笔记/旧库',
      '["旧库"]',
      '2026-02-02T00:00:00.000Z',
      0,
      6,
      'ai'
    );

    db.prepare(
      `INSERT INTO annotations(
         id, document_id, page, quote, content, rects, color, deleted, style,
         translation_excerpt, external_key, created, origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ANNOTATION_ID,
      DOC_ID,
      2,
      '旧批注原文',
      'v21 的 AI 批注内容',
      '[{"x":1}]',
      'yellow',
      0,
      'highlight',
      '',
      'ext-ann-v21',
      '2026-02-03T00:00:00.000Z',
      'ai'
    );
  } finally {
    db.close();
  }
}

function readOnlyDb(dir: string): DatabaseSync {
  return new DatabaseSync(path.join(dir, 'reader.sqlite3'), { readOnly: true });
}

function schemaObjectNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all() as unknown as Array<{ type: string; name: string }>;
  return rows.map((row) => `${row.type}:${row.name}`);
}

function tableColumns(
  db: DatabaseSync,
  table: string
): Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function selectRows(db: DatabaseSync, table: string, columns: string): Row[] {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all() as unknown as Row[];
}

function readVersion(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return row?.value ?? null;
}

function readRows(dir: string): { documents: Row[]; notes: Row[]; annotations: Row[] } {
  const db = readOnlyDb(dir);
  try {
    return {
      documents: selectRows(db, 'documents', DOCUMENT_COLUMNS),
      notes: selectRows(db, 'notes', NOTE_COLUMNS),
      annotations: selectRows(db, 'annotations', ANNOTATION_COLUMNS)
    };
  } finally {
    db.close();
  }
}

function migrationBackups(dir: string): string[] {
  const folder = path.join(dir, 'migration-backups');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith('reader-before-v') && name.endsWith('.sqlite3'))
    .sort();
}

describe('schema_version 21 → 24 迁移', () => {
  it('补建项目两表/索引，版本升到 22，旧行逐字不变，快照为 v21，重复迁移幂等', () => {
    const dir = mkdtempSync(path.join(root, 'v21-'));
    let store: Store | null = null;
    try {
      createLegacyV21Database(dir);

      // ---- 迁移前：确认夹具是 v21 形态（没有项目表） ----
      const beforeDb = readOnlyDb(dir);
      let beforeVersion = '';
      let beforeObjects: string[] = [];
      try {
        beforeVersion = readVersion(beforeDb) ?? '';
        beforeObjects = schemaObjectNames(beforeDb);
        expect(beforeVersion).toBe('21');
        expect(tableExists(beforeDb, 'projects')).toBe(false);
        expect(tableExists(beforeDb, 'project_documents')).toBe(false);
      } finally {
        beforeDb.close();
      }
      const beforeRows = readRows(dir);
      expect(beforeRows.documents).toHaveLength(1);
      expect(beforeRows.notes).toHaveLength(1);
      expect(beforeRows.annotations).toHaveLength(1);

      // ---- 触发真实迁移 ----
      store = new Store(dir);
      const active = store;

      // 迁移后读路径仍能读到老数据，origin 原样保留（'ai'）。
      expect(active.listDocuments().map((row) => row.id)).toContain(DOC_ID);
      expect(active.listNotes(DOC_ID)[0]).toMatchObject({ id: NOTE_ID, origin: 'ai' });
      expect(active.listAnnotations(DOC_ID)[0]).toMatchObject({ id: ANNOTATION_ID, origin: 'ai' });

      // 迁移后的新表可直接使用：新建项目、加入文献。
      const project = active.createProject({ name: 'v21 迁移后的项目', description: '迁移验证' });
      expect(project.documentCount).toBe(0);
      active.addProjectDocument(project.id, DOC_ID);
      expect(active.listProjectDocuments(project.id).map((row) => row.id)).toEqual([DOC_ID]);
      expect(active.getProject(project.id)?.documentCount).toBe(1);
      // 大小写不敏感唯一：老库升级后同样生效。
      expect(() => active.createProject({ name: 'V21 迁移后的项目' })).toThrow(
        '已存在同名项目：V21 迁移后的项目'
      );

      active.close();
      store = null;

      // ---- 迁移后：版本、项目表结构、索引、外键 ----
      const afterDb = readOnlyDb(dir);
      let afterVersion = '';
      let afterObjects: string[] = [];
      try {
        afterVersion = readVersion(afterDb) ?? '';
        afterObjects = schemaObjectNames(afterDb);
        expect(afterVersion).toBe('24');
        expect(tableExists(afterDb, 'projects')).toBe(true);
        expect(tableExists(afterDb, 'project_documents')).toBe(true);
        expect(afterObjects).toEqual(
          expect.arrayContaining([
            'table:projects',
            'table:project_documents',
            'index:projects_name_unique',
            'index:project_documents_document'
          ])
        );

        const projectColumns = tableColumns(afterDb, 'projects');
        expect(projectColumns.map((column) => column.name)).toEqual([
          'id',
          'name',
          'description',
          'archived_at',
          'created_at',
          'updated_at'
        ]);
        expect(projectColumns.find((column) => column.name === 'name')).toMatchObject({
          type: 'TEXT',
          notnull: 1
        });
        expect(projectColumns.find((column) => column.name === 'archived_at')).toMatchObject({
          type: 'TEXT',
          notnull: 1,
          dflt_value: "''"
        });

        const linkColumns = tableColumns(afterDb, 'project_documents');
        expect(linkColumns.map((column) => column.name)).toEqual([
          'project_id',
          'document_id',
          'added_at'
        ]);
        // 主键是 (project_id, document_id) 联合唯一。
        expect(linkColumns.find((column) => column.name === 'project_id')?.pk).toBe(1);
        expect(linkColumns.find((column) => column.name === 'document_id')?.pk).toBe(2);

        // 外键：PRAGMA foreign_keys=ON（Store 已开启），删文献/删项目级联清链接。
        const foreignKeys = afterDb
          .prepare('PRAGMA foreign_key_list(project_documents)')
          .all() as unknown as Array<{ table: string; from: string; on_delete: string }>;
        expect(foreignKeys.map((fk) => `${fk.table}:${fk.from}:${fk.on_delete}`).sort()).toEqual([
          'documents:document_id:CASCADE',
          'projects:project_id:CASCADE'
        ]);
      } finally {
        afterDb.close();
      }

      // ---- 迁移后：旧行逐字不变（含 origin） ----
      const afterRows = readRows(dir);
      expect(afterRows.documents).toEqual(beforeRows.documents);
      expect(afterRows.notes).toEqual(beforeRows.notes);
      expect(afterRows.annotations).toEqual(beforeRows.annotations);
      expect(afterRows.notes[0]?.content).toBe('v21 的 AI 笔记正文');
      expect(afterRows.notes[0]?.origin).toBe('ai');

      // ---- 迁移前快照：存在且是 v21（不含新表），证明可回滚 ----
      const backups = migrationBackups(dir);
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0]).toMatch(/reader-before-v21-/);
      const backupDb = new DatabaseSync(path.join(dir, 'migration-backups', backups[0]!), {
        readOnly: true
      });
      try {
        expect(readVersion(backupDb)).toBe('21');
        expect(tableExists(backupDb, 'projects')).toBe(false);
      } finally {
        backupDb.close();
      }

      // ---- 幂等：连续再打开两次，版本不变、schema 不变、不再产生新备份 ----
      const backupsAfterFirstMigration = migrationBackups(dir);
      for (let round = 0; round < 2; round += 1) {
        const reopened = new Store(dir);
        try {
          expect(reopened.listDocuments().map((row) => row.id)).toContain(DOC_ID);
        } finally {
          reopened.close();
        }
      }
      const afterReopenDb = readOnlyDb(dir);
      try {
        expect(readVersion(afterReopenDb)).toBe('24');
        expect(schemaObjectNames(afterReopenDb)).toEqual(afterObjects);
      } finally {
        afterReopenDb.close();
      }
      expect(migrationBackups(dir)).toEqual(backupsAfterFirstMigration);
      // 迁移前的旧版本号（21）只出现在备份名里，不再影响库内版本。
      expect(beforeVersion).toBe('21');
      expect(beforeObjects).not.toContain('table:projects');
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
