import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * schema_version **22 → 23** 旧库升级验证（当前迁移终点已到 25，本夹具同时覆盖 23→24 的加列
 * 与 24→25 的来源项目两列；直接跑真实 `Store` 构造函数里的 migrate）。
 *
 * 本轮迁移**只建表**：
 * - `corpus_sessions(id, title, created_at, updated_at, archived_at, source_project_id, source_project_name)`
 *   + `corpus_sessions_updated`（来源项目两列为 schema 25 追加）；
 * - `corpus_session_documents(session_id, document_id)`（联合主键）+ `corpus_session_documents_document`；
 * - 不改 `document_chat_sessions` 的主键、不把 `document_id` 改成可空；消息复用 `messages`。
 *
 * 夹具用 node:sqlite 手工构造 v22 旧库（documents/messages/document_chat_sessions/三张会话触发器都是
 * v22 真实形态），塞入固定数据后关库，再交给 `new Store(dir)` 触发真实迁移。断言覆盖：补建两表/索引、
 * 版本升到 25、旧行逐字不变（含后续新增列默认值）、迁移前快照存在且是 v22、重复迁移幂等、
 * 迁移后语料会话数据层可直接使用（建会话 / 落消息 / 删会话）。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-v22-v23-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DOC_ID = 'doc-v22';
const SESSION_ID = 'session-v22';
const MESSAGE_ID = 7;

const DOCUMENT_COLUMNS =
  'id, name, pages, current_page, created, deleted, storage_kind, external_path, external_key, ' +
  'file_stamp, tags, author, publication, doi, title_key, sha256, size_bytes, path, doc_type, ' +
  'folder_id, manual_order';
const MESSAGE_COLUMNS = 'id, document_id, role, content, sources, created, metadata, session_id';

type Row = Record<string, unknown>;

