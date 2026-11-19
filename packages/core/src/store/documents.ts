import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DocumentCategoryCounts,
  DocumentDetail,
  DocumentSummary,
  FileState,
  FolderOverview,
  FolderSummary
} from '@studianda/shared';
import { documentCategoryOf } from '@studianda/shared';
import { normalizeMetadataSource } from '../metadata-provenance.js';
import type { LayoutLine, LayoutPage } from '../pdf-layout.js';
import { visibleLines, type PageMask } from '../structure.js';

/**
 * 文献域（documents 表 + folders 分类 + page_edits 页文本 + page_masks 只读查询 +
 * 文献级检索版本读取）。
 *
 * 从 store.ts 拆出的第五个域（前四个：store/projects.ts、store/note-assets.ts、
 * store/notes.ts、store/annotations.ts），也是最大的一块。承载：
 * - 文献行映射与列表/详情读取（含文件状态）、分类文件夹 CRUD、默认排序拖拽；
 * - 文献改名/题录/标签/分类/阅读进度更新、回收站语义（移入/恢复；彻底删除与跨域级联
 *   仍在 store.ts 的 purgeDocument 里，不属于本域）；
 * - 页文本读写（page_edits：getPageText / getPageEdit / savePageTextEdit / cacheOcrPage）；
 * - 文献级派生状态读取：页遮罩查询（listPageMasks / pageMaskRevision）、检索版本号；
 * - 文献文件健康检查（missingDocumentFiles / documentHealth）。
 *
 * 拆分约定（与前四个域一致）：
 * - 纯函数 + 显式依赖注入：第一个参数是 SQLite 句柄 `db`，需要非 DB 依赖的函数再收
 *   `deps`；绝不接收 `Store` 实例，也绝不反向 import store.ts。
 * - 私有辅助（行映射、SQL、路径规范化、分类/文件夹校验、手动排序计算）随域一起搬进来，
 *   不反向引用 store.ts 的私有成员。
 * - Store 上的同名方法只剩一层薄委托，调用方与返回结构不变。
 * - 依赖方向固定为 documents →（deps 回调）。本模块不 import 其它域模块：
 *   - 引用图缓存失效（缓存仍由 Store 持有）由 deps.invalidateReferenceGraphCache 注入；
 *   - 页校订后的 chunks/FTS 重建属导入/索引流水线，由 deps.rebuildPageChunks 注入，
 *     版面解析（PDF 解析缓存）由 deps.readLayoutPage 注入。
 *
 * **事务不变量（改这里之前先读）：**
 * - 只读/单语句函数**自己不开事务**，既可直接调用（SQLite 自动提交），也可在调用方
 *   已打开的事务里执行：listDocuments / getDocument / getDocumentExternalKey /
 *   findZoteroDocumentId / listZoteroCollectionDocuments / getDocumentPath /
 *   documentTextState / chunkTextStats / findImportDuplicates / listFolders /
 *   listPageMasks / pageMaskRevision / getPageText / getPageEdit /
 *   getRetrievalRevision / getDocumentRetrievalRevision(s) / missingDocumentFiles /
 *   documentHealth / nextManualOrder。
 * - 单条写语句的函数同样**不开事务**：updateDocument（多条独立 UPDATE，各字段按原口径
 *   只更新非空项）、setDocumentTags、deleteDocument / restoreDocument（软删除语义）、
 *   setZoteroMissing / clearZoteroCollectionKey、createFolder / renameFolder、
 *   cacheOcrPage / savePageTextEdit（page_edits 单行 INSERT OR REPLACE）。
 *   引用图缓存失效由 deps 回调在写语句之后调用（updateDocument / deleteDocument /
 *   restoreDocument），与原实现时机一致。
 * - moveDocument 跨多条 UPDATE 且可能先全局重排，**自己管理事务**
 *   （BEGIN IMMEDIATE / COMMIT / ROLLBACK），调用方不得再包一层。
 * - deleteFolder 同步更新 documents.folder_id 与 folders 行，**自己管理事务**。
 * - backfillManualOrder 是迁移回填入口（多行 UPDATE），**必须运行在 migrate() 的事务里**，
 *   因此同样不自管事务。
 * - savePageTextEdit：先写 page_edits 行（提交即生效），再 await deps.readLayoutPage，
 *   等待期间库可能已被关闭——必须保留 `db.isOpen` 检查后才调 deps.rebuildPageChunks。
 *   chunks/FTS 重建在索引层自己开事务；本函数不包事务（与拆分前逐字一致）。
 * - getPageText 是精读热路径：只做已索引的单页查询与行重排，**不缓存、不加额外扫描**；
 *   OCR 页的 page_edits.boxes 合并（按当前 page_masks 过滤行框）逐字保留。
 */

/** 文献域真正需要的非 DB 依赖；由 Store（或直接调用本模块的测试）显式传入。 */
export interface DocumentDomainDeps {
  /** 数据目录：应用副本路径解析与列表里的文件状态（只读配置值）。 */
  dataDir: string;
  /** 文献写操作**提交后**失效引用图缓存（缓存仍由 Store 持有，用回调注入避免反向依赖）。 */
  invalidateReferenceGraphCache: () => void;
  /**
   * 读取某文献某页的版面（行框换算页面点坐标用）。
   *
   * 由 Store 注入（PDF 解析与进程内版面缓存属阅读/解析链路，不在本域）；
   * 解析失败按 null 处理，调用方与拆分前的 `.catch(() => null)` 口径一致。
   */
  readLayoutPage: (documentId: string, page: number) => Promise<LayoutPage | null>;
  /**
   * 用页文本重建该页 chunks（含 FTS 行号）。
   *
   * 由 Store 注入（分块/FTS 属导入/索引流水线，不在本域）。只在 page_edits 写入之后、
   * 且 `db.isOpen` 为真时调用；它自己管理事务，本函数不得再包一层。
   */
  rebuildPageChunks: (
    documentId: string,
    page: number,
    text: string,
    boxesJson: string,
    layoutPage: LayoutPage | null | undefined
  ) => void;
}

interface DocumentRow {
  id: string;
  name: string;
  pages: number;
  current_page: number;
  created: string;
  author: string;
  publication: string;
  doi: string;
  title_key: string;
  size_bytes: number;
  sha256: string;
  path: string;
  deleted: number;
  tags: string;
  storage_kind: string;
  file_stamp: string;
  external_path: string;
  external_key: string;
  doc_type: string;
  folder_id: string;
  manual_order: number;
  /** 题录来源；''（含迁移前老行）= 未知，读取接口返回 null。 */
  metadata_source: string;
  /** Zotero 顶层条目 key；'' = 不是 Zotero 来源（或迁移前的记录）。 */
  zotero_item_key: string;
  /** 最近一次同步的 Zotero collection key；'' = 未记录。 */
  zotero_collection_key: string;
  /** 1 = 最近同步确认已在 Zotero 侧删除（本地文献保留）。 */
  zotero_missing: number;
}

