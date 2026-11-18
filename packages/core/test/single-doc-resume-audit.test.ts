import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// 续读复用只验证「chat.ts 从会话历史复制 audit_summary」这一层：阅读链路整体替身化，
// 由测试直接给出 reused_answer 响应（没有重新调用模型，所以响应里没有 audit）。
vi.mock('../src/reading-chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reading-chat.js')>();
  return { ...actual, answerWithReading: vi.fn() };
});
// 续读不重跑问题路由：路由替身固定判定「读文献」，避免测试触碰模型。
vi.mock('../src/question-route.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/question-route.js')>();
  return {
    ...actual,
    routeQuestion: vi.fn(async () => ({
      document: true,
      search: false,
      reason: '测试：读文献',
      reply: '',
      modelPlan: false,
      plan: null,
      summaryIntent: false
    }))
  };
});

import type { ChatAuditSummary, ChatResponse, ReadingPlanRecord } from '@studianda/shared';
import { answerQuestion } from '../src/chat.js';
import { answerWithReading } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 单篇「继续阅读」复用答案的审计摘要继承：
 *
 * - 续读复用（`reused_answer`，没有未读页/草稿恢复）不会重新调用模型，响应里没有 audit；
 * - 审计结论等于被复用上一轮回答的结论：chat.ts 按正文从会话历史复制 `audit_summary`，
 *   复制而非重算、更不补 0（补 0 会把「有缺证」谎报成「没有」）；
 * - 找不到原消息（旧数据/正文未落库）时宁可不写摘要，也不伪造计数。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-single-resume-audit-'));
const ORIGINAL_ANSWER = '上一轮已保存的单篇回答正文：这句话被原样复用。';
const TASK_ID = 'single-resume-task';

/** 上一轮的审计摘要：claims=5 不可能从「没有 audit 的复用响应」重算出来。 */
const SUMMARY: ChatAuditSummary = {
  claims: 5,
  supported: 2,
  inference: 1,
  unsupported: 2,
  heading: 0,
  claim_types: { DOCUMENT_INTERPRETATION: 3, HISTORICAL_FACT: 2 },
  source_changed: 1,
  invalid_citations: 1
};

const PLAN: ReadingPlanRecord = {
  breadth: 'document',
  reason: '测试',
  origin: '规则',
  pages: [],
  queries: [],
  dimensions: []
};

beforeAll(() => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
});

afterAll(() => {
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(answerWithReading).mockReset();
});

/** 建独立数据目录 + 一篇 2 页 PDF；返回目录、store 与文档 id。 */
async function setupDocument(
  label: string
): Promise<{ dir: string; store: Store; documentId: string }> {
  const dir = mkdtempSync(path.join(root, `${label}-`));
  const store = new Store(dir);
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([200, 300]);
  const file = path.join(dir, `${label}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  store.savePageTextEdit(document.id, 1, '第一页原文：模型的定义。');
  store.savePageTextEdit(document.id, 2, '第二页原文：模型的补充说明。');
  return { dir, store, documentId: document.id };
}

/**
 * 造一个「全部页已读完但任务还没被销掉」的单篇任务。
 *
 * `answerWithReading()` 的复用分支只在任务仍存在且没有未读页时走到（正常流程读完会删任务，
 * 进程中断可能留下这种任务），这里直接落库复现该状态。
 */
function saveReusedTask(store: Store, documentId: string): void {
  store.saveReadingTask(
    TASK_ID,
    {
      question: '模型',
      selection: '',
      documentId,
      plan: PLAN,
      pagesRead: [1, 2],
      findings: [],
      answer: ORIGINAL_ANSWER,
      sources: [],
      unread_pages: []
    },
    [documentId]
  );
}

/** 复用响应：正文与原回答一致、没有 audit/audit_summary，只有 reused_answer 标记。 */
function reusedResponse(): ChatResponse {
  return {
    answer: ORIGINAL_ANSWER,
    sources: [],
    taskId: TASK_ID,
    reused_answer: true,
    notice: '本轮已经读完当前文献，没有需要补读的页。'
  };
}

async function continueReading(
  store: Store,
  documentId: string,
  sessionId: string
): Promise<ChatResponse> {
  return answerQuestion(store, new SecretStore(), {
    question: '模型',
    documentId,
    page: 1,
    taskId: TASK_ID,
    chat_session_id: sessionId
  });
}

describe('单篇续读复用的审计摘要继承', () => {
  it('复用答案时把上一轮 assistant 消息的 audit_summary 复制进响应，并能原样落库', async () => {
    const { dir, store, documentId } = await setupDocument('single-copy');
    const sessionId = 'single-session-copy';
    try {
      // 上一轮回答（被复用的就是它）：正文 + 完整审计摘要。
      store.addMessage({
        documentId,
        role: 'assistant',
        content: ORIGINAL_ANSWER,
        auditSummary: SUMMARY,
        metadata: { sessionId }
      });
      saveReusedTask(store, documentId);
      vi.mocked(answerWithReading).mockResolvedValueOnce(reusedResponse());

      const response = await continueReading(store, documentId, sessionId);
      expect(response.reused_answer).toBe(true);
      expect(response.answer).toBe(ORIGINAL_ANSWER);
      // claims=5 只可能来自复制：复用响应里没有 audit，重算只能是 0。
      expect(response.audit_summary).toEqual(SUMMARY);

      // 界面把整轮响应存进 metadata.response 后，落库摘要同样是对原消息的复制。
      const stored = store.addMessage({
        documentId,
        role: 'assistant',
        content: response.answer ?? '',
        metadata: { sessionId, response: { ...response, sources: undefined } }
      });
      expect(stored.auditSummary).toEqual(SUMMARY);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('会话里找不到被复用的原消息时不补 0：响应不带 audit_summary，落库为 NULL', async () => {
    const { dir, store, documentId } = await setupDocument('single-missing');
    const sessionId = 'single-session-missing';
    try {
      saveReusedTask(store, documentId);
      vi.mocked(answerWithReading).mockResolvedValueOnce(reusedResponse());

      const response = await continueReading(store, documentId, sessionId);
      expect(response.reused_answer).toBe(true);
      expect(response.audit_summary).toBeUndefined();

      const stored = store.addMessage({
        documentId,
        role: 'assistant',
        content: response.answer ?? '',
        metadata: { sessionId, response: { ...response, sources: undefined } }
      });
      expect(stored.auditSummary).toBeUndefined();
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('会话里只有正文不同的旧回答时不误复制：保持没有摘要', async () => {
    const { dir, store, documentId } = await setupDocument('single-other');
    const sessionId = 'single-session-other';
    try {
      store.addMessage({
        documentId,
        role: 'assistant',
        content: '另一轮不同的回答正文。',
        auditSummary: SUMMARY,
        metadata: { sessionId }
      });
      saveReusedTask(store, documentId);
      vi.mocked(answerWithReading).mockResolvedValueOnce(reusedResponse());

      const response = await continueReading(store, documentId, sessionId);
      expect(response.audit_summary).toBeUndefined();
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
