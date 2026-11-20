import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ContentOrigin,
  CreateNoteInput,
  DocumentDetail,
  NoteFolderOperationResult,
  NoteFolderRecord,
  NotePurgeResult,
  NoteRecord,
  UpdateNoteInput
} from '@studianda/shared';
import { beginTransaction } from './transactions.js';

/**
 * 笔记域（notes 表 + note_folders + notes.folder_path / manual_order / 回收站）。
 *
 * 从 store.ts 拆出的第三个域（前两个：store/projects.ts、store/note-assets.ts）。
 * 本文件承载五块：list（列表/搜索等读路径）、write（创建/更新/标签）、trash（回收站）、
 * folder（虚拟文件夹）、manualOrder（独立笔记拖拽排序）。至此笔记域的读写全部在本文件，
 * Store 上只剩薄委托。
 *
 * 拆分约定（与前两个域一致）：
 * - 纯函数 + 显式依赖注入：第一个参数是 SQLite 句柄 `db`，需要非 DB 依赖的函数再收
 *   `deps`；绝不接收 `Store` 实例，也绝不反向 import store.ts。
 * - 私有辅助（行映射、SQL、路径规范化、LIKE 转义、文件夹祖先展开）随域一起搬进来，
 *   不反向引用 store.ts 的私有成员。
 * - Store 上的同名方法只剩一层薄委托，调用方与返回结构不变。
 * - 内容来源（origin）映射、标签清洗、文件夹路径规范化、笔记行映射在本文件各只有一份导出，
 *   批注域（Store.toAnnotation / createAnnotation）也 import `normalizeContentOrigin`，
 *   不复制第二份。
 * - 依赖方向固定为 notes →（deps 回调）。本模块**不 import store/note-assets.ts**，
 *   资源引用同步 / 计数刷新 / 独占文件回收都由 Store 注入 `NoteDomainDeps` 回调
 *   （syncNoteAssetRefs / refreshAssetCounts / purgeAssetRecords），因此不会出现
 *   note-assets → notes 的反向依赖。
 *
 * **事务不变量（改这里之前先读）：**
 * - 只读或单语句函数**自己不开事务**，既可直接调用（SQLite 自动提交），也可在调用方
 *   已打开的事务里执行：list* / getNote / noteExternalKeys / findNoteByExternalKey /
 *   listNotesByExternalKeyPrefix / listNoteFolders / folderPathExists /
 *   nextNoteManualOrder / moveNoteToFolder / deleteNote / restoreNote / setNoteTags /
 *   ensureNoteFolderHierarchy（单条 INSERT OR IGNORE）。
 *   Markdown 导入就是在外层事务里调 ensureNoteFolderHierarchy 的，不要在这里加 BEGIN。
 * - backfillNoteFolders / backfillNoteManualOrder 是迁移回填入口（多行 INSERT/UPDATE），
 *   但**必须运行在 migrate() 的事务里**，因此同样不自管事务。
 * - 跨多行的写操作**自己管理事务**（BEGIN IMMEDIATE / COMMIT / ROLLBACK），调用方不得
 *   再包一层：createNote / updateNote（notes 行 + note_asset_refs 同成同败）、
 *   purgeNote（notes 行 + note_asset_refs 同成同败）、createNoteFolder /
 *   renameNoteFolder / deleteNoteFolder（note_folders + notes.folder_path）、
 *   reorderStandaloneNotes / batchDeleteStandaloneNotes / batchMoveStandaloneNotes
 *   （多条 UPDATE）。这些都是原实现的事务边界，拆文件不拆事务、不拆成多个事务。
 * - createNote / updateNote 的事务内顺序固定：写 notes 行 → deps.syncNoteAssetRefs
 *   （它不是本文件的函数，但必须在**同一事务、同名 db 连接**里执行，见
 *   store/note-assets.ts 的 syncSource 约定）→ COMMIT。**引用图缓存失效必须在 COMMIT
 *   之后**调用 deps.invalidateReferenceGraphCache，绝不放进事务。
 * - 页码校验（getDocument 不存在 →「文档不存在」；页码非整数/越界 →「页码超出范围」）
 *   与 externalKey 去重、文件夹层级登记都发生在 BEGIN 之前，错误文案与时机与拆分前一致。
 * - 软删除（deleteNote / restoreNote / batchDeleteStandaloneNotes）只改 notes.deleted，
 *   note_asset_refs 保留（回收站期间 usage 仍能统计到）；只有彻底删除 purgeNote 才在
 *   事务提交后经 deps 调 note-assets 的 refreshCounts / purgeRecords，再失效引用图缓存。
 */

