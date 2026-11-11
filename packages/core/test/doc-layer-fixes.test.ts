import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { recognizeRegion } from '../src/ocr.js';
import { extractPdfLayout } from '../src/pdf-layout.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-doc-layer-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const token = 'doc-layer-token';
const server = buildServer({ token, version: 'test-version', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(
  file: string,
  options: { pages?: number; rotate?: number; text?: string } = {}
): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < (options.pages ?? 1); index += 1) {
    const page = pdf.addPage([500, 700]);
    page.drawText(options.text ?? 'TEXT-LAYER-MARKER body text', {
      x: 30,
      y: 620,
      size: 14,
      font
    });
    if (options.rotate) page.setRotation(degrees(options.rotate));
  }
  writeFileSync(file, await pdf.save());
}

describe('pdf-layout 旋转页坐标', () => {
  for (const rotate of [90, 180, 270]) {
    it(`旋转 ${rotate}° 的页数据 bbox 仍在页面内`, async () => {
      const file = path.join(dataDir, `rotated-${rotate}.pdf`);
      await makePdf(file, { rotate });
      const layout = await extractPdfLayout(new Uint8Array(readFileSync(file)));
      const line = layout.pages[0]!.lines.find((item) => item.text.includes('TEXT-LAYER-MARKER'));
      expect(line).toBeTruthy();
      const [x0, y0, x1, y1] = line!.bbox;
      expect([x0, y0, x1, y1].every((value) => Number.isFinite(value))).toBe(true);
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1.0001);
      expect(y1).toBeLessThanOrEqual(1.0001);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
    });
  }
});

describe('页遮罩幂等与状态', () => {
  it('重复添加同一规则不会产生重复条目，并返回重建状态', async () => {
    const file = path.join(dataDir, 'mask-source.pdf');
    await makePdf(file, { pages: 2 });
    const document = await store.importDocument(file);
    const input = { page: 1, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 };
    const first = await store.addPageMask(document.id, input);
    const second = await store.addPageMask(document.id, input);
    expect(second.id).toBe(first.id);
    expect(store.listPageMasks(document.id)).toHaveLength(1);
    const status = store.maskIndexStatus(document.id);
    expect(status.state).toBe('ready');
    expect(status.revision).toBe(store.pageMaskRevision(document.id));
  });
});

describe('文件健康 changed 状态', () => {
  it('Zotero 本机附件被外部修改后标记 changed', async () => {
    const source = path.join(dataDir, 'zotero-file.pdf');
    await makePdf(source);
    const document = await store.importZoteroDocument({
      identity: 'zotero-local:HEALTH01',
      title: '附件健康测试',
      author: 'Ada',
      externalPath: source
    });
    const future = new Date(Date.now() + 10_000);
    utimesSync(source, future, future);
    const summary = store.listDocuments().find((item) => item.id === document.id);
    expect(summary?.fileState.state).toBe('changed');
    expect(summary?.missing_file).toBe(false);
  });
});

describe('区域识别优先取文本层', () => {
  it('数字版 PDF 框选文字时直接返回原文，不调用 OCR', async () => {
    const file = path.join(dataDir, 'region.pdf');
    await makePdf(file, { text: 'REGION-MARKER digital text' });
    const document = await store.importDocument(file);
    const result = await recognizeRegion(store, secrets, document.id, 1, {
      x0: 0,
      y0: 0,
      x1: 0.6,
      y1: 0.25
    });
    expect(result.engine).toBe('text_layer');
    expect(result.text).toContain('REGION-MARKER');
  });
});

describe('批注 PDF 下载头', () => {
  it('文件名按文献名生成，并禁用缓存', async () => {
    const file = path.join(dataDir, 'annotated.pdf');
    await makePdf(file, { text: 'ANNOTATED-MARKER body text' });
    const document = await store.importDocument(file);
    store.createAnnotation({
      documentId: document.id,
      page: 1,
      quote: 'ANNOTATED-MARKER',
      content: '批注',
      rects: '[[0.1,0.1,0.4,0.2]]',
      color: 'yellow',
      style: 'highlight'
    });
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${document.id}/annotated.pdf`,
      headers: { 'x-studianda-token': token }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(String(response.headers['content-disposition'])).toContain(
      "filename*=UTF-8''"
    );
    expect(String(response.headers['cache-control'])).toBe('no-store');
  });
});

describe('目录状态与预览', () => {  it('生成后返回 ready，并记录 last_used 与过期原因', async () => {
    const file = path.join(dataDir, 'nav.pdf');
    await makePdf(file, { pages: 2, text: 'NAV-MARKER heading title' });
    const document = await store.importDocument(file);
    const built = await store.buildNavigation(document.id, true);
    expect(built.state).toBe('ready');
    store.setNavigationEnabled(document.id, true);
    store.planningNavigation(document.id);
    const status = store.navigationStatus(document.id);
    expect(status.enabled).toBe(true);
    expect(status.last_used).toBeTruthy();
    await store.addPageMask(document.id, { page: 1, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2 });
    expect(store.navigationStatus(document.id).stale_reason).toContain('无关区域规则');
    const preview = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${document.id}/navigation/preview`,
      headers: { 'x-studianda-token': token }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toHaveProperty('nodes_truncated');
    const deleted = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${document.id}/navigation`,
      headers: { 'x-studianda-token': token }
    });
    expect(deleted.statusCode).toBe(204);
    expect(store.navigationStatus(document.id).state).toBe('missing');
  });

  it('POST /navigation 支持 body.enabled，构建后按值启用/停用', async () => {
    const file = path.join(dataDir, 'nav-enabled-body.pdf');
    await makePdf(file, { pages: 2, text: 'NAV-ENABLED-BODY heading' });
    const document = await store.importDocument(file);
    const enabled = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${document.id}/navigation`,
      headers: { 'x-studianda-token': token },
      payload: { rebuild: true, enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ state: 'ready', enabled: true });
    // rebuild=false 且已是最新时复用现有索引，再按 body.enabled 停用。
    const disabled = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${document.id}/navigation`,
      headers: { 'x-studianda-token': token },
      payload: { rebuild: false, enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ state: 'ready', enabled: false });
  });
});

describe('relink 清理旧页版面缓存', () => {
  it('换到新 sha 路径后，旧 path 的 structure_pages 行被删除', async () => {
    const sourceA = path.join(dataDir, 'relink-cache-a.pdf');
    const sourceB = path.join(dataDir, 'relink-cache-b.pdf');
    await makePdf(sourceA, { pages: 2, text: 'RELINK-CACHE-OLD body' });
    await makePdf(sourceB, { pages: 2, text: 'RELINK-CACHE-NEW body' });
    const document = await store.importDocument(sourceA);
    // 触发一次解析，把旧 path 的页版面写进 structure_pages。
    await store.getPageLayout(document.id);
    const oldPath = store.getDocumentPath(document.id);
    expect(oldPath).toBeTruthy();
    const db = (store as unknown as { db: DatabaseSync }).db;
    const countRows = (filePath: string): number => {
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM structure_pages WHERE path = ?')
        .get(filePath) as unknown as { count: number };
      return Number(row.count);
    };
    expect(countRows(oldPath!)).toBeGreaterThan(0);

    await store.relinkDocument(document.id, sourceB);
    const newPath = store.getDocumentPath(document.id);
    expect(newPath).toBeTruthy();
    expect(newPath).not.toBe(oldPath);
    expect(countRows(oldPath!)).toBe(0);
    // 新路径仍可正常建立缓存（没有误删/写错 path）。
    await store.getPageLayout(document.id);
    expect(countRows(newPath!)).toBeGreaterThan(0);
  });
});
