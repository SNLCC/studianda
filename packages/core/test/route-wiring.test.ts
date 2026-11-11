import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 路由接线矩阵：以 docs/api/route-manifest.json 为准，对每条已注册路由发一次真实 HTTP 请求。
 * 目的不是验证业务逻辑（各域已有单测），而是保证"路由确实接到 handler、缺参/坏 ID 不 500"。
 * SSE/流式接口会挂起，显式跳过（它们已有专门的流测试）。
 */
const manifestPath = path.resolve(import.meta.dirname, '../../../docs/api/route-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  serverRoutes: string[];
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-route-wiring-'));
const store = new Store(dataDir);
const server = buildServer({
  token: 'route-wiring-token',
  version: 'test',
  store,
  secrets: new SecretStore()
});
let documentId = '';

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(hasBody = false): Record<string, string> {
  return {
    'x-studianda-token': 'route-wiring-token',
    ...(hasBody ? { 'content-type': 'application/json' } : {})
  };
}

const SKIP_PATTERNS = [/\/events$/, /\/chat$/, /\/qa\/ask$/, /\/reading\/plan$/];

function toUrl(template: string): string {
  return template.replace(/\/:p(?=\/|$)/g, `/${encodeURIComponent('wire-id')}`);
}

describe('route wiring', () => {
  it('creates a fixture document', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const file = path.join(dataDir, 'route-wiring.pdf');
    writeFileSync(file, await pdf.save());
    const document = await store.importDocument(file);
    documentId = document.id;
    expect(documentId).toBeTruthy();
  });

  it('every manifest route is registered and does not crash on placeholder input', async () => {
    expect(manifest.serverRoutes.length).toBeGreaterThan(40);
    for (const entry of manifest.serverRoutes) {
      const [method, template] = entry.split(' ') as [string, string];
      if (SKIP_PATTERNS.some((pattern) => pattern.test(template))) continue;
      const url = toUrl(template).replace('/api/v1/documents/wire-id', `/api/v1/documents/${documentId}`);
      const hasBody = method !== 'GET' && method !== 'DELETE';
      const response = await server.inject({
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url,
        headers: headers(hasBody),
        payload: hasBody ? {} : undefined
      });
      // 允许业务 404/400/409/415/422/503，但不允许未注册路由或未捕获异常。
      expect(response.statusCode, `${entry} -> ${response.statusCode}`).not.toBe(500);
      if (response.statusCode === 404) {
        const body = response.json() as { message?: string };
        expect(body.message ?? '', `${entry} 未注册`).not.toMatch(/^Route \w+:/);
      }
    }
  }, 180_000);
});
