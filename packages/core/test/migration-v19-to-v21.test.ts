import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AI_ANSWER_COPY_SUFFIX, looksLikeAiContent } from '@studianda/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { markdownHasAiExportHeader } from '../src/export-marker.js';
import { Store } from '../src/store.js';

/**
 * schema_version **19 / 20 → 当前版本（24）** 旧库升级验证（可重复，直接跑真实 `Store` 构造函数里的 migrate）。
 *
 * 本轮迁移：
 * - 19 → 20：新增 `book_summaries`（全书摘要缓存）与 `selection_snapshots`（选区冻结快照）两张基线表；
 * - 20 → 21：`notes`、`annotations` 各新增 `origin TEXT NOT NULL DEFAULT 'user'`；
 * - 21 → 22：新增逻辑项目 `projects` 与 `project_documents` 两张基线表（直接由 SCHEMA_SQL 补建）；
 * - 22 → 23：新增跨文献语料会话 `corpus_sessions` 与 `corpus_session_documents` 两张基线表；
 * - 23 → 24：`messages` 新增 `scope_kind`（'document' | 'corpus'）与 `audit_summary`（审计摘要 JSON）。
 *
 * 夹具用 node:sqlite **手工构造** v19 / v20 的旧库（表结构是迁移前真实形态：notes/annotations
 * 没有 origin 列，v19 没有 20 的两张表），塞入固定数据后关库，再交给 `new Store(dir)` 触发真实迁移。
 * 断言覆盖：补表补列、版本号、旧行数与内容/时间戳逐字不变、老行 origin='user'、
 * 导出判定（origin 字段 + looksLikeAiContent 文本兜底）、重复迁移幂等（不报错、不重复建表）。
 */

type LegacyVersion = 19 | 20;

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migration-v19-v21-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DOC_ID = 'doc-legacy';
const AI_NOTE_ID = 'note-ai';
const PLAIN_NOTE_ID = 'note-user';
const SESSION_ID = 'session-legacy';

const NOTE_AI_CREATED = '2026-01-02T03:04:05.000Z';
const NOTE_PLAIN_CREATED = '2026-01-03T04:05:06.000Z';
const ANNOTATION_ONE_CREATED = '2026-01-04T05:06:07.000Z';
const SESSION_CREATED = '2026-01-06T07:08:09.000Z';

/** 迁移前老数据里的 AI 标识文字（与 shared 里复制 AI 回答的后缀同源）。 */
const AI_NOTE_CONTENT = `迁移前的 AI 回答正文：这段由系统代写，用户当时保留了标识。${AI_ANSWER_COPY_SUFFIX}`;
/** 迁移前纯用户内容：迁移后不能被误判成 AI。 */
const PLAIN_NOTE_CONTENT = '用户自己写的第二篇笔记，没有任何 AI 标识。';

/** 迁移前就存在的列（不含 21 新增的 origin），before/after 用同一列清单逐行比对。 */
const DOCUMENT_OLD_COLUMNS =
  'id, name, pages, current_page, created, deleted, storage_kind, external_path, external_key, ' +
  'file_stamp, tags, author, publication, doi, title_key, sha256, size_bytes, path, doc_type, ' +
  'folder_id, manual_order';
const NOTE_OLD_COLUMNS =
  'id, document_id, page, quote, content, external_key, folder_path, tags, created, deleted, ' +
  'manual_order';
const ANNOTATION_OLD_COLUMNS =
  'id, document_id, page, quote, content, rects, color, deleted, style, translation_excerpt, ' +
  'external_key, created';
const MESSAGE_COLUMNS = 'id, document_id, role, content, sources, created, metadata, session_id';
const SESSION_COLUMNS =
  'document_id, id, title, created, updated, context_summary, summary_upto, transcript_version';
const BOOK_SUMMARY_COLUMNS =
  'document_id, scope, block_key, title, pages_from, pages_to, content, model, content_version, ' +
  'prompt_version, level, created, updated';
const SELECTION_SNAPSHOT_COLUMNS =
  'id, document_id, page, text, text_hash, revision, question, created';

type Row = Record<string, unknown>;

/**
 * 手工构造迁移前的旧库。
 *
 * 只建与本次迁移相关的基线表（documents/notes/annotations/messages/会话），其余表由迁移里的
 * `SCHEMA_SQL` 补建；notes/annotations 的列严格保持 v19/v20 形态（**没有 origin 列**）。
 * `manual_order`/`title_key` 都写成非空值，避免迁移里 8→9、18→19 的旧回填改动本书断言的行。
 */
