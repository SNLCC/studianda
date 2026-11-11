import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BackupJobRecord } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-backup-job-'));
const store = new Store(dataDir);
const server = buildServer({
  token: 'backup-job-token',
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
  return { 'x-studianda-token': 'backup-job-token' };
}

async function startJob(): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/backups/start',
    headers: headers(),
    payload: { include_logs: false }
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { jobId: string }).jobId;
}

async function pollJob(id: string): Promise<BackupJobRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/backups/jobs/${id}`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const job = response.json() as BackupJobRecord;
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('backup job timeout');
}

describe('POST /api/v1/backups/start', () => {
  it('creates a backup in the background and reports completion', async () => {
    const jobId = await startJob();
    const job = await pollJob(jobId);
    expect(job.state).toBe('done');
    expect(job.progress).toBe(100);
    expect(job.backup?.name).toMatch(/^studianda-data-\d{8}-\d{6}\.zip$/);
    expect(job.backup?.sizeBytes).toBeGreaterThan(0);
  });

  it('accepts a cancel request (cancelled, or already done on tiny data dirs)', async () => {
    const jobId = await startJob();
    const cancel = await server.inject({
      method: 'POST',
      url: `/api/v1/backups/jobs/${jobId}/cancel`,
      headers: headers()
    });
    expect(cancel.statusCode).toBe(200);
    const job = await pollJob(jobId);
    expect(['cancelled', 'done']).toContain(job.state);
  });

  it('returns 404 for an unknown job id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/backups/jobs/not-a-job',
      headers: headers()
    });
    expect(response.statusCode).toBe(404);
  });
});
