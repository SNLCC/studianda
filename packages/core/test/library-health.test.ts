import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDiagnosticsPackage,
  listDiagnosticsPackages
} from '../src/diagnostics.js';
import { appendErrorLog, readRecentErrors } from '../src/error-log.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-library-health-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const FIXTURE_TEXT = 'HEALTH FIXTURE SECRET BODY';
let documentId = '';
let copyPath = '';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('library-health-fixture');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 600]);
  page.drawText(FIXTURE_TEXT, { x: 40, y: 540, size: 12, font });
  const file = path.join(dataDir, 'fixture.pdf');
  writeFileSync(file, await pdf.save());
  documentId = (await store.importDocument(file)).id;
  copyPath = store.getDocumentPath(documentId)!;
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('document health', () => {
  it('reports a healthy document before the copy is removed', () => {
    const health = store.documentHealth();
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      documentId,
      missing: false,
      path: copyPath
    });
    expect(store.listDocuments()[0]?.missing_file).toBe(false);
  });

  it('reports a missing attachment but keeps the document record', () => {
    unlinkSync(copyPath);
    const health = store.documentHealth().find((item) => item.documentId === documentId);
    expect(health).toMatchObject({ missing: true, path: copyPath });
    expect(existsSync(copyPath)).toBe(false);
    expect(store.getDocument(documentId)).not.toBeNull();
    expect(store.listDocuments()[0]?.missing_file).toBe(true);
    expect(store.missingDocumentFiles()).toBe(1);
  });
});

describe('error log rotation', () => {
  it('rotates application.log to .1 after 5MB and keeps writing', () => {
    const logPath = path.join(dataDir, 'application.log');
    const backupPath = `${logPath}.1`;
    writeFileSync(logPath, `${'x'.repeat(5 * 1024 * 1024 + 100)}\n`, 'utf8');
    appendErrorLog(dataDir, 'GET /test', new Error('rotation marker'));
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toContain('x'.repeat(1000));
    expect(readRecentErrors(dataDir).length).toBe(1);
    expect(readRecentErrors(dataDir)[0]?.message).toBe('rotation marker');
    // 再写一条：新日志继续追加，旧文件仍是 1 个。
    appendErrorLog(dataDir, 'GET /test', new Error('after rotation'));
    expect(readRecentErrors(dataDir).length).toBe(2);
    expect(readRecentErrors(dataDir)[0]?.message).toBe('after rotation');
    expect(existsSync(`${logPath}.2`)).toBe(false);
  });
});

describe('diagnostics package', () => {
  it('creates a zip with diagnostics and logs but no PDF or full text', () => {
    const created = createDiagnosticsPackage(store, { name: 'studianda', version: 'test-1.0' });
    expect(created.name).toMatch(/^studianda-diagnostics-.*\.zip$/);
    expect(created.path.startsWith(path.join(dataDir, 'diagnostics'))).toBe(true);
    expect(existsSync(created.path)).toBe(true);
    expect(created.bytes).toBe(readFileSync(created.path).byteLength);

    const entries = unzipSync(new Uint8Array(readFileSync(created.path)));
    const names = Object.keys(entries);
    expect(names).toContain('diagnostics.json');
    expect(names).toContain('recent-errors.json');
    expect(names).toContain('README.txt');
    expect(names.some((name) => name.toLowerCase().endsWith('.pdf'))).toBe(false);

    const text = names.map((name) => strFromU8(entries[name]!)).join('\n');
    expect(text).toContain('"generatedAt"');
    expect(text).not.toContain(FIXTURE_TEXT);
    expect(text).not.toContain('%PDF');
    // 日志尾部可以进包（脱敏后的错误日志），但 PDF/正文不能。
    expect(text).toContain('after rotation');
  });

  it('keeps at most 5 packages', async () => {
    for (let index = 0; index < 6; index += 1) {
      await wait(3);
      createDiagnosticsPackage(store, { name: 'studianda', version: 'test-1.0' });
    }
    const packages = listDiagnosticsPackages(store);
    expect(packages.length).toBe(5);
    for (const item of packages) {
      expect(item.name.startsWith('studianda-diagnostics-')).toBe(true);
      expect(item.bytes).toBeGreaterThan(0);
      expect(item.createdAt).not.toBe('');
    }
  });
});

describe('server endpoints', () => {
  it('returns missing_file on documents and exposes diagnostics packages', async () => {
    const server = buildServer({
      token: 'test-token',
      version: 'test-version',
      store,
      secrets
    });
    try {
      const documents = await server.inject({
        method: 'GET',
        url: '/api/v1/documents',
        headers: { 'x-studianda-token': 'test-token' }
      });
      expect(documents.statusCode).toBe(200);
      const list = documents.json() as Array<{ id: string; missing_file?: boolean }>;
      expect(list.find((item) => item.id === documentId)?.missing_file).toBe(true);

      const created = await server.inject({
        method: 'POST',
        url: '/api/v1/maintenance/diagnostics',
        headers: { 'x-studianda-token': 'test-token' },
        payload: {}
      });
      expect(created.statusCode).toBe(200);
      const body = created.json() as { path: string; name: string; bytes: number };
      expect(body.name).toMatch(/^studianda-diagnostics-.*\.zip$/);
      expect(existsSync(body.path)).toBe(true);

      const listed = await server.inject({
        method: 'GET',
        url: '/api/v1/maintenance/diagnostics',
        headers: { 'x-studianda-token': 'test-token' }
      });
      expect(listed.statusCode).toBe(200);
      const packages = listed.json() as Array<{ name: string; bytes: number }>;
      expect(packages.length).toBe(5);
      expect(packages.some((item) => item.name === body.name)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
