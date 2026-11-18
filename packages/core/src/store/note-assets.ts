import { existsSync, opendirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  NoteAssetGcReport,
  NoteAssetReindexResult,
  NoteAssetUsage,
  NotePurgeResult,
  SettingsMap
} from '@studianda/shared';
import { extractNoteAssetFilenames } from '@studianda/shared';

/**
 * 笔记资源域（note_assets / note_asset_refs + `<dataDir>/note-assets` 目录）。
 *
 * 从 store.ts 拆出的第二个域（第一个是 store/projects.ts）。拆分约定：
 * - 纯函数 + 显式依赖注入：第一个参数是 SQLite 句柄 `db`，非 DB 依赖放 `deps`
 *   （`now()` / `uuid()` / 资源目录与 settings 读写），绝不接收 `Store` 实例。
 * - 私有辅助（行映射、SQL、白名单常量、目录流式遍历）一起搬到这里，
 *   不反向引用 store.ts 的私有成员。
 * - Store 上的同名方法只剩一层薄委托，调用方与返回结构不变。
 *
 * **事务不变量（必须遵守，改这里之前先读）：**
 * - `syncSource` / `replaceSourceRefs` / `refreshCounts` 只写 refs 与计数，
 *   **必须在调用方已打开的事务里、用同一个 `db` 连接执行**；它们自己绝不
 *   BEGIN / COMMIT / ROLLBACK。原因：笔记/批注的内容写入与 refs 同步必须同成同败
 *   （见 createNote / updateNote / createAnnotation，失败要整条回滚）。
 * - `rebuildRefs` 是全量重建入口，自己管理事务；迁移外层已有事务时传
 *   `manageTransaction=false`，让 settings 统计写回也加入外层事务。
 * - `purgeRecords` / `gc` 直接作用在磁盘与登记表上，逐条幂等语句、不开事务：
 *   删除失败保留登记行，下次 GC 再试（与原实现一致）。
 */

/** 资源来源类型：笔记或批注（note_asset_refs.source_kind）。 */
export type NoteSourceKind = 'note' | 'annotation';

/** 笔记图片资源：MIME → 落盘扩展名；同时用作白名单。 */
export const NOTE_ASSET_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/** 资源目录名（相对数据目录）。 */
export const NOTE_ASSET_DIR = 'note-assets';

/** 反向映射：扩展名 → MIME（迁移回填/磁盘孤儿登记/附件导入用）。 */
export const NOTE_ASSET_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
};

/** 本域真正需要的非 DB 依赖；由 Store（或直接调用本模块的测试）显式传入。 */
export interface NoteAssetDeps {
  /** 资源目录绝对路径（`<dataDir>/note-assets`）；本模块的磁盘读写都只在这里。 */
  assetDir: string;
  /** 当前时间（ISO 文本）。默认实现与 Store 原来的 `new Date().toISOString()` 一致。 */
  now: () => string;
  /** 新建资源行 id。默认实现与 Store 原来的 `randomUUID()` 一致。 */
  uuid: () => string;
  /** 读 settings（`note_assets.*` 统计键）。 */
  readSettings: () => SettingsMap;
  /**
   * 写 settings；`manageTransaction=false` 时加入调用方事务（迁移回填场景），
   * 与 Store.updateSettings 的开关语义一致。
   */
  updateSettings: (patch: SettingsMap, manageTransaction?: boolean) => void;
}

/** settings 索引统计键：读写两处共用，避免手写字符串漂移。 */
const INDEXED_AT_KEY = 'note_assets.indexed_at';
const INDEXED_FILES_KEY = 'note_assets.indexed_files';
const INDEXED_REFS_KEY = 'note_assets.indexed_refs';
const LAST_GC_KEY = 'note_assets.last_gc';

