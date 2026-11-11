import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migrate-'));
const legacyDir = path.join(root, 'legacy-data');
const newDir = path.join(root, 'new-data');
mkdirSync(legacyDir, { recursive: true });
mkdirSync(newDir, { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText('Legacy page', { x: 40, y: 350, size: 20 });
  return pdf.save();
}

function setupLegacy(): void {
  writeFileSync(path.join(legacyDir, 'legacy-doc.pdf'), LEGACY_PDF);

  const db = new DatabaseSync(path.join(legacyDir, 'reader.sqlite3'));
  db.exec(`
    CREATE TABLE documents(
      id TEXT PRIMARY KEY, name TEXT, pages INTEGER, current_page INTEGER, created TEXT,
      deleted INTEGER DEFAULT 0, storage_kind TEXT DEFAULT 'copy', external_path TEXT DEFAULT '',
      external_key TEXT DEFAULT '', file_stamp TEXT DEFAULT '', tags TEXT DEFAULT '[]', author TEXT DEFAULT ''
    );
    CREATE TABLE chunks(
      id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, text TEXT, bbox TEXT, bbox_space TEXT DEFAULT 'legacy'
    );
    CREATE TABLE annotations(
      id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, quote TEXT, content TEXT, rects TEXT,
      color TEXT, deleted INTEGER DEFAULT 0, style TEXT DEFAULT 'highlight', translation_excerpt TEXT DEFAULT '',
      external_key TEXT DEFAULT ''
    );
    CREATE TABLE notes(id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, quote TEXT, content TEXT, created TEXT, deleted INTEGER DEFAULT 0);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, document_id TEXT, role TEXT, content TEXT, sources TEXT, created TEXT, metadata TEXT DEFAULT '{}');
  `);
  db.prepare(
    `INSERT INTO documents(id, name, pages, current_page, created, deleted, storage_kind, author)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('legacy-doc', 'legacy.pdf', 1, 2, '2026-01-01T00:00:00Z', 0, 'copy', 'Legacy Author');
  db.prepare(
    `INSERT INTO documents(id, name, pages, current_page, created, deleted, storage_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('missing-doc', 'missing.pdf', 1, 1, '2026-01-01T00:00:00Z', 0, 'copy');
  db.prepare(
    'INSERT INTO chunks(id, document_id, page, text, bbox) VALUES (?, ?, ?, ?, ?)'
  ).run('chunk-1', 'legacy-doc', 1, 'Legacy page with retrieval text.', '');
  db.prepare(
    `INSERT INTO annotations(id, document_id, page, quote, content, rects, color, style)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ann-1', 'legacy-doc', 1, 'Legacy page', '旧批注', '', 'yellow', 'highlight');
  db.prepare(
    'INSERT INTO notes(id, document_id, page, quote, content, created) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('note-1', 'legacy-doc', 1, 'quote', '旧笔记', '2026-01-01T00:00:00Z');
  db.prepare(
    'INSERT INTO messages(id, document_id, role, content, sources) VALUES (?, ?, ?, ?, ?)'
  ).run(7, 'legacy-doc', 'user', '旧消息', '[]');
  db.exec(`
    CREATE TABLE translation_pages(
      document_id TEXT, page INTEGER, source_hash TEXT, engine TEXT, status TEXT, error TEXT,
      done INTEGER, total INTEGER, updated TEXT, PRIMARY KEY(document_id, page)
    );
    CREATE TABLE translation_segments(
      id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, segment INTEGER, source TEXT,
      source_hash TEXT, text TEXT, engine TEXT, service TEXT, terms TEXT, unknown_terms TEXT,
      coverage REAL, edited INTEGER, origin TEXT, previous_text TEXT, previous_origin TEXT,
      created TEXT, updated TEXT
    );
    CREATE TABLE page_edits(document_id TEXT, page INTEGER, version TEXT, text TEXT, origin TEXT, boxes TEXT, PRIMARY KEY(document_id, page));
    CREATE TABLE doc_navigation(document_id TEXT, page INTEGER, kind TEXT, label TEXT, created TEXT, PRIMARY KEY(document_id, page, kind));
    CREATE TABLE doc_navigation_state(document_id TEXT PRIMARY KEY, enabled INTEGER, built_at TEXT, source_hash TEXT, node_count INTEGER, last_used TEXT, file_stamp TEXT, mask_revision TEXT, build_state TEXT, error TEXT);
    CREATE TABLE page_masks(id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, x0 REAL, y0 REAL, x1 REAL, y1 REAL, created TEXT);
    CREATE TABLE platform_connections(id TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(
    'INSERT INTO translation_pages(document_id, page, source_hash, engine, status, done, total) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('legacy-doc', 1, 'hash', 'mock', 'done', 1, 1);
  db.prepare(
    'INSERT INTO translation_segments(id, document_id, page, segment, source, text) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('seg-1', 'legacy-doc', 1, 1, 'Legacy page', '旧译文');
  db.prepare(
    'INSERT INTO page_edits(document_id, page, version, text, origin, boxes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('legacy-doc', 1, 'v1', '旧页面编辑', 'ocr', '[]');
  db.prepare(
    'INSERT INTO doc_navigation(document_id, page, kind, label) VALUES (?, ?, ?, ?)'
  ).run('legacy-doc', 1, 'heading', '旧导航');
  db.prepare('INSERT INTO doc_navigation_state(document_id) VALUES (?)').run('legacy-doc');
  db.prepare(
    'INSERT INTO page_masks(id, document_id, page, x0, y0, x1, y1) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('mask-1', 'legacy-doc', 1, 0, 0, 1, 0.1);
  db.prepare('INSERT INTO platform_connections(id, value) VALUES (?, ?)').run('zotero', '{}');
  db.close();

  const reading = new DatabaseSync(path.join(legacyDir, 'reading.sqlite3'));
  reading.exec(`
    CREATE TABLE reading_tasks(task TEXT PRIMARY KEY, payload TEXT, documents TEXT, updated REAL);
    CREATE TABLE checkpoints(task TEXT, stage TEXT, value TEXT, documents TEXT, updated REAL, PRIMARY KEY(task, stage));
  `);
  reading.prepare('INSERT INTO reading_tasks(task, payload, documents, updated) VALUES (?, ?, ?, ?)').run('task-1', '{}', '[]', 1);
  reading.prepare('INSERT INTO checkpoints(task, stage, value, documents, updated) VALUES (?, ?, ?, ?, ?)').run('task-1', 'stage-1', '{}', '[]', 1);
  reading.close();

  const structure = new DatabaseSync(path.join(legacyDir, 'structure.sqlite3'));
  structure.exec(`
    CREATE TABLE pages(path TEXT, page INTEGER, version TEXT, value TEXT, PRIMARY KEY(path, page));
    CREATE TABLE structures(document TEXT PRIMARY KEY, path TEXT, version TEXT, value TEXT);
  `);
  structure.prepare('INSERT INTO pages(path, page, version, value) VALUES (?, ?, ?, ?)').run('p', 1, 'v', '{}');
  structure.prepare('INSERT INTO structures(document, path, version, value) VALUES (?, ?, ?, ?)').run(
    'legacy-doc',
    'p',
    'v',
    JSON.stringify({ sections: [{ title: 'Legacy Section', page: 1, level: 1 }] })
  );
  structure.close();

  const vectors = new DatabaseSync(path.join(legacyDir, 'vectors.sqlite3'));
  vectors.exec('CREATE TABLE vectors(key TEXT PRIMARY KEY, value TEXT)');
  vectors.prepare('INSERT INTO vectors(key, value) VALUES (?, ?)').run(
    'legacy-key',
    JSON.stringify([0.1, 0.2, 0.3])
  );
  vectors.close();
}

let LEGACY_PDF: Uint8Array;

describe('legacy migration', () => {
  it('copies documents, chunks, annotations, notes, messages, settings and vector cache', async () => {
    LEGACY_PDF = await makePdf();
    setupLegacy();
    const store = new Store(newDir);
    const report = store.migrateLegacy(legacyDir);

    expect(report.documents).toBe(1);
    expect(report.skippedDocuments).toBe(1);
    expect(report.chunks).toBe(1);
    expect(report.annotations).toBe(1);
    expect(report.notes).toBe(1);
    expect(report.messages).toBe(1);
    expect(report.settings).toBe(0);
    expect(report.embeddings).toBe(1);
    expect(report.translations).toBe(2);
    expect(report.pageEdits).toBe(1);
    expect(report.navigation).toBe(2);
    expect(report.pageMasks).toBe(1);
    expect(report.readingTasks).toBe(2);
    expect(report.structures).toBe(2);
    expect(report.connections).toBe(1);
    expect(report.backupPath).toBeTruthy();
    expect(existsSync(report.backupPath as string)).toBe(true);

    const documents = store.listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.name).toBe('legacy.pdf');
    expect(documents[0]?.currentPage).toBe(2);
    expect(store.listAnnotations('legacy-doc')).toHaveLength(1);
    // 旧版模型设置不再迁移：模型配置只走「模型服务」。
    // 迁移会写入资源索引统计（note_assets.*），除此之外不应有旧设置残留。
    const migratedSettings = store.getSettings();
    expect(Object.keys(migratedSettings).every((key) => key.startsWith('note_assets.'))).toBe(true);
    expect(store.countChunks()).toBe(1);
    expect(store.countEmbeddingCache()).toBe(1);
    const derived = store.listDerivedChunks(['legacy-doc']);
    expect(derived.some((row) => row.text.includes('Legacy Section'))).toBe(true);
    expect(derived.some((row) => row.translation && row.text.includes('旧译文'))).toBe(true);
    expect(existsSync(path.join(newDir, 'papers'))).toBe(true);
    expect(store.search('retrieval', 'legacy-doc')).toHaveLength(1);
    store.close();
  });
});
