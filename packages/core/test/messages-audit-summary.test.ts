import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatAuditSummary, ChatMessageRecord } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 会话消息的审计摘要（schema_version 24）：
 *
 * - 单篇与跨篇消息落库时写 `scope_kind`（'document' | 'corpus'），assistant 消息把审计结果
 *   压成摘要写进 `audit_summary`（只存计数/状态，不存正文/完整 ChatResponse）；
 * - 读取（store 与 HTTP 历史接口）把摘要解析回 `auditSummary` 挂在消息上；
 * - **重开会话后审计信息仍在**（本功能核心价值）；坏 JSON 降级为「没有摘要」，旧消息 NULL 正常；
 * - 老消息（迁移前 `audit_summary=NULL`）读取不报错。
 *
 * 每个用例独占一个数据目录：Store 用实例锁保证单进程独占，重开必须真的 close 再 new。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-message-audit-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 一轮回答的审计摘要样例（含缺证归因、越界引用、选区状态）。 */
const SUMMARY: ChatAuditSummary = {
  claims: 5,
  supported: 2,
  inference: 1,
  unsupported: 2,
  heading: 0,
  claim_types: { DOCUMENT_INTERPRETATION: 3, HISTORICAL_FACT: 2 },
  source_changed: 1,
  invalid_citations: 2,
  selection_snapshot_status: 'source_changed'
};

