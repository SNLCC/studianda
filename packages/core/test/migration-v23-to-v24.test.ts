import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * schema_version **23 → 24** 旧库升级验证（直接跑真实 `Store` 构造函数里的 migrate；
 * 当前迁移终点已到 25，同时会补 24→25 的 corpus_sessions 来源项目两列）。
 *
 * 本轮迁移只给 `messages` 加两列（不重建表、不动既有行）：
 * - `scope_kind TEXT NOT NULL DEFAULT 'document'`：消息作用域显式化（'document' | 'corpus'），
 *   跨篇会话消息不再只靠 `document_id=''` 空串哨兵表达归属；
 * - `audit_summary TEXT`（可空 JSON）：assistant 消息的审计摘要（缺证/原文已变更/越界引用计数）。
 *
 * 夹具用 node:sqlite 手工构造 v23 旧库（documents/messages/document_chat_sessions/会话触发器/
 * corpus_sessions/corpus_session_documents 都是 v23 真实形态，messages **没有**新增两列，
 * corpus_sessions 也**没有**来源项目两列），塞入固定数据后关库，再交给 `new Store(dir)` 触发真实迁移。
 * 断言覆盖：补两列与默认值、版本升到 27、旧行逐字不变且 scope_kind='document'/audit_summary=NULL、
 * 迁移前快照是 v23、重复迁移幂等、迁移后新旧消息都能正常读写（含审计摘要解析容错）。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-v23-v24-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DOC_ID = 'doc-v23';
const SESSION_ID = 'session-v23';
const MESSAGE_ID = 7;
const CORPUS_SESSION_ID = 'corpus-v23';

const DOCUMENT_COLUMNS =
  'id, name, pages, current_page, created, deleted, storage_kind, external_path, external_key, ' +
  'file_stamp, tags, author, publication, doi, title_key, sha256, size_bytes, path, doc_type, ' +
  'folder_id, manual_order';
/** v23 的 messages 列（迁移前真实形态：没有 scope_kind/audit_summary）。 */
const MESSAGE_COLUMNS = 'id, document_id, role, content, sources, created, metadata, session_id';

type Row = Record<string, unknown>;

