import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { zoteroAttachment } from '../src/zotero.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-doctype-'));
const pdfPath = path.join(root, 'attachment.pdf');

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText('Zotero attachment fixture', { x: 40, y: 350, size: 16 });
  writeFileSync(pdfPath, await pdf.save());
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type MockRoute = (url: string, response: ServerResponse) => boolean;

function sendJson(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function sendPdfRedirect(response: ServerResponse): void {
  response.statusCode = 302;
  response.setHeader('location', pathToFileURL(pdfPath).href);
  response.end();
}

/** 起一个本机 mock Zotero API，跑完用例后必定关闭。 */
async function withMockZotero(
  routes: MockRoute[],
  run: (base: string) => Promise<void>
): Promise<void> {
  const mock = createServer((request, response) => {
    const url = request.url ?? '';
    for (const route of routes) {
      if (route(url, response)) return;
    }
    response.statusCode = 404;
    sendJson(response, { error: 'unexpected mock request', url });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  if (address == null || typeof address === 'string') throw new Error('mock address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      mock.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

describe('Zotero 导入自动识别文献类型', () => {
  it('父条目 itemType=thesis 映射为 docType=thesis（分栏论文）', async () => {
    const store = storeAt('thesis');
    const secrets = new SecretStore();
    try {
      await withMockZotero(
        [
          (url, response) => {
            if (url.includes('/items/PARENT01')) {
              sendJson(response, {
                data: {
                  itemType: 'thesis',
                  title: '学位论文标题',
                  creators: [{ firstName: 'Ada', lastName: 'Lovelace' }]
                }
              });
              return true;
            }
            if (url.endsWith('/file')) {
              sendPdfRedirect(response);
              return true;
            }
            if (url.includes('/items/ATTACH01')) {
              sendJson(response, {
                data: {
                  itemType: 'attachment',
                  contentType: 'application/pdf',
                  title: 'Full Text PDF',
                  parentItem: 'PARENT01'
                }
              });
              return true;
            }
            return false;
          }
        ],
        async (base) => {
          const attachment = await zoteroAttachment(store, secrets, 'ATTACH01', base);
          expect(attachment.docType).toBe('thesis');

          const document = await store.importZoteroDocument(attachment);
          expect(document).toMatchObject({ docType: 'thesis', docCategory: 'paper' });

          // 用户手动改过类型后再次打开同一 Zotero 条目：不覆盖用户选择。
          store.updateDocument(document.id, { docType: 'book' });
          const reopened = await store.importZoteroDocument({
            ...attachment,
            confirmDuplicate: true
          });
          expect(reopened.id).toBe(document.id);
          expect(reopened.docType).toBe('book');
        }
      );
    } finally {
      store.close();
    }
  });

  it('独立附件（没有父条目）docType 为空串，落库为未分类', async () => {
    const store = storeAt('standalone');
    const secrets = new SecretStore();
    try {
      await withMockZotero(
        [
          (url, response) => {
            if (url.endsWith('/file')) {
              sendPdfRedirect(response);
              return true;
            }
            if (url.includes('/items/STAND001')) {
              sendJson(response, {
                data: {
                  itemType: 'attachment',
                  contentType: 'application/pdf',
                  title: '独立附件'
                }
              });
              return true;
            }
            return false;
          }
        ],
        async (base) => {
          const attachment = await zoteroAttachment(store, secrets, 'STAND001', base);
          expect(attachment.docType).toBe('');

          const document = await store.importZoteroDocument(attachment);
          expect(document).toMatchObject({ docType: '', docCategory: 'unknown' });
        }
      );
    } finally {
      store.close();
    }
  });

  it('从顶层条目打开子 PDF 时取顶层条目的 itemType', async () => {
    const store = storeAt('top-level');
    const secrets = new SecretStore();
    try {
      await withMockZotero(
        [
          (url, response) => {
            if (url.includes('/items/THESIS01/children')) {
              sendJson(response, [
                {
                  key: 'CHILD001',
                  data: {
                    itemType: 'attachment',
                    contentType: 'application/pdf',
                    parentItem: 'THESIS01'
                  }
                }
              ]);
              return true;
            }
            if (url.includes('/items/THESIS01')) {
              sendJson(response, { data: { itemType: 'book', title: '一本图书' } });
              return true;
            }
            if (url.endsWith('/file')) {
              sendPdfRedirect(response);
              return true;
            }
            if (url.includes('/items/CHILD001')) {
              sendJson(response, {
                data: {
                  itemType: 'attachment',
                  contentType: 'application/pdf',
                  parentItem: 'THESIS01'
                }
              });
              return true;
            }
            return false;
          }
        ],
        async (base) => {
          const attachment = await zoteroAttachment(store, secrets, 'THESIS01', base);
          expect(attachment.docType).toBe('book');

          const document = await store.importZoteroDocument(attachment);
          expect(document).toMatchObject({ docType: 'book', docCategory: 'book' });
        }
      );
    } finally {
      store.close();
    }
  });
});
