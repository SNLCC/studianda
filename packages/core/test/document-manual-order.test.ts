import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { DocumentDetail, DocumentSummary } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-manual-order-'));
const token = 'test-token';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

async function makePdfBytes(label: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(`Manual order fixture ${label}`, { x: 40, y: 350, size: 16 });
  return pdf.save();
}

async function importPdf(store: Store, label: string): Promise<DocumentDetail> {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await makePdfBytes(label));
  return store.importDocument(file, `${label}.pdf`, true);
}

/** 默认排序（manualOrder 升序）下的文献 label 顺序。 */
function manualOrder(store: Store): string[] {
  return store
    .listDocuments()
    .slice()
    .sort((left, right) => (left.manualOrder ?? 0) - (right.manualOrder ?? 0))
    .map((document) => document.name.replace(/\.pdf$/i, ''));
}

function schemaVersion(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return String(row?.value ?? '');
}

function manualOrders(db: DatabaseSync): Array<{ id: string; manual_order: number }> {
  return db
    .prepare('SELECT id, manual_order FROM documents ORDER BY manual_order ASC')
    .all() as unknown as Array<{ id: string; manual_order: number }>;
}

describe('schema_version 8 → 9（默认排序位置）', () => {
  it('新库直接带 manual_order，版本为 9', () => {
    const store = storeAt('schema-new');
    store.close();
    const raw = new DatabaseSync(path.join(root, 'schema-new', 'reader.sqlite3'));
    try {
      const columns = (
        raw.prepare('PRAGMA table_info(documents)').all() as unknown as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toContain('manual_order');
      expect(schemaVersion(raw)).toBe('18');
    } finally {
      raw.close();
    }
  });

  it('v8 老库补列并按原展示顺序回填，重开幂等', () => {
    const dir = path.join(root, 'schema-v8');
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
        path TEXT DEFAULT '',
        doc_type TEXT DEFAULT '',
        folder_id TEXT DEFAULT ''
      );
    `);
    const insert = legacy.prepare(
      `INSERT INTO documents(id, name, pages, current_page, created, deleted)
       VALUES (?, ?, 1, 1, ?, 0)`
    );
    insert.run('oldest', '最旧.pdf', '2026-01-01T00:00:00Z');
    insert.run('middle', '中间.pdf', '2026-02-01T00:00:00Z');
    insert.run('newest', '最新.pdf', '2026-03-01T00:00:00Z');
    legacy
      .prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '8')")
      .run();
    legacy.close();

    const migrated = new Store(dir);
    // 升级瞬间的列表顺序是 created DESC（最新在前），manual_order 必须与其一致。
    expect(migrated.listDocuments().map((document) => document.id)).toEqual([
      'newest',
      'middle',
      'oldest'
    ]);
    expect(migrated.listDocuments().map((document) => document.manualOrder)).toEqual([1, 2, 3]);
    migrated.close();

    // 幂等：再打开不重复回填、不改顺序，且迁移后的位置可正常拖拽。
    const reopened = new Store(dir);
    expect(reopened.listDocuments().map((document) => document.manualOrder)).toEqual([1, 2, 3]);
    const moved = reopened.moveDocument('oldest', {
      beforeId: null,
      afterId: 'newest'
    });
    expect(moved.manualOrder).toBeLessThan(1);
    expect(
      reopened.listDocuments().slice().sort((a, b) => (a.manualOrder ?? 0) - (b.manualOrder ?? 0))[0]
        ?.id
    ).toBe('oldest');
    reopened.close();

    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    try {
      expect(schemaVersion(raw)).toBe('18');
      const values = manualOrders(raw).map((row) => row.manual_order);
      expect(new Set(values).size).toBe(values.length);
    } finally {
      raw.close();
    }
  });
});

describe('新文献追加到默认排序末尾', () => {
  it('普通导入按 1,2,3 递增；回收站文献也占位', async () => {
    const store = storeAt('append-import');
    try {
      const first = await importPdf(store, 'append-a');
      const second = await importPdf(store, 'append-b');
      const third = await importPdf(store, 'append-c');
      expect([first.manualOrder, second.manualOrder, third.manualOrder]).toEqual([1, 2, 3]);

      // 删除（回收站）不释放位置：恢复后顺序不变，新导入仍追加在全局末尾。
      store.deleteDocument(second.id);
      const fourth = await importPdf(store, 'append-d');
      expect(fourth.manualOrder).toBe(4);
      store.restoreDocument(second.id);
      expect(store.getDocument(second.id)?.manualOrder).toBe(2);
      expect(manualOrder(store)).toEqual(['append-a', 'append-b', 'append-c', 'append-d']);

      // 改标题/类型/文件夹/作者不影响默认排序位置。
      const folder = store.createFolder('追加测试');
      const updated = store.updateDocument(fourth.id, {
        name: '改名后',
        docType: 'book',
        folderId: folder.id
      });
      expect(updated?.manualOrder).toBe(4);
    } finally {
      store.close();
    }
  });

  it('Zotero 打开与旧库迁移导入都追加到末尾', async () => {
    const store = storeAt('append-zotero');
    try {
      const first = await importPdf(store, 'append-z-a');
      const bytes = await makePdfBytes('zotero');
      const zotero = await store.importZoteroDocument({
        identity: 'test:users:0:legacy:ITEM0001',
        title: 'Zotero 文献',
        author: 'Zotero Author',
        bytes
      });
      if (!first) throw new Error('import failed');
      expect(zotero.manualOrder).toBe(2);

      // 旧版目录迁移：文档追加在已有位置之后。
      const legacyDir = path.join(root, 'legacy-source');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(path.join(legacyDir, 'legacy-a.pdf'), await makePdfBytes('legacy-a'));
      writeFileSync(path.join(legacyDir, 'legacy-b.pdf'), await makePdfBytes('legacy-b'));
      const legacyDb = new DatabaseSync(path.join(legacyDir, 'reader.sqlite3'));
      legacyDb.exec(`
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
          author TEXT DEFAULT ''
        );
      `);
      const insert = legacyDb.prepare(
        'INSERT INTO documents(id, name, pages, current_page, created, deleted) VALUES (?, ?, 1, 1, ?, 0)'
      );
      insert.run('legacy-a', '旧库甲.pdf', '2026-01-01T00:00:00Z');
      insert.run('legacy-b', '旧库乙.pdf', '2026-01-02T00:00:00Z');
      legacyDb.close();

      const report = store.migrateLegacy(legacyDir);
      expect(report.documents).toBe(2);
      const migratedOrders = store
        .listDocuments()
        .filter((document) => document.id === 'legacy-a' || document.id === 'legacy-b')
        .map((document) => ({ id: document.id, order: document.manualOrder }))
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
      expect(migratedOrders).toEqual([
        { id: 'legacy-a', order: 3 },
        { id: 'legacy-b', order: 4 }
      ]);
    } finally {
      store.close();
    }
  });
});

describe('moveDocument 默认排序拖拽', () => {
  async function seedStore(name: string): Promise<{
    store: Store;
    ids: { a: string; b: string; c: string; d: string };
  }> {
    const store = storeAt(name);
    const ids = { a: '', b: '', c: '', d: '' };
    for (const label of ['a', 'b', 'c', 'd'] as const) {
      const document = await importPdf(store, `${name}-${label}`);
      ids[label] = document.id;
    }
    return { store, ids };
  }

  it('移到最前 / 最后 / 两篇之间', async () => {
    const { store, ids } = await seedStore('move-basic');
    try {
      expect(manualOrder(store)).toEqual(['move-basic-a', 'move-basic-b', 'move-basic-c', 'move-basic-d']);

      const toFront = store.moveDocument(ids.d, { beforeId: null, afterId: ids.a });
      expect(toFront.manualOrder).toBeLessThan(store.getDocument(ids.a)?.manualOrder ?? 0);
      expect(manualOrder(store)).toEqual(['move-basic-d', 'move-basic-a', 'move-basic-b', 'move-basic-c']);

      const toEnd = store.moveDocument(ids.d, { beforeId: ids.c, afterId: null });
      expect(manualOrder(store)).toEqual(['move-basic-a', 'move-basic-b', 'move-basic-c', 'move-basic-d']);

      const between = store.moveDocument(ids.d, { beforeId: ids.b, afterId: ids.c });
      expect(between.manualOrder).toBeGreaterThan(store.getDocument(ids.b)?.manualOrder ?? 0);
      expect(between.manualOrder).toBeLessThan(store.getDocument(ids.c)?.manualOrder ?? 0);
      expect(manualOrder(store)).toEqual(['move-basic-a', 'move-basic-b', 'move-basic-d', 'move-basic-c']);
    } finally {
      store.close();
    }
  });

  it('相邻两篇互换，重复调用幂等', async () => {
    const { store, ids } = await seedStore('move-swap');
    try {
      store.moveDocument(ids.a, { beforeId: ids.b, afterId: ids.c });
      expect(manualOrder(store)).toEqual(['move-swap-b', 'move-swap-a', 'move-swap-c', 'move-swap-d']);

      store.moveDocument(ids.b, { beforeId: ids.a, afterId: ids.c });
      expect(manualOrder(store)).toEqual(['move-swap-a', 'move-swap-b', 'move-swap-c', 'move-swap-d']);

      // 已经在该相对位置：重复调用不改位置（幂等），仍返回成功。
      const before = store.getDocument(ids.b)?.manualOrder;
      const again = store.moveDocument(ids.b, { beforeId: ids.a, afterId: ids.c });
      expect(again.manualOrder).toBe(before);
      expect(manualOrder(store)).toEqual(['move-swap-a', 'move-swap-b', 'move-swap-c', 'move-swap-d']);
    } finally {
      store.close();
    }
  });

  it('浮点间隙耗尽时先全局重排，结果仍正确', async () => {
    const { store, ids } = await seedStore('move-decimal');
    // 关库后手工把 a/b 的间隙压到 1e-9 以下，模拟反复插中间把 double 耗尽。
    const dir = path.join(root, 'move-decimal');
    store.close();
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    raw.prepare("UPDATE documents SET manual_order = 1 WHERE id = ?").run(ids.a);
    raw.prepare("UPDATE documents SET manual_order = 1.0000000000001 WHERE id = ?").run(ids.c);
    raw.prepare("UPDATE documents SET manual_order = 2 WHERE id = ?").run(ids.b);
    raw.prepare("UPDATE documents SET manual_order = 2.5 WHERE id = ?").run(ids.d);
    raw.close();

    const reopened = new Store(dir);
    try {
      // 重排后按 (manual_order, rowid) 变成 a=1,c=2,b=3,d=4，再取 a/b 中点 2 → 被 c 占用时退半格。
      const moved = reopened.moveDocument(ids.d, { beforeId: ids.a, afterId: ids.b });
      const a = reopened.getDocument(ids.a)?.manualOrder ?? 0;
      const b = reopened.getDocument(ids.b)?.manualOrder ?? 0;
      expect(moved.manualOrder).toBeGreaterThan(a);
      expect(moved.manualOrder).toBeLessThan(b);
      expect(manualOrder(reopened)).toEqual([
        'move-decimal-a',
        'move-decimal-c',
        'move-decimal-d',
        'move-decimal-b'
      ]);
    } finally {
      reopened.close();
    }
  });

  it('中点撞到其它文献时重排后再定位', async () => {
    const { store, ids } = await seedStore('move-collision');
    const dir = path.join(root, 'move-collision');
    store.close();
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    raw.prepare("UPDATE documents SET manual_order = 1 WHERE id = ?").run(ids.a);
    raw.prepare("UPDATE documents SET manual_order = 2 WHERE id = ?").run(ids.b);
    raw.prepare("UPDATE documents SET manual_order = 1.5 WHERE id = ?").run(ids.c);
    raw.prepare("UPDATE documents SET manual_order = 4 WHERE id = ?").run(ids.d);
    raw.close();

    const reopened = new Store(dir);
    try {
      const moved = reopened.moveDocument(ids.d, { beforeId: ids.a, afterId: ids.b });
      expect(moved.manualOrder).toBeGreaterThan(reopened.getDocument(ids.a)?.manualOrder ?? 0);
      expect(moved.manualOrder).toBeLessThan(reopened.getDocument(ids.b)?.manualOrder ?? 0);
      expect(manualOrder(reopened)).toEqual([
        'move-collision-a',
        'move-collision-c',
        'move-collision-d',
        'move-collision-b'
      ]);
    } finally {
      reopened.close();
    }
  });

  it('目标/邻居不存在或参数非法时给出中文错误', async () => {
    const { store, ids } = await seedStore('move-errors');
    try {
      expect(() => store.moveDocument('missing-document', { beforeId: ids.a, afterId: ids.b })).toThrow(
        '文献不存在'
      );
      expect(() => store.moveDocument(ids.d, { beforeId: 'missing', afterId: ids.a })).toThrow(
        '相邻文献不存在'
      );
      expect(() => store.moveDocument(ids.d, { beforeId: ids.a, afterId: 'missing' })).toThrow(
        '相邻文献不存在'
      );
      expect(() => store.moveDocument(ids.d, { beforeId: null, afterId: null })).toThrow(
        '需要提供 beforeId 或 afterId'
      );
      expect(() => store.moveDocument(ids.d, { beforeId: ids.d, afterId: ids.a })).toThrow(
        '相邻文献不能是目标文献本身'
      );
      expect(() => store.moveDocument(ids.d, { beforeId: ids.c, afterId: ids.a })).toThrow(
        '相邻文献顺序无效'
      );

      // 回收站里的文献不可拖拽（与列表一致）。
      store.deleteDocument(ids.d);
      expect(() => store.moveDocument(ids.d, { beforeId: null, afterId: ids.a })).toThrow(
        '文献不存在'
      );
    } finally {
      store.close();
    }
  });
});

describe('DocumentSummary/DocumentDetail 的 manualOrder 字段', () => {
  it('列表、详情、回收站都带数字 manualOrder', async () => {
    const store = storeAt('dto-manual');
    try {
      const document = await importPdf(store, 'dto-manual-a');
      expect(document.manualOrder).toBe(1);
      expect(store.getDocument(document.id)?.manualOrder).toBe(1);
      const listed: DocumentSummary[] = store.listDocuments();
      expect(listed[0]?.manualOrder).toBe(1);
      store.deleteDocument(document.id);
      expect(store.listDocuments(true)[0]?.manualOrder).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('POST /api/v1/documents/:id/move', () => {
  const dataDir = path.join(root, 'move-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('200 返回更新后的 DocumentDetail 并改变默认排序', async () => {
    const a = await importPdf(store, 'http-manual-a');
    const b = await importPdf(store, 'http-manual-b');
    const c = await importPdf(store, 'http-manual-c');
    expect([a.manualOrder, b.manualOrder, c.manualOrder]).toEqual([1, 2, 3]);

    // a 从最前移到最后（afterId=null），位置变成 c 之后的 4。
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(a.id)}/move`,
      headers: headers(),
      payload: { beforeId: c.id, afterId: null }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: a.id });
    expect((response.json() as DocumentDetail).manualOrder).toBe(4);
    expect(store.getDocument(c.id)?.manualOrder).toBe(3);

    // 再移回最前（beforeId=null），位置应小于 b。
    const toFront = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(a.id)}/move`,
      headers: headers(),
      payload: { beforeId: null, afterId: b.id }
    });
    expect(toFront.statusCode).toBe(200);
    expect((toFront.json() as DocumentDetail).manualOrder).toBeLessThan(
      store.getDocument(b.id)?.manualOrder ?? 0
    );
  });

  it('参数非法→400，文献/邻居不存在→404', async () => {
    const a = await importPdf(store, 'http-manual-d');
    const b = await importPdf(store, 'http-manual-e');

    const missingBoth = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(a.id)}/move`,
      headers: headers(),
      payload: {}
    });
    expect(missingBoth.statusCode).toBe(400);

    const badType = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(a.id)}/move`,
      headers: headers(),
      payload: { beforeId: 42 }
    });
    expect(badType.statusCode).toBe(400);

    const missingDocument = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/missing-document/move',
      headers: headers(),
      payload: { beforeId: null, afterId: b.id }
    });
    expect(missingDocument.statusCode).toBe(404);

    const missingNeighbor = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(a.id)}/move`,
      headers: headers(),
      payload: { beforeId: 'missing-neighbor', afterId: null }
    });
    expect(missingNeighbor.statusCode).toBe(404);
  });
});
