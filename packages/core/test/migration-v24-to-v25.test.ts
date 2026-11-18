import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * schema_version **24 → 25** 旧库升级验证（直接跑真实 `Store` 构造函数里的 migrate）。
 *
 * 本轮迁移只给 `corpus_sessions` 加两列（不重建表、不动既有行）：
 * - `source_project_id TEXT`（可空）：用 projectId 建会话时的来源项目 id。**不建外键**，
 *   项目被删除后允许悬空，避免删项目时连带删掉会话；
 * - `source_project_name TEXT`（可空）：建会话那一刻的项目名快照，项目改名/删除后仍能显示当时名字。
 *
 * 夹具用 node:sqlite 手工构造 v24 旧库（documents/messages/document_chat_sessions/触发器/
 * projects/project_documents/corpus_sessions/corpus_session_documents 都是 v24 真实形态，
 * corpus_sessions **没有**来源项目两列），塞入固定数据后关库，再交给 `new Store(dir)` 触发真实迁移。
 * 断言覆盖：补两列且可空、版本升到 26、旧会话逐字不变且新列为 NULL、迁移前快照是 v24、
 * 重复迁移幂等、迁移后来源项目快照落库（项目改名/删除后不变）以及不用项目建会话时为 NULL。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-v24-v25-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DOC_ID = 'doc-v24';
const SESSION_ID = 'session-v24';
const CORPUS_SESSION_ID = 'corpus-v24';
const PROJECT_ID = 'project-v24';

const DOCUMENT_COLUMNS =
  'id, name, pages, current_page, created, deleted, storage_kind, external_path, external_key, ' +
  'file_stamp, tags, author, publication, doi, title_key, sha256, size_bytes, path, doc_type, ' +
  'folder_id, manual_order';
const CORPUS_SESSION_COLUMNS_V24 = 'id, title, created_at, updated_at, archived_at';

type Row = Record<string, unknown>;

