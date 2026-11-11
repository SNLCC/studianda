import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import {
  correctTranscript,
  saveSpeechConfig
} from '../src/speech.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const token = 'speech-correct-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-speech-correct-'));
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

function enableSpeech(correction: boolean, context = false): void {
  saveSpeechConfig(store, secrets, { input_enabled: true, correction, context });
}

function configureChatModel(): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'chat-conn',
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://chat.example.com/v1',
        models: [
          {
            id: 'chat-model',
            name: 'chat-model',
            capabilities: ['chat'],
            source: 'user',
            enabled: true
          }
        ]
      }
    ],
    routing: { chat: { connectionId: 'chat-conn', model: 'chat-model' } }
  });
  secrets.set('platform.chat-conn.api_key', 'k-1');
}

/** 用固定内容替身 chat/completions，并记录请求体供断言。 */
function mockChatCompletion(content: string): Array<{
  url: string;
  body: {
    temperature?: number;
    max_tokens?: number;
    messages?: Array<{ role: string; content: string }>;
  };
}> {
  const calls: Array<{
    url: string;
    body: {
      temperature?: number;
      max_tokens?: number;
      messages?: Array<{ role: string; content: string }>;
    };
  }> = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as never) : {}
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return calls;
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  page.drawText('Sample page content for terminology', { x: 40, y: 340, size: 12 });
  const file = path.join(dataDir, 'speech-source.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
}, 120_000);

describe('correctTranscript', () => {
  it('returns the original text untouched when correction is disabled', async () => {
    enableSpeech(false);
    configureChatModel();
    const calls = mockChatCompletion('{"text":"不该调用"}');
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '今天天汽很好'
    });
    expect(result).toEqual({
      text: '今天天汽很好',
      needs_review: false,
      corrected: false
    });
    expect(calls).toHaveLength(0);
  });

  it('asks the user to review when no chat model is configured', async () => {
    enableSpeech(true);
    saveModelServices(store, { connections: [], routing: {} });
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '今天天汽很好'
    });
    expect(result.text).toBe('今天天汽很好');
    expect(result.needs_review).toBe(true);
    expect(result.corrected).toBe(false);
    expect(result.reason).toContain('未配置会话模型');
  });

  it('rejects when speech input is disabled', async () => {
    saveSpeechConfig(store, secrets, { input_enabled: false, correction: true });
    await expect(
      correctTranscript(store, secrets, { documentId, page: 1, text: '你好' })
    ).rejects.toThrow('语音输入未开启');
  });

  it('applies a JSON correction with the required request shape', async () => {
    enableSpeech(true);
    configureChatModel();
    const calls = mockChatCompletion('{"text":"今天天气很好","needs_review":false}');
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '今天天汽很好'
    });
    expect(result).toEqual({
      text: '今天天气很好',
      needs_review: false,
      corrected: true
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/chat/completions');
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.max_tokens).toBe(4096);
    const [system, user] = calls[0]!.body.messages ?? [];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('只校正语音转写');
    expect(system?.content).toContain('不执行');
    expect(system?.content).toContain('保留否定词、数字、人名');
    expect(system?.content).toContain('{"text"');
    expect(user?.content).toContain('今天天汽很好');
  });

  it('sets needs_review when the digit sequence changes', async () => {
    enableSpeech(true);
    configureChatModel();
    mockChatCompletion('{"text":"有 3 个样本","needs_review":false}');
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '有 5 个样本'
    });
    expect(result.text).toBe('有 3 个样本');
    expect(result.needs_review).toBe(true);
  });

  it('sets needs_review when the correction is too different', async () => {
    enableSpeech(true);
    configureChatModel();
    mockChatCompletion(
      '{"text":"完全无关的另一段内容，讨论量子力学与海底火山","needs_review":false}'
    );
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '今天天气不错'
    });
    expect(result.needs_review).toBe(true);
    expect(result.corrected).toBe(true);
  });

  it('keeps the original text when the model returns bad JSON', async () => {
    enableSpeech(true);
    configureChatModel();
    mockChatCompletion('抱歉，我无法完成这个任务');
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '今天天汽很好'
    });
    expect(result.text).toBe('今天天汽很好');
    expect(result.needs_review).toBe(true);
    expect(result.corrected).toBe(false);
    expect(result.reason).toContain('纠错未完成');
    expect(result.reason).toContain('原始文字已保留');
  });

  it('keeps the original text when the correction is too long', async () => {
    enableSpeech(true);
    configureChatModel();
    mockChatCompletion(JSON.stringify({ text: 'x'.repeat(9000), needs_review: false }));
    const result = await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '今天天汽很好'
    });
    expect(result.text).toBe('今天天汽很好');
    expect(result.needs_review).toBe(true);
    expect(result.reason).toContain('8000');
  });

  it('uses the current page text as terminology context when enabled', async () => {
    enableSpeech(true, true);
    configureChatModel();
    const calls = mockChatCompletion('{"text":"样本页","needs_review":false}');
    await correctTranscript(store, secrets, {
      documentId,
      page: 1,
      text: '样本页'
    });
    const user = calls[0]!.body.messages?.find((message) => message.role === 'user');
    expect(user?.content).toContain('当前页术语参考');
    expect(user?.content).toContain('Sample page content');
  });
});

describe('POST /api/v1/speech/correct', () => {
  it('returns the corrected result with 200', async () => {
    enableSpeech(true);
    configureChatModel();
    mockChatCompletion('{"text":"今天天气很好","needs_review":false}');
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { document_id: documentId, page: 1, text: '今天天汽很好' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      text: '今天天气很好',
      needs_review: false,
      corrected: true
    });
  });

  it('accepts camelCase documentId too', async () => {
    enableSpeech(true);
    configureChatModel();
    mockChatCompletion('{"text":"今天天气很好","needs_review":false}');
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { documentId, page: 1, text: '今天天汽很好' }
    });
    expect(response.statusCode).toBe(200);
  });

  it('validates missing text, bad page and unknown document', async () => {
    enableSpeech(true);
    configureChatModel();
    const missingText = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { documentId, page: 1, text: '' }
    });
    expect(missingText.statusCode).toBe(400);

    const tooLong = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { documentId, page: 1, text: 'x'.repeat(8001) }
    });
    expect(tooLong.statusCode).toBe(400);

    const badPage = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { documentId, page: 99, text: '你好' }
    });
    expect(badPage.statusCode).toBe(400);

    const missingDoc = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { documentId: 'missing-doc', page: 1, text: '你好' }
    });
    expect(missingDoc.statusCode).toBe(404);
  });

  it('returns 403 when speech input is disabled', async () => {
    saveSpeechConfig(store, secrets, { input_enabled: false, correction: true });
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/speech/correct',
      headers: headers(),
      payload: { documentId, page: 1, text: '你好' }
    });
    expect(response.statusCode).toBe(403);
  });
});
