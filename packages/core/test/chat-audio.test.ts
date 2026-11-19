import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 纯语音提问（`audio` 无 `question`）的 HTTP 用例。
 *
 * 既有用例都是文本提问；本文件固定 `/chat/ask` 与 `/chat/ask/stream` 在语音输入下的
 * 校验顺序与实测行为：
 * 1. `question`/`audio` 校验在 `documentId` 之前（只有 audio 可以没有 question）；
 * 2. audio-only 走到全模态模型分支，返回回答与逐字转写，`sources` 为空；
 * 3. audio + question 同时给：两段都发给全模态模型（text part + input_audio part）；
 * 4. 空/无效 audio（`{}`、`{data:''}`、数组、字符串）按**实测**行为断言，不假设。
 *
 * 模型全程 `vi.stubGlobal('fetch')` 模拟，不联网；audio 分支在读取文献之前返回，
 * 所以不需要真实 PDF（`documentId` 只要非空即可通过路由校验）。
 */

const token = 'chat-audio-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-chat-audio-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

/** 语音分支在回答前返回，不需要库里真有这篇文献；只要非空就能过路由校验。 */
const AUDIO_DOCUMENT_ID = 'voice-only-document';
const AUDIO_BASE64 = 'QUJDRA==';
const AUDIO_TRANSCRIPT = '这是语音的逐字转写。';
const AUDIO_ANSWER = '这是根据语音给出的回答。';

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

interface CapturedAudioCall {
  /** user 消息里的 input_audio 部分（有则说明走的是全模态分支）。 */
  audioData?: string;
  audioFormat?: string;
  /** user 消息里的文字部分（audio + question 时应等于 question）。 */
  textParts: string[];
}

let modelCalls = 0;
const audioCalls: CapturedAudioCall[] = [];

/** 模型 mock：只解析 audio 全模态请求，返回约定的 {transcript, answer} JSON。 */
function installModelMock(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    modelCalls += 1;
    const raw = init?.body ? String(init.body) : '';
    const parsed = raw ? (JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> }) : {};
    const user = (parsed.messages ?? []).find((message) => message.role === 'user');
    const content = Array.isArray(user?.content)
      ? (user!.content as Array<{
          type?: string;
          text?: string;
          input_audio?: { data?: string; format?: string };
        }>)
      : [];
    const textParts = content
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text ?? ''));
    const audioPart = content.find((part) => part.type === 'input_audio');
    audioCalls.push({
      audioData: audioPart?.input_audio?.data,
      audioFormat: audioPart?.input_audio?.format,
      textParts
    });
    // 约定的全模态返回：assistant.content 是 JSON 字符串 {"transcript","answer"}。
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({ transcript: AUDIO_TRANSCRIPT, answer: AUDIO_ANSWER })
          }
        }
      ]
    });
  });
}

function audioOnlyPayload(): Record<string, unknown> {
  return {
    documentId: AUDIO_DOCUMENT_ID,
    // data URL 前缀必须由服务端剥掉：接口只接受裸 base64。
    audio: { data: `data:audio/wav;base64,${AUDIO_BASE64}`, mimeType: 'audio/wav' }
  };
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({
      event: /^event: (.+)$/m.exec(chunk)?.[1] ?? '',
      data: /^data: (.+)$/m.exec(chunk)?.[1] ?? ''
    }))
    .filter((item) => Boolean(item.event));
}

async function askJson(payload: unknown): Promise<{
  statusCode: number;
  contentType: string;
  body: Record<string, unknown>;
}> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask',
    headers: headers(),
    payload: payload as Record<string, unknown>
  });
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    body: response.json() as Record<string, unknown>
  };
}

async function askStream(payload: unknown): Promise<{
  statusCode: number;
  contentType: string;
  body: string;
  events: SseEvent[];
}> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask/stream',
    headers: headers(),
    payload: payload as Record<string, unknown>
  });
  const body = String(response.body ?? '');
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    body,
    events: parseSse(body)
  };
}

beforeAll(() => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
});