// ---------------------------------------------------------------------------
// 映射/规范化辅助（纯函数）
// ---------------------------------------------------------------------------

function fileStateOf(row: DocumentRow, dataDir: string): FileState {
  const kind = row.storage_kind || 'copy';
  const filePath =
    kind === 'zotero' && row.external_path
      ? row.external_path
      : row.path
        ? path.resolve(dataDir, row.path)
        : path.join(dataDir, `${row.id}.pdf`);
  if (!existsSync(filePath)) {
    return {
      state: 'missing',
      detail:
        kind === 'zotero'
          ? 'Zotero 本机附件不可用；文献索引、批注与笔记仍在。请重新连接。'
          : '应用内 PDF 副本不存在；文献列表、批注与笔记仍在，阅读与检索需要重新连接 PDF。',
      storageKind: kind
    };
  }
  // 存在但不可读（被占用/权限不足）不能算"可用"，否则阅读时才报错。
  try {
    accessSync(filePath, constants.R_OK);
  } catch {
    return {
      state: 'unknown',
      detail: '文件存在但无法读取（可能被其他程序占用或权限不足）；请关闭占用程序或检查权限。',
      storageKind: kind
    };
  }
  if (kind === 'zotero' && row.file_stamp) {
    try {
      const stats = statSync(filePath);
      const current = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
      if (current !== row.file_stamp) {
        return {
          state: 'changed',
          detail:
            'Zotero 本机附件已改变（大小或修改时间变化），索引可能已过期；请重新连接后再阅读。',
          storageKind: kind
        };
      }
    } catch {
      return {
        state: 'unknown',
        detail: '无法读取附件信息（权限或占用）；请检查后重试。',
        storageKind: kind
      };
    }
  }
  return {
    state: 'ok',
    detail: kind === 'zotero' ? 'Zotero 本机附件可用。' : '应用内 PDF 副本可用。',
    storageKind: kind
  };
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) {
      return parsed;
    }
  } catch {
    // 损坏的标签按空处理
  }
  return [];
}

function toSummary(row: DocumentRow, dataDir: string): DocumentSummary {
  const fileState = fileStateOf(row, dataDir);
  const docType = row.doc_type ?? '';
  return {
    id: row.id,
    name: row.name,
    pages: row.pages,
    currentPage: row.current_page,
    created: row.created,
    author: row.author ?? '',
    publication: row.publication ?? '',
    sizeBytes: row.size_bytes ?? 0,
    tags: parseTags(row.tags),
    deleted: Boolean(row.deleted),
    fileState,
    // 列表接口直接带缺失标记，前端卡片不必再自己 stat。
    missing_file: fileState.state === 'missing',
    // 文献类型与文件夹始终由服务端算好带回，界面不需要重复映射。
    docType,
    docCategory: documentCategoryOf(docType),
    folderId: row.folder_id ?? '',
    // 默认排序位置：越小越靠前；只由拖拽（moveDocument）改变。
    manualOrder: Number(row.manual_order ?? 0),
    // 题录来源：未知（老库/手工构造）明确返回 null，不猜来源。
    metadataSource: normalizeMetadataSource(row.metadata_source),
    // Zotero 侧删除标记：只提示，不删除本地文献。
    zoteroMissing: Number(row.zotero_missing ?? 0) === 1
  };
}

function toDetail(row: DocumentRow, dataDir: string): DocumentDetail {
  return { ...toSummary(row, dataDir), sha256: row.sha256 ?? '' };
}

/** 只用于查重：去掉大小写、空白、标点和扩展名，不做展示。 */
export function normalizeKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 240);
}

function firstAuthorKey(value: string): string {
  return normalizeKey(value.split(/[、,，;；]/)[0] ?? '');
}

/** 文献查重候选（导入管线用；匹配优先级也由这里定义）。 */
export interface ImportDuplicateCandidate {
  id: string;
  name: string;
  pages: number;
  author: string;
  publication: string;
  doi: string;
  match: 'file' | 'doi' | 'title' | 'zotero';
  reasons: string[];
}

/**
 * Zotero 本机附件被外部替换/修改（大小或 mtime 变化）。
 *
 * 索引、批注、引用位置都来自旧文件，继续按新文件读会让页码/坐标对不上，
 * 因此访问路径时直接拒绝，要求重新连接。
 */
export class AttachmentChangedError extends Error {
  constructor() {
    super('Zotero 附件已改变，索引可能已过期；请重新连接这份文献后再试。');
    this.name = 'AttachmentChangedError';
  }
}

// ---------------------------------------------------------------------------
// 默认排序位置（documents.manual_order）：迁移回填 / 新增文献取号 / 拖拽重排
// ---------------------------------------------------------------------------

/**
 * 回填默认排序：仅在"有文献但所有 manual_order 都是 0"时执行（刚加列或半迁移）。
 *
 * 顺序取当前列表展示顺序 `created DESC, rowid DESC`，赋 1..N，
 * 保证升级瞬间用户看到的默认顺序不变；已迁移的库不会重复回填。
 *
 * 无事务边界：必须运行在 migrate() 的事务里（与原来一致）。
 */
export function backfillManualOrder(db: DatabaseSync): void {
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n?: number } | undefined)?.n ?? 0
  );
  if (total === 0) return;
  const nonZero = Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM documents WHERE manual_order <> 0')
        .get() as { n?: number } | undefined
    )?.n ?? 0
  );
  if (nonZero > 0) return;
  const rows = db
    .prepare('SELECT id FROM documents ORDER BY created DESC, rowid DESC')
    .all() as unknown as Array<{ id: string }>;
  const update = db.prepare('UPDATE documents SET manual_order = ? WHERE id = ?');
  rows.forEach((row, index) => update.run(index + 1, row.id));
}

/** 新文献的默认排序位置：追加到末尾（空库从 1 开始）；回收站里的也计入，避免恢复后撞位。 */
export function nextManualOrder(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(manual_order), 0) + 1 AS value FROM documents')
    .get() as { value?: number } | undefined;
  return Number(row?.value ?? 1);
}

// ---------------------------------------------------------------------------
// 文件夹分类（folders 表 + documents.folder_id）
// ---------------------------------------------------------------------------

