import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { saveModelServices } from '../src/model-services.js';
import { Store } from '../src/store.js';

const token = 'chat-http-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-chat-http-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const app = buildServer({ token, version: 'test-version', store, secrets });
let appPort = 0;
let documentId = '';
const modelServer = createServer((request, response) => {
  if (request.url?.endsWith('/chat/completions')) {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      // 延迟响应：请求体读完后立刻 abort 会返回 499，这里必须等响应写完。
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: '真实 HTTP 路径的回答内容。' } }]
          })
        );
      }, 250);
    });
    return;
  }
  response.writeHead(404);
  response.end('{}');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const modelAddress = modelServer.address();
  const modelPort = typeof modelAddress === 'object' && modelAddress ? modelAddress.port : 0;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([420, 594]);
  page.drawText('Model training needs data.', { x: 40, y: 540, size: 14, font });
  const file = path.join(dataDir, 'http.pdf');
  writeFileSync(file, await pdf.save());
  documentId = (await store.importDocument(file)).id;

  saveModelServices(store, {
    connections: [
      {
        id: 'fake-http',
        name: 'Fake HTTP',
        platform: 'custom',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        models: [
          {
            id: 'fake-chat',
            name: 'fake-chat',
            capabilities: ['chat'],
            source: 'user',
            enabled: true
          }
        ]
      }
    ],
    routing: { chat: { connectionId: 'fake-http', model: 'fake-chat' } }
  });
  secrets.set('platform.fake-http.api_key', 'test-key');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  appPort = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('非流式 /chat/ask 真实 HTTP 生命周期', () => {
  it('请求体读完后不会把正常请求误判为取消', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/v1/chat/ask`, {
      method: 'POST',
      headers: { 'x-studianda-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '模型训练需要什么？',
        documentId,
        page: 1,
        reading_scope: 'document',
        reading_rigor: 'fast',
        source_policy: 'document_only'
      }),
      signal: AbortSignal.timeout(30_000)
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer?: string; notice?: string };
    expect(typeof body.answer).toBe('string');
    expect(body.answer ?? '').toContain('回答');
  }, 40_000);
});