beforeEach(() => {
  modelCalls = 0;
  audioCalls.length = 0;
  clearRouteCache();
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRouteCache();
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

describe('纯语音（audio 无 question）', () => {
  it('非流式 /chat/ask：只有 audio 也放行，返回回答与逐字转写', async () => {
    const { statusCode, body } = await askJson(audioOnlyPayload());
    expect(statusCode).toBe(200);
    expect(body.answer).toBe(AUDIO_ANSWER);
    expect(body.audio_transcript).toBe(AUDIO_TRANSCRIPT);
    expect(body.sources).toEqual([]);
    expect(String(body.notice ?? '')).toContain('录音');
    // audio 分支在预算闸门之前被跳过（audio 不估预算），也不该出现确认框。
    expect(body.needs_confirmation).toBeUndefined();
    expect(modelCalls).toBe(1);
    // 服务端剥掉了 data URL 前缀；format 由 mimeType 推导；纯语音没有文字 part。
    expect(audioCalls[0]).toEqual({
      audioData: AUDIO_BASE64,
      audioFormat: 'wav',
      textParts: []
    });
  }, 30_000);

  it('流式 /chat/ask/stream：只有 audio 也放行，result 事件带回答与转写', async () => {
    const { statusCode, contentType, events, body } = await askStream(audioOnlyPayload());
    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
    expect(events.some((event) => event.event === 'error')).toBe(false);
    const result = events.find((event) => event.event === 'result');
    expect(result).toBeDefined();
    const payload = JSON.parse(result!.data) as {
      answer?: unknown;
      audio_transcript?: unknown;
      sources?: unknown;
    };
    expect(payload.answer).toBe(AUDIO_ANSWER);
    expect(payload.audio_transcript).toBe(AUDIO_TRANSCRIPT);
    expect(payload.sources).toEqual([]);
    expect(body).not.toContain('needs_confirmation');
  }, 30_000);
});

describe('audio + question 同时给', () => {
  it('非流式：文字问题与录音一起发给全模态模型，两者都生效', async () => {
    const question = '这段录音讲了什么？';
    const { statusCode, body } = await askJson({
      ...audioOnlyPayload(),
      question
    });
    expect(statusCode).toBe(200);
    expect(body.answer).toBe(AUDIO_ANSWER);
    expect(body.audio_transcript).toBe(AUDIO_TRANSCRIPT);
    expect(modelCalls).toBe(1);
    // 文字问题作为 text part、录音作为 input_audio part 同时出现在同一条 user 消息里。
    expect(audioCalls[0]?.textParts).toEqual([question]);
    expect(audioCalls[0]?.audioData).toBe(AUDIO_BASE64);
    expect(audioCalls[0]?.audioFormat).toBe('wav');
  }, 30_000);

  it('流式：audio + question 同口径', async () => {
    const question = '这段录音讲了什么？';
    const { statusCode, events } = await askStream({ ...audioOnlyPayload(), question });
    expect(statusCode).toBe(200);
    const result = events.find((event) => event.event === 'result');
    expect(result).toBeDefined();
    const payload = JSON.parse(result!.data) as { answer?: unknown; audio_transcript?: unknown };
    expect(payload.answer).toBe(AUDIO_ANSWER);
    expect(payload.audio_transcript).toBe(AUDIO_TRANSCRIPT);
    expect(audioCalls[0]?.textParts).toEqual([question]);
  }, 30_000);
});

describe('校验顺序：question/audio 在 documentId 之前', () => {
  it('既没有 question 也没有 audio（也缺 documentId）：先报「需要 question」', async () => {
    const plain = await askJson({});
    expect(plain.statusCode).toBe(400);
    expect(plain.body.message).toBe('需要 question');

    const stream = await askStream({});
    expect(stream.statusCode).toBe(400);
    expect((JSON.parse(stream.body) as { message?: unknown }).message).toBe('需要 question');
  });

  it('只有 audio、缺 documentId：question/audio 校验通过后才报缺失 documentId', async () => {
    const plain = await askJson({
      audio: { data: AUDIO_BASE64, mimeType: 'audio/wav' }
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.body.message).toBe('独立会话已移除，请先从文献库打开一篇文献再提问');

    const stream = await askStream({
      audio: { data: AUDIO_BASE64, mimeType: 'audio/wav' }
    });
    expect(stream.statusCode).toBe(400);
    expect((JSON.parse(stream.body) as { message?: unknown }).message).toBe(
      '独立会话已移除，请先从文献库打开一篇文献再提问'
    );
  });

  it('question 只有空白且没有 audio：报「需要 question」', async () => {
    const plain = await askJson({ question: '   ', documentId: AUDIO_DOCUMENT_ID });
    expect(plain.statusCode).toBe(400);
    expect(plain.body.message).toBe('需要 question');
  });
});

describe('audio 为空/无效（按实测行为断言）', () => {
  it('audio 是对象但没有 data：通过路由校验后在全模态分支前以「问题不能为空」失败（非流式 400）', async () => {
    const { statusCode, body } = await askJson({
      documentId: AUDIO_DOCUMENT_ID,
      audio: {}
    });
    expect(statusCode).toBe(400);
    expect(body.message).toBe('问题不能为空');
    // 没有真正的 audio data → 不会调用全模态模型。
    expect(modelCalls).toBe(0);
  }, 30_000);

  it('audio.data 为空字符串：同「问题不能为空」', async () => {
    const { statusCode, body } = await askJson({
      documentId: AUDIO_DOCUMENT_ID,
      audio: { data: '', mimeType: 'audio/wav' }
    });
    expect(statusCode).toBe(400);
    expect(body.message).toBe('问题不能为空');
    expect(modelCalls).toBe(0);
  }, 30_000);

  it('audio 是数组：对象判断放行，但同样没有 data →「问题不能为空」', async () => {
    const { statusCode, body } = await askJson({
      documentId: AUDIO_DOCUMENT_ID,
      audio: []
    });
    expect(statusCode).toBe(400);
    expect(body.message).toBe('问题不能为空');
    expect(modelCalls).toBe(0);
  }, 30_000);

  it('audio 不是对象（字符串）：不算有 audio，按缺 question 拒绝', async () => {
    const { statusCode, body } = await askJson({
      documentId: AUDIO_DOCUMENT_ID,
      audio: 'not-an-audio-object'
    });
    expect(statusCode).toBe(400);
    expect(body.message).toBe('需要 question');
    expect(modelCalls).toBe(0);
  }, 30_000);

  it('流式：无效 audio 由 SSE error 事件收尾（实测 200 + error，不是 HTTP 400）', async () => {
    const { statusCode, contentType, events } = await askStream({
      documentId: AUDIO_DOCUMENT_ID,
      audio: {}
    });
    // 实测：SSE 路由在 hijack 前已完成校验，错误在流内以 error 事件返回。
    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
    const errorEvent = events.find((event) => event.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((JSON.parse(errorEvent!.data) as { message?: unknown }).message).toBe('问题不能为空');
    expect(events.some((event) => event.event === 'result')).toBe(false);
    expect(modelCalls).toBe(0);
  }, 30_000);
});
