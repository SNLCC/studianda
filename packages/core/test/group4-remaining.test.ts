import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { matchedExcerpt } from '../src/retrieval.js';
import { generateDiagnostics } from '../src/diagnostics.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import {
  annotationTranslations,
  translationOverview,
  translationProgress
} from '../src/translation-service.js';
import {
  mimoVoiceList,
  minimaxVoiceList,
  voicesForSpeechConnection
} from '../src/speech.js';
import {
  zoteroFailureMessage,
  zoteroNetworkMessage
} from '../src/zotero.js';

const token = 'group4-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-group4-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });
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

describe('检索命中行 match', () => {
  it('返回命中词所在的整行；空白拆开的查询去掉空白后仍能定位', () => {
    const text = '第一行无关\n第二行讲 Transformer 模型\n第三行结论';
    expect(matchedExcerpt(text, 'Transformer')).toBe('第二行讲 Transformer 模型');
    expect(matchedExcerpt('alpha beta\ngamma delta', 'gamma delta')).toBe('gamma delta');
    // 没有命中时退回首行。
    expect(matchedExcerpt('首行内容\n次行', '不存在的词')).toBe('首行内容');
  });
});

describe('Zotero 错误话术', () => {
  it('本机/云端按状态给可执行说明', () => {
    expect(zoteroFailureMessage(403, 'local')).toContain('允许其他应用与 Zotero 通信');
    expect(zoteroFailureMessage(404, 'local')).toContain('文献库 ID 应为 0');
    expect(zoteroFailureMessage(403, 'cloud')).toContain('API Key');
    expect(zoteroFailureMessage(429, 'cloud')).toContain('限流');
    expect(zoteroFailureMessage(500, 'cloud')).toContain('稍后重试');
    expect(zoteroNetworkMessage('local')).toContain('localhost:23119');
    expect(zoteroNetworkMessage('cloud')).toContain('api.zotero.org');
  });
});

describe('语音音色按连接获取', () => {
  it('MiMo 返回官方预置音色；设计/克隆模型如实说明没有清单', () => {
    expect(mimoVoiceList('mimo-v2.5-tts').voices.map((voice) => voice.id)).toContain(
      'mimo_default'
    );
    expect(mimoVoiceList('mimo-v2.5-tts-voicedesign').voices).toHaveLength(0);
    expect(mimoVoiceList('mimo-v2.5-tts-voiceclone').note).toContain('音色');
  });

  it('MiniMax 从官方接口取账户可用音色', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          system_voice: [{ voice_id: 'female-shaonv', voice_name: '少女' }],
          voice_cloning: [{ voice_id: 'clone-1', voice_name: '我的声音' }],
          voice_generation: []
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const list = await minimaxVoiceList('https://api.minimax.io/v1', 'k');
    expect(list.voices.map((voice) => voice.id)).toEqual(['female-shaonv', 'clone-1']);
    expect(list.source).toBe('官方接口');
  });

  it('其它平台如实说明没有音色列表接口', async () => {
    const list = await voicesForSpeechConnection('https://api.example.com/v1', 'k', 'm');
    expect(list.voices).toHaveLength(0);
    expect(list.note).toContain('没有公开的音色列表');
  });
});

describe('批注译文与翻译进度', () => {
  it('批注摘引映射到对应句译文，并提供整篇进度', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 600]);
    page.drawText('fixture body', { x: 20, y: 560, size: 10, font });
    const file = path.join(dataDir, 'translation-progress.pdf');
    writeFileSync(file, await pdf.save());
    documentId = (await store.importDocument(file)).id;
    store.savePageTextEdit(documentId, 1, '第一句。第二句。');
    store.saveTranslationSegments([
      {
        id: 'seg-0',
        documentId,
        page: 1,
        segment: 0,
        source: '第一句。第二句。',
        sourceHash: 'h',
        text: 'First. Second.',
        engine: 'remote',
        service: 'm',
        terms: '[]',
        unknownTerms: '[]',
        coverage: 0,
        edited: false,
        origin: 'machine',
        previousText: '',
        previousOrigin: ''
      }
    ]);
    store.saveTranslationPage({
      documentId,
      page: 1,
      sourceHash: 'h',
      engine: 'remote',
      status: 'done',
      error: '',
      done: 1,
      total: 1,
      updated: new Date().toISOString()
    });
    const annotation = store.createAnnotation({
      documentId,
      page: 1,
      quote: '第一句',
      content: '批注',
      rects: '[[0.1,0.1,0.4,0.2]]',
      color: 'yellow',
      style: 'highlight'
    });
    const annotated = annotationTranslations(store, documentId, [annotation]);
    expect(annotated[0]!.translation?.[0]?.text).toBe('First.');
    expect(annotated[0]!.translation?.[0]?.narrowed).toBe(true);

    const progress = translationProgress(store, documentId);
    expect(progress.total_pages).toBe(1);
    expect(progress.translated_pages).toBe(1);
    expect(progress.pages[0]!.status).toBe('done');

    const overview = translationOverview(store, [documentId, 'missing-doc']);
    expect(overview).toHaveLength(1);
    expect(overview[0]!.status).toBe('done');
    expect(overview[0]!.translatedPages).toBe(1);

    const diagnostics = generateDiagnostics(store, { name: 'Studianda', version: 'test' });
    expect(diagnostics.environment.platform).toBe(process.platform);
    expect(typeof diagnostics.environment.cpus).toBe('number');
    expect(typeof diagnostics.git).toBe('string');

    const progressResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/translation/progress`,
      headers: headers()
    });
    expect(progressResponse.statusCode).toBe(200);
    expect((progressResponse.json() as { translated_pages: number }).translated_pages).toBe(1);
    const overviewResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/translation/overview?ids=${documentId}`,
      headers: headers()
    });
    expect(overviewResponse.statusCode).toBe(200);
    expect(
      (overviewResponse.json() as Array<{ status: string }>)[0]?.status
    ).toBe('done');
    const annotationsResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/translation/annotations`,
      headers: headers()
    });
    expect(annotationsResponse.statusCode).toBe(200);
    const rows = annotationsResponse.json() as Array<{
      translation?: Array<{ text: string }>;
    }>;
    expect(rows[0]?.translation?.[0]?.text).toBe('First.');
  });
});