/** 解析整数设置：非法/缺失/越界一律回退默认值（与 Store/budget.ts 同口径）。 */
function integerSetting(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = (raw ?? '').trim();
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** 按文件名登记资源行（已存在直接返回 asset_id；缺文件也登记，size 0）。 */
export function ensureAssetRecord(db: DatabaseSync, deps: NoteAssetDeps, filename: string): string {
  const existing = db
    .prepare('SELECT asset_id FROM note_assets WHERE filename = ?')
    .get(filename) as { asset_id?: string } | undefined;
  if (existing?.asset_id) return existing.asset_id;
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = NOTE_ASSET_MIME_BY_EXT[ext] ?? '';
  let size = 0;
  const filePath = path.join(deps.assetDir, filename);
  try {
    if (existsSync(filePath)) size = statSync(filePath).size;
  } catch {
    size = 0;
  }
  const assetId = deps.uuid();
  db.prepare(
    `INSERT OR IGNORE INTO note_assets(asset_id, filename, mime, size_bytes)
     VALUES (?, ?, ?, ?)`
  ).run(assetId, filename, mime, size);
  const row = db
    .prepare('SELECT asset_id FROM note_assets WHERE filename = ?')
    .get(filename) as { asset_id?: string } | undefined;
  return row?.asset_id ?? assetId;
}

/**
 * 把一条来源（笔记/批注）的 refs 替换为给定资源集合：先删旧 refs，再插新 refs。
 *
 * **调用方必须已打开事务**（本函数只发语句，不管理事务），见文件头事务不变量。
 */
export function replaceSourceRefs(
  db: DatabaseSync,
  kind: NoteSourceKind,
  sourceId: string,
  assetIds: Iterable<string>
): void {
  db.prepare('DELETE FROM note_asset_refs WHERE source_kind = ? AND source_id = ?').run(
    kind,
    sourceId
  );
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_asset_refs(asset_id, source_kind, source_id) VALUES (?, ?, ?)'
  );
  for (const assetId of new Set(assetIds)) insert.run(assetId, kind, sourceId);
}

/**
 * 重算受影响资源的 ref_count / last_referenced（last 取引用来源的最大 created）。
 *
 * **调用方必须已打开事务**（本函数只发语句，不管理事务），见文件头事务不变量。
 */
export function refreshCounts(db: DatabaseSync, assetIds: Iterable<string>): void {
  const countStatement = db.prepare('SELECT COUNT(*) AS n FROM note_asset_refs WHERE asset_id = ?');
  const lastStatement = db.prepare(
    `SELECT MAX(created) AS last FROM (
       SELECT n.created AS created FROM note_asset_refs r
         JOIN notes n ON n.id = r.source_id
        WHERE r.asset_id = ? AND r.source_kind = 'note'
       UNION ALL
       SELECT a.created AS created FROM note_asset_refs r
         JOIN annotations a ON a.id = r.source_id
        WHERE r.asset_id = ? AND r.source_kind = 'annotation'
     )`
  );
  const update = db.prepare(
    'UPDATE note_assets SET ref_count = ?, last_referenced = ? WHERE asset_id = ?'
  );
  for (const assetId of new Set(assetIds)) {
    const count = Number((countStatement.get(assetId) as { n?: number } | undefined)?.n ?? 0);
    const last = count
      ? String(
          (lastStatement.get(assetId, assetId) as { last?: string } | undefined)?.last ?? ''
        )
      : '';
    update.run(count, last, assetId);
  }
}

/**
 * 同步一条笔记/批注的资源引用：先删旧 refs，再按当前内容插入新 refs。
 * 只影响被删/新增的资源计数，不做全量扫描。
 *
 * **调用方必须已打开事务**（本函数只发语句，不管理事务），见文件头事务不变量。
 */
export function syncSource(
  db: DatabaseSync,
  kind: NoteSourceKind,
  sourceId: string,
  content: string,
  deps: NoteAssetDeps
): void {
  const old = db
    .prepare('SELECT asset_id FROM note_asset_refs WHERE source_kind = ? AND source_id = ?')
    .all(kind, sourceId) as unknown as Array<{ asset_id: string }>;
  const affected = new Set<string>(old.map((row) => row.asset_id));
  const next: string[] = [];
  for (const filename of extractNoteAssetFilenames(content ?? '')) {
    const assetId = ensureAssetRecord(db, deps, filename);
    next.push(assetId);
    affected.add(assetId);
  }
  replaceSourceRefs(db, kind, sourceId, next);
  refreshCounts(db, affected);
}

/** 全量重建资源登记与引用（迁移回填 / 旧库导入后调用；幂等，整体事务化）。
 *  迁移外层已有事务时传 false，避免 SQLite 嵌套事务报错。 */
