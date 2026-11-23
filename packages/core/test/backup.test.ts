import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { createSnapshot, listBackups, verifyBackup } from '../src/backup.js';
import { applyPendingRestore, requestRestore } from '../src/backup.js';
import { generateDiagnostics } from '../src/diagnostics.js';
import { appendErrorLog, readRecentErrors } from '../src/error-log.js';
import { Store } from '../src/store.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-backup-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('backup snapshots', () => {
  it('creates a consistent zip with the database and papers', async () => {
    await store.importDocument(TEST_PDF);
    const result = await createSnapshot(store);
    expect(result.backup.name).toMatch(/^studianda-data-\d{8}-\d{6}\.zip$/);
    expect(result.backup.sizeBytes).toBeGreaterThan(0);
    expect(result.databases).toContain('reader.sqlite3');
    expect(result.entries).toContain('reader.sqlite3');
    expect(result.entries.some((entry) => entry.startsWith('papers/'))).toBe(true);
    expect(result.entries.some((entry) => entry.startsWith('backups/'))).toBe(false);
  });

  it('excludes runtime.json (plaintext local Core token) from the archive', async () => {
    const runtimeFile = path.join(dataDir, 'runtime.json');
    // Core 启动时会把本地 HTTP 鉴权 token 明文写在这里；它不能进备份。
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port: 4321, token: 'plaintext-local-token', pid: 1 }),
      'utf8'
    );
    try {
      const result = await createSnapshot(store);
      expect(result.entries).not.toContain('runtime.json');
      const archive = unzipSync(new Uint8Array(readFileSync(result.backup.path)));
      expect(archive['runtime.json']).toBeUndefined();
      expect(Object.keys(archive).some((name) => name.endsWith('runtime.json'))).toBe(false);
    } finally {
      rmSync(runtimeFile, { force: true });
    }
  });

  it('excludes secrets.json even when it is placed inside the data directory', async () => {
    const secretsFile = path.join(dataDir, 'secrets.json');
    writeFileSync(
      secretsFile,
      JSON.stringify({ version: 1, values: { 'search.api_key': 'v10-fake-ciphertext' } }),
      'utf8'
    );
    try {
      const result = await createSnapshot(store);
      expect(result.entries).not.toContain('secrets.json');
      const archive = unzipSync(new Uint8Array(readFileSync(result.backup.path)));
      expect(archive['secrets.json']).toBeUndefined();
      expect(Object.keys(archive).some((name) => name.endsWith('secrets.json'))).toBe(false);
    } finally {
      rmSync(secretsFile, { force: true });
    }
  });

  it('lists only completed backup zips', () => {
    const listed = listBackups(dataDir);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed[0]?.name.startsWith('studianda-data-')).toBe(true);
  });

  it('produces a readable sqlite snapshot', async () => {
    const result = await createSnapshot(store);
    const archive = unzipSync(new Uint8Array(readFileSync(result.backup.path)));
    expect(archive['reader.sqlite3']?.byteLength).toBeGreaterThan(0);
  });

  it('generates a sanitized diagnostics report', () => {
    const report = generateDiagnostics(store, { name: 'Studianda', version: 'test' });
    expect(report.integrity).toBe('ok');
    expect(report.counts.documents).toBe(1);
    expect(report.missingFiles).toBe(0);
    expect(report.usage.databaseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/api[_-]?key/i);
  });

  it('verifies a backup without accepting path traversal', async () => {
    const result = await createSnapshot(store);
    const verified = verifyBackup(dataDir, result.backup.name);
    expect(verified.integrity).toBe('ok');
    expect(verified.databases).toContain('reader.sqlite3');
    expect(verified.entries).toBeGreaterThan(0);
    expect(() => verifyBackup(dataDir, '../reader.sqlite3')).toThrow();
  });

  it('restores a backup on the next open with rollback data preserved', async () => {
    const restoreDir = mkdtempSync(path.join(tmpdir(), 'studianda-restore-'));
    const first = new Store(restoreDir);
    try {
      await first.importDocument(TEST_PDF);
      const snapshot = await createSnapshot(first);
      requestRestore(restoreDir, snapshot.backup.name);
      first.close();
      const restored = applyPendingRestore(restoreDir);
      expect(restored?.restored).toBe(snapshot.backup.name);
      const reopened = new Store(restoreDir);
      try {
        expect(reopened.listDocuments()).toHaveLength(1);
      } finally {
        reopened.close();
      }
      expect(restored?.rollbackDir).toBeTruthy();
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it('records redacted recent errors for diagnostics', () => {
    appendErrorLog(dataDir, 'GET /test', new Error('Authorization: Bearer abcdefghijk123'));
    const errors = readRecentErrors(dataDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.context).toBe('GET /test');
    expect(errors[0]?.message).not.toContain('abcdefghijk123');
    expect(JSON.stringify(errors)).toContain('[redacted]');
  });

  it('classifies recent errors into failed task groups', () => {
    appendErrorLog(dataDir, 'POST /api/v1/chat/ask', new Error('model failed'));
    appendErrorLog(dataDir, 'POST /api/v1/chat/ask', new Error('model failed again'));
    appendErrorLog(dataDir, 'PUT /api/v1/translation/config', new Error('bad config'));
    const report = generateDiagnostics(store, { name: 'Studianda', version: 'test' });
    const reading = report.failedTasks.find((item) => item.category === '问答/阅读');
    const translation = report.failedTasks.find((item) => item.category === '翻译');
    expect(reading?.count).toBeGreaterThanOrEqual(2);
    expect(translation?.count).toBe(1);
    expect(reading?.lastMessage).toContain('model failed');
  });
});
