import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withAiNoteHeader, type AnnotationRecord } from '@studianda/shared';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { assertAiMetadataWritten, buildAnnotatedPdf } from '../src/annotated-pdf.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 笔记/批注的 AI 来源结构化标记（schema_version 21）。
 *
 * 核心价值：导出判定改成「origin 字段优先、文本标识兜底」。用户把 AI 内容粘进笔记后
 * 删掉正文里的标识文字，导出仍必须判为 AI 内容；迁移前没有 origin 列的老库，
 * 旧行一律 'user'，历史 AI 内容仍靠文本兜底识别。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-origin-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const LEGACY_AI_MARKER = '（AI 生成内容 · 可能出错，请核实原文；不得删除、篡改或隐匿本标识。）';

async function makePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]).drawText('Origin fixture', { x: 40, y: 760, size: 16 });
  return pdf.save();
}

async function importPdf(store: Store, dir: string, filename = 'origin.pdf'): Promise<string> {
  const file = path.join(dir, filename);
  writeFileSync(file, await makePdf());
  const document = await store.importDocument(file, filename, true);
  return document.id;
}

function record(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    page: 1,
    quote: '原文一句',
    content: '批注正文',
    rects: '[]',
    color: 'yellow',
    style: 'highlight',
    created: '',
    origin: 'user',
    ...overrides
  };
}

/**
 * 建一个 schema_version 20 的老库：documents/notes/annotations 都**没有 origin 列**。
 *
 * - legacy-ai-doc：一条带 AI 标识文字的老笔记（迁移后 origin='user'，靠文本兜底识别）；
 * - legacy-user-doc：纯用户笔记/批注（不能误判成 AI）。
 */
