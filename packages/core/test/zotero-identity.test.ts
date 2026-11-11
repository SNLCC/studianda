import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  diagnoseZotero,
  importZoteroAnnotations,
  zoteroAttachment
} from '../src/zotero.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-identity-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let pdfPath = '';

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('zotero-identity-fixture');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 600]);
  page.drawText('Evidence sentence for Zotero annotations', {
    x: 40,
    y: 540,
    size: 12,
    font
  });
  pdfPath = path.join(dataDir, 'fixture.pdf');
  writeFileSync(pdfPath, await pdf.save());
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(
  handler: (url: string) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const result = handler(url);
    const headers = new Headers({
      'content-type': 'application/json',
      ...(result.headers ?? {})
    });
    return new Response(
      result.status === 302 || result.body === undefined ? null : JSON.stringify(result.body),
      { status: result.status ?? 200, headers }
    );
  });
  return urls;
}

function useCloudUsers(libraryId: string): void {
  store.updateSettings({
    'zotero.mode': 'cloud',
    'zotero.library_type': 'users',
    'zotero.library_id': libraryId
  });
  secrets.set('zotero.api_key', 'secret-key-abc123');
}

describe('Zotero keys/current diagnosis', () => {
  it('reports the account, mismatched ID and permissions without leaking the key', async () => {
    useCloudUsers('111');
    const urls = mockFetch((url) =>
      url.includes('/keys/current')
        ? {
            body: {
              userID: 222,
              username: 'alice',
              access: { user: { library: true }, groups: {} }
            }
          }
        : { body: [] }
    );
    const result = await diagnoseZotero(store, secrets);
    expect(urls.some((url) => url.includes('/keys/current'))).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.suggested_library_id).toBe('222');
    const detail = result.detail.join('\n');
    expect(detail).toContain('密钥属于账户 alice');
    expect(detail).toContain('222');
    expect(detail).toContain('不一致');
    expect(JSON.stringify(result)).not.toContain('secret-key-abc123');
  });

  it('reports a 403 from keys/current with a re-check-permissions suggestion', async () => {
    useCloudUsers('111');
    mockFetch((url) =>
      url.includes('/keys/current') ? { status: 403, body: [] } : { body: [] }
    );
    const result = await diagnoseZotero(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('403');
    expect(result.detail.join('\n')).toContain('zotero.org');
    expect(JSON.stringify(result)).not.toContain('secret-key-abc123');
  });

  it('warns when the key has no read permission for the configured group', async () => {
    store.updateSettings({
      'zotero.mode': 'cloud',
      'zotero.library_type': 'groups',
      'zotero.library_id': '999'
    });
    secrets.set('zotero.api_key', 'secret-key-abc123');
    mockFetch((url) =>
      url.includes('/keys/current')
        ? {
            body: {
              userID: 5,
              username: 'bob',
              access: { user: { library: true }, groups: { '999': { library: false } } }
            }
          }
        : { body: [] }
    );
    const result = await diagnoseZotero(store, secrets);
    const detail = result.detail.join('\n');
    expect(detail).toContain('没有读取权限');
    expect(detail).toContain('999');
    expect(result.ok).toBe(true);
    expect(result.suggested_library_id).toBe('');
  });

  it('reports group read permission when granted', async () => {
    store.updateSettings({
      'zotero.mode': 'cloud',
      'zotero.library_type': 'groups',
      'zotero.library_id': '999'
    });
    secrets.set('zotero.api_key', 'secret-key-abc123');
    mockFetch((url) =>
      url.includes('/keys/current')
        ? {
            body: {
              userID: 5,
              username: 'bob',
              access: { user: { library: true }, groups: { '999': { library: true } } }
            }
          }
        : { body: [] }
    );
    const result = await diagnoseZotero(store, secrets);
    expect(result.detail.join('\n')).toContain('有读取权限');
  });

  it('keeps local diagnosis unchanged (no keys/current call)', async () => {
    store.updateSettings({
      'zotero.mode': 'local',
      'zotero.library_type': 'users',
      'zotero.library_id': '0'
    });
    secrets.set('zotero.api_key', 'secret-key-abc123');
    const urls = mockFetch(() => ({ body: [] }));
    const result = await diagnoseZotero(store, secrets);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('本机 Zotero 可读');
    expect(urls.some((url) => url.includes('/keys/current'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-key-abc123');
  });
});

describe('Zotero attachment identity', () => {
  function mockAttachmentApi(): void {
    mockFetch((url): { status?: number; body?: unknown; headers?: Record<string, string> } => {
      if (url.endsWith('/file')) {
        return {
          status: 302,
          headers: { location: pathToFileURL(pdfPath).href }
        };
      }
      if (url.includes('/items/ATTACH01')) {
        return {
          body: {
            data: {
              itemType: 'attachment',
              contentType: 'application/pdf',
              title: 'Identity PDF'
            }
          },
          headers: { 'Zotero-Server-ID': 'SERV42' }
        };
      }
      return { body: [] };
    });
  }

  it('is stable across opens and contains server id, library and path', async () => {
    store.updateSettings({
      'zotero.mode': 'local',
      'zotero.library_type': 'users',
      'zotero.library_id': '0'
    });
    mockAttachmentApi();
    const first = await zoteroAttachment(
      store,
      secrets,
      'ATTACH01',
      'http://local.example/api'
    );
    const second = await zoteroAttachment(
      store,
      secrets,
      'ATTACH01',
      'http://local.example/api'
    );
    expect(first.identity).toBe(second.identity);
    expect(first.identity).toBe(`local:users:0:SERV42:ATTACH01:${pdfPath}`);
    expect(first.legacyIdentity).toBe(`local:users:0:ATTACH01:${pdfPath}`);
    expect(first.externalPath).toBe(pdfPath);
  });

  it('re-opens a document imported under the legacy identity without duplicating it', async () => {
    store.updateSettings({
      'zotero.mode': 'local',
      'zotero.library_type': 'users',
      'zotero.library_id': '0'
    });
    mockAttachmentApi();
    const attachment = await zoteroAttachment(
      store,
      secrets,
      'ATTACH01',
      'http://local.example/api'
    );
    const old = await store.importZoteroDocument({
      identity: attachment.legacyIdentity!,
      title: 'legacy identity paper',
      author: '',
      externalPath: pdfPath
    });
    const reopened = await store.importZoteroDocument({
      ...attachment,
      confirmDuplicate: true
    });
    expect(reopened.id).toBe(old.id);
    // 重新打开后 external_key 迁移为新身份（含 Server-ID）。
    expect(store.getDocumentExternalKey(old.id)).toBe(attachment.identity);
  });
});

describe('Zotero annotation children fallback', () => {
  async function makeAnnotationDocument(key: string): Promise<string> {
    const document = await store.importZoteroDocument({
      identity: `local:users:0:${key}:${pdfPath}`,
      title: `annotation ${key}`,
      author: '',
      externalPath: pdfPath
    });
    return document.id;
  }

  it('falls back to itemType=annotation when children has no annotations and de-duplicates', async () => {
    const documentId = await makeAnnotationDocument('ATTACH09');
    const annotation = {
      key: 'ANNOTAAA',
      data: {
        itemType: 'annotation',
        parentItem: 'ATTACH09',
        annotationType: 'highlight',
        annotationText: 'Evidence sentence',
        annotationComment: 'important',
        annotationColor: '#ffd400',
        annotationPosition: JSON.stringify({ pageIndex: 0 })
      }
    };
    const urls = mockFetch((url) => {
      if (url.includes('/items/ATTACH09/children')) {
        return { body: [{ key: 'NOTE0001', data: { itemType: 'note' } }] };
      }
      if (url.includes('itemType=annotation')) {
        // 同一 key 返回两次：兜底结果必须去重。
        return { body: [annotation, annotation] };
      }
      return { body: [] };
    });
    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(urls.some((url) => url.includes('itemType=annotation'))).toBe(true);
    expect(preview.total).toBe(1);
    expect(preview.wouldImport).toBe(1);
    expect(preview.items).toHaveLength(1);
  });

  it('treats a failed fallback as "no extra annotations" instead of throwing', async () => {
    const documentId = await makeAnnotationDocument('ATTACH10');
    mockFetch((url) => {
      if (url.includes('/items/ATTACH10/children')) return { body: [] };
      if (url.includes('itemType=annotation')) return { status: 500, body: [] };
      return { body: [] };
    });
    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(preview.total).toBe(0);
    expect(preview.wouldImport).toBe(0);
  });
});
