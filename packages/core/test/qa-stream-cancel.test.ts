import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@studianda/shared';
import { answerQuestion } from '../src/chat.js';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 独立问答默认路径（库内检索）必须：
 *
 * 1. 用流式调用：`onDraft` 能收到增量，最终 answer 是增量拼接结果；
 * 2. 真正可取消：用户取消 signal 后立即以 AbortError 结束，而不是继续等模型（原实现用固定
 *    60s 超时、忽略传入 signal）。
 *
 * 用「无文献 + 一条匹配的独立笔记」让库内检索路径在 sources=[]、memoryHits>0 时仍会调用模型；
 * 模型服务用 `vi.stubGlobal('fetch')` 模拟，不联网。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-qa-stream-'));
let store: Store;
let secrets: SecretStore;

function sseResponse(chunks: string[]): Response {
  const body = chunks
    .map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    .join('');
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function routeResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              document: true,
              search: false,
              reason: '库内检索问答',
              reply: '',
              reading: 'document'
            })
          }
        }
      ]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeAll(() => {
  store = new Store(dataDir);
  secrets = new SecretStore();
  store.createNote({
    documentId: '',
    page: 0,
    content: '独立笔记：价值信念是本文的核心概念，作者把它与单纯意见区分开。'
  });
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
});

beforeEach(() => {
  clearRouteCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRouteCache();
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

describe('独立问答默认路径：流式与取消', () => {
  it('用流式调用：onDraft 收到增量，answer 是增量拼接', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
        const system = messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
        if (system.includes('QUESTION_ROUTE')) return routeResponse();
        // 库内检索回答：必须是真的 SSE 流（body.stream === true）。
        expect(body.stream).toBe(true);
        return sseResponse(['价值信念', '是本文的', '核心概念。[1]']);
      })
    );
    const drafts: string[] = [];
    const response: ChatResponse = await answerQuestion(
      store,
      secrets,
      { question: '价值信念是什么', include_memory: true },
      undefined,
      undefined,
      (text) => drafts.push(text)
    );
    expect(drafts.join('')).toBe('价值信念是本文的核心概念。[1]');
    expect(drafts.length).toBeGreaterThan(1);
    expect(response.answer).toBe('价值信念是本文的核心概念。[1]');
    // 流式路径仍然返回库内检索口径与笔记来源。
    expect(response.answer_mode).toBe('library');
    expect(response.memory_sources?.length).toBeGreaterThan(0);
  });

  it('取消 signal 会立即中断模型调用（AbortError），不再等 60s 超时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
        const system = messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
        if (system.includes('QUESTION_ROUTE')) return routeResponse();
        // 最终回答：挂起直到 signal 被取消（模拟一个会跑很久的模型调用）。
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        });
      })
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = answerQuestion(
      store,
      secrets,
      { question: '价值信念是什么', include_memory: true },
      controller.signal
    );
    setTimeout(() => controller.abort(), 80);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