function setupLegacyDb(dir: string): void {
  const db = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
  // 复刻 schema_version 20 的表结构：documents/notes/annotations 均无 origin 列。
  db.exec(`
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES ('schema_version', '20');
    CREATE TABLE documents(
      id TEXT PRIMARY KEY, name TEXT, pages INTEGER, current_page INTEGER DEFAULT 1,
      created TEXT DEFAULT CURRENT_TIMESTAMP, deleted INTEGER DEFAULT 0,
      storage_kind TEXT DEFAULT 'copy', external_path TEXT DEFAULT '', external_key TEXT DEFAULT '',
      file_stamp TEXT DEFAULT '', tags TEXT DEFAULT '[]', author TEXT DEFAULT '',
      publication TEXT DEFAULT '', doi TEXT DEFAULT '', title_key TEXT DEFAULT '', sha256 TEXT DEFAULT '',
      size_bytes INTEGER DEFAULT 0, path TEXT DEFAULT '', doc_type TEXT DEFAULT '',
      folder_id TEXT DEFAULT '', manual_order REAL DEFAULT 0
    );
    CREATE TABLE notes(
      id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, quote TEXT, content TEXT,
      external_key TEXT DEFAULT '', folder_path TEXT DEFAULT '', tags TEXT DEFAULT '[]',
      created TEXT DEFAULT CURRENT_TIMESTAMP, deleted INTEGER DEFAULT 0, manual_order REAL DEFAULT 0
    );
    CREATE TABLE annotations(
      id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, quote TEXT, content TEXT, rects TEXT,
      color TEXT, deleted INTEGER DEFAULT 0, style TEXT DEFAULT 'highlight',
      translation_excerpt TEXT DEFAULT '', external_key TEXT DEFAULT '',
      created TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const insertDocument = db.prepare(
    'INSERT INTO documents(id, name, pages, current_page, created, deleted, storage_kind) VALUES (?, ?, ?, ?, ?, 0, ?)'
  );
  insertDocument.run('legacy-ai-doc', 'legacy-ai.pdf', 1, 1, '2026-01-01T00:00:00Z', 'copy');
  insertDocument.run('legacy-user-doc', 'legacy-user.pdf', 1, 1, '2026-01-01T00:00:00Z', 'copy');
  const insertNote = db.prepare(
    'INSERT INTO notes(id, document_id, page, quote, content, created) VALUES (?, ?, 1, ?, ?, ?)'
  );
  insertNote.run(
    'legacy-ai-note',
    'legacy-ai-doc',
    '',
    `（AI 生成内容 · 可能出错，请核实原文）\n\n迁移前的 AI 回答正文`,
    '2026-01-01T00:00:00Z'
  );
  insertNote.run(
    'legacy-user-note',
    'legacy-user-doc',
    '',
    '用户自己写的笔记，没有 AI 标识。',
    '2026-01-01T00:00:00Z'
  );
  db.prepare(
    'INSERT INTO annotations(id, document_id, page, quote, content) VALUES (?, ?, 1, ?, ?)'
  ).run('legacy-ann', 'legacy-user-doc', '原文一句', '用户自己写的批注。');
  db.close();
}

describe('笔记/批注 origin 字段：写入与读回', () => {
  it('AI 写入显式置 ai；手写内容默认 user', async () => {
    const dir = mkdtempSync(path.join(root, 'field-'));
    const store = new Store(dir);
    try {
      const documentId = await importPdf(store, dir);

      const aiNote = store.createNote({
        documentId,
        page: 1,
        content: '无标识的 AI 回答正文',
        origin: 'ai'
      });
      expect(aiNote.origin).toBe('ai');

      const userNote = store.createNote({ documentId, page: 1, content: '用户手写笔记' });
      expect(userNote.origin).toBe('user');

      const aiAnnotation = store.createAnnotation({
        documentId,
        page: 1,
        quote: '原文一句',
        content: '无标识的 AI 译文',
        origin: 'ai'
      });
      expect(aiAnnotation.origin).toBe('ai');

      const userAnnotation = store.createAnnotation({
        documentId,
        page: 1,
        quote: '原文一句',
        content: '用户手写批注'
      });
      expect(userAnnotation.origin).toBe('user');

      // 读路径（列表/单条）也必须带回 origin，导出才能用字段优先判断。
      expect(store.listNotes(documentId).map((note) => note.origin)).toEqual(
        expect.arrayContaining(['ai', 'user'])
      );
      expect(store.getNote(aiNote.id)?.origin).toBe('ai');
      expect(store.listAnnotations(documentId).find((item) => item.id === aiAnnotation.id)?.origin).toBe(
        'ai'
      );
      expect(
        store.listAnnotations(documentId).find((item) => item.id === userAnnotation.id)?.origin
      ).toBe('user');
    } finally {
      store.close();
    }
  });

  it('POST /notes 与 POST /annotations 接受 origin，并拒绝非法值', async () => {
    const dir = mkdtempSync(path.join(root, 'routes-'));
    const store = new Store(dir);
    const token = 'origin-token';
    const server = buildServer({ token, version: 'test', store, secrets: new SecretStore() });
    try {
      const documentId = await importPdf(store, dir);
      const headers = { 'x-studianda-token': token };

      const aiNote = await server.inject({
        method: 'POST',
        url: '/api/v1/notes',
        headers,
        payload: { documentId, page: 1, content: '无标识的 AI 回答正文', origin: 'ai' }
      });
      expect(aiNote.statusCode).toBe(200);
      expect(aiNote.json().origin).toBe('ai');

      const userNote = await server.inject({
        method: 'POST',
        url: '/api/v1/notes',
        headers,
        payload: { documentId, page: 1, content: '用户手写笔记' }
      });
      expect(userNote.statusCode).toBe(200);
      expect(userNote.json().origin).toBe('user');

      const badNote = await server.inject({
        method: 'POST',
        url: '/api/v1/notes',
        headers,
        payload: { documentId, page: 1, content: '内容', origin: 'machine' }
      });
      expect(badNote.statusCode).toBe(400);

      const aiAnnotation = await server.inject({
        method: 'POST',
        url: '/api/v1/annotations',
        headers,
        payload: { documentId, page: 1, quote: '原文', content: '无标识的 AI 译文', origin: 'ai' }
      });
      expect(aiAnnotation.statusCode).toBe(200);
      expect(aiAnnotation.json().origin).toBe('ai');

      const badAnnotation = await server.inject({
        method: 'POST',
        url: '/api/v1/annotations',
        headers,
        payload: { documentId, page: 1, content: '内容', origin: 'machine' }
      });
      expect(badAnnotation.statusCode).toBe(400);
    } finally {
      await server.close();
      store.close();
    }
  });
});

describe('导出判定：字段优先、文本兜底', () => {
  it('核心价值：AI 笔记删掉正文里的标识文字后，导出仍判为 AI', async () => {
    const dir = mkdtempSync(path.join(root, 'core-value-'));
    const store = new Store(dir);
    try {
      const documentId = await importPdf(store, dir);
      // 系统「回答存为笔记」：正文带 AI 文件头，并显式标记 origin='ai'。
      const note = store.createNote({
        documentId,
        page: 1,
        content: withAiNoteHeader('这是 AI 回答正文。\n'),
        origin: 'ai'
      });
      expect(store.getNote(note.id)?.origin).toBe('ai');

      // 用户之后编辑笔记，把文件头与标识文字整段删掉：文本判断在此失效。
      store.updateNote(note.id, { content: '这是 AI 回答正文（用户删掉了标识文字）。' });
      const edited = store.getNote(note.id);
      expect(edited?.content).not.toContain('AI 生成内容');
      expect(edited?.origin).toBe('ai');

      // 字段优先：即使正文已经没有 AI 标识，导出仍必须写 aigc 文件头。
      const exported = store.exportMarkdown(documentId);
      expect(exported.markdown.startsWith('---\naigc: true\n')).toBe(true);
      expect(exported.markdown).toContain('> **AI 生成内容声明**');
    } finally {
      store.close();
    }
  });

  it('批注 origin=ai 同样触发导出标识，并写入带批注 PDF 的 AI 元数据', async () => {
    const dir = mkdtempSync(path.join(root, 'annotation-'));
    const store = new Store(dir);
    try {
      const documentId = await importPdf(store, dir);
      store.createAnnotation({
        documentId,
        page: 1,
        quote: '原文一句',
        content: '无标识的 AI 译文',
        origin: 'ai'
      });
      const exported = store.exportMarkdown(documentId);
      expect(exported.markdown.startsWith('---\naigc: true\n')).toBe(true);
    } finally {
      store.close();
    }

    // 带批注 PDF：字段命中 AI 时即使批注正文没有标识文字，也必须写 Info 字典 AI 元数据。
    const original = await makePdf();
    const aiResult = await buildAnnotatedPdf(original, [
      record({ content: '无标识的 AI 译文', origin: 'ai' })
    ]);
    const aiOutput = await PDFDocument.load(aiResult.bytes);
    expect(() => assertAiMetadataWritten(aiOutput)).not.toThrow();

    // 对照：纯用户批注（origin='user' 且无标识文字）不写 AI 元数据。
    const userResult = await buildAnnotatedPdf(original, [
      record({ content: '用户自己写的批注。', origin: 'user' })
    ]);
    const userOutput = await PDFDocument.load(userResult.bytes);
    expect(() => assertAiMetadataWritten(userOutput)).toThrow();
  });

  it('文本兜底：迁移前没有 origin 的 AI 标识内容仍被识别', async () => {
    const dir = mkdtempSync(path.join(root, 'text-fallback-'));
    const store = new Store(dir);
    try {
      const documentId = await importPdf(store, dir);
      // 模拟历史数据：字段是 user（老数据默认值兜底），正文还留着 AI 标识文字。
      const note = store.createNote({
        documentId,
        page: 1,
        content: `AI 回答正文\n\n${LEGACY_AI_MARKER}`
      });
      expect(note.origin).toBe('user');
      const exported = store.exportMarkdown(documentId);
      expect(exported.markdown.startsWith('---\naigc: true\n')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('老库迁移（无 origin 列）', () => {
  it('补列后能读、老行 origin=user，且文本兜底仍生效', async () => {
    const dir = mkdtempSync(path.join(root, 'legacy-'));
    setupLegacyDb(dir);

    const store = new Store(dir);
    try {
      // 迁移后两列都存在，老行按默认值 'user' 读出。
      const notes = store.listNotes('legacy-ai-doc');
      expect(notes).toHaveLength(1);
      expect(notes[0]?.origin).toBe('user');
      expect(notes[0]?.content).toContain('AI 生成内容');
      expect(store.listNotes('legacy-user-doc')[0]?.origin).toBe('user');
      expect(store.listAnnotations('legacy-user-doc')[0]?.origin).toBe('user');

      // 老库没有 origin 列，历史 AI 内容只靠文本兜底：仍必须导出 AI 标识。
      const legacyAiExport = store.exportMarkdown('legacy-ai-doc');
      expect(legacyAiExport.markdown.startsWith('---\naigc: true\n')).toBe(true);
      // 纯用户老内容不能误标。
      const legacyUserExport = store.exportMarkdown('legacy-user-doc');
      expect(legacyUserExport.markdown.startsWith('# ')).toBe(true);
      expect(legacyUserExport.markdown).not.toContain('aigc');

      // 迁移后新写入的 AI 内容走字段，老行不受影响。
      store.createNote({
        documentId: 'legacy-ai-doc',
        page: 1,
        content: '新写入的无标识 AI 内容',
        origin: 'ai'
      });
      const mixed = store.listNotes('legacy-ai-doc');
      expect(mixed.some((note) => note.origin === 'ai')).toBe(true);
      expect(mixed.some((note) => note.origin === 'user')).toBe(true);
    } finally {
      store.close();
    }

    // 幂等重开 + 版本号与列都在。
    const reopened = new Store(dir);
    try {
      expect(reopened.listNotes('legacy-ai-doc').some((note) => note.origin === 'ai')).toBe(true);
    } finally {
      reopened.close();
    }
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    try {
      const version = raw
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      expect(version?.value).toBe('27');
      for (const table of ['notes', 'annotations']) {
        const columns = (
          raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
        ).map((column) => column.name);
        expect(columns).toContain('origin');
      }
    } finally {
      raw.close();
    }
  });
});