export function rebuildRefs(
  db: DatabaseSync,
  deps: NoteAssetDeps,
  manageTransaction = true
): void {
  let filesSeen = 0;
  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (existsSync(deps.assetDir)) {
      // 只同步复制文件名列表（目录可能很大，不要把 Dirent 留到整段扫描结束）。
      let names: string[] = [];
      try {
        names = readdirSync(deps.assetDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        names = [];
      }
      for (const name of names) {
        filesSeen += 1;
        ensureAssetRecord(db, deps, name);
      }
    }
    db.exec('DELETE FROM note_asset_refs');
    db.exec("UPDATE note_assets SET ref_count = 0, last_referenced = ''");
    const notes = db
      .prepare('SELECT id, content FROM notes')
      .all() as unknown as Array<{ id: string; content: string | null }>;
    const annotations = db
      .prepare('SELECT id, content FROM annotations')
      .all() as unknown as Array<{ id: string; content: string | null }>;
    for (const note of notes) syncSource(db, 'note', note.id, note.content ?? '', deps);
    for (const annotation of annotations) {
      syncSource(db, 'annotation', annotation.id, annotation.content ?? '', deps);
    }
    if (manageTransaction) db.exec('COMMIT');
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK');
    throw error;
  }
  // 记录本次索引统计（迁移提示用）：扫描文件数 + 建立的引用条数，幂等覆盖。
  const refCount = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM note_asset_refs').get() as { n?: number })?.n ?? 0
  );
  try {
    deps.updateSettings(
      {
        [INDEXED_AT_KEY]: deps.now(),
        [INDEXED_FILES_KEY]: String(filesSeen),
        [INDEXED_REFS_KEY]: String(refCount)
      },
      manageTransaction
    );
  } catch {
    // 统计写入失败不影响索引重建本身。
  }
}

