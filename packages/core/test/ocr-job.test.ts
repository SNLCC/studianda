import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-job-'));
const store = new Store(dataDir);
const server = buildServer({
  token: 'ocr-job-token',
  version: 'test',
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
  return { 'x-studianda-token': 'ocr-job-token' };
}

describe('POST /api/v1/documents/:id/ocr/start', () => {
  it('creates a document fixture', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const file = path.join(dataDir, 'ocr-fixture.pdf');
    writeFileSync(file, await pdf.save());
    const document = await store.importDocument(file);
    documentId = document.id;
    expect(documentId).toBeTruthy();
  });

  it('validates page and coordinates before creating a job', async () => {
    const badPage = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/start`,
      headers: headers(),
      payload: { page: 0, x0: 0, y0: 0, x1: 10, y1: 10 }
    });
    expect(badPage.statusCode).toBe(400);

    const badCoords = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/start`,
      headers: headers(),
      payload: { page: 1, x0: 'a', y0: 0, x1: 10, y1: 10 }
    });
    expect(badCoords.statusCode).toBe(400);
  });

  it('returns 404 for unknown document and unknown job', async () => {
    const missingDoc = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/nope/ocr/start',
      headers: headers(),
      payload: { page: 1, x0: 0, y0: 0, x1: 10, y1: 10 }
    });
    expect(missingDoc.statusCode).toBe(404);

    const missingJob = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/ocr/jobs/nope`,
      headers: headers()
    });
    expect(missingJob.statusCode).toBe(404);
  });
});
