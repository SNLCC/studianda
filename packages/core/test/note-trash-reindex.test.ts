import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-trash-reindex-'));
const token = 'test-token';

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
    context.fillStyle = '#225577';
    context.fillRect(0, 0, 2, 2);
    return canvas.encode('png');
  })()
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

function writeAsset(store: Store, name: string): string {
  const dir = assetDir(store);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, PNG_BYTES);
  return file;
}

async function importPdf(store: Store, label: string) {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(`Trash fixture ${label}`, { x: 40, y: 350, size: 16 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

function rows(db: DatabaseSync, sql: string, params: Array<string | number> = []) {
  return db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
}

async function waitForReindex(store: Store, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const job = store.getNoteAssetReindexStatus();
    if (job.status === 'done' || job.status === 'error') return job;
    if (Date.now() - started > timeoutMs) throw new Error('reindex job timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('笔记/批注回收站（trash 列表 + restore）', () => {
  it('软删除进回收站：active/trash 列表互斥、恢复回 active、refs 保留且 usage 口径变化', async () => {
    const store = storeAt('trash-notes');
    try {
      const document = await importPdf(store, 'trash-doc');
      writeAsset(store, 'note-trash.png');
      const note = store.createNote({
        documentId: document.id,
        page: 0,
        content: '![](studianda-asset://note-assets/note-trash.png)'
      });
      writeAsset(store, 'standalone-trash.png');
      const standalone = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/standalone-trash.png)'
      });
      writeAsset(store, 'ann-trash.png');
      const annotation = store.createAnnotation({
        documentId: document.id,
        page: 0,
        quote: '',
        content: '![](studianda-asset://note-assets/ann-trash.png)',
        style: 'page'
      });

      // 软删除（笔记/独立笔记）。
      store.deleteNote(note.id);
      store.deleteNote(standalone.id);
      expect(store.listNotes(document.id).map((item) => item.id)).not.toContain(note.id);
      expect(store.listNotes(document.id, true).map((item) => item.id)).toEqual([note.id]);
      expect(store.listStandaloneNotes().map((item) => item.id)).not.toContain(standalone.id);
      expect(store.listStandaloneNotes(true).map((item) => item.id)).toEqual([standalone.id]);

      // 软删除期间 refs 保留，usage 归入 deletedReferenced。
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [note.id])
      ).toHaveLength(1);
      const deletedUsage = store.getNoteAssetUsage();
      expect(deletedUsage.fileCount).toBe(3);
      expect(deletedUsage.activeReferencedFiles).toBe(1); // ann-trash.png 仍活跃
      expect(deletedUsage.deletedReferencedFiles).toBe(2); // note/standalone 两个仅已删除引用

      // 恢复后回 active。
      store.restoreNote(note.id);
      store.restoreNote(standalone.id);
      expect(store.listNotes(document.id).map((item) => item.id)).toContain(note.id);
      expect(store.listStandaloneNotes().map((item) => item.id)).toContain(standalone.id);
      expect(store.listNotes(document.id, true)).toEqual([]);
      expect(store.getNoteAssetUsage().deletedReferencedFiles).toBe(0);

      // 批注回收站。
      store.deleteAnnotation(annotation.id);
      expect(store.listAnnotations(document.id).map((item) => item.id)).not.toContain(
        annotation.id
      );
      expect(store.listAnnotations(document.id, true).map((item) => item.id)).toEqual([
        annotation.id
      ]);
      expect(store.getNoteAssetUsage().deletedReferencedFiles).toBe(1);

      store.restoreAnnotation(annotation.id);
      expect(store.listAnnotations(document.id).map((item) => item.id)).toContain(annotation.id);
      expect(store.listAnnotations(document.id, true)).toEqual([]);
      // refs 在软删除/恢复期间一直保留。
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [annotation.id])
      ).toHaveLength(1);

      expect(() => store.restoreAnnotation('missing-annotation')).toThrow('批注不存在');
      expect(() => store.restoreAnnotation(annotation.id)).toThrow('批注不在回收站');
    } finally {
      store.close();
    }
  });
});

