import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { PageData } from '@studianda/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const token = 'page-api-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-page-api-'));
const store = new Store(dataDir);
const server = buildServer({
  token,
  version: 'test-version',
  store,
  secrets: new SecretStore()
});
let documentId = '';

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

/** 读 PNG 的 IHDR：宽高在固定偏移（签名 8 字节 + 长度 4 + 'IHDR' 4 之后）。 */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  for (const text of ['Page one sample text', 'Page two sample text']) {
    const page = pdf.addPage([420, 594]);
    page.drawText(text, { x: 40, y: 540, size: 14 });
  }
  const file = path.join(dataDir, 'two-pages.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await server.inject({
    method: 'POST',
    url: '/api/v1/documents/import',
    headers: headers(),
    payload: { path: file }
  });
  expect(imported.statusCode).toBe(200);
  documentId = (imported.json() as { id: string }).id;
}, 120_000);

describe('page data / image / thumbnail API', () => {
  it('returns normalized page data with lines and masks', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as PageData;
    expect(body.page).toBe(1);
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
    expect(Array.isArray(body.masks)).toBe(true);
    expect(typeof body.masks_revision).toBe('string');
    expect(body.lines.length).toBeGreaterThan(0);
    for (const line of body.lines) {
      expect(line.text.length).toBeGreaterThan(0);
      for (const value of line.bbox) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    // 文本项粒度框 + viewport 旋转矩阵（比整行更细，供选区对齐）。
    expect(Array.isArray(body.spans)).toBe(true);
    expect(body.spans!.length).toBeGreaterThan(0);
    for (const span of body.spans!) {
      expect(span.text.length).toBeGreaterThan(0);
      for (const value of span.bbox) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    expect(body.rotation_matrix).toHaveLength(6);
  });

  it('renders the full page image as PNG', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1/image`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] ?? '')).toContain('image/png');
    expect(String(response.headers['cache-control'] ?? '')).toContain('private');
    const bytes = response.rawPayload;
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    const size = pngSize(bytes);
    expect(size.width).toBeGreaterThan(160);
    expect(size.height).toBeGreaterThan(0);
  }, 120_000);

  it('shrinks the page image to the requested width', async () => {
    const full = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1/image`,
      headers: headers()
    });
    const narrow = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1/image?width=300`,
      headers: headers()
    });
    expect(narrow.statusCode).toBe(200);
    const fullWidth = pngSize(full.rawPayload).width;
    const narrowWidth = pngSize(narrow.rawPayload).width;
    expect(narrowWidth).toBeLessThanOrEqual(300);
    expect(narrowWidth).toBeLessThan(fullWidth);
  }, 120_000);

  it('ignores a too-small width instead of upscaling', async () => {
    // width<=160 直接忽略：返回整页图，宽度不小于整页渲染宽度。
    const full = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1/image`,
      headers: headers()
    });
    const tiny = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1/image?width=80`,
      headers: headers()
    });
    expect(tiny.statusCode).toBe(200);
    expect(pngSize(tiny.rawPayload).width).toBe(pngSize(full.rawPayload).width);
  }, 120_000);

  it('renders the thumbnail as a small PNG', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1/thumbnail`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'] ?? '')).toContain('image/png');
    const bytes = response.rawPayload;
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    const size = pngSize(bytes);
    expect(size.width).toBeLessThanOrEqual(240);
    expect(size.width).toBeGreaterThan(0);
  }, 120_000);

  it('rejects a page number out of range with 400', async () => {
    for (const page of ['3', '0', 'x']) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${documentId}/pages/${page}`,
        headers: headers()
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('rejects unknown documents with 404', async () => {
    for (const suffix of ['', '/image', '/thumbnail']) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/missing-doc/pages/1${suffix}`,
        headers: headers()
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
