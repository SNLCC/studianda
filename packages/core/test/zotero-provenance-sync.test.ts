import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mergeMetadataField,
  shouldOverwriteMetadataValue
} from '../src/metadata-provenance.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { syncZoteroCollection, zoteroAttachment } from '../src/zotero.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-provenance-'));
const COLLECTION_KEY = 'COLL0001';

const pdfPath = {
  zoteroA: path.join(root, 'zotero-a.pdf'),
  zoteroB: path.join(root, 'zotero-b.pdf'),
  authored: path.join(root, 'authored.pdf'),
  firstPageDoi: path.join(root, 'first-page-doi.pdf'),
  plain: path.join(root, 'plain.pdf'),
  relink: path.join(root, 'relink.pdf'),
  provenanceOnly: path.join(root, 'provenance-only.pdf')
};

async function makePdf(
  target: string,
  input: { text: string; author?: string; title?: string }
): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(input.text, { x: 40, y: 350, size: 14 });
  if (input.author) pdf.setAuthor(input.author);
  if (input.title) pdf.setTitle(input.title);
  writeFileSync(target, await pdf.save());
}

beforeAll(async () => {
  await makePdf(pdfPath.zoteroA, { text: 'ZOTERO ITEM A BODY' });
  await makePdf(pdfPath.zoteroB, { text: 'ZOTERO ITEM B BODY' });
  await makePdf(pdfPath.authored, { text: 'AUTHORED PDF BODY', author: 'Ada Lovelace' });
  await makePdf(pdfPath.firstPageDoi, {
    text: 'https://doi.org/10.5555/first.page body text'
  });
  await makePdf(pdfPath.plain, { text: 'PLAIN PDF BODY' });
  await makePdf(pdfPath.relink, { text: 'RELINK PDF BODY', author: 'PDF Author' });
  await makePdf(pdfPath.provenanceOnly, { text: 'PROVENANCE ONLY BODY' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function rawDb(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

interface MockZoteroItem {
  key: string;
  title: string;
  author: string;
  publication: string;
  doi: string;
  attachmentKey: string;
  pdfPath: string;
  deleted: boolean;
}

interface MockZoteroState {
  name: string;
  collectionKeys: string[];
  items: MockZoteroItem[];
}

function itemData(item: MockZoteroItem): Record<string, unknown> {
  return {
    itemType: 'journalArticle',
    title: item.title,
    creators: [{ creatorType: 'author', lastName: item.author }],
    publicationTitle: item.publication,
    DOI: item.doi
  };
}

function createZoteroMock(state: MockZoteroState) {
  return createServer((request, response) => {
    const url = request.url ?? '';
    const sendJson = (status: number, value: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(value));
    };

    // 分类顶层条目列表（分页参数由 sync 自身拼，mock 只需按 start/limit 切片）。
    if (url.includes(`/collections/${COLLECTION_KEY}/items/top`)) {
      const parsed = new URL(url, 'http://127.0.0.1');
      const start = Number(parsed.searchParams.get('start') ?? '0');
      const limit = Number(parsed.searchParams.get('limit') ?? '100');
      const rows = state.collectionKeys.slice(start, start + limit).flatMap((key) => {
        const item = state.items.find((candidate) => candidate.key === key);
        if (!item) {
          // 列表里有、但按 key 取不到（模拟上限用例里的无效条目）。
          return [{ key, data: { itemType: 'journalArticle', title: `未命名 ${key}` } }];
        }
        return [{ key: item.key, data: itemData(item) }];
      });
      sendJson(200, rows);
      return;
    }
    if (url.includes(`/collections/${COLLECTION_KEY}?`)) {
      sendJson(200, { key: COLLECTION_KEY, data: { name: state.name } });
      return;
    }
    const children = /\/items\/([A-Z0-9]{8})\/children/.exec(url);
    if (children) {
      const item = state.items.find((candidate) => candidate.key === children[1]);
      if (!item) {
        sendJson(404, {});
        return;
      }
      sendJson(200, [
        {
          key: item.attachmentKey,
          data: {
            itemType: 'attachment',
            contentType: 'application/pdf',
            parentItem: item.key
          }
        }
      ]);
      return;
    }
    const file = /\/items\/([A-Z0-9]{8})\/file/.exec(url);
    if (file) {
      const item = state.items.find((candidate) => candidate.attachmentKey === file[1]);
      if (!item) {
        sendJson(404, {});
        return;
      }
      response.statusCode = 302;
      response.setHeader('location', pathToFileURL(item.pdfPath).href);
      response.end();
      return;
    }
    const one = /\/items\/([A-Z0-9]{8})(?:\?|$)/.exec(url);
    if (one) {
      const item = state.items.find((candidate) => candidate.key === one[1]);
      if (!item || item.deleted) {
        sendJson(404, {});
        return;
      }
      sendJson(200, { key: item.key, data: itemData(item) });
      return;
    }
    sendJson(404, { error: 'unexpected mock request', url });
  });
}

async function withMockZotero(
  state: MockZoteroState,
  run: (base: string) => Promise<void>
): Promise<void> {
  const mock = createZoteroMock(state);
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  if (address == null || typeof address === 'string') throw new Error('mock address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      mock.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function syncState(): MockZoteroState {
  return {
    name: 'Reading',
    collectionKeys: ['ITEM0001', 'ITEM0002'],
    items: [
      {
        key: 'ITEM0001',
        title: 'Zotero Paper A',
        author: 'Ada Lovelace',
        publication: 'Journal A',
        doi: '10.5555/a',
        attachmentKey: 'ATTACH01',
        pdfPath: pdfPath.zoteroA,
        deleted: false
      },
      {
        key: 'ITEM0002',
        title: 'Zotero Paper B',
        author: 'Alan Turing',
        publication: 'Journal B',
        doi: '10.5555/b',
        attachmentKey: 'ATTACH02',
        pdfPath: pdfPath.zoteroB,
        deleted: false
      }
    ]
  };
}

describe('题录来源（metadata_source）', () => {
  it('Zotero 导入写 zotero，旧记录/未知值读取为 null', async () => {
    const store = storeAt('provenance-zotero');
    const secrets = new SecretStore();
    const state = syncState();
    try {
      await withMockZotero(state, async (base) => {
        const attachment = await zoteroAttachment(store, secrets, 'ITEM0001', base);
        expect(attachment.zoteroItemKey).toBe('ITEM0001');
        const document = await store.importZoteroDocument(attachment);
        expect(document.metadataSource).toBe('zotero');
        expect(document.zoteroMissing).toBe(false);

        // schema_version 25 老库没有来源信息：读取接口按 NULL 返回，不猜。
        rawDb(store)
          .prepare("UPDATE documents SET metadata_source = '' WHERE id = ?")
          .run(document.id);
        expect(store.getDocument(document.id)?.metadataSource).toBeNull();
        rawDb(store)
          .prepare("UPDATE documents SET metadata_source = 'bogus_source' WHERE id = ?")
          .run(document.id);
        expect(store.getDocument(document.id)?.metadataSource).toBeNull();

        // 读取接口（HTTP）同样明确返回 null，而不是猜成某个来源。
        rawDb(store)
          .prepare("UPDATE documents SET metadata_source = '' WHERE id = ?")
          .run(document.id);
        const server = buildServer({ token: 'test-token', version: 'test-version', store, secrets });
        try {
          const response = await server.inject({
            method: 'GET',
            url: `/api/v1/documents/${document.id}`,
            headers: { 'x-studianda-token': 'test-token' }
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({ metadataSource: null, zoteroMissing: false });
        } finally {
          await server.close();
        }
      });
    } finally {
      store.close();
    }
  });

  it('普通导入按实际字段来源标记 pdf_xmp / pdf_first_page / filename', async () => {
    const store = storeAt('provenance-plain');
    try {
      const authored = await store.importDocument(pdfPath.authored);
      expect(authored.metadataSource).toBe('pdf_xmp');
      const firstPage = await store.importDocument(pdfPath.firstPageDoi);
      expect(firstPage.metadataSource).toBe('pdf_first_page');
      const plain = await store.importDocument(pdfPath.plain);
      expect(plain.metadataSource).toBe('filename');
    } finally {
      store.close();
    }
  });

  it('覆盖规则：低优先级不覆盖高优先级、manual 不被自动覆盖', async () => {
    // 纯规则：来源优先级 + 同等级刷新 + manual 保护。
    expect(
      shouldOverwriteMetadataValue({
        existingValue: 'Zotero 标题',
        existingSource: 'zotero',
        incomingSource: 'filename'
      })
    ).toBe(false);
    expect(
      shouldOverwriteMetadataValue({
        existingValue: 'Zotero 标题',
        existingSource: 'zotero',
        incomingSource: 'zotero'
      })
    ).toBe(true);
    expect(
      shouldOverwriteMetadataValue({
        existingValue: '用户标题',
        existingSource: 'manual',
        incomingSource: 'zotero'
      })
    ).toBe(false);
    expect(
      shouldOverwriteMetadataValue({
        existingValue: '',
        existingSource: 'manual',
        incomingSource: 'filename'
      })
    ).toBe(true);
    expect(
      shouldOverwriteMetadataValue({
        existingValue: '旧值',
        existingSource: null,
        incomingSource: 'zotero'
      })
    ).toBe(true);
    expect(
      shouldOverwriteMetadataValue({
        existingValue: '旧值',
        existingSource: 'pdf_xmp',
        incomingSource: 'filename'
      })
    ).toBe(false);
    expect(mergeMetadataField('保留', 'zotero', '新值', 'filename').value).toBe('保留');
    expect(mergeMetadataField('保留', 'manual', '', 'zotero').value).toBe('保留');

    const store = storeAt('provenance-rules');
    const secrets = new SecretStore();
    const state = syncState();
    // 规则用例单独用一份 PDF：relink 成功后会把旧外部文件清掉（既有行为），
    // 不能拿后面 collection 同步还要用的共享夹具。
    state.items[0] = { ...state.items[0]!, pdfPath: pdfPath.provenanceOnly };
    try {
      await withMockZotero(state, async (base) => {
        const attachment = await zoteroAttachment(store, secrets, 'ITEM0001', base);
        const document = await store.importZoteroDocument(attachment);
        expect(document.metadataSource).toBe('zotero');

        // 1) 用户手改作者 → manual；Zotero 再同步不覆盖。
        store.updateDocument(document.id, { author: '用户手改作者' });
        expect(store.getDocument(document.id)?.metadataSource).toBe('manual');
        // Zotero 元数据变化后重新打开同一附件：作者必须保留用户手改值。
        const reopenedAttachment = await zoteroAttachment(store, secrets, 'ITEM0001', base);
        const reopened = await store.importZoteroDocument({
          ...reopenedAttachment,
          confirmDuplicate: true
        });
        expect(reopened.author).toBe('用户手改作者');
        expect(reopened.metadataSource).toBe('manual');

        // 2) 高优先级（zotero）不被低优先级（pdf_xmp）覆盖：relink 换 PDF 不覆盖作者。
        const beforeRelink = store.getDocument(document.id)!;
        await store.relinkDocument(document.id, pdfPath.relink);
        const afterRelink = store.getDocument(document.id)!;
        expect(afterRelink.author).toBe('用户手改作者');
        expect(afterRelink.metadataSource).toBe('manual');
        expect(afterRelink.pages).toBe(beforeRelink.pages);
      });
    } finally {
      store.close();
    }
  });

  it('v25 老库升级：新增列默认值可用，版本升到 26，来源仍为 null', async () => {
    const store = storeAt('migrate-v25');
    const document = await store.importDocument(pdfPath.plain);
    store.close();

    const raw = new DatabaseSync(path.join(root, 'migrate-v25', 'reader.sqlite3'));
    raw.exec('DROP INDEX IF EXISTS document_zotero_item');
    for (const column of [
      'metadata_source',
      'zotero_item_key',
      'zotero_collection_key',
      'zotero_missing'
    ]) {
      raw.exec(`ALTER TABLE documents DROP COLUMN ${column}`);
    }
    raw.exec("UPDATE schema_meta SET value = '25' WHERE key = 'schema_version'");
    raw.close();

    const reopened = new Store(path.join(root, 'migrate-v25'));
    try {
      const version = (
        rawDb(reopened)
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as { value?: string }
      ).value;
      expect(version).toBe('26');
      const migrated = reopened.getDocument(document.id);
      expect(migrated?.metadataSource).toBeNull();
      expect(migrated?.zoteroMissing).toBe(false);
    } finally {
      reopened.close();
    }
  });
});

describe('Zotero collection 增量同步', () => {
  it('二次同步不产生重复行，字段更新生效，用户标签/笔记/批注保留，Zotero 删除只标记', async () => {
    const store = storeAt('sync-incremental');
    // 本用例验证「按 provenance 刷新字段」的既有语义；保留标题开关的默认值会拦住
    // Zotero 侧标题更新，因此这里显式关闭（开关本身另有专测）。
    store.updateSettings({ 'zotero.sync_preserve_local_title': 'false' });
    const secrets = new SecretStore();
    const state = syncState();
    try {
      await withMockZotero(state, async (base) => {
        const first = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(first).toMatchObject({
          collectionKey: COLLECTION_KEY,
          collectionName: 'Reading',
          fetched: 2,
          inserted: 2,
          updated: 0,
          skippedDuplicates: 0,
          skippedDeleted: 0,
          failed: 0,
          markedMissing: 0,
          removedFromCollection: 0,
          complete: true
        });
        const initial = store.listDocuments();
        expect(initial).toHaveLength(2);
        const docA = initial.find((candidate) => candidate.name === 'Zotero Paper A');
        const docB = initial.find((candidate) => candidate.name === 'Zotero Paper B');
        expect(docA?.metadataSource).toBe('zotero');
        expect(docB?.zoteroMissing).toBe(false);
        if (!docA || !docB) throw new Error('missing synced documents');

        // 用户数据：标签、批注、笔记、手动改名（改名 = manual，同步不覆盖）。
        store.setDocumentTags(docA.id, ['用户标签', '重点']);
        store.createAnnotation({
          documentId: docA.id,
          page: 1,
          quote: 'ZOTERO ITEM A BODY',
          content: '用户批注'
        });
        store.createNote({ documentId: docA.id, page: 1, content: '用户笔记' });

        // Zotero 侧：条目 A 字段更新；条目 B 从 collection 删除并删除到回收站。
        const itemA = state.items[0]!;
        state.items[0] = {
          ...itemA,
          title: 'Zotero Paper A 修订版',
          author: 'Grace Hopper',
          publication: 'Journal A Revised',
          doi: '10.5555/a.revised'
        };
        state.collectionKeys = ['ITEM0001'];
        state.items[1] = { ...state.items[1]!, deleted: true };

        const second = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(second.fetched).toBe(1);
        expect(second.inserted).toBe(0);
        expect(second.updated).toBe(1);
        expect(second.skippedDuplicates).toBe(0);
        expect(second.markedMissing).toBe(1);
        expect(second.failed).toBe(0);

        // 行数不变（没有重复插入），字段更新生效，用户数据完整保留。
        const afterSecond = store.listDocuments();
        expect(afterSecond).toHaveLength(2);
        const updatedA = store.getDocument(docA.id)!;
        expect(updatedA.name).toBe('Zotero Paper A 修订版');
        expect(updatedA.author).toBe('Grace Hopper');
        expect(updatedA.publication).toBe('Journal A Revised');
        expect(updatedA.tags).toEqual(['用户标签', '重点']);
        expect(updatedA.metadataSource).toBe('zotero');
        expect(store.listAnnotations(docA.id)).toHaveLength(1);
        expect(store.listNotes(docA.id)).toHaveLength(1);

        // Zotero 侧已删除：本地文献不消失，只标记 zotero_missing，数据仍在。
        const keptB = afterSecond.find((candidate) => candidate.id === docB.id);
        expect(keptB).toBeDefined();
        expect(store.getDocument(docB.id)?.zoteroMissing).toBe(true);

        // 第三次同步：幂等（不再新增/标记变化），仍然只有 2 行。
        const third = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(third.inserted).toBe(0);
        expect(third.updated).toBe(1);
        expect(third.markedMissing).toBe(0);
        expect(store.listDocuments()).toHaveLength(2);
        expect(store.getDocument(docB.id)?.zoteroMissing).toBe(true);
      });
    } finally {
      store.close();
    }
  });

  it('条目仍在 Zotero、只是移出 collection：不删除、不标缺失，仅清 collection 归属', async () => {
    const store = storeAt('sync-removed');
    const secrets = new SecretStore();
    const state = syncState();
    try {
      await withMockZotero(state, async (base) => {
        await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        const docs = store.listDocuments();
        expect(docs).toHaveLength(2);
        const docB = docs.find((candidate) => candidate.name === 'Zotero Paper B')!;

        state.collectionKeys = ['ITEM0001'];
        const report = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(report.removedFromCollection).toBe(1);
        expect(report.markedMissing).toBe(0);
        const kept = store.getDocument(docB.id);
        expect(kept).not.toBeNull();
        expect(kept?.zoteroMissing).toBe(false);
        expect(
          store
            .listZoteroCollectionDocuments(COLLECTION_KEY)
            .some((row) => row.documentId === docB.id)
        ).toBe(false);
      });
    } finally {
      store.close();
    }
  });

  it('新条目重复检测：本地已有同 DOI 文献时不重复插入，按 skippedDuplicate 报告', async () => {
    const store = storeAt('sync-duplicate');
    const secrets = new SecretStore();
    // 先手工导入一篇同 DOI 的 PDF（模拟用户自己的副本）。
    const manual = await store.importDocument(pdfPath.plain);
    expect(manual.metadataSource).toBe('filename');
    const state = syncState();
    state.collectionKeys = ['ITEM0001'];
    state.items[0] = {
      ...state.items[0]!,
      title: 'Zotero Paper A',
      author: '',
      publication: '',
      doi: '10.5555/duplicate'
    };
    // 让手工副本带上同一 DOI，触发同步查重。
    rawDb(store)
      .prepare('UPDATE documents SET doi = ? WHERE id = ?')
      .run('10.5555/duplicate', manual.id);
    try {
      await withMockZotero(state, async (base) => {
        const report = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(report.skippedDuplicates).toBe(1);
        expect(report.inserted).toBe(0);
        expect(store.listDocuments()).toHaveLength(1);
      });
    } finally {
      store.close();
    }
  });

  it('超过单次同步上限时不完整，且不做缺失标记', async () => {
    const store = storeAt('sync-limit');
    const secrets = new SecretStore();
    const state = syncState();
    // 1000 个条目（= MAX_ZOTERO_SYNC_ITEMS）且都在 Zotero 取不到附件：
    // 同步必须走满上限并标记 complete=false，而不是把没读到的部分当成已删除。
    state.items = [];
    state.collectionKeys = Array.from(
      { length: 1000 },
      (_, index) => `ITEM${String(index).padStart(4, '0')}`
    );
    try {
      await withMockZotero(state, async (base) => {
        const report = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(report.complete).toBe(false);
        expect(report.fetched).toBe(1000);
        expect(report.warnings.some((warning) => warning.includes('上限'))).toBe(true);
        expect(report.markedMissing).toBe(0);
      });
    } finally {
      store.close();
    }
  });
});

describe('Zotero collection 同步：保留本地标题开关', () => {
  const SETTING = 'zotero.sync_preserve_local_title';

  /** 只同步 ITEM0001 的最小状态，避免别的条目干扰计数。 */
  function oneItemState(): MockZoteroState {
    const state = syncState();
    state.collectionKeys = ['ITEM0001'];
    state.items = [state.items[0]!];
    return state;
  }

  function setLocalLegacyTitle(store: Store, documentId: string, title: string): void {
    // 模拟迁移前老记录：本地标题被用户改过，但 metadata_source 为空（不是 manual）。
    rawDb(store)
      .prepare("UPDATE documents SET name = ?, metadata_source = '' WHERE id = ?")
      .run(title, documentId);
  }

  function storedDoi(store: Store, documentId: string): string {
    const row = rawDb(store)
      .prepare('SELECT doi FROM documents WHERE id = ?')
      .get(documentId) as { doi?: string } | undefined;
    return String(row?.doi ?? '');
  }

  it('默认开启：本地标题不同则保留并计数，其余字段仍更新；二次同步幂等', async () => {
    const store = storeAt('preserve-title-default-on');
    const secrets = new SecretStore();
    const state = oneItemState();
    try {
      await withMockZotero(state, async (base) => {
        const first = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(first.inserted).toBe(1);
        expect(first.preserved_titles).toBe(0);
        const document = store.listDocuments()[0]!;
        setLocalLegacyTitle(store, document.id, '用户手改标题');

        state.items[0] = {
          ...state.items[0]!,
          title: 'Zotero Paper A 修订版',
          author: 'Grace Hopper',
          publication: 'Journal A Revised',
          doi: '10.5555/a.revised'
        };
        const second = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(second.updated).toBe(1);
        expect(second.preserved_titles).toBe(1);

        const kept = store.getDocument(document.id)!;
        // 标题保留本地值；其余字段仍按来源优先级被 Zotero 刷新。
        expect(kept.name).toBe('用户手改标题');
        expect(kept.author).toBe('Grace Hopper');
        expect(kept.publication).toBe('Journal A Revised');
        expect(storedDoi(store, document.id)).toBe('10.5555/a.revised');
        expect(kept.metadataSource).toBe('zotero');

        // 再同步一次：行数、标题、保留计数都稳定（幂等）。
        const third = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(third.inserted).toBe(0);
        expect(third.updated).toBe(1);
        expect(third.preserved_titles).toBe(1);
        expect(store.listDocuments()).toHaveLength(1);
        expect(store.getDocument(document.id)?.name).toBe('用户手改标题');
      });
    } finally {
      store.close();
    }
  });

  it('关闭开关：非 manual 本地标题按现有 provenance 规则被 Zotero 覆盖', async () => {
    const store = storeAt('preserve-title-off');
    store.updateSettings({ [SETTING]: 'false' });
    const secrets = new SecretStore();
    const state = oneItemState();
    try {
      await withMockZotero(state, async (base) => {
        const first = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(first.preserved_titles).toBe(0);
        const document = store.listDocuments()[0]!;
        setLocalLegacyTitle(store, document.id, '用户手改标题');

        state.items[0] = {
          ...state.items[0]!,
          title: 'Zotero Paper A 修订版',
          author: 'Grace Hopper'
        };
        const second = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(second.updated).toBe(1);
        expect(second.preserved_titles).toBe(0);

        const kept = store.getDocument(document.id)!;
        expect(kept.name).toBe('Zotero Paper A 修订版');
        expect(kept.author).toBe('Grace Hopper');
        expect(kept.metadataSource).toBe('zotero');
      });
    } finally {
      store.close();
    }
  });

  it('关闭开关不等于强制覆盖 manual：用户手改的标题与作者仍不被覆盖', async () => {
    const store = storeAt('preserve-title-manual-off');
    store.updateSettings({ [SETTING]: 'false' });
    const secrets = new SecretStore();
    const state = oneItemState();
    try {
      await withMockZotero(state, async (base) => {
        await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        const document = store.listDocuments()[0]!;
        store.updateDocument(document.id, { name: '用户手工标题', author: '用户作者' });
        expect(store.getDocument(document.id)?.metadataSource).toBe('manual');

        state.items[0] = {
          ...state.items[0]!,
          title: 'Zotero 新标题',
          author: 'Grace Hopper'
        };
        const second = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
        expect(second.updated).toBe(1);
        expect(second.preserved_titles).toBe(0);

        const kept = store.getDocument(document.id)!;
        expect(kept.name).toBe('用户手工标题');
        expect(kept.author).toBe('用户作者');
        expect(kept.metadataSource).toBe('manual');
      });
    } finally {
      store.close();
    }
  });

  it('新建条目在开关开启/关闭两种情况下都用传入标题', async () => {
    const state = oneItemState();
    try {
      await withMockZotero(state, async (base) => {
        for (const value of ['true', 'false'] as const) {
          const store = storeAt(`preserve-title-insert-${value}`);
          store.updateSettings({ [SETTING]: value });
          const secrets = new SecretStore();
          try {
            const report = await syncZoteroCollection(store, secrets, COLLECTION_KEY, base);
            expect(report.inserted).toBe(1);
            expect(report.preserved_titles).toBe(0);
            expect(store.listDocuments()[0]?.name).toBe('Zotero Paper A');
          } finally {
            store.close();
          }
        }
      });
    } finally {
      // withMockZotero 负责关闭 mock；这里没有额外资源需要释放。
    }
  });

  it('设置键沿用现有 /settings 接口读写，默认值由 core 读取时补上', async () => {
    const store = storeAt('preserve-title-setting-io');
    const server = buildServer({
      token: 'test-token',
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    try {
      const headers = { 'x-studianda-token': 'test-token' };
      const put = await server.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers,
        payload: { [SETTING]: 'false' }
      });
      expect(put.statusCode).toBe(200);
      const get = await server.inject({ method: 'GET', url: '/api/v1/settings', headers });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({ [SETTING]: 'false' });
      expect(store.getSettings()[SETTING]).toBe('false');
    } finally {
      await server.close();
      store.close();
    }
  });
});
