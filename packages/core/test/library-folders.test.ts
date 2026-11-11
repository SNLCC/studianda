import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { DocumentDetail, FolderSummary } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-library-folders-'));
const token = 'test-token';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

async function makePdfBytes(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(text, { x: 40, y: 350, size: 20 });
  return pdf.save();
}

async function importPdf(store: Store, label: string): Promise<DocumentDetail> {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await makePdfBytes(`Library fixture ${label}`));
  return store.importDocument(file, `${label}.pdf`, true);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function schemaVersion(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return String(row?.value ?? '');
}

describe('schema_version 7 → 8（文件类型 + 文件夹）', () => {
  it('新库带 doc_type/folder_id 与 folders 表，版本为 8', () => {
    const store = storeAt('schema-new');
    store.close();

    const raw = new DatabaseSync(path.join(root, 'schema-new', 'reader.sqlite3'));
    try {
      const columns = columnNames(raw, 'documents');
      expect(columns).toContain('doc_type');
      expect(columns).toContain('folder_id');
      const folders = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
        .get() as { name?: string } | undefined;
      expect(folders?.name).toBe('folders');
      const indexNames = (
        raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'document%'")
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexNames).toContain('document_folder');
      expect(schemaVersion(raw)).toBe('18');
    } finally {
      raw.close();
    }
  });

  it('老 v7 库补列、幂等重开，旧文献按未分类处理', () => {
    const dir = path.join(root, 'schema-legacy');
    mkdirSync(dir, { recursive: true });
    const legacy = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    legacy.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents(
        id TEXT PRIMARY KEY,
        name TEXT,
        pages INTEGER,
        current_page INTEGER,
        created TEXT,
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
        path TEXT DEFAULT ''
      );
    `);
    legacy
      .prepare(
        'INSERT INTO documents(id, name, pages, current_page, created, deleted) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('old-doc', '迁移前的旧文献', 1, 1, '2026-01-01T00:00:00Z', 0);
    legacy
      .prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '7')")
      .run();
    legacy.close();

    const migrated = new Store(dir);
    const documents = migrated.listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: 'old-doc',
      name: '迁移前的旧文献',
      docType: '',
      docCategory: 'unknown',
      folderId: ''
    });
    expect(migrated.listFolders()).toEqual({
      folders: [],
      unfiled: {
        id: '',
        name: '未分类',
        created: '',
        counts: { total: 1, book: 0, paper: 0, other: 0, unknown: 1 }
      }
    });
    migrated.close();

    // 幂等：再打开一次不抛错，数据与列都在，迁移后的库可以正常建文件夹。
    const reopened = new Store(dir);
    expect(reopened.listDocuments()[0]?.id).toBe('old-doc');
    expect(reopened.createFolder('迁移后可写').name).toBe('迁移后可写');
    reopened.close();

    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    try {
      expect(schemaVersion(raw)).toBe('18');
      expect(columnNames(raw, 'documents')).toEqual(
        expect.arrayContaining(['doc_type', 'folder_id'])
      );
      expect(columnNames(raw, 'folders')).toEqual(
        expect.arrayContaining(['id', 'name', 'created'])
      );
      const row = raw.prepare("SELECT doc_type, folder_id FROM documents WHERE id = 'old-doc'").get() as {
        doc_type?: string;
        folder_id?: string;
      };
      expect(row).toEqual({ doc_type: '', folder_id: '' });
    } finally {
      raw.close();
    }
  });
});

describe('文件夹 CRUD 与重名校验', () => {
  it('创建/列表/重命名文件夹，拒绝空名、超长与重名', () => {
    const store = storeAt('folders-crud');
    try {
      expect(store.listFolders()).toEqual({
        folders: [],
        unfiled: {
          id: '',
          name: '未分类',
          created: '',
          counts: { total: 0, book: 0, paper: 0, other: 0, unknown: 0 }
        }
      });

      const reading = store.createFolder('  阅读  ');
      expect(reading.name).toBe('阅读');
      expect(reading.id).not.toBe('');
      expect(typeof reading.created).toBe('string');
      expect(reading.counts).toEqual({ total: 0, book: 0, paper: 0, other: 0, unknown: 0 });

      expect(() => store.createFolder('   ')).toThrow('请输入文件夹名称');
      expect(() => store.createFolder('x'.repeat(61))).toThrow('文件夹名称过长');
      expect(() => store.createFolder('阅读')).toThrow('已存在同名文件夹');

      const paper = store.createFolder('Paper');
      // 重名比较大小写不敏感，避免侧栏出现两个只差大小写的文件夹。
      expect(() => store.createFolder('paper')).toThrow('已存在同名文件夹');

      expect(store.renameFolder(paper.id, '文献')).toMatchObject({ id: paper.id, name: '文献' });
      expect(store.renameFolder(reading.id, '阅读')).toMatchObject({ id: reading.id, name: '阅读' });
      expect(() => store.renameFolder(paper.id, '阅读')).toThrow('已存在同名文件夹');
      expect(() => store.renameFolder('missing-folder', '任意')).toThrow('文件夹不存在');
      expect(() => store.renameFolder(reading.id, '')).toThrow('请输入文件夹名称');

      const overview = store.listFolders();
      expect(overview.folders.map((folder) => folder.name).sort()).toEqual(['文献', '阅读'].sort());
      expect(overview.unfiled.id).toBe('');
    } finally {
      store.close();
    }
  });

  it('删除文件夹只把文献（含回收站）移回未分类，不删文献', async () => {
    const store = storeAt('folders-delete');
    try {
      const folder = store.createFolder('待删文件夹');
      const first = await importPdf(store, 'delete-a');
      const second = await importPdf(store, 'delete-b');
      const trashed = await importPdf(store, 'delete-c');
      for (const document of [first, second, trashed]) {
        store.updateDocument(document.id, { folderId: folder.id });
      }
      store.deleteDocument(trashed.id);

      expect(store.deleteFolder(folder.id)).toEqual({ movedDocuments: 2 });
      expect(store.listFolders().folders).toEqual([]);
      expect(store.listFolders().unfiled.counts.total).toBe(2);
      expect(store.getDocument(first.id)?.folderId).toBe('');
      expect(store.getDocument(second.id)?.folderId).toBe('');
      // 回收站里的文献同样移出：恢复后不会指向一个已不存在的文件夹。
      expect(store.listDocuments(true).find((doc) => doc.id === trashed.id)?.folderId).toBe('');
      expect(() => store.deleteFolder(folder.id)).toThrow('文件夹不存在');
    } finally {
      store.close();
    }
  });
});

describe('文件夹/未分类的分栏计数', () => {
  it('按著作/论文/其他/未分类统计，回收站不计入，类型改动即时生效', async () => {
    const store = storeAt('folders-counts');
    try {
      const book = await importPdf(store, 'count-book');
      const paper = await importPdf(store, 'count-paper');
      const other = await importPdf(store, 'count-other');
      await importPdf(store, 'count-unknown');
      const folder = store.createFolder('专题');
      store.updateDocument(book.id, { docType: 'book', folderId: folder.id });
      store.updateDocument(paper.id, { docType: 'journalArticle', folderId: folder.id });
      store.updateDocument(other.id, { docType: 'dataset', folderId: folder.id });

      let overview = store.listFolders();
      expect(overview.folders).toHaveLength(1);
      expect(overview.folders[0]?.counts).toEqual({
        total: 3,
        book: 1,
        paper: 1,
        other: 1,
        unknown: 0
      });
      expect(overview.unfiled.counts).toEqual({
        total: 1,
        book: 0,
        paper: 0,
        other: 0,
        unknown: 1
      });

      store.deleteDocument(other.id);
      overview = store.listFolders();
      expect(overview.folders[0]?.counts).toEqual({
        total: 2,
        book: 1,
        paper: 1,
        other: 0,
        unknown: 0
      });

      store.updateDocument(book.id, { docType: 'thesis' });
      overview = store.listFolders();
      expect(overview.folders[0]?.counts).toEqual({
        total: 2,
        book: 0,
        paper: 2,
        other: 0,
        unknown: 0
      });
    } finally {
      store.close();
    }
  });
});

describe('updateDocument 支持 docType / folderId', () => {
  it('校验文献类型与文件夹归属，并保持原有字段行为', async () => {
    const store = storeAt('folders-update');
    try {
      const document = await importPdf(store, 'update-a');
      const folder = store.createFolder('目标文件夹');

      const updated = store.updateDocument(document.id, {
        docType: '  thesis  ',
        folderId: folder.id,
        currentPage: 1,
        name: '改名后的文献',
        author: '新作者'
      });
      expect(updated).toMatchObject({
        docType: 'thesis',
        docCategory: 'paper',
        folderId: folder.id,
        name: '改名后的文献',
        author: '新作者'
      });

      expect(() => store.updateDocument(document.id, { folderId: 'missing-folder' })).toThrow(
        '文件夹不存在'
      );
      expect(() => store.updateDocument(document.id, { docType: 'x'.repeat(61) })).toThrow(
        '文献类型过长'
      );
      expect(() => store.updateDocument(document.id, { docType: 'a\u0000b' })).toThrow(
        '文献类型包含控制字符'
      );

      const cleared = store.updateDocument(document.id, { docType: '', folderId: '' });
      expect(cleared).toMatchObject({ docType: '', docCategory: 'unknown', folderId: '' });

      // 不存在的文献仍按原契约返回 null，由路由转 404。
      expect(store.updateDocument('missing-document', { docType: 'book' })).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('DocumentSummary/Detail 的 docType 字段', () => {
  it('导入、列表、详情、回收站都带 docType/docCategory/folderId', async () => {
    const store = storeAt('folders-dto');
    try {
      const document = await importPdf(store, 'dto-a');
      expect(document).toMatchObject({ docType: '', docCategory: 'unknown', folderId: '' });

      const folder = store.createFolder('DTO');
      store.updateDocument(document.id, { docType: 'book', folderId: folder.id });

      expect(store.getDocument(document.id)).toMatchObject({
        docType: 'book',
        docCategory: 'book',
        folderId: folder.id
      });
      expect(store.listDocuments()[0]).toMatchObject({
        docType: 'book',
        docCategory: 'book',
        folderId: folder.id
      });

      store.deleteDocument(document.id);
      expect(store.listDocuments()).toEqual([]);
      expect(store.listDocuments(true)[0]).toMatchObject({
        docType: 'book',
        docCategory: 'book',
        folderId: folder.id,
        deleted: true
      });
    } finally {
      store.close();
    }
  });
});

describe('文件夹 HTTP 路由', () => {
  const dataDir = path.join(root, 'folders-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  const server = buildServer({ token, version: 'test-version', store, secrets });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('提供 GET/POST/PATCH/DELETE /api/v1/folders', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: headers(),
      payload: { name: 'HTTP 阅读' }
    });
    expect(created.statusCode).toBe(200);
    const folder = created.json() as FolderSummary;
    expect(folder.name).toBe('HTTP 阅读');
    expect(folder.counts.total).toBe(0);

    const listed = await server.inject({ method: 'GET', url: '/api/v1/folders', headers: headers() });
    expect(listed.statusCode).toBe(200);
    const overview = listed.json() as { folders: FolderSummary[]; unfiled: FolderSummary };
    expect(overview.folders.map((entry) => entry.id)).toContain(folder.id);
    expect(overview.unfiled).toMatchObject({ id: '', name: '未分类' });

    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/v1/folders/${encodeURIComponent(folder.id)}`,
      headers: headers(),
      payload: { name: 'HTTP 精读' }
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as FolderSummary).name).toBe('HTTP 精读');

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/folders/${encodeURIComponent(folder.id)}`,
      headers: headers()
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ movedDocuments: 0 });
  });

  it('参数校验返回 400，找不到文件夹返回 404', async () => {
    const missingName = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: headers(),
      payload: {}
    });
    expect(missingName.statusCode).toBe(400);

    const blankName = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: headers(),
      payload: { name: '   ' }
    });
    expect(blankName.statusCode).toBe(400);

    const duplicate = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: headers(),
      payload: { name: '重复名' }
    });
    expect(duplicate.statusCode).toBe(200);
    const duplicated = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: headers(),
      payload: { name: '重复名' }
    });
    expect(duplicated.statusCode).toBe(400);

    const renameMissing = await server.inject({
      method: 'PATCH',
      url: '/api/v1/folders/missing-folder',
      headers: headers(),
      payload: { name: '新名字' }
    });
    expect(renameMissing.statusCode).toBe(404);

    const deleteMissing = await server.inject({
      method: 'DELETE',
      url: '/api/v1/folders/missing-folder',
      headers: headers()
    });
    expect(deleteMissing.statusCode).toBe(404);
  });

  it('PATCH /api/v1/documents/:id 透传 docType 与 folderId', async () => {
    const document = await importPdf(store, 'http-doc');
    const folder = store.createFolder('HTTP 文献夹');

    const updated = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(document.id)}`,
      headers: headers(),
      payload: { docType: 'journalArticle', folderId: folder.id }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      docType: 'journalArticle',
      docCategory: 'paper',
      folderId: folder.id
    });

    const listed = await server.inject({ method: 'GET', url: '/api/v1/documents', headers: headers() });
    expect(listed.statusCode).toBe(200);
    const documents = listed.json() as Array<Record<string, unknown>>;
    expect(documents[0]).toMatchObject({ docType: 'journalArticle', folderId: folder.id });

    const badFolder = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(document.id)}`,
      headers: headers(),
      payload: { folderId: 'missing-folder' }
    });
    expect(badFolder.statusCode).toBe(400);
    expect(badFolder.json()).toMatchObject({ message: '文件夹不存在' });

    const cleared = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(document.id)}`,
      headers: headers(),
      payload: { docType: '', folderId: '' }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ docType: '', docCategory: 'unknown', folderId: '' });
  });
});