describe('后台分块资源索引重建', () => {
  it('start 后轮询到 done：进度/统计/并发保护/refs 修复', async () => {
    const store = storeAt('reindex-job');
    try {
      writeAsset(store, 'job-a.png');
      writeAsset(store, 'job-b.png');
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/job-a.png)'
      });
      store.createNote({ documentId: '', page: 0, content: '无图片笔记' });
      const annotation = store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: '![](studianda-asset://note-assets/job-b.png)',
        style: 'page'
      });
      const db = (store as unknown as { db: DatabaseSync }).db;

      // 直接改库造成漂移：note 改为引用 b。
      db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(
        '![](studianda-asset://note-assets/job-b.png)',
        note.id
      );

      // 初始 idle。
      expect(store.getNoteAssetReindexStatus()).toMatchObject({
        status: 'idle',
        phase: 'idle',
        done: 0,
        total: 0
      });

      const first = store.startNoteAssetReindex();
      expect(first.status).toBe('running');
      // 并发 start 返回当前 running 任务（不会重复启动）。
      const second = store.startNoteAssetReindex();
      expect(second.status).toBe('running');
      expect(second.phase).toBe(first.phase);

      const job = await waitForReindex(store);
      expect(job.status).toBe('done');
      expect(job.error).toBe('');
      // 2 个文件 + 2 条笔记 + 1 条批注 = 5 个处理项。
      expect(job.total).toBe(5);
      expect(job.done).toBe(5);
      expect(job.indexedFiles).toBe(2);
      expect(job.indexedRefs).toBe(2);
      expect(Number.isNaN(Date.parse(job.indexedAt))).toBe(false);
      expect(store.getSettings()['note_assets.indexed_refs']).toBe('2');
      // 完成后状态保持可读。
      expect(store.getNoteAssetReindexStatus().status).toBe('done');

      // refs 漂移被修复：a 归零、b 被 note+annotation 各一条引用。
      const aRow = rows(db, "SELECT * FROM note_assets WHERE filename = 'job-a.png'")[0]!;
      const bRow = rows(db, "SELECT * FROM note_assets WHERE filename = 'job-b.png'")[0]!;
      expect(Number(aRow.ref_count)).toBe(0);
      expect(Number(bRow.ref_count)).toBe(2);
      expect(
        rows(db, 'SELECT * FROM note_asset_refs WHERE source_id = ?', [annotation.id])
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('重建失败时 status=error 并带中文 error，且可重新开始', async () => {
    const store = storeAt('reindex-job-error');
    try {
      writeAsset(store, 'err-a.png');
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/err-a.png)'
      });
      type SyncFn = (kind: 'note' | 'annotation', sourceId: string, content: string) => void;
      const mutable = store as unknown as { syncNoteAssetRefs: SyncFn };
      const original = mutable.syncNoteAssetRefs;
      mutable.syncNoteAssetRefs = () => {
        throw new Error('injected-reindex-failure');
      };
      try {
        store.startNoteAssetReindex();
        const job = await waitForReindex(store);
        expect(job.status).toBe('error');
        expect(job.error).toContain('资源索引重建失败');
      } finally {
        mutable.syncNoteAssetRefs = original;
      }
      // 失败后 running 标记释放，可重新开始并成功。
      store.startNoteAssetReindex();
      const retried = await waitForReindex(store);
      expect(retried.status).toBe('done');
    } finally {
      store.close();
    }
  });
});

describe('SQLite WAL', () => {
  it('Store 打开后 journal_mode 为 wal（写失败会回退默认模式）', () => {
    const store = storeAt('wal');
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      expect(String(row.journal_mode).toLowerCase()).toBe('wal');
      // 事务写入仍正常（短事务）。
      store.updateSettings({ 'wal.probe': 'ok' });
      expect(store.getSettings()['wal.probe']).toBe('ok');
      expect(existsSync(path.join(store.dataDir, 'reader.sqlite3'))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('HTTP：回收站 / 后台重建', () => {
  const dataDir = path.join(root, 'http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('三个列表支持 ?trash=true，批注 restore 200/400/404', async () => {
    const note = store.createNote({ documentId: '', page: 0, content: '独立笔记' });
    const document = await importPdf(store, 'http-trash-doc');
    const documentNote = store.createNote({
      documentId: document.id,
      page: 0,
      content: '文献笔记'
    });
    const annotation = store.createAnnotation({
      documentId: document.id,
      page: 0,
      quote: '批注',
      content: '',
      style: 'page'
    });
    store.deleteNote(note.id);
    store.deleteNote(documentNote.id);
    store.deleteAnnotation(annotation.id);

    const standaloneTrash = await server.inject({
      method: 'GET',
      url: '/api/v1/notes/standalone?trash=true',
      headers: headers()
    });
    expect(standaloneTrash.statusCode).toBe(200);
    expect((standaloneTrash.json() as Array<{ id: string }>).map((item) => item.id)).toContain(
      note.id
    );

    const documentNotesTrash = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(document.id)}/notes?trash=true`,
      headers: headers()
    });
    expect(documentNotesTrash.statusCode).toBe(200);
    expect(
      (documentNotesTrash.json() as Array<{ id: string }>).map((item) => item.id)
    ).toContain(documentNote.id);

    const annotationsTrash = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(document.id)}/annotations?trash=true`,
      headers: headers()
    });
    expect(annotationsTrash.statusCode).toBe(200);
    expect(
      (annotationsTrash.json() as Array<{ id: string }>).map((item) => item.id)
    ).toContain(annotation.id);

    const restored = await server.inject({
      method: 'POST',
      url: `/api/v1/annotations/${encodeURIComponent(annotation.id)}/restore`,
      headers: headers()
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ ok: true });

    const restoreActive = await server.inject({
      method: 'POST',
      url: `/api/v1/annotations/${encodeURIComponent(annotation.id)}/restore`,
      headers: headers()
    });
    expect(restoreActive.statusCode).toBe(400);

    const restoreMissing = await server.inject({
      method: 'POST',
      url: '/api/v1/annotations/missing-annotation/restore',
      headers: headers()
    });
    expect(restoreMissing.statusCode).toBe(404);
  });

  it('后台重建 start/status HTTP：轮询到 done；旧同步 reindex 仍可用', async () => {
    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/reindex/start',
      headers: headers()
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as { status: string }).status).toBe('running');

    // 轮询状态直到 done。
    let statusCode = 200;
    let job: { status: string; done: number; total: number; indexedAt: string } = {
      status: 'running',
      done: 0,
      total: 0,
      indexedAt: ''
    };
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/note-assets/reindex/status',
        headers: headers()
      });
      statusCode = response.statusCode;
      job = response.json() as typeof job;
      if (job.status === 'done' || job.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(statusCode).toBe(200);
    expect(job.status).toBe('done');
    expect(job.done).toBe(job.total);

    const sync = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/reindex',
      headers: headers()
    });
    expect(sync.statusCode).toBe(200);
    expect((sync.json() as { indexedAt: string }).indexedAt).not.toBe('');
  });
});
