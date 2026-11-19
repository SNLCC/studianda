import type { DocumentChatSessionRecord } from '@studianda/shared';
import type { Store } from './store.js';

/**
 * 阅读伙伴会话清单：schema 15 起正式存在 `document_chat_sessions` 表（按文献隔离）。
 *
 * 之前版本把清单存在 settings JSON（键 `doc-chat.sessions.<documentId>`），升级时由 Store
 * 迁移到表；这里只保留 normalize 与薄封装，供 server / 摘要压缩共用。
 */

/** 校验并规整会话清单（外部输入不能直接信任）。 */
export function normalizeDocumentChatSessions(
  raw: readonly unknown[]
): DocumentChatSessionRecord[] {
  const seen = new Set<string>();
  const result: DocumentChatSessionRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim().slice(0, 80) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const now = new Date().toISOString();
    const summary =
      typeof row.contextSummary === 'string' ? row.contextSummary.trim().slice(0, 8000) : '';
    const summaryUpto =
      typeof row.summaryUpto === 'number' &&
      Number.isInteger(row.summaryUpto) &&
      row.summaryUpto >= 0
        ? row.summaryUpto
        : 0;
    result.push({
      id,
      title: typeof row.title === 'string' ? row.title.trim().slice(0, 120) : '',
      created: typeof row.created === 'string' ? row.created : now,
      updated: typeof row.updated === 'string' ? row.updated : now,
      ...(summary ? { contextSummary: summary, summaryUpto } : {})
    });
    if (result.length >= 200) break;
  }
  return result;
}

/** 读某文献的会话清单（按 updated 倒序）。 */
export function readDocumentChatSessions(
  store: Store,
  documentId: string
): DocumentChatSessionRecord[] {
  return store.listDocumentChatSessions(documentId);
}

/** 保存某文献的会话清单；逐行 upsert，不删除调用方未带上的其它会话。 */
export function writeDocumentChatSessions(
  store: Store,
  documentId: string,
  sessions: DocumentChatSessionRecord[]
): DocumentChatSessionRecord[] {
  return store.saveDocumentChatSessions(documentId, sessions);
}

/**
 * 会话摘要失效：编辑/删除了某条被摘要覆盖过的消息后，把该会话的 `contextSummary`
 * 清空、`summaryUpto` 归 0（只清 `summaryUpto >= messageId` 的会话，不是无脑清）。
 * 只在真的变了才写库（`changed`）；`sessionId` 为空时直接返回（旧调用不失效摘要）。
 *
 * **调用方必须已持有该文献的轮次锁**（`ChatTurnRegistry`，key=`doc:<id>`）：这里是无 CAS
 * 的整行读改写，而摘要压缩在 `reading-session-context.ts` 走 CAS 写回；脱离锁调用会与
 * 压缩交错（要么摘要复活覆盖已编辑内容，要么把压缩结果写回已变化的会话）。
 */
export function clearSummaryCoveringMessage(
  store: Store,
  documentId: string,
  sessionId: string,
  messageId: number
): void {
  if (!sessionId) return;
  const sessions = readDocumentChatSessions(store, documentId);
  let changed = false;
  const updated = sessions.map((session) => {
    if (
      session.id === sessionId &&
      typeof session.summaryUpto === 'number' &&
      session.summaryUpto >= messageId
    ) {
      changed = true;
      return { ...session, contextSummary: undefined, summaryUpto: 0 };
    }
    return session;
  });
  if (changed) writeDocumentChatSessions(store, documentId, updated);
}
