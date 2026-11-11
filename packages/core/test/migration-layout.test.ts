import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-migrate-layout-'));
const legacyDir = path.join(root, 'legacy');
const externalDir = path.join(root, 'zotero-pdfs');
mkdirSync(legacyDir, { recursive: true });
mkdirSync(externalDir, { recursive: true });

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上仍有句柄时清不掉临时目录；测试目录在系统临时区，留待系统清理。
  }
});

async function makePdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(text, { x: 40, y: 350, size: 20 });
  return pdf.save();
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createLegacyDb(objects: Record<string, Uint8Array>): string {
  // 新版资料目录的 documents 表：带 path / sha256 列，PDF 副本在 papers/<sha256>.pdf。
  const dbPath = path.join(legacyDir, 'reader.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents(
      id TEXT PRIMARY KEY, name TEXT, pages INTEGER, current_page INTEGER DEFAULT 1,
      created TEXT, deleted INTEGER DEFAULT 0, storage_kind TEXT DEFAULT 'copy',
      external_path TEXT DEFAULT '', external_key TEXT DEFAULT '', file_stamp TEXT DEFAULT '',
      tags TEXT DEFAULT '[]', author TEXT DEFAULT '', publication TEXT DEFAULT '',
      doi TEXT DEFAULT '', sha256 TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0,
      path TEXT DEFAULT ''
    );
    CREATE TABLE translation_segments(
      id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, segment INTEGER, source TEXT,
      source_hash TEXT, text TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO documents(id, name, pages, created, storage_kind, external_path, sha256, path)
     VALUES (?, ?, 1, '2026-01-01T00:00:00Z', ?, ?, ?, ?)`
  );

  // 1. 新版本布局：documents.path + papers/<sha256>.pdf。
  const copy = objects.copyByPath!;
  const copySha = sha256Of(copy);
  mkdirSync(path.join(legacyDir, 'papers'), { recursive: true });
  writeFileSync(path.join(legacyDir, 'papers', `${copySha}.pdf`), copy);
  insert.run(
    'doc-by-path',
    'by-path.pdf',
    'copy',
    '',
    copySha,
    path.join('papers', `${copySha}.pdf`)
  );

  // 2. 只有 papers/<文档 ID>.pdf，没有 path / sha256 记录。
  const byId = objects.byPapersId!;
  writeFileSync(path.join(legacyDir, 'papers', 'doc-by-papers-id.pdf'), byId);
  insert.run('doc-by-papers-id', 'by-papers-id.pdf', 'copy', '', '', '');

  // 3. 旧 Python 版布局：data 目录根部的 <文档 ID>.pdf。
  const byRoot = objects.byRootId!;
  writeFileSync(path.join(legacyDir, 'doc-by-root.pdf'), byRoot);
  insert.run('doc-by-root', 'by-root.pdf', 'copy', '', '', '');

  // 4. Zotero 外部路径。
  const zotero = objects.zotero!;
  const zoteroPath = path.join(externalDir, 'zotero-doc.pdf');
  writeFileSync(zoteroPath, zotero);
  insert.run('doc-zotero', 'zotero.pdf', 'zotero', zoteroPath, '', '');

  // 5. 没有任何 PDF，应当被跳过并给出提示。
  insert.run('doc-missing', 'missing.pdf', 'copy', '', 'f'.repeat(64), 'papers/missing.pdf');

  db.prepare(
    `INSERT INTO translation_segments(id, document_id, page, segment, source, source_hash, text)
     VALUES ('seg-1', 'doc-by-path', 1, 1, 'Legacy', 'hash', '旧译文')`
  ).run();
  db.close();
  return dbPath;
}

describe('legacy migration PDF layouts', () => {
  it('finds PDFs in papers/<sha256>.pdf, papers/<id>.pdf, root <id>.pdf and zotero paths', async () => {
    const objects = {
      copyByPath: await makePdf('copy by path'),
      byPapersId: await makePdf('copy in papers by id'),
      byRootId: await makePdf('copy in data root'),
      zotero: await makePdf('zotero external')
    };
    const dbPath = createLegacyDb(objects);
    const targetDir = path.join(root, 'target');
    mkdirSync(targetDir, { recursive: true });
    const store = new Store(targetDir);

    // 直接传 reader.sqlite3 文件路径也应接受，并把所在目录当作 data 目录。
    const report = store.migrateLegacy(dbPath);

    expect(report.documents).toBe(4);
    expect(report.skippedDocuments).toBe(1);
    expect(report.warnings.some((warning) => warning.includes('doc-missing'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('papers/'))).toBe(true);
    expect(report.translations).toBe(1);

    const documents = store.listDocuments();
    expect(documents).toHaveLength(4);
    const names = documents.map((document) => document.name).sort();
    expect(names).toEqual(
      ['by-papers-id.pdf', 'by-path.pdf', 'by-root.pdf', 'zotero.pdf'].sort()
    );

    for (const bytes of Object.values(objects)) {
      const sha = sha256Of(bytes);
      expect(existsSync(path.join(targetDir, 'papers', `${sha}.pdf`))).toBe(true);
    }
    for (const id of ['doc-by-path', 'doc-by-papers-id', 'doc-by-root', 'doc-zotero']) {
      const resolved = store.getDocumentPath(id);
      expect(resolved).toBeTruthy();
      expect(existsSync(resolved as string)).toBe(true);
    }
    expect(store.getDocumentPath('doc-missing')).toBeNull();
    store.close();
  });

  it('can be re-run after the PDFs are connected, without duplicating migrated rows', async () => {
    const targetDir = path.join(root, 'target-retry');
    mkdirSync(targetDir, { recursive: true });
    const store = new Store(targetDir);

    // 第一轮：源目录只有数据库，PDF 全部缺失，文档被跳过，译文仍会复制。
    const firstLegacy = path.join(root, 'legacy-retry');
    mkdirSync(firstLegacy, { recursive: true });
    const dbPath = path.join(firstLegacy, 'reader.sqlite3');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE documents(
        id TEXT PRIMARY KEY, name TEXT, pages INTEGER, created TEXT, deleted INTEGER DEFAULT 0,
        storage_kind TEXT DEFAULT 'copy', external_path TEXT DEFAULT '', external_key TEXT DEFAULT '',
        file_stamp TEXT DEFAULT '', tags TEXT DEFAULT '[]', author TEXT DEFAULT '', sha256 TEXT DEFAULT '',
        path TEXT DEFAULT ''
      );
      CREATE TABLE translation_segments(id TEXT PRIMARY KEY, document_id TEXT, page INTEGER, text TEXT);
    `);
    db.prepare(
      `INSERT INTO documents(id, name, pages, created, sha256, path)
       VALUES ('retry-doc', 'retry.pdf', 1, '2026-01-01T00:00:00Z', ?, ?)`
    ).run('a'.repeat(64), path.join('papers', `${'a'.repeat(64)}.pdf`));
    db.prepare(
      "INSERT INTO translation_segments(id, document_id, page, text) VALUES ('seg-1', 'retry-doc', 1, '旧译文')"
    ).run();
    db.close();

    const first = store.migrateLegacy(firstLegacy);
    expect(first.documents).toBe(0);
    expect(first.skippedDocuments).toBe(1);
    // 文档被跳过时，它名下的译文也不应先进新库，避免出现指向不存在文献的孤儿数据。
    expect(first.translations).toBe(0);
    expect(store.listDocuments()).toHaveLength(0);

    // 第二轮：补上 PDF 后重新迁移，文档入库，已有的译文行不会重复或报错。
    const pdf = await makePdf('recovered');
    const sha = sha256Of(pdf);
    const recorded = path.join('papers', `${'a'.repeat(64)}.pdf`);
    const retryPdf = path.join(firstLegacy, recorded);
    mkdirSync(path.dirname(retryPdf), { recursive: true });
    writeFileSync(retryPdf, pdf);

    const second = store.migrateLegacy(firstLegacy);
    expect(second.documents).toBe(1);
    expect(second.skippedDocuments).toBe(0);
    // 上一轮被文档过滤掉的译文，在文档入库后随下一轮迁移补上。
    expect(second.translations).toBe(1);
    expect(store.listDocuments()).toHaveLength(1);
    const resolved = store.getDocumentPath('retry-doc');
    expect(resolved).toBeTruthy();
    expect(sha256Of(readFileSync(resolved as string))).toBe(sha);
    store.close();
  });
});
