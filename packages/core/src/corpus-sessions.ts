import type {
  CorpusSessionRecord,
  CorpusSessionSummary,
  CorpusSessionDocumentSummary
} from '@studianda/shared';
import type { Store } from './store.js';

/**
 * 跨文献（语料）会话：范围是建立时的文献 id 快照。
 *
 * 这里只放「外部输入规整」与「快照 → HTTP 视图」两个纯逻辑；持久化在 Store 的
 * corpus_* 方法，路由在 server/corpus-session-routes.ts。
 */

/** 单会话范围内的文献数上限：防止一次请求把整库当范围塞进快照。 */
export const CORPUS_SESSION_MAX_DOCUMENTS = 200;
/** 文献 id 最大长度（内部 id 是 uuid，这里只防超长垃圾输入）。 */
const MAX_DOCUMENT_ID_LENGTH = 120;

/**
 * 规整建立会话时传入的 documentIds：只收字符串、去空白、去重、保序、限长限量。
 *
 * 不做存在性过滤：范围是用户的显式决定，已删除/暂时不可读的文献由读取侧跳过并报告
 * （建立响应里也会报告 skippedDocumentIds）。
 */
export function normalizeCorpusSessionDocumentIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim().slice(0, MAX_DOCUMENT_ID_LENGTH);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= CORPUS_SESSION_MAX_DOCUMENTS) break;
  }
  return ids;
}

/** 会话标题兜底：优先用户给的标题；没给时用范围内的第一篇文献名 + 篇数。 */
export function defaultCorpusSessionTitle(
  title: unknown,
  documents: readonly { name: string }[]
): string {
  if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 120);
  const first = documents[0]?.name?.trim() || '跨文献会话';
  return documents.length > 1 ? `${first} 等 ${documents.length} 篇` : first;
}

/**
 * 快照 → HTTP 视图：按**当前**库状态解析可读文献；已删除/不存在的 id 放进 skippedDocumentIds。
 *
 * 快照本身不因为文献删除而改写（`session.documentIds` 始终是建立时的清单）。
 * 来源项目字段（sourceProjectId/sourceProjectName）原样透传，**不做项目是否存在判断**：
 * 项目删除后 id 允许悬空，界面仍按 name 快照展示「来自项目 X」。
 */
export function corpusSessionView(
  store: Store,
  record: CorpusSessionRecord
): CorpusSessionSummary {
  const documents: CorpusSessionDocumentSummary[] = [];
  const skippedDocumentIds: string[] = [];
  for (const documentId of record.documentIds) {
    const document = store.getDocument(documentId);
    if (document) {
      documents.push({ id: document.id, name: document.name, pages: document.pages });
    } else {
      skippedDocumentIds.push(documentId);
    }
  }
  return { ...record, documents, skippedDocumentIds };
}

/**
 * 跳过文献的可读说明（用于追问响应 notice）：软删除的文献能查到名字，
 * 彻底删除/不存在的只能报 id；最多列 5 个，避免 notice 过长。
 */
export function skippedDocumentsNotice(store: Store, skippedDocumentIds: readonly string[]): string {
  if (skippedDocumentIds.length === 0) return '';
  const names = new Map(store.listDocuments(true).map((document) => [document.id, document.name]));
  const labels = skippedDocumentIds.slice(0, 5).map((id) => names.get(id) ?? id);
  return (
    `会话范围里有 ${skippedDocumentIds.length} 篇文献已删除或不存在，本轮已跳过：` +
    `${labels.join('、')}${skippedDocumentIds.length > labels.length ? ' 等' : ''}。`
  );
}