/**
 * 按 (folder_id, doc_type) 聚合未删除文献，得到每个文件夹/未分类的分栏计数。
 *
 * 垃圾箱里的文献不参与侧栏计数（deleted = 0），否则文件夹上会显示已删除文献；
 * 分类口径统一走 shared 的 `documentCategoryOf`。
 */
function folderCounts(db: DatabaseSync): Map<string, DocumentCategoryCounts> {
  const rows = db
    .prepare(
      `SELECT folder_id AS folder_id, doc_type AS doc_type, COUNT(*) AS total
       FROM documents WHERE deleted = 0 GROUP BY folder_id, doc_type`
    )
    .all() as unknown as Array<{ folder_id?: string; doc_type?: string; total?: number }>;
  const counts = new Map<string, DocumentCategoryCounts>();
  const emptyCounts = (): DocumentCategoryCounts => ({
    total: 0,
    book: 0,
    paper: 0,
    other: 0,
    unknown: 0
  });
  for (const row of rows) {
    const folderId = String(row.folder_id ?? '');
    const amount = Number(row.total ?? 0);
    const entry = counts.get(folderId) ?? emptyCounts();
    entry.total += amount;
    entry[documentCategoryOf(String(row.doc_type ?? ''))] += amount;
    counts.set(folderId, entry);
  }
  return counts;
}

function folderRow(
  db: DatabaseSync,
  id: string
): { id: string; name: string; created: string } | null {
  const row = db
    .prepare('SELECT id, name, created FROM folders WHERE id = ?')
    .get(id) as { id?: string; name?: string; created?: string } | undefined;
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    created: String(row.created ?? '')
  };
}

function folderSummary(
  db: DatabaseSync,
  id: string,
  counts: Map<string, DocumentCategoryCounts>
): FolderSummary | null {
  const row = folderRow(db, id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created: row.created,
    counts: counts.get(row.id) ?? { total: 0, book: 0, paper: 0, other: 0, unknown: 0 }
  };
}

function folderNameOf(input: string): string {
  const name = input.trim();
  if (!name) throw new Error('请输入文件夹名称');
  if (name.length > 60) throw new Error('文件夹名称过长（最多 60 个字符）');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('文件夹名称包含控制字符');
  return name;
}

function folderNameTaken(db: DatabaseSync, name: string, exceptId?: string): boolean {
  const row = db
    .prepare('SELECT id FROM folders WHERE name = ? COLLATE NOCASE AND id <> ? LIMIT 1')
    .get(name, exceptId ?? '') as { id?: string } | undefined;
  return Boolean(row?.id);
}

/** 文献类型只做长度/控制字符校验：Zotero itemType 与用户手填值都允许。 */
export function documentTypeOf(input: string): string {
  const value = input.trim();
  if (value.length > 60) throw new Error('文献类型过长（最多 60 个字符）');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('文献类型包含控制字符');
  return value;
}

export function listFolders(db: DatabaseSync): FolderOverview {
  const counts = folderCounts(db);
  const rows = db
    .prepare('SELECT id, name, created FROM folders ORDER BY created ASC, name ASC')
    .all() as unknown as Array<{ id?: string; name?: string; created?: string }>;
  const folders = rows.map((row) => {
    const id = String(row.id ?? '');
    return {
      id,
      name: String(row.name ?? ''),
      created: String(row.created ?? ''),
      counts: counts.get(id) ?? { total: 0, book: 0, paper: 0, other: 0, unknown: 0 }
    };
  });
  const unfiledCounts = counts.get('') ?? { total: 0, book: 0, paper: 0, other: 0, unknown: 0 };
  return {
    folders,
    unfiled: { id: '', name: '未分类', created: '', counts: unfiledCounts }
  };
}

export function createFolder(db: DatabaseSync, name: string): FolderSummary {
  const value = folderNameOf(name);
  if (folderNameTaken(db, value)) throw new Error(`已存在同名文件夹：${value}`);
  const id = randomUUID();
  db.prepare('INSERT INTO folders(id, name) VALUES (?, ?)').run(id, value);
  const row = folderRow(db, id);
  if (!row) throw new Error('创建文件夹后无法读取');
  return {
    id,
    name: row.name,
    created: row.created,
    counts: { total: 0, book: 0, paper: 0, other: 0, unknown: 0 }
  };
}

export function renameFolder(db: DatabaseSync, id: string, name: string): FolderSummary {
  if (!folderRow(db, id)) throw new Error('文件夹不存在');
  const value = folderNameOf(name);
  if (folderNameTaken(db, value, id)) throw new Error(`已存在同名文件夹：${value}`);
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(value, id);
  const summary = folderSummary(db, id, folderCounts(db));
  if (!summary) throw new Error('文件夹不存在');
  return summary;
}

/**
 * 删除文件夹：文献本身保留，只把归属移回「未分类」。
 *
 * 连回收站里的文献也一起改（它们恢复后不应指向一个已不存在的文件夹）。
 * `movedDocuments` 只统计未删除的文献数，供界面提示“已移出 N 篇文献”。
 */
