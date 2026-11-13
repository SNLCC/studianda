import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const token = 'test-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-core-'));
const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(text = 'Hello'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  page.drawText(text, { x: 50, y: 350, size: 24 });
  return pdf.save();
}

async function makeMultiPagePdf(texts: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const text of texts) {
    const page = pdf.addPage([300, 400]);
    page.drawText(text, { x: 40, y: 340, size: 14 });
  }
  return pdf.save();
}

async function makeTextHeavyPdf(texts: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const text of texts) {
    const page = pdf.addPage([420, 594]);
    const words = text.split(/\s+/);
    let line = '';
    let y = 560;
    for (const word of words) {
      if (`${line} ${word}`.length > 70) {
        page.drawText(line, { x: 30, y, size: 10 });
        y -= 12;
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
      if (y < 30) break;
    }
    if (line && y >= 30) page.drawText(line, { x: 30, y, size: 10 });
  }
  return pdf.save();
}

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function multipartPdf(
  bytes: Uint8Array,
  filename = 'upload.pdf'
): { payload: Buffer; contentType: string } {
  const boundary = '----studianda-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/pdf\r\n\r\n',
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

describe('core health endpoint', () => {
  it('rejects requests without the launch token', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the health payload with the launch token', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      application: 'studianda',
      version: 'test-version',
      api_version: 1,
      closing: false
    });
  });

  it('rejects a foreign Host header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { ...headers(), host: 'evil.example' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', message: 'Invalid host' });
  });

  it('rejects a foreign Origin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { ...headers(), origin: 'https://evil.example' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', message: 'Invalid origin' });
  });

  it('echoes a valid localhost origin instead of *', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { ...headers(), origin: 'http://localhost:5173' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173'
    );
    expect(String(response.headers.vary ?? '')).toContain('origin');
  });

  it('accepts the Electron file origin (null) and echoes it', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { ...headers(), origin: 'null' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('null');
  });

  it('answers an OPTIONS preflight for an allowed origin without a token', async () => {
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents',
      headers: { origin: 'http://127.0.0.1:5173' }
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:5173'
    );
  });

  it('answers an OPTIONS preflight for the Electron null origin', async () => {
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents',
      headers: { origin: 'null' }
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(String(response.headers['access-control-allow-headers'] ?? '')).toContain(
      'x-studianda-token'
    );
  });

  it('rejects an OPTIONS preflight from a foreign origin', async () => {
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents',
      headers: { origin: 'https://evil.example' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', message: 'Invalid origin' });
  });

  it('keeps accepting requests without Origin (inject / native clients)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('documents and annotations', () => {
  it('imports a PDF, lists it and streams its file', async () => {
    const pdfPath = path.join(dataDir, 'sample.pdf');
    writeFileSync(pdfPath, await makePdf());

    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath }
    });
    expect(imported.statusCode).toBe(200);
    const document = imported.json() as { id: string; pages: number; name: string };
    expect(document.pages).toBe(1);
    expect(document.name).toBe('sample.pdf');

    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const file = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${document.id}/file`,
      headers: headers()
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    const search = await server.inject({
      method: 'GET',
      url: '/api/v1/search?q=Hello',
      headers: headers()
    });
    expect(search.statusCode).toBe(200);
    const hits = search.json() as Array<{ documentId: string; page: number; snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ documentId: document.id, page: 1 });
    expect(hits[0]?.snippet).toContain('Hello');

    const index = await server.inject({
      method: 'POST',
      url: '/api/v1/embeddings/index',
      headers: headers(),
      payload: {}
    });
    expect(index.statusCode).toBe(200);
    expect(index.json()).toMatchObject({ model: 'local-tfidf', external: false, indexed: 0 });

    const status = await server.inject({
      method: 'GET',
      url: '/api/v1/embeddings/status',
      headers: headers()
    });
    const statusBody = status.json() as { chunks: number; vectors: number; external: boolean };
    expect(statusBody.chunks).toBeGreaterThan(0);
    expect(statusBody.external).toBe(false);
    expect(statusBody.vectors).toBe(0);
  });

  it('stores, updates and soft-deletes page annotations', async () => {
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    const documentId = (list.json() as Array<{ id: string }>)[0]?.id;
    expect(documentId).toBeTruthy();

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/annotations',
      headers: headers(),
      payload: {
        documentId,
        page: 1,
        quote: 'Hello',
        content: '第一条批注',
        color: 'yellow'
      }
    });
    expect(created.statusCode).toBe(200);
    const annotation = created.json() as { id: string; content: string };
    expect(annotation.content).toBe('第一条批注');

    const updated = await server.inject({
      method: 'PATCH',
      url: `/api/v1/annotations/${annotation.id}`,
      headers: headers(),
      payload: { content: '改过的批注' }
    });
    expect(updated.json()).toMatchObject({ content: '改过的批注' });

    const listed = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/annotations`,
      headers: headers()
    });
    expect(listed.json()).toHaveLength(1);

    const invalidSelection = await server.inject({
      method: 'POST',
      url: '/api/v1/annotations',
      headers: headers(),
      payload: {
        documentId,
        page: 1,
        quote: 'bad rect',
        rects: JSON.stringify([[0, 0, 1.2, 0.5]])
      }
    });
    expect(invalidSelection.statusCode).toBe(400);

    const selection = await server.inject({
      method: 'POST',
      url: '/api/v1/annotations',
      headers: headers(),
      payload: {
        documentId,
        page: 1,
        quote: '选中原文',
        content: '选中批注',
        rects: JSON.stringify([[0.1, 0.2, 0.3, 0.4]]),
        color: 'green',
        style: 'underline'
      }
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json()).toMatchObject({ color: 'green', style: 'underline' });

    const exported = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/export`,
      headers: headers()
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/markdown');
    expect(exported.body).toContain('选中原文');
    expect(exported.body).toContain('选中批注');

    const annotated = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/annotated.pdf`,
      headers: headers()
    });
    expect(annotated.statusCode).toBe(200);
    expect(annotated.headers['content-type']).toContain('application/pdf');
    expect(Number(annotated.headers['x-studianda-placed'])).toBeGreaterThan(0);
    const payload = (annotated as unknown as { rawPayload: Buffer }).rawPayload;
    const outputPdf = await PDFDocument.load(payload);
    expect(outputPdf.getPage(0).node.lookup(PDFName.of('Annots'))).toBeTruthy();
    expect(payload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${annotation.id}`,
      headers: headers()
    });
    expect(removed.statusCode).toBe(204);

    const afterDelete = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/annotations`,
      headers: headers()
    });
    expect(afterDelete.json()).toHaveLength(1);
    expect(afterDelete.json()).toMatchObject([{ quote: '选中原文' }]);
  });
});

