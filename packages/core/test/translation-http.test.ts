import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 真实 HTTP 回归：用 `request.raw.once('close', abort)` 判断取消并不可靠——
 * Node 的请求流在**正常收完请求体**时也会触发 'close'，导致请求刚开始就被 abort（翻译永远 499
 * “翻译已取消”、模型测试永远报中断）。`server.inject` 不经过真实 socket，测不出这个问题。
 */

const token = 'http-translation-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-http-translation-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });
const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');

const mockModel = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '这是模拟译文。' } }] }));
  });
});

let base = '';

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => mockModel.listen(0, '127.0.0.1', resolve));
  const address = mockModel.address();
  if (address == null || typeof address === 'string') throw new Error('mock address');
  process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.STUDIANDA_MODEL_NAME = 'mock-model';
  await server.listen({ port: 0, host: '127.0.0.1' });
  const actual = server.server.address();
  if (actual == null || typeof actual === 'string') throw new Error('server address');
  base = `http://127.0.0.1:${actual.port}`;
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-studianda-token': token };
}

afterAll(async () => {
  await server.close();
  await new Promise<void>((resolve) => mockModel.close(() => resolve()));
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('真实 HTTP 下的长请求取消语义', () => {
  it('页面翻译不会被正常结束的请求流误取消', async () => {
    await listen();
    const imported = await fetch(`${base}/api/v1/documents/import`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ path: TEST_PDF, confirmLarge: true })
    });
    expect(imported.status).toBe(200);
    const documentId = ((await imported.json()) as { id: string }).id;

    const response = await fetch(
      `${base}/api/v1/documents/${encodeURIComponent(documentId)}/translation/pages/1`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ include_furniture: false })
      }
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      page?: { status?: string };
      pageSize?: { width?: number; height?: number };
      bodyFontSize?: number;
      segments?: Array<{
        text?: string;
        bbox?: number[] | null;
        lineBoxes?: number[][];
      }>;
    };
    expect(payload.segments?.length ?? 0).toBeGreaterThan(0);
    expect(payload.page?.status).toBe('done');

    // 版式呈现依赖服务端直接给出逐行框与版面字号：POST（刚翻译完）与 GET（刷新/切页）都要有。
    const assertLayoutBoxes = (title: string, data: typeof payload): void => {
      expect(data.pageSize?.width ?? 0, `${title}: pageSize.width`).toBeGreaterThan(0);
      expect(data.bodyFontSize ?? 0, `${title}: bodyFontSize`).toBeGreaterThan(0);
      const boxes = (data.segments ?? [])
        .map((segment) => segment.bbox)
        .filter((box): box is number[] => Array.isArray(box) && box.length === 4);
      expect(boxes.length, `${title}: segments with bbox`).toBeGreaterThan(0);
      for (const box of boxes) {
        const [x0, y0, x1, y1] = box as [number, number, number, number];
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(1);
        expect(y1).toBeLessThanOrEqual(1);
        expect(x1).toBeGreaterThan(x0);
        expect(y1).toBeGreaterThan(y0);
      }
      // 逐行框：版式按行摆放，不能只有整段框（跨栏段落的整段框会把中间内容一起盖住）。
      const lineSegments = (data.segments ?? []).filter(
        (segment) => (segment.lineBoxes?.length ?? 0) > 0
      );
      expect(lineSegments.length, `${title}: segments with lineBoxes`).toBeGreaterThan(0);
      for (const segment of lineSegments) {
        for (const box of segment.lineBoxes ?? []) {
          const [x0, y0, x1, y1] = box as [number, number, number, number];
          expect(x1).toBeGreaterThan(x0);
          expect(y1).toBeGreaterThan(y0);
          expect(x0).toBeGreaterThanOrEqual(0);
          expect(y0).toBeGreaterThanOrEqual(0);
          expect(x1).toBeLessThanOrEqual(1);
          expect(y1).toBeLessThanOrEqual(1);
        }
      }
    };
    assertLayoutBoxes('POST', payload);

    const refreshed = await fetch(
      `${base}/api/v1/documents/${encodeURIComponent(documentId)}/translation/pages/1`,
      { headers: headers() }
    );
    expect(refreshed.status).toBe(200);
    assertLayoutBoxes(
      'GET',
      (await refreshed.json()) as typeof payload
    );
  });

  it('模型连接测试不会被正常结束的请求流误取消', async () => {
    const response = await fetch(`${base}/api/v1/model/test`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({})
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok?: boolean; model?: string };
    expect(result.ok).toBe(true);
    expect(result.model).toBe('mock-model');
  });
});