export function deleteFolder(db: DatabaseSync, id: string): { movedDocuments: number } {
  if (!folderRow(db, id)) throw new Error('文件夹不存在');
  const movedRow = db
    .prepare('SELECT COUNT(*) AS n FROM documents WHERE folder_id = ? AND deleted = 0')
    .get(id) as { n?: number } | undefined;
  const movedDocuments = Number(movedRow?.n ?? 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE documents SET folder_id = '' WHERE folder_id = ?").run(id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { movedDocuments };
}

// ---------------------------------------------------------------------------
// 文献读取：列表/详情/外部键/Zotero 同步查询/查重（全部只读，不开事务）
// ---------------------------------------------------------------------------

export function listDocuments(db: DatabaseSync, deps: DocumentDomainDeps, trash = false): DocumentSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, pages, current_page, created, author, publication, size_bytes, sha256, path,
              deleted, tags, storage_kind, file_stamp, external_path, external_key,
              doc_type, folder_id, manual_order, metadata_source,
              zotero_item_key, zotero_collection_key, zotero_missing
       FROM documents WHERE deleted = ? ORDER BY created DESC, rowid DESC`
    )
    .all(trash ? 1 : 0) as unknown as DocumentRow[];
  return rows.map((row) => toSummary(row, deps.dataDir));
}

export function getDocument(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  id: string
): DocumentDetail | null {
  const row = db
    .prepare(
      `SELECT id, name, pages, current_page, created, author, publication, size_bytes, sha256, path,
              deleted, tags, storage_kind, file_stamp, external_path, external_key,
              doc_type, folder_id, manual_order, metadata_source,
              zotero_item_key, zotero_collection_key, zotero_missing
       FROM documents WHERE id = ? AND deleted = 0`
    )
    .get(id) as unknown as DocumentRow | undefined;
  return row ? toDetail(row, deps.dataDir) : null;
}

export function getDocumentExternalKey(db: DatabaseSync, id: string): string {
  const row = db
    .prepare('SELECT external_key FROM documents WHERE id = ? AND deleted = 0')
    .get(id) as { external_key?: string } | undefined;
  return String(row?.external_key ?? '');
}

/**
 * 查找已存在的 Zotero 本地文献（collection 增量同步用）。
 *
 * 命中顺序：外部身份（含升级前旧身份）→ Zotero 顶层条目 key。返回文献 id；
 * 找不到返回 null。只查未删除文献（回收站里的文献由导入路径自己报错，避免误恢复）。
 */
export function findZoteroDocumentId(
  db: DatabaseSync,
  input: {
    identity?: string;
    legacyIdentity?: string;
    zoteroItemKey?: string;
  }): string | null {
  const identity = String(input.identity ?? '').trim();
  const legacy = String(input.legacyIdentity ?? '').trim();
  const zoteroKey = String(input.zoteroItemKey ?? '').trim();
  if (identity || legacy) {
    const row = db
      .prepare(
        `SELECT id FROM documents WHERE deleted = 0
           AND external_key IN (?, ?) AND external_key <> '' LIMIT 1`
      )
      .get(identity, legacy) as { id?: string } | undefined;
    if (row?.id) return String(row.id);
  }
  if (zoteroKey) {
    const row = db
      .prepare(
        `SELECT id FROM documents WHERE deleted = 0 AND zotero_item_key = ?
         ORDER BY rowid ASC LIMIT 1`
      )
      .get(zoteroKey) as { id?: string } | undefined;
    if (row?.id) return String(row.id);
  }
  return null;
}

/**
 * 最近一次同步记录为「属于该 Zotero collection」的本地文献。
 *
 * 只用于判断 Zotero 侧删除/移出：不是全局 Zotero 文献清单。
 */
export function listZoteroCollectionDocuments(
  db: DatabaseSync,
  collectionKey: string
): Array<{
  documentId: string;
  zoteroItemKey: string;
  zoteroMissing: boolean;
}> {
  const key = String(collectionKey ?? '').trim();
  if (!key) return [];
  const rows = db
    .prepare(
      `SELECT id, zotero_item_key, zotero_missing FROM documents
       WHERE deleted = 0 AND zotero_collection_key = ?
       ORDER BY rowid ASC`
    )
    .all(key) as unknown as Array<{
    id?: string;
    zotero_item_key?: string;
    zotero_missing?: number;
  }>;
  return rows.map((row) => ({
    documentId: String(row.id ?? ''),
    zoteroItemKey: String(row.zotero_item_key ?? ''),
    zoteroMissing: Number(row.zotero_missing ?? 0) === 1
  }));
}

/**
 * 标记/取消「Zotero 侧已删除」。只改标记，不删除文献、标签、笔记、批注。
 * 返回标记是否发生变化（重复同步幂等）。
 */
export function setZoteroMissing(db: DatabaseSync, documentId: string, missing: boolean): boolean {
  const result = db
    .prepare(
      `UPDATE documents SET zotero_missing = ?
       WHERE id = ? AND deleted = 0 AND zotero_missing <> ?`
    )
    .run(missing ? 1 : 0, documentId, missing ? 1 : 0);
  return Number(result.changes ?? 0) > 0;
}

/**
 * 清理 collection 归属：条目仍在 Zotero、只是被移出了这个 collection。
 * 文献本身、`zotero_item_key` 与缺失标记都不动（不删除用户数据）。
 */
export function clearZoteroCollectionKey(db: DatabaseSync, documentId: string): void {
  db.prepare(
    "UPDATE documents SET zotero_collection_key = '' WHERE id = ? AND deleted = 0"
  ).run(documentId);
}

/**
 * 这篇文献在本机**已索引到的全部文字**，用于跨文献发现排序。
 *
 * 两个来源缺一不可：`chunks`（解析到的原文片段）与 `page_edits`（整页 OCR/用户校订，
 * 不在 chunks 里）。任一来源取不到时如实少给，不编造。
 */
export function documentTextState(db: DatabaseSync, documentId: string): string {
  const parts: string[] = [];
  try {
    const rows = db
      .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY page, rowid')
      .all(documentId) as unknown as Array<{ text?: string }>;
    parts.push(...rows.map((row) => String(row.text ?? '')).filter(Boolean));
  } catch {
    // 索引表不可用时按空处理，不影响调用方继续阅读。
  }
  try {
    const rows = db
      .prepare(
        'SELECT text FROM page_edits WHERE document_id = ? AND LENGTH(TRIM(text)) > 0 ORDER BY page'
      )
      .all(documentId) as unknown as Array<{ text?: string }>;
    parts.push(...rows.map((row) => String(row.text ?? '')).filter(Boolean));
  } catch {
    // 同上。
  }
  return parts.join('\n');
}

export function chunkTextStats(db: DatabaseSync, documentId: string): { characters: number; cjk: number } {
  const rows = db
    .prepare('SELECT text FROM chunks WHERE document_id = ?')
    .all(documentId) as unknown as Array<{ text?: string }>;
  let characters = 0;
  let cjk = 0;
  for (const row of rows) {
    const text = String(row.text ?? '');
    characters += text.length;
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk += 1;
      }
    }
  }
  return { characters, cjk };
}

export function getDocumentPath(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  id: string
): string | null {
  const row = db
    .prepare(
      'SELECT path, storage_kind, external_path, file_stamp FROM documents WHERE id = ? AND deleted = 0'
    )
    .get(id) as
    | {
        path?: string;
        storage_kind?: string;
        external_path?: string;
        file_stamp?: string;
      }
    | undefined;
  if (!row) return null;
  if (row.storage_kind === 'zotero' && row.external_path) {
    if (!existsSync(row.external_path)) return null;
    // 导入时记录的是 `size:mtimeMs`。外部替换/覆盖后索引仍指向旧内容，必须拒绝，
    // 不能把新文件的热链接当成"还能用"。
    const expected = String(row.file_stamp ?? '');
    if (expected) {
      let current = '';
      try {
        const stats = statSync(row.external_path);
        current = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
      } catch {
        return null;
      }
      if (current !== expected) throw new AttachmentChangedError();
    }
    return row.external_path;
  }
  if (!row.path) return null;
  const resolved = path.resolve(deps.dataDir, row.path);
  if (!resolved.startsWith(path.resolve(deps.dataDir))) return null;
  return resolved;
}

export function findImportDuplicates(
  db: DatabaseSync,
  input: {
    sha256?: string;
    doi?: string;
    externalKey?: string;
    title?: string;
    author?: string;
    publication?: string;
    pages?: number;
  }): ImportDuplicateCandidate[] {
  const found = new Map<string, ImportDuplicateCandidate>();
  const add = (
    row: {
      id: string;
      name: string;
      pages: number;
      author: string;
      publication: string;
      doi: string;
    },
    match: ImportDuplicateCandidate['match'],
    reason: string
  ): void => {
    const existing = found.get(row.id);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      const rank = { title: 1, zotero: 2, doi: 3, file: 4 } as const;
      if (rank[match] > rank[existing.match]) existing.match = match;
      return;
    }
    found.set(row.id, {
      id: row.id,
      name: row.name,
      pages: row.pages,
      author: row.author ?? '',
      publication: row.publication ?? '',
      doi: row.doi ?? '',
      match,
      reasons: [reason]
    });
  };
  const select = `SELECT id, name, pages, author, publication, doi
    FROM documents WHERE deleted = 0`;
  if (input.sha256) {
    const rows = db
      .prepare(`${select} AND sha256 = ? LIMIT 3`)
      .all(input.sha256) as unknown as Array<Parameters<typeof add>[0]>;
    for (const row of rows) add(row, 'file', '文件内容完全相同');
  }
  if (input.externalKey) {
    const rows = db
      .prepare(`${select} AND external_key = ? LIMIT 3`)
      .all(input.externalKey) as unknown as Array<Parameters<typeof add>[0]>;
    for (const row of rows) add(row, 'zotero', 'Zotero 条目相同');
  }
  if (input.doi) {
    const rows = db
      .prepare(`${select} AND doi = ? LIMIT 5`)
      .all(input.doi) as unknown as Array<Parameters<typeof add>[0]>;
    for (const row of rows) add(row, 'doi', 'DOI 相同');
  }
  const titleKey = normalizeKey(input.title ?? '');
  if (titleKey) {
    const rows = db
      .prepare(`${select} AND title_key = ? LIMIT 8`)
      .all(titleKey) as unknown as Array<Parameters<typeof add>[0]>;
    const authorKey = firstAuthorKey(input.author ?? '');
    const publicationKey = normalizeKey(input.publication ?? '');
    for (const row of rows) {
      const reasons: string[] = [];
      if (authorKey && firstAuthorKey(row.author) === authorKey) reasons.push('作者一致');
      if (publicationKey && normalizeKey(row.publication) === publicationKey) {
        reasons.push('期刊/出版社一致');
      }
      if (input.pages && row.pages === input.pages) reasons.push('页数一致');
      if (reasons.length === 0) reasons.push('标题相同');
      add(row, 'title', reasons.join('、'));
    }
  }
  return [...found.values()].slice(0, 5);
}

// ---------------------------------------------------------------------------
// 文献级派生状态读取：检索版本号 / 文件健康（只读，不开事务）
// ---------------------------------------------------------------------------

/** 检索索引版本号：chunks/派生结构/译文/文献改名变化时由触发器递增。 */
export function getRetrievalRevision(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT value FROM retrieval_revision WHERE id = 1')
    .get() as { value?: number | bigint } | undefined;
  return Number(row?.value ?? 0);
}

/** 单篇文献的检索版本号：该文献 chunks/结构/译文/改名变化时递增。 */
export function getDocumentRetrievalRevision(db: DatabaseSync, documentId: string): number {
  const row = db
    .prepare('SELECT value FROM retrieval_document_revision WHERE document_id = ?')
    .get(documentId) as { value?: number | bigint } | undefined;
  return Number(row?.value ?? 0);
}

/** 批量读取多篇文献的检索版本（scope 检索的缓存键用）；缺失的文献按 0 处理。 */
export function getDocumentRetrievalRevisions(
  db: DatabaseSync,
  documentIds: readonly string[]
): Record<string, number> {
  const unique = [...new Set(documentIds.filter(Boolean))];
  const result: Record<string, number> = {};
  for (const id of unique) result[id] = 0;
  if (unique.length === 0) return result;
  const marks = unique.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT document_id, value FROM retrieval_document_revision WHERE document_id IN (${marks})`
    )
    .all(...unique) as unknown as Array<{ document_id: string; value: number | bigint | null }>;
  for (const row of rows) {
    result[row.document_id] = Number(row.value ?? 0);
  }
  return result;
}