/** 手工构造 v23 旧库：与本次迁移相关的表 + v23 的会话消息触发器 + 语料会话两表。 */
function createLegacyV23Database(dir: string): void {
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
      CREATE INDEX document_chat_sessions_document
        ON document_chat_sessions(document_id, updated);
      CREATE INDEX messages_session ON messages(document_id, session_id, id);

      -- v23 真实库的会话消息版本触发器：跨篇消息（document_id 空串）写入时更新 0 行，
      -- 迁移后必须保持可用（不能因为新列/新行报错）。
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

    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '23')").run();

    db.prepare(
      `INSERT INTO documents(
         id, name, pages, current_page, created, deleted, storage_kind, external_path,
         external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
         size_bytes, path, doc_type, folder_id, manual_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      DOC_ID,
      'v23-老文献.pdf',
      4,
      2,
      '2026-03-01T00:00:00.000Z',
      0,
      'copy',
      '',
      '',
      'stamp-v23',
      '["老库"]',
      '老作者',
      '老期刊',
      '10.1000/v23',
      'v23oldpdf',
      'sha256-v23',
      4096,
      'papers/v23.pdf',
      'journalArticle',
      '',
      3
    );

    // 先插消息、再插会话：v23 真实库里消息先于会话落库（触发器找不到会话行，不递增）。
    db.prepare(
      `INSERT INTO messages(id, document_id, role, content, sources, created, metadata, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      MESSAGE_ID,
      DOC_ID,
      'user',
      'v23 老消息',
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
      'v23 老会话',
      '2026-03-02T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
      '老摘要',
      0,
      2
    );

    // v23 已存在的跨篇会话（范围快照）：迁移不能动它，也不能让旧消息读取报错。
    db.prepare(
      'INSERT INTO corpus_sessions(id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      CORPUS_SESSION_ID,
      'v23 老跨篇会话',
      '2026-03-03T00:00:00.000Z',
      '2026-03-03T00:00:00.000Z',
      ''
    );
    db.prepare(
      'INSERT INTO corpus_session_documents(session_id, document_id) VALUES (?, ?)'
    ).run(CORPUS_SESSION_ID, DOC_ID);
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

describe('schema_version 23 → 24 迁移', () => {
  it('messages 加 scope_kind/audit_summary 两列，版本升到 27，旧行逐字不变且读取容错', () => {
    const dir = mkdtempSync(path.join(root, 'v23-'));
    let store: Store | null = null;
    try {
      createLegacyV23Database(dir);

      // ---- 迁移前：确认夹具是 v23 形态（messages 没有本次新增两列） ----
      const beforeDb = readOnlyDb(dir);
      let beforeVersion = '';
      let beforeMessageColumns: string[] = [];
      let beforeObjects: string[] = [];
      try {
        beforeVersion = readVersion(beforeDb) ?? '';
        beforeMessageColumns = tableColumns(beforeDb, 'messages').map((column) => column.name);
        beforeObjects = schemaObjectNames(beforeDb);
        expect(beforeVersion).toBe('23');
        expect(beforeMessageColumns).not.toContain('scope_kind');
        expect(beforeMessageColumns).not.toContain('audit_summary');
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

      // 旧数据仍可读；v23 的旧跨篇会话与范围快照原样保留。
      expect(store.listDocuments().map((row) => row.id)).toContain(DOC_ID);
      expect(store.listMessages(DOC_ID).map((row) => row.content)).toEqual(['v23 老消息']);
      expect(store.listDocumentChatSessions(DOC_ID)[0]).toMatchObject({
        id: SESSION_ID,
        title: 'v23 老会话',
        transcriptVersion: 2
      });
      expect(store.getCorpusSession(CORPUS_SESSION_ID)).toMatchObject({
        id: CORPUS_SESSION_ID,
        title: 'v23 老跨篇会话',
        documentIds: [DOC_ID]
      });
      expect(store.listCorpusSessionMessages(CORPUS_SESSION_ID)).toEqual([]);

      // ---- 迁移后：版本、两列结构、默认值 ----
      store.close();
      store = null;
      const afterDb = readOnlyDb(dir);
      let afterVersion = '';
      let afterObjects: string[] = [];
      let afterMessageColumns: ReturnType<typeof tableColumns> = [];
      try {
        afterVersion = readVersion(afterDb) ?? '';
        afterObjects = schemaObjectNames(afterDb);
        afterMessageColumns = tableColumns(afterDb, 'messages');
        expect(afterVersion).toBe('28');
        // 只加列不重建表：v23 已有的语料会话两表/索引仍在。
        expect(afterObjects).toEqual(
          expect.arrayContaining([
            'table:corpus_sessions',
            'table:corpus_session_documents',
            'index:corpus_sessions_updated',
            'index:corpus_session_documents_document',
            'index:messages_session'
          ])
        );
        const scopeKind = afterMessageColumns.find((column) => column.name === 'scope_kind');
        expect(scopeKind).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'document'" });
        const auditSummary = afterMessageColumns.find((column) => column.name === 'audit_summary');
        expect(auditSummary).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

        // 旧行逐字不变（原有列），新列按兼容口径：scope_kind='document'、audit_summary=NULL。
        expect(selectRows(afterDb, 'documents', DOCUMENT_COLUMNS)).toEqual(beforeRows.documents);
        expect(selectRows(afterDb, 'messages', MESSAGE_COLUMNS)).toEqual(beforeRows.messages);
        const migratedRows = selectRows(afterDb, 'messages', 'scope_kind, audit_summary');
        expect(migratedRows).toEqual([{ scope_kind: 'document', audit_summary: null }]);
      } finally {
        afterDb.close();
      }

      // ---- 迁移前快照：存在且是 v23（messages 没有新列），证明可回滚 ----
      const backups = migrationBackups(dir);
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0]).toMatch(/reader-before-v23-/);
      const backupDb = new DatabaseSync(path.join(dir, 'migration-backups', backups[0]!), {
        readOnly: true
      });
      try {
        expect(readVersion(backupDb)).toBe('23');
        expect(tableColumns(backupDb, 'messages').map((column) => column.name)).not.toContain(
          'audit_summary'
        );
      } finally {
        backupDb.close();
      }

      // ---- 迁移后新写入：单篇与跨篇作用域/摘要正确，且重开仍能读到 ----
      store = new Store(dir);
      try {
        const corpusSession = store.createCorpusSession('迁移后新建的跨篇会话', [DOC_ID]);
        const corpusUser = store.addCorpusSessionMessage({
          sessionId: corpusSession.id,
          role: 'user',
          content: '迁移后的跨篇追问',
          metadata: { corpusSessionId: corpusSession.id }
        });
        const corpusAssistant = store.addCorpusSessionMessage({
          sessionId: corpusSession.id,
          role: 'assistant',
          content: '迁移后的跨篇回答',
          auditSummary: {
            claims: 3,
            supported: 1,
            inference: 1,
            unsupported: 1,
            heading: 0,
            claim_types: { DOCUMENT_INTERPRETATION: 2, HISTORICAL_FACT: 1 },
            source_changed: 1,
            invalid_citations: 2,
            selection_snapshot_status: 'source_changed'
          }
        });
        const documentAssistant = store.addMessage({
          documentId: DOC_ID,
          role: 'assistant',
          content: '迁移后的单篇回答',
          metadata: {
            sessionId: SESSION_ID,
            response: {
              answer: '迁移后的单篇回答',
              sources: [],
              invalid_citations: [5],
              audit: {
                status: '已进行模型证据支持复核',
                claims: [
                  { claim: 1, verdict: 'supported' },
                  { claim: 2, verdict: 'inference' },
                  { claim: 3, verdict: 'unsupported' }
                ]
              },
              selection_snapshot: { status: 'current' }
            }
          }
        });
        expect(corpusUser.scopeKind).toBe('corpus');
        expect(corpusUser.auditSummary).toBeUndefined();
        expect(corpusAssistant.scopeKind).toBe('corpus');
        expect(corpusAssistant.auditSummary).toMatchObject({
          claims: 3,
          supported: 1,
          inference: 1,
          unsupported: 1,
          source_changed: 1,
          invalid_citations: 2,
          selection_snapshot_status: 'source_changed'
        });
        expect(documentAssistant.scopeKind).toBe('document');
        expect(documentAssistant.auditSummary).toMatchObject({
          claims: 3,
          supported: 1,
          inference: 1,
          unsupported: 1,
          source_changed: 0,
          invalid_citations: 1,
          selection_snapshot_status: 'current'
        });

        store.close();
        store = new Store(dir);
        // 重开：审计摘要仍在（本次迁移的核心价值），按会话/文档都能取回。
        const reopenedCorpus = store.listCorpusSessionMessages(corpusSession.id);
        expect(reopenedCorpus.map((row) => row.scopeKind)).toEqual(['corpus', 'corpus']);
        expect(reopenedCorpus[1]!.auditSummary).toMatchObject({
          claims: 3,
          source_changed: 1,
          invalid_citations: 2
        });
        const reopenedDocument = store.listMessages(DOC_ID, { sessionId: SESSION_ID }).at(-1)!;
        expect(reopenedDocument.scopeKind).toBe('document');
        expect(reopenedDocument.auditSummary).toMatchObject({
          claims: 3,
          invalid_citations: 1
        });

        // ---- 坏摘要/旧消息（NULL）都不能让整条历史读取报错 ----
        store.close();
        store = null;
        const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
        try {
          raw.prepare('UPDATE messages SET audit_summary = ? WHERE id = ?').run(
            '{这不是合法 JSON',
            corpusAssistant.id
          );
        } finally {
          raw.close();
        }
        store = new Store(dir);
        const degraded = store.listCorpusSessionMessages(corpusSession.id);
        expect(degraded).toHaveLength(2);
        expect(degraded[1]!.auditSummary).toBeUndefined();
        expect(degraded[1]!.content).toBe('迁移后的跨篇回答');
        // 旧消息（迁移前写入、audit_summary=NULL）读取正常。
        expect(store.listMessages(DOC_ID, { sessionId: SESSION_ID })[0]).toMatchObject({
          content: 'v23 老消息',
          scopeKind: 'document'
        });

        // ---- 幂等：再开两次，版本/schema/备份不变 ----
        const backupsAfterFirstMigration = migrationBackups(dir);
        for (let round = 0; round < 2; round += 1) {
          store.close();
          store = new Store(dir);
          expect(store.listDocuments().map((row) => row.id)).toContain(DOC_ID);
        }
        store.close();
        store = null;
        const reopenedDb = readOnlyDb(dir);
        try {
          expect(readVersion(reopenedDb)).toBe('28');
          expect(schemaObjectNames(reopenedDb)).toEqual(afterObjects);
        } finally {
          reopenedDb.close();
        }
        expect(migrationBackups(dir)).toEqual(backupsAfterFirstMigration);
      } finally {
        store?.close();
        store = null;
      }

      expect(beforeVersion).toBe('23');
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