/** 笔记域真正需要的非 DB 依赖；由 Store（或直接调用本模块的测试）显式传入。 */
export interface NoteDomainDeps {
  /** 当前时间（ISO 文本），用于 note_folders.created_at。默认与 Store 原来的 `new Date().toISOString()` 一致。 */
  now: () => string;
  /**
   * 按 id 取未删除文献（创建/更新文献笔记时校验页码）。
   *
   * 由 Store 注入（保持原 `this.getDocument` 的查询口径与返回结构）；未删除的文献
   * 也必须带 pages，用于「页码超出范围」判断。不存在/已删除返回 null。
   */
  getDocument: (id: string) => DocumentDetail | null;
  /**
   * 同步一条笔记的资源引用（note_asset_refs）。
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
  /** 彻底删除笔记后重算资源引用计数（note-assets 域注入）。 */
  refreshAssetCounts: (assetIds: string[]) => void;
  /** 彻底删除笔记后回收其独占图片资源（note-assets 域注入）。 */
  purgeAssetRecords: (assetIds: string[]) => NotePurgeResult;
  /** 笔记写操作**提交后**失效引用图缓存（缓存仍由 Store 持有，用回调注入避免反向依赖）。 */
  invalidateReferenceGraphCache: () => void;
}

/** notes 表读取用的原始行形状（updateNote 的写前读取也用它做类型断言）。 */
export interface NoteRow {
  id: string;
  document_id: string | null;
  page: number;
  quote: string;
  content: string;
  created: string;
  folder_path?: string | null;
  tags?: string | null;
  origin?: string | null;
  agent_name?: string | null;
}

// ---------------------------------------------------------------------------
// 映射/规范化辅助（纯函数）
// ---------------------------------------------------------------------------

/**
 * 内容来源归一：只认 `'ai'`，其余（含迁移前没有 origin 列的老数据）一律 `'user'`。
 *
 * 与表列 `origin TEXT NOT NULL DEFAULT 'user'` 保持一致；老库迁移后靠文本兜底
 * （`looksLikeAiContent`）识别历史 AI 内容，字段只覆盖系统写入路径。
 */
export function normalizeContentOrigin(value: unknown): ContentOrigin {
  return value === 'ai' ? 'ai' : 'user';
}

/** 笔记标签清洗：trim、去 `#`、去控制字符、去重（忽略大小写）、数量/长度上限。 */
export function normalizeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('标签必须是字符串数组');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw
      .trim()
      .replace(/^#+/, '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim();
    if (!tag) continue;
    const capped = tag.slice(0, 50);
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capped);
    if (result.length >= 50) break;
  }
  return result;
}

export function parseNoteTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return normalizeTags(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 笔记来源文件夹：'' 或 `/` 分隔层级；拒绝 `..`/控制字符/超长。 */
export function normalizeFolderPath(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const segments = raw
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error('文件夹路径无效');
  }
  const joined = segments.join('/');
  if (joined.length > 240) throw new Error('文件夹路径过长（最多 240 个字符）');
  return joined;
}

/** 独立笔记（不属于任何文献）用 document_id='' 表示；旧数据可能是 NULL，统一成 ''。 */
function toNote(row: NoteRow): NoteRecord {
  return {
    id: row.id,
    documentId: row.document_id ?? '',
    page: Number(row.page ?? 0),
    quote: row.quote ?? '',
    content: row.content ?? '',
    created: row.created ?? '',
    origin: normalizeContentOrigin(row.origin),
    agentName: row.agent_name || undefined,
    folderPath: row.folder_path ?? '',
    tags: parseNoteTags(row.tags)
  };
}

/** LIKE 前缀转义：与 store.ts 里 backlinks 用的同名辅助口径一致（本模块自带，不反向依赖）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// ---------------------------------------------------------------------------
// list：笔记列表/搜索等读路径
// ---------------------------------------------------------------------------

export function listNotes(db: DatabaseSync, documentId: string, trash = false): NoteRecord[] {
  const rows = db
    .prepare(
      `SELECT id, document_id, page, quote, content, created, folder_path, tags, origin, agent_name
       FROM notes WHERE document_id = ? AND deleted = ? ORDER BY page, created`
    )
    .all(documentId, trash ? 1 : 0) as unknown as NoteRow[];
  return rows.map(toNote);
}

/** 独立笔记（document_id=''，不依附任何文献）；trash=true 返回回收站里的。 */
export function listStandaloneNotes(db: DatabaseSync, trash = false): NoteRecord[] {
  const rows = db
    .prepare(
      `SELECT id, document_id, page, quote, content, created, folder_path, tags, origin, agent_name, rowid
       FROM notes WHERE (document_id = '' OR document_id IS NULL) AND deleted = ?
       ORDER BY folder_path ASC, manual_order ASC, created ASC`
    )
    .all(trash ? 1 : 0) as unknown as NoteRow[];
  return rows.map(toNote);
}

