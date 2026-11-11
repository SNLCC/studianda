import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MaintenanceStatus } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-maintenance-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token: 'maintenance-token', version: 'test-version', store, secrets });
const backupName = 'studianda-data-2026-01-01-000000.zip';
const secretMarker = 'MAINTENANCE SECRET PDF BODY';

beforeAll(() => {
  // 日志（含轮转文件）与正文文件：维护状态只能 stat，不能把正文读进响应。
  writeFileSync(path.join(dataDir, 'application.log'), 'x'.repeat(100), 'utf8');
  writeFileSync(path.join(dataDir, 'application.log.1'), 'y'.repeat(50), 'utf8');
  mkdirSync(path.join(dataDir, 'papers'), { recursive: true });
  writeFileSync(path.join(dataDir, 'papers', 'secret.pdf'), secretMarker, 'utf8');
  mkdirSync(path.join(dataDir, 'diagnostics'), { recursive: true });
  writeFileSync(path.join(dataDir, 'diagnostics', 'studianda-diagnostics-a.zip'), 'zip-a');
  writeFileSync(path.join(dataDir, 'diagnostics', 'studianda-diagnostics-b.zip'), 'zip-b');
  writeFileSync(path.join(dataDir, 'diagnostics', 'unrelated.txt'), 'nope');
  mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  writeFileSync(path.join(dataDir, 'backups', backupName), 'backup-bytes');
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': 'maintenance-token' };
}

describe('GET /api/v1/maintenance/status', () => {
  it('reports sizes, counts and the latest backup using stat only', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/maintenance/status',
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as MaintenanceStatus;
    expect(body).toMatchObject({
      version: 'test-version',
      data_dir: dataDir,
      platform: process.platform,
      diagnostics_count: 2,
      backups_count: 1,
      last_backup: backupName,
      core_pid: process.pid
    });
    expect(body.database_bytes).toBeGreaterThan(0);
    expect(body.log_bytes).toBe(150);
    expect(typeof body.uptime_seconds).toBe('number');
    expect(body.uptime_seconds ?? -1).toBeGreaterThanOrEqual(0);
    // 只 stat：响应里不能出现 PDF 正文。
    expect(JSON.stringify(body)).not.toContain(secretMarker);
  });

  it('returns empty last_backup and zero counts on a fresh data dir', async () => {
    const freshDir = mkdtempSync(path.join(tmpdir(), 'studianda-maintenance-fresh-'));
    const freshStore = new Store(freshDir);
    const freshServer = buildServer({
      token: 'maintenance-token',
      version: 'fresh-version',
      store: freshStore,
      secrets
    });
    try {
      const response = await freshServer.inject({
        method: 'GET',
        url: '/api/v1/maintenance/status',
        headers: headers()
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as MaintenanceStatus;
      expect(body).toMatchObject({
        version: 'fresh-version',
        data_dir: freshDir,
        diagnostics_count: 0,
        backups_count: 0
      });
      expect(body.last_backup).toBeUndefined();
      expect(body.database_bytes).toBeGreaterThan(0);
      expect(body.log_bytes).toBe(0);
    } finally {
      await freshServer.close();
      freshStore.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