describe('scoped search', () => {
  it('honors selection, explicit document scope and rejects empty cross-book scope', async () => {
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    const documentId = (list.json() as Array<{ id: string }>)[0]?.id;
    expect(documentId).toBeTruthy();

    const local = await server.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers: headers(),
      payload: {
        query: 'Hello',
        documentId,
        selection: 'Hello',
        page: 1,
        mode: 'close'
      }
    });
    expect(local.statusCode).toBe(200);
    expect((local.json() as unknown[]).length).toBeGreaterThan(0);

    const scoped = await server.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers: headers(),
      payload: {
        query: 'Hello',
        documentId,
        crossBook: true,
        scope: 'documents',
        scopeDocuments: [documentId]
      }
    });
    expect(scoped.statusCode).toBe(200);

    const empty = await server.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers: headers(),
      payload: {
        query: 'Hello',
        documentId,
        crossBook: true,
        scope: 'tags',
        scopeTags: ['不存在的标签']
      }
    });
    expect(empty.statusCode).toBe(400);

    const plan = await server.inject({
      method: 'POST',
      url: '/api/v1/plan',
      headers: headers(),
      payload: { question: '第 3—5 页说了什么？' }
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({
      breadth: 'local',
      pages: [3, 4, 5],
      origin: '规则'
    });

    const plannedReading = await server.inject({
      method: 'POST',
      url: '/api/v1/plan-reading',
      headers: headers(),
      payload: { question: '请通读全文', documentId, page: 1 }
    });
    expect(plannedReading.statusCode).toBe(200);
    expect(plannedReading.json()).toMatchObject({
      plan: { breadth: 'document' },
      pages: [1],
      multiPass: false
    });
  });
});

