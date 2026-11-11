import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * schema 14 → 15 迁移：
 * - settings 里的 `doc-chat.sessions.<docId>` 清单迁移到 document_chat_sessions 表；
 * - messages.metadata.sessionId 回填到 messages.session_id 列；
 * - 旧消息仍归入 legacy，不丢消息。
 */
describe('阅读会话 schema 15 迁移', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-schema15-'));
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('从 settings JSON 与 metadata.sessionId 迁移到表/列', async () => {
    let documentId = '';
    const first = new Store(dataDir);
    try {
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 300]);
      const file = path.join(dataDir, 'migrate.pdf');
      writeFileSync(file, await pdf.save());
      documentId = (await first.importDocument(file, undefined, true)).id;
      // 写一条旧消息（模拟 14 的写入：metadata 带 sessionId，列默认 legacy）。
      const message = first.addMessage({
        documentId,
        role: 'user',
        content: '旧版阅读消息',
        metadata: { sessionId: 'session-a' }
      });
      expect(message.id).toBeGreaterThan(0);
    } finally {
      first.close();
    }

    // 模拟 schema 14：版本号回退 + settings JSON 清单 + 消息列回退到 legacy。
    const raw = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
    raw.exec("UPDATE schema_meta SET value = '14' WHERE key = 'schema_version'");
    raw.exec("UPDATE messages SET session_id = 'legacy'");
    raw.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(
      `doc-chat.sessions.${documentId}`,
      JSON.stringify([
        {
          id: 'legacy',
          title: '默认对话',
          created: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'session-a',
          title: '旧会话 A',
          created: '2026-01-02T00:00:00.000Z',
          updated: '2026-01-02T00:00:00.000Z',
          contextSummary: '旧摘要',
          summaryUpto: 3
        }
      ])
    );
    raw.close();

    const reopened = new Store(dataDir);
    try {
      const sessions = reopened.listDocumentChatSessions(documentId);
      expect(sessions.map((session) => session.id).sort()).toEqual(['legacy', 'session-a']);
      expect(sessions.find((session) => session.id === 'session-a')).toMatchObject({
        title: '旧会话 A',
        contextSummary: '旧摘要',
        summaryUpto: 3
      });
      // 旧消息按 metadata 回填到 session_id 列，能按会话查到；不丢消息。
      expect(reopened.listMessages(documentId, { sessionId: 'session-a' })).toHaveLength(1);
      expect(reopened.getSettings()[`doc-chat.sessions.${documentId}`]).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});
