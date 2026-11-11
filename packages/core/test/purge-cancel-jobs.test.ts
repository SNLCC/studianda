import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import {
  startDocumentTranslation,
  translationJobState
} from '../src/translation-service.js';

const token = 'purge-cancel-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-purge-cancel-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });
let documentId = '';
let documentName = '';

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configureTranslationModel(): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'purge-conn',
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://translate.example.com/v1',
        models: [
          {
            id: 'translate-model',
            name: 'translate-model',
            capabilities: ['translation'],
            source: 'user',
            enabled: true
          }
        ]
      }
    ],
    routing: {
      translation: { connectionId: 'purge-conn', model: 'translate-model' }
    }
  });
  secrets.set('platform.purge-conn.api_key', 'k-1');
}

/** 永不主动完成的请求：只有收到 abort 才失败，用来模拟"翻译进行中"。 */
function stallFetch(): void {
  vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  });
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.addPage([300, 400]);
  const file = path.join(dataDir, 'purge.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
  documentName = imported.name;
  store.savePageTextEdit(documentId, 1, '第一页内容。');
  store.savePageTextEdit(documentId, 2, '第二页内容。');
}, 120_000);

describe('彻底删除文献时取消后台任务', () => {
  it('purge 会停止该文献正在进行的翻译任务', async () => {
    configureTranslationModel();
    stallFetch();
    const started = startDocumentTranslation(store, secrets, documentId, {
      pages: [1, 2]
    });
    expect(started.status).toBe('running');

    // 等翻译请求真正发出去，再移入回收站并彻底删除。
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.deleteDocument(documentId);
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/purge`,
      headers: { 'x-studianda-token': token },
      payload: { confirmName: documentName }
    });
    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = translationJobState(store, documentId);
    expect(state?.status).toBe('stopped');
    expect(state?.currentPage).toBe(null);
    // 彻底删除后文档与译文都不应再存在。
    expect(store.getDocument(documentId)).toBe(null);
    expect(store.getTranslationSegments(documentId, 1)).toHaveLength(0);
  });
});