describe('generated navigation', () => {
  it('builds navigation, reports stale state after mask changes, and locates quotes', async () => {
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    const documentId = (list.json() as Array<{ id: string }>)[0]?.id;
    expect(documentId).toBeTruthy();

    const initial = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/navigation/status`,
      headers: headers()
    });
    expect(initial.json()).toMatchObject({ state: 'missing' });

    const built = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation`,
      headers: headers()
    });
    expect(built.statusCode).toBe(200);
    expect(built.json()).toMatchObject({ state: 'ready' });
    expect((built.json() as { nodeCount: number }).nodeCount).toBeGreaterThan(0);

    const nodes = (
      await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${documentId}/navigation`,
        headers: headers()
      })
    ).json() as Array<{ page: number; kind: string; label: string }>;
    expect(nodes[0]).toMatchObject({ page: 1 });
    expect(nodes[0]?.label).toBeTruthy();

    const structure = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/structure`,
      headers: headers()
    });
    expect(structure.statusCode).toBe(200);

    const located = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/quote-locate`,
      headers: headers(),
      payload: { page: 1, quote: 'Hello' }
    });
    expect(located.statusCode).toBe(200);
    const location = located.json() as {
      boxes: Array<{ bbox: number[]; text: string }>;
      page: number;
      method: string;
      corrected: boolean;
      message: string;
    };
    expect(location.boxes.length).toBeGreaterThan(0);
    expect(location.boxes[0]?.bbox.every((value) => value >= 0 && value <= 1)).toBe(
      true
    );

    const mask = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/masks`,
      headers: headers(),
      payload: { page: 0, x0: 0, y0: 0, x1: 1, y1: 0.08 }
    });
    expect(mask.statusCode).toBe(200);
    expect((mask.json() as { page: number }).page).toBe(0);

    const stale = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/navigation/status`,
      headers: headers()
    });
    expect(stale.json()).toMatchObject({ state: 'stale' });

    // 这条遮罩把全文都盖住了：按标题规则没有可用行时必须明确报错，
    // 不能以 0 条目录"生成成功"（用户报告 5：弹窗关闭、没有任何反馈）。
    const rebuilt = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation`,
      headers: headers()
    });
    expect(rebuilt.statusCode).toBe(400);
    expect(rebuilt.json()).toMatchObject({ error: 'bad_request' });
    expect((rebuilt.json() as { message: string }).message).toContain('按标题规则没有识别到任何目录条目');
    // 失败时不能覆盖已有目录：原节点仍在，状态是 failed（带错误原因）。
    expect(
      ((
        await server.inject({
          method: 'GET',
          url: `/api/v1/documents/${documentId}/navigation`,
          headers: headers()
        })
      ).json() as Array<unknown>).length
    ).toBeGreaterThan(0);

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${documentId}/masks/${(mask.json() as { id: string }).id}`,
      headers: headers()
    });
    expect(removed.statusCode).toBe(204);

    process.env.STUDIANDA_NAV_SYNC_LIMIT = '0';
    try {
      const background = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/navigation`,
        headers: headers()
      });
      expect(background.statusCode).toBe(200);
      expect(['building', 'ready']).toContain(
        (background.json() as { state: string }).state
      );
      let status = background.json() as { state: string };
      for (let attempt = 0; attempt < 30 && status.state === 'building'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const polled = await server.inject({
          method: 'GET',
          url: `/api/v1/documents/${documentId}/navigation/status`,
          headers: headers()
        });
        status = polled.json() as { state: string };
      }
      expect(status.state).toBe('ready');
    } finally {
      delete process.env.STUDIANDA_NAV_SYNC_LIMIT;
    }
  });
});