/** 全库笔记（含文献笔记与独立笔记；不含回收站及已删除文献下的笔记）。资料库索引用，只取元数据。 */
export function listAllNotes(db: DatabaseSync): NoteRecord[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.document_id, n.page, n.quote, substr(n.content, 1, 400) AS content,
              n.created, n.folder_path, n.tags, n.origin, n.agent_name
       FROM notes n LEFT JOIN documents d ON d.id = n.document_id
       WHERE n.deleted = 0 AND (n.document_id IS NULL OR n.document_id = '' OR d.deleted = 0)
       ORDER BY n.created DESC LIMIT 2000`
    )
    .all() as unknown as NoteRow[];
  return rows.map(toNote);
}

/** 单条笔记（含独立笔记）；不存在或已删除返回 null。 */
export function getNote(db: DatabaseSync, id: string): NoteRecord | null {
  const row = db
    .prepare(
      'SELECT id, document_id, page, quote, content, created, folder_path, tags, origin, agent_name FROM notes WHERE id = ? AND deleted = 0'
    )
    .get(id) as unknown as NoteRow | undefined;
  return row ? toNote(row) : null;
}

/** 全库笔记标签（未删除笔记；已删除文献下的文献笔记不计入）。 */
export function listNoteTags(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT n.tags FROM notes n LEFT JOIN documents d ON d.id = n.document_id
       WHERE n.deleted = 0 AND n.tags IS NOT NULL
         AND (n.document_id IS NULL OR n.document_id = '' OR d.deleted = 0)`
    )
    .all() as unknown as Array<{ tags?: string | null }>;
  const all = new Set<string>();
  for (const row of rows) {
    for (const tag of parseNoteTags(row.tags)) all.add(tag);
  }
  return [...all].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

/**
 * 这篇文献里已写入过外部标识的笔记 key（例如 Zotero note item key）。
 *
 * 与 annotationExternalKeys 一致，**包含已被软删除的行**：用户删掉导入的笔记后
 * 再次迁移不会把它当新笔记重新塞回来；要恢复用笔记自身的恢复/撤销。
 */
export function noteExternalKeys(db: DatabaseSync, documentId: string): Set<string> {
  const rows = db
    .prepare("SELECT external_key FROM notes WHERE document_id = ? AND external_key <> ''")
    .all(documentId) as unknown as Array<{ external_key?: string }>;
  return new Set(rows.map((row) => String(row.external_key ?? '')));
}

/** 按外部稳定键查笔记（含回收站里的，用于导入去重/恢复）；不存在返回 null。 */
export function findNoteByExternalKey(
  db: DatabaseSync,
  documentId: string,
  externalKey: string
): { id: string; deleted: boolean } | null {
  const key = (externalKey ?? '').trim();
  if (!key) return null;
  const row = db
    .prepare(
      `SELECT id, deleted FROM notes
       WHERE document_id = ? AND external_key = ? ORDER BY rowid DESC LIMIT 1`
    )
    .get(documentId, key) as { id?: string; deleted?: number } | undefined;
  return row?.id ? { id: String(row.id), deleted: Number(row.deleted ?? 0) === 1 } : null;
}

/** 按 external_key 前缀列出笔记（Markdown 同一 vault 的已导入笔记，用于链接 resolving）。 */
export function listNotesByExternalKeyPrefix(
  db: DatabaseSync,
  prefix: string
): Array<{
  id: string;
  externalKey: string;
  folderPath: string;
  content: string;
}> {
  const value = `${(prefix ?? '').trim()}%`;
  if (!value) return [];
  const rows = db
    .prepare(
      `SELECT id, external_key, folder_path, content FROM notes
       WHERE document_id = '' AND external_key LIKE ? ESCAPE '\\'`
    )
    .all(value) as unknown as Array<{
    id: string;
    external_key: string | null;
    folder_path: string | null;
    content: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    externalKey: String(row.external_key ?? ''),
    folderPath: String(row.folder_path ?? ''),
    content: String(row.content ?? '')
  }));
}

// ---------------------------------------------------------------------------
// write：创建 / 更新 / 标签（内容与资源引用同成同败）
// ---------------------------------------------------------------------------

/**
 * 创建笔记（含独立笔记与 Markdown 导入/「回答存为笔记」路径）。
 *
 * 事务与顺序（与拆分前的 Store.createNote 逐字一致）：
 * 1. 事务之前：独立笔记判定与 quote 清空 → 文献页码校验（getDocument；错误文案
 *    「文档不存在」/「页码超出范围」）→ externalKey 去重（含软删除行不参与去重）→
 *    文件夹层级登记（INSERT OR IGNORE）→ manual_order（同文件夹 MAX+1）→ origin 归一。
 * 2. BEGIN IMMEDIATE 内：INSERT notes → deps.syncNoteAssetRefs（note_asset_refs），
 *    任一步失败 ROLLBACK，内容与 refs 同成同败。
 * 3. COMMIT 之后才 deps.invalidateReferenceGraphCache（缓存不能在事务里失效）。
 * 4. 返回重新读出的记录（保证 origin/tags/folderPath 与落库一致）。
 */
