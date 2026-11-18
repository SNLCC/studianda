import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageRecord, ChatResponse } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 跨文献（语料）会话的最小可用版（schema 23）：范围快照 + 可追问的跨篇精读会话。
 *
 * 覆盖：
 * 1. 建会话 → 追问两轮：消息按序落库、session_id 正确、第二轮历史来自已落库消息；
 * 2. 范围快照不随之后新增的文献变化（会话只读建立时的 documentIds）；
 * 3. 范围含已删除文献：建立/追问都跳过并在响应里报告，全部不可读时拒绝建立/追问；
 * 4. 删除会话清理该会话消息（不碰其它会话）。
 *
 * 模型服务全程 `vi.stubGlobal('fetch')` 模拟，不联网；样张 PDF 由 pdf-lib 运行时生成。
 */

const token = 'corpus-sessions-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-sessions-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

let documentA = '';
let documentB = '';
let documentC = '';
let fetchBodies: string[] = [];

const headers = { 'x-studianda-token': token };

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** 从批次材料里取第一段原文，作为模型"逐字摘引"返回（保证能通过核验）。 */
function quoteFromMaterial(user: string): string {
  const match = /\[1\][^\n]*\n([^\n]{4,})/.exec(user);
  return (match?.[1] ?? '').trim().slice(0, 60);
}

/** 从审计材料里取一条已给原文，作为 supported 的逐字证据。 */
function firstAuditEvidence(user: string): { source: number; quote: string } | null {
  const start = user.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(user.slice(start)) as {
      evidence_index?: unknown;
      verified_quotes?: unknown;
    };
    const list = Array.isArray(parsed.verified_quotes)
      ? parsed.verified_quotes
      : Array.isArray(parsed.evidence_index)
        ? parsed.evidence_index
        : [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const item = row as { source?: unknown; quote?: unknown };
      if (typeof item.quote === 'string' && item.quote.trim().length >= 4) {
        return {
          source: typeof item.source === 'number' ? item.source : 1,
          quote: item.quote.trim().slice(0, 120)
        };
      }
    }
  } catch {
    // 材料不是 JSON（或半截）：按没有证据处理。
  }
  return null;
}

/** 跨文献管线用到的三类模型调用（逐批阅读 / 综合 / 审计）统一走本地 mock。 */
function installModelMock(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const raw = init?.body ? String(init.body) : '';
    fetchBodies.push(raw);
    const body = raw ? (JSON.parse(raw) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = '';
    if (system.includes('READING_BATCH')) {
      const quote = quoteFromMaterial(user);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
      const evidence = firstAuditEvidence(user);
      content = JSON.stringify({
        claims: [
          {
            claim: 1,
            verdict: 'supported',
            reason: '原文支持',
            claim_type: 'DOCUMENT_INTERPRETATION',
            evidence_standard: 'GROUNDED',
            evidence: evidence ? [evidence] : []
          }
        ]
      });
    } else {
      content = '跨文献回答：这批文献给出了相关论述。';
    }
    return jsonResponse(content);
  });
}

async function importPdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`${name} ${index + 1}`, { x: 20, y: 20, size: 8, font });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return document.id;
}

async function createSession(documentIds: string[]): Promise<Record<string, unknown>> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/corpus-sessions',
    headers,
    payload: { documentIds }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

function sessionIdOf(payload: Record<string, unknown>): string {
  const session = payload.session as { id?: string } | undefined;
  expect(session?.id).toBeTruthy();
  return String(session!.id);
}

async function ask(sessionId: string, question: string): Promise<Record<string, unknown>> {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
    headers,
    payload: { question }
  });
  return { statusCode: response.statusCode, ...(response.json() as Record<string, unknown>) };
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  documentA = await importPdf('corpus-a.pdf', 2);
  documentB = await importPdf('corpus-b.pdf', 2);
  documentC = await importPdf('corpus-c.pdf', 2);
  store.savePageTextEdit(documentA, 1, '甲文献第一页：讨论模型的定义。');
  store.savePageTextEdit(documentA, 2, '甲文献第二页：补充说明。');
  store.savePageTextEdit(documentB, 1, '乙文献第一页：也讨论模型训练。');
  store.savePageTextEdit(documentB, 2, '乙文献第二页：结论。');
  store.savePageTextEdit(documentC, 1, '丙文献第一页：方法与数据。');
  store.savePageTextEdit(documentC, 2, '丙文献第二页：讨论。');
}, 120_000);

