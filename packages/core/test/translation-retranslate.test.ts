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
  retranslateTranslationSegment,
  translatePage
} from '../src/translation-service.js';

const token = 'translation-retranslate-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-retranslate-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({
  token,
  version: 'test-version',
  store,
  secrets
});
let documentId = '';

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function configureTranslationModel(): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'translation-conn',
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
      translation: { connectionId: 'translation-conn', model: 'translate-model' }
    }
  });
  secrets.set('platform.translation-conn.api_key', 'k-1');
}

/** 替身 chat/completions：记录每次请求里 user 消息内容，内容由 handler 决定。 */
function mockChat(
  handler: (userContent: string) => string
): Array<{ user: string; body: Record<string, unknown> }> {
  const calls: Array<{ user: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    calls.push({ user, body });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: handler(user) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return calls;
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  const file = path.join(dataDir, 'retranslate.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
  store.savePageTextEdit(documentId, 1, '第一段内容。\n第二段内容。');
}, 120_000);

describe('retranslateTranslationSegment', () => {
  it('only sends the requested segment and keeps the other ones untouched', async () => {
    configureTranslationModel();
    mockChat((user) => (user.includes('第一段内容') ? '第一段译文。' : '第二段译文。'));
    const page = await translatePage(store, secrets, documentId, 1, { language: 'zh' });
    const translated = page.segments.filter((segment) => segment.text);
    expect(translated.length).toBe(2);
    const target = page.segments[1]!;
    const other = page.segments[0]!;
    expect(target.source).toContain('第二段内容');

    // 先把目标段标记为人工修改，验证重译会复位 edited 并保留恢复所需的 previous_text。
    const storedBefore = store.getTranslationSegments(documentId, 1);
    store.saveTranslationSegments(
      storedBefore.map((segment) =>
        segment.segment === target.segment
          ? { ...segment, text: '人工修改的译文', edited: true, origin: 'user' }
          : segment
      )
    );

    const calls = mockChat(() => '第二段新译文。');
    const payload = await retranslateTranslationSegment(
      store,
      secrets,
      documentId,
      1,
      target.segment,
      'zh'
    );

    // 只请求一次，且只包含目标段原文。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain('第二段内容');
    expect(calls[0]!.user).not.toContain('第一段内容');
    expect(calls[0]!.body.temperature).toBe(0);

    const updatedTarget = payload.segments.find(
      (segment) => segment.segment === target.segment
    )!;
    const updatedOther = payload.segments.find(
      (segment) => segment.segment === other.segment
    )!;
    expect(updatedTarget.text).toBe('第二段新译文。');
    expect(updatedTarget.edited).toBe(false);
    expect(updatedTarget.id).toBe(target.id);
    expect(updatedTarget.source).toContain('第二段内容');
    expect(updatedOther.text).toBe(other.text);

    // 落库结果与返回一致：非目标段没有被覆盖。
    const storedAfter = store.getTranslationSegments(documentId, 1);
    expect(storedAfter.find((segment) => segment.segment === target.segment)?.text).toBe(
      '第二段新译文。'
    );
    expect(storedAfter.find((segment) => segment.segment === other.segment)?.text).toBe(
      other.text
    );
    expect(storedAfter.find((segment) => segment.segment === target.segment)?.previousText).toBe(
      '人工修改的译文'
    );
    expect(payload.page?.total).toBe(2);
    expect(payload.page?.done).toBe(2);
    expect(payload.page?.status).toBe('done');
    expect(payload.targetLanguage).toBe('zh');
  });

  it('validates document, page, index and empty source', async () => {
    configureTranslationModel();
    await expect(
      retranslateTranslationSegment(store, secrets, 'missing-doc', 1, 1)
    ).rejects.toThrow('文档不存在');
    await expect(
      retranslateTranslationSegment(store, secrets, documentId, 99, 1)
    ).rejects.toThrow('页码超出范围');
    await expect(
      retranslateTranslationSegment(store, secrets, documentId, 1, 99)
    ).rejects.toThrow('不存在');
    await expect(
      retranslateTranslationSegment(store, secrets, documentId, 1, -1)
    ).rejects.toThrow('段号必须是非负整数');

    const stored = store.getTranslationSegments(documentId, 1);
    store.saveTranslationSegments([
      { ...stored[0]!, source: '   ', text: stored[0]!.text }
    ]);
    await expect(
      retranslateTranslationSegment(store, secrets, documentId, 1, stored[0]!.segment)
    ).rejects.toThrow('原文为空');
  });
});

describe('POST /translation/pages/:page/segments/:index', () => {
  it('returns the refreshed page payload', async () => {
    configureTranslationModel();
    const stored = store.getTranslationSegments(documentId, 1);
    // 第二个段落在前一个用例里没有被清空原文。
    const target = stored[1]!;
    mockChat(() => '服务端重译结果。');
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/pages/1/segments/${target.segment}`,
      headers: headers(),
      payload: { language: 'zh' }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      segments: Array<{ segment: number; text: string }>;
      page: { total: number };
    };
    expect(body.page.total).toBe(2);
    expect(body.segments.find((segment) => segment.segment === target.segment)?.text).toBe(
      '服务端重译结果。'
    );
  });

  it('returns 400 for a bad page/index and 404 for a missing document/segment', async () => {
    configureTranslationModel();
    const badPage = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/pages/99/segments/1`,
      headers: headers(),
      payload: {}
    });
    expect(badPage.statusCode).toBe(400);

    const badIndex = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/pages/1/segments/99`,
      headers: headers(),
      payload: {}
    });
    expect(badIndex.statusCode).toBe(404);

    const missingDoc = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/missing-doc/translation/pages/1/segments/1',
      headers: headers(),
      payload: {}
    });
    expect(missingDoc.statusCode).toBe(404);
  });
});