/** 手工构造 v24 旧库：与本次迁移相关的表 + v24 的触发器/索引/项目表。 */
function createLegacyV24Database(dir: string): void {
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

      -- v24 的 messages 已含 scope_kind/audit_summary（23→24 迁移产物）。
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,
        document_id TEXT,
        role TEXT,
        content TEXT,
        sources TEXT,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}',
        session_id TEXT DEFAULT 'legacy',
        scope_kind TEXT NOT NULL DEFAULT 'document',
        audit_summary TEXT
      );

      CREATE TABLE document_chat_sessions(
        document_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        updated TEXT DEFAULT CURRENT_TIMESTAMP,
        context_summary TEXT DEFAULT '',
        summary_upto INTEGER DEFAULT 0,
        transcript_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(document_id, id)
      );
      CREATE INDEX document_chat_sessions_document
        ON document_chat_sessions(document_id, updated);
      CREATE INDEX messages_session ON messages(document_id, session_id, id);

      CREATE TRIGGER document_chat_transcript_ai
        AFTER INSERT ON messages BEGIN
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = NEW.document_id AND id = NEW.session_id;
        END;
      CREATE TRIGGER document_chat_transcript_au
        AFTER UPDATE ON messages BEGIN
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = NEW.document_id AND id = NEW.session_id;
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = OLD.document_id AND id = OLD.session_id;
        END;
      CREATE TRIGGER document_chat_transcript_ad
        AFTER DELETE ON messages BEGIN
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = OLD.document_id AND id = OLD.session_id;
        END;

      -- v22 起的逻辑项目表与项目-文献链接（v24 真实形态，本迁移不碰）。
      CREATE TABLE projects(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        archived_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX projects_name_unique ON projects(name COLLATE NOCASE);
      CREATE TABLE project_documents(
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(project_id, document_id)
      );
      CREATE INDEX project_documents_document ON project_documents(document_id);

      -- v24 的 corpus_sessions：只有五列，**没有** source_project_id/source_project_name。
      CREATE TABLE corpus_sessions(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        archived_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX corpus_sessions_updated ON corpus_sessions(updated_at);

      CREATE TABLE corpus_session_documents(
        session_id TEXT NOT NULL REFERENCES corpus_sessions(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        PRIMARY KEY(session_id, document_id)
      );
      CREATE INDEX corpus_session_documents_document
        ON corpus_session_documents(document_id);
    `);

    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '24')").run();

    db.prepare(
      `INSERT INTO documents(
         id, name, pages, current_page, created, deleted, storage_kind, external_path,
         external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
         size_bytes, path, doc_type, folder_id, manual_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      DOC_ID,
      'v24-老文献.pdf',
      3,
      1,
      '2026-05-01T00:00:00.000Z',
      0,
      'copy',
      '',
      '',
      'stamp-v24',
      '["老库"]',
      '老作者',
      '老期刊',
      '10.1000/v24',
      'v24oldpdf',
      'sha256-v24',
      2048,
      'papers/v24.pdf',
      'journalArticle',
      '',
      1
    );

    // v24 已有的项目与会话（会话没有来源项目两列；迁移不能动它们）。
    db.prepare(
      `INSERT INTO projects(id, name, description, archived_at, created_at, updated_at)
       VALUES (?, ?, '', '', ?, ?)`
    ).run(PROJECT_ID, 'v24 老项目', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');

    db.prepare(
      'INSERT INTO corpus_sessions(id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      CORPUS_SESSION_ID,
      'v24 老跨篇会话',
      '2026-05-02T00:00:00.000Z',
      '2026-05-02T00:00:00.000Z',
      ''
    );
    db.prepare(
      'INSERT INTO corpus_session_documents(session_id, document_id) VALUES (?, ?)'
    ).run(CORPUS_SESSION_ID, DOC_ID);

    // 单篇阅读会话只用于确认迁移后旧触发器/旧表仍可用。
    db.prepare(
      `INSERT INTO document_chat_sessions(
         document_id, id, title, created, updated, context_summary, summary_upto, transcript_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      DOC_ID,
      SESSION_ID,
      'v24 老阅读会话',
      '2026-05-02T00:00:00.000Z',
      '2026-05-02T00:00:00.000Z',
      '',
      0,
      0
    );
    db.prepare(
      `INSERT INTO messages(id, document_id, role, content, sources, created, metadata, session_id, scope_kind, audit_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(1, DOC_ID, 'user', 'v24 老消息', '[]', '2026-05-02T00:00:00.000Z', '{}', SESSION_ID, 'document', null);
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

function selectRows(db: DatabaseSync, table: string, columns: string): Row[] {
  return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all() as unknown as Row[];
}

function readVersion(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return row?.value ?? null;
}

function migrationBackups(dir: string): string[] {
  const folder = path.join(dir, 'migration-backups');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith('reader-before-v') && name.endsWith('.sqlite3'))
    .sort();
}

describe('schema_version 24 → 25 迁移', () => {
  it('corpus_sessions 加来源项目两列，版本升到 26，来源快照可落库且项目改名/删除后不变', () => {
    const dir = mkdtempSync(path.join(root, 'v24-'));
    let store: Store | null = null;
    try {
      createLegacyV24Database(dir);

      // ---- 迁移前：确认夹具是 v24 形态（corpus_sessions 没有本次新增两列） ----
      const beforeDb = readOnlyDb(dir);
      let beforeVersion = '';
      let beforeCorpusColumns: string[] = [];
      let beforeCorpusRows: Row[] = [];
      try {
        beforeVersion = readVersion(beforeDb) ?? '';
        beforeCorpusColumns = tableColumns(beforeDb, 'corpus_sessions').map(
          (column) => column.name
        );
        beforeCorpusRows = selectRows(beforeDb, 'corpus_sessions', CORPUS_SESSION_COLUMNS_V24);
        expect(beforeVersion).toBe('24');
        expect(beforeCorpusColumns).toEqual([
          'id',
          'title',
          'created_at',
          'updated_at',
          'archived_at'
        ]);
        expect(beforeCorpusColumns).not.toContain('source_project_id');
        expect(beforeCorpusColumns).not.toContain('source_project_name');
        expect(beforeCorpusRows).toHaveLength(1);
      } finally {
        beforeDb.close();
      }

      // ---- 触发真实迁移 ----
      store = new Store(dir);

      // 旧数据仍可读：v24 的老跨篇会话原样保留，来源项目两列为 NULL。
      expect(store.listDocuments().map((row) => row.id)).toContain(DOC_ID);
      expect(store.listMessages(DOC_ID, { sessionId: SESSION_ID }).map((row) => row.content)).toEqual([
        'v24 老消息'
      ]);
      expect(store.getCorpusSession(CORPUS_SESSION_ID)).toMatchObject({
        id: CORPUS_SESSION_ID,
        title: 'v24 老跨篇会话',
        documentIds: [DOC_ID],
        sourceProjectId: null,
        sourceProjectName: null
      });
      expect(store.listCorpusSessionMessages(CORPUS_SESSION_ID)).toEqual([]);

      // ---- 迁移后：版本、两列结构 ----
      store.close();
      store = null;
      const afterDb = readOnlyDb(dir);
      let afterObjects: string[] = [];
      try {
        expect(readVersion(afterDb)).toBe('26');
        afterObjects = schemaObjectNames(afterDb);
        // 只加列不重建表：v24 已有的项目/语料会话两表与索引仍在。
        expect(afterObjects).toEqual(
          expect.arrayContaining([
            'table:corpus_sessions',
            'table:corpus_session_documents',
            'table:projects',
            'table:project_documents',
            'index:corpus_sessions_updated',
            'index:corpus_session_documents_document',
            'index:projects_name_unique'
          ])
        );
        const corpusColumns = tableColumns(afterDb, 'corpus_sessions');
        expect(corpusColumns.map((column) => column.name)).toEqual([
          'id',
          'title',
          'created_at',
          'updated_at',
          'archived_at',
          'source_project_id',
          'source_project_name'
        ]);
        for (const name of ['source_project_id', 'source_project_name']) {
          expect(corpusColumns.find((column) => column.name === name)).toMatchObject({
            type: 'TEXT',
            notnull: 0,
            dflt_value: null
          });
        }
        // 来源项目**不建外键**：删项目不能连带删会话（悬空 id 由读取方原样展示）。
        expect(afterDb.prepare('PRAGMA foreign_key_list(corpus_sessions)').all()).toEqual([]);
        // 旧行原有列逐字不变，新列按兼容口径为 NULL。
        expect(selectRows(afterDb, 'corpus_sessions', CORPUS_SESSION_COLUMNS_V24)).toEqual(
          beforeCorpusRows
        );
        expect(
          afterDb
            .prepare(
              'SELECT source_project_id, source_project_name FROM corpus_sessions WHERE id = ?'
            )
            .get(CORPUS_SESSION_ID)
        ).toEqual({ source_project_id: null, source_project_name: null });
      } finally {
        afterDb.close();
      }

      // ---- 迁移前快照：存在且是 v24（corpus_sessions 没有新列），证明可回滚 ----
      const backups = migrationBackups(dir);
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0]).toMatch(/reader-before-v24-/);
      const backupDb = new DatabaseSync(path.join(dir, 'migration-backups', backups[0]!), {
        readOnly: true
      });
      try {
        expect(readVersion(backupDb)).toBe('24');
        expect(tableColumns(backupDb, 'corpus_sessions').map((column) => column.name)).not.toContain(
          'source_project_id'
        );
      } finally {
        backupDb.close();
      }

      // ---- 迁移后新写入：来源项目快照落库；项目改名/删除后展示名不变 ----
      store = new Store(dir);
      const project = store.createProject({ name: '来源项目-原名' });
      const withSource = store.createCorpusSession('来源项目会话', [DOC_ID], {
        id: project.id,
        name: project.name
      });
      expect(withSource).toMatchObject({
        id: withSource.id,
        sourceProjectId: project.id,
        sourceProjectName: '来源项目-原名',
        documentIds: [DOC_ID]
      });
      const withoutSource = store.createCorpusSession('手选文献会话', [DOC_ID]);
      expect(withoutSource.sourceProjectId).toBeNull();
      expect(withoutSource.sourceProjectName).toBeNull();

      // 项目改名：快照名不跟着变。
      store.updateProject(project.id, { name: '来源项目-改名后' });
      expect(store.getCorpusSession(withSource.id)).toMatchObject({
        sourceProjectId: project.id,
        sourceProjectName: '来源项目-原名'
      });
      // 删项目：会话保留、id 悬空、name 仍是建会话时的名字（读取方不做删除判断）。
      store.deleteProject(project.id);
      expect(store.getProject(project.id)).toBeNull();
      expect(store.getCorpusSession(withSource.id)).toMatchObject({
        id: withSource.id,
        sourceProjectId: project.id,
        sourceProjectName: '来源项目-原名',
        documentIds: [DOC_ID]
      });
      expect(store.listCorpusSessions().find((row) => row.id === withSource.id)).toMatchObject({
        sourceProjectId: project.id,
        sourceProjectName: '来源项目-原名'
      });

      // 关库重开：两列确实持久化，不是只在内存里。
      store.close();
      store = new Store(dir);
      expect(store.getCorpusSession(withSource.id)).toMatchObject({
        sourceProjectId: project.id,
        sourceProjectName: '来源项目-原名'
      });
      expect(store.getCorpusSession(withoutSource.id)).toMatchObject({
        sourceProjectId: null,
        sourceProjectName: null
      });
      expect(store.getCorpusSession(CORPUS_SESSION_ID)).toMatchObject({
        sourceProjectId: null,
        sourceProjectName: null
      });

      // ---- 幂等：再开两次，版本/schema/备份不变 ----
      const backupsAfterFirstMigration = migrationBackups(dir);
      for (let round = 0; round < 2; round += 1) {
        store.close();
        store = new Store(dir);
        expect(store.getCorpusSession(withSource.id)?.sourceProjectName).toBe('来源项目-原名');
      }
      store.close();
      store = null;
      const reopenedDb = readOnlyDb(dir);
      try {
        expect(readVersion(reopenedDb)).toBe('26');
        expect(schemaObjectNames(reopenedDb)).toEqual(afterObjects);
      } finally {
        reopenedDb.close();
      }
      expect(migrationBackups(dir)).toEqual(backupsAfterFirstMigration);

      expect(beforeVersion).toBe('24');
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