beforeEach(() => {
  fetchBodies = [];
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

describe('跨文献会话', () => {
  it('建会话 → 追问两轮：消息按序落库、session_id 正确、第二轮带上已落库历史', async () => {
    const created = await createSession([documentA, documentB]);
    const sessionId = sessionIdOf(created);
    const session = created.session as {
      documentIds: string[];
      documents: Array<{ id: string }>;
      skippedDocumentIds: string[];
      title: string;
    };
    expect(session.documentIds).toEqual([documentA, documentB]);
    expect(session.documents.map((document) => document.id)).toEqual([documentA, documentB]);
    expect(session.skippedDocumentIds).toEqual([]);
    expect(session.title).toContain('篇');

    const first = await ask(sessionId, '模型训练');
    expect(first.statusCode).toBe(200);
    expect(first.reading_scope).toBe('corpus');
    expect(String(first.answer)).toContain('跨文献回答');
    expect(first.session_id).toBe(sessionId);
    expect(first.skipped_document_ids).toEqual([]);

    const firstRoundBodies = fetchBodies.length;
    expect(firstRoundBodies).toBeGreaterThan(0);

    const second = await ask(sessionId, '再看定义');
    expect(second.statusCode).toBe(200);
    // 第二轮的历史来自该会话已落库的消息：模型请求里能看到上一轮回答。
    const secondRoundBodies = fetchBodies.slice(firstRoundBodies);
    expect(secondRoundBodies.length).toBeGreaterThan(0);
    expect(
      secondRoundBodies.some((body) => body.includes('跨文献回答：这批文献给出了相关论述。'))
    ).toBe(true);

    const messages = await server.inject({
      method: 'GET',
      url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/messages`,
      headers
    });
    expect(messages.statusCode).toBe(200);
    const rows = messages.json() as ChatMessageRecord[];
    expect(rows.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rows.map((message) => message.content.slice(0, 4))).toEqual([
      '模型训练',
      '跨文献回',
      '再看定义',
      '跨文献回'
    ]);
    // 消息复用 messages：document_id 为空串哨兵，归属只看 session_id。
    for (const message of rows) {
      expect(message.documentId).toBe('');
      expect(message.sessionId).toBe(sessionId);
    }
    // 数据层口径一致（按会话 id 读回同 4 条）。
    expect(store.listCorpusSessionMessages(sessionId).map((message) => message.id)).toEqual(
      rows.map((message) => message.id)
    );
  });

  it('范围快照不随之后新增的文献变化', async () => {
    const created = await createSession([documentA]);
    const sessionId = sessionIdOf(created);

    // 会话建立之后图书馆新增一篇文献：快照保持不可变，不会自动加入。
    const added = await importPdf('corpus-later.pdf', 2);
    store.savePageTextEdit(added, 1, '后加文献第一页：新增内容。');
    store.savePageTextEdit(added, 2, '后加文献第二页：新增内容。');
    expect(store.listDocuments().map((document) => document.id)).toContain(added);

    expect(store.getCorpusSession(sessionId)?.documentIds).toEqual([documentA]);

    const listed = await server.inject({ method: 'GET', url: '/api/v1/corpus-sessions', headers });
    expect(listed.statusCode).toBe(200);
    const sessions = (listed.json() as { sessions: Array<Record<string, unknown>> }).sessions;
    const shown = sessions.find((item) => item.id === sessionId)!;
    expect(shown.documentIds).toEqual([documentA]);
    expect((shown.documents as Array<{ id: string }>).map((document) => document.id)).toEqual([
      documentA
    ]);

    const answer = await ask(sessionId, '模型的定义');
    expect(answer.statusCode).toBe(200);
    const coverage = answer.coverage as { selected_documents?: number; candidate_documents?: number };
    expect(coverage.selected_documents).toBe(1);
    expect(coverage.candidate_documents).toBe(1);
    const sources = answer.sources as Array<{ documentId: string }>;
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.documentId === documentA)).toBe(true);
  });

  it('范围含已删除文献：建立与追问都跳过并在响应里报告；全部不可读时拒绝', async () => {
    store.deleteDocument(documentB);
    try {
      const created = await createSession([documentA, documentB]);
      const sessionId = sessionIdOf(created);
      const session = created.session as {
        documentIds: string[];
        documents: Array<{ id: string }>;
        skippedDocumentIds: string[];
      };
      // 快照仍保留建立时的显式范围（含已删除文献），但当前可读清单只含甲。
      expect(session.documentIds).toEqual([documentA, documentB]);
      expect(session.documents.map((document) => document.id)).toEqual([documentA]);
      expect(session.skippedDocumentIds).toEqual([documentB]);

      const answer = await ask(sessionId, '模型训练');
      expect(answer.statusCode).toBe(200);
      expect(answer.skipped_document_ids).toEqual([documentB]);
      expect(String(answer.notice)).toContain('已跳过');
      expect((answer.coverage as { selected_documents?: number }).selected_documents).toBe(1);
      // 回答落库时同样记录跳过清单，便于回看。
      const last = store.listCorpusSessionMessages(sessionId).at(-1)!;
      expect(last.metadata.skipped_document_ids).toEqual([documentB]);

      // 范围为空：一篇可读文献都没有时拒绝建立会话。
      const empty = await server.inject({
        method: 'POST',
        url: '/api/v1/corpus-sessions',
        headers,
        payload: { documentIds: [documentB] }
      });
      expect(empty.statusCode).toBe(400);

      // 追问时范围里的文献全部被删：409 并带出被跳过的 id。
      store.deleteDocument(documentA);
      const stale = await server.inject({
        method: 'POST',
        url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
        headers,
        payload: { question: '还能追问吗' }
      });
      expect(stale.statusCode).toBe(409);
      expect((stale.json() as { details?: { skipped_document_ids?: string[] } }).details)
        .toMatchObject({ skipped_document_ids: [documentA, documentB] });
    } finally {
      store.restoreDocument(documentB);
      store.restoreDocument(documentA);
    }
  });

  it('删除会话清理该会话消息；不存在的会话返回 404', async () => {
    const kept = sessionIdOf(await createSession([documentC]));
    const removedSession = sessionIdOf(await createSession([documentA]));
    expect((await ask(removedSession, '模型训练')).statusCode).toBe(200);
    expect(store.listCorpusSessionMessages(removedSession)).toHaveLength(2);
    if (kept === removedSession) throw new Error('会话 id 不应相同');
    expect((await ask(kept, '方法与数据')).statusCode).toBe(200);
    const keptMessageIds = store.listCorpusSessionMessages(kept).map((message) => message.id);
    expect(keptMessageIds).toHaveLength(2);

    const deleted = await server.inject({
      method: 'DELETE',
      url: `/api/v1/corpus-sessions/${encodeURIComponent(removedSession)}`,
      headers
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, removed: 2 });
    expect(store.getCorpusSession(removedSession)).toBeNull();
    expect(store.listCorpusSessionMessages(removedSession)).toEqual([]);
    // 其它会话的消息不受影响。
    expect(store.listCorpusSessionMessages(kept).map((message) => message.id)).toEqual(
      keptMessageIds
    );

    const again = await server.inject({
      method: 'DELETE',
      url: `/api/v1/corpus-sessions/${encodeURIComponent(removedSession)}`,
      headers
    });
    expect(again.statusCode).toBe(404);

    const missingMessages = await server.inject({
      method: 'GET',
      url: `/api/v1/corpus-sessions/${encodeURIComponent(removedSession)}/messages`,
      headers
    });
    expect(missingMessages.statusCode).toBe(404);
  });

  it('参数校验：缺 documentIds / 缺 question 返回 400', async () => {
    const missingIds = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: {}
    });
    expect(missingIds.statusCode).toBe(400);

    const sessionId = sessionIdOf(await createSession([documentA]));
    const noQuestion = await server.inject({
      method: 'POST',
      url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
      headers,
      payload: {}
    });
    expect(noQuestion.statusCode).toBe(400);
    // 校验失败不应留下 user 消息。
    expect(store.listCorpusSessionMessages(sessionId)).toEqual([]);

    const unknownSession = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions/not-a-session/ask',
      headers,
      payload: { question: '问题' }
    });
    expect(unknownSession.statusCode).toBe(404);
  });
});