/** 未删除文献里附件文件缺失的篇数（只 stat 是否存在）。 */
export function missingDocumentFiles(db: DatabaseSync, deps: DocumentDomainDeps): number {
  const rows = db
    .prepare('SELECT id FROM documents WHERE deleted = 0')
    .all() as unknown as Array<{ id?: string }>;
  let missing = 0;
  for (const row of rows) {
    const id = String(row.id ?? '');
    const filePath = id ? getDocumentPath(db, deps, id) : null;
    // getDocumentPath 对应用副本只做路径解析；这里必须再确认文件真的存在。
    if (!id || !filePath || !existsSync(filePath)) missing += 1;
  }
  return missing;
}

/**
 * 逐文档检查附件是否还在（只 stat 是否存在，不读 PDF 内容）。
 *
 * 应用副本看 dataDir 下的相对路径（或 `<id>.pdf` 兜底）；Zotero 文献看登记的外部路径。
 * 不会因为附件缺失而删记录：索引、批注、笔记仍在，用户可重新连接。
 */
export function documentHealth(
  db: DatabaseSync,
  deps: DocumentDomainDeps
): Array<{
  documentId: string;
  name: string;
  missing: boolean;
  path: string;
}> {
  const rows = db
    .prepare(
      'SELECT id, name, path, storage_kind, external_path FROM documents WHERE deleted = 0 ORDER BY created'
    )
    .all() as unknown as Array<{
    id?: string;
    name?: string;
    path?: string;
    storage_kind?: string;
    external_path?: string;
  }>;
  return rows.map((row) => {
    const id = String(row.id ?? '');
    const kind = row.storage_kind || 'copy';
    const filePath =
      kind === 'zotero' && row.external_path
        ? String(row.external_path)
        : row.path
          ? path.resolve(deps.dataDir, String(row.path))
          : path.join(deps.dataDir, `${id}.pdf`);
    return {
      documentId: id,
      name: String(row.name ?? ''),
      missing: !existsSync(filePath),
      path: filePath
    };
  });
}

