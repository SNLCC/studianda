import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { ImportJobRecord } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-import-job-'));
const store = new Store(dataDir);
const server = buildServer({
  token: 'import-job-token',
  version: 'test',
  store,
  secrets: new SecretStore()
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': 'import-job-token' };
}

async function makePdf(label: string, pageCount = 1): Promise<string> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) pdf.addPage();
  const file = path.join(dataDir, `${label}.pdf`);
  writeFileSync(file, await pdf.save());
  return file;
}

async function startJob(file: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/documents/import/start',
    headers: headers(),
    payload: { path: file }
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { jobId: string }).jobId;
}

async function pollJob(id: string): Promise<ImportJobRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/import/jobs/${id}`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const job = response.json() as ImportJobRecord;
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('import job timeout');
}

describe('POST /api/v1/documents/import/start', () => {
  it('runs the import in the background and reports progress to done', async () => {
    const file = await makePdf('job-ok');
    const jobId = await startJob(file);
    const job = await pollJob(jobId);
    expect(job.state).toBe('done');
    expect(job.progress).toBe(100);
    expect(job.stage).toBe('done');
    expect(job.documentId).toBeTruthy();
    expect(job.documentName).toBe('job-ok.pdf');
    expect(job.pages).toBe(1);
    expect(store.listDocuments(false).some((doc) => doc.id === job.documentId)).toBe(true);
  });

  it('reports duplicate files as a failed job with an actionable code', async () => {
    const file = await makePdf('job-ok');
    const jobId = await startJob(file);
    const job = await pollJob(jobId);
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('duplicate_required');
    expect(job.error?.message).toContain('已有');
  });

  it('accepts a cancel request (cancelled, or already done on fast parses)', async () => {
    const file = await makePdf('job-cancel', 2);
    const jobId = await startJob(file);
    const cancel = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/import/jobs/${jobId}/cancel`,
      headers: headers()
    });
    expect(cancel.statusCode).toBe(200);
    const job = await pollJob(jobId);
    expect(['cancelled', 'done'], JSON.stringify(job.error)).toContain(job.state);
    if (job.state === 'cancelled') expect(job.progress).toBe(0);
  });

  it('returns 404 for an unknown job id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/documents/import/jobs/not-a-job',
      headers: headers()
    });
    expect(response.statusCode).toBe(404);
  });
});