/** 至少有一条「未删除来源」引用的资源文件名集合（usage.active / GC includeDeleted=false 共用）。 */
function activeReferencedAssetFilenames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT na.filename AS filename
       FROM note_assets na
       JOIN note_asset_refs r ON r.asset_id = na.asset_id
       LEFT JOIN notes n ON r.source_kind = 'note' AND n.id = r.source_id
       LEFT JOIN annotations a ON r.source_kind = 'annotation' AND a.id = r.source_id
       WHERE (r.source_kind = 'note' AND n.deleted = 0)
          OR (r.source_kind = 'annotation' AND a.deleted = 0)`
    )
    .all() as unknown as Array<{ filename: string }>;
  return new Set(rows.map((row) => row.filename));
}

/**
 * 裁剪登记表里磁盘文件已不存在的行（连同 refs）。幂等；只用于 GC 真删阶段，
 * 不参与 report 统计（这些行本来就不对应磁盘文件）。
 */
function pruneMissingAssets(db: DatabaseSync, deps: NoteAssetDeps): void {
  const dir = deps.assetDir;
  const resolvedDir = path.resolve(dir);
  const rows = db
    .prepare('SELECT asset_id, filename FROM note_assets')
    .all() as unknown as Array<{ asset_id: string; filename: string }>;
  const deleteRefs = db.prepare('DELETE FROM note_asset_refs WHERE asset_id = ?');
  const deleteAsset = db.prepare('DELETE FROM note_assets WHERE asset_id = ?');
  for (const row of rows) {
    const filename = String(row.filename ?? '');
    const safeName = filename && path.basename(filename) === filename;
    const filePath = safeName ? path.resolve(dir, filename) : '';
    if (!safeName || path.dirname(filePath) !== resolvedDir || !existsSync(filePath)) {
      deleteRefs.run(row.asset_id);
      deleteAsset.run(row.asset_id);
    }
  }
}

/**
 * 资源彻底回收：仅处理 ref_count 已为 0 且文件存在的资源，删文件 + 删登记行。
 * 用于彻底删除笔记/文献后立即释放其独占图片。
 */
export function purgeRecords(
  db: DatabaseSync,
  deps: NoteAssetDeps,
  assetIds: Iterable<string>
): NotePurgeResult {
  const result: NotePurgeResult = { freedAssets: 0, freedBytes: 0 };
  const dir = deps.assetDir;
  const resolvedDir = path.resolve(dir);
  const countStatement = db.prepare('SELECT COUNT(*) AS n FROM note_asset_refs WHERE asset_id = ?');
  for (const assetId of new Set(assetIds)) {
    const count = Number((countStatement.get(assetId) as { n?: number } | undefined)?.n ?? 0);
    if (count > 0) continue;
    const row = db
      .prepare('SELECT filename, size_bytes FROM note_assets WHERE asset_id = ?')
      .get(assetId) as { filename?: string; size_bytes?: number } | undefined;
    if (!row) continue;
    const filename = String(row.filename ?? '');
    if (!filename || path.basename(filename) !== filename) {
      // 不安全的文件名：只清登记与 refs，不碰磁盘。
      db.prepare('DELETE FROM note_asset_refs WHERE asset_id = ?').run(assetId);
      db.prepare('DELETE FROM note_assets WHERE asset_id = ?').run(assetId);
      continue;
    }
    const filePath = path.resolve(dir, filename);
    if (path.dirname(filePath) === resolvedDir && existsSync(filePath)) {
      try {
        const size = statSync(filePath).size;
        unlinkSync(filePath);
        result.freedBytes += size;
      } catch {
        // 删除失败：保留登记行，下次 GC 再试。
        continue;
      }
    }
    db.prepare('DELETE FROM note_asset_refs WHERE asset_id = ?').run(assetId);
    db.prepare('DELETE FROM note_assets WHERE asset_id = ?').run(assetId);
    result.freedAssets += 1;
  }
  return result;
}

/**
 * 清理没有被任何笔记/批注引用的本地图片资源。
 *
 * 引用判断优先用 `note_assets`/`note_asset_refs`：挂表时 ref_count>0 视为被引用；
 * includeDeleted 默认 true（含已删除笔记/批注，restore-safe），false 时忽略 deleted=1
 * 来源的引用，允许清理只被已删除内容引用的文件。磁盘上但表中没有的文件按孤儿处理。
 * 删除条件仍是「无引用 + mtime 早于 graceMs（默认 24h）」；dryRun 只统计不删；
 * 非 dryRun 完成后写 settings `note_assets.last_gc`（ISO 时间）。只处理目录内普通文件。
 */
export function gc(
  db: DatabaseSync,
  deps: NoteAssetDeps,
  input?: { dryRun?: boolean; graceMs?: number; includeDeleted?: boolean }
): NoteAssetGcReport {
  const dryRun = input?.dryRun === true;
  const includeDeleted = input?.includeDeleted !== false;
  const graceMs =
    typeof input?.graceMs === 'number' && Number.isFinite(input.graceMs) && input.graceMs >= 0
      ? input.graceMs
      : 24 * 60 * 60 * 1000;
  const report: NoteAssetGcReport = {
    scannedFiles: 0,
    referencedFiles: 0,
    deletedFiles: 0,
    keptFiles: 0,
    skippedRecent: 0,
    bytesFreed: 0
  };
  // 真删阶段先裁剪「登记表有行、磁盘文件已不存在」的残留（幂等，不影响报告数字）。
  if (!dryRun) pruneMissingAssets(db, deps);
  const assetRows = db
    .prepare('SELECT asset_id, filename, ref_count FROM note_assets')
    .all() as unknown as Array<{ asset_id: string; filename: string; ref_count: number }>;
  const assetIdByFilename = new Map(assetRows.map((row) => [row.filename, row.asset_id]));
  const referenced = new Set<string>();
  if (includeDeleted) {
    for (const row of assetRows) {
      if (Number(row.ref_count) > 0) referenced.add(row.filename);
    }
  } else {
    for (const filename of activeReferencedAssetFilenames(db)) referenced.add(filename);
  }
  const dir = deps.assetDir;
  const finish = (): NoteAssetGcReport => {
    if (!dryRun) {
      try {
        deps.updateSettings({ [LAST_GC_KEY]: deps.now() });
      } catch {
        // 写 last_gc 失败不影响清理结果。
      }
    }
    return report;
  };
  if (!existsSync(dir)) return finish();
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return finish();
  }
  const resolvedDir = path.resolve(dir);
  const now = Date.now();
  const deleteRefs = db.prepare('DELETE FROM note_asset_refs WHERE asset_id = ?');
  const deleteAsset = db.prepare('DELETE FROM note_assets WHERE asset_id = ?');
  for (const entry of entries) {
    // 只处理目录下的普通文件；符号链接/子目录一律跳过。
    if (!entry.isFile()) continue;
    const filePath = path.resolve(dir, entry.name);
    if (path.dirname(filePath) !== resolvedDir) continue;
    report.scannedFiles += 1;
    if (referenced.has(entry.name)) {
      report.referencedFiles += 1;
      report.keptFiles += 1;
      continue;
    }
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      report.keptFiles += 1;
      continue;
    }
    if (now - stats.mtimeMs < graceMs) {
      report.skippedRecent += 1;
      report.keptFiles += 1;
      continue;
    }
    if (dryRun) {
      report.deletedFiles += 1;
      report.bytesFreed += stats.size;
      continue;
    }
    try {
      unlinkSync(filePath);
    } catch {
      // 删除失败（占用/权限）按保留处理，下次 GC 再试。
      report.keptFiles += 1;
      continue;
    }
    report.deletedFiles += 1;
    report.bytesFreed += stats.size;
    const assetId = assetIdByFilename.get(entry.name);
    if (assetId) {
      // 文件已删：同步清掉登记与残留 refs（孤儿引用不再有意义）。
      deleteRefs.run(assetId);
      deleteAsset.run(assetId);
      assetIdByFilename.delete(entry.name);
    }
  }
  return finish();
}

/** 本地图片资源使用统计：文件数/占用/被引用/孤儿/活跃与仅删除引用/上次清理/索引统计。 */
export function usage(db: DatabaseSync, deps: NoteAssetDeps): NoteAssetUsage {
  const dir = deps.assetDir;
  const referenced = new Set(
    (
      db.prepare('SELECT filename FROM note_assets WHERE ref_count > 0').all() as unknown as Array<{
        filename: string;
      }>
    ).map((row) => row.filename)
  );
  const active = activeReferencedAssetFilenames(db);
  let fileCount = 0;
  let totalBytes = 0;
  let referencedFiles = 0;
  let activeReferencedFiles = 0;
  let deletedReferencedFiles = 0;
  if (existsSync(dir)) {
    let entries: Array<{ name: string; isFile: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const resolvedDir = path.resolve(dir);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.resolve(dir, entry.name);
      if (path.dirname(filePath) !== resolvedDir) continue;
      try {
        const size = statSync(filePath).size;
        fileCount += 1;
        totalBytes += size;
        if (referenced.has(entry.name)) {
          referencedFiles += 1;
          // 有任一条未删除来源引用 → active；否则只被已删除内容引用。
          if (active.has(entry.name)) activeReferencedFiles += 1;
          else deletedReferencedFiles += 1;
        }
      } catch {
        // 读不到的文件不计入统计。
      }
    }
  }
  const settings = deps.readSettings();
  const indexedFiles = integerSetting(
    settings[INDEXED_FILES_KEY],
    0,
    Number.MAX_SAFE_INTEGER,
    0
  );
  const indexedRefs = integerSetting(settings[INDEXED_REFS_KEY], 0, Number.MAX_SAFE_INTEGER, 0);
  return {
    fileCount,
    totalBytes,
    referencedFiles,
    orphanFiles: Math.max(0, fileCount - referencedFiles),
    lastGcAt: String(settings[LAST_GC_KEY] ?? ''),
    activeReferencedFiles,
    deletedReferencedFiles,
    indexedAt: String(settings[INDEXED_AT_KEY] ?? ''),
    indexedFiles,
    indexedRefs
  };
}

/**
 * 手动重建资源索引：重新扫描 note-assets 目录与所有笔记/批注内容，修复外部直接改库
 * 造成的 refs 漂移；同时更新并返回 `note_assets.indexed_*` 统计。
 */
export function reindex(db: DatabaseSync, deps: NoteAssetDeps): NoteAssetReindexResult {
  rebuildRefs(db, deps);
  const settings = deps.readSettings();
  return {
    indexedFiles: integerSetting(
      settings[INDEXED_FILES_KEY],
      0,
      Number.MAX_SAFE_INTEGER,
      0
    ),
    indexedRefs: integerSetting(settings[INDEXED_REFS_KEY], 0, Number.MAX_SAFE_INTEGER, 0),
    indexedAt: String(settings[INDEXED_AT_KEY] ?? '')
  };
}

/**
 * 只数资源目录下的普通文件（后台重建的进度分母）。
 * 流式遍历：不一次性把几十万/上百万个文件名都留在内存里。
 */
export function countAssetFiles(assetDir: string): number {
  if (!existsSync(assetDir)) return 0;
  let total = 0;
  let handle: ReturnType<typeof opendirSync> | null = null;
  try {
    handle = opendirSync(assetDir);
    let entry = handle.readSync();
    while (entry) {
      if (entry.isFile()) total += 1;
      entry = handle.readSync();
    }
  } catch {
    return total;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // 目录句柄已被关闭/不可关闭
    }
  }
  return total;
}

/**
 * 流式按批遍历资源目录（每批最多 `batchSize` 个文件名，只含普通文件）。
 *
 * 不一次性持有全部 Dirent；每个满批回调后让出事件循环，避免后台重建长时间
 * 阻塞请求。尾批不足 batchSize 时只回调、不再额外让出（与原实现一致）。
 */
export async function scanAssetFileBatches(
  assetDir: string,
  batchSize: number,
  onBatch: (names: string[]) => void
): Promise<void> {
  if (!existsSync(assetDir)) return;
  let handle: ReturnType<typeof opendirSync> | null = null;
  try {
    handle = opendirSync(assetDir);
    let batch: string[] = [];
    let entry = handle.readSync();
    while (entry) {
      if (entry.isFile()) {
        batch.push(entry.name);
        if (batch.length >= batchSize) {
          onBatch(batch);
          batch = [];
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      entry = handle.readSync();
    }
    onBatch(batch);
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // 目录句柄已被关闭/不可关闭
    }
  }
}