// ---------------------------------------------------------------------------
// 文献写路径：字段更新 / 默认排序拖拽 / 标签 / 回收站（软删除与恢复）
// ---------------------------------------------------------------------------

/**
 * 更新文献字段（阅读进度/标题/作者/文献类型/文件夹）。
 *
 * 每个字段一条独立 UPDATE，只更新调用方显式传入的字段；**不开事务**（与拆分前逐字一致，
 * 部分字段成功、部分字段无效的组合行为不变：无效值仍会在写库前抛中文错误文案）。
 * 改名/改作者会把 metadata_source 标为 manual（之后的 Zotero 同步不得覆盖）。
 */
export function updateDocument(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  id: string,
  input: {
    currentPage?: number;
    name?: string;
    author?: string;
    /** 文献类型（Zotero itemType 原文）；空串恢复为「未分类」。 */
    docType?: string;
    /** 文件夹 id；空串表示移到「未分类」。 */
    folderId?: string;
  }
): DocumentDetail | null {
  if (input.currentPage != null) {
    db.prepare('UPDATE documents SET current_page = ? WHERE id = ? AND deleted = 0').run(
      Math.max(1, Math.trunc(input.currentPage)),
      id
    );
  }
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw new Error('请输入文献名称');
    // 用户手动改名 = 题录来源变 manual：之后的 Zotero 同步不得覆盖。
    db.prepare(
      "UPDATE documents SET name = ?, metadata_source = 'manual' WHERE id = ? AND deleted = 0"
    ).run(name, id);
  }
  if (input.author != null) {
    db.prepare(
      "UPDATE documents SET author = ?, metadata_source = 'manual' WHERE id = ? AND deleted = 0"
    ).run(input.author.trim(), id);
  }
  if (input.docType != null) {
    const docType = documentTypeOf(input.docType);
    db.prepare('UPDATE documents SET doc_type = ? WHERE id = ? AND deleted = 0').run(docType, id);
  }
  if (input.folderId != null) {
    const folderId = input.folderId.trim();
    // 只允许 ''（未分类）或真实存在的文件夹；避免出现指向不存在文件夹的孤儿归属。
    if (folderId && !folderRow(db, folderId)) throw new Error('文件夹不存在');
    db.prepare('UPDATE documents SET folder_id = ? WHERE id = ? AND deleted = 0').run(folderId, id);
  }
  deps.invalidateReferenceGraphCache();
  return getDocument(db, deps, id);
}

/**
 * 默认排序拖拽：把文献移动到 beforeId 与 afterId 之间（两者是当前显示顺序里的邻居）。
 *
 * - beforeId 为 null 表示移到当前显示顺序最前（afterId 必须是第一位）；afterId 为 null 同理。
 * - 位置计算：两端 neighbor ± 1，中间取中点；浮点间隙 < 1e-9 时先按
 *   (manual_order, rowid) 全局重排成 1..N 再算，避免反复插中间把 double 耗尽。
 * - 已处于该相对位置时是幂等 no-op（仍返回成功与当前文档）。
 */