/** 手工构造 v22 旧库：与本次迁移相关的表 + v22 的会话消息触发器。 */
function createLegacyV22Database(dir: string): void {
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

      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,
        document_id TEXT,
        role TEXT,
        content TEXT,
        sources TEXT,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}',
        session_id TEXT DEFAULT 'legacy'
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

      -- v22 真实库已有会话消息版本触发器；跨文献会话消息（document_id 空串哨兵）写入时触发
      -- 更新 0 行，必须保持这样（不能让迁移后的旧库因为触发器报错）。
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
    `);

    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '22')").run();

    db.prepare(
      `INSERT INTO documents(
         id, name, pages, current_page, created, deleted, storage_kind, external_path,
         external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
         size_bytes, path, doc_type, folder_id, manual_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      DOC_ID,
      'v22-老文献.pdf',
      4,
      2,
      '2026-03-01T00:00:00.000Z',
      0,
      'copy',
      '',
      '',
      'stamp-v22',
      '["旧库"]',
      '旧作者',
      '旧期刊',
      '10.1000/v22',
      'v22oldpdf',
      'sha256-v22',
      4096,
      'papers/v22.pdf',
      'journalArticle',
      '',
      3
    );

    // 先插旧消息、再插旧会话：真实库里消息先于会话落库，触发器会递增会话的
    // transcript_version；这里按同样顺序构造，让 v22 的 transcript_version=2 是真实值。
    db.prepare(
      `INSERT INTO messages(id, document_id, role, content, sources, created, metadata, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      MESSAGE_ID,
      DOC_ID,
      'user',
      'v22 旧消息',
      '[]',
      '2026-03-02T00:00:00.000Z',
      '{}',
      SESSION_ID
    );

    db.prepare(
      'INSERT INTO document_chat_sessions(document_id, id, title, created, updated, context_summary, summary_upto, transcript_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      DOC_ID,
      SESSION_ID,
      'v22 旧会话',
      '2026-03-02T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
      '旧摘要',
      0,
      2
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

function migrationBackups(dir: string): string[] {
  const folder = path.join(dir, 'migration-backups');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith('reader-before-v') && name.endsWith('.sqlite3'))
    .sort();
}

describe('schema_version 22 → 23 迁移', () => {
  it('补建语料会话两表/索引，版本升到 25，旧行逐字不变，快照为 v22，重复迁移幂等', () => {
    const dir = mkdtempSync(path.join(root, 'v22-'));
    let store: Store | null = null;
    try {
      createLegacyV22Database(dir);

      // ---- 迁移前：确认夹具是 v22 形态（没有语料会话表） ----
      const beforeDb = readOnlyDb(dir);
      let beforeVersion = '';
      let beforeObjects: string[] = [];
      try {
        beforeVersion = readVersion(beforeDb) ?? '';
        beforeObjects = schemaObjectNames(beforeDb);
        expect(beforeVersion).toBe('22');
        expect(tableExists(beforeDb, 'corpus_sessions')).toBe(false);
        expect(tableExists(beforeDb, 'corpus_session_documents')).toBe(false);
      } finally {
        beforeDb.close();
      }
      const beforeRows = {
        documents: (() => {
          const db = readOnlyDb(dir);
          try {
            return selectRows(db, 'documents', DOCUMENT_COLUMNS);
          } finally {
            db.close();
          }
        })(),
        messages: (() => {
          const db = readOnlyDb(dir);
          try {
            return selectRows(db, 'messages', MESSAGE_COLUMNS);
          } finally {
            db.close();
          }
        })()
      };
      expect(beforeRows.documents).toHaveLength(1);
      expect(beforeRows.messages).toHaveLength(1);

      // ---- 触发真实迁移 ----
      store = new Store(dir);

      // 迁移后旧数据仍可读，旧会话的 transcript_version 原样保留。
      expect(store.listDocuments().map((row) => row.id)).toContain(DOC_ID);
      expect(store.listMessages(DOC_ID).map((row) => row.content)).toEqual(['v22 旧消息']);
      expect(store.listDocumentChatSessions(DOC_ID)[0]).toMatchObject({
        id: SESSION_ID,
        title: 'v22 旧会话',
        transcriptVersion: 2
      });

      // 迁移后的新表可直接使用：建会话 → 落两轮消息 → 删会话清理消息。
      const session = store.createCorpusSession('v22 迁移后的跨文献会话', [DOC_ID]);
      expect(session.documentIds).toEqual([DOC_ID]);
      expect(session.archivedAt).toBe('');
      expect(store.listCorpusSessions().map((row) => row.id)).toEqual([session.id]);
      const userMessage = store.addCorpusSessionMessage({
        sessionId: session.id,
        role: 'user',
        content: '迁移后的追问',
        metadata: { corpusSessionId: session.id }
      });
      store.addCorpusSessionMessage({
        sessionId: session.id,
        role: 'assistant',
        content: '迁移后的回答',
        sources: [{ documentId: DOC_ID, documentName: 'v22-老文献.pdf', page: 1, snippet: '旧原文' }]
      });
      expect(store.listCorpusSessionMessages(session.id).map((row) => row.role)).toEqual([
        'user',
        'assistant'
      ]);
      // 单篇文献的阅读会话消息不受影响（两种会话的消息按 document_id 隔离）。
      expect(store.listMessages(DOC_ID, { sessionId: SESSION_ID })).toHaveLength(1);
      expect(store.deleteCorpusSession(session.id)).toBe(2);
      expect(store.getCorpusSession(session.id)).toBeNull();
      expect(store.listCorpusSessionMessages(session.id)).toEqual([]);
      expect(userMessage.sessionId).toBe(session.id);
      expect(userMessage.documentId).toBe('');

      store.close();
      store = null;

      // ---- 迁移后：版本、表结构、索引、外键 ----
      const afterDb = readOnlyDb(dir);
      let afterVersion = '';
      let afterObjects: string[] = [];
      try {
        afterVersion = readVersion(afterDb) ?? '';
        afterObjects = schemaObjectNames(afterDb);
        expect(afterVersion).toBe('26');
        expect(tableExists(afterDb, 'corpus_sessions')).toBe(true);
        expect(tableExists(afterDb, 'corpus_session_documents')).toBe(true);
        expect(afterObjects).toEqual(
          expect.arrayContaining([
            'table:corpus_sessions',
            'table:corpus_session_documents',
            'index:corpus_sessions_updated',
            'index:corpus_session_documents_document'
          ])
        );

        const sessionColumns = tableColumns(afterDb, 'corpus_sessions');
        expect(sessionColumns.map((column) => column.name)).toEqual([
          'id',
          'title',
          'created_at',
          'updated_at',
          'archived_at',
          'source_project_id',
          'source_project_name'
        ]);
        expect(sessionColumns.find((column) => column.name === 'id')?.pk).toBe(1);
        expect(sessionColumns.find((column) => column.name === 'title')).toMatchObject({
          type: 'TEXT',
          notnull: 1,
          dflt_value: "''"
        });
        expect(sessionColumns.find((column) => column.name === 'archived_at')).toMatchObject({
          type: 'TEXT',
          notnull: 1,
          dflt_value: "''"
        });
        // 24→25 的来源项目两列：可空、无默认值、无外键（项目删除后允许悬空）。
        for (const name of ['source_project_id', 'source_project_name']) {
          expect(sessionColumns.find((column) => column.name === name)).toMatchObject({
            type: 'TEXT',
            notnull: 0,
            dflt_value: null
          });
        }
        expect(
          afterDb.prepare('PRAGMA foreign_key_list(corpus_sessions)').all()
        ).toEqual([]);

        const linkColumns = tableColumns(afterDb, 'corpus_session_documents');
        expect(linkColumns.map((column) => column.name)).toEqual(['session_id', 'document_id']);
        expect(linkColumns.find((column) => column.name === 'session_id')?.pk).toBe(1);
        expect(linkColumns.find((column) => column.name === 'document_id')?.pk).toBe(2);

        // 只对会话表建外键；范围里刻意不建 documents 外键（删文献后仍要能报告“已跳过”）。
        const foreignKeys = afterDb
          .prepare('PRAGMA foreign_key_list(corpus_session_documents)')
          .all() as unknown as Array<{ table: string; from: string; on_delete: string }>;
        expect(foreignKeys.map((fk) => `${fk.table}:${fk.from}:${fk.on_delete}`)).toEqual([
          'corpus_sessions:session_id:CASCADE'
        ]);
        // document_chat_sessions 主键与语义不变（仍是 document_id + id）。
        const documentSessionColumns = tableColumns(afterDb, 'document_chat_sessions');
        expect(
          documentSessionColumns.filter((column) => column.pk > 0).map((column) => column.name)
        ).toEqual(['document_id', 'id']);
        expect(
          documentSessionColumns.find((column) => column.name === 'document_id')?.notnull
        ).toBe(1);
      } finally {
        afterDb.close();
      }

      // ---- 迁移后：旧行逐字不变（documents/messages/旧会话） ----
      const afterRows = (() => {
        const db = readOnlyDb(dir);
        try {
          return {
            documents: selectRows(db, 'documents', DOCUMENT_COLUMNS),
            messages: selectRows(db, 'messages', MESSAGE_COLUMNS)
          };
        } finally {
          db.close();
        }
      })();
      expect(afterRows.documents).toEqual(beforeRows.documents);
      expect(afterRows.messages).toEqual(beforeRows.messages);
      expect(afterRows.documents[0]?.name).toBe('v22-老文献.pdf');

      // ---- 迁移前快照：存在且是 v22（不含新表），证明可回滚 ----
      const backups = migrationBackups(dir);
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0]).toMatch(/reader-before-v22-/);
      const backupDb = new DatabaseSync(path.join(dir, 'migration-backups', backups[0]!), {
        readOnly: true
      });
      try {
        expect(readVersion(backupDb)).toBe('22');
        expect(tableExists(backupDb, 'corpus_sessions')).toBe(false);
      } finally {
        backupDb.close();
      }

      // ---- 幂等：连续再打开两次，版本不变、schema 不变、不再产生新备份 ----
      const backupsAfterFirstMigration = migrationBackups(dir);
      for (let round = 0; round < 2; round += 1) {
        const reopened = new Store(dir);
        try {
          expect(reopened.listDocuments().map((row) => row.id)).toContain(DOC_ID);
          expect(reopened.getCorpusSession('missing-session')).toBeNull();
        } finally {
          reopened.close();
        }
      }
      const afterReopenDb = readOnlyDb(dir);
      try {
        expect(readVersion(afterReopenDb)).toBe('26');
        expect(schemaObjectNames(afterReopenDb)).toEqual(afterObjects);
      } finally {
        afterReopenDb.close();
      }
      expect(migrationBackups(dir)).toEqual(backupsAfterFirstMigration);
      expect(beforeVersion).toBe('22');
      expect(beforeObjects).not.toContain('table:corpus_sessions');
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