/** 建一个独立数据目录，并导入一篇最小 PDF（返回目录与文档 id）。 */
async function setupDocument(label: string): Promise<{ dir: string; store: Store; documentId: string }> {
  const dir = mkdtempSync(path.join(root, `${label}-`));
  const store = new Store(dir);
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const file = path.join(dir, `${label}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return { dir, store, documentId: document.id };
}

describe('消息审计摘要落库与恢复', () => {
  it('跨篇消息：scope_kind/audit_summary 落库，重开会话后审计摘要仍在', async () => {
    const { dir, store, documentId } = await setupDocument('corpus');
    try {
      const corpus = store.createCorpusSession('审计摘要会话', [documentId]);
      const user = store.addCorpusSessionMessage({
        sessionId: corpus.id,
        role: 'user',
        content: '这篇文献的证据链是什么？',
        metadata: { corpusSessionId: corpus.id }
      });
      const assistant = store.addCorpusSessionMessage({
        sessionId: corpus.id,
        role: 'assistant',
        content: '回答正文（审计摘要另行保存）。',
        sources: [{ documentId, documentName: 'corpus.pdf', page: 1, snippet: '原文' }],
        auditSummary: SUMMARY
      });

      // 落库返回值就带作用域与摘要，调用方无需再猜 document_id 哨兵语义。
      expect(user.scopeKind).toBe('corpus');
      expect(user.auditSummary).toBeUndefined();
      expect(assistant.scopeKind).toBe('corpus');
      expect(assistant.auditSummary).toEqual(SUMMARY);

      // 重开数据目录（模拟重启后打开历史会话）：摘要仍在，且解析成同一结构。
      store.close();
      const reopened = new Store(dir);
      try {
        const rows = reopened.listCorpusSessionMessages(corpus.id);
        expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
        expect(rows.map((row) => row.scopeKind)).toEqual(['corpus', 'corpus']);
        expect(rows[0]!.auditSummary).toBeUndefined();
        expect(rows[1]!.auditSummary).toEqual(SUMMARY);
        expect(rows[1]!.content).toBe('回答正文（审计摘要另行保存）。');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('单篇消息：scope_kind=document，assistant 从完整 ChatResponse 自动压缩摘要；坏 JSON/旧消息降级不报错', async () => {
    const { dir, store, documentId } = await setupDocument('document');
    try {
      // 客户端把整轮 ChatResponse 放进 metadata.response（阅读页既有做法），服务端负责压缩。
      const sessionId = 'audit-session';
      const assistant = store.addMessage({
        documentId,
        role: 'assistant',
        content: '单篇回答正文。',
        metadata: {
          sessionId,
          response: {
            answer: '单篇回答正文。',
            sources: [],
            invalid_citations: [3, 9],
            audit: {
              status: '已进行模型证据支持复核',
              claims: [
                { claim: 1, verdict: 'supported', claim_type: 'DOCUMENT_INTERPRETATION' },
                { claim: 2, verdict: 'inference', claim_type: 'DOCUMENT_INTERPRETATION' },
                {
                  claim: 3,
                  verdict: 'unsupported',
                  claim_type: 'HISTORICAL_FACT',
                  evidence_status: 'source_changed'
                },
                { claim: 4, verdict: 'unsupported', claim_type: 'HISTORICAL_FACT' }
              ]
            },
            selection_snapshot: { status: 'source_changed' }
          }
        }
      });
      expect(assistant.scopeKind).toBe('document');
      expect(assistant.auditSummary).toEqual({
        claims: 4,
        supported: 1,
        inference: 1,
        unsupported: 2,
        heading: 0,
        claim_types: { DOCUMENT_INTERPRETATION: 2, HISTORICAL_FACT: 2 },
        source_changed: 1,
        invalid_citations: 2,
        selection_snapshot_status: 'source_changed'
      });

      // 重开数据目录后历史接口仍能读到摘要。
      store.close();
      let reopened = new Store(dir);
      try {
        const rows = reopened.listMessages(documentId, { sessionId });
        expect(rows.at(-1)).toMatchObject({
          content: '单篇回答正文。',
          scopeKind: 'document',
          auditSummary: { claims: 4, unsupported: 2, source_changed: 1, invalid_citations: 2 }
        });
      } finally {
        reopened.close();
      }

      // 用独立连接把 audit_summary 改坏，再插一条迁移前风格的老消息（audit_summary NULL）。
      const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
      let legacyId = 0;
      try {
        raw
          .prepare('UPDATE messages SET audit_summary = ? WHERE id = ?')
          .run('{broken json', assistant.id);
        const inserted = raw
          .prepare(
            "INSERT INTO messages(document_id, role, content, sources, metadata, session_id) VALUES (?, 'user', ?, '[]', '{}', ?)"
          )
          .run(documentId, '老消息（没有审计摘要）', sessionId);
        legacyId = Number(inserted.lastInsertRowid);
      } finally {
        raw.close();
      }
      expect(legacyId).toBeGreaterThan(0);

      // 重新读取：坏 JSON 的 assistant 消息与 NULL 老消息都不影响整条历史。
      reopened = new Store(dir);
      try {
        const rows = reopened.listMessages(documentId, { sessionId });
        const broken = rows.find((row) => row.id === assistant.id)!;
        expect(broken.content).toBe('单篇回答正文。');
        expect(broken.auditSummary).toBeUndefined();
        const legacy = rows.find((row) => row.content === '老消息（没有审计摘要）')!;
        expect(legacy.auditSummary).toBeUndefined();
        expect(legacy.scopeKind).toBe('document');
        expect(rows).toHaveLength(2);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('历史接口把 audit_summary 挂在消息记录上（单篇 GET 与跨篇 GET）', async () => {
    const { dir, store, documentId } = await setupDocument('routes');
    const token = 'message-audit-token';
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    const headers = { 'x-studianda-token': token };
    try {
      // 单篇：POST 落一条带完整响应的 assistant 消息，GET 回读摘要。
      const posted = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages`,
        headers,
        payload: {
          role: 'assistant',
          content: '接口回答正文。',
          metadata: {
            sessionId: 'http-session',
            response: {
              answer: '接口回答正文。',
              sources: [],
              invalid_citations: [7],
              audit: {
                status: '已进行模型证据支持复核',
                claims: [
                  { claim: 1, verdict: 'supported' },
                  { claim: 2, verdict: 'unsupported' }
                ]
              }
            }
          }
        }
      });
      expect(posted.statusCode).toBe(200);
      expect(posted.json()).toMatchObject({
        scopeKind: 'document',
        auditSummary: { claims: 2, unsupported: 1, source_changed: 0, invalid_citations: 1 }
      });

      const documentHistory = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages?sessionId=http-session`,
        headers
      });
      expect(documentHistory.statusCode).toBe(200);
      const documentRows = documentHistory.json() as ChatMessageRecord[];
      expect(documentRows).toHaveLength(1);
      expect(documentRows[0]).toMatchObject({
        content: '接口回答正文。',
        scopeKind: 'document',
        auditSummary: { claims: 2, unsupported: 1, source_changed: 0, invalid_citations: 1 }
      });

      // 跨篇：建会话 + 直接落一条带摘要的 assistant 消息，GET 回读。
      const created = await server.inject({
        method: 'POST',
        url: '/api/v1/corpus-sessions',
        headers,
        payload: { documentIds: [documentId], title: '接口跨篇会话' }
      });
      expect(created.statusCode).toBe(200);
      const sessionId = (created.json() as { session: { id: string } }).session.id;
      store.addCorpusSessionMessage({
        sessionId,
        role: 'assistant',
        content: '跨篇接口回答。',
        auditSummary: SUMMARY
      });
      const corpusHistory = await server.inject({
        method: 'GET',
        url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/messages`,
        headers
      });
      expect(corpusHistory.statusCode).toBe(200);
      const corpusRows = corpusHistory.json() as ChatMessageRecord[];
      expect(corpusRows).toHaveLength(1);
      expect(corpusRows[0]).toMatchObject({
        content: '跨篇接口回答。',
        scopeKind: 'corpus',
        auditSummary: SUMMARY
      });
    } finally {
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('单篇 POST：没有 metadata.response 时从可见审计字段压摘要；完全没有审计信息时显式 NULL', async () => {
    const { dir, store, documentId } = await setupDocument('post-fields');
    const token = 'message-audit-fields-token';
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    const headers = { 'x-studianda-token': token };
    let plainId = 0;
    try {
      // 1) 只带可见审计字段（audit.claims / invalid_citations / selection_snapshot），
      //    没有完整 metadata.response：仍要压出摘要，不能只存正文。
      const visible = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages`,
        headers,
        payload: {
          role: 'assistant',
          content: '只带可见审计字段的回答。',
          sources: [],
          metadata: {
            sessionId: 'visible-fields',
            audit: {
              status: '已进行模型证据支持复核',
              claims: [
                { claim: 1, verdict: 'supported', claim_type: 'DOCUMENT_INTERPRETATION' },
                {
                  claim: 2,
                  verdict: 'unsupported',
                  claim_type: 'HISTORICAL_FACT',
                  evidence_status: 'source_changed'
                },
                { claim: 3, verdict: 'inference' }
              ]
            },
            invalid_citations: [2, 5, 7],
            selection_snapshot: { status: 'source_changed' }
          }
        }
      });
      expect(visible.statusCode).toBe(200);
      expect(visible.json()).toMatchObject({
        scopeKind: 'document',
        auditSummary: {
          claims: 3,
          supported: 1,
          inference: 1,
          unsupported: 1,
          heading: 0,
          source_changed: 1,
          invalid_citations: 3,
          selection_snapshot_status: 'source_changed'
        }
      });

      // 2) 只有顶层 claims 数组（没有 audit 包装、也没有完整响应）同样接受。
      const claimsOnly = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages`,
        headers,
        payload: {
          role: 'assistant',
          content: '只带 claims 数组的回答。',
          metadata: {
            sessionId: 'claims-only',
            claims: [
              { claim: 1, verdict: 'unsupported', claim_type: 'HISTORICAL_FACT' },
              { claim: 2, verdict: 'unsupported' }
            ]
          }
        }
      });
      expect(claimsOnly.statusCode).toBe(200);
      expect(claimsOnly.json()).toMatchObject({
        auditSummary: { claims: 2, supported: 0, unsupported: 2, source_changed: 0 }
      });

      // 3) 请求里确实没有任何审计信息（连 metadata 都不传）：消息照常落库，
      //    审计列显式写 NULL——不伪造计数。
      const plain = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages`,
        headers,
        payload: { role: 'assistant', content: '没有审计信息的回答。' }
      });
      expect(plain.statusCode).toBe(200);
      const plainRow = plain.json() as ChatMessageRecord;
      plainId = plainRow.id;
      expect(plainRow.auditSummary).toBeUndefined();

      // 回读历史：能压出摘要的两条可恢复，无审计的那条没有摘要（且不影响其它消息）。
      const history = await server.inject({
        method: 'GET',
        url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages`,
        headers
      });
      expect(history.statusCode).toBe(200);
      const rows = history.json() as ChatMessageRecord[];
      expect(rows.find((row) => row.content === '只带可见审计字段的回答。')?.auditSummary).toMatchObject(
        { claims: 3, unsupported: 1, source_changed: 1, invalid_citations: 3 }
      );
      expect(rows.find((row) => row.content === '只带 claims 数组的回答。')?.auditSummary).toMatchObject(
        { claims: 2, unsupported: 2 }
      );
      expect(rows.find((row) => row.id === plainId)?.auditSummary).toBeUndefined();
    } finally {
      await server.close();
      store.close();
    }
    // 「显式存 NULL」在库层核实：列值就是 NULL，不是空串或 '{}'（关库后用独立连接查看）。
    try {
      const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
      try {
        const row = raw
          .prepare('SELECT audit_summary FROM messages WHERE id = ?')
          .get(plainId) as { audit_summary: string | null };
        expect(row.audit_summary).toBeNull();
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
