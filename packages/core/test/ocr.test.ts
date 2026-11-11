import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { strToU8, zipSync } from 'fflate';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderPdfPage, recognizePage } from '../src/ocr.js';
import { saveModelServices } from '../src/model-services.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let documentId = '';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('local OCR', () => {
  it('renders the designated PDF page to PNG', async () => {
    const imported = await store.importDocument(TEST_PDF);
    documentId = imported.id;
    const rendered = await renderPdfPage(documentId, 1, store, 2);
    expect(rendered.png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(rendered.width).toBeGreaterThan(0);
    expect(rendered.height).toBeGreaterThan(0);
  });

  it('caches OCR text and line boxes', () => {
    store.cacheOcrPage(documentId, 1, 'sample ocr text', [
      { text: 'sample', confidence: 0.9, bbox: [0.1, 0.1, 0.3, 0.2] }
    ]);
    expect(store.getPageEdit(documentId, 1)).toMatchObject({
      text: 'sample ocr text',
      origin: 'ocr'
    });
    expect(JSON.parse(store.getPageEdit(documentId, 1)?.boxes ?? '[]')).toHaveLength(1);
  });

  it('falls back to OCR boxes when the native text layer misses a quote', async () => {
    store.cacheOcrPage(documentId, 1, 'sample ocr text', [
      {
        text: 'Unique scanned sentence about causality',
        confidence: 0.92,
        bbox: [0.2, 0.3, 0.8, 0.4]
      }
    ]);
    const found = await store.locateCitation(
      documentId,
      1,
      'Unique scanned sentence about causality'
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.bbox).toEqual([0.2, 0.3, 0.8, 0.4]);
  });

  it('lets a user correction override page text and keeps OCR boxes', async () => {
    await store.savePageTextEdit(documentId, 1, 'Corrected page text');
    expect(store.getPageText(documentId, 1)).toBe('Corrected page text');
    expect(store.getPageEdit(documentId, 1)).toMatchObject({ origin: 'user' });
    expect(JSON.parse(store.getPageEdit(documentId, 1)?.boxes ?? '[]')).toHaveLength(1);
  });

  it('calls a vision model with the page image', async () => {
    let body = '';
    const mock = createServer((request, response) => {
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ choices: [{ message: { content: 'vision parsed page text' } }] })
        );
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    // 环境变量覆盖：只给无界面运行/调试用；测试用它把视觉模型指向 mock 服务。
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    saveParsingConfig(store, secrets, {
      mode: 'vision',
      model: 'vision-model',
      allow_remote: true
    });
    try {
      const result = await recognizePage(store, secrets, documentId, 2);
      expect(result.engine).toBe('vision:vision-model');
      expect(result.text).toBe('vision parsed page text');
      expect(body).toContain('image_url');
      expect(body).toContain('data:image/png;base64,');
      expect(store.getPageText(documentId, 2)).toBe('vision parsed page text');
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      saveParsingConfig(store, secrets, { mode: 'local', service_url: '' });
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('resolves the vision model address from the selected parsing connection', async () => {
    let connectionBody = '';
    let connectionAuth = '';
    const connectionServer = createServer((request, response) => {
      connectionAuth = String(request.headers.authorization ?? '');
      request.on('data', (chunk) => (connectionBody += String(chunk)));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'connection vision text' } }]
          })
        );
      });
    });
    await new Promise<void>((resolve) => connectionServer.listen(0, '127.0.0.1', resolve));
    const connectionAddress = connectionServer.address();
    if (connectionAddress == null || typeof connectionAddress === 'string') {
      throw new Error('mock address');
    }
    let routingHits = 0;
    const routingServer = createServer((request, response) => {
      routingHits += 1;
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ choices: [{ message: { content: 'routing text' } }] })
        );
      });
    });
    await new Promise<void>((resolve) => routingServer.listen(0, '127.0.0.1', resolve));
    const routingAddress = routingServer.address();
    if (routingAddress == null || typeof routingAddress === 'string') {
      throw new Error('mock address');
    }
    saveModelServices(store, {
      connections: [
        {
          id: 'conn-vision',
          name: '视觉平台',
          platform: 'custom',
          baseUrl: `http://127.0.0.1:${connectionAddress.port}/v1`,
          models: []
        },
        {
          id: 'conn-chat',
          name: '会话平台',
          platform: 'custom',
          baseUrl: `http://127.0.0.1:${routingAddress.port}/v1`,
          models: []
        }
      ],
      routing: { chat: { connectionId: 'conn-chat', model: 'routing-model' } }
    });
    secrets.set('platform.conn-vision.api_key', 'conn-key');
    saveParsingConfig(store, secrets, {
      mode: 'vision',
      connection_id: 'conn-vision',
      model: 'vision-model',
      allow_remote: true
    });
    try {
      const result = await recognizePage(store, secrets, documentId, 2);
      expect(result.engine).toBe('vision:vision-model');
      expect(result.text).toBe('connection vision text');
      expect(connectionBody).toContain('image_url');
      expect(connectionBody).toContain('data:image/png;base64,');
      expect(connectionAuth).toBe('Bearer conn-key');
      // 已经指定了解析连接时，不应再落到「会话模型」的 routing。
      expect(routingHits).toBe(0);
    } finally {
      saveParsingConfig(store, secrets, { mode: 'local', service_url: '', connection_id: '' });
      saveModelServices(store, { connections: [], routing: {} });
      secrets.clear('platform.conn-vision.api_key');
      await new Promise<void>((resolve, reject) =>
        connectionServer.close((error) => (error ? reject(error) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        routingServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('calls MinerU agent upload/poll/markdown endpoints', async () => {
    let baseUrl = '';
    const mock = createServer((request, response) => {
      const url = request.url ?? '';
      if (url === '/parse/file' && request.method === 'POST') {
        request.resume();
        request.on('end', () => {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              code: 0,
              data: { task_id: 'task-1', file_url: `${baseUrl}/upload` }
            })
          );
        });
        return;
      }
      if (url === '/upload' && request.method === 'PUT') {
        request.resume();
        request.on('end', () => response.end('ok'));
        return;
      }
      if (url === '/parse/task-1') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            code: 0,
            data: { state: 'done', markdown_url: `${baseUrl}/md` }
          })
        );
        return;
      }
      if (url === '/md') {
        response.end('agent markdown text');
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const addr = mock.address();
    if (addr == null || typeof addr === 'string') throw new Error('mock address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    saveParsingConfig(store, secrets, { mode: 'mineru_agent', allow_remote: true });
    store.updateSettings({ 'parsing.service_url': baseUrl });
    try {
      const result = await recognizePage(store, secrets, documentId, 2);
      expect(result.engine).toBe('mineru_agent');
      expect(result.text).toBe('agent markdown text');
      expect(store.getPageText(documentId, 2)).toBe('agent markdown text');
    } finally {
      saveParsingConfig(store, secrets, { mode: 'local', service_url: '' });
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 20_000);

  it('calls MinerU online batch results and extracts full.md from the zip', async () => {
    let baseUrl = '';
    const mock = createServer((request, response) => {
      const url = request.url ?? '';
      if (url === '/file-urls/batch' && request.method === 'POST') {
        request.resume();
        request.on('end', () => {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              code: 0,
              data: { batch_id: 'batch-1', file_urls: [`${baseUrl}/upload`] }
            })
          );
        });
        return;
      }
      if (url === '/upload' && request.method === 'PUT') {
        request.resume();
        request.on('end', () => response.end('ok'));
        return;
      }
      if (url === '/extract-results/batch/batch-1') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            data: {
              extract_result: { state: 'done', full_zip_url: `${baseUrl}/zip` }
            }
          })
        );
        return;
      }
      if (url === '/zip') {
        response.end(
          Buffer.from(zipSync({ 'full.md': strToU8('online full.md text') }))
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const addr = mock.address();
    if (addr == null || typeof addr === 'string') throw new Error('mock address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    saveParsingConfig(store, secrets, {
      mode: 'mineru_online',
      allow_remote: true,
      service_key: 'online-token'
    });
    store.updateSettings({ 'parsing.service_url': baseUrl });
    try {
      const result = await recognizePage(store, secrets, documentId, 2);
      expect(result.engine).toBe('mineru_online');
      expect(result.text).toBe('online full.md text');
      expect(store.getPageText(documentId, 2)).toBe('online full.md text');
    } finally {
      saveParsingConfig(store, secrets, { mode: 'local', service_url: '' });
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 20_000);

  it('calls a custom /parse service for non-local parsing', async () => {
    let received = 0;
    const mock = createServer((request, response) => {
      received += 1;
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ text: 'custom parsed page text' }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    saveParsingConfig(store, secrets, {
      mode: 'custom',
      service_url: `http://127.0.0.1:${address.port}`,
      allow_remote: true,
      service_key: 'token'
    });
    try {
      const result = await recognizePage(store, secrets, documentId, 2);
      expect(result.engine).toBe('custom');
      expect(result.text).toBe('custom parsed page text');
      expect(received).toBe(1);
      expect(store.getPageText(documentId, 2)).toBe('custom parsed page text');
    } finally {
      saveParsingConfig(store, secrets, { mode: 'local', service_url: '' });
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.skipIf(!process.env.STUDIANDA_OCR_TEST)(
    'recognizes the designated PDF page with local RapidOCR',
    async () => {
      const result = await recognizePage(store, secrets, documentId, 1, 2);
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.text).toContain('Sample');
      expect(store.getPageEdit(documentId, 1)?.origin).toBe('ocr');
    },
    600_000
  );
});
