import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-asset-refs-'));
const token = 'test-token';
const DAY = 24 * 60 * 60 * 1000;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function assetDir(store: Store): string {
  return path.join(store.dataDir, 'note-assets');
}

const PNG_BYTES = Buffer.from(
  await (async () => {
    const canvas = createCanvas(2, 2);
    const context = canvas.getContext('2d');
    context.fillStyle = '#336699';
    context.fillRect(0, 0, 2, 2);
    return canvas.encode('png');
  })()
);

function pngDataUrl(): string {
  return `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
}

function writeAsset(store: Store, name: string, bytes = PNG_BYTES, ageMs = 0): string {
  const dir = assetDir(store);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(file, old, old);
  }
  return file;
}

function rows(
  db: DatabaseSync,
  sql: string,
  params: Array<string | number> = []
): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
}

describe('schema 10：note_assets / note_asset_refs 迁移回填', () => {
  it('v9 老库升级：登记磁盘文件、按内容建 refs、重算计数，重开幂等', () => {
    const dir = path.join(root, 'migration');
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    const file = writeAsset(store, 'legacy-image.png', PNG_BYTES, 2 * DAY);
    const note = store.createNote({
      documentId: '',
      page: 0,
      content: '![](studianda-asset://note-assets/legacy-image.png)'
    });
    store.close();

    // 模拟 v9：清掉新表内容并降级版本号。
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    raw.exec('DELETE FROM note_asset_refs');
    raw.exec('DELETE FROM note_assets');
    raw.exec("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'");
    raw.close();

    const migrated = new Store(dir);
    let indexedAt = '';
    try {
      const assets = (
        migrated as unknown as {
          db: DatabaseSync;
        }
      ).db;
      expect(rows(assets, 'SELECT * FROM note_assets')).toHaveLength(1);
      const asset = rows(assets, 'SELECT * FROM note_assets')[0]!;
      expect(asset.filename).toBe('legacy-image.png');
      expect(asset.mime).toBe('image/png');
      expect(Number(asset.size_bytes)).toBe(PNG_BYTES.length);
      expect(Number(asset.ref_count)).toBe(1);
      expect(String(asset.last_referenced)).not.toBe('');
      const refs = rows(assets, 'SELECT * FROM note_asset_refs');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({
        asset_id: asset.asset_id,
        source_kind: 'note',
        source_id: note.id
      });
      const version = rows(assets, "SELECT value FROM schema_meta WHERE key = 'schema_version'");
      expect(version[0]?.value).toBe('18');
      // 迁移回填同时写索引统计。
      const settings = migrated.getSettings();
      expect(settings['note_assets.indexed_files']).toBe('1');
      expect(settings['note_assets.indexed_refs']).toBe('1');
      indexedAt = String(settings['note_assets.indexed_at'] ?? '');
      expect(Number.isNaN(Date.parse(indexedAt))).toBe(false);
    } finally {
      migrated.close();
    }

    // 幂等：再打开一次不重复登记，索引统计时间不再被改写（版本已是 10，不再重建）。
    const reopened = new Store(dir);
    try {
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      expect(rows(db, 'SELECT * FROM note_assets')).toHaveLength(1);
      expect(rows(db, 'SELECT * FROM note_asset_refs')).toHaveLength(1);
      expect(readFileSync(file)).toEqual(PNG_BYTES);
      expect(reopened.getSettings()['note_assets.indexed_at']).toBe(indexedAt);
    } finally {
      reopened.close();
    }
  });
});

describe('引用同步 create/update/delete', () => {
  it('笔记增改同步 refs，改内容移除旧引用；软删除保留 refs', () => {
    const store = storeAt('sync-note');
    try {
      writeAsset(store, 'a.png');
      writeAsset(store, 'b.png');
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/a.png) ![](studianda-asset://note-assets/b.png)'
      });
      const db = (store as unknown as { db: DatabaseSync }).db;
      let refs = rows(db, 'SELECT * FROM note_asset_refs WHERE source_kind = ? AND source_id = ?', [
        'note',
        note.id
      ]);
      expect(refs).toHaveLength(2);

      store.updateNote(note.id, {
        content: '![](studianda-asset://note-assets/b.png)'
      });
      refs = rows(db, 'SELECT * FROM note_asset_refs WHERE source_kind = ? AND source_id = ?', [
        'note',
        note.id
      ]);
      expect(refs).toHaveLength(1);
      const bAsset = rows(db, "SELECT * FROM note_assets WHERE filename = 'b.png'")[0]!;
      expect(Number(bAsset.ref_count)).toBe(1);
      const aAsset = rows(db, "SELECT * FROM note_assets WHERE filename = 'a.png'")[0]!;
      expect(Number(aAsset.ref_count)).toBe(0);

      // 软删除笔记：refs 保留（restore-safe）。
      store.deleteNote(note.id);
      refs = rows(db, 'SELECT * FROM note_asset_refs WHERE source_kind = ? AND source_id = ?', [
        'note',
        note.id
      ]);
      expect(refs).toHaveLength(1);
      store.restoreNote(note.id);
      expect(rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [note.id])).toHaveLength(
        1
      );
    } finally {
      store.close();
    }
  });

  it('批注增改同步 refs，批注软删除也保留 refs', () => {
    const store = storeAt('sync-annotation');
    try {
      writeAsset(store, 'ann-a.png');
      const annotation = store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: '![](studianda-asset://note-assets/ann-a.png)',
        style: 'page'
      });
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [annotation.id])
      ).toHaveLength(1);

      store.updateAnnotation(annotation.id, { content: '无图片内容' });
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [annotation.id])
      ).toHaveLength(0);

      store.updateAnnotation(annotation.id, {
        content: '![](studianda-asset://note-assets/ann-a.png)'
      });
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [annotation.id])
      ).toHaveLength(1);
      store.deleteAnnotation(annotation.id);
      // 软删除保留 refs（GC includeDeleted=false 时会忽略）。
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [annotation.id])
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('saveNoteAsset 登记 note_assets 行（ref_count 0，可被引用同步接管）', async () => {
    const store = storeAt('sync-save');
    try {
      const asset = await store.saveNoteAsset({ dataUrl: pngDataUrl(), filename: '图.png' });
      const db = (store as unknown as { db: DatabaseSync }).db;
      const assetRow = rows(db, 'SELECT * FROM note_assets WHERE filename = ?', [
        `${asset.id}.png`
      ])[0]!;
      expect(Number(assetRow.ref_count)).toBe(0);
      expect(Number(assetRow.size_bytes)).toBe(PNG_BYTES.length);
      expect(assetRow.mime).toBe('image/png');

      store.createNote({
        documentId: '',
        page: 0,
        content: `![](${asset.url})`
      });
      const updated = rows(db, 'SELECT * FROM note_assets WHERE filename = ?', [
        `${asset.id}.png`
      ])[0]!;
      expect(Number(updated.ref_count)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('引用同步事务性（内容 + refs 同成同败）', () => {
  type SyncFn = (kind: 'note' | 'annotation', sourceId: string, content: string) => void;
  function patchSyncFailure(store: Store): () => void {
    const mutable = store as unknown as { syncNoteAssetRefs: SyncFn };
    const original = mutable.syncNoteAssetRefs;
    mutable.syncNoteAssetRefs = () => {
      throw new Error('injected-sync-failure');
    };
    return () => {
      mutable.syncNoteAssetRefs = original;
    };
  }

  it('createNote 同步失败时整条笔记回滚（不留下没有 refs 的内容）', () => {
    const store = storeAt('tx-create-note');
    try {
      writeAsset(store, 'tx-a.png');
      const db = (store as unknown as { db: DatabaseSync }).db;
      const restore = patchSyncFailure(store);
      try {
        expect(() =>
          store.createNote({
            documentId: '',
            page: 0,
            content: '![](studianda-asset://note-assets/tx-a.png)'
          })
        ).toThrow('injected-sync-failure');
      } finally {
        restore();
      }
      // 内容回滚：没有 note 行，也没有 refs/asset 行（asset 行由 sync 创建，同样回滚）。
      expect(rows(db, 'SELECT * FROM notes')).toHaveLength(0);
      expect(rows(db, 'SELECT * FROM note_asset_refs')).toHaveLength(0);
      expect(rows(db, 'SELECT * FROM note_assets')).toHaveLength(0);

      // 事务已正确回滚，后续写入正常。
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/tx-a.png)'
      });
      expect(rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [note.id])).toHaveLength(
        1
      );
    } finally {
      store.close();
    }
  });

  it('updateNote/updateAnnotation 同步失败时内容与 refs 都保持原样', () => {
    const store = storeAt('tx-update');
    try {
      writeAsset(store, 'tx-old.png');
      writeAsset(store, 'tx-new.png');
      const db = (store as unknown as { db: DatabaseSync }).db;
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/tx-old.png)'
      });
      const annotation = store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: '![](studianda-asset://note-assets/tx-old.png)',
        style: 'page'
      });

      const restore = patchSyncFailure(store);
      try {
        expect(() =>
          store.updateNote(note.id, {
            content: '![](studianda-asset://note-assets/tx-new.png)'
          })
        ).toThrow('injected-sync-failure');
        expect(() =>
          store.updateAnnotation(annotation.id, {
            content: '![](studianda-asset://note-assets/tx-new.png)'
          })
        ).toThrow('injected-sync-failure');
      } finally {
        restore();
      }

      // 内容回滚为旧值；refs 仍指向旧资源。
      const noteRow = rows(db, 'SELECT content FROM notes WHERE id = ?', [note.id])[0]!;
      expect(String(noteRow.content)).toContain('tx-old.png');
      expect(String(noteRow.content)).not.toContain('tx-new.png');
      const annotationRow = rows(db, 'SELECT content FROM annotations WHERE id = ?', [
        annotation.id
      ])[0]!;
      expect(String(annotationRow.content)).toContain('tx-old.png');
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id IN (?, ?)', [
          note.id,
          annotation.id
        ])
      ).toHaveLength(2);
      const oldAsset = rows(db, "SELECT * FROM note_assets WHERE filename = 'tx-old.png'")[0]!;
      expect(Number(oldAsset.ref_count)).toBe(2);
      const newAsset = rows(db, "SELECT * FROM note_assets WHERE filename = 'tx-new.png'")[0];
      expect(newAsset).toBeUndefined();

      // 恢复后更新正常，refs 切换。
      store.updateNote(note.id, {
        content: '![](studianda-asset://note-assets/tx-new.png)'
      });
      const newAssetAfter = rows(db, "SELECT * FROM note_assets WHERE filename = 'tx-new.png'")[0]!;
      expect(Number(newAssetAfter.ref_count)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('purgeNote（硬删除笔记 + 回收独占资源）', () => {
  it('共享资源只删最后一个引用者；独占资源立即释放', async () => {
    const store = storeAt('purge-note');
    try {
      const asset = await store.saveNoteAsset({ dataUrl: pngDataUrl() });
      const file = path.join(assetDir(store), `${asset.id}.png`);
      const first = store.createNote({
        documentId: '',
        page: 0,
        content: `![](${asset.url})`
      });
      const second = store.createNote({
        documentId: '',
        page: 0,
        content: `![](${asset.url})`
      });

      expect(store.purgeNote(first.id)).toEqual({ freedAssets: 0, freedBytes: 0 });
      expect(store.getNote(first.id)).toBeNull();
      expect(existsSync(file)).toBe(true);
      const afterFirst = store.purgeNote(second.id);
      expect(afterFirst.freedAssets).toBe(1);
      expect(afterFirst.freedBytes).toBe(PNG_BYTES.length);
      expect(existsSync(file)).toBe(false);
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(rows(db, 'SELECT * FROM note_assets')).toHaveLength(0);
      expect(rows(db, 'SELECT * FROM note_asset_refs')).toHaveLength(0);

      expect(() => store.purgeNote('missing-note')).toThrow('笔记不存在');
    } finally {
      store.close();
    }
  });
});

describe('purgeDocument（清理 refs 并回收资源）', () => {
  it('彻底删除文献后引用该文献笔记/批注的资源变为孤儿时立即回收；共享资源保留', async () => {
    const store = storeAt('purge-document');
    try {
      const shared = await store.saveNoteAsset({ dataUrl: pngDataUrl() });
      const sharedFile = path.join(assetDir(store), `${shared.id}.png`);
      // 另一张不同内容的图片（只被目标文献引用）。
      const canvas = createCanvas(3, 3);
      canvas.getContext('2d').fillRect(0, 0, 3, 3);
      const otherBytes = Buffer.from(await canvas.encode('png'));
      const onlyDocAsset = await store.saveNoteAsset({
        dataUrl: `data:image/png;base64,${otherBytes.toString('base64')}`
      });
      const onlyDocFile = path.join(assetDir(store), `${onlyDocAsset.id}.png`);

      const target = await importPdf(store, 'purge-doc-target');
      const keeper = await importPdf(store, 'purge-doc-keeper');
      store.createNote({
        documentId: target.id,
        page: 0,
        content: `![](${onlyDocAsset.url}) ![](${shared.url})`
      });
      store.createAnnotation({
        documentId: target.id,
        page: 0,
        quote: '',
        content: `![](${onlyDocAsset.url})`,
        style: 'page'
      });
      store.createNote({
        documentId: keeper.id,
        page: 0,
        content: `![](${shared.url})`
      });

      store.deleteDocument(target.id);
      store.purgeDocument(target.id, 'purge-doc-target.pdf');
      // 独占资源被回收，共享资源仍在。
      expect(existsSync(onlyDocFile)).toBe(false);
      expect(existsSync(sharedFile)).toBe(true);
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(
        rows(db, 'SELECT * FROM note_assets WHERE filename = ?', [`${onlyDocAsset.id}.png`])
      ).toHaveLength(0);
      const sharedRow = rows(db, 'SELECT * FROM note_assets WHERE filename = ?', [
        `${shared.id}.png`
      ])[0]!;
      expect(Number(sharedRow.ref_count)).toBe(1);

      // 删掉最后一个引用者也回收共享资源。
      store.deleteDocument(keeper.id);
      store.purgeDocument(keeper.id, 'purge-doc-keeper.pdf');
      expect(existsSync(sharedFile)).toBe(false);
    } finally {
      store.close();
    }
  });
});

async function importPdf(store: Store, label: string) {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(`Purge fixture ${label}`, { x: 40, y: 350, size: 16 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

describe('purgeAnnotation（硬删除批注 + 回收独占资源）', () => {
  it('共享资源最后引用者才回收；批注独占资源立即回收；不存在 404 语义', async () => {
    const store = storeAt('purge-annotation');
    try {
      const shared = await store.saveNoteAsset({ dataUrl: pngDataUrl() });
      const sharedFile = path.join(assetDir(store), `${shared.id}.png`);
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: `![](${shared.url})`
      });
      const annotation = store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: `![](${shared.url})`,
        style: 'page'
      });
      // 批注先删：共享资源仍被笔记引用，不回收。
      expect(store.purgeAnnotation(annotation.id)).toEqual({ freedAssets: 0, freedBytes: 0 });
      expect(existsSync(sharedFile)).toBe(true);
      expect(() => store.purgeAnnotation(annotation.id)).toThrow('批注不存在');
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(rows(db, 'SELECT * FROM annotations WHERE id = ?', [annotation.id])).toHaveLength(0);

      // 批注独占的资源：硬删除后立即回收文件与登记行。
      writeAsset(store, 'ann-only.png', PNG_BYTES);
      const exclusive = store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: '![](studianda-asset://note-assets/ann-only.png)',
        style: 'page'
      });
      const exclusiveFile = path.join(assetDir(store), 'ann-only.png');
      expect(existsSync(exclusiveFile)).toBe(true);
      const purged = store.purgeAnnotation(exclusive.id);
      expect(purged).toEqual({ freedAssets: 1, freedBytes: PNG_BYTES.length });
      expect(existsSync(exclusiveFile)).toBe(false);
      expect(rows(db, "SELECT * FROM note_assets WHERE filename = 'ann-only.png'")).toHaveLength(0);

      // 笔记是共享资源的最后引用者。
      const notePurged = store.purgeNote(note.id);
      expect(notePurged).toEqual({ freedAssets: 1, freedBytes: PNG_BYTES.length });
      expect(existsSync(sharedFile)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('reindexNoteAssets（修复外部改库造成的 refs 漂移）', () => {
  it('直接 SQL 改 note 内容绕过 store 后，reindex 重建 refs/ref_count/usage 并返回统计', () => {
    const store = storeAt('reindex');
    try {
      writeAsset(store, 'reindex-a.png');
      writeAsset(store, 'reindex-b.png');
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/reindex-a.png)'
      });
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(
        Number(
          rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-a.png'")[0]?.ref_count
        )
      ).toBe(1);
      expect(
        rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-b.png'")
      ).toHaveLength(0);

      // 绕过 store 直接改内容：refs 仍是旧资源 → 漂移。
      db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(
        '![](studianda-asset://note-assets/reindex-b.png)',
        note.id
      );
      expect(
        Number(
          rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-a.png'")[0]?.ref_count
        )
      ).toBe(1);

      const result = store.reindexNoteAssets();
      expect(result.indexedFiles).toBe(2);
      expect(result.indexedRefs).toBe(1);
      expect(Number.isNaN(Date.parse(result.indexedAt))).toBe(false);

      const aAfter = rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-a.png'")[0]!;
      const bAfter = rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-b.png'")[0]!;
      expect(Number(aAfter.ref_count)).toBe(0);
      expect(Number(bAfter.ref_count)).toBe(1);
      const usage = store.getNoteAssetUsage();
      expect(usage).toMatchObject({
        referencedFiles: 1,
        activeReferencedFiles: 1,
        deletedReferencedFiles: 0,
        orphanFiles: 1
      });
      expect(usage.indexedFiles).toBe(2);
      expect(usage.indexedRefs).toBe(1);
      expect(store.getSettings()['note_assets.indexed_refs']).toBe('1');

      // 直接 SQL 插入一条绕过 store 的笔记，reindex 也能纳入。
      writeAsset(store, 'reindex-c.png');
      db.prepare(
        `INSERT INTO notes(id, document_id, page, quote, content, external_key)
         VALUES (?, '', 0, '', ?, '')`
      ).run('raw-note', '![](studianda-asset://note-assets/reindex-c.png)');
      expect(
        rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-c.png'")
      ).toHaveLength(0);
      const second = store.reindexNoteAssets();
      expect(second.indexedFiles).toBe(3);
      expect(second.indexedRefs).toBe(2);
      expect(
        Number(rows(db, "SELECT * FROM note_assets WHERE filename = 'reindex-c.png'")[0]?.ref_count)
      ).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('GC 使用资源引用表', () => {
  it('includeDeleted 默认保护已删除笔记的引用，false 时清理并写 last_gc', () => {
    const store = storeAt('gc-refs');
    try {
      writeAsset(store, 'deleted-ref.png', PNG_BYTES, 2 * DAY);
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/deleted-ref.png)'
      });
      store.deleteNote(note.id);

      // dryRun：不删、不写 last_gc。
      const dry = store.gcNoteAssets({ dryRun: true, includeDeleted: false });
      expect(dry.deletedFiles).toBe(1);
      expect(store.getSettings()['note_assets.last_gc']).toBeUndefined();
      expect(existsSync(path.join(assetDir(store), 'deleted-ref.png'))).toBe(true);

      // 默认 includeDeleted=true：保留。
      const safe = store.gcNoteAssets();
      expect(safe.deletedFiles).toBe(0);
      expect(existsSync(path.join(assetDir(store), 'deleted-ref.png'))).toBe(true);

      // includeDeleted=false：删除文件 + 登记行 + refs，写 last_gc。
      const cleaned = store.gcNoteAssets({ includeDeleted: false });
      expect(cleaned.deletedFiles).toBe(1);
      expect(cleaned.bytesFreed).toBe(PNG_BYTES.length);
      expect(existsSync(path.join(assetDir(store), 'deleted-ref.png'))).toBe(false);
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(rows(db, "SELECT * FROM note_assets WHERE filename = 'deleted-ref.png'")).toHaveLength(
        0
      );
      const lastGc = String(store.getSettings()['note_assets.last_gc'] ?? '');
      expect(lastGc).not.toBe('');
      expect(Number.isNaN(Date.parse(lastGc))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('磁盘孤儿（表中没有）也按 grace 清理；新文件保留', () => {
    const store = storeAt('gc-orphans');
    try {
      const oldFile = writeAsset(store, 'disk-only-old.png', PNG_BYTES, 2 * DAY);
      const freshFile = writeAsset(store, 'disk-only-new.png', PNG_BYTES, 0);
      const report = store.gcNoteAssets();
      expect(report.scannedFiles).toBe(2);
      expect(report.deletedFiles).toBe(1);
      expect(report.skippedRecent).toBe(1);
      expect(existsSync(oldFile)).toBe(false);
      expect(existsSync(freshFile)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('autoGcNoteAssets 使用 restore-safe 默认值并写 last_gc', () => {
    const store = storeAt('gc-auto');
    try {
      const oldFile = writeAsset(store, 'auto-old.png', PNG_BYTES, 2 * DAY);
      const deletedNote = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/auto-old.png)'
      });
      store.deleteNote(deletedNote.id);
      store.autoGcNoteAssets();
      // includeDeleted=true：被已删除笔记引用的文件保留；last_gc 写入。
      expect(existsSync(oldFile)).toBe(true);
      expect(String(store.getSettings()['note_assets.last_gc'] ?? '')).not.toBe('');
    } finally {
      store.close();
    }
  });
});

describe('getNoteAssetUsage', () => {
  it('统计文件数/占用/被引用/孤儿/上次清理时间', async () => {
    const store = storeAt('usage');
    try {
      const asset = await store.saveNoteAsset({ dataUrl: pngDataUrl() });
      writeAsset(store, 'orphan-old.png', PNG_BYTES, 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: `![](${asset.url})`
      });
      const before = store.getNoteAssetUsage();
      expect(before).toMatchObject({
        fileCount: 2,
        totalBytes: PNG_BYTES.length * 2,
        referencedFiles: 1,
        orphanFiles: 1,
        lastGcAt: ''
      });
      store.gcNoteAssets();
      const after = store.getNoteAssetUsage();
      expect(after).toMatchObject({ fileCount: 1, referencedFiles: 1, orphanFiles: 0 });
      expect(after.lastGcAt).not.toBe('');
    } finally {
      store.close();
    }
  });

  it('区分活跃引用/仅已删除引用/孤儿（共享文件计入活跃），并裁剪表有行但磁盘缺文件的行', async () => {
    const store = storeAt('usage-split');
    try {
      writeAsset(store, 'active.png');
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/active.png)'
      });

      writeAsset(store, 'deleted-only.png');
      const deletedNote = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/deleted-only.png)'
      });
      store.deleteNote(deletedNote.id);

      // 共享文件：一条活跃引用 + 一条已删除引用 → 计入 active，不计 deleted。
      writeAsset(store, 'shared.png');
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/shared.png)'
      });
      const deletedShared = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/shared.png)'
      });
      store.deleteNote(deletedShared.id);

      // 磁盘孤儿：有文件、无引用、登记表里也没有。
      writeAsset(store, 'orphan.png');

      // 表有行、磁盘文件缺失（上传后文件被外部删除）。
      const missingAsset = await store.saveNoteAsset({ dataUrl: pngDataUrl() });
      const missingFile = path.join(assetDir(store), `${missingAsset.id}.png`);
      const missingNote = store.createNote({
        documentId: '',
        page: 0,
        content: `![](${missingAsset.url})`
      });
      rmSync(missingFile);
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(
        rows(db, 'SELECT * FROM note_assets WHERE filename = ?', [`${missingAsset.id}.png`])
      ).toHaveLength(1);

      const usage = store.getNoteAssetUsage();
      expect(usage).toMatchObject({
        fileCount: 4,
        referencedFiles: 3,
        activeReferencedFiles: 2,
        deletedReferencedFiles: 1,
        orphanFiles: 1
      });
      expect(typeof usage.indexedFiles).toBe('number');
      expect(typeof usage.indexedRefs).toBe('number');
      expect(usage.indexedAt).not.toBe('');

      // GC 真删阶段：裁剪缺文件行 + 其 refs；报告仍按磁盘文件统计。
      const report = store.gcNoteAssets();
      expect(report.scannedFiles).toBe(4);
      expect(
        rows(db, 'SELECT * FROM note_assets WHERE filename = ?', [`${missingAsset.id}.png`])
      ).toHaveLength(0);
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [missingNote.id])
      ).toHaveLength(0);
      const after = store.getNoteAssetUsage();
      expect(after).toMatchObject({
        fileCount: 4,
        referencedFiles: 3,
        activeReferencedFiles: 2,
        deletedReferencedFiles: 1,
        orphanFiles: 1
      });
    } finally {
      store.close();
    }
  });
});

describe('HTTP：usage / purge', () => {
  const dataDir = path.join(root, 'http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('GET /note-assets/usage 200；DELETE /notes/:id/purge 200 与 404', async () => {
    const asset = await store.saveNoteAsset({ dataUrl: pngDataUrl() });
    const note = store.createNote({
      documentId: '',
      page: 0,
      content: `![](${asset.url})`
    });

    const usage = await server.inject({
      method: 'GET',
      url: '/api/v1/note-assets/usage',
      headers: headers()
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({
      fileCount: 1,
      referencedFiles: 1,
      orphanFiles: 0,
      lastGcAt: ''
    });
    expect((usage.json() as { totalBytes: number }).totalBytes).toBe(PNG_BYTES.length);

    const purged = await server.inject({
      method: 'DELETE',
      url: `/api/v1/notes/${encodeURIComponent(note.id)}/purge`,
      headers: headers()
    });
    expect(purged.statusCode).toBe(200);
    expect(purged.json()).toEqual({ freedAssets: 1, freedBytes: PNG_BYTES.length });

    const missing = await server.inject({
      method: 'DELETE',
      url: '/api/v1/notes/missing-note/purge',
      headers: headers()
    });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /note-assets/reindex 200；DELETE /annotations/:id/purge 200 与 404', async () => {
    const reindex = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/reindex',
      headers: headers()
    });
    expect(reindex.statusCode).toBe(200);
    const reindexBody = reindex.json() as {
      indexedFiles: number;
      indexedRefs: number;
      indexedAt: string;
    };
    expect(typeof reindexBody.indexedFiles).toBe('number');
    expect(typeof reindexBody.indexedRefs).toBe('number');
    expect(Number.isNaN(Date.parse(reindexBody.indexedAt))).toBe(false);

    writeAsset(store, 'http-ann.png', PNG_BYTES);
    const annotation = store.createAnnotation({
      documentId: '',
      page: 0,
      quote: '',
      content: '![](studianda-asset://note-assets/http-ann.png)',
      style: 'page'
    });
    const purged = await server.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${encodeURIComponent(annotation.id)}/purge`,
      headers: headers()
    });
    expect(purged.statusCode).toBe(200);
    expect(purged.json()).toEqual({ freedAssets: 1, freedBytes: PNG_BYTES.length });

    const missing = await server.inject({
      method: 'DELETE',
      url: '/api/v1/annotations/missing-annotation/purge',
      headers: headers()
    });
    expect(missing.statusCode).toBe(404);
  });
});
