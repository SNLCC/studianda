import { copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { AttachmentChangedError, Store } from '../src/store.js';
import { saveZoteroConfig, zoteroAttachment } from '../src/zotero.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const token = 'zotero-integrity-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-integrity-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function configureWebdav(baseUrl: string): void {
  saveZoteroConfig(store, secrets, {
    mode: 'webdav',
    library_type: 'users',
    library_id: '123',
    webdav_url: 'https://dav.example.test/zotero',
    webdav_user: 'user',
    webdav_password: 'password',
    api_key: 'zotero-key'
  });
  // 测试用本机 http 替身：绕过保存时的 HTTPS 校验（等价于既有 zotero.test.ts 的做法）。
  store.updateSettings({
    'zotero.webdav_url': `${baseUrl}/dav`,
    'zotero.webdav_user': 'user'
  });
}

/** 起一个只读的 Zotero/WebDAV 替身：附件 ZIP 内容由调用方决定。 */
async function mockZotero(
  zipFor: (itemKey: string) => Uint8Array
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const pdfBytes = new Uint8Array(readFileSync(TEST_PDF));
  const mock = createServer((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/dav/')) {
      const key = url.replace('/dav/', '').replace('.zip', '');
      response.setHeader('content-type', 'application/zip');
      response.end(Buffer.from(zipFor(key)));
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (url.includes('/items/PARENT')) {
      response.end(JSON.stringify({ data: { title: '附件包论文', creators: [] } }));
      return;
    }
    response.end(
      JSON.stringify({
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          filename: 'paper.pdf',
          parentItem: 'PARENT',
          size: pdfBytes.byteLength
        }
      })
    );
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  if (address == null || typeof address === 'string') throw new Error('mock address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

describe('WebDAV 附件必须唯一', () => {
  it('压缩包里有多份 PDF 时拒绝，而不是取第一个', async () => {
    const pdfBytes = new Uint8Array(readFileSync(TEST_PDF));
    const mock = await mockZotero(() =>
      zipSync({ '正文.pdf': pdfBytes, '附录.pdf': pdfBytes })
    );
    configureWebdav(mock.baseUrl);
    try {
      await expect(zoteroAttachment(store, secrets, 'MULTI001', undefined, mock.baseUrl)).rejects.toThrow(
        '无法唯一定位'
      );
    } finally {
      await mock.close();
    }
  });

  it('按 %ZB64 解出文件名后能唯一定位 PDF', async () => {
    const pdfBytes = new Uint8Array(readFileSync(TEST_PDF));
    const encoded = `${Buffer.from('真正附件.pdf').toString('base64')}%ZB64`;
    const mock = await mockZotero(() => zipSync({ [encoded]: pdfBytes }));
    configureWebdav(mock.baseUrl);
    try {
      const attachment = await zoteroAttachment(
        store,
        secrets,
        'ZB640001',
        undefined,
        mock.baseUrl
      );
      expect(attachment.bytes?.byteLength).toBeGreaterThan(0);
    } finally {
      await mock.close();
    }
  });
});

describe('Zotero 本机附件变化', () => {
  it('文件被外部修改后拒绝继续使用旧索引', async () => {
    const source = path.join(dataDir, 'zotero-local.pdf');
    copyFileSync(TEST_PDF, source);
    const document = await store.importZoteroDocument({
      identity: 'zotero-local:TEST01',
      title: '本机附件论文',
      author: 'Ada',
      externalPath: source
    });
    expect(store.getDocumentPath(document.id)).toBe(source);

    // 模拟 Zotero 重新同步/外部替换：mtime 变化，大小不变。
    const future = new Date(Date.now() + 10_000);
    utimesSync(source, future, future);

    expect(() => store.getDocumentPath(document.id)).toThrow(AttachmentChangedError);
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${document.id}/pages/1`,
      headers: { 'x-studianda-token': token }
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('attachment_changed');
  });
});