export function moveDocument(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  id: string,
  input: { beforeId?: string | null; afterId?: string | null }
): DocumentDetail {
  const target = manualDocumentOrder(db, id);
  if (target === null) throw new Error('文献不存在');
  const beforeId = (input.beforeId ?? '').trim();
  const afterId = (input.afterId ?? '').trim();
  if (!beforeId && !afterId) throw new Error('需要提供 beforeId 或 afterId');
  if (beforeId === id || afterId === id) throw new Error('相邻文献不能是目标文献本身');
  const beforeOrder = beforeId ? manualDocumentOrder(db, beforeId) : null;
  if (beforeId && beforeOrder === null) throw new Error('相邻文献不存在');
  const afterOrder = afterId ? manualDocumentOrder(db, afterId) : null;
  if (afterId && afterOrder === null) throw new Error('相邻文献不存在');
  if (beforeOrder !== null && afterOrder !== null && beforeOrder >= afterOrder) {
    throw new Error('相邻文献顺序无效');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // 已在该相对位置：不改位置，保证重复调用幂等。
    const alreadyPlaced =
      (beforeOrder === null || target > beforeOrder) &&
      (afterOrder === null || target < afterOrder);
    if (!alreadyPlaced) {
      const position = manualPositionFor(db, id, beforeId, afterId);
      db.prepare('UPDATE documents SET manual_order = ? WHERE id = ?').run(position, id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const document = getDocument(db, deps, id);
  if (!document) throw new Error('文献不存在');
  return document;
}

/** 读取未删除文献的默认排序位置；不存在返回 null。 */
function manualDocumentOrder(db: DatabaseSync, id: string): number | null {
  const row = db
    .prepare('SELECT manual_order FROM documents WHERE id = ? AND deleted = 0')
    .get(id) as { manual_order?: number } | undefined;
  return row ? Number(row.manual_order ?? 0) : null;
}

/** 全库按 (manual_order, rowid) 重排成 1..N（含回收站，保证位置唯一且保序）。 */
function rebalanceManualOrder(db: DatabaseSync): void {
  const rows = db
    .prepare('SELECT id FROM documents ORDER BY manual_order ASC, rowid ASC')
    .all() as unknown as Array<{ id: string }>;
  const update = db.prepare('UPDATE documents SET manual_order = ? WHERE id = ?');
  rows.forEach((row, index) => update.run(index + 1, row.id));
}

/** 小于/大于给定位置的最近 manual_order（排除目标文献本身）；没有返回 null。 */
function manualOrderBound(
  db: DatabaseSync,
  order: number,
  direction: 'lower' | 'upper',
  excludeId: string
): number | null {
  const row = db
    .prepare(
      direction === 'lower'
        ? 'SELECT MAX(manual_order) AS value FROM documents WHERE manual_order < ? AND id <> ?'
        : 'SELECT MIN(manual_order) AS value FROM documents WHERE manual_order > ? AND id <> ?'
    )
    .get(order, excludeId) as { value?: number | null } | undefined;
  const value = row?.value;
  return value === null || value === undefined ? null : Number(value);
}

function manualOrderTaken(db: DatabaseSync, order: number, excludeId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM documents WHERE manual_order = ? AND id <> ? LIMIT 1')
    .get(order, excludeId) as { found?: number } | undefined;
  return Boolean(row?.found);
}

/** 计算 moveDocument 的新位置；必要时先全局重排。 */
function manualPositionFor(
  db: DatabaseSync,
  id: string,
  beforeId: string,
  afterId: string
): number {
  const GAP = 1e-9;
  let before = beforeId ? manualDocumentOrder(db, beforeId) : null;
  let after = afterId ? manualDocumentOrder(db, afterId) : null;
  if (before !== null && after !== null) {
    if (after - before < GAP) {
      rebalanceManualOrder(db);
      before = manualDocumentOrder(db, beforeId);
      after = manualDocumentOrder(db, afterId);
    }
    // 过滤视图里两个邻居之间可能还夹着其它文件夹的文献：中点撞位时也先重排。
    let position = ((before as number) + (after as number)) / 2;
    if (manualOrderTaken(db, position, id)) {
      rebalanceManualOrder(db);
      before = manualDocumentOrder(db, beforeId);
      after = manualDocumentOrder(db, afterId);
      position = ((before as number) + (after as number)) / 2;
      // 整数重排后若中点被占（邻居间隔为偶数），退到紧贴 after 的半格位置。
      if (manualOrderTaken(db, position, id)) position = (after as number) - 0.5;
    }
    return position;
  }
  if (before === null && after !== null) {
    // 移到 after 之前（显示顺序最前）：优先 after - 1，否则取 (lower + after) 中点。
    const lower = manualOrderBound(db, after, 'lower', id);
    if (lower !== null && after - lower < GAP) {
      rebalanceManualOrder(db);
      return manualPositionFor(db, id, beforeId, afterId);
    }
    const candidate = after - 1;
    if (lower === null || candidate > lower) return candidate;
    return (lower + after) / 2;
  }
  // 移到 before 之后（显示顺序最后）：优先 before + 1，否则取 (before + upper) 中点。
  const beforeValue = before as number;
  const upper = manualOrderBound(db, beforeValue, 'upper', id);
  if (upper !== null && upper - beforeValue < GAP) {
    rebalanceManualOrder(db);
    return manualPositionFor(db, id, beforeId, afterId);
  }
  const candidate = beforeValue + 1;
  if (upper === null || candidate < upper) return candidate;
  return (beforeValue + upper) / 2;
}

export function setDocumentTags(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  id: string,
  tags: string[]
): string[] {
  if (!getDocument(db, deps, id)) throw new Error('文档不存在');
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (normalized.some((tag) => tag.length > 50 || /[\u0000-\u001f]/.test(tag))) {
    throw new Error('标签过长或包含控制字符');
  }
  db.prepare('UPDATE documents SET tags = ? WHERE id = ? AND deleted = 0').run(
    JSON.stringify(normalized),
    id
  );
  return normalized;
}

/** 软删除（移入应用回收站）：单条 UPDATE，不开事务；引用图缓存由 deps 回调失效。 */
export function deleteDocument(db: DatabaseSync, deps: DocumentDomainDeps, id: string): void {
  if (!getDocument(db, deps, id)) throw new Error('文档不存在');
  db.prepare('UPDATE documents SET deleted = 1 WHERE id = ?').run(id);
  deps.invalidateReferenceGraphCache();
}

/** 从应用回收站恢复：单条 UPDATE，不开事务。 */
export function restoreDocument(db: DatabaseSync, deps: DocumentDomainDeps, id: string): void {
  const row = db
    .prepare('SELECT id FROM documents WHERE id = ?')
    .get(id) as { id: string } | undefined;
  if (!row) throw new Error('文档不存在');
  db.prepare('UPDATE documents SET deleted = 0 WHERE id = ?').run(id);
  deps.invalidateReferenceGraphCache();
}

// ---------------------------------------------------------------------------
// 页文本（page_edits）与页遮罩只读查询
// ---------------------------------------------------------------------------

/** 去掉 CJK 字符之间由 PDF 排版产生的空格，保留英文词间空格。 */
function tidyCjkSpacing(text: string): string {
  return text
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '')
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[，。；：！？、）》”’])/g, '')
    .replace(/(?<=[（《“‘])\s+(?=[\u3400-\u9fff])/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * PDF 文本层按行返回，直接拼给模型会得到一排“行首/行尾碎片”。
 * 在读取时按句子边界复原段落；英文仍保留词间空格。
 */
function reflowPageLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current = '';
  const flush = (): void => {
    const value = tidyCjkSpacing(current).trim();
    if (value) paragraphs.push(value);
    current = '';
  };
  for (const raw of lines) {
    const line = tidyCjkSpacing(String(raw)).trim();
    if (!line) {
      flush();
      continue;
    }
    if (!current) {
      current = line;
      continue;
    }
    const startsHeading =
      /^(?:第[一二三四五六七八九十百]+[章节部分]|[一二三四五六七八九十]+[、.．]|\([一二三四五六七八九十]+\)|\d+(?:\.\d+)*[、.．]?\s|[［\[]\d+[］\]])/.test(
        line
      );
    const previousEndsSentence = /[。！？!?；;：:…”’】》)]$/.test(current);
    if (startsHeading || previousEndsSentence) {
      flush();
      current = line;
      continue;
    }
    const cjkBoundary = /[\u3400-\u9fff]$/.test(current) && /^[\u3400-\u9fff]/.test(line);
    current += cjkBoundary ? line : ` ${line}`;
  }
  flush();
  return paragraphs.join('\n\n');
}

/** 解析 page_edits.boxes（归一化 0..1 的 OCR 行框）；坏数据按空处理。 */
export function parsePageEditBoxes(raw: string): LayoutLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const lines: LayoutLine[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const value = row as { text?: unknown; bbox?: unknown };
    if (typeof value.text !== 'string' || !Array.isArray(value.bbox)) continue;
    if (value.bbox.length !== 4) continue;
    const numbers = value.bbox as unknown[];
    if (!numbers.every((item) => typeof item === 'number' && Number.isFinite(item))) continue;
    const [x0, y0, x1, y1] = numbers as [number, number, number, number];
    lines.push({ text: value.text, bbox: [x0, y0, x1, y1] });
  }
  return lines;
}

/**
 * 读取一页文本（精读热路径，逐页调用）：
 * 用户校订/OCR 结果优先于 PDF 原生文本层；没有 page_edits 时按 chunks 的行重排段落。
 *
 * 行为与拆分前逐字一致：只做单页索引查询 + 行重排，不缓存、不额外扫描；
 * OCR 页的行框按**当前** page_masks 过滤后再拼接（删除规则后同一份行框又能恢复）。
 */
