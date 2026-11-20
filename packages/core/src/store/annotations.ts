import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AnnotationRecord,
  CreateAnnotationInput,
  NotePurgeResult,
  UpdateAnnotationInput
} from '@studianda/shared';
// origin 口径只有一份：批注行映射与创建共用笔记域导出的 normalizeContentOrigin，
// 不在这里复制第二份映射（notes.ts 已注明批注域复用该导出）。
import { normalizeContentOrigin } from './notes.js';
import { beginTransaction } from './transactions.js';

/**
 * 批注域（annotations 表 + note_asset_refs 中 source_kind='annotation' 的引用）。
 *
 * 从 store.ts 拆出的第四个域（前三个：store/projects.ts、store/note-assets.ts、
 * store/notes.ts）。承载批注的全部数据访问：按文献列列表/回收站、外部稳定键
 * （Zotero 导入去重与坐标升级）、页面几何更新、创建/更新/软删除/恢复/彻底删除。
 *
 * 拆分约定（与前三个域一致）：
 * - 纯函数 + 显式依赖注入：第一个参数是 SQLite 句柄 `db`，需要非 DB 依赖的函数再收
 *   `deps`；绝不接收 `Store` 实例，也绝不反向 import store.ts。
 * - 私有辅助（行映射 toAnnotation、行形状、SQL）随域一起搬进来，不反向引用
 *   store.ts 的私有成员。内容来源（origin）映射复用 notes.ts 的 normalizeContentOrigin，
 *   不复制第二份。
 * - Store 上的同名方法只剩一层薄委托，调用方与返回结构不变。
 * - 依赖方向固定为 annotations →（deps 回调）。本模块**不 import store/note-assets.ts**，
 *   资源引用同步 / 计数刷新 / 独占文件回收（以及引用图缓存失效）都由 Store 注入
 *   `AnnotationDomainDeps` 回调，因此不会出现 note-assets → annotations 的反向依赖。
 *
 * **事务不变量（改这里之前先读）：**
 * - 只读函数**自己不开事务**，既可直接调用，也可在调用方已打开的事务里执行：
 *   listAnnotations / getAnnotation / annotationExternalKeys / annotationExternalIndex。
 * - 单条写语句的函数同样**不开事务**：setAnnotationGeometry（UPDATE）、
 *   deleteAnnotation（UPDATE deleted=1）、restoreAnnotation（SELECT + UPDATE）。
 *   引用图缓存失效由调用方注入的 deps 回调完成，必须在写语句之后调用。
 * - createAnnotation / updateAnnotation 跨 annotations 与 note_asset_refs，**自己管理事务**
 *   （BEGIN IMMEDIATE / COMMIT / ROLLBACK），调用方不得再包一层。事务内顺序固定：
 *   写 annotations 行 → deps.syncNoteAssetRefs（它自己不 BEGIN，必须在**同一事务、同名
 *   db 连接**里执行，见 store/note-assets.ts 的 syncSource 约定）→ COMMIT。
 *   **引用图缓存失效必须在 COMMIT 之后**调用 deps.invalidateReferenceGraphCache，
 *   绝不放进事务。
 * - purgeAnnotation 同理：一个事务内先删 note_asset_refs 再删 annotations 行，
 *   COMMIT 之后才经 deps 让 note-assets 重算计数、回收独占文件（**先提交再删文件**，
 *   文件失败不回滚数据库），最后失效引用图缓存。
 * - 创建时的 rects 校验发生在 BEGIN 之前，错误文案与时机与拆分前一致。
 */

/** 批注域真正需要的非 DB 依赖；由 Store（或直接调用本模块的测试）显式传入。 */
export interface AnnotationDomainDeps {
  /** 当前时间（ISO 文本），用于 annotations.created。默认与 Store 原来的 `new Date().toISOString()` 一致。 */
  now: () => string;
  /**
   * 同步一条批注的资源引用（note_asset_refs）。
   *
   * 由 Store 注入（实际实现是 note-assets 域的 syncSource）。**必须在调用方已打开的
   * 事务里、用同一个 db 连接执行**，它自己绝不 BEGIN/COMMIT：内容写入与 refs 同步
   * 必须同成同败（见 store/note-assets.ts 的事务不变量）。
   */
  syncNoteAssetRefs: (
    sourceKind: 'note' | 'annotation',
    sourceId: string,
    content: string
  ) => void;
  /** 彻底删除批注后重算资源引用计数（note-assets 域注入）。 */
  refreshAssetCounts: (assetIds: string[]) => void;
  /** 彻底删除批注后回收其独占图片资源（note-assets 域注入）。 */
  purgeAssetRecords: (assetIds: string[]) => NotePurgeResult;
  /** 批注写操作**提交后**失效引用图缓存（缓存仍由 Store 持有，用回调注入避免反向依赖）。 */
  invalidateReferenceGraphCache: () => void;
}

