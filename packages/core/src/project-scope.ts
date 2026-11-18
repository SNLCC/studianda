import type { Store } from './store.js';

/**
 * 把「逻辑项目」解析成**当前**可用于检索/阅读的文献 id 集合。
 *
 * 只复用项目已有的读取口径 `listProjectDocuments()`：它按 `project_documents` 链接
 * 关联 `documents` 且 `d.deleted = 0`（回收站里的文献不算），顺序是加入时间倒序。
 * 这里**不新增任何 SQL**，也不缓存：项目当前范围随「加/移文献、文献进回收站」实时变化，
 * 检索与精读每次请求都按解析结果走原有逻辑。
 *
 * 返回值必须区分两种「空」：
 * - `null`：项目不存在（调用方回 404）；
 * - `[]`：项目存在但当前没有文献（调用方按各自的空范围语义处理：检索返回空结果 + 标记，
 *   精读/建会话回 400，不静默扩大到全库）。
 */
export function resolveProjectScope(store: Store, projectId: string): string[] | null {
  if (!store.getProject(projectId)) return null;
  return store.listProjectDocuments(projectId).map((document) => document.id);
}
