import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { FileHealthReport } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-file-health-'));
const store = new Store(dataDir);
const server = buildServer({ token: 'file-health-token', version: 'test', store, secrets: new SecretStore() });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': 'file-health-token' };
}

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return Buffer.from(await pdf.save());
}

async function readHealth(): Promise<FileHealthReport> {
  const response = await server.inject({
    method: 'GET',
    url: '/api/v1/maintenance/file-health',
    headers: headers()
  });
  expect(response.statusCode).toBe(200);
  return response.json() as FileHealthReport;
}

describe('GET /api/v1/maintenance/file-health', () => {
  it('reports ok for a document whose file still exists', async () => {
    const source = path.join(dataDir, 'sample.pdf');
    writeFileSync(source, await makePdf());
    const document = await store.importDocument(source);

    const report = await readHealth();
    expect(report.checked).toBe(1);
    expect(report.missing).toBe(0);
    expect(report.ok).toBe(1);
    expect(report.issues).toEqual([]);
    expect(store.documentHealth().find((row) => row.documentId === document.id)?.missing).toBe(false);
  });

  it('reports missing when the stored file was deleted, without touching records', async () => {
    const row = store.documentHealth()[0];
    expect(row).toBeTruthy();
    rmSync(row!.path, { force: true });

    const report = await readHealth();
    expect(report.checked).toBe(1);
    expect(report.missing).toBe(1);
    expect(report.ok).toBe(0);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      documentId: row!.documentId,
      name: row!.name,
      path: row!.path
    });
    // 只检查文件是否存在：记录仍保留，用户可重新连接。
    expect(store.listDocuments(false).some((doc) => doc.id === row!.documentId)).toBe(true);
  });

  it('returns zero counts when the library has no documents', async () => {
    const freshDir = mkdtempSync(path.join(tmpdir(), 'studianda-file-health-fresh-'));
    const freshStore = new Store(freshDir);
    const freshServer = buildServer({
      token: 'fresh-token',
      version: 'test',
      store: freshStore,
      secrets: new SecretStore()
    });
    try {
      const response = await freshServer.inject({
        method: 'GET',
        url: '/api/v1/maintenance/file-health',
        headers: { 'x-studianda-token': 'fresh-token' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ checked: 0, ok: 0, missing: 0, issues: [] });
    } finally {
      await freshServer.close();
      freshStore.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