/** annotations 表读取用的原始行形状（创建后回读、单条读取共用）。 */
interface AnnotationRow {
  id: string;
  document_id: string;
  page: number;
  quote: string;
  content: string;
  rects: string;
  color: string;
  style: string;
  created: string;
  deleted: number;
  origin?: string | null;
  agent_name?: string | null;
}

// ---------------------------------------------------------------------------
// 映射辅助（纯函数）
// ---------------------------------------------------------------------------

/**
 * 批注行 → AnnotationRecord。
 *
 * origin 复用笔记域的 normalizeContentOrigin：只认 `'ai'`，其余（含迁移前没有 origin
 * 列的老数据）一律 `'user'`，保证 notes / annotations 两个域的口径只有一份。
 */
function toAnnotation(row: AnnotationRow): AnnotationRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    page: row.page,
    quote: row.quote ?? '',
    content: row.content ?? '',
    rects: row.rects ?? '',
    color: row.color ?? 'yellow',
    style: row.style ?? 'highlight',
    created: row.created ?? '',
    origin: normalizeContentOrigin(row.origin),
    agentName: row.agent_name || undefined
  };
}

// ---------------------------------------------------------------------------
// list / 外部稳定键 / 页面几何（读路径与单条 UPDATE，都不开事务）
// ---------------------------------------------------------------------------

/** 这篇文献里已写入过外部标识的批注 key（例如 Zotero annotation item key）。 */
export function annotationExternalKeys(db: DatabaseSync, documentId: string): Set<string> {
  const rows = db
    .prepare("SELECT external_key FROM annotations WHERE document_id = ? AND external_key <> ''")
    .all(documentId) as unknown as Array<{ external_key?: string }>;
  return new Set(rows.map((row) => String(row.external_key ?? '')));
}

/**
 * 按 external_key 索引这篇文献的批注（含已软删除的，保持"删除后不会重复导入"的既有语义），
 * 用于 Zotero 坐标升级：判断已导入的批注是否只有页级位置，并拿到它的 id 更新几何。
 * 不把 external_key 暴露进 AnnotationRecord（保持既有 API 形状）。
 */
