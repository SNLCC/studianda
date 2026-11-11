import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { saveZoteroConfig, zoteroAttachment } from '../src/zotero.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-webdav-zip-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const PDF_A = new TextEncoder().encode('%PDF-1.4 WEBDAV-ATTACHMENT-A');
const PDF_B = new TextEncoder().encode('%PDF-1.4 WEBDAV-ATTACHMENT-B');

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
  store.updateSettings({
    'zotero.webdav_url': `${baseUrl}/dav`,
    'zotero.webdav_user': 'user'
  });
}

/** 起一个只读 Zotero/WebDAV 替身：附件 filename 与 zip 内容由用例决定。 */
async function mockZotero(
  filename: string,
  zipFor: (itemKey: string) => Uint8Array
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const mock = createServer((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/dav/')) {
      const key = url.replace('/dav/', '').replace('.zip', '');
      response.setHeader('content-type', 'application/zip');
      response.end(Buffer.from(zipFor(key)));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          filename
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

async function attachmentWith(
  filename: string,
  zip: Uint8Array
): Promise<Awaited<ReturnType<typeof zoteroAttachment>>> {
  const mock = await mockZotero(filename, () => zip);
  configureWebdav(mock.baseUrl);
  try {
    return await zoteroAttachment(store, secrets, 'WEBDAV01', undefined, mock.baseUrl);
  } finally {
    await mock.close();
  }
}

describe('Zotero WebDAV zip 唯一 PDF 定位', () => {
  it('按 %ZB64 解码后的文件名唯一匹配', async () => {
    const encoded = `${Buffer.from('真正附件.pdf').toString('base64')}%ZB64`;
    const zip = zipSync({ [encoded]: PDF_A, 'other.pdf': PDF_B });
    const attachment = await attachmentWith('真正附件.pdf', zip);
    expect(Buffer.from(attachment.bytes!).toString('latin1')).toBe(
      Buffer.from(PDF_A).toString('latin1')
    );
  });

  it('按 basename 匹配反斜杠路径里的 PDF', async () => {
    const zip = zipSync({ 'folder\\paper.pdf': PDF_A, 'appendix.pdf': PDF_B });
    const attachment = await attachmentWith('paper.pdf', zip);
    expect(attachment.bytes).toEqual(PDF_A);
  });

  it('多 PDF 且 filenames 都不匹配时报中文错误，而不是取第一个', async () => {
    const zip = zipSync({ '正文.pdf': PDF_A, '附录.pdf': PDF_B });
    await expect(attachmentWith('missing.pdf', zip)).rejects.toThrow('无法唯一定位');
  });

  it('只有 1 个 PDF 时回退取它', async () => {
    const zip = zipSync({ 'only-one.pdf': PDF_A });
    const attachment = await attachmentWith('different-name.pdf', zip);
    expect(attachment.bytes).toEqual(PDF_A);
  });
});