function createLegacyDatabase(dir: string, version: LegacyVersion): void {
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

      -- v19/v20 的 notes 已经有 manual_order（18→19），但还没有 origin（20→21）。
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
        manual_order REAL DEFAULT 0
      );

      -- v19/v20 的 annotations 同样没有 origin 列。
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
        created TEXT DEFAULT CURRENT_TIMESTAMP
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
    `);

    // v20 基线新增的两张表；v19 没有。v20 里各留一行，验证迁移不会清空/覆盖已有数据。
    if (version >= 20) {
      db.exec(`
        CREATE TABLE book_summaries(
          document_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          block_key TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          pages_from INTEGER NOT NULL DEFAULT 0,
          pages_to INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          content_version TEXT NOT NULL DEFAULT '',
          prompt_version INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 0,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY(document_id, scope, block_key)
        );
        CREATE INDEX book_summaries_document ON book_summaries(document_id);

        CREATE TABLE selection_snapshots(
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          page INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          revision TEXT NOT NULL DEFAULT '',
          question TEXT DEFAULT '',
          created TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX selection_snapshots_unique
          ON selection_snapshots(document_id, text_hash, revision);
        CREATE INDEX selection_snapshots_document
          ON selection_snapshots(document_id, created);
      `);
    }

    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)").run(
      String(version)
    );

    db.prepare(
      `INSERT INTO documents(
         id, name, pages, current_page, created, deleted, storage_kind, external_path,
         external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
         size_bytes, path, doc_type, folder_id, manual_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      DOC_ID,
      `legacy-v${version}.pdf`,
      2,
      3,
      '2026-01-01T00:00:00.000Z',
      0,
      'copy',
      '',
      '',
      'file-stamp-old',
      '["旧库"]',
      '旧库作者',
      '旧期刊',
      '10.1000/old.1',
      `legacyv${version}pdf`,
      'sha256-old',
      12_345,
      'papers/legacy.pdf',
      'journalArticle',
      'folder-old',
      7
    );

    const insertNote = db.prepare(
      `INSERT INTO notes(
         id, document_id, page, quote, content, external_key, folder_path, tags, created,
         deleted, manual_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertNote.run(
      AI_NOTE_ID,
      DOC_ID,
      1,
      '原文摘录一',
      AI_NOTE_CONTENT,
      'ext-ai',
      '阅读笔记/旧库',
      '["旧库","AI"]',
      NOTE_AI_CREATED,
      0,
      4
    );
    insertNote.run(
      PLAIN_NOTE_ID,
      DOC_ID,
      2,
      '原文摘录二',
      PLAIN_NOTE_CONTENT,
      'ext-user',
      '阅读笔记/旧库',
      '["旧库"]',
      NOTE_PLAIN_CREATED,
      0,
      5
    );

    const insertAnnotation = db.prepare(
      `INSERT INTO annotations(
         id, document_id, page, quote, content, rects, color, deleted, style,
         translation_excerpt, external_key, created
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertAnnotation.run(
      'ann-1',
      DOC_ID,
      1,
      '原文一句',
      '旧批注：用户手写',
      '[{"x":1}]',
      'yellow',
      0,
      'highlight',
      '',
      'ext-ann-1',
      ANNOTATION_ONE_CREATED
    );
    insertAnnotation.run(
      'ann-2',
      DOC_ID,
      2,
      '原文二句',
      '旧批注二：用户高亮',
      '[{"x":2}]',
      'green',
      0,
      'underline',
      '',
      'ext-ann-2',
      '2026-01-05T06:07:08.000Z'
    );

    const insertMessage = db.prepare(
      `INSERT INTO messages(id, document_id, role, content, sources, created, metadata, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertMessage.run(
      101,
      DOC_ID,
      'user',
      '旧会话里的用户消息',
      '[]',
      '2026-01-06T07:08:09.000Z',
      '{}',
      SESSION_ID
    );
    insertMessage.run(
      102,
      DOC_ID,
      'assistant',
      '旧会话里的助手回答',
      '[]',
      '2026-01-06T07:09:10.000Z',
      '{}',
      SESSION_ID
    );

    db.prepare(
      `INSERT INTO document_chat_sessions(
         document_id, id, title, created, updated, context_summary, summary_upto, transcript_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(DOC_ID, SESSION_ID, '旧会话', SESSION_CREATED, '2026-01-06T07:09:10.000Z', '', 0, 2);

    if (version >= 20) {
      db.prepare(
        `INSERT INTO book_summaries(
           document_id, scope, block_key, title, pages_from, pages_to, content, model,
           content_version, prompt_version, level, created, updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        DOC_ID,
        'book',
        'block-1',
        '全书摘要',
        1,
        2,
        'v20 已有全书摘要内容',
        'model-old',
        'v1',
        1,
        0,
        '2026-01-07T00:00:00.000Z',
        '2026-01-07T00:00:00.000Z'
      );
      db.prepare(
        `INSERT INTO selection_snapshots(
           id, document_id, page, text, text_hash, revision, question, created
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'snap-old',
        DOC_ID,
        1,
        'v20 已有选区快照原文',
        'hash-old',
        'rev-old',
        'v20 旧问题',
        '2026-01-08T00:00:00.000Z'
      );
    }
  } finally {
    db.close();
  }
}

interface SchemaColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

interface LegacyState {
  version: string | null;
  /** `type:name` 形式，含表/索引/触发器（不含 sqlite_ 内部对象）。 */
  schemaObjects: string[];
  notesColumns: SchemaColumn[];
  annotationsColumns: SchemaColumn[];
  rows: {
    documents: Row[];
    notes: Row[];
    annotations: Row[];
    messages: Row[];
    sessions: Row[];
    bookSummaries: Row[];
    selectionSnapshots: Row[];
  };
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

function tableColumns(db: DatabaseSync, table: string): SchemaColumn[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as SchemaColumn[];
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function selectRows(db: DatabaseSync, table: string, columns: string, orderBy = 'rowid'): Row[] {
  if (!tableExists(db, table)) return [];
  return db
    .prepare(`SELECT ${columns} FROM ${table} ORDER BY ${orderBy}`)
    .all() as unknown as Row[];
}

/** 读取旧库的表/列/行快照（before 与 after 都能用；只取迁移前就存在的列）。 */
function readState(dir: string): LegacyState {
  const db = readOnlyDb(dir);
  try {
    const versionRow = tableExists(db, 'schema_meta')
      ? (db
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as { value?: string } | undefined)
      : undefined;
    return {
      version: versionRow?.value ?? null,
      schemaObjects: schemaObjectNames(db),
      notesColumns: tableColumns(db, 'notes'),
      annotationsColumns: tableColumns(db, 'annotations'),
      rows: {
        documents: selectRows(db, 'documents', DOCUMENT_OLD_COLUMNS, 'rowid'),
        notes: selectRows(db, 'notes', NOTE_OLD_COLUMNS, 'rowid'),
        annotations: selectRows(db, 'annotations', ANNOTATION_OLD_COLUMNS, 'rowid'),
        messages: selectRows(db, 'messages', MESSAGE_COLUMNS, 'id'),
        sessions: selectRows(db, 'document_chat_sessions', SESSION_COLUMNS, 'id'),
        bookSummaries: selectRows(db, 'book_summaries', BOOK_SUMMARY_COLUMNS, 'block_key'),
        selectionSnapshots: selectRows(db, 'selection_snapshots', SELECTION_SNAPSHOT_COLUMNS, 'id')
      }
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

function tableNames(state: LegacyState): string[] {
  return state.schemaObjects
    .filter((entry) => entry.startsWith('table:'))
    .map((entry) => entry.slice('table:'.length));
}

function indexNames(state: LegacyState): string[] {
  return state.schemaObjects
    .filter((entry) => entry.startsWith('index:'))
    .map((entry) => entry.slice('index:'.length));
}

function columnByName(columns: SchemaColumn[], name: string): SchemaColumn | undefined {
  return columns.find((column) => column.name === name);
}

describe.each([19, 20] as const)('schema_version %i → 24 迁移', (version) => {
  it('补建表/列、版本升到 25，旧行数与内容/时间戳逐字不变，老行 origin=user，重复迁移幂等', () => {
    const dir = mkdtempSync(path.join(root, `v${version}-`));
    let store: Store | null = null;
    try {
      createLegacyDatabase(dir, version);

      // ---- 迁移前：确认夹具真的是旧库形态 ----
      const before = readState(dir);
      expect(before.version).toBe(String(version));
      expect(columnByName(before.notesColumns, 'origin')).toBeUndefined();
      expect(columnByName(before.annotationsColumns, 'origin')).toBeUndefined();
      expect(tableNames(before)).toEqual(expect.arrayContaining(['documents', 'notes', 'annotations']));
      if (version === 19) {
        // v19 还没有 19→20 的两张基线表。
        expect(tableNames(before)).not.toContain('book_summaries');
        expect(tableNames(before)).not.toContain('selection_snapshots');
      } else {
        expect(tableNames(before)).toEqual(
          expect.arrayContaining(['book_summaries', 'selection_snapshots'])
        );
      }
      expect(before.rows.documents).toHaveLength(1);
      expect(before.rows.notes).toHaveLength(2);
      expect(before.rows.annotations).toHaveLength(2);
      expect(before.rows.messages).toHaveLength(2);
      expect(before.rows.sessions).toHaveLength(1);
      // v19 没有这两张表 → 0 行；v20 各 1 行（迁移后必须原样保留）。
      expect(before.rows.bookSummaries).toHaveLength(version === 20 ? 1 : 0);
      expect(before.rows.selectionSnapshots).toHaveLength(version === 20 ? 1 : 0);

      // ---- 触发真实迁移 ----
      store = new Store(dir);

      // 读路径（Store）必须能读到老数据，且 origin 一律 'user'。
      const notes = store.listNotes(DOC_ID);
      expect(notes).toHaveLength(2);
      expect(notes.map((note) => note.origin)).toEqual(['user', 'user']);
      expect(notes.find((note) => note.id === AI_NOTE_ID)?.content).toBe(AI_NOTE_CONTENT);
      expect(notes.find((note) => note.id === AI_NOTE_ID)?.created).toBe(NOTE_AI_CREATED);
      expect(notes.find((note) => note.id === PLAIN_NOTE_ID)?.content).toBe(PLAIN_NOTE_CONTENT);
      expect(notes.find((note) => note.id === PLAIN_NOTE_ID)?.created).toBe(NOTE_PLAIN_CREATED);
      const annotations = store.listAnnotations(DOC_ID);
      expect(annotations).toHaveLength(2);
      expect(annotations.map((annotation) => annotation.origin)).toEqual(['user', 'user']);
      expect(annotations[0]?.created).toBe(ANNOTATION_ONE_CREATED);
      expect(store.getNote(AI_NOTE_ID)?.origin).toBe('user');
      // 会话与消息也不受迁移影响。
      expect(store.listDocumentChatSessions(DOC_ID)).toHaveLength(1);
      expect(store.listDocumentChatSessions(DOC_ID)[0]).toMatchObject({
        id: SESSION_ID,
        title: '旧会话',
        transcriptVersion: 2
      });
      expect(store.listMessages(DOC_ID)).toHaveLength(2);

      store.close();
      store = null;

      // ---- 迁移后：版本、表、列 ----
      const after = readState(dir);
      expect(after.version).toBe('28');
      expect(tableNames(after)).toEqual(
        expect.arrayContaining([
          'book_summaries',
          'notes',
          'annotations',
          'selection_snapshots',
          // 21 → 22：逻辑项目与项目文献链接。
          'projects',
          'project_documents'
        ])
      );
      expect(indexNames(after)).toEqual(
        expect.arrayContaining([
          'book_summaries_document',
          'selection_snapshots_unique',
          'selection_snapshots_document',
          'projects_name_unique',
          'project_documents_document'
        ])
      );
      const noteOrigin = columnByName(after.notesColumns, 'origin');
      expect(noteOrigin).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'user'" });
      const annotationOrigin = columnByName(after.annotationsColumns, 'origin');
      expect(annotationOrigin).toMatchObject({
        type: 'TEXT',
        notnull: 1,
        dflt_value: "'user'"
      });

      // ---- 迁移后：行数、旧列内容、时间戳逐字不变 ----
      expect(after.rows.documents).toHaveLength(before.rows.documents.length);
      expect(after.rows.notes).toHaveLength(2);
      expect(after.rows.annotations).toHaveLength(2);
      expect(after.rows.messages).toHaveLength(2);
      expect(after.rows.sessions).toHaveLength(1);
      expect(after.rows.documents).toEqual(before.rows.documents);
      expect(after.rows.notes).toEqual(before.rows.notes);
      expect(after.rows.annotations).toEqual(before.rows.annotations);
      expect(after.rows.messages).toEqual(before.rows.messages);
      expect(after.rows.sessions).toEqual(before.rows.sessions);
      // v20 已有的 20 基线数据原样保留；v19 新表则是空的。
      expect(after.rows.bookSummaries).toEqual(before.rows.bookSummaries);
      expect(after.rows.selectionSnapshots).toEqual(before.rows.selectionSnapshots);
      if (version === 20) {
        expect(after.rows.bookSummaries[0]?.content).toBe('v20 已有全书摘要内容');
        expect(after.rows.selectionSnapshots[0]?.text).toBe('v20 已有选区快照原文');
      }
      // 笔记正文逐字相同（含 AI 标识文字原样保留）。
      const preservedAiNote = after.rows.notes.find((row) => row.id === AI_NOTE_ID);
      expect(preservedAiNote?.content).toBe(AI_NOTE_CONTENT);
      expect(preservedAiNote?.created).toBe(NOTE_AI_CREATED);

      // ---- 迁移后：数据行 origin 全部为 'user'（默认值兜底），新旧表都在 ----
      const rawAfter = readOnlyDb(dir);
      try {
        const noteOrigins = rawAfter
          .prepare('SELECT id, origin FROM notes ORDER BY id')
          .all() as unknown as Array<{ id: string; origin: string }>;
        expect(noteOrigins).toEqual([
          { id: AI_NOTE_ID, origin: 'user' },
          { id: PLAIN_NOTE_ID, origin: 'user' }
        ]);
        const annotationOrigins = rawAfter
          .prepare('SELECT id, origin FROM annotations ORDER BY id')
          .all() as unknown as Array<{ id: string; origin: string }>;
        expect(annotationOrigins).toHaveLength(2);
        expect(annotationOrigins.every((row) => row.origin === 'user')).toBe(true);
      } finally {
        rawAfter.close();
      }

      // ---- 幂等：连续再打开两次，不报错、不重复建表/索引、不再产生迁移备份 ----
      const schemaAfterFirstMigration = after.schemaObjects;
      const backupsAfterFirstMigration = migrationBackups(dir);
      expect(backupsAfterFirstMigration.length).toBeGreaterThan(0);
      for (let round = 0; round < 2; round += 1) {
        const reopened = new Store(dir);
        try {
          expect(reopened.listNotes(DOC_ID)).toHaveLength(2);
        } finally {
          reopened.close();
        }
      }
      const afterReopen = readState(dir);
      expect(afterReopen.version).toBe('28');
      expect(afterReopen.schemaObjects).toEqual(schemaAfterFirstMigration);
      expect(afterReopen.rows).toEqual(after.rows);
      // 已是 23 的库不会再备份一次。
      expect(migrationBackups(dir)).toEqual(backupsAfterFirstMigration);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('迁移后的导出判定：looksLikeAiContent 文本兜底 + origin 字段', () => {
  it('历史 AI 笔记靠文本兜底识别；删掉标识文字后，迁移后新写入的 AI 内容靠 origin 仍判为 AI', () => {
    const dir = mkdtempSync(path.join(root, 'export-'));
    let store: Store | null = null;
    try {
      createLegacyDatabase(dir, 20);
      store = new Store(dir);

      // 1) 迁移前的老 AI 笔记：origin 迁移后是 'user'，只能靠正文里的 AI 标识文字兜底。
      const legacyNotes = store.listNotes(DOC_ID);
      expect(legacyNotes.every((note) => note.origin === 'user')).toBe(true);
      const legacyText = [...legacyNotes, ...store.listAnnotations(DOC_ID)]
        .map((record) => record.content ?? '')
        .join('\n');
      expect(looksLikeAiContent(legacyText)).toBe(true);
      const fallbackExport = store.exportMarkdown(DOC_ID);
      expect(markdownHasAiExportHeader(fallbackExport.markdown)).toBe(true);
      expect(fallbackExport.markdown).toContain('AI 生成内容声明');

      // 2) 用户把正文里的 AI 标识文字删掉：老行 origin 仍是 'user'，文本兜底必然失效
      //    （这是迁移前老数据的已知缺口，也正是 21 新增 origin 字段要覆盖的场景）。
      store.updateNote(AI_NOTE_ID, { content: '用户编辑后删掉了 AI 标识文字的历史正文。' });
      const editedLegacyNote = store.getNote(AI_NOTE_ID);
      expect(editedLegacyNote?.origin).toBe('user');
      expect(looksLikeAiContent(editedLegacyNote?.content)).toBe(false);
      expect(markdownHasAiExportHeader(store.exportMarkdown(DOC_ID).markdown)).toBe(false);

      // 3) 迁移后系统新写入的 AI 内容：正文没有标识文字，但 origin='ai'，导出仍必须判为 AI。
      const newAiNote = store.createNote({
        documentId: DOC_ID,
        page: 1,
        content: '无标识文字的新 AI 正文（迁移后新数据）。',
        origin: 'ai'
      });
      expect(newAiNote.origin).toBe('ai');
      expect(looksLikeAiContent(newAiNote.content)).toBe(false);
      const originExport = store.exportMarkdown(DOC_ID);
      expect(markdownHasAiExportHeader(originExport.markdown)).toBe(true);
      expect(originExport.markdown).toContain('AI 生成内容声明');
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