export function createNote(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  input: CreateNoteInput & { tags?: string[] }
): NoteRecord {
  const documentId = typeof input.documentId === 'string' ? input.documentId.trim() : '';
  // documentId 为空 = 独立笔记：不校验文献/页码，固定 page 0，不带原文摘录。
  const standalone = !documentId;
  let page = 0;
  let quote = input.quote?.trim() ?? '';
  if (standalone) {
    quote = '';
  } else {
    const document = deps.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    if (!Number.isInteger(input.page) || input.page < 0 || input.page > document.pages) {
      throw new Error('页码超出范围');
    }
    page = input.page;
  }
  const externalKey = String(input.externalKey ?? '').trim();
  // 外部稳定标识去重：同一文献内同一 externalKey 只保留一条（重复保存「回答存为笔记」等场景）。
  // 独立笔记 documentId='' 也适用；已删除的笔记不参与去重，允许重新保存。
  if (externalKey) {
    const existing = db
      .prepare(
        'SELECT id FROM notes WHERE document_id = ? AND external_key = ? AND deleted = 0 LIMIT 1'
      )
      .get(documentId, externalKey) as { id: string } | undefined;
    if (existing?.id) {
      const existingNote = getNote(db, existing.id);
      if (existingNote) return existingNote;
    }
  }
  const id = randomUUID();
  const folderPath = normalizeFolderPath(input.folderPath);
  // 文件夹路径及其祖先必须登记，否则 Markdown 导入产生的文件夹无法重命名/删除。
  ensureNoteFolderHierarchy(db, deps, folderPath);
  const manualOrder = nextNoteManualOrder(db, folderPath);
  // 内容来源：只有显式声明 'ai'（系统代写 AI 内容）才落 'ai'，其余（含旧调用方）为 'user'。
  // 与 toAnnotation 共用同一个 normalizeContentOrigin 导出，不复制第二份映射。
  const origin = normalizeContentOrigin(input.origin);
  const agentName = String(input.agentName ?? '').trim().slice(0, 80);
  // 内容写入与资源引用同步必须同成同败：任何一步失败都回滚，避免内容有图但索引没登记。
  const transaction = beginTransaction(db);
  try {
    db.prepare(
      `INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path, tags, manual_order, origin, agent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      documentId,
      page,
      quote,
      input.content?.trim() ?? '',
      externalKey,
      folderPath,
      JSON.stringify(normalizeTags(input.tags)),
      manualOrder,
      origin,
      agentName
    );
    deps.syncNoteAssetRefs('note', id, input.content?.trim() ?? '');
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
  deps.invalidateReferenceGraphCache();
  return getNote(db, id)!;
}

/**
 * 更新笔记（页码/摘录/正文/文件夹/标签）。
 *
 * 事务与顺序（与拆分前的 Store.updateNote 逐字一致）：
 * 1. 事务之前读取原行；独立笔记忽略传入 page 固定 0；文献笔记经 deps.getDocument 校验
 *    页码（错误文案「文档不存在」/「页码超出范围」）；显式 folderPath 时登记文件夹层级。
 * 2. BEGIN IMMEDIATE 内：UPDATE notes → deps.syncNoteAssetRefs，失败整体 ROLLBACK。
 * 3. COMMIT 之后才 deps.invalidateReferenceGraphCache。
 */
export function updateNote(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  id: string,
  input: UpdateNoteInput
): NoteRecord {
  const row = db
    .prepare(
      'SELECT id, document_id, page, quote, content, created, folder_path, tags, origin, agent_name FROM notes WHERE id = ? AND deleted = 0'
    )
    .get(id) as unknown as NoteRow | undefined;
  if (!row) throw new Error('笔记不存在');
  const standalone = !row.document_id;
  let page = Number(row.page ?? 0);
  if (standalone) {
    // 独立笔记没有页码：忽略传入的 page，始终保存为 0。
    page = 0;
  } else {
    const document = deps.getDocument(row.document_id as string);
    if (!document) throw new Error('文档不存在');
    page = input.page ?? page;
    if (!Number.isInteger(page) || page < 0 || page > document.pages) {
      throw new Error('页码超出范围');
    }
  }
  const folderPath =
    input.folderPath !== undefined ? normalizeFolderPath(input.folderPath) : (row.folder_path ?? '');
  // 显式改文件夹时同样登记层级（Markdown 导入/移动后文件夹必须能重命名/删除）。
  if (input.folderPath !== undefined) ensureNoteFolderHierarchy(db, deps, folderPath);
  const tags = input.tags !== undefined ? normalizeTags(input.tags) : parseNoteTags(row.tags);
  const transaction = beginTransaction(db);
  try {
    db.prepare(
      'UPDATE notes SET page = ?, quote = ?, content = ?, folder_path = ?, tags = ? WHERE id = ?'
    ).run(
      page,
      input.quote?.trim() ?? row.quote,
      input.content?.trim() ?? row.content,
      folderPath,
      JSON.stringify(tags),
      id
    );
    deps.syncNoteAssetRefs('note', id, input.content?.trim() ?? row.content ?? '');
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
  deps.invalidateReferenceGraphCache();
  return getNote(db, id)!;
}

/**
 * 设置某条笔记的标签（规范化/去重后返回）。
 *
 * 单条 UPDATE，不开事务；也不失效引用图缓存（标签不影响关系图节点/边），
 * 与拆分前 Store.setNoteTags 的行为逐字一致。
 */
export function setNoteTags(
  db: DatabaseSync,
  id: string,
  tags: string[]
): { ok: boolean; tags: string[] } {
  const row = db
    .prepare('SELECT id FROM notes WHERE id = ? AND deleted = 0')
    .get(id) as { id?: string } | undefined;
  if (!row?.id) throw new Error('笔记不存在');
  const normalized = normalizeTags(tags);
  db.prepare('UPDATE notes SET tags = ? WHERE id = ?').run(JSON.stringify(normalized), id);
  return { ok: true, tags: normalized };
}

// ---------------------------------------------------------------------------
// trash：回收站（移入/恢复/彻底删除/批量移入）
// ---------------------------------------------------------------------------

/** 软删除（移入回收站）：单条 UPDATE，不开事务；引用图缓存由 Store 注入的回调失效。 */
export function deleteNote(db: DatabaseSync, deps: NoteDomainDeps, id: string): void {
  const result = db.prepare('UPDATE notes SET deleted = 1 WHERE id = ? AND deleted = 0').run(id);
  if (result.changes === 0) throw new Error('笔记不存在');
  deps.invalidateReferenceGraphCache();
}

/** 从回收站恢复：单条 UPDATE，不开事务。 */
export function restoreNote(db: DatabaseSync, deps: NoteDomainDeps, id: string): void {
  const result = db.prepare('UPDATE notes SET deleted = 0 WHERE id = ?').run(id);
  if (result.changes === 0) throw new Error('笔记不存在');
  deps.invalidateReferenceGraphCache();
}

/**
 * 彻底删除笔记（含回收站里的）+ 回收其独占图片资源；不存在的笔记返回 404 语义。
 *
 * 事务边界：notes 行与 note_asset_refs 同成同败（一个事务）；提交后再经 deps 让
 * note-assets 重算计数、回收独占文件（与原实现一致，文件失败不回滚数据库）。
 */
export function purgeNote(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  id: string
): NotePurgeResult {
  const row = db.prepare('SELECT id FROM notes WHERE id = ?').get(id) as
    | { id?: string }
    | undefined;
  if (!row?.id) throw new Error('笔记不存在');
  const affected = (
    db
      .prepare('SELECT asset_id FROM note_asset_refs WHERE source_kind = ? AND source_id = ?')
      .all('note', id) as unknown as Array<{ asset_id: string }>
  ).map((ref) => ref.asset_id);
  const transaction = beginTransaction(db);
  try {
    db.prepare('DELETE FROM note_asset_refs WHERE source_kind = ? AND source_id = ?').run(
      'note',
      id
    );
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
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

/** 批量软删除独立笔记（回收站）；幂等，返回实际删除条数（已是删除态不计）。 */
export function batchDeleteStandaloneNotes(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  ids: string[]
): { ok: boolean; deleted: number } {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new Error('需要笔记 id 字符串数组');
  }
  const ordered = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const remove = db.prepare(
    `UPDATE notes SET deleted = 1
     WHERE id = ? AND deleted = 0 AND (document_id = '' OR document_id IS NULL)`
  );
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ordered) {
      const result = remove.run(id);
      if (Number(result.changes ?? 0) > 0) deleted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (deleted > 0) deps.invalidateReferenceGraphCache();
  return { ok: true, deleted };
}

// ---------------------------------------------------------------------------
// folder：笔记虚拟文件夹（note_folders + notes.folder_path）
// ---------------------------------------------------------------------------

/** 从 notes.folder_path 回填 note_folders（含祖先目录）；幂等，迁移/启动时调用。 */
export function backfillNoteFolders(db: DatabaseSync, deps: NoteDomainDeps): void {
  const rows = db
    .prepare(
      "SELECT DISTINCT folder_path FROM notes WHERE folder_path IS NOT NULL AND folder_path <> ''"
    )
    .all() as unknown as Array<{ folder_path?: string | null }>;
  if (rows.length === 0) return;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_folders(path, created_at) VALUES (?, ?)'
  );
  const now = deps.now();
  const paths = new Set<string>();
  for (const row of rows) {
    const folder = String(row.folder_path ?? '');
    if (!folder) continue;
    const segments = folder.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      paths.add(segments.slice(0, index).join('/'));
    }
  }
  for (const folderPath of paths) insert.run(folderPath, now);
}

/** notes.folder_path（含回收站笔记）里出现的路径及其所有祖先（隐式文件夹）。 */
function implicitNoteFolderPaths(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      "SELECT DISTINCT folder_path FROM notes WHERE folder_path IS NOT NULL AND folder_path <> ''"
    )
    .all() as unknown as Array<{ folder_path?: string | null }>;
  const paths = new Set<string>();
  for (const row of rows) {
    const folder = String(row.folder_path ?? '');
    if (!folder) continue;
    const segments = folder.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      paths.add(segments.slice(0, index).join('/'));
    }
  }
  return paths;
}

/**
 * 列出笔记虚拟文件夹（不含根 ''；空文件夹也返回；noteCount 只统计未删除笔记）。
 *
 * 除 note_folders 里显式登记的行，还包含「隐式文件夹」：notes.folder_path（含回收站笔记）
 * 中出现的路径及其所有祖先。这样 Markdown 导入直接写入 folder_path 的目录也能被
 * 重命名/删除，而不是报「文件夹不存在」。
 */
export function listNoteFolders(db: DatabaseSync): NoteFolderRecord[] {
  const explicit = db
    .prepare('SELECT path, created_at FROM note_folders')
    .all() as unknown as Array<{ path: string; created_at: string }>;
  const counts = db
    .prepare(
      `SELECT folder_path AS path, COUNT(*) AS n FROM notes
       WHERE deleted = 0 AND folder_path IS NOT NULL AND folder_path <> ''
       GROUP BY folder_path`
    )
    .all() as unknown as Array<{ path: string; n: number }>;
  const countByPath = new Map(counts.map((row) => [String(row.path ?? ''), Number(row.n ?? 0)]));
  const merged = new Map<string, NoteFolderRecord>();
  for (const row of explicit) {
    const folderPath = String(row.path ?? '');
    if (!folderPath) continue;
    merged.set(folderPath, {
      path: folderPath,
      noteCount: countByPath.get(folderPath) ?? 0,
      createdAt: String(row.created_at ?? '')
    });
  }
  for (const folderPath of implicitNoteFolderPaths(db)) {
    if (merged.has(folderPath)) continue;
    merged.set(folderPath, {
      path: folderPath,
      noteCount: countByPath.get(folderPath) ?? 0,
      createdAt: ''
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

/** 文件夹是否存在：显式登记、隐式笔记路径或作为更短路径的祖先。 */
function folderPathExists(db: DatabaseSync, folderPath: string): boolean {
  if (!folderPath) return true;
  const row = db.prepare('SELECT path FROM note_folders WHERE path = ?').get(folderPath) as
    | { path?: string }
    | undefined;
  if (row?.path) return true;
  const note = db
    .prepare(
      `SELECT 1 AS found FROM notes
       WHERE folder_path = ? OR folder_path LIKE ? ESCAPE '\\' LIMIT 1`
    )
    .get(folderPath, `${escapeLike(folderPath)}/%`) as { found?: number } | undefined;
  return Boolean(note?.found);
}

function insertFolderWithAncestors(
  folderPath: string,
  insert: (path: string, createdAt: string) => void,
  createdAt: string
): void {
  const segments = folderPath.split('/').filter(Boolean);
  for (let index = 1; index <= segments.length; index += 1) {
    insert(segments.slice(0, index).join('/'), createdAt);
  }
}

/**
 * 确保文件夹路径及其所有祖先都已登记到 note_folders（INSERT OR IGNORE）。
 * Markdown 导入每条笔记写入前、createNote/updateNote 指定 folderPath 时调用。
 *
 * 单条 INSERT OR IGNORE，不开事务：Markdown 导入在外层事务里调用它是安全的。
 */
export function ensureNoteFolderHierarchy(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  folderPath: string
): void {
  const normalized = normalizeFolderPath(folderPath);
  if (!normalized) return;
  const now = deps.now();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_folders(path, created_at) VALUES (?, ?)'
  );
  insertFolderWithAncestors(
    normalized,
    (pathValue, createdAt) => {
      insert.run(pathValue, createdAt);
    },
    now
  );
}

/** 创建笔记文件夹（自动创建祖先）；已存在时幂等返回现有记录。 */
export function createNoteFolder(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  folderPath: string
): NoteFolderRecord {
  const normalized = normalizeFolderPath(folderPath);
  if (!normalized) throw new Error('需要文件夹路径');
  const now = deps.now();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_folders(path, created_at) VALUES (?, ?)'
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    insertFolderWithAncestors(
      normalized,
      (pathValue, createdAt) => {
        insert.run(pathValue, createdAt);
      },
      now
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const row = db
    .prepare('SELECT created_at FROM note_folders WHERE path = ?')
    .get(normalized) as { created_at?: string } | undefined;
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0 AND folder_path = ?')
    .get(normalized) as { n?: number } | undefined;
  return {
    path: normalized,
    noteCount: Number(count?.n ?? 0),
    createdAt: String(row?.created_at ?? now)
  };
}

/**
 * 重命名/合并文件夹子树：同步更新 note_folders 与 notes.folder_path。
 *
 * 目标不存在时等价重命名；目标已存在时**合并**：源子树前缀替换为目标前缀后并入目标
 * 子树（同路径笔记允许共存），删除源子树行，保留目标原有空目录；返回移动的笔记数。
 * 目标位于源子树内仍拒绝（避免自我包含）。
 */
export function renameNoteFolder(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  from: string,
  to: string
): NoteFolderOperationResult {
  const source = normalizeFolderPath(from);
  const target = normalizeFolderPath(to);
  if (!source) throw new Error('需要文件夹路径');
  if (!target) throw new Error('目标文件夹路径无效');
  if (!folderPathExists(db, source)) throw new Error('文件夹不存在');
  if (source === target) return { ok: true, movedNotes: 0 };
  if (target.startsWith(`${source}/`)) throw new Error('不能重命名到自己的子文件夹');
  const merging = folderPathExists(db, target);
  const prefixPattern = `${escapeLike(source)}/%`;
  const now = deps.now();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_folders(path, created_at) VALUES (?, ?)'
  );
  let movedNotes = 0;
  let movedDeletedNotes = 0;
  const affectedNotes: Array<{ id: string; folderPath: string }> = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    insertFolderWithAncestors(
      target,
      (pathValue, createdAt) => {
        insert.run(pathValue, createdAt);
      },
      now
    );
    const folders = db
      .prepare(
        `SELECT path, created_at FROM note_folders
         WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY length(path)`
      )
      .all(source, prefixPattern) as unknown as Array<{ path: string; created_at: string }>;
    if (merging) {
      // 合并：先并入目标子树（INSERT OR IGNORE，已存在路径保留原 created_at），再删源行。
      for (const folder of folders) {
        const current = String(folder.path ?? '');
        insert.run(`${target}${current.slice(source.length)}`, String(folder.created_at ?? now));
      }
      for (const folder of folders) {
        db.prepare('DELETE FROM note_folders WHERE path = ?').run(String(folder.path ?? ''));
      }
    } else {
      // 重命名：先删源行再插新行，避免目标祖先已存在时 UPDATE 触发 path 唯一约束冲突。
      for (const folder of folders) {
        db.prepare('DELETE FROM note_folders WHERE path = ?').run(String(folder.path ?? ''));
      }
      for (const folder of folders) {
        const current = String(folder.path ?? '');
        insert.run(`${target}${current.slice(source.length)}`, String(folder.created_at ?? now));
      }
    }
    const notes = db
      .prepare(
        `SELECT id, folder_path, deleted FROM notes
         WHERE folder_path = ? OR folder_path LIKE ? ESCAPE '\\'`
      )
      .all(source, prefixPattern) as unknown as Array<{
      id: string;
      folder_path: string;
      deleted: number;
    }>;
    const updateNoteFolder = db.prepare('UPDATE notes SET folder_path = ? WHERE id = ?');
    for (const note of notes) {
      const current = String(note.folder_path ?? '');
      const nextFolderPath = `${target}${current.slice(source.length)}`;
      updateNoteFolder.run(nextFolderPath, note.id);
      affectedNotes.push({ id: note.id, folderPath: nextFolderPath });
      if (Number(note.deleted ?? 0) === 1) movedDeletedNotes += 1;
      else movedNotes += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    ok: true,
    movedNotes,
    movedDeletedNotes,
    folders: listNoteFolders(db),
    notes: affectedNotes
  };
}

/**
 * 删除笔记文件夹（含隐式文件夹）：删除整棵子树，但笔记不丢。
 *
 * - path 直接下属笔记移动到其父文件夹（path 无父则根 ''）；
 * - 子文件夹整体上移一级（保持层级与笔记），空子文件夹目录也保留；
 * - 删除 path 及子树的 note_folders 行，并把上移后的子文件夹重新登记；
 * - 回收站里的笔记同样移动（计入 movedDeletedNotes）。
 *
 * 仅当 path 既无笔记也无 note_folders 行时抛「文件夹不存在」。
 */
export function deleteNoteFolder(
  db: DatabaseSync,
  deps: NoteDomainDeps,
  folderPath: string
): NoteFolderOperationResult {
  const target = normalizeFolderPath(folderPath);
  if (!target) throw new Error('需要文件夹路径');
  if (!folderPathExists(db, target)) throw new Error('文件夹不存在');
  const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
  const prefixPattern = `${escapeLike(target)}/%`;
  let movedNotes = 0;
  let movedDeletedNotes = 0;
  const affectedNotes: Array<{ id: string; folderPath: string }> = [];
  const now = deps.now();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_folders(path, created_at) VALUES (?, ?)'
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    const folders = db
      .prepare(
        `SELECT path, created_at FROM note_folders
         WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY length(path)`
      )
      .all(target, prefixPattern) as unknown as Array<{ path: string; created_at: string }>;
    const notes = db
      .prepare(
        `SELECT id, folder_path, deleted FROM notes
         WHERE folder_path = ? OR folder_path LIKE ? ESCAPE '\\'`
      )
      .all(target, prefixPattern) as unknown as Array<{
      id: string;
      folder_path: string;
      deleted: number;
    }>;
    // 删除文件夹：直接笔记上移到父级，子文件夹整体上移一级（路径前缀替换）。
    const updateNoteFolder = db.prepare('UPDATE notes SET folder_path = ? WHERE id = ?');
    for (const note of notes) {
      const current = String(note.folder_path ?? '');
      const nextFolderPath = normalizeFolderPath(`${parent}${current.slice(target.length)}`);
      updateNoteFolder.run(nextFolderPath, note.id);
      affectedNotes.push({ id: note.id, folderPath: nextFolderPath });
      if (Number(note.deleted ?? 0) === 1) movedDeletedNotes += 1;
      else movedNotes += 1;
    }
    // 删除原子树行，再登记父级与上移后的子文件夹（保留空目录层级）。
    for (const folder of folders) {
      db.prepare('DELETE FROM note_folders WHERE path = ?').run(String(folder.path ?? ''));
    }
    if (parent) {
      insertFolderWithAncestors(
        parent,
        (pathValue, createdAt) => {
          insert.run(pathValue, createdAt);
        },
        now
      );
    }
    for (const folder of folders) {
      const current = String(folder.path ?? '');
      if (current === target) continue;
      const nextFolderPath = normalizeFolderPath(`${parent}${current.slice(target.length)}`);
      if (!nextFolderPath) continue;
      insert.run(nextFolderPath, String(folder.created_at ?? now));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    ok: true,
    movedNotes,
    movedDeletedNotes,
    folders: listNoteFolders(db),
    notes: affectedNotes
  };
}

/** 把笔记移动到指定文件夹（'' = 根目录；目标文件夹必须存在）。单条 UPDATE，不开事务。 */
export function moveNoteToFolder(
  db: DatabaseSync,
  id: string,
  folderPath: string
): { ok: boolean; folders: NoteFolderRecord[]; notes: Array<{ id: string; folderPath: string }> } {
  const row = db.prepare('SELECT id FROM notes WHERE id = ?').get(id) as
    | { id?: string }
    | undefined;
  if (!row?.id) throw new Error('笔记不存在');
  const normalized = normalizeFolderPath(folderPath);
  if (normalized && !folderPathExists(db, normalized)) throw new Error('目标文件夹不存在');
  db.prepare('UPDATE notes SET folder_path = ? WHERE id = ?').run(normalized, id);
  return {
    ok: true,
    folders: listNoteFolders(db),
    notes: [{ id, folderPath: normalized }]
  };
}

/**
 * 批量移动独立笔记到指定文件夹（'' = 根目录；目标可以是已有或隐式文件夹）。
 * 返回实际移动条数（只统计未删除的独立笔记）。
 */
export function batchMoveStandaloneNotes(
  db: DatabaseSync,
  ids: string[],
  folderPath: string
): {
  ok: boolean;
  moved: number;
  folders: NoteFolderRecord[];
  notes: Array<{ id: string; folderPath: string }>;
} {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new Error('需要笔记 id 字符串数组');
  }
  const folder = normalizeFolderPath(folderPath);
  if (folder && !folderPathExists(db, folder)) throw new Error('目标文件夹不存在');
  const ordered = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const move = db.prepare(
    `UPDATE notes SET folder_path = ?
     WHERE id = ? AND deleted = 0 AND (document_id = '' OR document_id IS NULL)`
  );
  let moved = 0;
  const notes: Array<{ id: string; folderPath: string }> = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ordered) {
      const result = move.run(folder, id);
      if (Number(result.changes ?? 0) > 0) {
        moved += 1;
        notes.push({ id, folderPath: folder });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, moved, folders: listNoteFolders(db), notes };
}

// ---------------------------------------------------------------------------
// manualOrder：独立笔记手动排序（notes.manual_order）
// ---------------------------------------------------------------------------

/**
 * 回填笔记默认排序（schema_version 19）：仅在"有笔记但所有 manual_order 都是 0"时执行
 * （刚加列或半迁移）。按 rowid 递增赋 1..N，顺序即升级前的默认顺序；已迁移的库不会重复回填。
 *
 * 无事务边界：必须运行在 migrate() 的事务里（与原来一致）。
 */
export function backfillNoteManualOrder(db: DatabaseSync): void {
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n?: number } | undefined)?.n ?? 0
  );
  if (total === 0) return;
  const nonZero = Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM notes WHERE manual_order <> 0').get() as
        | { n?: number }
        | undefined
    )?.n ?? 0
  );
  if (nonZero > 0) return;
  const rows = db.prepare('SELECT id FROM notes ORDER BY rowid ASC').all() as unknown as Array<{
    id: string;
  }>;
  const update = db.prepare('UPDATE notes SET manual_order = ? WHERE id = ?');
  rows.forEach((row, index) => update.run(index + 1, row.id));
}

/** 新笔记的默认排序位置：当前文件夹内追加到末尾（同名文件夹下 MAX+1）。纯读，不开事务。 */
export function nextNoteManualOrder(db: DatabaseSync, folderPath: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(manual_order), 0) + 1 AS value FROM notes WHERE folder_path = ?')
    .get(folderPath) as { value?: number } | undefined;
  return Number(row?.value ?? 1);
}

/**
 * 重排某文件夹内独立笔记：ids 为该文件夹内的目标顺序，只处理属于该 folderPath 的 id，
 * 按数组下标（从 1 开始）写 manual_order（事务）。
 */
export function reorderStandaloneNotes(
  db: DatabaseSync,
  folderPath: string,
  ids: string[]
): { ok: boolean; folders: NoteFolderRecord[]; notes: Array<{ id: string; folderPath: string }> } {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new Error('需要笔记 id 字符串数组');
  }
  const folder = normalizeFolderPath(folderPath);
  const ordered = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const lookup = db.prepare(
    `SELECT id FROM notes
     WHERE id = ? AND deleted = 0 AND (document_id = '' OR document_id IS NULL) AND folder_path = ?`
  );
  const update = db.prepare('UPDATE notes SET manual_order = ? WHERE id = ?');
  const notes: Array<{ id: string; folderPath: string }> = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    let position = 0;
    for (const id of ordered) {
      const row = lookup.get(id, folder) as { id?: string } | undefined;
      if (!row?.id) continue;
      position += 1;
      update.run(position, id);
      notes.push({ id, folderPath: folder });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, folders: listNoteFolders(db), notes };
}