export function annotationExternalIndex(
  db: DatabaseSync,
  documentId: string
): Map<string, { id: string; rects: string; style: string; deleted: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, external_key, rects, style, deleted FROM annotations
       WHERE document_id = ? AND external_key <> ''`
    )
    .all(documentId) as unknown as Array<{
    id: string;
    external_key: string;
    rects: string | null;
    style: string | null;
    deleted: number | null;
  }>;
  const index = new Map<string, { id: string; rects: string; style: string; deleted: boolean }>();
  for (const row of rows) {
    const key = String(row.external_key ?? '');
    if (!key || index.has(key)) continue;
    index.set(key, {
      id: row.id,
      rects: row.rects ?? '',
      style: row.style ?? 'highlight',
      deleted: Number(row.deleted ?? 0) === 1
    });
  }
  return index;
}

/**
 * 只更新批注的页面几何（rects / style），保留用户改过的 content / color。
 * 用于把旧版 Zotero 页级批注升级为按坐标的高亮/下划线。单条 UPDATE，不开事务。
 */
export function setAnnotationGeometry(
  db: DatabaseSync,
  id: string,
  input: { rects: string; style: string }
): void {
  const result = db
    .prepare('UPDATE annotations SET rects = ?, style = ? WHERE id = ? AND deleted = 0')
    .run(input.rects, input.style, id);
  if (result.changes === 0) throw new Error('批注不存在');
}

/**
 * 按文献列出批注（默认不含回收站，trash=true 只列回收站里的）。
 * 排序与拆分前一致：page、created 升序。只读，不开事务。
 */
export function listAnnotations(
  db: DatabaseSync,
  documentId: string,
  trash = false
): AnnotationRecord[] {
  const rows = db
    .prepare(
      `SELECT id, document_id, page, quote, content, rects, color, style, created, deleted, origin, agent_name
       FROM annotations WHERE document_id = ? AND deleted = ? ORDER BY page, created`
    )
    .all(documentId, trash ? 1 : 0) as unknown as AnnotationRow[];
  return rows.map(toAnnotation);
}

/** 单条未删除批注；不存在或已删除返回 null。只读，不开事务。 */
export function getAnnotation(db: DatabaseSync, id: string): AnnotationRecord | null {
  const row = db
    .prepare(
      `SELECT id, document_id, page, quote, content, rects, color, style, created, deleted, origin, agent_name
       FROM annotations WHERE id = ? AND deleted = 0`
    )
    .get(id) as unknown as AnnotationRow | undefined;
  return row ? toAnnotation(row) : null;
}

// ---------------------------------------------------------------------------
// write：创建 / 更新（内容与资源引用同成同败）
// ---------------------------------------------------------------------------

/**
 * 创建批注。
 *
 * 事务与顺序（与拆分前的 Store.createAnnotation 逐字一致）：
 * 1. 事务之前：rects 若是 JSON 必须是 0..1 内、左上/右下有序的矩形数组（否则「批注位置无效」）；
 *    origin 归一到 `'ai' | 'user'`。
 * 2. BEGIN IMMEDIATE 内：INSERT annotations → deps.syncNoteAssetRefs（note_asset_refs），
 *    任一步失败 ROLLBACK，内容与 refs 同成同败。
 * 3. COMMIT 之后才回读记录（保证 origin/默认值口径与落库一致），再
 *    deps.invalidateReferenceGraphCache。
 */
export function createAnnotation(
  db: DatabaseSync,
  deps: AnnotationDomainDeps,
  input: CreateAnnotationInput
): AnnotationRecord {
  if (input.rects) {
    let rects: unknown;
    try {
      rects = JSON.parse(input.rects);
    } catch {
      throw new Error('批注位置无效');
    }
    if (
      !Array.isArray(rects) ||
      !rects.every((rect) => {
        if (!Array.isArray(rect) || rect.length !== 4) return false;
        const values = rect as number[];
        return (
          values.every((value) => typeof value === 'number' && value >= 0 && value <= 1) &&
          values[0]! < values[2]! &&
          values[1]! < values[3]!
        );
      })
    ) {
      throw new Error('批注位置无效');
    }
  }
  const id = randomUUID();
  // 内容来源：AI 译文/识别结果由系统写入批注时显式传 'ai'；用户手工新建为 'user'。
  // 与 toAnnotation 共用同一个 normalizeContentOrigin 导出，不复制第二份映射。
  const origin = normalizeContentOrigin(input.origin);
  const agentName = String(input.agentName ?? '').trim().slice(0, 80);
  const transaction = beginTransaction(db);
  try {
    db.prepare(
      `INSERT INTO annotations
       (id, document_id, page, quote, content, rects, color, style, deleted, external_key, created, origin, agent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(
      id,
      input.documentId,
      Math.max(1, Math.trunc(input.page)),
      input.quote ?? '',
      input.content ?? '',
      input.rects ?? '',
      input.color ?? 'yellow',
      input.style ?? 'highlight',
      input.externalKey ?? '',
      deps.now(),
      origin,
      agentName
    );
    deps.syncNoteAssetRefs('annotation', id, input.content ?? '');
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
  const row = db
    .prepare(
      `SELECT id, document_id, page, quote, content, rects, color, style, created, deleted, origin, agent_name
       FROM annotations WHERE id = ?`
    )
    .get(id) as unknown as AnnotationRow;
  const annotation = toAnnotation(row);
  deps.invalidateReferenceGraphCache();
  return annotation;
}

/**
 * 更新批注（正文/颜色/样式）。
 *
 * 事务与顺序（与拆分前的 Store.updateAnnotation 逐字一致）：
 * 1. 只构造传了值的字段；三个字段都没传时直接返回当前记录（不写库、不失效缓存）。
 * 2. BEGIN IMMEDIATE 内：UPDATE annotations → 回读 content（记录不存在/已删除则不建 refs）
 *    → deps.syncNoteAssetRefs，失败整体 ROLLBACK。
 * 3. COMMIT 之后读回记录并 deps.invalidateReferenceGraphCache。
 */
export function updateAnnotation(
  db: DatabaseSync,
  deps: AnnotationDomainDeps,
  id: string,
  input: UpdateAnnotationInput
): AnnotationRecord | null {
  const fields: string[] = [];
  const values: Array<string | number> = [];
  if (input.content != null) {
    fields.push('content = ?');
    values.push(input.content);
  }
  if (input.color != null) {
    fields.push('color = ?');
    values.push(input.color);
  }
  if (input.style != null) {
    fields.push('style = ?');
    values.push(input.style);
  }
  if (fields.length === 0) return getAnnotation(db, id);
  values.push(id);
  const transaction = beginTransaction(db);
  try {
    db.prepare(`UPDATE annotations SET ${fields.join(', ')} WHERE id = ? AND deleted = 0`).run(
      ...values
    );
    const current = db
      .prepare('SELECT content FROM annotations WHERE id = ? AND deleted = 0')
      .get(id) as { content?: string | null } | undefined;
    if (current) deps.syncNoteAssetRefs('annotation', id, current.content ?? '');
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
  const annotation = getAnnotation(db, id);
  deps.invalidateReferenceGraphCache();
  return annotation;
}

// ---------------------------------------------------------------------------
// trash：回收站（软删除/恢复）+ 彻底删除
// ---------------------------------------------------------------------------

/** 软删除（移入回收站）：单条 UPDATE，不开事务；不存在也不报错（与拆分前一致）。 */
export function deleteAnnotation(db: DatabaseSync, deps: AnnotationDomainDeps, id: string): void {
  db.prepare('UPDATE annotations SET deleted = 1 WHERE id = ?').run(id);
  deps.invalidateReferenceGraphCache();
}

/**
 * 从回收站恢复软删除的批注；refs 在软删除期间保留，恢复后无需重建。
 * SELECT + UPDATE 两条语句，不开事务（与拆分前一致）。
 */
export function restoreAnnotation(db: DatabaseSync, deps: AnnotationDomainDeps, id: string): void {
  const row = db
    .prepare('SELECT id, deleted FROM annotations WHERE id = ?')
    .get(id) as { id?: string; deleted?: number } | undefined;
  if (!row?.id) throw new Error('批注不存在');
  if (Number(row.deleted ?? 0) !== 1) throw new Error('批注不在回收站');
  db.prepare('UPDATE annotations SET deleted = 0 WHERE id = ?').run(id);
  deps.invalidateReferenceGraphCache();
}

/**
 * 彻底删除批注（含回收站里的）+ 回收其独占图片资源；不存在的批注返回 404 语义。
 * annotations 只有软删除，这里才是真正的硬删除。
 *
 * 事务边界：annotations 行与 note_asset_refs 同成同败（一个事务）；**COMMIT 之后**
 * 才经 deps 让 note-assets 重算计数、回收独占文件（先提交再删文件，文件失败不回滚
 * 数据库），最后失效引用图缓存。
 */
export function purgeAnnotation(
  db: DatabaseSync,
  deps: AnnotationDomainDeps,
  id: string
): NotePurgeResult {
  const row = db.prepare('SELECT id FROM annotations WHERE id = ?').get(id) as
    | { id?: string }
    | undefined;
  if (!row?.id) throw new Error('批注不存在');
  const affected = (
    db
      .prepare('SELECT asset_id FROM note_asset_refs WHERE source_kind = ? AND source_id = ?')
      .all('annotation', id) as unknown as Array<{ asset_id: string }>
  ).map((ref) => ref.asset_id);
  const transaction = beginTransaction(db);
  try {
    db.prepare('DELETE FROM note_asset_refs WHERE source_kind = ? AND source_id = ?').run(
      'annotation',
      id
    );
    db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
  deps.refreshAssetCounts(affected);
  const purged = deps.purgeAssetRecords(affected);
  deps.invalidateReferenceGraphCache();
  return purged;
}