export function getPageText(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  documentId: string,
  page: number
): string {
  // 用户校订/OCR 结果优先于 PDF 原生文本层（page_edits 语义）。
  const target = Math.max(1, Math.trunc(page));
  const edit = getPageEdit(db, deps, documentId, target);
  const edited = edit?.text?.trim();
  if (edited) {
    // OCR 页保存的是「整页文本 + 全量行框」：读取时按**当前**无关区域规则过滤行框再拼接，
    // 删除规则后同一份行框又能恢复（可逆）。
    // 用户校订（origin='user'）直接返回正文，不再按几何裁剪。
    if (edit?.origin === 'ocr' && edit.boxes) {
      const lines = parsePageEditBoxes(edit.boxes);
      if (lines.length > 0) {
        const masks = listPageMasks(db, documentId);
        const visible =
          masks.length > 0
            ? visibleLines({ page: target, width: 1, height: 1, lines }, masks)
            : lines;
        return visible.map((line) => line.text).join('\n');
      }
    }
    return edited;
  }
  const rows = db
    .prepare('SELECT text FROM chunks WHERE document_id = ? AND page = ? ORDER BY rowid')
    .all(documentId, target) as unknown as Array<{ text: string }>;
  return reflowPageLines(rows.map((row) => row.text));
}

export function getPageEdit(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  documentId: string,
  page: number
): { text: string; origin: string; boxes: string; version: string } | null {
  const document = getDocument(db, deps, documentId);
  const row = db
    .prepare(
      'SELECT text, origin, boxes, version FROM page_edits WHERE document_id = ? AND page = ?'
    )
    .get(documentId, Math.max(1, Math.trunc(page))) as
    | { text?: string; origin?: string; boxes?: string; version?: string }
    | undefined;
  if (!row) return null;
  if (document && row.version && row.version !== document.sha256) return null;
  return {
    text: String(row.text ?? ''),
    origin: String(row.origin ?? ''),
    boxes: String(row.boxes ?? ''),
    version: String(row.version ?? '')
  };
}

/**
 * 保存用户校订的页文本（page_edits），并把该页文本同步进检索索引。
 *
 * 事务/顺序与拆分前逐字一致：
 * 1. 校验文献存在（「文档不存在」），保留原有 OCR 行框（与文字是否被改写无关）。
 * 2. INSERT OR REPLACE page_edits（单行，不开事务，提交即生效）。
 * 3. await deps.readLayoutPage（解析或缓存）；等待期间库可能已被关闭——保留 db.isOpen
 *    检查，关闭后不再写索引。
 * 4. deps.rebuildPageChunks 重建该页 chunks/FTS（索引层自己管理事务）。
 */
export async function savePageTextEdit(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  documentId: string,
  page: number,
  text: string
): Promise<{ text: string; origin: string; boxes: string }> {
  const document = getDocument(db, deps, documentId);
  if (!document) throw new Error('文档不存在');
  const target = Math.max(1, Math.trunc(page));
  const existing = getPageEdit(db, deps, documentId, target);
  // 保留 OCR 行框：它是版面上那一行的位置，与文字是否被改写无关。
  const boxes = existing?.boxes ?? '';
  db.prepare(
    `INSERT OR REPLACE INTO page_edits(document_id, page, version, text, origin, boxes)
     VALUES (?, ?, ?, ?, 'user', ?)`
  ).run(documentId, target, document.sha256, text, boxes);
  // 校订必须同步进检索索引：否则问答/证据仍读到旧 chunks。
  // 页面尺寸用于把归一化行框换算成 chunks 的页面点坐标；读不到就退回无行框的平铺块。
  const layoutPage = await deps.readLayoutPage(documentId, target);
  // 等待 PDF 解析期间库可能已被关闭（关闭应用 / 测试清理）：此时不再写索引。
  if (!db.isOpen) return { text, origin: 'user', boxes };
  deps.rebuildPageChunks(documentId, target, text, boxes, layoutPage);
  return { text, origin: 'user', boxes };
}

/** 缓存整页 OCR 结果（page_edits，origin='ocr'）；单行 INSERT OR REPLACE，不开事务。 */
export function cacheOcrPage(
  db: DatabaseSync,
  deps: DocumentDomainDeps,
  documentId: string,
  page: number,
  text: string,
  boxes: unknown[]
): void {
  const document = getDocument(db, deps, documentId);
  if (!document) throw new Error('文档不存在');
  db.prepare(
    `INSERT OR REPLACE INTO page_edits(document_id, page, version, text, origin, boxes)
     VALUES (?, ?, ?, ?, 'ocr', ?)`
  ).run(
    documentId,
    Math.max(1, Math.trunc(page)),
    document.sha256,
    text,
    JSON.stringify(boxes)
  );
}

// ---------------------------------------------------------------------------
// 页遮罩查询（page_masks 只读；重建/写入仍留在 store.ts 的遮罩链路里）
// ---------------------------------------------------------------------------

export function listPageMasks(db: DatabaseSync, documentId: string): PageMask[] {
  return db
    .prepare(
      `SELECT id, document_id, page, scope, range_start, range_end, exclude_pages,
              x0, y0, x1, y1 FROM page_masks
       WHERE document_id = ? ORDER BY page, created, rowid`
    )
    .all(documentId)
    .map((row) => {
      const value = row as unknown as {
        id: string;
        document_id: string;
        page: number;
        scope: string;
        range_start: number;
        range_end: number;
        exclude_pages: string;
        x0: number;
        y0: number;
        x1: number;
        y1: number;
      };
      let excludePages: number[] = [];
      try {
        const parsed = JSON.parse(value.exclude_pages || '[]') as unknown;
        if (Array.isArray(parsed)) {
          excludePages = parsed.filter((item): item is number => Number.isInteger(item));
        }
      } catch {
        excludePages = [];
      }
      return {
        id: value.id,
        documentId: value.document_id,
        page: value.page,
        scope: (value.scope || (value.page === 0 ? 'all' : 'page')) as PageMask['scope'],
        rangeStart: value.range_start || undefined,
        rangeEnd: value.range_end || undefined,
        excludePages,
        x0: value.x0,
        y0: value.y0,
        x1: value.x1,
        y1: value.y1
      };
    });
}

/** 页遮罩内容指纹（空遮罩返回 ''）：页遮罩变化即 revision 变化，用于结构缓存失效。 */
export function pageMaskRevision(db: DatabaseSync, documentId: string): string {
  const masks = listPageMasks(db, documentId);
  if (masks.length === 0) return '';
  const digest = createHash('sha256');
  for (const mask of masks) {
    digest.update(`${mask.id}|${mask.page}|${mask.x0}|${mask.y0}|${mask.x1}|${mask.y1}\n`);
  }
  return digest.digest('hex').slice(0, 16);
}
