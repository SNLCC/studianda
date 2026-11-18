import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// 本文件只验证「复用答案」落库时的审计摘要继承：跨文献阅读链整体替身化，
// 由测试直接给出 reused_answer 响应（没有重新调用模型，所以响应里没有 audit）。
vi.mock('../src/reading-chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reading-chat.js')>();
  return { ...actual, answerWithCorpus: vi.fn() };
});

import type { ChatAuditSummary, ChatResponse } from '@studianda/shared';
import { answerWithCorpus } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 跨文献会话复用答案（`reused_answer`）时的审计摘要继承：
 *
 * - 复用不重新调用模型，响应里没有 audit；但复用答案的审计结论等于**原答案**的审计结论，
 *   所以落库时要把原消息的 `audit_summary` 原样复制过来（复制而非重算）；
 * - 原消息没有摘要（旧数据/失败占位）时，新消息也保持 NULL，不补 0、不伪造。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-reused-audit-'));
const token = 'corpus-reused-audit-token';
const headers = { 'x-studianda-token': token };

/** 一轮回答的审计摘要样例：claims=7 不可能从「没有 audit 的复用响应」重算出来。 */
const SUMMARY: ChatAuditSummary = {
  claims: 7,
  supported: 3,
  inference: 2,
  unsupported: 2,
  heading: 0,
  claim_types: { DOCUMENT_INTERPRETATION: 4, HISTORICAL_FACT: 3 },
  source_changed: 1,
  invalid_citations: 2,
  selection_snapshot_status: 'source_changed'
};

const ORIGINAL_ANSWER = '上一轮已保存的跨文献回答正文：这句话被原样复用。';

beforeAll(() => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

afterEach(() => {
  vi.mocked(answerWithCorpus).mockReset();
});

/** 建一个独立数据目录，并导入一篇最小 PDF（返回目录与文档 id）。 */
async function setupDocument(
  label: string
): Promise<{ dir: string; store: Store; documentId: string }> {
  const dir = mkdtempSync(path.join(root, `${label}-`));
  const store = new Store(dir);
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const file = path.join(dir, `${label}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return { dir, store, documentId: document.id };
}

/** 复用响应：正文与原回答一致、没有 audit/audit_summary，只有 reused_answer 标记。 */
function reusedResponse(): ChatResponse {
  return {
    answer: ORIGINAL_ANSWER,
    sources: [],
    reused_answer: true,
    notice: '这些文献已没有需要补读的页；下面是上一轮已保存的回答，本轮没有重新调用模型。'
  };
}

/** 走一次跨文献追问（命中复用的整条落库链路）。 */
async function ask(
  server: ReturnType<typeof buildServer>,
  sessionId: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
    headers,
    payload: { question: '继续阅读' }
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** 直接看库列值，核实「NULL」不是空串或 '{}'（调用前 store 必须已关闭）。 */
function auditSummaryColumn(dir: string, messageId: number): string | null {
  const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
  try {
    const row = raw
      .prepare('SELECT audit_summary FROM messages WHERE id = ?')
      .get(messageId) as { audit_summary: string | null } | undefined;
    return row?.audit_summary ?? null;
  } finally {
    raw.close();
  }
}

describe('跨文献会话复用答案的审计摘要继承', () => {
  it('复用答案时把被复用原消息的 audit_summary 复制到新消息（不重算、不补 0）', async () => {
    const { dir, store, documentId } = await setupDocument('reuse-copy');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    let sessionId = '';
    let reusedMessageId = 0;
    try {
      const session = store.createCorpusSession('复用答案审计', [documentId]);
      sessionId = session.id;
      // 原消息：上一轮已落库的回答（复用的就是它），带完整摘要。
      const original = store.addCorpusSessionMessage({
        sessionId: session.id,
        role: 'assistant',
        content: ORIGINAL_ANSWER,
        sources: [{ documentId, documentName: 'reuse-copy.pdf', page: 1, snippet: '原文' }],
        auditSummary: SUMMARY,
        metadata: { corpusSessionId: session.id }
      });
      expect(original.auditSummary).toEqual(SUMMARY);

      vi.mocked(answerWithCorpus).mockResolvedValueOnce(reusedResponse());
      const result = await ask(server, session.id);
      expect(result.statusCode).toBe(200);
      expect(result.body.reused_answer).toBe(true);
      reusedMessageId = Number(result.body.assistant_message_id);
      expect(reusedMessageId).toBeGreaterThan(original.id);

      const reused = store
        .listCorpusSessionMessages(session.id)
        .find((row) => row.id === reusedMessageId)!;
      expect(reused.content).toBe(ORIGINAL_ANSWER);
      // claims=7 只可能来自复制：复用响应里没有 audit，重算只能是 0。
      expect(reused.auditSummary).toEqual(SUMMARY);
    } finally {
      await server.close();
      store.close();
    }
    // 重开历史（读取路径）后摘要仍在：这是本功能的意义。
    try {
      const reopened = new Store(dir);
      try {
        const restored = reopened
          .listCorpusSessionMessages(sessionId)
          .find((row) => row.id === reusedMessageId)!;
        expect(restored.auditSummary).toEqual(SUMMARY);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('原消息没有审计摘要时，复用后的新消息也保持 NULL（不伪造计数）', async () => {
    const { dir, store, documentId } = await setupDocument('reuse-null');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    let reusedMessageId = 0;
    try {
      const session = store.createCorpusSession('复用答案无摘要', [documentId]);
      store.addCorpusSessionMessage({
        sessionId: session.id,
        role: 'assistant',
        content: ORIGINAL_ANSWER,
        metadata: { corpusSessionId: session.id }
      });
      vi.mocked(answerWithCorpus).mockResolvedValueOnce(reusedResponse());
      const result = await ask(server, session.id);
      expect(result.statusCode).toBe(200);
      reusedMessageId = Number(result.body.assistant_message_id);
      const reused = store
        .listCorpusSessionMessages(session.id)
        .find((row) => row.id === reusedMessageId)!;
      expect(reused.content).toBe(ORIGINAL_ANSWER);
      expect(reused.auditSummary).toBeUndefined();
    } finally {
      await server.close();
      store.close();
    }
    try {
      expect(auditSummaryColumn(dir, reusedMessageId)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('会话里找不到被复用的原消息时不伪造摘要，新消息为 NULL', async () => {
    const { dir, store, documentId } = await setupDocument('reuse-missing');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    let reusedMessageId = 0;
    try {
      const session = store.createCorpusSession('复用答案无原消息', [documentId]);
      vi.mocked(answerWithCorpus).mockResolvedValueOnce(reusedResponse());
      const result = await ask(server, session.id);
      expect(result.statusCode).toBe(200);
      reusedMessageId = Number(result.body.assistant_message_id);
      const reused = store
        .listCorpusSessionMessages(session.id)
        .find((row) => row.id === reusedMessageId)!;
      expect(reused.auditSummary).toBeUndefined();
    } finally {
      await server.close();
      store.close();
    }
    try {
      expect(auditSummaryColumn(dir, reusedMessageId)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
