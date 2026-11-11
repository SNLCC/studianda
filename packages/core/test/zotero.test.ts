import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  getZoteroConfig,
  importZoteroAnnotations,
  listZoteroCollections,
  listZoteroItems,
  probeZotero,
  saveZoteroConfig,
  zoteroAttachment
} from '../src/zotero.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('zotero config', () => {
  it('defaults to local users library 0', () => {
    expect(getZoteroConfig(store, secrets)).toMatchObject({
      mode: 'local',
      library_type: 'users',
      library_id: '0',
      has_key: false
    });
  });

  it('rejects cloud mode without a numeric library id', () => {
    expect(() =>
      saveZoteroConfig(store, secrets, { mode: 'cloud', library_id: '0' })
    ).toThrow();
  });

  it('probes a local Zotero API read-only', async () => {
    const mock = createServer((request, response) => {
      expect(request.url).toContain('/collections');
      response.setHeader('content-type', 'application/json');
      response.end('[]');
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    try {
      const result = await probeZotero(
        store,
        secrets,
        `http://127.0.0.1:${address.port}`
      );
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('local');
      // 本机成功路径保持不变：仍是这句话，且请求方式/实际端点都是 local。
      expect(result.requestedMode).toBe('local');
      expect(result.actualMode).toBe('local');
      expect(result.message).toBe('本机 Zotero 可读。');
    } finally {
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('lists local Zotero collections and top-level items', async () => {
    const mock = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.includes('/items')) {
        response.end(
          JSON.stringify([
            {
              key: 'ITEM0001',
              data: {
                title: 'A paper',
                itemType: 'journalArticle',
                date: '2024',
                creators: [{ firstName: 'Ada', lastName: 'Lovelace' }]
              }
            }
          ])
        );
        return;
      }
      response.end(JSON.stringify([{ key: 'COL00001', data: { name: 'Reading' } }]));
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect(await listZoteroCollections(store, secrets, base)).toEqual([
        { key: 'COL00001', name: 'Reading', parentCollection: '' }
      ]);
      expect(await listZoteroItems(store, secrets, '', 0, base)).toEqual([
        {
          key: 'ITEM0001',
          title: 'A paper',
          creators: 'Ada Lovelace',
          date: '2024',
          itemType: 'journalArticle',
          publication: ''
        }
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('opens a local Zotero attachment as a read-only link', async () => {
    const mock = createServer((request, response) => {
      if (request.url?.endsWith('/file')) {
        response.statusCode = 302;
        response.setHeader('location', pathToFileURL(TEST_PDF).href);
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.url?.includes('/items/PARENT01')) {
        response.end(
          JSON.stringify({
            data: {
              title: 'Parent paper',
              creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }]
            }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            itemType: 'attachment',
            contentType: 'application/pdf',
            title: 'PDF',
            parentItem: 'PARENT01'
          }
        })
      );
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    try {
      const attachment = await zoteroAttachment(
        store,
        secrets,
        'ATTACH01',
        `http://127.0.0.1:${address.port}`
      );
      expect(attachment.externalPath).toBe(TEST_PDF);
      expect(attachment.title).toBe('Parent paper');
      expect(attachment.author).toBe('Ada Lovelace');
      const document = await store.importZoteroDocument(attachment);
      expect(document.fileState.storageKind).toBe('zotero');
      expect(document.pages).toBe(2);
      expect((await store.importZoteroDocument({ ...attachment, confirmDuplicate: true })).id).toBe(
        document.id
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('downloads a WebDAV attachment zip and imports it as a cached copy', async () => {
    const pdfBytes = new Uint8Array(readFileSync(TEST_PDF));
    saveZoteroConfig(store, secrets, {
      mode: 'webdav',
      library_type: 'users',
      library_id: '123',
      webdav_url: 'https://dav.example.test/zotero',
      webdav_user: 'user',
      webdav_password: 'password',
      api_key: 'zotero-key'
    });
    let baseUrl = '';
    const mock = createServer((request, response) => {
      const url = request.url ?? '';
      if (url.startsWith('/dav/ATTACH03.zip')) {
        response.setHeader('content-type', 'application/zip');
        response.end(Buffer.from(zipSync({ 'paper.pdf': pdfBytes })));
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (url.includes('/items/PARENT03')) {
        response.end(
          JSON.stringify({
            data: {
              title: 'WebDAV paper',
              creators: [{ creatorType: 'author', lastName: 'Turing' }]
            }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            itemType: 'attachment',
            contentType: 'application/pdf',
            filename: 'paper.pdf',
            parentItem: 'PARENT03'
          }
        })
      );
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    store.updateSettings({
      'zotero.webdav_url': `${baseUrl}/dav`,
      'zotero.webdav_user': 'user'
    });
    try {
      const attachment = await zoteroAttachment(
        store,
        secrets,
        'ATTACH03',
        undefined,
        baseUrl
      );
      expect(attachment.bytes?.byteLength).toBeGreaterThan(0);
      expect(attachment.title).toBe('WebDAV paper');
      const document = await store.importZoteroDocument(attachment);
      expect(document.fileState.storageKind).toBe('zotero_cache');
      expect(document.pages).toBe(2);
    } finally {
      saveZoteroConfig(store, secrets, { mode: 'local', library_id: '0' });
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('converts a Zotero link into an app-owned copy', async () => {
    const linked = await store.importZoteroDocument({
      identity: `local:users:0:SNAP0001:${TEST_PDF}`,
      title: 'Snapshot target',
      author: '',
      externalPath: TEST_PDF
    });
    expect(linked.fileState.storageKind).toBe('zotero');
    const copied = await store.snapshotZoteroDocument(linked.id);
    expect(copied.fileState.storageKind).toBe('copy');
    expect(store.getDocumentExternalKey(linked.id)).toBe('');
    expect(store.getDocumentPath(linked.id)).toBeTruthy();
    expect(copied.pages).toBe(2);
  });

  it('previews and imports Zotero annotations idempotently', async () => {    const document = await store.importZoteroDocument({
      identity: `local:users:0:ANNIMP01:${TEST_PDF}`,
      title: 'Annotation target',
      author: '',
      externalPath: TEST_PDF
    });
    const mock = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.includes('/children')) {
        response.end(
          JSON.stringify([
            {
              key: 'ANNOT001',
              data: {
                annotationType: 'highlight',
                annotationText: 'A Sample Two-Column Academic Paper',
                annotationComment: 'important',
                annotationColor: '#ffd400',
                annotationPosition: JSON.stringify({ pageIndex: 0 })
              }
            }
          ])
        );
        return;
      }
      response.end('{}');
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const preview = await importZoteroAnnotations(store, secrets, document.id, false, base);
      expect(preview.wouldImport).toBe(1);
      expect(preview.imported).toBe(0);
      const imported = await importZoteroAnnotations(store, secrets, document.id, true, base);
      expect(imported.imported).toBe(1);
      expect(store.listAnnotations(document.id)).toHaveLength(1);
      const again = await importZoteroAnnotations(store, secrets, document.id, true, base);
      expect(again.imported).toBe(0);
      expect(again.skippedExisting).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
