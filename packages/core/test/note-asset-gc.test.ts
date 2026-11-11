import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-asset-gc-'));
const token = 'test-token';
const DAY = 24 * 60 * 60 * 1000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/** 真实可解码的 PNG（saveNoteAsset 会完整解码校验）。 */
const REAL_PNG = Buffer.from(await (async () => {
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#123456';
  context.fillRect(0, 0, 2, 2);
  return canvas.encode('png');
})());

function pngBytes(payload: string): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(payload)]);
}

function pngDataUrl(): string {
  return `data:image/png;base64,${REAL_PNG.toString('base64')}`;
}

function assetDir(store: Store): string {
  return path.join(store.dataDir, 'note-assets');
}

/** 直接往 note-assets/ 写一个文件，可把 mtime 调到过去（模拟老文件）。 */
function writeAsset(store: Store, name: string, bytes: Buffer, ageMs = 0): string {
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

describe('Store.gcNoteAssets', () => {
  it('只删无引用且超过 grace 的文件；dryRun 只统计；引用按纯文件名匹配', async () => {
    const store = storeAt('gc-basic');
    try {
      const asset = await store.saveNoteAsset({ dataUrl: pngDataUrl(), filename: '图.png' });
      const referencedFile = `${asset.id}.png`;
      store.createNote({
        documentId: '',
        page: 0,
        content: `![](${asset.url})`
      });
      // 批注里也引用一张老图片。
      const annFile = writeAsset(store, 'ann-old.png', pngBytes('ann'), 2 * DAY);
      store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: `![](${asset.url.replace(referencedFile, 'ann-old.png')})`,
        style: 'page'
      });
      // 兼容无 note-assets host 的写法。
      writeAsset(store, 'alt.png', pngBytes('alt'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://alt.png)'
      });
      const alt2File = writeAsset(store, 'alt2.png', pngBytes('alt2'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset:alt2.png)'
      });
      // 无引用：老的会被清，新的被 grace 保护。
      const deadBytes = pngBytes('dead');
      const deadFile = writeAsset(store, 'dead.png', deadBytes, 2 * DAY);
      const freshFile = writeAsset(store, 'fresh.png', pngBytes('fresh'), 0);
      // 目录/目录外文件都不受 GC 影响。
      mkdirSync(path.join(assetDir(store), 'nested'), { recursive: true });
      const outsideFile = path.join(store.dataDir, 'secret.txt');
      writeFileSync(outsideFile, 'do not delete');

      const dryRun = store.gcNoteAssets({ dryRun: true });
      expect(dryRun).toMatchObject({
        scannedFiles: 6,
        referencedFiles: 4,
        deletedFiles: 1,
        keptFiles: 5,
        skippedRecent: 1,
        bytesFreed: deadBytes.length
      });
      expect(existsSync(deadFile)).toBe(true);
      expect(existsSync(freshFile)).toBe(true);
      expect(existsSync(annFile)).toBe(true);
      expect(existsSync(alt2File)).toBe(true);
      expect(existsSync(outsideFile)).toBe(true);

      const real = store.gcNoteAssets();
      expect(real).toMatchObject({
        scannedFiles: 6,
        referencedFiles: 4,
        deletedFiles: 1,
        keptFiles: 5,
        skippedRecent: 1,
        bytesFreed: deadBytes.length
      });
      expect(existsSync(deadFile)).toBe(false);
      expect(existsSync(freshFile)).toBe(true);
      expect(existsSync(annFile)).toBe(true);
      expect(existsSync(outsideFile)).toBe(true);
      expect(existsSync(path.join(assetDir(store), 'nested'))).toBe(true);

      // 再跑一次：已无过期无引用文件，什么都不删。
      const again = store.gcNoteAssets();
      expect(again).toMatchObject({
        scannedFiles: 5,
        referencedFiles: 4,
        deletedFiles: 0,
        keptFiles: 5,
        skippedRecent: 1,
        bytesFreed: 0
      });
    } finally {
      store.close();
    }
  });

  it('已删除笔记/批注里的引用仍算引用（恢复后图片还在）；graceMs 可覆盖', () => {
    const store = storeAt('gc-deleted-refs');
    try {
      const noteFile = writeAsset(store, 'note-ref.png', pngBytes('note'), 2 * DAY);
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/note-ref.png)'
      });
      store.deleteNote(note.id);
      const annFile = writeAsset(store, 'ann-ref.png', pngBytes('ann'), 2 * DAY);
      const annotation = store.createAnnotation({
        documentId: '',
        page: 0,
        quote: '',
        content: '![](studianda-asset://note-assets/ann-ref.png)',
        style: 'page'
      });
      store.deleteAnnotation(annotation.id);

      const report = store.gcNoteAssets();
      expect(report.referencedFiles).toBe(2);
      expect(report.deletedFiles).toBe(0);
      expect(existsSync(noteFile)).toBe(true);
      expect(existsSync(annFile)).toBe(true);

      // 覆盖 graceMs：10 分钟前的无引用文件在默认 24h 下保留，在 1 分钟阈值下删除。
      const recentBytes = pngBytes('recent');
      const recentFile = writeAsset(store, 'recent-unref.png', recentBytes, 10 * 60 * 1000);
      expect(store.gcNoteAssets().deletedFiles).toBe(0);
      expect(store.gcNoteAssets({ graceMs: 60 * 1000 }).deletedFiles).toBe(1);
      expect(existsSync(recentFile)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('目录不存在返回全 0 报告；路径写法的 ../ 不会被当成引用', () => {
    const empty = storeAt('gc-empty');
    try {
      expect(empty.gcNoteAssets()).toMatchObject({
        scannedFiles: 0,
        referencedFiles: 0,
        deletedFiles: 0,
        keptFiles: 0,
        skippedRecent: 0,
        bytesFreed: 0
      });
    } finally {
      empty.close();
    }

    const store = storeAt('gc-traversal');
    try {
      const outside = path.join(store.dataDir, 'secret.png');
      writeFileSync(outside, 'outside');
      const file = writeAsset(store, 'old.png', pngBytes('old'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/../secret.png)'
      });
      const report = store.gcNoteAssets();
      // `../secret.png` 不是纯文件名 → 不算引用；目录内 old.png 正常删除。
      expect(report.referencedFiles).toBe(0);
      expect(report.deletedFiles).toBe(1);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(outside)).toBe(true);
      // 目录外的文件大小不会算进 bytesFreed。
      expect(report.bytesFreed).toBe(pngBytes('old').length);
    } finally {
      store.close();
    }
  });

  it('includeDeleted 默认保护已删除内容引用；false 时允许清理只被已删除内容引用的图片', () => {
    const store = storeAt('gc-include-deleted');
    try {
      const referenced = writeAsset(store, 'only-deleted.png', pngBytes('only-deleted'), 2 * DAY);
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/only-deleted.png)'
      });
      store.deleteNote(note.id);
      const deletedOnlyFile = referenced;

      const defaultReport = store.gcNoteAssets();
      expect(defaultReport.referencedFiles).toBe(1);
      expect(defaultReport.deletedFiles).toBe(0);
      expect(existsSync(deletedOnlyFile)).toBe(true);

      const ignoreDeleted = store.gcNoteAssets({ includeDeleted: false, dryRun: true });
      expect(ignoreDeleted.referencedFiles).toBe(0);
      expect(ignoreDeleted.deletedFiles).toBe(1);
      expect(existsSync(deletedOnlyFile)).toBe(true);

      const real = store.gcNoteAssets({ includeDeleted: false });
      expect(real.deletedFiles).toBe(1);
      expect(existsSync(deletedOnlyFile)).toBe(false);

      // 未删除内容里的引用在 includeDeleted=false 下仍受保护。
      const kept = writeAsset(store, 'active.png', pngBytes('active'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/active.png)'
      });
      expect(store.gcNoteAssets({ includeDeleted: false }).deletedFiles).toBe(0);
      expect(existsSync(kept)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('URL 编码文件名可识别为引用；非法编码/%2F 路径写法不崩溃且不算引用', () => {
    const store = storeAt('gc-url-encoded');
    try {
      // 文件名含空格，引用里写成 %20。
      const encodedFile = writeAsset(store, 'enc a.png', pngBytes('encoded'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/enc%20a.png)'
      });
      // %2F 解码后是路径 → 不算引用、不能误保护/误删目录外文件。
      writeAsset(store, 'slash.png', pngBytes('slash'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/note-assets%2Fslash.png)'
      });
      // 非法百分号编码：不崩溃，也不当成引用。
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/%E0%A4%A.png)'
      });

      const dry = store.gcNoteAssets({ dryRun: true });
      // 只有 enc a.png 被识别为引用；slash.png 仍是无引用的老文件。
      expect(dry.referencedFiles).toBe(1);
      expect(dry.deletedFiles).toBe(1);
      expect(dry.keptFiles).toBe(1);
      expect(existsSync(encodedFile)).toBe(true);

      const real = store.gcNoteAssets();
      expect(real.deletedFiles).toBe(1);
      expect(existsSync(encodedFile)).toBe(true);
      expect(existsSync(path.join(assetDir(store), 'slash.png'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('支持最多 2 层 URL 解码（%2520），三层及以上不再解码；%252F 仍按路径拒绝', () => {
    const store = storeAt('gc-double-encoded');
    try {
      const doubleFile = writeAsset(store, 'double a.png', pngBytes('double'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/double%2520a.png)'
      });
      // 三层编码：%252520 只解两层 → %20，不会再变成空格，因此不算引用。
      const tripleFile = writeAsset(store, 'triple a.png', pngBytes('triple'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/triple%252520a.png)'
      });
      // 双层编码的路径分隔符：%252F → %2F → /，解码后含路径 → 不算引用。
      const slashFile = writeAsset(store, 'double-slash.png', pngBytes('dslash'), 2 * DAY);
      store.createNote({
        documentId: '',
        page: 0,
        content: '![](studianda-asset://note-assets/double%252Fslash.png)'
      });

      const dry = store.gcNoteAssets({ dryRun: true });
      expect(dry.referencedFiles).toBe(1);
      expect(dry.deletedFiles).toBe(2);
      expect(dry.keptFiles).toBe(1);
      expect(existsSync(doubleFile)).toBe(true);

      const real = store.gcNoteAssets();
      expect(real.deletedFiles).toBe(2);
      expect(existsSync(doubleFile)).toBe(true);
      expect(existsSync(tripleFile)).toBe(false);
      expect(existsSync(slashFile)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('POST /api/v1/note-assets/gc', () => {
  const dataDir = path.join(root, 'gc-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('200 返回报告；dryRun 不删除', async () => {
    const deadFile = writeAsset(store, 'http-dead.png', pngBytes('http-dead'), 2 * DAY);
    writeAsset(store, 'http-fresh.png', pngBytes('http-fresh'), 0);

    const dry = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers(),
      payload: { dryRun: true }
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ deletedFiles: 1, skippedRecent: 1 });
    expect(existsSync(deadFile)).toBe(true);

    const real = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers()
    });
    expect(real.statusCode).toBe(200);
    expect((real.json() as { deletedFiles: number }).deletedFiles).toBe(1);
    expect(existsSync(deadFile)).toBe(false);
  });

  it('body 非法 400；空 body 视为默认 dryRun=false', async () => {
    const badType = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers(),
      payload: { dryRun: 'yes' }
    });
    expect(badType.statusCode).toBe(400);
    expect((badType.json() as { message: string }).message).toContain('dryRun');

    const badArray = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers(),
      payload: [1, 2]
    });
    expect(badArray.statusCode).toBe(400);

    const badInclude = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers(),
      payload: { includeDeleted: 'yes' }
    });
    expect(badInclude.statusCode).toBe(400);
    expect((badInclude.json() as { message: string }).message).toContain('includeDeleted');

    const withInclude = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers(),
      payload: { dryRun: true, includeDeleted: false }
    });
    expect(withInclude.statusCode).toBe(200);

    const emptyBody = await server.inject({
      method: 'POST',
      url: '/api/v1/note-assets/gc',
      headers: headers()
    });
    expect(emptyBody.statusCode).toBe(200);
  });
});