describe('notes', () => {
  it('creates, edits, exports, deletes and restores document notes', async () => {
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    const documentId = (list.json() as Array<{ id: string }>)[0]?.id;
    expect(documentId).toBeTruthy();

    const invalid = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId, page: 99, content: '超范围' }
    });
    expect(invalid.statusCode).toBe(400);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId, page: 1, content: '第一条笔记' }
    });
    expect(created.statusCode).toBe(200);
    const note = created.json() as { id: string; page: number; content: string };
    expect(note).toMatchObject({ page: 1, content: '第一条笔记' });

    const updated = await server.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${note.id}`,
      headers: headers(),
      payload: { page: 0, content: '改过的整篇笔记' }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ page: 0, content: '改过的整篇笔记' });

    const listed = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/notes`,
      headers: headers()
    });
    expect(listed.json()).toHaveLength(1);

    const exported = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/export`,
      headers: headers()
    });
    expect(exported.body).toContain('改过的整篇笔记');

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/notes/${note.id}`,
      headers: headers()
    });
    expect(removed.statusCode).toBe(204);

    const afterDelete = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/notes`,
      headers: headers()
    });
    expect(afterDelete.json()).toHaveLength(0);

    const restored = await server.inject({
      method: 'POST',
      url: `/api/v1/notes/${note.id}/restore`,
      headers: headers()
    });
    expect(restored.json()).toEqual({ ok: true });
  });
});

describe('chat', () => {
  it('previews multiple reading batches for a multi-page document', async () => {
    const pdfPath = path.join(dataDir, 'multi-preview.pdf');
    writeFileSync(
      pdfPath,
      await makeTextHeavyPdf([
        `Alpha ${'padding '.repeat(120)}`,
        `Beta ${'padding '.repeat(120)}`,
        `Gamma ${'padding '.repeat(120)}`
      ])
    );
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath }
    });
    const documentId = (imported.json() as { id: string }).id;
    const preview = await server.inject({
      method: 'POST',
      url: '/api/v1/plan-reading',
      headers: headers(),
      payload: {
        question: '请通读全文并总结',
        documentId,
        page: 1,
        budget: 700,
        overlap: 1
      }
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as {
      pages: number[];
      batchCount: number;
      batches: Array<Array<{ page: number }>>;
    };
    expect(body.pages).toHaveLength(3);
    expect(body.batchCount).toBeGreaterThan(1);
  });

  it('returns outline sections with honest origin and page count', async () => {
    const pdfPath = path.join(dataDir, 'outline.pdf');
    writeFileSync(
      pdfPath,
      await makeMultiPagePdf([
        '1 Introduction\nThis is the introduction body.',
        '2 Methods\nWe describe the method here.',
        '3 Results\nThe results follow.'
      ])
    );
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath }
    });
    const documentId = (imported.json() as { id: string }).id;
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/outline`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sections: Array<{ title: string; page: number; end_page: number; origin: string }>;
      total_pages: number;
      origins: string[];
      message: string;
    };
    expect(body.total_pages).toBe(3);
    expect(body.sections.length).toBeGreaterThan(0);
    expect(body.sections[0]?.title).toContain('Introduction');
    expect(body.sections[0]?.page).toBe(1);
    expect(body.origins.length).toBeGreaterThan(0);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('runs multi-batch reading and answers with verified evidence', async () => {
    const pdfPath = path.join(dataDir, 'multi-batch.pdf');
    writeFileSync(
      pdfPath,
      await makeTextHeavyPdf([
        `Alpha ${'padding '.repeat(120)}`,
        `Beta ${'padding '.repeat(120)}`,
        `Gamma ${'padding '.repeat(120)}`
      ])
    );
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath, confirmDuplicate: true }
    });
    const documentId = (imported.json() as { id: string }).id;
    const mockServer = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => {
        data += String(chunk);
      });
      request.on('end', () => {
        const body = JSON.parse(data) as { messages?: Array<{ role: string; content: string }> };
        const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
        const material = body.messages?.find((message) => message.role === 'user')?.content ?? '';
        let content = '多批回答 [1]';
        if (system.includes('QUESTION_ROUTE')) {
          content = JSON.stringify({
            document: true,
            search: false,
            reason: '读文献',
            reply: '',
            reading: 'document',
            confidence: 0.95,
            pages: [],
            queries: [],
            dimensions: [{ code: 'D1', label: '概念界定' }]
          });
        } else if (system.includes('READING_BATCH')) {
          const match = material.match(/\[(\d+)\][^\n]*\n([^\n]+)/);
          content = JSON.stringify({
            analysis: '要点',
            evidence: [
              {
                source: Number(match?.[1] ?? 1),
                // 只取首行前 12 字：证据银行按 token 预算（budget 700×0.6）装载，
                // 长摘引会把后面来源挤出银行；这里验证的是“多批来源都在”，不是长引文。
                quote: (match?.[2] ?? 'missing').slice(0, 12),
                dimension: 'D1'
              }
            ],
            no_relevant_evidence: false
          });
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    process.env.STUDIANDA_READING_BUDGET = '700';
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask',
        headers: headers(),
        payload: { question: '请通读全文并总结', documentId, page: 1 }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        answer: string;
        sources: Array<{ quotes?: string[] }>;
      };
      expect(body.answer).toBe('多批回答 [1]');
      expect(body.sources.length).toBeGreaterThan(1);
      expect(body.sources[0]?.quotes?.[0]).toBeTruthy();
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      delete process.env.STUDIANDA_READING_BUDGET;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('streams a local answer with a result event', async () => {
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    const documentId = (list.json() as Array<{ id: string }>)[0]?.id;
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask/stream',
      headers: headers(),
      payload: { question: 'Hello', documentId, page: 1 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: result');
    expect(response.body).toContain('"answer"');
  });

  it('continues reading unread pages from a saved task', async () => {
    const pdfPath = path.join(dataDir, 'continue-reading.pdf');
    writeFileSync(
      pdfPath,
      await makeTextHeavyPdf(
        Array.from({ length: 5 }, (_, index) => `Page ${index + 1} ${'content '.repeat(120)}`)
      )
    );
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath }
    });
    const documentId = (imported.json() as { id: string }).id;
    const mockServer = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => {
        data += String(chunk);
      });
      request.on('end', () => {
        const body = JSON.parse(data) as { messages?: Array<{ role: string; content: string }> };
        const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
        const material = body.messages?.find((message) => message.role === 'user')?.content ?? '';
        let content = '单批回答 [1]';
        if (system.includes('QUESTION_ROUTE')) {
          content = JSON.stringify({
            document: true,
            search: false,
            reason: '读第一页',
            reply: '',
            reading: 'local',
            confidence: 0.95,
            pages: [1],
            queries: [],
            dimensions: [{ code: 'D1', label: '概念界定' }]
          });
        } else if (system.includes('READING_BATCH')) {
          const match = material.match(/\[(\d+)\][^\n]*\n([^\n]+)/);
          content = JSON.stringify({
            analysis: '要点',
            evidence: [
              {
                source: Number(match?.[1] ?? 1),
                // 同上：短摘引才会在 token 预算内被证据银行保留（多来源断言需要）。
                quote: (match?.[2] ?? 'missing').slice(0, 40),
                dimension: 'D1'
              }
            ],
            no_relevant_evidence: false
          });
        } else if (material.includes('verified_quotes')) {
          content = '补读回答 [1]';
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    process.env.STUDIANDA_READING_BUDGET = '700';
    try {
      const first = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask',
        headers: headers(),
        payload: { question: '第 1 页在讲什么？', documentId, page: 1 }
      });
      const firstBody = first.json() as {
        taskId?: string;
        unread_pages?: number[];
      };
      expect(firstBody.taskId).toBeTruthy();
      expect(firstBody.unread_pages?.length).toBe(4);

      const second = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask',
        headers: headers(),
        payload: {
          question: '第 1 页在讲什么？',
          documentId,
          page: 1,
          taskId: firstBody.taskId
        }
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as {
        answer: string;
        taskId?: string;
        unread_pages?: number[];
      };
      expect(secondBody.answer).toBe('补读回答 [1]');
      expect(secondBody.taskId).toBe(firstBody.taskId);
      expect(secondBody.unread_pages).toEqual([]);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      delete process.env.STUDIANDA_READING_BUDGET;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('adds contrast pages to a local reading plan', async () => {
    const pdfPath = path.join(dataDir, 'falsify-plan.pdf');
    writeFileSync(
      pdfPath,
      await makeMultiPagePdf([
        'First page plain claim.',
        'However, this claim has a limitation.',
        'Third page plain note.'
      ])
    );
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath }
    });
    const documentId = (imported.json() as { id: string }).id;
    const mockServer = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => {
        data += String(chunk);
      });
      request.on('end', () => {
        const body = JSON.parse(data) as { messages?: Array<{ role: string; content: string }> };
        const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
        let content = '回答 [1]';
        if (system.includes('QUESTION_ROUTE')) {
          content = JSON.stringify({
            document: true,
            search: false,
            reason: '读第一页',
            reply: '',
            reading: 'local',
            confidence: 0.95,
            pages: [1],
            queries: []
          });
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask',
        headers: headers(),
        payload: { question: '第 1 页说了什么？', documentId, page: 1 }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        falsify?: { added_pages: number[]; contrast_pages: number[] };
        sources: Array<{ page: number }>;
        plan?: { pages: number[] };
      };
      expect(body.falsify?.contrast_pages).toContain(2);
      expect(body.falsify?.added_pages).toContain(2);
      expect(body.plan?.pages).toEqual(expect.arrayContaining([1, 2]));
      expect(body.sources.map((source) => source.page)).toEqual(
        expect.arrayContaining([1, 2])
      );
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('translates a page with the configured model and stores segments', async () => {
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: TEST_PDF, confirmDuplicate: true }
    });
    expect(imported.statusCode).toBe(200);
    const documentId = (imported.json() as { id: string }).id;
    const mockServer = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ choices: [{ message: { content: '你好世界。' } }] })
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    try {
      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/translation/pages/1`,
        headers: headers(),
        payload: { language: 'zh' }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        page: { status: string; done: number; total: number };
        pageSize: { width: number; height: number } | null;
        columns: number;
        bodyLineHeight: number;
        targetLanguage: string;
        furniture: number;
        segments: Array<{
          text: string;
          source: string;
          terms: string;
          unknownTerms: string;
          coverage: number | null;
        }>;
      };
      expect(body.page.status).toBe('done');
      expect(body.pageSize?.width).toBeGreaterThan(0);
      expect(body.columns).toBeGreaterThanOrEqual(1);
      expect(body.bodyLineHeight).toBeGreaterThan(0);
      expect(body.targetLanguage).toBe('zh');
      expect(body.furniture).toBeGreaterThanOrEqual(0);
      expect(body.segments[0]?.text).toBe('你好世界。');
      expect(body.segments[0]?.source).toBeTruthy();
      expect(body.segments[0]?.terms).toBe('[]');
      expect(body.segments[0]?.unknownTerms).toBe('[]');
      expect(body.segments[0]?.coverage).toBe(0);

      const stored = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${documentId}/translation/pages/1`,
        headers: headers()
      });
      expect(stored.statusCode).toBe(200);
      expect((stored.json() as { segments: unknown[] }).segments.length).toBeGreaterThan(0);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('stores translation target language without any legacy service config', async () => {
    const defaults = await server.inject({
      method: 'GET',
      url: '/api/v1/translation/config',
      headers: headers()
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({ target_language: 'zh' });
    expect(Array.isArray((defaults.json() as { targets?: unknown[] }).targets)).toBe(true);

    const saved = await server.inject({
      method: 'PUT',
      url: '/api/v1/translation/config',
      headers: headers(),
      payload: {
        target_language: 'en',
        // 旧版字段应被忽略：翻译服务只走「模型服务」路由，不再有独立地址/密钥。
        model: 'mock-model',
        base_url: 'https://example.com/v1/',
        api_key: 'secret'
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ target_language: 'en' });
    expect(JSON.stringify(saved.json())).not.toContain('secret');
    const settings = store.getSettings();
    expect(settings['translation.target_language']).toBe('en');
    expect(settings['translation.base_url']).toBeUndefined();
    expect(settings['translation.model']).toBeUndefined();

    store.deleteSettings(['translation.target_language']);
  });

  it('runs and stops a whole-document translation job', async () => {
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: TEST_PDF, confirmDuplicate: true }
    });
    expect(imported.statusCode).toBe(200);
    const documentId = (imported.json() as { id: string; pages: number }).id;
    const mockServer = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ choices: [{ message: { content: '译文。' } }] })
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    try {
      const started = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/translation`,
        headers: headers(),
        payload: {}
      });
      expect(started.statusCode).toBe(200);
      let job: { status: string; done: number; total: number } | null = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const state = await server.inject({
          method: 'GET',
          url: `/api/v1/documents/${documentId}/translation`,
          headers: headers()
        });
        job = state.json() as { status: string; done: number; total: number };
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(job?.status).toBe('done');
      expect(job?.done).toBe(2);
      expect(job?.total).toBe(2);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('reuses unchanged translations unless forced', async () => {
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: TEST_PDF, confirmDuplicate: true }
    });
    expect(imported.statusCode).toBe(200);
    const documentId = (imported.json() as { id: string }).id;
    let calls = 0;
    const mockServer = createServer((request, response) => {
      calls += 1;
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ choices: [{ message: { content: '稳定译文。' } }] })
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    try {
      const url = `/api/v1/documents/${documentId}/translation/pages/1`;
      await server.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: { force: true }
      });
      const baseline = calls;
      expect(baseline).toBeGreaterThan(0);
      await server.inject({ method: 'POST', url, headers: headers(), payload: {} });
      expect(calls).toBe(baseline);
      await server.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: { force: true }
      });
      expect(calls).toBe(baseline * 2);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('does not skip a top-margin reference line', async () => {
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: TEST_PDF, confirmDuplicate: true }
    });
    const documentId = (imported.json() as { id: string }).id;
    const mockServer = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ choices: [{ message: { content: '译文。' } }] })
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    try {
      const url = `/api/v1/documents/${documentId}/translation/pages/2`;
      const result = await server.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: {}
      });
      const body = result.json() as {
        page: { status: string; done: number; total: number };
        furniture: number;
        segments: Array<{ skipped?: boolean; text: string; source: string }>;
      };
      expect(result.statusCode).toBe(200);
      expect(body.furniture).toBe(0);
      expect(body.segments.every((segment) => !segment.skipped)).toBe(true);
      expect(body.page.status).toBe('done');
      expect(
        body.segments.some((segment) => segment.source.includes('[3]') && segment.text)
      ).toBe(true);

      const included = await server.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: { include_furniture: true, force: true }
      });
      expect(included.statusCode).toBe(200);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.skip('returns local sources when no model is configured', async () => {
    delete process.env.STUDIANDA_MODEL_BASE_URL;
    delete process.env.STUDIANDA_MODEL_NAME;
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: { question: 'Hello' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      answer: string | null;
      sources: Array<{ page: number; snippet: string }>;
      notice?: string;
    };
    expect(body.answer).toBeNull();
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.notice).toContain('尚未配置模型');
  });

  it('calls a configured OpenAI-compatible model', async () => {
    let authorization = '';
    let receivedBody = '';
    const mockServer = createServer((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      let data = '';
      request.on('data', (chunk) => {
        data += String(chunk);
      });
      request.on('end', () => {
        receivedBody += data;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'Mock answer based on [1].' } }]
          })
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');

    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    const documentId = (list.json() as Array<{ id: string }>)[0]?.id;

    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    process.env.STUDIANDA_MODEL_API_KEY = 'mock-key';

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask',
        headers: headers(),
        payload: {
          question: 'Hello',
          documentId,
          page: 1,
          selection: 'Selected annotation quote'
        }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { answer: string | null; sources: unknown[] };
      expect(body.answer).toBe('Mock answer based on [1].');
      expect(body.sources.length).toBeGreaterThan(0);
      expect(authorization).toBe('Bearer mock-key');
      expect(receivedBody).toContain('Selected annotation quote');
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      delete process.env.STUDIANDA_MODEL_API_KEY;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.skip('uses the model question route to answer greetings without retrieval', async () => {
    let calls = 0;
    const mockServer = createServer((request, response) => {
      calls += 1;
      let data = '';
      request.on('data', (chunk) => {
        data += String(chunk);
      });
      request.on('end', () => {
        const body = JSON.parse(data) as { messages?: Array<{ role: string; content: string }> };
        const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
        const content = system.includes('QUESTION_ROUTE')
          ? JSON.stringify({
              document: false,
              search: false,
              reason: '问候',
              reply: '你好，有什么可以帮你？',
              reading: 'document',
              confidence: 0.95,
              pages: [],
              queries: []
            })
          : '不应调用正式回答';
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address();
    if (address == null || typeof address === 'string') throw new Error('mock server address');
    process.env.STUDIANDA_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.STUDIANDA_MODEL_NAME = 'mock-model';
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask',
        headers: headers(),
        payload: { question: '你好', documentId: undefined, page: 1 }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        answer: string;
        sources: unknown[];
        routing?: { document: boolean };
      };
      expect(body.answer).toBe('你好，有什么可以帮你？');
      expect(body.sources).toEqual([]);
      expect(body.routing?.document).toBe(false);
      expect(calls).toBe(1);
    } finally {
      delete process.env.STUDIANDA_MODEL_BASE_URL;
      delete process.env.STUDIANDA_MODEL_NAME;
      await new Promise<void>((resolve, reject) =>
        mockServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('reports secret status without exposing the value', async () => {
    const status = await server.inject({
      method: 'GET',
      url: '/api/v1/secrets/status',
      headers: headers()
    });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain('mock-key');
  });
});

describe('settings', () => {
  it('merges string settings and persists them', async () => {
    const initial = await server.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: headers()
    });
    // 迁移会写入资源索引统计（note_assets.*），其余设置初始为空。
    const before = initial.json() as Record<string, string>;
    expect(before.theme).toBeUndefined();
    expect(before.language).toBeUndefined();
    expect(before['note_assets.indexed_files']).toBe('0');

    const saved = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: headers(),
      payload: { theme: 'dark', language: 'zh-CN' }
    });
    const expected = { ...before, language: 'zh-CN', theme: 'dark' };
    expect(saved.json()).toEqual(expected);

    const reloaded = await server.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: headers()
    });
    expect(reloaded.json()).toEqual(expected);
  });
});

describe('large file confirmation', () => {
  it('warns instead of hard-rejecting, and imports after confirmation', async () => {
    const pdfPath = path.join(dataDir, 'large-warning.pdf');
    writeFileSync(pdfPath, await makePdf('Large file confirmation test'));
    process.env.STUDIANDA_LARGE_FILE_WARN_BYTES = '100';
    try {
      const pending = await server.inject({
        method: 'POST',
        url: '/api/v1/documents/import',
        headers: headers(),
        payload: { path: pdfPath }
      });
      expect(pending.statusCode).toBe(409);
      expect(pending.json()).toMatchObject({ error: 'confirmation_required' });
      expect((pending.json() as { details: { sizeBytes: number } }).details.sizeBytes).toBeGreaterThan(
        100
      );

      const confirmed = await server.inject({
        method: 'POST',
        url: '/api/v1/documents/import',
        headers: headers(),
        payload: { path: pdfPath, confirmLarge: true }
      });
      expect(confirmed.statusCode).toBe(200);
    } finally {
      delete process.env.STUDIANDA_LARGE_FILE_WARN_BYTES;
    }
  });
});

describe('multipart upload', () => {
  it('uploads a PDF with multipart and keeps the original filename', async () => {
    const pdf = await makePdf('Multipart upload text');
    const body = multipartPdf(pdf, '原始文件名.pdf');
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { ...headers(), 'content-type': body.contentType },
      payload: body.payload
    });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { name: string; id: string; chunks?: number };
    expect(document.name).toBe('原始文件名.pdf');
    expect(document.chunks).toBeGreaterThan(0);
  });

  it('requires confirmation for a large multipart upload and accepts it after confirmation', async () => {
    const pdf = await makePdf('Large multipart confirmation');
    const body = multipartPdf(pdf);
    process.env.STUDIANDA_LARGE_FILE_WARN_BYTES = '100';
    try {
      const pending = await server.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: { ...headers(), 'content-type': body.contentType },
        payload: body.payload
      });
      expect(pending.statusCode).toBe(409);
      expect(pending.json()).toMatchObject({ error: 'confirmation_required' });

      const confirmed = await server.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: {
          ...headers(),
          'content-type': body.contentType,
          'x-studianda-confirm-large': 'true'
        },
        payload: body.payload
      });
      expect(confirmed.statusCode).toBe(200);
    } finally {
      delete process.env.STUDIANDA_LARGE_FILE_WARN_BYTES;
    }
  });
});

describe('relink and span chunking', () => {
  it('replaces the PDF, rebuilds chunks, and keeps annotations', async () => {
    const oldPath = path.join(dataDir, 'relink-old.pdf');
    writeFileSync(oldPath, await makePdf('Old retrieval text'));
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: oldPath }
    });
    const document = imported.json() as { id: string };
    expect(imported.statusCode).toBe(200);

    const annotation = await server.inject({
      method: 'POST',
      url: '/api/v1/annotations',
      headers: headers(),
      payload: { documentId: document.id, page: 1, content: '保留的批注' }
    });
    expect(annotation.statusCode).toBe(200);

    const newPath = path.join(dataDir, 'relink-new.pdf');
    writeFileSync(
      newPath,
      await makeMultiPagePdf([
        'New page one with retrieval and evidence.',
        'New page two with annotations and notes.'
      ])
    );
    const relinked = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${document.id}/relink`,
      headers: headers(),
      payload: { path: newPath }
    });
    expect(relinked.statusCode).toBe(200);
    expect(relinked.json()).toMatchObject({ pages: 2 });

    const annotations = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${document.id}/annotations`,
      headers: headers()
    });
    expect(annotations.json()).toHaveLength(1);

    const oldSearch = await server.inject({
      method: 'GET',
      url: '/api/v1/search?q=Old%20retrieval',
      headers: headers()
    });
    const relinkedChunks = store.listChunks(document.id);
    expect(relinkedChunks.some((chunk) => chunk.text.includes('Old retrieval'))).toBe(false);
    expect(oldSearch.statusCode).toBe(200);
    const newSearch = await server.inject({
      method: 'GET',
      url: '/api/v1/search?q=evidence',
      headers: headers()
    });
    expect((newSearch.json() as Array<{ documentId: string; page: number }>).some(
      (hit) => hit.documentId === document.id && hit.page === 1
    )).toBe(true);
  });

  it('splits a long span into 1000-step / 1200-window chunks', async () => {
    const longText = 'retrieval '.repeat(220).trim();
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([12000, 500]);
    page.drawText(longText, { x: 20, y: 240, size: 5 });
    const pdfPath = path.join(dataDir, 'long-chunks.pdf');
    writeFileSync(pdfPath, await pdf.save());
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath, confirmLarge: true }
    });
    const document = imported.json() as { id: string };
    expect(imported.statusCode).toBe(200);
    const chunks = store.listChunks(document.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 1200)).toBe(true);
  });
});

describe('document lifecycle', () => {  it('renames, tags, trashes, restores and purges a document', async () => {
    const pdfPath = path.join(dataDir, 'lifecycle.pdf');
    writeFileSync(pdfPath, await makePdf('Lifecycle document'));

    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/import',
      headers: headers(),
      payload: { path: pdfPath }
    });
    const document = imported.json() as { id: string; name: string };
    expect(imported.statusCode).toBe(200);
    expect(document.name).toBe('lifecycle.pdf');

    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${document.id}`,
      headers: headers(),
      payload: { name: '重命名后的文献' }
    });
    expect(renamed.json()).toMatchObject({ name: '重命名后的文献' });

    const tagged = await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${document.id}/tags`,
      headers: headers(),
      payload: { tags: ['文献', '文献', '重要'] }
    });
    expect(tagged.json()).toEqual({ ok: true, tags: ['文献', '重要'] });

    const authored = await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${document.id}/author`,
      headers: headers(),
      payload: { author: '作者 A' }
    });
    expect(authored.json()).toMatchObject({ author: '作者 A' });

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${document.id}`,
      headers: headers()
    });
    expect(removed.json()).toEqual({ ok: true });

    const active = await server.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: headers()
    });
    expect((active.json() as Array<{ id: string }>).some((item) => item.id === document.id)).toBe(
      false
    );

    const trash = await server.inject({
      method: 'GET',
      url: '/api/v1/documents?trash=true',
      headers: headers()
    });
    expect((trash.json() as Array<{ id: string }>).some((item) => item.id === document.id)).toBe(
      true
    );

    const restored = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${document.id}/restore`,
      headers: headers()
    });
    expect(restored.json()).toEqual({ ok: true });

    await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${document.id}`,
      headers: headers()
    });
    const mismatch = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${document.id}/purge`,
      headers: headers(),
      payload: { confirmName: '错误名称' }
    });
    expect(mismatch.statusCode).toBe(400);

    const purged = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${document.id}/purge`,
      headers: headers(),
      payload: { confirmName: '重命名后的文献' }
    });
    expect(purged.json()).toEqual({ ok: true });
    expect(store.getDocument(document.id)).toBeNull();
  });
});
