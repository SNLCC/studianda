import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './store-schema.js';
import * as projectDomain from './store/projects.js';
import * as noteAssets from './store/note-assets.js';
import {
  NOTE_ASSET_DIR,
  NOTE_ASSET_EXT,
  NOTE_ASSET_MIME_BY_EXT
} from './store/note-assets.js';
import * as noteDomain from './store/notes.js';
import { withTransaction as runWithTransaction } from './store/transactions.js';
import * as annotationDomain from './store/annotations.js';
import * as documentDomain from './store/documents.js';
import {
  normalizeKey,
  parsePageEditBoxes,
  type ImportDuplicateCandidate
} from './store/documents.js';
import { NoteAssetReindexer } from './note-asset-reindexer.js';
import {
  highestMetadataSource,
  mergeMetadataField,
  normalizeMetadataSource
} from './metadata-provenance.js';
import { looksLikeAiContent } from '@studianda/shared';
import { buildMarkedMarkdownExport } from './export-marker.js';
import {
  normalizeSnapshotText,
  pageTextRevision,
  selectionSnapshotStatus,
  snapshotStillPresent,
  snapshotTextHash,
  type SelectionSnapshotRecord,
  type SelectionSnapshotStatus
} from './selection-snapshot.js';
import {
  auditSummaryFromResponse,
  parseAuditSummary,
  serializeAuditSummary
} from './chat-audit-summary.js';
import { purgeDocumentRetrievalCaches } from './retrieval.js';
import { loadImage } from '@napi-rs/canvas';
import type {
  AnnotationRecord,
  BacklinkRecord,
  BacklinkTargetKind,
  ChatAuditSummary,
  ChatMessageRecord,
  ChatSource,
  ClearUserDataResult,
  CorpusSessionRecord,
  CreateAnnotationInput,
  CreateNoteInput,
  CreateProjectInput,
  DocumentChatSessionRecord,
  DocumentCategoryCounts,
  DocumentDetail,
  DocumentBlocks,
  DocumentReferences,
  DocumentSectionIndex,
  DocumentSummary,
  FileState,
  FolderOverview,
  FolderSummary,
  LegacyMigrationReport,
  NoteAssetRecord,
  NoteAssetGcReport,
  NoteAssetReindexJob,
  NoteAssetReindexResult,
  NoteAssetUsage,
  NoteFolderOperationResult,
  NoteFolderRecord,
  NotePurgeResult,
  NoteRecord,
  ProjectDeleteResult,
  ProjectDocumentRecord,
  ProjectSummary,
  QuoteLocation,
  ReadingTaskSummary,
  ReferenceEntryInput,
  ReferenceGraph,
  ReferenceGraphCrossEdge,
  ReferenceGraphEdge,
  ReferenceGraphNode,
  ReferenceNodeKind,
  RelinkResult,
  SearchHit,
  SettingsMap,
  TocNavigationPreview,
  TranslationPageRecord,
  TranslationSegmentRecord,
  UpdateAnnotationInput,
  UpdateNoteInput,
  UpdateProjectInput
} from '@studianda/shared';
import {
  REFERENCE_GRAPH_ALL_NODE_LIMIT,
  documentCategoryOf,
  markdownPlainText,
  parseMarkdownInternalLink
} from '@studianda/shared';
import { normalizeDoi } from './pdf-metadata.js';
import {
  parsePdfOffMainThread,
  PdfParseCancelledError,
  type ParsedChunk,
  type ParsedPdf
} from './pdf-worker.js';
import { matchedExcerpt } from './retrieval.js';
import {
  extractPdfLayout,
  type LayoutLine,
  type LayoutPage,
  type OutlineEntry,
  type PdfLayout
} from './pdf-layout.js';
import { locateQuoteOnPage, locateQuote, searchOrder, type LocatedQuote } from './citation.js';
import { buildAnnotatedPdf, type AnnotatedPdfResult } from './annotated-pdf.js';
import { appendErrorLog } from './error-log.js';
import { recognizeBlocks, sectionIndexChunks, type SectionIndexOptions } from './blocks.js';
import {
  applyReferenceEdits,
  recognizeReferences,
  sanitizeReferenceInput,
  type ReferenceEditRecord
} from './references.js';
import { detectTocPages, normalizeTocPages, tocNavigation } from './toc-pages.js';
import {
  documentStructure,
  masksForPage,
  navigationNodes,
  textQuality,
  visibleLines,
  visualNodes,
  type PageMask
} from './structure.js';

const NAV_SYNC_LIMIT = 80;

/**
 * 跨文献会话消息在 `messages` 表里的 document_id 哨兵：空串 = 不属于任何单篇文献。
 *
 * `messages` 确实绑了 document_id：既有读取/删除/编辑/摘要接口都先按 document_id 过滤，
 * 而 `addMessage` 还要求该文献存在。跨文献会话没有单篇归属，所以复用该表时把 document_id
 * 写成空串、只靠 session_id 归属：这些消息不会出现在任何单篇文献的阅读会话里，
 * 单篇文献被彻底删除（purgeDocument 按 document_id 清 messages）时也不会误删它们。
 *
 * schema_version 24 起另写 `messages.scope_kind='corpus'` 显式表达作用域；空串哨兵继续保留
 * 只是为了复用同一张表/同一套 document_id 过滤，**不再是判断作用域的唯一依据**。
 */
const CORPUS_MESSAGE_DOCUMENT_ID = '';

function mapTranslationPage(row: Record<string, unknown>): TranslationPageRecord {
  return {
    documentId: String(row.document_id ?? ''),
    page: Number(row.page ?? 0),
    sourceHash: String(row.source_hash ?? ''),
    engine: String(row.engine ?? ''),
    status: String(row.status ?? 'pending'),
    error: String(row.error ?? ''),
    done: Number(row.done ?? 0),
    total: Number(row.total ?? 0),
    updated: String(row.updated ?? '')
  };
}

function mapTranslationSegment(row: Record<string, unknown>): TranslationSegmentRecord {
  return {
    id: String(row.id ?? ''),
    documentId: String(row.document_id ?? ''),
    page: Number(row.page ?? 0),
    segment: Number(row.segment ?? 0),
    source: String(row.source ?? ''),
    sourceHash: String(row.source_hash ?? ''),
    text: String(row.text ?? ''),
    engine: String(row.engine ?? ''),
    service: String(row.service ?? ''),
    terms: String(row.terms ?? ''),
    unknownTerms: String(row.unknown_terms ?? ''),
    coverage:
      row.coverage === null || row.coverage === undefined ? null : Number(row.coverage),
    edited: Number(row.edited ?? 0) === 1,
    origin: String(row.origin ?? 'machine'),
    previousText: String(row.previous_text ?? ''),
    previousOrigin: String(row.previous_origin ?? '')
  };
}

export interface NavigationStatus {
  state: 'missing' | 'ready' | 'stale' | 'building' | 'failed';
  enabled: boolean;
  nodeCount: number;
  builtAt: string;
  sourceHash: string;
  error: string;
  done: number;
  total: number;
  /** 过期原因：文献文件已变化 / 无关区域规则已变化 / 索引已过期。 */
  stale_reason?: string;
  /** 上次被阅读规划实际使用的时间；未用过为空。 */
  last_used?: string;
  /** 用户指定的「目录页」范围；空数组表示按标题规则/PDF 书签生成。 */
  toc_pages?: number[];
  /** 目录是否为用户手动编辑/保存。 */
  manual?: boolean;
  /** 目录是否为「PDF 内置目录自动保存的本地副本」（勾选启用时自动生成）。 */
  materialized?: boolean;
}

interface NavigationJob {
  state: 'building' | 'done' | 'failed';
  done: number;
  total: number;
  error?: unknown;
}

const navigationJobs = new Map<string, NavigationJob>();

/** 规划上下文最多带多少条目录节点（NAV_PLANNING_LIMIT）。 */
const NAV_PLANNING_LIMIT = 120;

export interface NavigationNode {
  page: number;
  kind: string;
  label: string;
}

/** 规划上下文里的 navigation 字段：未启用/未生成时 nodes 为空并给出中文原因。 */
export interface NavigationPlanningView {
  enabled: boolean;
  state: NavigationStatus['state'];
  nodes: NavigationNode[];
  reason?: string;
}

/** 原因文案：让规划器/界面知道为什么没启用。 */
function navigationReason(status: NavigationStatus): string {
  switch (status.state) {
    case 'missing':
      return status.enabled
        ? '导航索引已启用，但还没有生成：请先生成导航索引'
        : '导航索引未生成（默认关闭，需要手动生成并启用）';
    case 'stale':
      return '导航索引已过期：文献或无关区域规则已变化，请重建导航索引';
    case 'failed':
      return `导航索引生成失败：${status.error || '未知原因'}`;
    case 'building':
      return `导航索引正在生成中：${status.done}/${status.total} 页`;
    case 'ready':
      return '导航索引已生成但未启用';
    default:
      return '导航索引不可用';
  }
}

// 文献域的原始行映射/文件状态/摘要与详情组装已随文献域搬到 ./store/documents.ts
// （DocumentRow / fileStateOf / parseTags / toSummary / toDetail / ImportDuplicateCandidate），
// 本文件不再持有第二份映射。

// 笔记行的映射/规范化辅助已随笔记域搬到 ./store/notes.ts（toNote / normalizeTags /
// parseNoteTags / normalizeFolderPath / normalizeContentOrigin），写路径也已在那边。
// 批注行映射 toAnnotation 与批注写路径同样随批注域搬到 ./store/annotations.ts；
// origin 口径复用 notes.ts 导出的 normalizeContentOrigin，本文件不再持有该映射。

interface SelectionSnapshotRow {
  id: string;
  document_id: string;
  page: number;
  text: string;
  text_hash: string;
  revision: string;
  question: string | null;
  created: string;
}

function toSelectionSnapshot(row: SelectionSnapshotRow): SelectionSnapshotRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    page: Number(row.page ?? 0),
    text: row.text ?? '',
    textHash: row.text_hash ?? '',
    revision: row.revision ?? '',
    question: row.question ?? '',
    created: row.created ?? ''
  };
}

// ParsedChunk / ParsedPdf 与 `parsePdf` 一起搬到 ./pdf-worker.ts：解析只在 worker 线程跑，
// 主线程拿回同一结构的解析结果直接落库。normalizeDoi / extractDoi / XMP 字段读取的
// 唯一实现在 ./pdf-metadata.ts（worker 通过源码投递复用同一份实现）。
// normalizeKey / firstAuthorKey 已随文献域搬到 ./store/documents.ts：题录/查重归一只有一份，
// 导入管线与迁移回填从该模块 import，不在这里复制。

/** LIKE 查询把用户输入当字面量：转义 %、_ 与转义符本身。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 展示用文件名：去掉路径与控制字符，空值回退 `图片.<ext>`。 */
function cleanAssetFilename(raw: string | undefined, ext: string): string {
  const fallback = `图片.${ext}`;
  const segments = (raw ?? '')
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter(Boolean);
  const value = (segments.pop() ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!value || value === '.' || value === '..') return fallback;
  return value;
}

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

/** 按 magic bytes 识别真实图片格式；不认识的返回 null。 */
function detectImageMime(bytes: Uint8Array): keyof typeof NOTE_ASSET_EXT | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head = Buffer.from(bytes.subarray(0, 12)).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (
    bytes.length >= 12 &&
    head.startsWith('RIFF') &&
    Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const MAX_IMAGE_SIDE = 20000;
/** 笔记图片上限默认值与合法范围（设置键 note_image.max_mb / note_image.max_pixels）。 */
const NOTE_IMAGE_DEFAULT_MAX_MB = 2;
const NOTE_IMAGE_MIN_MAX_MB = 1;
const NOTE_IMAGE_MAX_MAX_MB = 20;
const NOTE_IMAGE_DEFAULT_MAX_PIXELS = 8_000_000;
const NOTE_IMAGE_MIN_MAX_PIXELS = 1;
const NOTE_IMAGE_MAX_MAX_PIXELS = 25_000_000;

/** 解析整数设置：非法/缺失/越界一律回退默认值。 */
function integerSetting(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = (raw ?? '').trim();
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export interface NoteImageLimits {
  /** 单图最大字节数（由 note_image.max_mb 换算）。 */
  maxBytes: number;
  /** 单图最大总像素数（note_image.max_pixels）。 */
  maxPixels: number;
}

/** 全书摘要缓存行：分块摘要（scope=block）或合并后的全书摘要（scope=book）。 */
export interface BookSummaryRow {
  documentId: string;
  scope: 'block' | 'book';
  /** 分块键：章/页区间的稳定标识；全书摘要为空串。 */
  blockKey: string;
  title: string;
  pagesFrom: number;
  pagesTo: number;
  content: string;
  model: string;
  /** 生成时的文档内容版本（文档变了旧摘要视为过期）。 */
  contentVersion: string;
  promptVersion: number;
  /** 合并层级：0=章摘要，>0=合并层。 */
  level: number;
  created: string;
  updated: string;
}

/** 宽高是否超出解压炸弹防护上限（单边 20000，总像素由设置决定）。 */
function imageDimensionsTooLarge(
  width: number,
  height: number,
  maxPixels: number
): boolean {
  return (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > maxPixels
  );
}

/**
 * 从文件头解析图片像素尺寸（不真正解码图像），用于在解码前拦截解压炸弹。
 *
 * 支持 PNG IHDR、GIF 逻辑屏幕、JPEG SOFn、WebP VP8X/VP8/VP8L；解析不出返回 null，
 * 调用方降级为「完整解码后再校验尺寸」。
 */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes);
  const size = view.byteLength;
  // PNG：8 字节签名 + 4 字节长度 + 'IHDR' + 宽/高（大端 32 位）。
  if (size >= 24 && view.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  }
  // GIF：逻辑屏幕宽/高（小端 16 位，6..10 字节）。
  const gifHead = size >= 6 ? view.subarray(0, 6).toString('latin1') : '';
  if ((gifHead === 'GIF87a' || gifHead === 'GIF89a') && size >= 10) {
    return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
  }
  // JPEG：顺序扫描 marker，取 SOFn 段里的高度/宽度（大端 16 位）。
  if (size >= 4 && view[0] === 0xff && view[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < size) {
      if (view[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = view[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // SOI/RSTn/TEM 没有长度字段。
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9) break;
      const length = view.readUInt16BE(offset + 2);
      if (length < 2) return null;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        if (offset + 9 > size) return null;
        return { width: view.readUInt16BE(offset + 7), height: view.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return null;
  }
  // WebP：RIFF 容器里的 VP8X（扩展）/ VP8（有损）/ VP8L（无损）。
  if (
    size >= 16 &&
    view.subarray(0, 4).toString('latin1') === 'RIFF' &&
    view.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    const fourcc = view.subarray(12, 16).toString('latin1');
    if (fourcc === 'VP8X' && size >= 30) {
      return { width: view.readUIntLE(24, 3) + 1, height: view.readUIntLE(27, 3) + 1 };
    }
    if (fourcc === 'VP8 ' && size >= 30) {
      return {
        width: view.readUInt16LE(26) & 0x3fff,
        height: view.readUInt16LE(28) & 0x3fff
      };
    }
    if (fourcc === 'VP8L' && size >= 25 && view[20] === 0x2f) {
      const bits = view.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

/** 关系图笔记节点标题：取首个非空行，去掉 Markdown 标记；空则「未命名笔记」。 */
function noteGraphLabel(content: string): string {
  const firstLine = (content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '未命名笔记';
  const plain = markdownPlainText(firstLine).trim();
  return plain || '未命名笔记';
}

interface BacklinkCandidateRow {
  id: string;
  document_id: string;
  document_name: string | null;
  page: number | null;
  content: string | null;
  created: string | null;
  rowid: number;
}

/** 引用关系图缓存条目：完整节点（已按度数排序）/边/悬空数/节点索引。 */
interface CachedReferenceGraph {
  builtAt: number;
  nodes: ReferenceGraphNode[];
  edges: ReferenceGraphEdge[];
  unresolved: number;
  nodeById: Map<string, ReferenceGraphNode>;
}

// 题录 XMP 字段读取/DOI 抽取的唯一实现在 ./pdf-metadata.ts；PDF 解析在 ./pdf-worker.ts。

export class DuplicateImportError extends Error {
  readonly candidates: ImportDuplicateCandidate[];
  readonly canOverride: boolean;

  constructor(candidates: ImportDuplicateCandidate[], canOverride: boolean) {
    super('文献库中已有相同或高度相似的文献');
    this.name = 'DuplicateImportError';
    this.candidates = candidates;
    this.canOverride = canOverride;
  }
}

// Zotero 附件变更错误类型随文献域搬到 ./store/documents.ts；这里只做 re-export，
// server.ts / 测试仍从 './store.js' 取同一个类（instanceof 语义不变）。
export { AttachmentChangedError } from './store/documents.js';

/** 索引分块口径：span/行级，1000 步长、1200 窗口。 */

/**
 * 解析 PDF（导入/重连/快照/Zotero 路径共用）。
 *
 * 实际解析在 `pdf-worker` 的 worker 线程里跑：主线程只等结果、落库、写 FTS，
 * 解析期间事件循环不被 PDF.js 占住。返回结构、错误语义与旧主线程实现完全相同；
 * 需要取消时传 `signal`（worker 任务会被终止，并以 `PdfParseCancelledError` 失败）。
 */
export async function parsePdf(
  bytes: Uint8Array,
  options?: { signal?: AbortSignal }
): Promise<ParsedPdf> {
  return parsePdfOffMainThread(bytes, options);
}

function makeSnippet(text: string, query: string, radius = 80): string {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function makeFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""'))
    .filter(Boolean)
    .map((term) => `"${term}"`);
  return terms.join(' OR ');
}

/** 导入进度（粗粒度阶段；解析 PDF 期间百分比不逐页变化）。 */
export interface ImportProgress {
  stage: 'reading' | 'hashing' | 'parsing' | 'writing' | 'done';
  percent: number;
}

/** 用户在解析完成后、写入数据库前取消导入。 */
export class ImportCancelledError extends Error {
  constructor() {
    super('导入已取消');
    this.name = 'ImportCancelledError';
  }
}

/**
 * Zotero 文献导入结果。
 *
 * 只有本次调用按 `zotero.sync_preserve_local_title` 开关**确实保留了本地标题**时，
 * 才附带 `localTitlePreserved: true`；其余情况与 `DocumentDetail` 完全一致，
 * 不给直接打开附件等普通导入响应增加无意义字段。
 */
export interface ZoteroDocumentImportResult extends DocumentDetail {
  localTitlePreserved?: boolean;
}

/**
 * 迁移前 schema 快照（`migration-backups/reader-before-v<数字>-<时间戳>.sqlite3`）的保留份数。
 *
 * 每份是 VACUUM INTO 出的完整库副本（真实库约 7 MiB），不设上限会随每次升级累积成几十 MB。
 * 数值集中定义在这里：单测与 `scripts/verify-migration.mjs` 都从源码读取，避免多处各写一份。
 * 计入本次刚生成的那份；迁移成功后只保留最近 N 份，更早的自动删除。
 */
export const MIGRATION_BACKUP_KEEP = 3;

/**
 * 只识别自动生成的迁移快照名。
 *
 * 必须是 `reader-before-v<数字>-<非空后缀>.sqlite3`；`migration-backups/` 是普通目录，
 * 用户可能手动放进去其它文件，不符合该模式的一律不参与保留策略、也绝不删除。
 */
const MIGRATION_BACKUP_NAME = /^reader-before-v(\d+)-(.+)\.sqlite3$/;

function isMigrationBackupName(name: string): boolean {
  return MIGRATION_BACKUP_NAME.test(name);
}

/** 取快照名里的时间戳部分；不属于自动命名格式时退回整个名字，保证排序确定。 */
function migrationBackupStamp(name: string): string {
  return MIGRATION_BACKUP_NAME.exec(name)?.[2] ?? name;
}

/**
 * 快照「新 → 旧」排序：文件名里的时间戳是生成时的 ISO 时间（':'/'.' 已替换为 '-'），
 * 可直接按字符串比较，不依赖文件 mtime，也不受版本号位数影响（v9/v10 不会排错）。
 */
function compareMigrationBackupsNewestFirst(a: string, b: string): number {
  const stampA = migrationBackupStamp(a);
  const stampB = migrationBackupStamp(b);
  if (stampA !== stampB) return stampA < stampB ? 1 : -1;
  // 时间戳相同（理论上不会发生）：按完整文件名倒序，保证排序稳定。
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * `reading_tasks` 表里翻译任务进度行的 key 前缀（`translation-job:<documentId>`）。
 *
 * 该表由阅读任务与翻译任务共用：问答/跨文献任务的 `task` 是无前缀 UUID，翻译任务用本前缀。
 * `listReadingTasks` 默认不按前缀过滤（保持既有返回结构），需要严格只取问答任务时由调用方
 * 传 `{ kind: 'reading' }`。
 */
const TRANSLATION_JOB_TASK_PREFIX = 'translation-job:';

export interface StoreOptions {
  /**
   * 应用进程专用：打开数据库后持 SQLite 独占锁，阻止同账号下的第二个 SQLite 连接并发读写。
   * 测试与离线脚本默认关闭（它们需要直接开库核对数据）；只有 Core 入口传 true。
   */
  exclusiveLock?: boolean;
}

export class Store {
  readonly dataDir: string;
  readonly papersDir: string;
  private readonly db: DatabaseSync;
  private readonly instanceLockPath: string;
  private readonly exclusiveLock: boolean;
  private instanceLockDb: DatabaseSync | null = null;
  /**
   * 版面解析缓存（进程内 LRU，最多 8 篇）。
   *
   * PDF 解析是整篇最贵的操作；页数据/引用/目录/翻译请求都复用同一份解析结果。
   * 键是文件路径 + size:mtime，relink 换文件后自然失效；缓存的是**原始文本层**，
   * OCR 合并在 `mergeOcrLayout` 里按当前 page_edits 重新做（不写回缓存）。
   */
  private readonly layoutCache = new Map<string, { stamp: string; layout: PdfLayout }>();
  /**
   * 内容块/章节识别缓存（进程内 LRU，最多 8 篇）。
   *
   * 识别本身是纯函数、从版面重算，但一篇几百页的文献每次请求都重算不划算；
   * 键含 `structureStamp`（文件 size:mtime + 页遮罩版本），换文件或改遮罩自然失效。
   * 不写数据库：版面已持久化，重算结果确定，没必要再存一份块文本。
   */
  private readonly blocksCache = new Map<string, { stamp: string; blocks: DocumentBlocks }>();
  /** 章节索引片段缓存（派生自内容块；键 = 文献 + 结构版本 + 切片参数）。 */
  private readonly sectionIndexCache = new Map<string, DocumentSectionIndex>();
  /** 页遮罩重建进度（内存态，用于状态接口；不持久化）。 */
  private readonly maskJobs = new Map<
    string,
    { state: 'idle' | 'rebuilding' | 'ready' | 'failed'; done: number; total: number; error?: string }
  >();
  /** 重建进行中又收到的规则变更：页集合并到下一轮，不并行跑两份。 */
  private readonly maskPending = new Map<string, Set<number>>();
  /**
   * 完整引用关系图缓存（分页只切这一份，避免每次翻页重扫全库）。
   * TTL 2 秒；任何影响节点/边/悬空统计的写操作都会调用 invalidateReferenceGraphCache。
   */
  private referenceGraphCache: CachedReferenceGraph | null = null;
  private static readonly REFERENCE_GRAPH_CACHE_TTL_MS = 2000;
  /**
   * 关系图全量模式一次返回的节点硬上限（默认 5000，超过则退回分页并标注 truncated）。
   * 用 static 字段而非 const，便于测试按需调小后覆盖超限分支。
   */
  static MAX_ALL_NODES = REFERENCE_GRAPH_ALL_NODE_LIMIT;
  /**
   * 后台资源索引重建器（任务状态 job / running 与其状态机都在 NoteAssetReindexer 里，
   * 本类不再持有；懒创建，构造它不会启动任何任务）。
   */
  private noteAssetReindexerInstance: NoteAssetReindexer | null = null;
  /** 上一次非正常关闭后启动时 `quick_check` 的结果；仅用于诊断/测试。 */
  private lastIntegrityCheckResult: string | null = null;
  /** 最近一次数据库写入时间（由代理后的 db 自动更新）；看门狗据此判断"空闲"。 */
  private lastWriteActivityAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private watchdogSnapshot: { size: number; mtimeMs: number; walSize: number; walMtimeMs: number } | null = null;
  private tamperSuspected = false;
  private lastWatchdogResult: string | null = null;

  constructor(dataDir: string, options: StoreOptions = {}) {
    this.dataDir = dataDir;
    this.exclusiveLock = options.exclusiveLock === true;
    this.papersDir = path.join(dataDir, 'papers');
    this.instanceLockPath = path.join(dataDir, '.instance-lock.sqlite3');
    mkdirSync(this.papersDir, { recursive: true });
    this.acquireInstanceLock();

    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
      this.db = this.instrumentDatabase(opened);
      // WAL 提升读写并发：读不被写阻塞、写仍串行；不支持时回退默认 journal（不阻断启动）。
      try {
        this.db.exec('PRAGMA journal_mode = WAL');
      } catch {
        // 文件系统/SQLite 变体不支持 WAL 时保持默认模式。
      }
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA foreign_keys = ON');
      // 独占锁：应用进程运行期间不让第二个 SQLite 连接读/写数据库。
      // 测试与离线脚本默认关闭；只有 Core 入口传 exclusiveLock=true。
      if (this.exclusiveLock) {
        try {
          this.db.exec('PRAGMA locking_mode = EXCLUSIVE');
        } catch {
          // 某些文件系统/变体不支持独占锁
        }
      }
      this.migrate();
      this.recordStartupIntegrity();
      this.watchdogSnapshot = this.readDbFileStat();
    } catch (error) {
      try {
        opened?.close();
      } catch {
        // 忽略关闭失败
      }
      this.releaseInstanceLock();
      throw error;
    }
  }

  private acquireInstanceLock(): void {
    // 独立 SQLite 文件 + BEGIN EXCLUSIVE：由 SQLite 的 OS 文件锁保证跨进程互斥。
    // 进程崩溃/强杀时 OS 自动释放锁，不再依赖 PID 是否存活；也避免 PID 复用误判。
    let lockDb: DatabaseSync | null = null;
    try {
      lockDb = new DatabaseSync(this.instanceLockPath);
      lockDb.exec('PRAGMA busy_timeout = 0');
      lockDb.exec('BEGIN EXCLUSIVE');
      this.instanceLockDb = lockDb;
      return;
    } catch (error) {
      try {
        lockDb?.close();
      } catch {
        // 忽略
      }
      throw new Error(
        `数据目录正在被另一个 Studianda 进程使用，或无法锁定：${this.dataDir}` +
          `（${error instanceof Error ? error.message : '未知错误'}）。` +
          '请关闭另一个实例后重试。'
      );
    }
  }

  private releaseInstanceLock(): void {
    const lockDb = this.instanceLockDb;
    this.instanceLockDb = null;
    if (!lockDb) return;
    try {
      lockDb.exec('ROLLBACK');
    } catch {
      // 事务可能已被 SQLite 关闭
    }
    try {
      lockDb.close();
    } catch {
      // 忽略关闭失败
    }
    // 锁文件保留（空库）：下次启动继续用 SQLite 文件锁，不靠删除文件清理。
  }

  close(): void {
    this.stopIntegrityWatch();
    try {
      // 先落"正常关闭"标记，再 checkpoint/关闭；写标记失败不阻断关闭。
      try {
        this.writeSchemaMeta('clean_shutdown', '1');
      } catch {
        // 数据库可能已不可写
      }
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // checkpoint 失败由 SQLite 自行恢复
      }
      this.db.close();
    } finally {
      this.releaseInstanceLock();
    }
  }

  /** 上一次非正常关闭后启动时的 `quick_check` 结果；`null` 表示上次正常关闭或首次启动。 */
  integrityOnStartup(): string | null {
    return this.lastIntegrityCheckResult;
  }

  /** 启动/停止运行期看门狗：空闲时比对数据库文件变化并跑 quick_check。 */
  startIntegrityWatch(options: { intervalMs?: number; idleMs?: number } = {}): void {
    if (this.watchdogTimer) return;
    const intervalMs = options.intervalMs ?? 5000;
    const idleMs = options.idleMs ?? 15000;
    this.watchdogSnapshot = this.readDbFileStat();
    this.watchdogTimer = setInterval(() => this.watchdogTick(idleMs), intervalMs);
    // 不阻止进程退出（Electron/Core 退出不应被定时器拖住）。
    this.watchdogTimer.unref?.();
  }

  stopIntegrityWatch(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** 主动跑一次完整性检查（测试/诊断用）；文件在空闲期变化或 quick_check 失败都会标记篡改可疑。 */
  checkIntegrityNow(): string {
    const current = this.readDbFileStat();
    const previous = this.watchdogSnapshot;
    this.watchdogSnapshot = current;
    if (previous && this.dbFileChanged(previous, current)) this.tamperSuspected = true;
    const result = this.safeQuickCheck();
    this.lastWatchdogResult = result;
    if (result !== 'ok') this.tamperSuspected = true;
    return result;
  }

  integrityStatus(): { tamperSuspected: boolean; lastWatchdogResult: string | null } {
    return { tamperSuspected: this.tamperSuspected, lastWatchdogResult: this.lastWatchdogResult };
  }

  private safeQuickCheck(): string {
    try {
      return this.quickCheck();
    } catch (error) {
      return `quick_check_failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private readDbFileStat(): { size: number; mtimeMs: number; walSize: number; walMtimeMs: number } {
    const dbPath = path.join(this.dataDir, 'reader.sqlite3');
    const walPath = `${dbPath}-wal`;
    const dbStat = existsSync(dbPath) ? statSync(dbPath) : null;
    const walStat = existsSync(walPath) ? statSync(walPath) : null;
    return {
      size: dbStat?.size ?? 0,
      mtimeMs: dbStat?.mtimeMs ?? 0,
      walSize: walStat?.size ?? 0,
      walMtimeMs: walStat?.mtimeMs ?? 0
    };
  }

  private watchdogTick(idleMs: number): void {
    // 有写入活动时视为正常；只在空闲窗口比对文件。活动期先把快照追到最新，避免把自己的写当成篡改。
    if (Date.now() - this.lastWriteActivityAt < idleMs) {
      this.watchdogSnapshot = this.readDbFileStat();
      return;
    }
    const current = this.readDbFileStat();
    const previous = this.watchdogSnapshot;
    if (previous && !this.dbFileChanged(previous, current)) return;
    this.watchdogSnapshot = current;
    if (previous) this.tamperSuspected = true;
    const result = this.safeQuickCheck();
    this.lastWatchdogResult = result;
    if (result !== 'ok') {
      this.tamperSuspected = true;
      console.error('[studianda] 看门狗：数据库完整性异常：', result);
    }
  }

  private dbFileChanged(
    previous: { size: number; mtimeMs: number; walSize: number; walMtimeMs: number },
    current: { size: number; mtimeMs: number; walSize: number; walMtimeMs: number }
  ): boolean {
    return (
      previous.size !== current.size ||
      previous.mtimeMs !== current.mtimeMs ||
      previous.walSize !== current.walSize ||
      previous.walMtimeMs !== current.walMtimeMs
    );
  }

  /**
   * 给数据库连接套一层写活动代理：
   * - 写语句（INSERT/UPDATE/DELETE/...）在 `run()` 或 `exec()` 后更新 `lastWriteActivityAt`；
   * - 读语句不更新，避免把查询噪声当成写入。
   * 看门狗据此区分"Core 自己在写"和"空闲时文件被外部改动"。
   */
  private instrumentDatabase(db: DatabaseSync): DatabaseSync {
    const touch = (): void => {
      this.lastWriteActivityAt = Date.now();
    };
    const wrapStatement = (statement: ReturnType<DatabaseSync['prepare']>, sql: string) => {
      const isWrite = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH)\b/i.test(
        sql
      );
      if (!isWrite) return statement;
      return new Proxy(statement, {
        get: (target, property) => {
          const value = Reflect.get(target, property, target);
          if (property === 'run' && typeof value === 'function') {
            return (...args: unknown[]) => {
              const result = value.apply(target, args);
              touch();
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    return new Proxy(db, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (property === 'exec' && typeof value === 'function') {
          return (sql: string) => {
            const result = value.call(target, sql);
            touch();
            return result;
          };
        }
        if (property === 'prepare' && typeof value === 'function') {
          return (sql: string) => wrapStatement(value.call(target, sql), sql);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as unknown as DatabaseSync;
  }

  private readSchemaMeta(key: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT value FROM schema_meta WHERE key = ?')
        .get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private writeSchemaMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)')
      .run(key, value);
  }

  /**
   * 启动完整性门禁：上次关闭标记为 '0'（崩溃/强杀）时跑一次 `quick_check`。
   * 只记录结果，不自动修复，也不阻断启动（修复入口由 verify/repair 提供）。
   */
  private recordStartupIntegrity(): void {
    if (this.readSchemaMeta('clean_shutdown') === '0') {
      const result = this.quickCheck();
      this.lastIntegrityCheckResult = result;
      if (result !== 'ok') {
        console.error('[studianda] 数据库完整性检查未通过：', result);
      }
    }
    this.writeSchemaMeta('clean_shutdown', '0');
  }

  backupDatabase(target: string): void {
    // VACUUM INTO 生成一致性快照，避免直接复制正在写入的 SQLite 文件。
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }

  diagnosticCounts(): Record<string, number> {
    const tables = [
      'documents',
      'annotations',
      'notes',
      'settings',
      'chunks',
      'translation_pages',
      'translation_segments',
      'page_edits',
      'reading_tasks'
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
          | { n?: number }
          | undefined;
        counts[table] = Number(row?.n ?? 0);
      } catch {
        counts[table] = 0;
      }
    }
    return counts;
  }

  quickCheck(): string {
    const rows = this.db.prepare('PRAGMA quick_check').all() as unknown as Array<{
      quick_check?: string;
    }>;
    const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter(Boolean);
    return values.length === 0 ? 'ok' : values.join('; ');
  }

  /** 未删除文献中附件文件缺失的篇数；实现见 store/documents.ts。 */
  missingDocumentFiles(): number {
    return documentDomain.missingDocumentFiles(this.db, this.documentDomainDeps);
  }

  /** 逐文档附件健康检查（缺失/不可读/大小变化）；实现见 store/documents.ts。 */
  documentHealth(): Array<{
    documentId: string;
    name: string;
    missing: boolean;
    path: string;
  }> {
    return documentDomain.documentHealth(this.db, this.documentDomainDeps);
  }

  getTranslationPage(documentId: string, page: number): TranslationPageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM translation_pages WHERE document_id = ? AND page = ?')
      .get(documentId, page) as Record<string, unknown> | undefined;
    return row ? mapTranslationPage(row) : null;
  }

  listTranslationPages(documentId: string): TranslationPageRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM translation_pages WHERE document_id = ? ORDER BY page')
        .all(documentId) as unknown as Array<Record<string, unknown>>
    ).map(mapTranslationPage);
  }

  getTranslationSegments(documentId: string, page: number): TranslationSegmentRecord[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM translation_segments WHERE document_id = ? AND page = ? ORDER BY segment'
        )
        .all(documentId, page) as unknown as Array<Record<string, unknown>>
    ).map(mapTranslationSegment);
  }

  saveTranslationPage(record: TranslationPageRecord): void {
    this.db
      .prepare(
        `INSERT INTO translation_pages(document_id, page, source_hash, engine, status, error, done, total, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id, page) DO UPDATE SET
           source_hash = excluded.source_hash, engine = excluded.engine,
           status = excluded.status, error = excluded.error,
           done = excluded.done, total = excluded.total, updated = excluded.updated`
      )
      .run(
        record.documentId,
        record.page,
        record.sourceHash,
        record.engine,
        record.status,
        record.error,
        record.done,
        record.total,
        record.updated
      );
  }

  editTranslationSegment(
    documentId: string,
    segmentId: string,
    text: string
  ): { ok: true; id: string } {
    const row = this.db
      .prepare('SELECT * FROM translation_segments WHERE id = ? AND document_id = ?')
      .get(segmentId, documentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('译文不存在');
    if (row.origin === 'machine') {
      this.db
        .prepare(
          `UPDATE translation_segments SET text = ?, edited = 1, origin = 'user',
             previous_text = text, previous_origin = 'machine', updated = ?
           WHERE id = ?`
        )
        .run(text, new Date().toISOString(), segmentId);
    } else {
      this.db
        .prepare(
          `UPDATE translation_segments SET text = ?, edited = 1, origin = 'user', updated = ?
           WHERE id = ?`
        )
        .run(text, new Date().toISOString(), segmentId);
    }
    return { ok: true, id: segmentId };
  }

  translationServiceSummary(documentId: string): {
    total: number;
    legacy: number;
    services: Array<{ service: string; count: number }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(service, '') AS service, COUNT(*) AS count
         FROM translation_segments WHERE document_id = ?
         GROUP BY COALESCE(service, '') ORDER BY count DESC`
      )
      .all(documentId) as unknown as Array<{ service: string; count: number }>;
    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    const legacy = rows
      .filter((row) => !row.service || row.service.includes('术语'))
      .reduce((sum, row) => sum + Number(row.count), 0);
    return {
      total,
      legacy,
      services: rows.map((row) => ({ service: row.service, count: Number(row.count) }))
    };
  }

  restoreTranslationSegment(
    documentId: string,
    segmentId: string
  ): { ok: true; restored: boolean; message?: string } {    const row = this.db
      .prepare('SELECT * FROM translation_segments WHERE id = ? AND document_id = ?')
      .get(segmentId, documentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('译文不存在');
    if (Number(row.edited ?? 0) !== 1) {
      return {
        ok: true,
        restored: false,
        message: '这段本来就是机器译文，没有需要撤销的修改。'
      };
    }
    if (!String(row.previous_text ?? '')) {
      this.db
        .prepare(
          `UPDATE translation_segments SET edited = 0, updated = ? WHERE id = ?`
        )
        .run(new Date().toISOString(), segmentId);
      return {
        ok: true,
        restored: false,
        message: '这段没有保存下来的机器译文：可以点「重新翻译」用当前服务重译这一段。'
      };
    }
    this.db
      .prepare(
        `UPDATE translation_segments SET text = previous_text, edited = 0,
           origin = previous_origin, previous_text = '', previous_origin = '', updated = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), segmentId);
    return { ok: true, restored: true };
  }

  saveTranslationSegments(records: TranslationSegmentRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO translation_segments(
         id, document_id, page, segment, source, source_hash, text, engine, service,
         terms, unknown_terms, coverage, edited, origin, previous_text, previous_origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, page, segment) DO UPDATE SET
         source = excluded.source, source_hash = excluded.source_hash,
         text = excluded.text, engine = excluded.engine, service = excluded.service,
         terms = excluded.terms, unknown_terms = excluded.unknown_terms,
         coverage = excluded.coverage, edited = excluded.edited, origin = excluded.origin,
         -- 机器译文覆盖人工改稿时，把人工版本留作“恢复”目标（同 Python translation._upsert）。
         previous_text = CASE
           WHEN excluded.origin = 'machine'
            AND translation_segments.origin = 'user'
            AND translation_segments.text <> excluded.text
           THEN translation_segments.text
           ELSE excluded.previous_text END,
         previous_origin = CASE
           WHEN excluded.origin = 'machine'
            AND translation_segments.origin = 'user'
            AND translation_segments.text <> excluded.text
           THEN translation_segments.origin
           ELSE excluded.previous_origin END,
         updated = CURRENT_TIMESTAMP`
    );
    for (const record of records) {
      statement.run(
        record.id,
        record.documentId,
        record.page,
        record.segment,
        record.source,
        record.sourceHash,
        record.text,
        record.engine,
        record.service,
        record.terms,
        record.unknownTerms,
        record.coverage,
        record.edited ? 1 : 0,
        record.origin,
        record.previousText,
        record.previousOrigin
      );
    }
  }

  saveReadingTask(task: string, payload: unknown, documents: string[] = []): void {
    this.db
      .prepare(
        `INSERT INTO reading_tasks(task, payload, documents, updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task) DO UPDATE SET payload = excluded.payload,
           documents = excluded.documents, updated = excluded.updated`
      )
      .run(task, JSON.stringify(payload), JSON.stringify(documents), Date.now() / 1000);
  }

  loadReadingTask<T = unknown>(
    task: string
  ): { payload: T; documents: string[]; updated: number } | null {
    const row = this.db
      .prepare('SELECT payload, documents, updated FROM reading_tasks WHERE task = ?')
      .get(task) as { payload: string | null; documents: string | null; updated: number | null } | undefined;
    if (!row || !row.payload) return null;
    try {
      return {
        payload: JSON.parse(row.payload) as T,
        documents: row.documents ? (JSON.parse(row.documents) as string[]) : [],
        updated: row.updated ?? 0
      };
    } catch {
      return null;
    }
  }

  deleteReadingTask(task: string): void {
    this.db.prepare('DELETE FROM checkpoints WHERE task = ?').run(task);
    this.db.prepare('DELETE FROM reading_tasks WHERE task = ?').run(task);
  }

  saveCheckpoint(task: string, stage: string, value: unknown, documents: string[] = []): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints(task, stage, value, documents, updated)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task, stage) DO UPDATE SET
           value = excluded.value,
           documents = excluded.documents,
           updated = excluded.updated`
      )
      .run(task, stage, JSON.stringify(value), JSON.stringify(documents), Date.now() / 1000);
  }

  loadCheckpoint<T = unknown>(
    task: string,
    stage: string
  ): { value: T; documents: string[] } | null {
    const row = this.db
      .prepare('SELECT value, documents FROM checkpoints WHERE task = ? AND stage = ?')
      .get(task, stage) as { value: string | null; documents: string | null } | undefined;
    if (!row?.value) return null;
    try {
      return {
        value: JSON.parse(row.value) as T,
        documents: row.documents ? (JSON.parse(row.documents) as string[]) : []
      };
    } catch {
      return null;
    }
  }

  /**
   * 全书摘要缓存（分层：`scope='block'` 是章/页区间摘要，`scope='book'` 是合并后的全书摘要）。
   *
   * 只存摘要与页码范围，不存原文；内容版本不匹配的记录由调用方视为过期（仍保留，便于诊断）。
   */
  listBookSummaries(documentId: string): BookSummaryRow[] {
    const rows = this.db
      .prepare(
        `SELECT document_id, scope, block_key, title, pages_from, pages_to, content, model,
                content_version, prompt_version, level, created, updated
           FROM book_summaries
          WHERE document_id = ?
          ORDER BY scope, level, pages_from`
      )
      .all(documentId) as unknown as Array<{
      document_id: string;
      scope: string;
      block_key: string;
      title: string;
      pages_from: number;
      pages_to: number;
      content: string;
      model: string;
      content_version: string;
      prompt_version: number;
      level: number;
      created: string;
      updated: string;
    }>;
    return rows.map((row) => ({
      documentId: row.document_id,
      scope: row.scope === 'book' ? 'book' : 'block',
      blockKey: row.block_key,
      title: row.title,
      pagesFrom: row.pages_from,
      pagesTo: row.pages_to,
      content: row.content,
      model: row.model,
      contentVersion: row.content_version,
      promptVersion: row.prompt_version,
      level: row.level,
      created: row.created,
      updated: row.updated
    }));
  }

  saveBookSummary(row: BookSummaryRow): void {
    this.db
      .prepare(
        `INSERT INTO book_summaries(
           document_id, scope, block_key, title, pages_from, pages_to, content, model,
           content_version, prompt_version, level, created, updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id, scope, block_key) DO UPDATE SET
           title = excluded.title,
           pages_from = excluded.pages_from,
           pages_to = excluded.pages_to,
           content = excluded.content,
           model = excluded.model,
           content_version = excluded.content_version,
           prompt_version = excluded.prompt_version,
           level = excluded.level,
           updated = excluded.updated`
      )
      .run(
        row.documentId,
        row.scope,
        row.blockKey,
        row.title,
        row.pagesFrom,
        row.pagesTo,
        row.content,
        row.model,
        row.contentVersion,
        row.promptVersion,
        row.level,
        row.created,
        row.updated
      );
  }

  deleteBookSummaries(documentId: string): void {
    this.db.prepare('DELETE FROM book_summaries WHERE document_id = ?').run(documentId);
  }

  listMessages(
    documentId: string,
    options: { sessionId?: string } = {}
  ): ChatMessageRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, document_id, role, content, sources, metadata, created, session_id, scope_kind, audit_summary FROM messages WHERE document_id = ? ORDER BY id'
      )
      .all(documentId) as unknown as Array<{
      id: number;
      document_id: string;
      role: string;
      content: string;
      sources: string | null;
      metadata: string | null;
      created: string;
      session_id: string | null;
      scope_kind: string | null;
      audit_summary: string | null;
    }>;
    const sessionId = options.sessionId?.trim() ?? '';
    // 会话归属以 messages.session_id 列为准；legacy 兼容旧库/旧消息（列默认值或空）。
    const visibleRows = sessionId
      ? rows.filter((row) => {
          const own = row.session_id ?? '';
          return sessionId === 'legacy' ? !own || own === 'legacy' : own === sessionId;
        })
      : rows;
    const messages: ChatMessageRecord[] = visibleRows.map((row) => {
      let sources: ChatSource[] = [];
      let metadata: Record<string, unknown> = {};
      try {
        const parsed = row.sources ? (JSON.parse(row.sources) as unknown) : [];
        if (Array.isArray(parsed)) sources = parsed as ChatSource[];
      } catch {
        sources = [];
      }
      try {
        const parsed = row.metadata ? (JSON.parse(row.metadata) as unknown) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = {};
      }
      // 审计摘要解析失败时退化为「没有摘要」（坏 JSON/旧消息都不能让整条历史读取报错）。
      const auditSummary = parseAuditSummary(row.audit_summary);
      return {
        id: Number(row.id),
        documentId: row.document_id,
        role: row.role === 'user' ? 'user' : 'assistant',
        content: row.content ?? '',
        sources,
        metadata,
        created: row.created,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        // 空串哨兵语义显式化：只有校验为 corpus 才算跨篇，其余（含旧数据 NULL）按单篇兜底。
        scopeKind: row.scope_kind === 'corpus' ? 'corpus' : 'document',
        ...(auditSummary ? { auditSummary } : {})
      };
    });
    if (!sessionId) return messages;
    return messages;
  }

  /**
   * 阅读伙伴消息分页：取该会话最新的一页（升序），`beforeId` 用于「加载更早」。
   * 返回 hasMore = 这一页之前还有更早的消息。
   */
  listMessagesPage(
    documentId: string,
    options: { sessionId?: string; limit?: number; beforeId?: number } = {}
  ): { messages: ChatMessageRecord[]; hasMore: boolean } {
    const limit =
      typeof options.limit === 'number' &&
      Number.isInteger(options.limit) &&
      options.limit > 0
        ? Math.min(options.limit, 200)
        : 60;
    const all = this.listMessages(
      documentId,
      options.sessionId ? { sessionId: options.sessionId } : {}
    );
    const beforeId =
      typeof options.beforeId === 'number' &&
      Number.isInteger(options.beforeId) &&
      options.beforeId > 0
        ? options.beforeId
        : 0;
    const visible = beforeId ? all.filter((message) => message.id < beforeId) : all;
    const page = visible.slice(-limit);
    return {
      messages: page,
      hasMore: visible.length > page.length
    };
  }

  /** 阅读伙伴会话内搜索：词面包含匹配，返回命中消息与截断片段。 */
  searchDocumentSessionMessages(
    documentId: string,
    options: { sessionId?: string; query: string; limit?: number }
  ): {
    matches: Array<{
      id: number;
      role: 'user' | 'assistant';
      content: string;
      snippet: string;
      created: string;
    }>;
    total: number;
  } {
    const query = options.query.trim();
    if (!query) return { matches: [], total: 0 };
    const limit =
      typeof options.limit === 'number' &&
      Number.isInteger(options.limit) &&
      options.limit > 0
        ? Math.min(options.limit, 200)
        : 80;
    const all = this.listMessages(
      documentId,
      options.sessionId ? { sessionId: options.sessionId } : {}
    );
    const needle = query.toLowerCase();
    const hits = all.filter((message) => message.content.toLowerCase().includes(needle));
    const matches = hits.slice(0, limit).map((message) => {
      const index = message.content.toLowerCase().indexOf(needle);
      const start = Math.max(0, index - 60);
      const end = Math.min(message.content.length, index + query.length + 90);
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        snippet:
          (start > 0 ? '…' : '') +
          message.content.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < message.content.length ? '…' : ''),
        created: message.created
      };
    });
    return { matches, total: hits.length };
  }

  addMessage(input: {
    documentId: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: ChatSource[];
    metadata?: Record<string, unknown>;
    /**
     * 显式审计摘要（一般由调用方从 ChatResponse 压缩后传入）。
     * 不传时：assistant 消息先尝试 `metadata.response` 里的整轮 ChatResponse；没有完整响应
     * 就退回 `metadata` 自身的可见审计字段（`audit` / `claims` / `invalid_citations` /
     * `selection_snapshot` / `audit_summary`）。两者都取不到才写 NULL（旧消息/失败占位没有
     * 审计信息），**不伪造计数**。
     */
    auditSummary?: ChatAuditSummary | null;
  }): ChatMessageRecord {
    if (!this.getDocument(input.documentId)) throw new Error('文档不存在');
    const rawSessionId = input.metadata?.sessionId;
    const sessionId =
      typeof rawSessionId === 'string' && rawSessionId.trim() ? rawSessionId.trim() : 'legacy';
    // 单篇文献消息显式记 scope_kind='document'：不再依赖 document_id 是否为空来判断作用域。
    const auditSummary =
      input.role === 'assistant'
        ? (input.auditSummary ??
          auditSummaryFromResponse(input.metadata?.response) ??
          // 调用方没带完整 response 时，请求里的可见审计字段同样压成摘要；都没有就保持 NULL。
          auditSummaryFromResponse(input.metadata))
        : null;
    const result = this.db
      .prepare(
        'INSERT INTO messages(document_id, role, content, sources, metadata, session_id, scope_kind, audit_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        input.documentId,
        input.role,
        input.content,
        JSON.stringify(input.sources ?? []),
        JSON.stringify(input.metadata ?? {}),
        sessionId,
        'document',
        serializeAuditSummary(auditSummary)
      );
    return {
      id: Number(result.lastInsertRowid),
      documentId: input.documentId,
      role: input.role,
      content: input.content,
      sources: input.sources ?? [],
      metadata: input.metadata ?? {},
      created: new Date().toISOString(),
      sessionId,
      scopeKind: 'document',
      ...(auditSummary ? { auditSummary } : {})
    };
  }

  /**
   * 某篇文献的「继续阅读」任务列表（`GET /documents/:id/reading-tasks` 的返回）。
   *
   * 数据直接来自共享表 `reading_tasks`，表里实际有两类行：
   * - 问答/跨文献任务：`task` 是 randomUUID（无前缀），payload 带 question/pagesRead/unread_pages；
   * - 翻译任务进度：`task` 是 `translation-job:<documentId>`（见 `saveTranslationJob`），payload 只有
   *   status/total/done/currentPage/error。
   *
   * 为保持既有 HTTP 返回结构不变，本方法**默认不筛行类型**：同文档的翻译任务行也会返回，
   * 映射为 `question:''`、`pagesRead:[]`、`unreadPages:[]`。只渲染「还有几页未读」的调用方按
   * `unreadPages.length > 0` 过滤即可（界面 StudiandaApp 的 pendingTasks 就是这么做的，
   * 所以翻译任务行不会显示给用户）；需要严格只取问答任务时传 `{ kind: 'reading' }`。
   *
   * 性能：`documents` 是 JSON 数组、无索引，现有实现本就是全表扫描后逐行 JSON 解析；
   * 按 key 前缀跳过放在解析 payload 之前，不增加扫描次数。
   */
  listReadingTasks(
    documentId: string,
    options: { kind?: 'all' | 'reading' } = {}
  ): ReadingTaskSummary[] {
    const rows = this.db
      .prepare('SELECT task, payload, documents, updated FROM reading_tasks ORDER BY updated DESC')
      .all() as unknown as Array<{
      task: string;
      payload: string | null;
      documents: string | null;
      updated: number | null;
    }>;
    const onlyReading = options.kind === 'reading';
    const result: ReadingTaskSummary[] = [];
    for (const row of rows) {
      if (onlyReading && row.task.startsWith(TRANSLATION_JOB_TASK_PREFIX)) continue;
      try {
        const documents = row.documents ? (JSON.parse(row.documents) as unknown) : [];
        if (!Array.isArray(documents) || !documents.includes(documentId)) continue;
        const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
        const pagesRead = Array.isArray(payload.pagesRead)
          ? (payload.pagesRead as unknown[]).filter(
              (page): page is number => Number.isInteger(page)
            )
          : [];
        const unreadPages = Array.isArray(payload.unread_pages)
          ? (payload.unread_pages as unknown[]).filter(
              (page): page is number => Number.isInteger(page)
            )
          : [];
        result.push({
          taskId: row.task,
          question: typeof payload.question === 'string' ? payload.question : '',
          pagesRead,
          unreadPages,
          answer: typeof payload.answer === 'string' ? payload.answer : '',
          updated: row.updated ?? 0
        });
      } catch {
        // 损坏的任务记录不阻塞历史加载
      }
    }
    return result;
  }

  deleteMessages(documentId: string): void {
    this.db.prepare('DELETE FROM messages WHERE document_id = ?').run(documentId);
  }

  /** 删除阅读伙伴某个会话的消息（legacy=没有 sessionId 的旧消息）；返回删除条数。 */
  deleteDocumentSessionMessages(documentId: string, sessionId: string): number {
    const result = this.db
      .prepare(
        sessionId === 'legacy'
          ? "DELETE FROM messages WHERE document_id = ? AND (session_id = 'legacy' OR session_id IS NULL OR session_id = '')"
          : 'DELETE FROM messages WHERE document_id = ? AND session_id = ?'
      )
      .run(...(sessionId === 'legacy' ? [documentId] : [documentId, sessionId]));
    return Number(result.changes ?? 0);
  }

  /** 阅读伙伴会话清单（按更新时间倒序）；摘要为空时不返回字段。 */
  listDocumentChatSessions(documentId: string): DocumentChatSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, created, updated, context_summary, summary_upto, transcript_version
         FROM document_chat_sessions WHERE document_id = ? ORDER BY created ASC, id`
      )
      .all(documentId) as unknown as Array<{
      id: string;
      title: string | null;
      created: string | null;
      updated: string | null;
      context_summary: string | null;
      summary_upto: number | null;
      transcript_version: number | null;
    }>;
    return rows.map((row) => {
      const summary = row.context_summary ?? '';
      return {
        id: row.id,
        title: row.title ?? '',
        created: row.created ?? '',
        updated: row.updated ?? '',
        ...(summary ? { contextSummary: summary, summaryUpto: Number(row.summary_upto ?? 0) } : {}),
        transcriptVersion: Number(row.transcript_version ?? 0)
      };
    });
  }

  /** 保存阅读伙伴会话清单：逐行 upsert（不删除调用方没带上的会话，避免多窗口互相清掉）。 */
  saveDocumentChatSessions(
    documentId: string,
    sessions: readonly DocumentChatSessionRecord[]
  ): DocumentChatSessionRecord[] {
    const upsertWithSummary = this.db.prepare(
      `INSERT INTO document_chat_sessions(document_id, id, title, created, updated, context_summary, summary_upto)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, id) DO UPDATE SET
         title = excluded.title,
         updated = excluded.updated,
         context_summary = excluded.context_summary,
         summary_upto = excluded.summary_upto`
    );
    // 客户端整表保存时通常只带标题/时间、不带摘要；此时不能把服务端刚写完的摘要覆盖成空。
    const upsertMetadataOnly = this.db.prepare(
      `INSERT INTO document_chat_sessions(document_id, id, title, created, updated, context_summary, summary_upto)
       VALUES (?, ?, ?, ?, ?, '', 0)
       ON CONFLICT(document_id, id) DO UPDATE SET
         title = excluded.title,
         updated = excluded.updated`
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const session of sessions) {
        const created = session.created || new Date().toISOString();
        const updated = session.updated || new Date().toISOString();
        if (Object.prototype.hasOwnProperty.call(session, 'contextSummary')) {
          const summary =
            typeof session.contextSummary === 'string' ? session.contextSummary : '';
          upsertWithSummary.run(
            documentId,
            session.id,
            session.title ?? '',
            created,
            updated,
            summary,
            summary ? Number(session.summaryUpto ?? 0) : 0
          );
        } else {
          upsertMetadataOnly.run(
            documentId,
            session.id,
            session.title ?? '',
            created,
            updated
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listDocumentChatSessions(documentId);
  }

  /** 创建阅读会话（幂等：同 id 已存在时返回已有记录，不覆盖摘要/版本）。 */
  createDocumentChatSession(
    documentId: string,
    session: DocumentChatSessionRecord
  ): DocumentChatSessionRecord {
    this.db
      .prepare(
        `INSERT INTO document_chat_sessions(document_id, id, title, created, updated, context_summary, summary_upto)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id, id) DO NOTHING`
      )
      .run(
        documentId,
        session.id,
        session.title ?? '',
        session.created || new Date().toISOString(),
        session.updated || new Date().toISOString(),
        typeof session.contextSummary === 'string' ? session.contextSummary : '',
        Number(session.summaryUpto ?? 0)
      );
    return this.listDocumentChatSessions(documentId).find((item) => item.id === session.id)!;
  }

  /** 细粒度更新阅读会话：只更新调用方显式提供的字段，不碰其它字段/摘要（摘要走 CAS）。 */
  updateDocumentChatSession(
    documentId: string,
    sessionId: string,
    patch: {
      title?: string;
      updated?: string;
      contextSummary?: string | undefined;
      summaryUpto?: number;
    }
  ): DocumentChatSessionRecord | null {
    const assignments: string[] = [];
    const params: Array<string | number> = [];
    if (typeof patch.title === 'string') {
      assignments.push('title = ?');
      params.push(patch.title.trim().slice(0, 120));
    }
    if (typeof patch.updated === 'string' && patch.updated.trim()) {
      assignments.push('updated = ?');
      params.push(patch.updated);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'contextSummary')) {
      assignments.push('context_summary = ?', 'summary_upto = ?');
      params.push(
        typeof patch.contextSummary === 'string' ? patch.contextSummary : '',
        typeof patch.summaryUpto === 'number' && Number.isInteger(patch.summaryUpto)
          ? patch.summaryUpto
          : 0
      );
    }
    if (assignments.length > 0) {
      const result = this.db
        .prepare(
          `UPDATE document_chat_sessions SET ${assignments.join(', ')}
            WHERE document_id = ? AND id = ?`
        )
        .run(...params, documentId, sessionId);
      if (Number(result.changes ?? 0) === 0) return null;
    }
    return this.listDocumentChatSessions(documentId).find((item) => item.id === sessionId) ?? null;
  }

  /** 摘要条件写回：只有 transcript_version 仍是期望值时才更新，返回是否写入成功。 */
  compareAndSetDocumentChatSessionSummary(
    documentId: string,
    sessionId: string,
    expectedVersion: number,
    summary: string,
    summaryUpto: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE document_chat_sessions
            SET context_summary = ?, summary_upto = ?, updated = ?
          WHERE document_id = ? AND id = ? AND transcript_version = ?`
      )
      .run(
        summary,
        summaryUpto,
        new Date().toISOString(),
        documentId,
        sessionId,
        expectedVersion
      );
    return Number(result.changes ?? 0) > 0;
  }

  /** 删除阅读伙伴会话（消息 + 会话行）；返回删除的消息条数。 */
  deleteDocumentChatSession(documentId: string, sessionId: string): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.deleteDocumentSessionMessages(documentId, sessionId);
      this.db
        .prepare('DELETE FROM document_chat_sessions WHERE document_id = ? AND id = ?')
        .run(documentId, sessionId);
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 跨文献（语料）会话（schema_version 23；24 起消息带 scope_kind='corpus' + 审计摘要；
  // 25 起会话记录来源项目快照）：范围是建立时的文献 id 快照。
  // document_chat_sessions 的主键与「一会话一篇文献」语义完全
  // 不变；这里是另一张表。消息复用 messages：document_id 空串哨兵 + session_id，
  // 详见 CORPUS_MESSAGE_DOCUMENT_ID。
  // ---------------------------------------------------------------------------

  /** 读一个跨文献会话（含范围快照，按写入顺序）；不存在返回 null。 */
  getCorpusSession(id: string): CorpusSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, title, created_at, updated_at, archived_at,
                source_project_id, source_project_name
         FROM corpus_sessions WHERE id = ?`
      )
      .get(id) as
      | {
          id?: string;
          title?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
          archived_at?: string | null;
          source_project_id?: string | null;
          source_project_name?: string | null;
        }
      | undefined;
    if (!row?.id) return null;
    const documents = this.db
      .prepare('SELECT document_id FROM corpus_session_documents WHERE session_id = ? ORDER BY rowid')
      .all(id) as unknown as Array<{ document_id?: string }>;
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      archivedAt: String(row.archived_at ?? ''),
      // 来源项目 id 允许悬空（项目已删除）：读取侧不做存在性判断，原样返回。
      sourceProjectId: row.source_project_id ? String(row.source_project_id) : null,
      sourceProjectName:
        row.source_project_name === null || row.source_project_name === undefined
          ? null
          : String(row.source_project_name),
      documentIds: documents
        .map((item) => String(item.document_id ?? ''))
        .filter((documentId) => documentId.length > 0)
    };
  }

  /** 列出跨文献会话（最近更新的在前；归档列本版只读不写）。 */
  listCorpusSessions(): CorpusSessionRecord[] {
    const rows = this.db
      .prepare('SELECT id FROM corpus_sessions ORDER BY updated_at DESC, created_at DESC, id')
      .all() as unknown as Array<{ id?: string }>;
    return rows.flatMap((row) => {
      const session = row.id ? this.getCorpusSession(String(row.id)) : null;
      return session ? [session] : [];
    });
  }

  /**
   * 建跨文献会话：会话行 + 范围快照行同一事务写入。
   *
   * 只做去重/去空白，不校验文献是否存在——范围是用户的显式决定，当前已删除的文献也保留在
   * 快照里（恢复后仍可读）；读取时跳过并如实报告，而不是建立时静默改写用户的快照。
   *
   * `sourceProject` 可选：用 projectId 建会话时由调用方传入**当时**的项目 id 与名字，
   * 一起落库成快照（schema_version 25）。项目之后改名/删除都不影响这两个字段；不传则两列为 NULL。
   */
  createCorpusSession(
    title: string,
    documentIds: readonly string[],
    sourceProject?: { id: string; name: string } | null
  ): CorpusSessionRecord {
    const ids = [...new Set(documentIds.map((documentId) => documentId.trim()).filter(Boolean))];
    if (ids.length === 0) throw new Error('至少需要一篇文献');
    const sourceProjectId = sourceProject?.id?.trim() || null;
    // 只有确实带了来源项目才写名字：id 与 name 同写同空，避免出现「有 id 没名字」的半个快照。
    const sourceProjectName = sourceProjectId
      ? (sourceProject?.name ?? '').trim().slice(0, 60)
      : null;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO corpus_sessions(
             id, title, created_at, updated_at, archived_at, source_project_id, source_project_name
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, title.trim().slice(0, 120), now, now, '', sourceProjectId, sourceProjectName);
      const insertDocument = this.db.prepare(
        'INSERT INTO corpus_session_documents(session_id, document_id) VALUES (?, ?)'
      );
      for (const documentId of ids) insertDocument.run(id, documentId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const created = this.getCorpusSession(id);
    if (!created) throw new Error('创建跨文献会话后无法读取');
    return created;
  }

  /** 追问/建会话后刷新 updated_at（列表按它排序）。 */
  touchCorpusSession(id: string, at = new Date().toISOString()): void {
    this.db.prepare('UPDATE corpus_sessions SET updated_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * 删跨文献会话：删消息（只删 document_id 空串、session_id 为该会话的行）+ 范围快照 + 会话行。
   * 返回删除的消息条数；会话不存在返回 null。
   */
  deleteCorpusSession(id: string): number | null {
    if (!this.getCorpusSession(id)) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare('DELETE FROM messages WHERE document_id = ? AND session_id = ?')
        .run(CORPUS_MESSAGE_DOCUMENT_ID, id);
      this.db.prepare('DELETE FROM corpus_session_documents WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM corpus_sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return Number(result.changes ?? 0);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 往跨文献会话里落一条消息（追问的 user 与回答的 assistant）。
   *
   * 直接写 messages，不用 `addMessage`：后者要求 document_id 对应一篇真实文献，而跨文献会话
   * 的消息没有单篇归属。
   */
  addCorpusSessionMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: ChatSource[];
    metadata?: Record<string, unknown>;
    /**
     * 本轮回答的审计摘要（由调用方从 ChatResponse 压缩后传入）。
     * 落库为 `messages.audit_summary`，重开历史时据此恢复缺证/原文已变更/越界引用展示。
     */
    auditSummary?: ChatAuditSummary | null;
  }): ChatMessageRecord {
    if (!this.getCorpusSession(input.sessionId)) throw new Error('跨文献会话不存在');
    // 跨篇消息显式记 scope_kind='corpus'：空串 document_id 只是复用 messages 表的兼容手段，
    // 不再是唯一语义来源。user 消息没有审计信息，写 NULL。
    const auditSummary =
      input.role === 'assistant'
        ? (input.auditSummary ?? auditSummaryFromResponse(input.metadata?.response))
        : null;
    const result = this.db
      .prepare(
        'INSERT INTO messages(document_id, role, content, sources, metadata, session_id, scope_kind, audit_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        CORPUS_MESSAGE_DOCUMENT_ID,
        input.role,
        input.content,
        JSON.stringify(input.sources ?? []),
        JSON.stringify(input.metadata ?? {}),
        input.sessionId,
        'corpus',
        serializeAuditSummary(auditSummary)
      );
    return {
      id: Number(result.lastInsertRowid),
      documentId: CORPUS_MESSAGE_DOCUMENT_ID,
      role: input.role,
      content: input.content,
      sources: input.sources ?? [],
      metadata: input.metadata ?? {},
      created: new Date().toISOString(),
      sessionId: input.sessionId,
      scopeKind: 'corpus',
      ...(auditSummary ? { auditSummary } : {})
    };
  }

  /** 读跨文献会话消息（按 id 升序；只按 session_id 归属，不会串到单篇文献或别的跨文献会话）。 */
  listCorpusSessionMessages(sessionId: string): ChatMessageRecord[] {
    return this.listMessages(CORPUS_MESSAGE_DOCUMENT_ID, { sessionId });
  }

  deleteMessageIds(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    const remove = this.db.prepare('DELETE FROM messages WHERE id = ?');
    let removed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        remove.run(id);
        removed += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return removed;
  }

  /**
   * 编辑阅读页的一条用户消息并删除其后所有消息（编辑会保留该 user 消息本身）。
   *
   * 传 sessionId 时只在**该会话内**查找/删除，避免多会话下误删其它会话的消息。
   */
    editDocumentUserMessage(
    documentId: string,
    messageId: number,
    content: string,
    sessionId = ''
  ): { ok: boolean; removed: number } {
    const row = this.db
      .prepare('SELECT role FROM messages WHERE id = ? AND document_id = ?')
      .get(messageId, documentId) as { role: string } | undefined;
    if (!row || row.role !== 'user') return { ok: false, removed: 0 };
    const sessionRows = this.listMessages(documentId, sessionId ? { sessionId } : {});
    if (sessionId && !sessionRows.some((message) => message.id === messageId)) {
      return { ok: false, removed: 0 };
    }
    const removed = this.deleteMessageIds(
      sessionRows.filter((message) => message.id > messageId).map((message) => message.id)
    );
    this.db
      .prepare('UPDATE messages SET content = ? WHERE id = ?')
      .run(content.trim(), messageId);
    return { ok: true, removed };
  }

  /**
   * 删除阅读页某条消息及其后的所有消息（从这一轮起分支删除）。
   * 传 sessionId 时只在该会话内删除。
   */
  deleteDocumentMessagesFrom(
    documentId: string,
    messageId: number,
    sessionId = ''
  ): { ok: boolean; removed: number } {
    const row = this.db
      .prepare('SELECT id FROM messages WHERE id = ? AND document_id = ?')
      .get(messageId, documentId) as { id: number } | undefined;
    if (!row) return { ok: false, removed: 0 };
    const sessionRows = this.listMessages(documentId, sessionId ? { sessionId } : {});
    if (sessionId && !sessionRows.some((message) => message.id === messageId)) {
      return { ok: false, removed: 0 };
    }
    const removed = this.deleteMessageIds(
      sessionRows.filter((message) => message.id >= messageId).map((message) => message.id)
    );
    return { ok: true, removed };
  }

  /**
   * 阅读页重新生成：删除该文献（或指定会话里）「最后一条用户消息之后」的消息，
   * 返回最后一条用户消息正文与删除条数；用于重答时避免新旧回答并存。
   */
  rewindDocumentMessagesTail(
    documentId: string,
    sessionId = ''
  ): { content: string | null; removed: number } {
    const rows = this.listMessages(documentId, sessionId ? { sessionId } : {});
    let lastUser: { id: number; content: string } | null = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.role === 'user') {
        lastUser = { id: row.id, content: row.content };
        break;
      }
    }
    if (!lastUser) return { content: null, removed: 0 };
    const removed = this.deleteMessageIds(
      rows.filter((message) => message.id > lastUser!.id).map((message) => message.id)
    );
    return { content: lastUser.content, removed };
  }

  /**
   * 保存整篇翻译任务的进度快照。
   *
   * 与阅读任务共用 `reading_tasks` 表：key 用 `translation-job:<documentId>` 前缀与问答任务
   * 区分（见 `TRANSLATION_JOB_TASK_PREFIX`），payload 只有 status/total/done/currentPage/error，
   * 没有 question/pagesRead/unread_pages；因此 `listReadingTasks` 默认返回里会出现这类行
   * （question 为空），消费方不能假设列表里只有问答任务。
   */
  saveTranslationJob(state: {
    documentId: string;
    status: string;
    total: number;
    done: number;
    currentPage: number | null;
    error: string;
  }): void {
    this.saveReadingTask(`${TRANSLATION_JOB_TASK_PREFIX}${state.documentId}`, state, [
      state.documentId
    ]);
  }

  loadTranslationJob(documentId: string): {
    documentId: string;
    status: string;
    total: number;
    done: number;
    currentPage: number | null;
    error: string;
  } | null {
    return (
      this.loadReadingTask<{
        documentId: string;
        status: string;
        total: number;
        done: number;
        currentPage: number | null;
        error: string;
      }>(`${TRANSLATION_JOB_TASK_PREFIX}${documentId}`)?.payload ?? null
    );
  }

  /**
   * 旧库升级前的 schema 快照（VACUUM INTO）。
   * 备份失败必须中止迁移：宁可让用户重试，也不要无备份地改库。
   * 返回本次快照的绝对路径；保留上限的清理在迁移成功之后由 pruneMigrationBackups 处理。
   */
  private backupBeforeMigration(previousVersion: number): string {
    const folder = path.join(this.dataDir, 'migration-backups');
    mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(folder, `reader-before-v${previousVersion}-${stamp}.sqlite3`);
    this.backupDatabase(target);
    return target;
  }

  /**
   * 迁移**成功之后**的快照保留清理：`migration-backups/` 只保留最近
   * MIGRATION_BACKUP_KEEP 份迁移快照（含本次刚生成的那份），更早的删除。
   *
   * 约束（任何一条都不能放松）：
   * - 只认 `reader-before-v<数字>-*.sqlite3`；同目录里用户手动放的其它文件不碰。
   * - 本次刚生成的快照无条件保留：即使按时间排序它不在前 N 份里也不删。
   * - 清理失败只写错误日志，绝不抛错影响启动；旧快照最多多留几份。
   * - 必须在迁移成功路径上调用：迁移失败时快照是唯一救命稻草，不能清理。
   */
  private pruneMigrationBackups(currentBackupPath: string | null): void {
    const folder = path.join(this.dataDir, 'migration-backups');
    try {
      if (!existsSync(folder)) return;
      const currentName = currentBackupPath ? path.basename(currentBackupPath) : '';
      const snapshots = readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && isMigrationBackupName(entry.name))
        .map((entry) => entry.name)
        .sort(compareMigrationBackupsNewestFirst);
      // 先放入本次快照，再按「新 → 旧」补足到 N 份；其余全部删除。
      const keep = new Set<string>();
      if (currentName && snapshots.includes(currentName)) keep.add(currentName);
      for (const name of snapshots) {
        if (keep.size >= MIGRATION_BACKUP_KEEP) break;
        keep.add(name);
      }
      for (const name of snapshots) {
        if (keep.has(name)) continue;
        rmSync(path.join(folder, name), { force: true });
      }
    } catch (error) {
      // 清理失败不影响启动；错误日志本身写失败也会被 appendErrorLog 内部吞掉。
      appendErrorLog(this.dataDir, 'migration:prune-backups', error);
    }
  }

  private migrate(): void {
    // 迁移前的 schema 版本：决定是否需要回填 10 新增的 note_assets/refs。
    let previousVersion = 0;
    try {
      const row = this.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      previousVersion = Number(row?.value ?? 0) || 0;
    } catch {
      previousVersion = 0;
    }
    // 备份必须在 BEGIN 之前（VACUUM INTO 不能在事务内执行）。
    // 20：基线新增全书摘要缓存 + 选区冻结快照（selection_snapshots）。
    // 21：notes/annotations 新增内容来源 origin（AI 生成标记不再只靠正文文本判断）。
    // 22：新增逻辑项目 projects + 项目文献链接 project_documents（不绑目录，文献仍全局唯一）。
    // 23：新增跨文献语料会话 corpus_sessions + 范围快照 corpus_session_documents（只建表，
    //     消息复用 messages 的 session_id；document_chat_sessions 主键与语义不变）。
    // 24：messages 新增 scope_kind（'document' | 'corpus'，把跨篇消息的空串 document_id 哨兵
    //     变成显式语义）与 audit_summary（审计摘要 JSON：缺证/原文已变更/越界引用等只存计数，
    //     不存正文/完整响应）。旧消息默认 scope_kind='document'、audit_summary=NULL。
    // 25：corpus_sessions 新增 source_project_id / source_project_name（来源项目快照；项目删除后
    //     id 允许悬空、不建外键，name 存建会话时的项目名）。都只是加列，不重建表。
    // 26：documents 新增 metadata_source（题录来源；''=未知，读取接口返回 null）、
    //     zotero_item_key（Zotero 顶层条目 key，collection 增量同步按它就地更新）、
    //     zotero_collection_key（最近同步的 collection）、zotero_missing（Zotero 侧已删除标记，
    //     只标记不删本地文献）。都只是加列 + 一个索引，不重建表、不动旧行。
    // 27：清空历史遗留表 platform_connections（旧版本存过平台 API Key 的 DPAPI 密文）。
    //     当前代码零读零写；保留表结构以防旧版本回滚后报 "no such table"，只 DELETE 所有行。
    // 28：notes.agent_name / annotations.agent_name（谁写的：用户空串、agent 记 clientInfo.name）；
    //     新增 agent_grants / agent_operations 两张表（P1 写操作与撤销快照；当前只建表）。
    const currentVersion = 28;
    // 本次升级生成的快照路径；迁移成功后据此清理旧快照并保证这一份不被删。
    let migrationBackupPath: string | null = null;
    if (previousVersion > 0 && previousVersion < currentVersion) {
      migrationBackupPath = this.backupBeforeMigration(previousVersion);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
    this.db.exec(SCHEMA_SQL);

    // schema_version 27：清空 platform_connections 里的历史 API Key 密文。
    // 该表当前代码零读零写（migrateLegacy 也不再复制旧库的该表），保留空表只为兼容回滚。
    // 无条件 DELETE 而非 `if (previousVersion < 27)`：每次启动都幂等执行，也能兜住
    // “版本号已是 27 但表里仍有旧行”的半迁移库；表不存在时 SCHEMA_SQL 已先建出来。
    this.db.exec('DELETE FROM platform_connections');

    // 独立会话与 Agent 已移除：一次性删除旧会话表与历史备份（不可恢复）。
    const qaRemoved = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'standalone_qa_removed'")
      .get() as { value?: string } | undefined;
    if (!qaRemoved) {
      this.db.exec('DROP TABLE IF EXISTS qa_messages; DROP TABLE IF EXISTS qa_sessions;');
      try {
        rmSync(path.join(this.dataDir, 'backups'), { recursive: true, force: true });
      } catch {
        // 备份目录删除失败不影响启动；下次启动会重试（标记在清理后写入）。
      }
      this.db
        .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('standalone_qa_removed', '1')")
        .run();
    }

    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    const additions: Array<[string, string]> = [
      ['author', "TEXT DEFAULT ''"],
      ['publication', "TEXT DEFAULT ''"],
      ['doi', "TEXT DEFAULT ''"],
      ['title_key', "TEXT DEFAULT ''"],
      ['sha256', "TEXT DEFAULT ''"],
      ['size_bytes', 'INTEGER DEFAULT 0'],
      ['path', "TEXT DEFAULT ''"],
      ['deleted', 'INTEGER DEFAULT 0'],
      ['tags', "TEXT DEFAULT '[]'"],
      // schema_version 7 → 8：文献类型（Zotero itemType 原文，空串=未分类）与所属文件夹。
      ['doc_type', "TEXT DEFAULT ''"],
      ['folder_id', "TEXT DEFAULT ''"],
      // schema_version 8 → 9：默认排序位置（越小越靠前，拖拽只改这一列）。
      ['manual_order', 'REAL DEFAULT 0'],
      // schema_version 25 → 26：题录来源与 Zotero collection 同步状态。
      // 老库升级后 metadata_source 为 ''（读取接口按 NULL/未知返回），
      // zotero_item_key 为 ''（老记录没有 Zotero 条目 key，不猜）。
      ['metadata_source', "TEXT DEFAULT ''"],
      ['zotero_item_key', "TEXT DEFAULT ''"],
      ['zotero_collection_key', "TEXT DEFAULT ''"],
      ['zotero_missing', 'INTEGER DEFAULT 0']
    ];
    for (const [name, ddl] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${ddl}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS document_doi ON documents(doi);
      CREATE INDEX IF NOT EXISTS document_title_key ON documents(title_key);
      CREATE INDEX IF NOT EXISTS document_folder ON documents(folder_id);
      CREATE INDEX IF NOT EXISTS document_folder_type ON documents(folder_id, doc_type);
      CREATE INDEX IF NOT EXISTS document_zotero_item ON documents(zotero_item_key);
    `);
    // schema_version 8 → 9：给旧库回填默认排序位置。
    // 列刚 ALTER 出来时所有行都是 0；按当前列表的展示顺序（created DESC, rowid DESC）
    // 赋 1..N，这样旧库首次升级后的默认顺序与升级前的列表完全一致。
    // 半迁移（列已加但回填未完成）同样是"全 0"，再次启动会补上；正常库不会触发。
    this.backfillManualOrder();
    const missingTitleKeys = this.db
      .prepare("SELECT id, name FROM documents WHERE title_key = ''")
      .all() as unknown as Array<{ id: string; name: string }>;
    const setTitleKey = this.db.prepare('UPDATE documents SET title_key = ? WHERE id = ?');
    for (const row of missingTitleKeys) setTitleKey.run(normalizeKey(row.name ?? ''), row.id);

    const maskColumns = new Set(
      (this.db.prepare('PRAGMA table_info(page_masks)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    const maskAdditions: Array<[string, string]> = [
      ['scope', "TEXT DEFAULT 'page'"],
      ['range_start', 'INTEGER DEFAULT 1'],
      ['range_end', 'INTEGER DEFAULT 0'],
      ['exclude_pages', "TEXT DEFAULT '[]'"]
    ];
    for (const [name, ddl] of maskAdditions) {
      if (!maskColumns.has(name)) {
        this.db.exec(`ALTER TABLE page_masks ADD COLUMN ${name} ${ddl}`);
      }
    }

    // schema_version 6 → 7：notes.external_key 用于按外部来源（Zotero note key）去重。
    // 老数据库的 notes 表没有该列，先查 PRAGMA 再 ALTER；重复启动 / 半迁移的库都能幂等通过。
    const noteColumns = new Set(
      (this.db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!noteColumns.has('external_key')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN external_key TEXT DEFAULT ''");
    }
    // schema_version 10 → 11：笔记来源文件夹层级（Markdown 导入用；'' = 根目录）。
    if (!noteColumns.has('folder_path')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN folder_path TEXT DEFAULT ''");
    }
    // schema_version 11 → 12：笔记标签（JSON 数组文本，安全默认 '[]'）。
    if (!noteColumns.has('tags')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT '[]'");
    }
    // schema_version 18 → 19：笔记手动排序位置（越小越靠前；拖拽排序只改这一列）。
    // 旧库升级时按 rowid 递增回填，保证升级前后列表顺序稳定（ALTER/回填/版本号同一事务）。
    if (!noteColumns.has('manual_order')) {
      this.db.exec('ALTER TABLE notes ADD COLUMN manual_order REAL DEFAULT 0');
    }
    // schema_version 20 → 21：内容来源（'ai' = 系统代写 AI 生成内容，'user' = 用户内容）。
    // 老库先 ALTER 补列，默认 'user'；迁移前的 AI 笔记仍由导出时的文本兜底识别。
    // NOT NULL + 常量默认值对 SQLite 的 ALTER ADD COLUMN 是合法写法，不需要重建表。
    if (!noteColumns.has('origin')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    }
    // schema_version 28：写入内容的 agent 名字（用户写入为空串）；旧行回填 ''。
    if (!noteColumns.has('agent_name')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''");
    }
    // annotations 同样补 origin：AI 译文/识别结果写入批注时由系统置 'ai'。
    // PRAGMA 单独查一次，避免和上面 notes 的列集合混用。
    const annotationColumns = new Set(
      (this.db.prepare('PRAGMA table_info(annotations)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!annotationColumns.has('origin')) {
      this.db.exec("ALTER TABLE annotations ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    }
    // schema_version 28：写入这条批注的 agent 名字（用户写入为空串）。
    if (!annotationColumns.has('agent_name')) {
      this.db.exec("ALTER TABLE annotations ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''");
    }
    // schema_version 23 → 24：消息作用域显式化 + 审计摘要落库（都只是加列，不重建表）。
    // - scope_kind：跨篇消息此前靠 document_id='' 哨兵，语义不清；现在显式记 'corpus'，
    //   单篇消息记 'document'。NOT NULL + 常量默认值对 SQLite 的 ALTER ADD COLUMN 合法，
    //   旧消息按默认值 'document' 兜底（读取不依赖该列，缺/空也照样能读）。
    // - audit_summary：可空 JSON，旧消息保持 NULL；读取侧解析失败即视为没有摘要。
    const messageColumns = new Set(
      (this.db.prepare('PRAGMA table_info(messages)').all() as unknown as Array<{
        name: string;
      }>).map((column) => column.name)
    );
    if (!messageColumns.has('scope_kind')) {
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'document'"
      );
    }
    if (!messageColumns.has('audit_summary')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN audit_summary TEXT');
    }
    // schema_version 24 → 25：跨文献会话记录来源项目快照（都只是加可空列，不重建表）。
    // - source_project_id：用 projectId 建会话时写项目 id；**不建外键**，项目删除后允许悬空，
    //   避免删项目时连带删掉会话（会话的范围快照与会话本身仍独立存在）。
    // - source_project_name：建会话那一刻的项目名快照；项目之后改名/删除仍显示当时名字。
    // 旧会话与不用 projectId 建的会话保持 NULL。
    const corpusSessionColumns = new Set(
      (this.db.prepare('PRAGMA table_info(corpus_sessions)').all() as unknown as Array<{
        name: string;
      }>).map((column) => column.name)
    );
    if (!corpusSessionColumns.has('source_project_id')) {
      this.db.exec('ALTER TABLE corpus_sessions ADD COLUMN source_project_id TEXT');
    }
    if (!corpusSessionColumns.has('source_project_name')) {
      this.db.exec('ALTER TABLE corpus_sessions ADD COLUMN source_project_name TEXT');
    }
    if (previousVersion < 19) this.backfillNoteManualOrder();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS note_external_key ON notes(document_id, external_key)`
    );
    this.db.exec("UPDATE notes SET tags = '[]' WHERE tags IS NULL OR tags = ''");

    // schema_version 9 → 10：回填资源登记表（扫描目录 + 所有笔记/批注引用）。
    // 旧库升级时跑一次；已是 10 的库不再重复扫描（迁移幂等，见 previousVersion）。
    if (previousVersion < 10) {
      noteAssets.rebuildRefs(this.db, this.noteAssetDeps, false);
    }
    // 12：从 notes.folder_path 回填虚拟文件夹（含祖先目录）；幂等。
    this.backfillNoteFolders();
    // 15：阅读会话清单 settings JSON → document_chat_sessions 表；messages 增加 session_id。
    if (previousVersion < 15) {
      this.migrateDocumentChatSessions();
    }
    // 16：会话 transcript_version + 消息增删改触发器；摘要写回用版本号做条件更新。
    if (previousVersion < 16) {
      this.migrateDocumentChatTranscriptVersion();
    }
    // 17：按文献的检索版本；阅读页/单文献索引缓存只受该文献写入影响。
    if (previousVersion < 17) {
      this.migrateDocumentRetrievalDocumentRevision();
    }
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)')
      .run('schema_version', '28');
      this.db.exec('COMMIT');
    } catch (error) {
      // 整体回滚：schema、回填、schema_version 一起回到迁移前；迁移前快照仍保留在
      // dataDir/migration-backups/，必要时可人工恢复。失败路径直接 rethrow，
      // 不会走到下面的快照清理（失败时快照是唯一救命稻草，绝不能删）。
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 事务可能已由 SQLite 自动回滚（例如磁盘满）；忽略二次回滚错误。
      }
      throw error;
    }

    // 只有事务提交成功才会执行到这里：清理更早的迁移快照，只保留最近
    // MIGRATION_BACKUP_KEEP 份（本次刚生成的这份无条件保留）。清理失败只记日志，不影响启动。
    this.pruneMigrationBackups(migrationBackupPath);
  }

  /** schema 17：按文献检索版本表 + chunks/结构/译文/文献改名触发器。 */
  private migrateDocumentRetrievalDocumentRevision(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_document_revision(
        document_id TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_chunks_ai
        AFTER INSERT ON chunks BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_chunks_au
        AFTER UPDATE ON chunks BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (OLD.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_chunks_ad
        AFTER DELETE ON chunks BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (OLD.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_structures_ai
        AFTER INSERT ON structures BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.document, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_structures_au
        AFTER UPDATE ON structures BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.document, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_structures_ad
        AFTER DELETE ON structures BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (OLD.document, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_translations_ai
        AFTER INSERT ON translation_segments BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_translations_au
        AFTER UPDATE ON translation_segments BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_translations_ad
        AFTER DELETE ON translation_segments BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (OLD.document_id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retrieval_doc_revision_documents_au
        AFTER UPDATE OF name ON documents BEGIN
          INSERT INTO retrieval_document_revision(document_id, value)
          VALUES (NEW.id, 1)
          ON CONFLICT(document_id) DO UPDATE SET value = value + 1;
        END;
    `);
  }

  /** schema 16：阅读会话消息版本号 + 触发器（消息增删改都会递增对应会话的版本）。 */
  private migrateDocumentChatTranscriptVersion(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(document_chat_sessions)').all() as unknown as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );
    if (!columns.has('transcript_version')) {
      this.db.exec(
        'ALTER TABLE document_chat_sessions ADD COLUMN transcript_version INTEGER NOT NULL DEFAULT 0'
      );
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS document_chat_transcript_ai
        AFTER INSERT ON messages BEGIN
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = NEW.document_id AND id = NEW.session_id;
        END;
      CREATE TRIGGER IF NOT EXISTS document_chat_transcript_au
        AFTER UPDATE ON messages BEGIN
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = NEW.document_id AND id = NEW.session_id;
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = OLD.document_id AND id = OLD.session_id;
        END;
      CREATE TRIGGER IF NOT EXISTS document_chat_transcript_ad
        AFTER DELETE ON messages BEGIN
          UPDATE document_chat_sessions
             SET transcript_version = transcript_version + 1
           WHERE document_id = OLD.document_id AND id = OLD.session_id;
        END;
    `);
  }

  /**
   * schema 15 迁移：阅读伙伴会话从 settings JSON 落到 document_chat_sessions 表，
   * messages 增加 session_id 列（旧消息统一 legacy）。迁移幂等：列已存在/表已有记录不会重复覆盖。
   */
  private migrateDocumentChatSessions(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(messages)').all() as unknown as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );
    if (!columns.has('session_id')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN session_id TEXT DEFAULT 'legacy'");
    }
    // 从旧 metadata.sessionId 回填；没有/无效的保持 legacy。
    const messageRows = this.db
      .prepare(
        "SELECT id, metadata FROM messages WHERE session_id IS NULL OR session_id = '' OR session_id = 'legacy'"
      )
      .all() as unknown as Array<{ id: number; metadata: string | null }>;
    const updateMessage = this.db.prepare('UPDATE messages SET session_id = ? WHERE id = ?');
    for (const row of messageRows) {
      try {
        const metadata = row.metadata ? (JSON.parse(row.metadata) as unknown) : null;
        if (!metadata || typeof metadata !== 'object') continue;
        const sessionId = (metadata as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === 'string' && sessionId.trim() && sessionId.trim() !== 'legacy') {
          updateMessage.run(sessionId.trim(), row.id);
        }
      } catch {
        // 损坏 metadata 保持 legacy
      }
    }
    // settings 里的旧会话清单迁移到表；legacy 按 document 区分，不会跨文献冲突。
    const legacyRows = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'doc-chat.sessions.%'")
      .all() as unknown as Array<{ key: string; value: string }>;
    const insertSession = this.db.prepare(
      `INSERT INTO document_chat_sessions(document_id, id, title, created, updated, context_summary, summary_upto)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, id) DO NOTHING`
    );
    const removeSetting = this.db.prepare('DELETE FROM settings WHERE key = ?');
    for (const row of legacyRows) {
      const documentId = row.key.slice('doc-chat.sessions.'.length);
      if (!documentId) continue;
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const session = item as Record<string, unknown>;
            const id = typeof session.id === 'string' ? session.id.trim().slice(0, 80) : '';
            if (!id) continue;
            const now = new Date().toISOString();
            insertSession.run(
              documentId,
              id,
              typeof session.title === 'string' ? session.title.trim().slice(0, 120) : '',
              typeof session.created === 'string' ? session.created : now,
              typeof session.updated === 'string' ? session.updated : now,
              typeof session.contextSummary === 'string'
                ? session.contextSummary.trim().slice(0, 8000)
                : '',
              typeof session.summaryUpto === 'number' && Number.isInteger(session.summaryUpto)
                ? session.summaryUpto
                : 0
            );
          }
        }
        removeSetting.run(row.key);
      } catch {
        // 损坏的旧清单保留在 settings 里，人工可查；不阻断升级
      }
    }
  }

  /**
   * 文献域的显式依赖：数据目录、引用图缓存失效、页校订后的索引重建与版面读取。
   *
   * 域模块不接收 Store 实例、也不 import 索引/解析链路；页校订同步 chunks/FTS 与版面
   * 解析都通过这两个回调注入（见 store/documents.ts 的拆分约定与事务不变量）。
   */
  private get documentDomainDeps(): documentDomain.DocumentDomainDeps {
    return {
      dataDir: this.dataDir,
      invalidateReferenceGraphCache: () => this.invalidateReferenceGraphCache(),
      readLayoutPage: async (documentId, page) => {
        const layout = await this.readLayout(documentId).catch(() => null);
        return layout?.pages.find((item) => item.page === page) ?? null;
      },
      rebuildPageChunks: (documentId, page, text, boxesJson, layoutPage) =>
        this.rebuildPageChunks(documentId, page, text, boxesJson, layoutPage ?? undefined)
    };
  }

  /**
   * 薄委托：回填文献默认排序（schema_version 9）。
   * 实现与「必须运行在 migrate() 事务里」的不变量见 store/documents.ts 的 backfillManualOrder。
   */
  private backfillManualOrder(): void {
    documentDomain.backfillManualOrder(this.db);
  }

  /** 薄委托：新文献默认排序位置；实现见 store/documents.ts 的 nextManualOrder。 */
  private nextManualOrder(): number {
    return documentDomain.nextManualOrder(this.db);
  }

  /**
   * 薄委托：回填笔记默认排序（schema_version 19）。实现与「必须运行在 migrate() 事务里」
   * 的不变量见 store/notes.ts 的 backfillNoteManualOrder。
   */
  private backfillNoteManualOrder(): void {
    noteDomain.backfillNoteManualOrder(this.db);
  }

  /**
   * 笔记资源域的显式依赖：syncSource / GC / 全量重建只通过它拿时间、uuid、资源目录与
   * settings，不把 Store 实例传进域模块（见 store/note-assets.ts 的拆分约定）。
   */
  private get noteAssetDeps(): noteAssets.NoteAssetDeps {
    return {
      assetDir: path.join(this.dataDir, NOTE_ASSET_DIR),
      now: () => new Date().toISOString(),
      uuid: () => randomUUID(),
      readSettings: () => this.getSettings(),
      updateSettings: (patch, manageTransaction) => {
        this.updateSettings(patch, manageTransaction);
      }
    };
  }

  /**
   * 笔记域的显式依赖：时间、文献页码校验、资源引用同步、写后失效引用图缓存、
   * 彻底删除后的资源回收。
   *
   * 域模块不接收 Store 实例，也不 import note-assets；交界全部通过这些回调注入
   * （见 store/notes.ts 的拆分约定与事务不变量）。`syncNoteAssetRefs` 直接转给
   * note-assets 的 syncSource：它必须在笔记域已打开的同一事务里执行，绝不自己 BEGIN。
   */
  private get noteDomainDeps(): noteDomain.NoteDomainDeps {
    return {
      now: () => new Date().toISOString(),
      getDocument: (id) => this.getDocument(id),
      syncNoteAssetRefs: (sourceKind, sourceId, content) =>
        this.syncNoteAssetRefs(sourceKind, sourceId, content),
      refreshAssetCounts: (assetIds) => noteAssets.refreshCounts(this.db, assetIds),
      purgeAssetRecords: (assetIds) =>
        noteAssets.purgeRecords(this.db, this.noteAssetDeps, assetIds),
      invalidateReferenceGraphCache: () => this.invalidateReferenceGraphCache()
    };
  }

  /**
   * 批注域的显式依赖：时间、资源引用同步、彻底删除后的资源回收、写后失效引用图缓存。
   *
   * 与笔记域同一套交界：域模块不接收 Store 实例，也不 import note-assets；全部通过
   * 这些回调注入（见 store/annotations.ts 的拆分约定与事务不变量）。`syncNoteAssetRefs`
   * 必须在批注域已打开的同一事务里执行，绝不自己 BEGIN。
   */
  private get annotationDomainDeps(): annotationDomain.AnnotationDomainDeps {
    return {
      now: () => new Date().toISOString(),
      syncNoteAssetRefs: (sourceKind, sourceId, content) =>
        this.syncNoteAssetRefs(sourceKind, sourceId, content),
      refreshAssetCounts: (assetIds) => noteAssets.refreshCounts(this.db, assetIds),
      purgeAssetRecords: (assetIds) =>
        noteAssets.purgeRecords(this.db, this.noteAssetDeps, assetIds),
      invalidateReferenceGraphCache: () => this.invalidateReferenceGraphCache()
    };
  }

  /**
   * 后台重建器：懒创建，任务状态在 NoteAssetReindexer 里（Store 不再持有 job/running）。
   * 同步写路径与后台重建共用 `syncNoteAssetRefs`，因此这里动态引用它。
   */
  private get noteAssetReindexer(): NoteAssetReindexer {
    this.noteAssetReindexerInstance ??= new NoteAssetReindexer(this.db, {
      ...this.noteAssetDeps,
      syncSource: (kind, sourceId, content) => this.syncNoteAssetRefs(kind, sourceId, content)
    });
    return this.noteAssetReindexerInstance;
  }

  /**
   * 同步一条笔记/批注的资源引用：先删旧 refs，再按当前内容插入新 refs。
   * 只影响被删/新增的资源计数，不做全量扫描。
   *
   * 薄委托：实现（含「调用方事务内执行」的不变量）见 store/note-assets.ts 的 syncSource。
   */
  private syncNoteAssetRefs(
    sourceKind: 'note' | 'annotation',
    sourceId: string,
    content: string
  ): void {
    noteAssets.syncSource(this.db, sourceKind, sourceId, content, this.noteAssetDeps);
  }

  /** 薄委托：文献类型长度/控制字符校验；实现见 store/documents.ts 的 documentTypeOf。 */
  private documentTypeOf(input: string): string {
    return documentDomain.documentTypeOf(input);
  }

  /** 分类文件夹总览（含未分类与分栏计数）；实现见 store/documents.ts。 */
  listFolders(): FolderOverview {
    return documentDomain.listFolders(this.db);
  }

  createFolder(name: string): FolderSummary {
    return documentDomain.createFolder(this.db, name);
  }

  renameFolder(id: string, name: string): FolderSummary {
    return documentDomain.renameFolder(this.db, id, name);
  }

  /** 删文件夹只把文献归属移回未分类，不删文献；实现见 store/documents.ts。 */
  deleteFolder(id: string): { movedDocuments: number } {
    return documentDomain.deleteFolder(this.db, id);
  }

  // ---------------------------------------------------------------------------
  // 逻辑项目（schema_version 22）：实现已抽到 ./store/projects.ts。
  // 拆分模式：纯函数 + 显式依赖注入（db + deps），Store 只保留薄委托，
  // 调用方签名/返回结构不变；跨表写事务（deleteProject）仍在实现里一次性完成。
  // ---------------------------------------------------------------------------

  /** 项目域依赖：时间、id、文献读取由 Store 显式提供，模块不持有 Store 实例。 */
  private get projectDeps(): projectDomain.ProjectDeps {
    return {
      now: () => new Date().toISOString(),
      uuid: randomUUID,
      getDocument: (id) => this.getDocument(id)
    };
  }

  /** 列出项目（默认不含归档）；documentCount 只数未进回收站的文献。 */
  listProjects(includeArchived = false): ProjectSummary[] {
    return projectDomain.listProjects(this.db, this.projectDeps, includeArchived);
  }

  getProject(id: string): ProjectSummary | null {
    return projectDomain.getProject(this.db, this.projectDeps, id);
  }

  createProject(input: CreateProjectInput): ProjectSummary {
    return projectDomain.createProject(this.db, this.projectDeps, input);
  }

  /** 改名/改描述/归档都在这里：只更新传了的字段，名称冲突给出中文错误。 */
  updateProject(id: string, patch: UpdateProjectInput): ProjectSummary {
    return projectDomain.updateProject(this.db, this.projectDeps, id, patch);
  }

  archiveProject(id: string): ProjectSummary {
    return projectDomain.archiveProject(this.db, this.projectDeps, id);
  }

  /** 删项目只删链接、不删文献；返回解除关联的文献数（含回收站里的文献链接）。 */
  deleteProject(id: string): ProjectDeleteResult {
    return projectDomain.deleteProject(this.db, this.projectDeps, id);
  }

  /** 把文献加入项目（重复加入幂等）；只建链接，不改文献归属。 */
  addProjectDocument(projectId: string, documentId: string): ProjectDocumentRecord {
    return projectDomain.addProjectDocument(this.db, this.projectDeps, projectId, documentId);
  }

  removeProjectDocument(projectId: string, documentId: string): void {
    projectDomain.removeProjectDocument(this.db, this.projectDeps, projectId, documentId);
  }

  /** 项目下的文献（只读链接；隐藏进应用回收站的文献，恢复后自动重新出现）。 */
  listProjectDocuments(projectId: string): ProjectDocumentRecord[] {
    return projectDomain.listProjectDocuments(this.db, this.projectDeps, projectId);
  }

  // -------------------------------------------------------------------------
  // 文献读路径：实现已抽到 ./store/documents.ts，Store 只留薄委托，签名/返回结构不变。
  // -------------------------------------------------------------------------

  listDocuments(trash = false): DocumentSummary[] {
    return documentDomain.listDocuments(this.db, this.documentDomainDeps, trash);
  }

  getDocument(id: string): DocumentDetail | null {
    return documentDomain.getDocument(this.db, this.documentDomainDeps, id);
  }

  /** 文献在 Zotero 侧的外部身份 key（未删除才有）；语义见 store/documents.ts。 */
  getDocumentExternalKey(id: string): string {
    return documentDomain.getDocumentExternalKey(this.db, id);
  }

  /** 按外部身份（含升级前旧身份）/Zotero 顶层条目 key 查已存在文献；语义见 store/documents.ts。 */
  findZoteroDocumentId(input: {
    identity?: string;
    legacyIdentity?: string;
    zoteroItemKey?: string;
  }): string | null {
    return documentDomain.findZoteroDocumentId(this.db, input);
  }

  /** 最近一次同步记录为属于该 Zotero collection 的本地文献；语义见 store/documents.ts。 */
  listZoteroCollectionDocuments(collectionKey: string): Array<{
    documentId: string;
    zoteroItemKey: string;
    zoteroMissing: boolean;
  }> {
    return documentDomain.listZoteroCollectionDocuments(this.db, collectionKey);
  }

  /** 标记/取消「Zotero 侧已删除」，返回标记是否变化；语义见 store/documents.ts。 */
  setZoteroMissing(documentId: string, missing: boolean): boolean {
    return documentDomain.setZoteroMissing(this.db, documentId, missing);
  }

  /** 清理 Zotero collection 归属（文献与条目 key 不动）；语义见 store/documents.ts。 */
  clearZoteroCollectionKey(documentId: string): void {
    documentDomain.clearZoteroCollectionKey(this.db, documentId);
  }

  // -------------------------------------------------------------------------
  // 批注域：实现已抽到 ./store/annotations.ts，Store 只留薄委托，签名/返回结构不变。
  // 拆分模式与 projects / note-assets / notes 相同（db + 显式 deps，不传 Store 实例）；
  // 事务边界、内容与 refs 同成同败、COMMIT 后回收资源与失效缓存等不变量见域模块文件头。
  // -------------------------------------------------------------------------

  /** 这篇文献里已写入过外部标识的批注 key（含软删除行）；语义见 store/annotations.ts。 */
  annotationExternalKeys(documentId: string): Set<string> {
    return annotationDomain.annotationExternalKeys(this.db, documentId);
  }

  /** 按 external_key 索引这篇文献的批注（含软删除行）；语义见 store/annotations.ts。 */
  annotationExternalIndex(
    documentId: string
  ): Map<string, { id: string; rects: string; style: string; deleted: boolean }> {
    return annotationDomain.annotationExternalIndex(this.db, documentId);
  }

  /** 只更新批注的页面几何（rects / style）；实现见 store/annotations.ts。 */
  setAnnotationGeometry(id: string, input: { rects: string; style: string }): void {
    annotationDomain.setAnnotationGeometry(this.db, id, input);
  }

  // -------------------------------------------------------------------------
  // 笔记读路径（外部稳定键）：实现已抽到 ./store/notes.ts，Store 只留薄委托。
  // -------------------------------------------------------------------------

  /** 这篇文献里已写入过外部标识的笔记 key（含软删除行）；语义见 store/notes.ts。 */
  noteExternalKeys(documentId: string): Set<string> {
    return noteDomain.noteExternalKeys(this.db, documentId);
  }

  /** 按外部稳定键查笔记（含回收站里的，用于导入去重/恢复）；不存在返回 null。 */
  findNoteByExternalKey(
    documentId: string,
    externalKey: string
  ): { id: string; deleted: boolean } | null {
    return noteDomain.findNoteByExternalKey(this.db, documentId, externalKey);
  }

  // -------------------------------------------------------------------------
  // 文献派生文本/路径/查重：实现已抽到 ./store/documents.ts，Store 只留薄委托。
  // -------------------------------------------------------------------------

  /** 这篇文献在本机已索引到的全部文字（chunks + page_edits）；语义见 store/documents.ts。 */
  documentTextState(documentId: string): string {
    return documentDomain.documentTextState(this.db, documentId);
  }

  chunkTextStats(documentId: string): { characters: number; cjk: number } {
    return documentDomain.chunkTextStats(this.db, documentId);
  }

  /** 文献附件路径（应用副本/Zotero 热链接，含 file_stamp 校验）；语义见 store/documents.ts。 */
  getDocumentPath(id: string): string | null {
    return documentDomain.getDocumentPath(this.db, this.documentDomainDeps, id);
  }

  /** 导入查重候选（文件/DOI/标题/Zotero）；语义见 store/documents.ts。 */
  findImportDuplicates(input: {
    sha256?: string;
    doi?: string;
    externalKey?: string;
    title?: string;
    author?: string;
    publication?: string;
    pages?: number;
  }): ImportDuplicateCandidate[] {
    return documentDomain.findImportDuplicates(this.db, input);
  }

  /**
   * 旧版本的 PDF.js 没有加载 GBK CMap，中文文本会被索引成标点碎片。
   * 这里在后台对“有中文标题但索引里没有中文”的旧文档重建一次 chunks。
   */
  async reindexLegacyChunks(): Promise<void> {
    const marker = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'text_index_v3'")
      .get() as { value?: string } | undefined;
    if (marker?.value === 'done') return;
    const docs = this.db
      .prepare('SELECT id, name, pages FROM documents WHERE deleted = 0')
      .all() as unknown as Array<{ id: string; name: string; pages: number }>;
    for (const doc of docs) {
      const sample = this.db
        .prepare('SELECT text FROM chunks WHERE document_id = ? LIMIT 100')
        .all(doc.id) as unknown as Array<{ text: string }>;
      const joined = sample.map((row) => row.text).join('');
      const needsCjkFix = /[\u3400-\u9fff]/.test(doc.name) && !/[\u3400-\u9fff]/.test(joined);
      // 期刊论文通常是双栏；短文档重建一次，恢复左右栏阅读顺序。
      const needsColumnOrder = doc.pages <= 20 && sample.length > 0;
      if (!needsCjkFix && !needsColumnOrder) continue;
      const filePath = this.getDocumentPath(doc.id);
      if (!filePath) continue;
      try {
        const parsed = await parsePdf(new Uint8Array(readFileSync(filePath)));
        this.writeChunks(doc.id, parsed.chunks);
        this.db
          .prepare('UPDATE documents SET pages = ? WHERE id = ?')
          .run(parsed.pages, doc.id);
      } catch {
        // 单个文档解析失败不影响应用启动，下次启动会再试。
      }
    }
    this.db
      .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('text_index_v3', 'done')")
      .run();
  }

  async importDocument(
    sourcePath: string,
    nameOverride?: string,
    confirmDuplicate = false,
    options?: {
      onProgress?: (progress: ImportProgress) => void;
      isCancelled?: () => boolean;
    }
  ): Promise<DocumentDetail> {
    options?.onProgress?.({ stage: 'reading', percent: 5 });
    const resolved = path.resolve(sourcePath);
    if (!existsSync(resolved)) {
      throw new Error('文件不存在');
    }
    const stats = statSync(resolved);
    if (!stats.isFile()) throw new Error('不是文件');
    const bytes = readFileSync(resolved);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('只支持 PDF 文件');
    }
    options?.onProgress?.({ stage: 'hashing', percent: 15 });

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = this.db
      .prepare('SELECT id FROM documents WHERE sha256 = ? AND deleted = 0')
      .get(sha256) as unknown as { id: string } | undefined;
    if (existing) {
      const document = this.getDocument(existing.id);
      if (document) {
        if (confirmDuplicate) return document;
        throw new DuplicateImportError(
          [
            {
              id: document.id,
              name: document.name,
              pages: document.pages,
              author: document.author,
              publication: document.publication,
              doi: '',
              match: 'file',
              reasons: ['文件内容完全相同']
            }
          ],
          false
        );
      }
    }

    if (options?.isCancelled?.()) throw new ImportCancelledError();
    options?.onProgress?.({ stage: 'parsing', percent: 30 });
    // 解析在 worker 线程：把 isCancelled 轮询接到 AbortSignal 上，取消能中断 worker 任务
    // （排队时直接出队，执行中 terminate 该 worker），错误仍映射成 ImportCancelledError。
    const controller = new AbortController();
    const cancelPoll = options?.isCancelled
      ? setInterval(() => {
          if (options.isCancelled?.()) controller.abort();
        }, 100)
      : null;
    cancelPoll?.unref?.();
    let parsed: ParsedPdf;
    try {
      parsed = await parsePdf(new Uint8Array(bytes), { signal: controller.signal });
    } catch (error) {
      if (error instanceof PdfParseCancelledError) throw new ImportCancelledError();
      throw error;
    } finally {
      if (cancelPoll) clearInterval(cancelPoll);
    }
    options?.onProgress?.({ stage: 'parsing', percent: 75 });
    if (options?.isCancelled?.()) throw new ImportCancelledError();
    const name = nameOverride?.trim() || path.basename(resolved);
    const candidates = this.findImportDuplicates({
      doi: parsed.doi,
      title: name,
      author: parsed.author,
      publication: parsed.publication,
      pages: parsed.pages
    });
    if (candidates.length > 0 && !confirmDuplicate) {
      throw new DuplicateImportError(candidates, true);
    }
    if (options?.isCancelled?.()) throw new ImportCancelledError();
    options?.onProgress?.({ stage: 'writing', percent: 85 });
    const id = randomUUID();
    const relativePath = path.join('papers', `${sha256}.pdf`);
    copyFileSync(resolved, path.join(this.dataDir, relativePath));

    this.db
      .prepare(
        `INSERT INTO documents
         (id, name, pages, current_page, created, deleted, storage_kind, tags, author,
          publication, doi, title_key, sha256, size_bytes, path, metadata_source, manual_order)
         VALUES (?, ?, ?, 1, ?, 0, 'copy', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        parsed.pages,
        new Date().toISOString(),
        parsed.author,
        parsed.publication,
        parsed.doi,
        normalizeKey(name),
        sha256,
        stats.size,
        relativePath,
        parsed.metadataSource,
        this.nextManualOrder()
      );

    this.writeChunks(id, parsed.chunks);
    this.invalidateReferenceGraphCache();

    const document = this.getDocument(id);
    if (!document) throw new Error('导入后无法读取文档');
    options?.onProgress?.({ stage: 'done', percent: 100 });
    return document;
  }

  async importZoteroDocument(input: {
    identity: string;
    /** 升级前的旧身份（不含 Server-ID/路径）；只用于命中已有记录，避免重复导入。 */
    legacyIdentity?: string;
    title: string;
    author: string;
    publication?: string;
    doi?: string;
    /** 父条目的 Zotero itemType 原文（如 book / journalArticle / thesis）；独立附件为空串。 */
    docType?: string;
    /**
     * 顶层 Zotero 条目 key（父条目；独立附件就是附件自身）。
     *
     * collection 增量同步按它命中已有本地文献并就地更新；直接打开附件时也写下来，
     * 这样之后把该条目纳入 collection 同步仍能对上。旧记录没有该列时为空串。
     */
    zoteroItemKey?: string;
    /** 本次导入所属的 Zotero collection key（collection 同步用）；不传则保留原值。 */
    zoteroCollectionKey?: string;
    /**
     * 是否保留本地已存在的标题（`zotero.sync_preserve_local_title` 开关）。
     *
     * 仅作用于**已存在**的本地文献：本地标题非空、不是占位标题、且与传入标题
     * 不同时，保留本地标题（其余字段仍按来源优先级合并）；新建条目没有本地标题，
     * 一律使用传入值。
     */
    preserveLocalTitle?: boolean;
    externalPath?: string;
    bytes?: Uint8Array;
    confirmDuplicate?: boolean;
  }): Promise<ZoteroDocumentImportResult> {
    const bytes = input.externalPath
      ? new Uint8Array(readFileSync(input.externalPath))
      : input.bytes;
    if (!bytes) throw new Error('Zotero 附件没有内容');
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      throw new Error('Zotero 返回内容不是 PDF');
    }
    const parsed = await parsePdf(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const external = Boolean(input.externalPath);
    const stamp = input.externalPath
      ? `${statSync(input.externalPath).size}:${Math.trunc(statSync(input.externalPath).mtimeMs)}`
      : `${bytes.byteLength}:${Date.now()}`;
    const legacy = input.legacyIdentity?.trim() ?? '';
    const zoteroKey = input.zoteroItemKey?.trim() ?? '';
    let old = (
      legacy && legacy !== input.identity
        ? this.db
            .prepare(
              'SELECT * FROM documents WHERE external_key = ? OR external_key = ? LIMIT 1'
            )
            .get(input.identity, legacy)
        : this.db
            .prepare('SELECT * FROM documents WHERE external_key = ?')
            .get(input.identity)
    ) as Record<string, unknown> | undefined;
    // 附件被 Zotero 重建/换路径后 identity 会变：再按 Zotero 顶层条目 key 兜底，
    // 保证 collection 增量同步永远就地更新同一行，而不是插入重复文献。
    if (!old && zoteroKey) {
      old = this.db
        .prepare(
          'SELECT * FROM documents WHERE zotero_item_key = ? ORDER BY deleted ASC, rowid ASC LIMIT 1'
        )
        .get(zoteroKey) as Record<string, unknown> | undefined;
    }
    if (old && Number(old.deleted ?? 0) === 1) {
      throw new Error('该附件已在应用回收站，请先恢复或彻底移除其应用记录');
    }
    const generic = new Set(['full text pdf', 'full text', 'pdf', '全文']);
    const incomingTitle = input.title || 'Zotero 文献';
    const title =
      old && !generic.has(String(old.name ?? '').trim().toLowerCase())
        ? String(old.name)
        : incomingTitle;
    const incomingDoi = normalizeDoi(input.doi ?? '') || parsed.doi;
    const doi = old ? String(old.doi ?? '') || incomingDoi : incomingDoi;
    // 父条目 itemType 原文；独立附件/父条目不可读时为空串（= 未分类）。
    const docType = input.docType ? this.documentTypeOf(input.docType) : '';
    if (old && !input.confirmDuplicate) {
      throw new DuplicateImportError(
        [
          {
            id: String(old.id),
            name: title,
            pages: Number(old.pages ?? parsed.pages),
            author: String(old.author ?? input.author),
            publication: String(old.publication ?? input.publication ?? ''),
            doi,
            match: 'zotero',
            reasons: ['Zotero 条目相同']
          }
        ],
        false
      );
    }
    const candidates = this.findImportDuplicates({
      doi: incomingDoi,
      title: incomingTitle,
      author: input.author,
      publication: input.publication ?? '',
      pages: parsed.pages
    });
    if (candidates.length > 0 && !input.confirmDuplicate) {
      throw new DuplicateImportError(candidates, true);
    }
    // 题录合并：Zotero 来源（优先级高于 PDF 元数据/首页/文件名），但绝不覆盖
    // 用户手动改过的值（metadata_source='manual'）；未知来源按最低处理。
    const existingSource = normalizeMetadataSource(old?.metadata_source);
    // 「保留本地标题」开关只作用于已存在且带有真实标题的文献：本地标题为空或是
    // 占位标题（Full Text PDF 等）时视为没有本地标题，一律用传入值。
    const localTitle = String(old?.name ?? '');
    const localTitleUsable =
      Boolean(old) &&
      Boolean(localTitle.trim()) &&
      !generic.has(localTitle.trim().toLowerCase());
    const preserveTitle =
      Boolean(input.preserveLocalTitle) &&
      localTitleUsable &&
      localTitle.trim() !== incomingTitle.trim();
    const mergedTitle = preserveTitle
      ? { value: localTitle, applied: false }
      : localTitleUsable
        ? mergeMetadataField(localTitle, existingSource, incomingTitle, 'zotero')
        : { value: incomingTitle, applied: true };
    const mergedAuthor = mergeMetadataField(
      String(old?.author ?? ''),
      existingSource,
      input.author,
      'zotero'
    );
    const mergedPublication = mergeMetadataField(
      String(old?.publication ?? ''),
      existingSource,
      input.publication ?? '',
      'zotero'
    );
    const mergedDoi = mergeMetadataField(
      String(old?.doi ?? ''),
      existingSource,
      incomingDoi,
      'zotero'
    );
    const zoteroApplied =
      mergedTitle.applied ||
      mergedAuthor.applied ||
      mergedPublication.applied ||
      mergedDoi.applied;
    const metadataSource = highestMetadataSource(existingSource, zoteroApplied ? 'zotero' : null);
    const storedZoteroItemKey = zoteroKey || String(old?.zotero_item_key ?? '');
    const storedCollectionKey =
      input.zoteroCollectionKey?.trim() || String(old?.zotero_collection_key ?? '');
    const id = old ? String(old.id) : randomUUID();
    let storedPath = '';
    if (!external) {
      const relative = path.join('papers', `${sha256}.pdf`);
      const destination = path.join(this.dataDir, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      if (!existsSync(destination)) writeFileSync(destination, bytes);
      storedPath = relative;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (old) {
        this.db
          .prepare(
            `UPDATE documents SET name = ?, pages = ?, current_page = MIN(current_page, ?),
               storage_kind = ?, external_path = ?, external_key = ?, file_stamp = ?,
               author = ?, publication = ?, doi = ?,
               doc_type = CASE WHEN doc_type = '' AND ? <> '' THEN ? ELSE doc_type END,
               title_key = ?,
               sha256 = ?, size_bytes = ?, path = ?,
               metadata_source = ?, zotero_item_key = ?, zotero_collection_key = ?,
               zotero_missing = 0
             WHERE id = ?`
          )
          .run(
            mergedTitle.value,
            parsed.pages,
            parsed.pages,
            external ? 'zotero' : 'zotero_cache',
            input.externalPath ?? '',
            input.identity,
            stamp,
            mergedAuthor.value,
            mergedPublication.value,
            mergedDoi.value,
            docType,
            docType,
            normalizeKey(mergedTitle.value),
            sha256,
            bytes.byteLength,
            storedPath,
            metadataSource ?? '',
            storedZoteroItemKey,
            storedCollectionKey,
            id
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO documents
               (id, name, pages, current_page, created, deleted, storage_kind, external_path,
                external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
                size_bytes, path, doc_type, metadata_source, zotero_item_key,
                zotero_collection_key, zotero_missing, manual_order)
             VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
          )
          .run(
            id,
            mergedTitle.value,
            parsed.pages,
            new Date().toISOString(),
            external ? 'zotero' : 'zotero_cache',
            input.externalPath ?? '',
            input.identity,
            stamp,
            mergedAuthor.value,
            mergedPublication.value,
            mergedDoi.value,
            normalizeKey(mergedTitle.value),
            sha256,
            bytes.byteLength,
            storedPath,
            docType,
            'zotero',
            storedZoteroItemKey,
            storedCollectionKey,
            this.nextManualOrder()
          );
      }
      this.writeChunks(id, parsed.chunks);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.invalidateReferenceGraphCache();
    const document = this.getDocument(id);
    if (!document) throw new Error('导入 Zotero 文献后无法读取');
    return preserveTitle ? { ...document, localTitlePreserved: true } : document;
  }

  async snapshotZoteroDocument(documentId: string): Promise<DocumentDetail> {
    const row = this.db
      .prepare(
        `SELECT storage_kind, external_path, author, publication, metadata_source
         FROM documents WHERE id = ? AND deleted = 0`
      )
      .get(documentId) as
      | {
          storage_kind?: string;
          external_path?: string;
          author?: string;
          publication?: string;
          metadata_source?: string;
        }
      | undefined;
    if (!row) throw new Error('文献不存在');
    if (row.storage_kind !== 'zotero') {
      throw new Error('只有 Zotero 只读链接需要保存为本机副本');
    }
    const external = String(row.external_path ?? '');
    if (!external || !existsSync(external)) {
      throw new Error('Zotero 附件当前不可用（文件不存在）');
    }
    const bytes = new Uint8Array(readFileSync(external));
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      throw new Error('Zotero 附件不是有效的 PDF');
    }
    const parsed = await parsePdf(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relative = path.join('papers', `${sha256}.pdf`);
    const destination = path.join(this.dataDir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (!existsSync(destination)) writeFileSync(destination, bytes);
    // 保存副本只补空缺：题录已由 Zotero（更高优先级）写入时，不用 PDF 元数据覆盖。
    const existingSource = normalizeMetadataSource(row.metadata_source);
    const mergedAuthor = mergeMetadataField(
      String(row.author ?? ''),
      existingSource,
      parsed.author,
      'pdf_xmp'
    );
    const mergedPublication = mergeMetadataField(
      String(row.publication ?? ''),
      existingSource,
      parsed.publication,
      'pdf_xmp'
    );
    const metadataSource = highestMetadataSource(
      existingSource,
      mergedAuthor.applied || mergedPublication.applied ? 'pdf_xmp' : null
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE documents SET pages = ?, current_page = MIN(current_page, ?),
             storage_kind = 'copy', external_path = '', external_key = '',
             file_stamp = '', sha256 = ?, size_bytes = ?, path = ?,
             author = ?, publication = ?, metadata_source = ?
           WHERE id = ?`
        )
        .run(
          parsed.pages,
          parsed.pages,
          sha256,
          bytes.byteLength,
          relative,
          mergedAuthor.value,
          mergedPublication.value,
          metadataSource ?? '',
          documentId
        );
      this.writeChunks(documentId, parsed.chunks);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.invalidateReferenceGraphCache();
    const document = this.getDocument(documentId);
    if (!document) throw new Error('保存本机副本后无法读取文献');
    return document;
  }

  private writeChunks(documentId: string, chunks: ParsedChunk[]): void {
    const oldChunks = this.db
      .prepare('SELECT rowid AS rowid FROM chunks WHERE document_id = ?')
      .all(documentId) as unknown as Array<{ rowid: number }>;
    const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    for (const chunk of oldChunks) deleteFts.run(chunk.rowid);
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

    const insertChunk = this.db.prepare(
      `INSERT INTO chunks(id, document_id, page, text, bbox, bbox_space)
       VALUES (?, ?, ?, ?, ?, 'visual')`
    );
    const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)');
    for (const chunk of chunks) {
      const chunkId = `${documentId}:${chunk.page}:${randomUUID()}`;
      const result = insertChunk.run(chunkId, documentId, chunk.page, chunk.text, chunk.bbox);
      insertFts.run(Number(result.lastInsertRowid), chunk.text);
    }
  }

  async relinkDocument(id: string, sourcePath: string): Promise<RelinkResult> {
    const existing = this.getDocument(id);
    if (!existing) throw new Error('文档不存在');
    const pagesBefore = existing.pages;
    const resolved = path.resolve(sourcePath);
    if (!existsSync(resolved)) throw new Error('文件不存在');
    const stats = statSync(resolved);
    if (!stats.isFile()) throw new Error('不是文件');
    const bytes = readFileSync(resolved);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('只支持 PDF 文件');
    }

    const parsed = await parsePdf(new Uint8Array(bytes));
    const oldPath = this.getDocumentPath(id);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relativePath = path.join('papers', `${sha256}.pdf`);
    const destination = path.join(this.dataDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (!existsSync(destination)) copyFileSync(resolved, destination);
    // 题录按来源优先级合并：relink 来自 PDF 元数据，不能覆盖 Zotero / 用户手改的值。
    const existingSource = existing.metadataSource ?? null;
    const mergedAuthor = mergeMetadataField(
      existing.author,
      existingSource,
      parsed.author,
      'pdf_xmp'
    );
    const mergedPublication = mergeMetadataField(
      existing.publication,
      existingSource,
      parsed.publication,
      'pdf_xmp'
    );
    const metadataSource = highestMetadataSource(
      existingSource,
      mergedAuthor.applied || mergedPublication.applied ? 'pdf_xmp' : null
    );

    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db
        .prepare(
          `UPDATE documents SET pages = ?, current_page = MIN(current_page, ?), sha256 = ?,
             size_bytes = ?, path = ?, storage_kind = 'copy', external_path = '', external_key = '',
             file_stamp = '', author = ?, publication = ?, metadata_source = ?
           WHERE id = ? AND deleted = 0`
        )
        .run(
          parsed.pages,
          parsed.pages,
          sha256,
          stats.size,
          relativePath,
          mergedAuthor.value,
          mergedPublication.value,
          metadataSource ?? '',
          id
        );
      this.writeChunks(id, parsed.chunks);
      // relink 换到新 sha 路径后，旧路径的页版面缓存已经没有对应文献：按旧 path 清掉，
      // 否则反复重连会让 structure_pages 持续变大（新 path 的缓存保留）。
      if (oldPath && oldPath !== destination) {
        this.db.prepare('DELETE FROM structure_pages WHERE path = ?').run(oldPath);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (destination !== oldPath && existsSync(destination)) unlinkSync(destination);
      throw error;
    }

    if (oldPath && oldPath !== destination && existsSync(oldPath)) {
      try {
        unlinkSync(oldPath);
      } catch {
        // 旧副本删除失败不影响新副本
      }
    }
    if (oldPath) this.layoutCache.delete(oldPath);
    // 已设置的“无关区域”规则同样要作用于新文件：否则被屏蔽的页眉/页脚会重新进入正文；
    // 检索索引同样套用 page_masks.all_regions。
    if (this.listPageMasks(id).length > 0) {
      const pages = Array.from({ length: parsed.pages }, (_, index) => index + 1);
      await this.rebuildMaskedChunks(id, pages);
    }
    const outOfRange = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM annotations WHERE document_id = ? AND deleted = 0 AND page > ?'
      )
      .get(id, parsed.pages) as unknown as { count: number };
    const notes: string[] = [];
    if (pagesBefore !== parsed.pages) {
      notes.push(
        `文献页数由 ${pagesBefore} 页变为 ${parsed.pages} 页：原有批注与笔记的页码可能已错位，请逐条核对后再使用。`
      );
    }
    if (Number(outOfRange.count ?? 0) > 0) {
      notes.push(
        `其中 ${Number(outOfRange.count)} 条批注的页码超出了新文件的页数，已无法定位到原文。`
      );
    }
    const document = this.getDocument(id);
    if (!document) throw new Error('重新连接后无法读取文档');
    this.invalidateReferenceGraphCache();
    return {
      ...document,
      page_count_before: pagesBefore,
      page_count_after: parsed.pages,
      annotations_out_of_range: Number(outOfRange.count ?? 0),
      warning: notes.join(' ') || null
    };
  }

  // -------------------------------------------------------------------------
  // 文献写路径（字段更新/默认排序拖拽/标签/回收站）：实现已抽到 ./store/documents.ts。
  // 彻底删除 purgeDocument（跨批注/笔记/会话/分块级联）仍在下方，不属于本域。
  // -------------------------------------------------------------------------

  /** 更新文献字段（阅读进度/标题/作者/类型/文件夹）；字段级合并语义见 store/documents.ts。 */
  updateDocument(
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
    return documentDomain.updateDocument(this.db, this.documentDomainDeps, id, input);
  }

  /** 默认排序拖拽：移动到 beforeId 与 afterId 之间；语义见 store/documents.ts。 */
  moveDocument(
    id: string,
    input: { beforeId?: string | null; afterId?: string | null }
  ): DocumentDetail {
    return documentDomain.moveDocument(this.db, this.documentDomainDeps, id, input);
  }

  setDocumentTags(id: string, tags: string[]): string[] {
    return documentDomain.setDocumentTags(this.db, this.documentDomainDeps, id, tags);
  }

  /** 软删除（移入应用回收站）；语义见 store/documents.ts。 */
  deleteDocument(id: string): void {
    documentDomain.deleteDocument(this.db, this.documentDomainDeps, id);
  }

  /** 从应用回收站恢复；语义见 store/documents.ts。 */
  restoreDocument(id: string): void {
    documentDomain.restoreDocument(this.db, this.documentDomainDeps, id);
  }

  purgeDocument(id: string, confirmName: string): void {
    const row = this.db
      .prepare('SELECT * FROM documents WHERE id = ? AND deleted = 1')
      .get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error('请先将文献移入应用回收站');
    if (String(row.name ?? '') !== confirmName) throw new Error('文献名称确认不匹配');

    const documentPath = row.path
      ? path.resolve(this.dataDir, String(row.path))
      : path.join(this.dataDir, `${id}.pdf`);
    if (documentPath.startsWith(path.resolve(this.dataDir)) && existsSync(documentPath)) {
      try {
        unlinkSync(documentPath);
      } catch {
        throw new Error('副本正在使用，请稍后重试');
      }
    }

    const tablesWithDocumentId = [
      'annotations',
      'notes',
      'messages',
      // 会话表存标题与早期摘要、目录页设置与参考文献编辑都含用户内容：
      // 彻底删除文献时必须一并清掉，否则"已删除"的文献仍能读出摘要与编辑记录。
      'document_chat_sessions',
      'doc_navigation_toc',
      'reference_edits',
      'translation_segments',
      'translation_pages',
      'page_edits',
      'doc_navigation',
      'doc_navigation_state',
      'page_masks',
      'visual_cache',
      // 22：项目只存文献链接；彻底删除文献时链接一并清掉（外键级联是兜底，这里显式删）。
      'project_documents'
    ];
    // 彻底删除文献前先记下该文献下笔记/批注的资源引用，删除后回收变成孤儿的资源。
    const noteIds = (
      this.db.prepare('SELECT id FROM notes WHERE document_id = ?').all(id) as unknown as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    const annotationIds = (
      this.db
        .prepare('SELECT id FROM annotations WHERE document_id = ?')
        .all(id) as unknown as Array<{ id: string }>
    ).map((row) => row.id);
    const affectedAssets = new Set<string>();
    const collectRefs = (kind: 'note' | 'annotation', sourceIds: string[]): void => {
      const select = this.db.prepare(
        'SELECT asset_id FROM note_asset_refs WHERE source_kind = ? AND source_id = ?'
      );
      const remove = this.db.prepare(
        'DELETE FROM note_asset_refs WHERE source_kind = ? AND source_id = ?'
      );
      for (const sourceId of sourceIds) {
        const refs = select.all(kind, sourceId) as unknown as Array<{ asset_id: string }>;
        for (const ref of refs) affectedAssets.add(ref.asset_id);
        remove.run(kind, sourceId);
      }
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      collectRefs('note', noteIds);
      collectRefs('annotation', annotationIds);
      const chunkRows = this.db
        .prepare('SELECT rowid AS rowid FROM chunks WHERE document_id = ?')
        .all(id) as unknown as Array<{ rowid: number }>;
      // 语义向量按 chunk_id 存；先按该文献的 chunk 删除，避免向量表残留可还原的语义信息。
      this.db
        .prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)')
        .run(id);
      const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
      for (const chunk of chunkRows) deleteFts.run(chunk.rowid);
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
      for (const table of tablesWithDocumentId) {
        this.db.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(id);
      }
      // 阅读任务和断点用 documents JSON 关联文献；彻底删除时一并清理。
      const taskRows = this.db
        .prepare('SELECT task, documents FROM reading_tasks')
        .all() as unknown as Array<{ task: string; documents: string | null }>;
      for (const task of taskRows) {
        let related = false;
        try {
          const documents = task.documents ? (JSON.parse(task.documents) as unknown) : [];
          related = Array.isArray(documents) && documents.includes(id);
        } catch {
          related = false;
        }
        if (!related) continue;
        this.db.prepare('DELETE FROM checkpoints WHERE task = ?').run(task.task);
        this.db.prepare('DELETE FROM reading_tasks WHERE task = ?').run(task.task);
      }
      this.db.prepare('DELETE FROM structures WHERE document = ?').run(id);
      // 页版面缓存按文件路径存；文献彻底删除时一并清理，避免长期占用。
      this.db.prepare('DELETE FROM structure_pages WHERE path = ?').run(documentPath);
      // 审计复用缓存可能含已删除文献的原文摘引；彻底删除时一并清空。
      this.db.prepare('DELETE FROM audit_cache').run();
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    noteAssets.refreshCounts(this.db, affectedAssets);
    noteAssets.purgeRecords(this.db, this.noteAssetDeps, affectedAssets);
    this.invalidateReferenceGraphCache();
    // 派生缓存不在事务里：按作用域清掉内存索引与磁盘 token 缓存，再截断 WAL，减少残留。
    try {
      purgeDocumentRetrievalCaches(this, id);
    } catch {
      // 缓存可重建；清理失败不应让删除看起来没成功（revision 变化后旧缓存也不会再命中）。
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // WAL 仍有读/写者时 checkpoint 可能失败，下次启动还会再做。
    }
  }

  /**
   * 清空全部本地用户数据（合规整改 P1-6；供 `POST /maintenance/clear-user-data` 使用）。
   *
   * 删除范围：文献及全部派生数据（批注/笔记/会话与消息/译文与页记录/页编辑/页遮罩/
   * 目录导航/块与 FTS/结构/参考文献用户编辑/阅读任务与断点/视觉读页缓存/嵌入与审计缓存/
   * 检索版本）、文件夹、笔记附件记录与文件、PDF 副本、上传临时文件、
   * Markdown 扫描/导入结果与任务快照、备份（backups/、migration-backups/ 与恢复标记）、
   * 诊断包、检索缓存目录、用户自定义阅读流程目录 flows/。
   * **保留** settings（模型/服务/界面配置）与 secrets（密钥）：清空后不需要重新配置模型。
   *
   * Windows 注意：**不删除正在使用的数据库文件**（只按表删行，事务提交即生效），
   * 随后 best-effort 截断 WAL、VACUUM 回收空闲页；PDF/附件/备份/缓存/运行日志文件逐个
   * best-effort 删除；个别文件被其它进程占用（EPERM/EBUSY）时跳过，而不是让整次清空失败。
   * 删除后不可恢复。
   */
  clearUserData(): ClearUserDataResult {
    const countOf = (table: string): number => {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
          | { n?: number }
          | undefined;
        return Number(row?.n ?? 0);
      } catch {
        // 旧库缺表时按 0 计：清空不应当因为某个可选表不存在而失败。
        return 0;
      }
    };
    const removed = {
      documents: countOf('documents'),
      notes: countOf('notes'),
      annotations: countOf('annotations'),
      messages: countOf('messages'),
      // 23：跨文献会话也算「会话」；消息已包含在上面的 messages 总数里。
      sessions: countOf('document_chat_sessions') + countOf('corpus_sessions'),
      translations: countOf('translation_segments'),
      note_assets: countOf('note_assets')
    };
    const dataRoot = path.resolve(this.dataDir);
    const insideDataDir = (target: string): boolean =>
      target === dataRoot || target.startsWith(`${dataRoot}${path.sep}`);
    // 文献 PDF 副本：先记下路径，事务提交后再删文件（外部/Zotero 只读链接的原文件绝不能删）。
    const documentFiles = new Set<string>();
    try {
      const rows = this.db.prepare('SELECT id, path FROM documents').all() as unknown as Array<{
        id: string;
        path?: string | null;
      }>;
      for (const row of rows) {
        const stored = String(row.path ?? '').trim();
        const target = stored
          ? path.resolve(this.dataDir, stored)
          : path.join(this.dataDir, `${row.id}.pdf`);
        if (insideDataDir(target)) documentFiles.add(target);
      }
    } catch {
      // 读不到路径就只清数据库记录；papers/ 目录内容仍会整体清理。
    }

    const contentTables = [
      'documents',
      'annotations',
      'notes',
      'note_assets',
      'note_folders',
      'folders',
      // 22：逻辑项目与项目文献链接（先删链接表再删项目表）。
      'project_documents',
      'projects',
      // 23：跨文献会话范围快照与会话行；消息在 messages 里一并清掉。
      'corpus_session_documents',
      'corpus_sessions',
      'messages',
      'document_chat_sessions',
      'translation_pages',
      'translation_segments',
      'page_edits',
      'doc_navigation',
      'doc_navigation_state',
      'doc_navigation_toc',
      'page_masks',
      'reading_tasks',
      'checkpoints',
      'structure_pages',
      'structures',
      'reference_edits',
      'visual_cache',
      'vectors',
      'embedding_cache',
      'audit_cache',
      'retrieval_document_revision',
      // 27：历史遗留表，旧版本可能残留平台 API Key 密文；「清空全部本地数据」也要清掉。
      'platform_connections'
    ];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM note_asset_refs');
      // FTS 行与 chunks 同源：先清 FTS 再清 chunks。
      this.db.exec('DELETE FROM chunks_fts');
      for (const table of contentTables) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec('DELETE FROM chunks');
      // settings 里属于用户内容的条目：旧版阅读会话清单、Markdown 扫描/导入任务快照。
      // 模型/服务/界面配置项一律保留。
      this.db.exec(
        "DELETE FROM settings WHERE key LIKE 'doc-chat.sessions.%'" +
          " OR key = 'markdown.import_job' OR key = 'markdown.scan_job'"
      );
      // 检索版本单调递增：让进程内倒排索引/页缓存立即失效。
      this.db.exec('UPDATE retrieval_revision SET value = value + 1 WHERE id = 1');
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 事务可能已被 SQLite 自动回滚。
      }
      throw error;
    }

    // 进程内缓存同样要失效：否则清空后还可能返回已删文献的解析文本/关系图。
    this.layoutCache.clear();
    this.blocksCache.clear();
    this.sectionIndexCache.clear();
    this.maskJobs.clear();
    this.maskPending.clear();
    this.invalidateReferenceGraphCache();

    // 物理删除尽量彻底（best-effort，失败不影响清空结果）：截断 WAL 并 VACUUM 回收空闲页，
    // 避免已删除的行继续留在 WAL/数据库空闲页里。
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // WAL 仍有读者/写者时 checkpoint 可能失败；下次启动还会再做 checkpoint。
    }
    try {
      this.db.exec('VACUUM');
    } catch {
      // VACUUM 失败（空间不足/被占用）时保留逻辑删除结果。
    }

    // 文件删除一律 best-effort：Windows 上被打开的文件删不掉，但清空数据不能因此整单失败。
    // 删不掉的路径记进 failed，界面据此提示"逻辑数据已清空，但部分文件仍被占用"。
    const failed: string[] = [];
    const relPath = (target: string): string =>
      path.relative(this.dataDir, target) || path.basename(target);
    let backupsRemoved = 0;
    for (const file of documentFiles) {
      try {
        unlinkSync(file);
      } catch {
        failed.push(relPath(file));
      }
    }
    const removeFolderContents = (folder: string, label: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(folder, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const target = path.join(folder, entry.name);
        try {
          if (entry.isDirectory()) rmSync(target, { recursive: true, force: true });
          else unlinkSync(target);
        } catch {
          failed.push(`${label}/${entry.name}`);
        }
      }
    };
    // PDF 副本目录整体清理（连旧版本遗留/无记录的孤儿副本一起清）。
    removeFolderContents(this.papersDir, 'papers');
    // 上传解析的临时目录（失败/中断时可能残留 PDF）。
    removeFolderContents(path.join(this.dataDir, 'imports'), 'imports');
    // Markdown 扫描/导入结果文件（含扫描到/导入过的笔记路径与报告）。
    try {
      for (const name of readdirSync(this.dataDir)) {
        if (/^markdown-(import|scan)-result\.json(\.gz)?(\.sha256)?$/.test(name)) {
          try {
            unlinkSync(path.join(this.dataDir, name));
          } catch {
            failed.push(name);
          }
        }
      }
    } catch {
      // 目录读取失败不影响已完成的数据库清空。
    }
    removeFolderContents(path.join(this.dataDir, NOTE_ASSET_DIR), NOTE_ASSET_DIR);
    removeFolderContents(path.join(this.dataDir, 'migration-backups'), 'migration-backups');
    removeFolderContents(path.join(this.dataDir, 'diagnostics'), 'diagnostics');
    // 用户自定义阅读流程（flows/<id>/flow.json + flow.md，见 flows.ts）：整目录删除。
    // Windows 上有文件被占用时整目录删不掉，退回逐个删除并把残留路径（含具体文件）记进 failed。
    const flowsRoot = path.join(this.dataDir, 'flows');
    try {
      rmSync(flowsRoot, { recursive: true, force: true });
    } catch {
      const removeFlowEntries = (folder: string, label: string): boolean => {
        let entries: Dirent[];
        try {
          entries = readdirSync(folder, { withFileTypes: true });
        } catch {
          failed.push(`${label}/`);
          return false;
        }
        let ok = true;
        for (const entry of entries) {
          const target = path.join(folder, entry.name);
          const rel = `${label}/${entry.name}`;
          if (entry.isDirectory()) {
            if (!removeFlowEntries(target, rel)) ok = false;
          } else {
            try {
              unlinkSync(target);
            } catch {
              failed.push(rel);
              ok = false;
            }
          }
        }
        if (!ok) return false;
        try {
          rmSync(folder, { recursive: false, force: true });
        } catch {
          failed.push(`${label}/`);
          return false;
        }
        return true;
      };
      removeFlowEntries(flowsRoot, 'flows');
    }
    // 运行日志（可能含脱敏错误上下文）也属于本机数据：best-effort 删除，写日志的句柄会重建文件。
    for (const name of ['application.log', 'application.log.1']) {
      const target = path.join(this.dataDir, name);
      if (!existsSync(target)) continue;
      try {
        unlinkSync(target);
      } catch {
        failed.push(name);
      }
    }
    // 检索缓存目录（dataDir/cache/retrieval-index）。
    try {
      rmSync(path.join(this.dataDir, 'cache'), { recursive: true, force: true });
    } catch {
      failed.push('cache/');
    }
    // 备份目录：按文件计数（备份 zip），staging 等子目录一并清理。
    const backupsDir = path.join(this.dataDir, 'backups');
    try {
      for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
        const target = path.join(backupsDir, entry.name);
        try {
          if (entry.isDirectory()) rmSync(target, { recursive: true, force: true });
          else {
            unlinkSync(target);
            backupsRemoved += 1;
          }
        } catch {
          failed.push(`backups/${entry.name}`);
        }
      }
    } catch {
      // 没有备份目录。
    }
    // 恢复待办标记与恢复前快照：备份都删了，不能再让下次启动去恢复一个已删的备份。
    try {
      unlinkSync(path.join(this.dataDir, 'restore-pending.json'));
    } catch {
      // 没有待恢复标记。
    }
    try {
      for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.pre-restore-')) {
          try {
            rmSync(path.join(this.dataDir, entry.name), { recursive: true, force: true });
          } catch {
            failed.push(entry.name);
          }
        }
      }
    } catch {
      // 目录读取失败不影响已完成的数据库清空。
    }
    return { ok: true, removed: { ...removed, backups: backupsRemoved }, failed };
  }

  /** 按文献列批注（默认不含回收站）；实现与排序见 store/annotations.ts。 */
  listAnnotations(documentId: string, trash = false): AnnotationRecord[] {
    return annotationDomain.listAnnotations(this.db, documentId, trash);
  }

  // -------------------------------------------------------------------------
  // 笔记：实现已全部抽到 ./store/notes.ts（list / write / trash / folder /
  // manualOrder），Store 上只剩薄委托，签名/返回结构不变。
  // 拆分模式：纯函数 + 显式依赖注入（db + deps）；事务边界、内容与 refs 同成同败、
  // 引用图缓存提交后失效等不变量都在域模块文件头逐条写明。
  // -------------------------------------------------------------------------

  listNotes(documentId: string, trash = false): NoteRecord[] {
    return noteDomain.listNotes(this.db, documentId, trash);
  }

  /** 独立笔记（document_id=''，不依附任何文献）；trash=true 返回回收站里的。 */
  listStandaloneNotes(trash = false): NoteRecord[] {
    return noteDomain.listStandaloneNotes(this.db, trash);
  }

  /** 全库笔记（含文献笔记与独立笔记；不含回收站及已删除文献下的笔记）。资料库索引用。 */
  listAllNotes(): NoteRecord[] {
    return noteDomain.listAllNotes(this.db);
  }

  /** 单条笔记（含独立笔记）；不存在或已删除返回 null。 */
  getNote(id: string): NoteRecord | null {
    return noteDomain.getNote(this.db, id);
  }

  /** 创建笔记（含独立笔记）；实现与事务/缓存顺序见 store/notes.ts 的 createNote。 */
  createNote(input: CreateNoteInput & { tags?: string[] }): NoteRecord {
    return noteDomain.createNote(this.db, this.noteDomainDeps, input);
  }

  /** 彻底删除笔记（含回收站里的）+ 回收其独占图片资源；不存在的笔记返回 404 语义。 */
  purgeNote(id: string): NotePurgeResult {
    return noteDomain.purgeNote(this.db, this.noteDomainDeps, id);
  }

  /** 更新笔记；实现与事务/缓存顺序见 store/notes.ts 的 updateNote。 */
  updateNote(id: string, input: UpdateNoteInput): NoteRecord {
    return noteDomain.updateNote(this.db, this.noteDomainDeps, id, input);
  }

  /** 软删除（移入回收站）；引用图缓存由域实现经注入的 deps 失效。 */
  deleteNote(id: string): void {
    noteDomain.deleteNote(this.db, this.noteDomainDeps, id);
  }

  /** 从回收站恢复；引用图缓存由域实现经注入的 deps 失效。 */
  restoreNote(id: string): void {
    noteDomain.restoreNote(this.db, this.noteDomainDeps, id);
  }

  // -------------------------------------------------------------------------
  // 笔记标签
  // -------------------------------------------------------------------------

  /** 全库笔记标签（未删除笔记；已删除文献下的文献笔记不计入）。实现见 store/notes.ts。 */
  listNoteTags(): string[] {
    return noteDomain.listNoteTags(this.db);
  }

  /** 设置某条笔记的标签（规范化/去重后返回）。实现见 store/notes.ts。 */
  setNoteTags(id: string, tags: string[]): { ok: boolean; tags: string[] } {
    return noteDomain.setNoteTags(this.db, id, tags);
  }

  // -------------------------------------------------------------------------
  // 笔记虚拟文件夹（note_folders + notes.folder_path）：实现已抽到 ./store/notes.ts。
  // 层级/路径/移动/删除时的归属处理与事务边界都在域模块里；Store 只留薄委托。
  // -------------------------------------------------------------------------

  /** 从 notes.folder_path 回填 note_folders（含祖先目录）；幂等，迁移时调用。 */
  private backfillNoteFolders(): void {
    noteDomain.backfillNoteFolders(this.db, this.noteDomainDeps);
  }

  /** 列出笔记虚拟文件夹（不含根 ''；空文件夹也返回；noteCount 只统计未删除笔记）。 */
  listNoteFolders(): NoteFolderRecord[] {
    return noteDomain.listNoteFolders(this.db);
  }

  /** 薄委托：确保文件夹路径及其所有祖先都已登记（INSERT OR IGNORE，不开事务）。 */
  ensureNoteFolderHierarchy(folderPath: string): void {
    noteDomain.ensureNoteFolderHierarchy(this.db, this.noteDomainDeps, folderPath);
  }

  /** 创建笔记文件夹（自动创建祖先）；已存在时幂等返回现有记录。 */
  createNoteFolder(folderPath: string): NoteFolderRecord {
    return noteDomain.createNoteFolder(this.db, this.noteDomainDeps, folderPath);
  }

  /** 重命名/合并文件夹子树：同步更新 note_folders 与 notes.folder_path。 */
  renameNoteFolder(from: string, to: string): NoteFolderOperationResult {
    return noteDomain.renameNoteFolder(this.db, this.noteDomainDeps, from, to);
  }

  /** 删除笔记文件夹（含隐式文件夹）：删除整棵子树，但笔记不丢。 */
  deleteNoteFolder(folderPath: string): NoteFolderOperationResult {
    return noteDomain.deleteNoteFolder(this.db, this.noteDomainDeps, folderPath);
  }

  /** 把笔记移动到指定文件夹（'' = 根目录；目标文件夹必须存在）。 */
  moveNoteToFolder(
    id: string,
    folderPath: string
  ): { ok: boolean; folders: NoteFolderRecord[]; notes: Array<{ id: string; folderPath: string }> } {
    return noteDomain.moveNoteToFolder(this.db, id, folderPath);
  }

  // -------------------------------------------------------------------------
  // 独立笔记批量操作与手动排序（notes.manual_order）：实现已抽到 ./store/notes.ts。
  // -------------------------------------------------------------------------

  /** 重排某文件夹内独立笔记（ids 为目标顺序，按数组下标写 manual_order）。 */
  reorderStandaloneNotes(
    folderPath: string,
    ids: string[]
  ): { ok: boolean; folders: NoteFolderRecord[]; notes: Array<{ id: string; folderPath: string }> } {
    return noteDomain.reorderStandaloneNotes(this.db, folderPath, ids);
  }

  /** 批量软删除独立笔记（回收站）；幂等，返回实际删除条数。 */
  batchDeleteStandaloneNotes(ids: string[]): { ok: boolean; deleted: number } {
    return noteDomain.batchDeleteStandaloneNotes(this.db, this.noteDomainDeps, ids);
  }

  /** 批量移动独立笔记到指定文件夹（'' = 根目录）；返回实际移动条数。 */
  batchMoveStandaloneNotes(
    ids: string[],
    folderPath: string
  ): {
    ok: boolean;
    moved: number;
    folders: NoteFolderRecord[];
    notes: Array<{ id: string; folderPath: string }>;
  } {
    return noteDomain.batchMoveStandaloneNotes(this.db, ids, folderPath);
  }

  async exportAnnotatedPdf(documentId: string): Promise<AnnotatedPdfResult> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const documentPath = this.getDocumentPath(documentId);
    if (!documentPath) throw new Error('PDF 副本不存在');
    let bytes: Buffer;
    try {
      bytes = readFileSync(documentPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 文件级失败：给 server 的 409 中文正则一条可命中的说明，同时明确原文件未被改动。
      throw new Error(`导出批注 PDF 失败：原文件未改动（读取 PDF 副本失败：${reason.slice(0, 200)}）`);
    }
    return buildAnnotatedPdf(bytes, this.listAnnotations(documentId));
  }

  exportMarkdown(documentId: string): { markdown: string; filename: string } {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const notes = this.listNotes(documentId);
    const annotations = this.listAnnotations(documentId);
    const parts: string[] = [`# ${document.name} · 阅读笔记`, ''];
    if (notes.length > 0) {
      parts.push('# 笔记', '');
      for (const note of notes) {
        parts.push(
          note.page === 0 ? '## 整篇文献' : `## 第 ${note.page} 页`,
          '',
          note.quote ? `> ${note.quote.replace(/\n/g, '\n> ')}` : '',
          '',
          note.content,
          ''
        );
      }
    }
    if (annotations.length > 0) {
      parts.push('# 文献批注', '');
      for (const annotation of annotations) {
        parts.push(`## 第 ${annotation.page} 页`, '');
        if (annotation.quote) parts.push(`> ${annotation.quote.replace(/\n/g, '\n> ')}`, '');
        if (annotation.content) parts.push(annotation.content, '');
      }
    }
    // 判定「字段优先、文本兜底」：
    // - origin 字段覆盖系统写入路径（「回答存为笔记」等），即使用户删掉正文里的标识文字
    //   仍然会被判为 AI 内容——这正是文本判断的盲区；
    // - 文本兜底保留给迁移前的老数据（那时还没有 origin 列，AI 笔记只靠文件头标识区分）。
    const joinedText = [
      ...notes.map((note) => note.content ?? ''),
      ...annotations.map((annotation) => annotation.content ?? '')
    ].join('\n');
    const containsAi =
      notes.some((note) => note.origin === 'ai') ||
      annotations.some((annotation) => annotation.origin === 'ai') ||
      looksLikeAiContent(joinedText);
    const body = parts.filter((part) => part != null).join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
    return {
      markdown: buildMarkedMarkdownExport(body, containsAi),
      filename: `${document.name.replace(/\.pdf$/i, '')}-批注.md`
    };
  }

  /**
   * 保存笔记/批注里粘贴的本地图片：只接受 png/jpeg/gif/webp 的 base64 data URL，
   * 单图大小/像素上限来自 settings（默认 2MB / 8,000,000 像素，每次调用实时读取）；
   * 按内容 sha256 去重，落到 `<dataDir>/note-assets/<sha>.<ext>`。
   *
   * 返回的 `url` 是 `studianda-asset://note-assets/<file>`，由桌面端协议从当前数据目录读取，
   * 因此写进 Markdown 的图片地址与数据目录无关、可随数据目录一起迁移。
   */
  async saveNoteAsset(input: { dataUrl: string; filename?: string }): Promise<NoteAssetRecord> {
    const limits = this.getNoteImageLimits();
    const raw = typeof input?.dataUrl === 'string' ? input.dataUrl.trim() : '';
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(raw);
    if (!match) {
      throw new Error('只支持 png/jpeg/gif/webp 的 base64 图片 data URL');
    }
    const mime = match[1]!.toLowerCase();
    const payload = match[2]!.replace(/\s+/g, '');
    if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
      throw new Error('图片数据不是有效的 base64');
    }
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length === 0) throw new Error('图片内容为空');
    if (bytes.length > limits.maxBytes) {
      throw new Error(`图片不能超过 ${Math.round(limits.maxBytes / (1024 * 1024))}MB`);
    }
    // 按 magic bytes 校验真实格式，防止把任意文件伪装成图片写进资源目录。
    const detected = detectImageMime(bytes);
    if (!detected) {
      throw new Error('图片内容不是有效的 png/jpeg/gif/webp 图片');
    }
    if (detected !== mime) {
      throw new Error('图片内容与声明类型不符');
    }
    const tooLargeMessage = `图片尺寸过大或无法识别（单边最多 ${MAX_IMAGE_SIDE} 像素，总像素最多 ${limits.maxPixels}）`;
    // 解压炸弹防护：先从文件头解析尺寸，超限时不进入完整解码。
    const headerDimensions = readImageDimensions(bytes);
    if (
      headerDimensions &&
      imageDimensionsTooLarge(headerDimensions.width, headerDimensions.height, limits.maxPixels)
    ) {
      throw new Error(tooLargeMessage);
    }
    // 完整解码：magic 只能识别文件头，截断/损坏的数据要在这里拒绝，避免坏图进资源目录。
    let width = 0;
    let height = 0;
    try {
      const image = await loadImage(bytes);
      width = Number(image.width);
      height = Number(image.height);
    } catch {
      throw new Error('图片无法解码或尺寸无效');
    }
    if (imageDimensionsTooLarge(width, height, limits.maxPixels)) {
      throw new Error(tooLargeMessage);
    }
    const ext = NOTE_ASSET_EXT[mime]!;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dir = path.join(this.dataDir, NOTE_ASSET_DIR);
    mkdirSync(dir, { recursive: true });
    // 同内容只存一份：已有任意扩展名的同名资源就直接复用，不重写文件。
    const existingExt = Object.values(NOTE_ASSET_EXT).find((candidate) =>
      existsSync(path.join(dir, `${sha256}.${candidate}`))
    );
    const storedExt = existingExt ?? ext;
    const target = path.join(dir, `${sha256}.${storedExt}`);
    if (!existingExt) writeFileSync(target, bytes);
    const storedMime = existingExt
      ? (Object.entries(NOTE_ASSET_EXT).find(([, value]) => value === storedExt)?.[0] ?? mime)
      : mime;
    // 登记资源行（ref_count 由引用同步维护；这里只 upsert 元数据，不去动已有计数）。
    const filename = `${sha256}.${storedExt}`;
    const existingAsset = this.db
      .prepare('SELECT asset_id FROM note_assets WHERE filename = ?')
      .get(filename) as { asset_id?: string } | undefined;
    if (existingAsset?.asset_id) {
      this.db
        .prepare('UPDATE note_assets SET mime = ?, size_bytes = ? WHERE asset_id = ?')
        .run(storedMime, bytes.length, existingAsset.asset_id);
    } else {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO note_assets(asset_id, filename, mime, size_bytes)
           VALUES (?, ?, ?, ?)`
        )
        .run(sha256, filename, storedMime, bytes.length);
      const inserted = this.db
        .prepare('SELECT asset_id FROM note_assets WHERE filename = ?')
        .get(filename) as { asset_id?: string } | undefined;
      if (!inserted?.asset_id) {
        // asset_id 撞车（极罕见）：换随机 id 再登记，filename 唯一仍可定位。
        this.db
          .prepare(
            `INSERT OR IGNORE INTO note_assets(asset_id, filename, mime, size_bytes)
             VALUES (?, ?, ?, ?)`
          )
          .run(randomUUID(), filename, storedMime, bytes.length);
      }
    }
    return {
      id: sha256,
      url: `studianda-asset://${NOTE_ASSET_DIR}/${filename}`,
      filename: cleanAssetFilename(input.filename, storedExt),
      mime: storedMime,
      sizeBytes: bytes.length
    };
  }

  /** 写操作后立即失效关系图缓存（下次请求重建）。 */
  private invalidateReferenceGraphCache(): void {
    this.referenceGraphCache = null;
  }

  /** 完整构建关系图节点/边/悬空集合，并按度数排序（带缓存 TTL 2s）。 */
  private buildReferenceGraph(): CachedReferenceGraph {
    const nodes: ReferenceGraphNode[] = [];
    const known = new Set<string>();
    const addNode = (node: ReferenceGraphNode): void => {
      nodes.push(node);
      known.add(node.id);
    };
    for (const document of this.listDocuments(false)) {
      addNode({
        id: `document:${document.id}`,
        kind: 'document',
        label: document.name || '未命名文献',
        documentId: document.id
      });
    }
    const noteRows = this.db
      .prepare(
        `SELECT id, document_id, page, content FROM notes WHERE deleted = 0
         ORDER BY created DESC, rowid DESC`
      )
      .all() as unknown as Array<{
      id: string;
      document_id: string | null;
      page: number | null;
      content: string | null;
    }>;
    for (const note of noteRows) {
      addNode({
        id: `note:${note.id}`,
        kind: 'note',
        label: noteGraphLabel(note.content ?? ''),
        documentId: note.document_id ?? '',
        page: Number(note.page ?? 0)
      });
    }
    const annotationRows = this.db
      .prepare(
        `SELECT id, document_id, page, quote, content FROM annotations WHERE deleted = 0
         ORDER BY created DESC, rowid DESC`
      )
      .all() as unknown as Array<{
      id: string;
      document_id: string | null;
      page: number | null;
      quote: string | null;
      content: string | null;
    }>;
    for (const annotation of annotationRows) {
      const label =
        (annotation.quote ?? '').trim() ||
        markdownPlainText(annotation.content ?? '').trim().slice(0, 40) ||
        '未命名批注';
      addNode({
        id: `annotation:${annotation.id}`,
        kind: 'annotation',
        label,
        documentId: annotation.document_id ?? '',
        page: Number(annotation.page ?? 0)
      });
    }

    const edges: ReferenceGraphEdge[] = [];
    const seen = new Set<string>();
    // 悬空引用按「来源 + 目标原文」去重；同一来源重复写同一个不存在的目标只算 1。
    const unresolvedKeys = new Set<string>();
    const scan = (fromId: string, content: string): void => {
      const pattern = /\[\[([^\]\n]+)\]\]/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const rawTarget = (match[1] ?? '').trim();
        const parsed = parseMarkdownInternalLink(rawTarget);
        if (!parsed) continue;
        const target = parsed.target;
        const to =
          target.kind === 'document'
            ? `document:${target.documentId}`
            : target.kind === 'annotation'
              ? `annotation:${target.annotationId}`
              : `note:${target.noteId}`;
        if (!known.has(to)) {
          unresolvedKeys.add(`${fromId}\u0000${rawTarget}`);
          continue;
        }
        const key = `${fromId}\u0000${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: fromId, to });
      }
    };
    for (const note of noteRows) scan(`note:${note.id}`, note.content ?? '');
    for (const annotation of annotationRows) {
      scan(`annotation:${annotation.id}`, annotation.content ?? '');
    }

    // 度数 = 与该节点相连的边数（出边+入边，自环算 2）。
    const degree = new Map<string, number>();
    for (const node of nodes) degree.set(node.id, 0);
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    nodes.sort((left, right) => {
      const degreeDiff = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
      if (degreeDiff !== 0) return degreeDiff;
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      return left.id.localeCompare(right.id);
    });
    return {
      builtAt: Date.now(),
      nodes,
      edges,
      unresolved: unresolvedKeys.size,
      nodeById: new Map(nodes.map((node) => [node.id, node]))
    };
  }

  /**
   * 保存任意笔记附件（非图片）：泛化扩展名/MIME，sha256 去重，≤50MB，登记 note_assets 行。
   * 图片仍应走 saveNoteAsset（有 magic/尺寸/像素校验）。
   */
  saveNoteFile(filename: string, bytes: Uint8Array): NoteAssetRecord {
    const buffer = Buffer.from(bytes);
    if (buffer.length === 0) throw new Error('附件内容为空');
    if (buffer.length > 50 * 1024 * 1024) throw new Error('附件不能超过 50MB');
    const displayName = cleanAssetFilename(filename, 'bin');
    const rawExt = path.extname(displayName).slice(1).toLowerCase();
    const ext = /^[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : 'bin';
    const mime = NOTE_ASSET_MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const dir = path.join(this.dataDir, NOTE_ASSET_DIR);
    mkdirSync(dir, { recursive: true });
    const storedName = `${sha256}.${ext}`;
    const target = path.join(dir, storedName);
    if (!existsSync(target)) writeFileSync(target, buffer);
    // 登记资源行（ref_count 由引用同步维护）。
    const existing = this.db
      .prepare('SELECT asset_id FROM note_assets WHERE filename = ?')
      .get(storedName) as { asset_id?: string } | undefined;
    if (existing?.asset_id) {
      this.db
        .prepare('UPDATE note_assets SET mime = ?, size_bytes = ? WHERE asset_id = ?')
        .run(mime, buffer.length, existing.asset_id);
    } else {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO note_assets(asset_id, filename, mime, size_bytes)
           VALUES (?, ?, ?, ?)`
        )
        .run(sha256, storedName, mime, buffer.length);
      const inserted = this.db
        .prepare('SELECT asset_id FROM note_assets WHERE filename = ?')
        .get(storedName) as { asset_id?: string } | undefined;
      if (!inserted?.asset_id) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO note_assets(asset_id, filename, mime, size_bytes)
             VALUES (?, ?, ?, ?)`
          )
          .run(randomUUID(), storedName, mime, buffer.length);
      }
    }
    return {
      id: sha256,
      url: `studianda-asset://${NOTE_ASSET_DIR}/${storedName}`,
      filename: displayName,
      mime,
      sizeBytes: buffer.length
    };
  }

  /** 按 external_key 前缀列出笔记（Markdown 同一 vault 的已导入笔记，用于链接 resolving）。 */
  listNotesByExternalKeyPrefix(prefix: string): Array<{
    id: string;
    externalKey: string;
    folderPath: string;
    content: string;
  }> {
    return noteDomain.listNotesByExternalKeyPrefix(this.db, prefix);
  }

  /**
   * 全库引用关系图：文献/笔记/批注三类节点 + 笔记/批注里 `[[…]]` 引用形成的边。
   *
   * 节点包含所有未删除对象（含无连边的孤立节点、独立笔记 documentId=''）；
   * 只有目标仍存在时才建边；引用已删除/不存在目标计入 unresolved（按 `来源→目标原文`
   * 去重，同一来源重复引用同一缺失目标只算 1）。同一对 from→to 只保留一条边。
   *
   * 返回按引用度数（入边+出边，自环计 2）降序、同度数按 kind/id 升序排序后的当前页；
   * edges 只含两端都在当前页的边；offset 默认 0，limit 默认 200（1..500）。
   *
   * 可选 kinds（document/note/annotation）与 search（节点显示名不区分大小写子串）在分页之前
   * 过滤，totalNodes/totalEdges/hasMore 均按过滤后的结果计算，便于「只看文献+笔记」一屏装下。
   * kindCounts 始终返回全库各类型总数（不受过滤影响），UI 可据此提示如何缩小范围。
   *
   * `all: true` 为全量模式：一次返回全部匹配节点与全部页内边（不再按 offset/limit 截断），
   * totalNodes/totalEdges 为全图口径、hasMore=false、crossEdges 为空（所有端点在同一份数据里，
   * 不会出现「A 与 BCD 都有关系却只显示 BC」的跨页缺失）。超过硬上限 MAX_ALL_NODES 时退回
   * 分页并返回 truncated=true / allNodeLimit，如实标注截断。
   */
  getReferenceGraph(options?: {
    limit?: number;
    offset?: number;
    kinds?: ReferenceNodeKind[];
    search?: string;
    all?: boolean;
  }): ReferenceGraph {
    const limit = options?.limit ?? 200;
    const offset = options?.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('limit 必须是 1..500 的整数');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset 必须是非负整数');
    }
    const rawKinds = options?.kinds;
    if (rawKinds !== undefined && !Array.isArray(rawKinds)) {
      throw new Error('kinds 必须是 document/note/annotation 的数组');
    }
    const kindFilter = rawKinds && rawKinds.length > 0 ? new Set<ReferenceNodeKind>(rawKinds) : null;
    if (kindFilter) {
      for (const kind of kindFilter) {
        if (kind !== 'document' && kind !== 'note' && kind !== 'annotation') {
          throw new Error('kinds 必须是 document/note/annotation 的数组');
        }
      }
    }
    const search = (options?.search ?? '').trim().toLowerCase();
    let full = this.referenceGraphCache;
    if (!full || Date.now() - full.builtAt > Store.REFERENCE_GRAPH_CACHE_TTL_MS) {
      full = this.buildReferenceGraph();
      this.referenceGraphCache = full;
    }
    const kindCounts: Record<ReferenceNodeKind, number> = {
      document: 0,
      note: 0,
      annotation: 0
    };
    for (const node of full.nodes) kindCounts[node.kind] += 1;
    const matchedNodes =
      kindFilter || search
        ? full.nodes.filter(
            (node) =>
              (!kindFilter || kindFilter.has(node.kind)) &&
              (!search || node.label.toLowerCase().includes(search))
          )
        : full.nodes;
    const matchedIds =
      matchedNodes === full.nodes ? null : new Set(matchedNodes.map((node) => node.id));
    // 全量模式：匹配结果不超过硬上限时一次返回全部节点/边；超限则退回分页并标注截断。
    const allMode = options?.all === true;
    const allNodeLimit = Store.MAX_ALL_NODES;
    const truncated = allMode && matchedNodes.length > allNodeLimit;
    const fullAll = allMode && !truncated;
    const pageNodes = fullAll ? matchedNodes : matchedNodes.slice(offset, offset + limit);
    const pageIds = new Set(pageNodes.map((node) => node.id));
    const pageEdges: ReferenceGraphEdge[] = [];
    const crossEdges: ReferenceGraphCrossEdge[] = [];
    const crossSeen = new Set<string>();
    for (const edge of full.edges) {
      const fromInPage = pageIds.has(edge.from);
      const toInPage = pageIds.has(edge.to);
      if (fromInPage && toInPage) {
        pageEdges.push(edge);
        continue;
      }
      // 全量模式不画跨页 stub：不在结果集里的端点是被 kinds/search 主动过滤掉的。
      if (fullAll) continue;
      // 两端都在页外：与当前页无关；恰好一端在页内：跨页边。
      if (!fromInPage && !toInPage) continue;
      const key = `${edge.from}\u0000${edge.to}`;
      if (crossSeen.has(key)) continue;
      crossSeen.add(key);
      const externalId = fromInPage ? edge.to : edge.from;
      crossEdges.push({
        from: edge.from,
        to: edge.to,
        externalId,
        externalLabel: full.nodeById.get(externalId)?.label ?? externalId,
        direction: fromInPage ? 'out' : 'in'
      });
    }
    let totalEdges = full.edges.length;
    if (matchedIds) {
      // 过滤后 totalEdges 只统计两端都在结果集中的边，和 totalNodes 口径一致。
      totalEdges = 0;
      for (const edge of full.edges) {
        if (matchedIds.has(edge.from) && matchedIds.has(edge.to)) totalEdges += 1;
      }
    }
    // 跨页边稳定排序（from、to 字典序）后截断到 200 条，total 记录全部数量。
    crossEdges.sort((left, right) =>
      left.from === right.from
        ? left.to.localeCompare(right.to)
        : left.from.localeCompare(right.from)
    );
    const crossEdgeTotal = crossEdges.length;
    return {
      nodes: pageNodes,
      edges: pageEdges,
      crossEdges: crossEdges.slice(0, 200),
      crossEdgeTotal,
      unresolved: full.unresolved,
      totalNodes: matchedNodes.length,
      totalEdges,
      offset,
      limit,
      hasMore: fullAll ? false : offset + pageNodes.length < matchedNodes.length,
      kindCounts,
      ...(allMode ? { truncated, allNodeLimit } : {})
    };
  }

  /**
   * 清理没有被任何笔记/批注引用的本地图片资源。
   *
   * 引用判断优先用 `note_assets`/`note_asset_refs`：挂表时 ref_count>0 视为被引用；
   * includeDeleted 默认 true（含已删除笔记/批注，restore-safe），false 时忽略 deleted=1
   * 来源的引用，允许清理只被已删除内容引用的图片。磁盘上但表中没有的文件按孤儿处理。
   * 删除条件仍是「无引用 + mtime 早于 graceMs（默认 24h）」；dryRun 只统计不删；
   * 非 dryRun 完成后写 settings `note_assets.last_gc`（ISO 时间）。只处理目录内普通文件。
   */
  gcNoteAssets(input?: {
    dryRun?: boolean;
    graceMs?: number;
    includeDeleted?: boolean;
  }): NoteAssetGcReport {
    return noteAssets.gc(this.db, this.noteAssetDeps, input);
  }

  /** 本地图片资源使用统计：文件数/占用/被引用/孤儿/活跃与仅删除引用/上次清理/索引统计。 */
  getNoteAssetUsage(): NoteAssetUsage {
    return noteAssets.usage(this.db, this.noteAssetDeps);
  }

  /** 启动时自动 GC：restore-safe（includeDeleted=true、grace 24h）；失败不影响启动。 */
  autoGcNoteAssets(): void {
    try {
      this.gcNoteAssets({ includeDeleted: true, graceMs: 24 * 60 * 60 * 1000 });
    } catch {
      // 后台清理失败不阻断启动，下次启动再试。
    }
  }

  /**
   * 手动重建资源索引：重新扫描 note-assets 目录与所有笔记/批注内容，修复外部直接改库
   * 造成的 refs 漂移；同时更新并返回 `note_assets.indexed_*` 统计。
   */
  reindexNoteAssets(): NoteAssetReindexResult {
    return noteAssets.reindex(this.db, this.noteAssetDeps);
  }

  /**
   * 触发后台分块重建资源索引（单并发）：目录文件、notes、annotations 分批处理，
   * 每批一个短事务并在批间让出事件循环，避免长时间阻塞请求。已运行则返回当前任务。
   */
  startNoteAssetReindex(): NoteAssetReindexJob {
    return this.noteAssetReindexer.start();
  }

  /** 后台重建任务状态快照（无任务时 status/phase 为 idle）。 */
  getNoteAssetReindexStatus(): NoteAssetReindexJob {
    return this.noteAssetReindexer.status();
  }

  /**
   * 反向链接：哪些笔记/批注引用了指定目标（`[[note:doc/id]]`、`[[ann:doc/id]]`、`[[doc:id]]`）。
   *
   * 独立笔记目标用 `documentId=''` + `id=<noteId>`，匹配无斜杠的 `[[note:<noteId>]]`；
   * 此时不做 documents 存在性检查，来源是独立笔记时 documentName 固定为「独立笔记」。
   * 其余目标先用 id 做 SQL LIKE 缩小候选（含回收站来源文献，名称仍可读），再用正则
   * 精确校验引用边界（`|` 或 `]]`），避免 `<id>` 前缀把 `id2` 也误判为引用；同时兼容
   * `[[document:…]]` / `[[annotation:…]]` 别名。snippet 用 markdownPlainText 去标记。
   */
  listBacklinks(input: {
    kind: BacklinkTargetKind;
    documentId: string;
    id?: string;
  }): BacklinkRecord[] {
    const documentId = (input?.documentId ?? '').trim();
    const targetId = (input?.id ?? '').trim();
    const kind = input?.kind;
    const standaloneNoteTarget = kind === 'note' && !documentId;
    if (!documentId && !standaloneNoteTarget) return [];

    let pattern: RegExp;
    const documentPattern = escapeRegExp(documentId);
    if (standaloneNoteTarget) {
      if (!targetId) return [];
      // 独立笔记引用没有斜杠：`[[note:<noteId>]]` / `[[note:<noteId>|标签]]`。
      pattern = new RegExp(`\\[\\[note:${escapeRegExp(targetId)}(?:\\||\\]\\])`, 'i');
    } else {
      const target = this.db
        .prepare('SELECT id FROM documents WHERE id = ?')
        .get(documentId) as { id?: string } | undefined;
      if (!target?.id) return [];
      if (kind === 'document') {
        pattern = new RegExp(`\\[\\[(?:doc|document):${documentPattern}(?:\\||\\]\\])`, 'i');
      } else if (!targetId) {
        // note/annotation 目标必须给出 id；缺 id 视为没有反向链接。
        return [];
      } else if (kind === 'note') {
        pattern = new RegExp(
          `\\[\\[note:${documentPattern}/${escapeRegExp(targetId)}(?:\\||\\]\\])`,
          'i'
        );
      } else if (kind === 'annotation') {
        pattern = new RegExp(
          `\\[\\[(?:ann|annotation):${documentPattern}/${escapeRegExp(targetId)}(?:\\||\\]\\])`,
          'i'
        );
      } else {
        return [];
      }
    }

    // LIKE 先缩小候选：独立笔记目标按 note id，其余按目标文献 id；边界再由正则判定。
    const like = `%${escapeLike(standaloneNoteTarget ? targetId : documentId)}%`;
    const notes = this.db
      .prepare(
        `SELECT n.id AS id, n.document_id AS document_id, d.name AS document_name,
                n.page AS page, n.content AS content, n.created AS created, n.rowid AS rowid
         FROM notes n LEFT JOIN documents d ON d.id = n.document_id
         WHERE n.deleted = 0 AND n.content LIKE ? ESCAPE '\\'`
      )
      .all(like) as unknown as BacklinkCandidateRow[];
    const annotations = this.db
      .prepare(
        `SELECT a.id AS id, a.document_id AS document_id, d.name AS document_name,
                a.page AS page, a.content AS content, a.created AS created, a.rowid AS rowid
         FROM annotations a LEFT JOIN documents d ON d.id = a.document_id
         WHERE a.deleted = 0 AND a.content LIKE ? ESCAPE '\\'`
      )
      .all(like) as unknown as BacklinkCandidateRow[];

    const records: Array<BacklinkRecord & { created: string; rowid: number }> = [];
    const collect = (
      rows: BacklinkCandidateRow[],
      sourceKind: 'note' | 'annotation'
    ): void => {
      for (const row of rows) {
        const content = String(row.content ?? '');
        const match = pattern.exec(content);
        if (!match) continue;
        // 排除目标自身（笔记引用自己 / 批注引用自己）。
        if (sourceKind === kind && String(row.id) === targetId) continue;
        const snippet = this.backlinkSnippet(content, match.index);
        const sourceDocumentId = String(row.document_id ?? '');
        records.push({
          kind: sourceKind,
          id: String(row.id),
          documentId: sourceDocumentId,
          // 独立笔记来源没有所属文献，给界面一个可读名字。
          documentName: sourceDocumentId ? String(row.document_name ?? '') : '独立笔记',
          page: Number(row.page ?? 0),
          snippet,
          created: String(row.created ?? ''),
          rowid: Number(row.rowid ?? 0)
        });
      }
    };
    collect(notes, 'note');
    collect(annotations, 'annotation');
    // created 只到秒（SQLite CURRENT_TIMESTAMP），同秒用 rowid 倒序保证"新写入在前"。
    records.sort(
      (left, right) =>
        right.created.localeCompare(left.created) || right.rowid - left.rowid
    );
    return records.slice(0, 100).map(({ created, rowid, ...record }) => record);
  }

  /** 引用位置附近约 120 字的纯文本摘要（去掉 Markdown 标记）。 */
  private backlinkSnippet(content: string, index: number): string {
    // 摘要必须包含完整的 `[[…]]` 引用，否则 markdownPlainText 会把半截语法当普通文本，
    // 在摘要里留下 `[[note:…` 这种原始标记。
    const close = content.indexOf(']]', index);
    const tokenEnd = close >= 0 ? close + 2 : index;
    const start = Math.max(0, index - 40);
    const end = Math.min(content.length, Math.max(index + 80, tokenEnd + 60));
    const plain = markdownPlainText(content.slice(start, end)).trim();
    return `${start > 0 ? '…' : ''}${plain}${end < content.length ? '…' : ''}`;
  }

  // -------------------------------------------------------------------------
  // 批注写路径：实现已抽到 ./store/annotations.ts（创建/更新/回收站/彻底删除），
  // Store 上只剩薄委托，签名/返回结构不变。事务边界、内容与 refs 同成同败、
  // COMMIT 后回收资源与失效缓存等不变量见域模块文件头。
  // -------------------------------------------------------------------------

  /** 创建批注（含 rects 校验、origin 归一与资源引用同步）；实现与事务顺序见 store/annotations.ts。 */
  createAnnotation(input: CreateAnnotationInput): AnnotationRecord {
    return annotationDomain.createAnnotation(this.db, this.annotationDomainDeps, input);
  }

  /** 更新批注（正文/颜色/样式）；实现与事务顺序见 store/annotations.ts。 */
  updateAnnotation(id: string, input: UpdateAnnotationInput): AnnotationRecord | null {
    return annotationDomain.updateAnnotation(this.db, this.annotationDomainDeps, id, input);
  }

  /** 彻底删除批注（含回收站里的）+ 回收其独占图片资源；实现见 store/annotations.ts。 */
  purgeAnnotation(id: string): NotePurgeResult {
    return annotationDomain.purgeAnnotation(this.db, this.annotationDomainDeps, id);
  }

  /** 软删除（移入回收站）；引用图缓存由域实现经注入的 deps 失效。 */
  deleteAnnotation(id: string): void {
    annotationDomain.deleteAnnotation(this.db, this.annotationDomainDeps, id);
  }

  /** 从回收站恢复软删除的批注；refs 在软删除期间保留，恢复后无需重建。 */
  restoreAnnotation(id: string): void {
    annotationDomain.restoreAnnotation(this.db, this.annotationDomainDeps, id);
  }

  search(query: string, documentId?: string, limit = 20): SearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const max = Math.min(Math.max(1, Math.trunc(limit)), 50);
    const documentFilter = documentId ? ' AND c.document_id = ?' : '';
    const documentParams = documentId ? [documentId] : [];

    const toHits = (rows: Array<Record<string, unknown>>, fallbackSnippet = false): SearchHit[] =>
      rows.map((row) => {
        const text = String(row.text ?? '');
        return {
          chunkId: String(row.chunkId ?? ''),
          documentId: String(row.documentId ?? ''),
          documentName: String(row.documentName ?? ''),
          page: Number(row.page ?? 1),
          snippet: fallbackSnippet
            ? makeSnippet(text, trimmed)
            : String(row.snippet ?? ''),
          // 命中行：与全文检索同口径（整行锚点/去空白回退），界面据此精确标出命中词。
          match: matchedExcerpt(text, trimmed),
          score: Number(row.rank ?? 0)
        };
      });

    if (trimmed.length >= 3) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.id AS chunkId, c.document_id AS documentId, d.name AS documentName,
                    c.page AS page, c.text AS text,
                    snippet(chunks_fts, 0, '[', ']', '…', 18) AS snippet,
                    bm25(chunks_fts) AS rank
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN documents d ON d.id = c.document_id
             WHERE chunks_fts MATCH ? AND d.deleted = 0${documentFilter}
             ORDER BY rank
             LIMIT ?`
          )
          .all(makeFtsQuery(trimmed), ...documentParams, max) as unknown as Array<
          Record<string, unknown>
        >;
        if (rows.length > 0) return toHits(rows);
      } catch {
        // 查询语法/分词不支持时退回 LIKE
      }
    }

    const escaped = trimmed.replace(/[\\%_]/g, (character) => `\\${character}`);
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunkId, c.document_id AS documentId, d.name AS documentName,
                c.page AS page, c.text AS text, 0 AS rank
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE d.deleted = 0 AND c.text LIKE ? ESCAPE '\\'${documentFilter}
         ORDER BY c.page
         LIMIT ?`
      )
      .all(`%${escaped}%`, ...documentParams, max) as unknown as Array<Record<string, unknown>>;
    return toHits(rows, true);
  }

  /**
   * 正文命中的文献 id（去重，不截断）。
   *
   * 文献列表的搜索过滤需要"哪些文献命中"，而不是"前 N 段命中"；`search()`
   * 为了界面性能有 50 条上限，不能用来判断整库范围，所以单独走一次去重查询。
   */
  matchDocumentIds(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (trimmed.length >= 3) {
      try {
        const rows = this.db
          .prepare(
            `SELECT DISTINCT c.document_id AS documentId
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN documents d ON d.id = c.document_id
             WHERE chunks_fts MATCH ? AND d.deleted = 0`
          )
          .all(makeFtsQuery(trimmed)) as unknown as Array<Record<string, unknown>>;
        if (rows.length > 0) return rows.map((row) => String(row.documentId ?? ''));
      } catch {
        // 查询语法/分词不支持时退回 LIKE
      }
    }

    const escaped = trimmed.replace(/[\\%_]/g, (character) => `\\${character}`);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.document_id AS documentId
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE d.deleted = 0 AND c.text LIKE ? ESCAPE '\\'`
      )
      .all(`%${escaped}%`) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.documentId ?? ''));
  }

  listNavigation(documentId: string): Array<{ page: number; kind: string; label: string }> {
    return this.db
      .prepare(
        `SELECT page, kind, label FROM doc_navigation
         WHERE document_id = ? ORDER BY page ASC, rowid ASC`
      )
      .all(documentId) as unknown as Array<{ page: number; kind: string; label: string }>;
  }

  /**
   * 保存本地目录节点。
   *
   * `kind='manual'`：用户编辑/手动添加后保存；`kind='materialized'`：勾选启用时
   * 把 PDF 内置目录自动保存成的本地副本（两者都写当前 sourceHash，状态为 ready）。
   */
  saveNavigation(
    documentId: string,
    nodes: Array<{ page: number; label: string }>,
    kind: 'manual' | 'materialized' = 'manual'
  ): Array<{ page: number; kind: string; label: string }> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const rows = nodes
      .filter(
        (node) =>
          Number.isInteger(node.page) &&
          node.page >= 1 &&
          node.page <= document.pages &&
          typeof node.label === 'string' &&
          node.label.trim()
      )
      .map((node) => ({
        page: node.page,
        kind: 'manual',
        label: node.label.trim().slice(0, 120)
      }))
      .sort((left, right) => left.page - right.page);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM doc_navigation WHERE document_id = ?').run(documentId);
      const insert = this.db.prepare(
        'INSERT INTO doc_navigation(document_id, page, kind, label) VALUES (?, ?, ?, ?)'
      );
      for (const row of rows) insert.run(documentId, row.page, row.kind, row.label);
      // 保存（手动编辑或内置目录落成本地副本）也是"当前版本的目录"：写入当前 sourceHash，
      // 状态才是 ready；之后改目录页设置/换文件仍会变 stale。
      const { stamp, sourceHash } = this.navigationStamp(documentId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO doc_navigation_state
           (document_id, enabled, built_at, source_hash, node_count, file_stamp, mask_revision, build_state, error)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, '')`
        )
        .run(
          documentId,
          new Date().toISOString(),
          sourceHash,
          rows.length,
          stamp,
          this.pageMaskRevision(documentId),
          kind
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows;
  }

  readSection(
    documentId: string,
    section: string,
    pages?: number[]
  ): { pages: number[]; text: string } | null {    const document = this.getDocument(documentId);
    if (!document) return null;
    const navigation = this.listNavigation(documentId);
    let selectedPages: number[] = [];
    if (pages && pages.length > 0) {
      selectedPages = pages.filter(
        (page) => Number.isInteger(page) && page >= 1 && page <= document.pages
      );
    } else {
      const matched = navigation.find(
        (entry) =>
          entry.label.toLowerCase().includes(section.toLowerCase()) ||
          section.toLowerCase().includes(entry.label.toLowerCase())
      );
      if (!matched) return null;
      const next = navigation.find((entry) => entry.page > matched.page);
      const start = matched.page;
      const end = Math.min(next ? next.page - 1 : document.pages, start + 15);
      selectedPages = Array.from(
        { length: Math.max(1, end - start + 1) },
        (_, index) => start + index
      );
    }
    selectedPages = [...new Set(selectedPages)].sort((left, right) => left - right);
    return {
      pages: selectedPages,
      text: selectedPages
        .map((page) => `第 ${page} 页\n${this.getPageText(documentId, page)}`)
        .join('\n\n')
    };
  }

  /** 某文献的页遮罩规则（只读；遮罩写入/重建链路仍在本文件）；语义见 store/documents.ts。 */
  listPageMasks(documentId: string): PageMask[] {
    return documentDomain.listPageMasks(this.db, documentId);
  }

  async addPageMask(
    documentId: string,
    input: {
      page: number;
      scope?: PageMask['scope'];
      rangeStart?: number;
      rangeEnd?: number;
      excludePages?: number[];
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  ): Promise<PageMask> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    if (!Number.isInteger(input.page) || input.page < 0 || input.page > document.pages) {
      throw new Error('页码超出范围');
    }
    if (
      ![input.x0, input.y0, input.x1, input.y1].every(Number.isFinite) ||
      input.x0 < 0 || input.y0 < 0 || input.x1 > 1 || input.y1 > 1 ||
      input.x0 >= input.x1 || input.y0 >= input.y1
    ) {
      throw new Error('区域坐标无效');
    }
    const scope = input.scope ?? (input.page === 0 ? 'all' : 'page');
    const targetPage = scope === 'page' ? input.page : 0;
    const rangeStart = input.rangeStart ?? 1;
    const rangeEnd = input.rangeEnd ?? 0;
    const excludePages = input.excludePages ?? [];
    // 幂等：同页/同范围/同坐标（1e-6 内）的规则直接返回原条目，不重复插入、不重复重建。
    const existing = this.listPageMasks(documentId).find(
      (mask) =>
        mask.scope === scope &&
        mask.page === targetPage &&
        (mask.rangeStart ?? 1) === rangeStart &&
        (mask.rangeEnd ?? 0) === rangeEnd &&
        JSON.stringify(mask.excludePages ?? []) === JSON.stringify(excludePages) &&
        Math.abs(mask.x0 - input.x0) <= 1e-6 &&
        Math.abs(mask.y0 - input.y0) <= 1e-6 &&
        Math.abs(mask.x1 - input.x1) <= 1e-6 &&
        Math.abs(mask.y1 - input.y1) <= 1e-6
    );
    if (existing) return existing;
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM page_masks WHERE document_id = ?')
      .get(documentId) as unknown as { count: number };
    if (count.count >= 200) throw new Error('屏蔽规则已达上限（200 条）');
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO page_masks(id, document_id, page, scope, range_start, range_end,
          exclude_pages, x0, y0, x1, y1)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, documentId, targetPage, scope,
        rangeStart, rangeEnd,
        JSON.stringify(excludePages),
        input.x0, input.y0, input.x1, input.y1
      );
    await this.rebuildMaskedChunksScheduled(
      documentId,
      this.maskAffectedPages(
        documentId, scope, input.page, input.rangeStart, input.rangeEnd, input.excludePages
      )
    );
    return this.listPageMasks(documentId).find((mask) => mask.id === id)!;
  }

  async updatePageMask(
    documentId: string,
    maskId: string,
    input: {
      scope?: PageMask['scope'];
      page?: number;
      rangeStart?: number;
      rangeEnd?: number;
      excludePages?: number[];
      x0?: number;
      y0?: number;
      x1?: number;
      y1?: number;
    }
  ): Promise<PageMask> {
    const document = this.getDocument(documentId);
    const existing = this.listPageMasks(documentId).find((mask) => mask.id === maskId);
    if (!document || !existing) throw new Error('屏蔽规则不存在');
    const scope = input.scope ?? existing.scope;
    const page = input.page ?? existing.page;
    const x0 = input.x0 ?? existing.x0;
    const y0 = input.y0 ?? existing.y0;
    const x1 = input.x1 ?? existing.x1;
    const y1 = input.y1 ?? existing.y1;
    if (![x0, y0, x1, y1].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x0 >= x1 || y0 >= y1) {
      throw new Error('区域坐标无效');
    }
    this.db
      .prepare(
        `UPDATE page_masks SET page = ?, scope = ?, range_start = ?, range_end = ?,
          exclude_pages = ?, x0 = ?, y0 = ?, x1 = ?, y1 = ? WHERE id = ? AND document_id = ?`
      )
      .run(
        scope === 'page' ? page : 0, scope,
        input.rangeStart ?? existing.rangeStart ?? 1,
        input.rangeEnd ?? existing.rangeEnd ?? 0,
        JSON.stringify(input.excludePages ?? existing.excludePages ?? []),
        x0, y0, x1, y1, maskId, documentId
      );
    await this.rebuildMaskedChunksScheduled(
      documentId,
      this.maskAffectedPages(
        documentId, scope, page,
        input.rangeStart ?? existing.rangeStart,
        input.rangeEnd ?? existing.rangeEnd,
        input.excludePages ?? existing.excludePages
      )
    );
    return this.listPageMasks(documentId).find((mask) => mask.id === maskId)!;
  }

  private maskAffectedPages(
    documentId: string,
    scope: PageMask['scope'],
    page: number,
    rangeStart?: number,
    rangeEnd?: number,
    excludePages: number[] = []
  ): number[] {
    const document = this.getDocument(documentId);
    if (!document) return [];
    if (scope === 'page') return [page];
    if (scope === 'range') {
      const start = Math.max(1, rangeStart ?? 1);
      const end = Math.min(document.pages, rangeEnd ?? document.pages);
      const pages: number[] = [];
      for (let index = start; index <= end; index += 1) {
        if (!excludePages.includes(index)) pages.push(index);
      }
      return pages;
    }
    if (scope === 'odd' || scope === 'even') {
      const parity = scope === 'odd' ? 1 : 0;
      return Array.from({ length: document.pages }, (_, index) => index + 1).filter(
        (index) => index % 2 === parity && !excludePages.includes(index)
      );
    }
    return Array.from({ length: document.pages }, (_, index) => index + 1).filter(
      (index) => scope !== 'exclude' || !excludePages.includes(index)
    );
  }

  async removePageMask(documentId: string, maskId: string): Promise<void> {
    const mask = this.listPageMasks(documentId).find((item) => item.id === maskId);
    if (!mask) throw new Error('屏蔽规则不存在');
    this.db
      .prepare('DELETE FROM page_masks WHERE id = ? AND document_id = ?')
      .run(maskId, documentId);
    await this.rebuildMaskedChunksScheduled(
      documentId,
      this.maskAffectedPages(
        documentId,
        mask.scope,
        mask.page,
        mask.rangeStart,
        mask.rangeEnd,
        mask.excludePages
      )
    );
  }

  /**
   * 遮罩重建调度。
   * 同一文档重建进行中再次变更只把页并入 pending，等当前轮完成后按最新 masks 再跑一轮；
   * 不并行跑两份，也不让解析/数据库异常把状态永久停在 rebuilding。
   */
  private async rebuildMaskedChunksScheduled(
    documentId: string,
    pages: number[]
  ): Promise<void> {
    const syncLimit = Number(process.env.STUDIANDA_MASK_SYNC_LIMIT ?? 40);
    const current = this.maskJobs.get(documentId);
    if (current?.state === 'rebuilding') {
      const pending = this.maskPending.get(documentId) ?? new Set<number>();
      for (const page of pages) pending.add(page);
      this.maskPending.set(documentId, pending);
      return;
    }
    const sync = !Number.isFinite(syncLimit) || pages.length <= syncLimit;
    this.maskJobs.set(documentId, { state: 'rebuilding', done: 0, total: pages.length });
    const run = this.runMaskedRebuild(documentId, pages, sync);
    if (sync) {
      await run;
      return;
    }
    // 后台：runMaskedRebuild 自己捕获并写 failed；这里兜底并确保意外异常不被静默吞掉。
    void run.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '重建索引失败';
      this.maskJobs.set(documentId, {
        state: 'failed',
        done: 0,
        total: pages.length,
        error: message
      });
      try {
        appendErrorLog(this.dataDir, 'mask:rebuild', error);
      } catch {
        // 错误日志写失败不影响状态。
      }
    });
  }

  /** 跑一轮或多轮（pending 合并）遮罩重建；同步首轮失败抛给调用方，后台失败落状态与错误日志。 */
  private async runMaskedRebuild(
    documentId: string,
    firstPages: number[],
    throwFirstError: boolean
  ): Promise<void> {
    const normalize = (pages: number[]): number[] =>
      [...new Set(pages)]
        .filter((page) => Number.isInteger(page) && page >= 1)
        .sort((left, right) => left - right);
    let round = normalize(firstPages);
    for (;;) {
      if (round.length === 0) return;
      try {
        await this.rebuildMaskedChunks(documentId, round);
      } catch (error) {
        this.maskPending.delete(documentId);
        if (!throwFirstError) {
          // 后台失败不能静默：状态已由 rebuildMaskedChunks 写成 failed，这里再记一条错误日志。
          appendErrorLog(this.dataDir, 'mask:rebuild', error);
        }
        if (throwFirstError) throw error;
        return;
      }
      const pending = this.maskPending.get(documentId);
      this.maskPending.delete(documentId);
      if (!pending || pending.size === 0) return;
      // 下一轮用最新 masks（rebuildMaskedChunks 内部重新 listPageMasks）。
      round = normalize([...pending]);
      this.maskJobs.set(documentId, {
        state: 'rebuilding',
        done: 0,
        total: round.length
      });
      throwFirstError = false;
    }
  }

  private async rebuildMaskedChunks(documentId: string, pages: number[]): Promise<void> {
    const total = pages.length;
    this.maskJobs.set(documentId, { state: 'rebuilding', done: 0, total });
    let inTransaction = false;
    try {
      const documentPath = this.getDocumentPath(documentId);
      if (!documentPath) throw new Error('PDF 副本不存在');
      // 解析与数据库都放进 try：任何一步失败都要落 failed，不能把状态永久停在 rebuilding。
      const layout = await extractPdfLayout(readFileSync(documentPath));
      const masks = this.listPageMasks(documentId);
      const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
      const insertChunk = this.db.prepare(
        `INSERT INTO chunks(id, document_id, page, text, bbox, bbox_space)
         VALUES (?, ?, ?, ?, ?, 'visual')`
      );
      const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)');
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      for (const pageNumber of pages) {
        // 用户校订过的页：校订文本才是该页的权威内容，chunks 已由 savePageTextEdit 重建。
        // 遮罩重建若再按原 PDF 的 span 重写这一页，会把校订后的文字从检索里顶掉；
        // 平铺块用 bbox='null'，达到同样"校订块不被删"的效果。
        const edited = this.getPageEdit(documentId, pageNumber);
        if (edited && edited.origin === 'user' && edited.text.trim()) continue;
        // 只删**文本层 span**生成的块（bbox 形如 "[...]"）。OCR/用户校订写入的
        // bbox='null' 平铺块来自身份不同的来源，删掉就再也恢复不了。
        const old = this.db
          .prepare(
            "SELECT rowid AS rowid FROM chunks WHERE document_id = ? AND page = ? AND bbox LIKE '[%'"
          )
          .all(documentId, pageNumber) as unknown as Array<{ rowid: number }>;
        for (const row of old) {
          deleteFts.run(row.rowid);
          this.db
            .prepare('DELETE FROM chunks WHERE document_id = ? AND page = ? AND rowid = ?')
            .run(documentId, pageNumber, row.rowid);
        }
        const page = layout.pages.find((item) => item.page === pageNumber);
        if (!page) continue;
        for (const line of page.lines) {
          if (
            masksForPage(masks, pageNumber).some(
              (mask) =>
                line.bbox[0] < mask.x1 &&
                line.bbox[2] > mask.x0 &&
                line.bbox[1] < mask.y1 &&
                line.bbox[3] > mask.y0
            )
          ) {
            continue;
          }
          for (let start = 0; start < line.text.length; start += 1000) {
            const text = line.text.slice(start, start + 1200);
            const bbox = JSON.stringify([
              line.bbox[0] * page.width,
              line.bbox[1] * page.height,
              line.bbox[2] * page.width,
              line.bbox[3] * page.height
            ]);
            const id = `${documentId}:${pageNumber}:${randomUUID()}`;
            const result = insertChunk.run(id, documentId, pageNumber, text, bbox);
            insertFts.run(Number(result.lastInsertRowid), text);
          }
        }
      }
      this.db.exec('COMMIT');
      inTransaction = false;
      this.maskJobs.set(documentId, {
        state: 'ready',
        done: total,
        total
      });
    } catch (error) {
      if (inTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // 回滚失败也必须保留 failed 状态，不能让状态卡在 rebuilding。
        }
      }
      this.maskJobs.set(documentId, {
        state: 'failed',
        done: 0,
        total,
        error: error instanceof Error ? error.message : '重建索引失败'
      });
      throw error;
    }
  }

  /** 页遮罩重建状态。 */
  maskIndexStatus(documentId: string): {
    state: 'idle' | 'rebuilding' | 'ready' | 'failed';
    done: number;
    total: number;
    error: string;
    revision: string;
  } {
    const job = this.maskJobs.get(documentId);
    const hasMasks = this.listPageMasks(documentId).length > 0;
    return {
      state: job?.state ?? (hasMasks ? 'ready' : 'idle'),
      done: job?.done ?? 0,
      total: job?.total ?? 0,
      error: job?.error ?? '',
      revision: this.pageMaskRevision(documentId)
    };
  }

  /** 页遮罩内容指纹（空遮罩为 ''）；语义见 store/documents.ts。 */
  pageMaskRevision(documentId: string): string {
    return documentDomain.pageMaskRevision(this.db, documentId);
  }

  private navigationStamp(documentId: string): { stamp: string; sourceHash: string } {
    const documentPath = this.getDocumentPath(documentId);
    if (!documentPath) return { stamp: '', sourceHash: '' };
    const stats = statSync(documentPath);
    const stamp = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
    // 目录页设置也进 sourceHash：改了目录页范围应视为「目录需要重新生成」。
    const tocPages = this.getNavigationTocPages(documentId).join(',');
    const sourceHash = createHash('sha256')
      .update(`${stamp}|${this.pageMaskRevision(documentId)}|${tocPages}`)
      .digest('hex')
      .slice(0, 16);
    return { stamp, sourceHash };
  }

  /** 用户指定的「目录页」范围（1 起、升序）；没有设置返回空数组。 */
  getNavigationTocPages(documentId: string): number[] {
    try {
      const row = this.db
        .prepare('SELECT pages FROM doc_navigation_toc WHERE document_id = ?')
        .get(documentId) as unknown as { pages?: string } | undefined;
      if (!row?.pages) return [];
      const total = this.getDocument(documentId)?.pages ?? 0;
      return normalizeTocPages(JSON.parse(row.pages), total);
    } catch {
      return [];
    }
  }

  /** 设置「目录页」范围；传空数组表示清除设置（回到标题规则/PDF 书签）。 */
  setNavigationTocPages(documentId: string, pages: unknown): number[] {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const normalized = normalizeTocPages(pages, document.pages);
    if (normalized.length === 0) {
      this.db.prepare('DELETE FROM doc_navigation_toc WHERE document_id = ?').run(documentId);
    } else {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO doc_navigation_toc(document_id, pages, updated)
           VALUES (?, ?, CURRENT_TIMESTAMP)`
        )
        .run(documentId, JSON.stringify(normalized));
    }
    return normalized;
  }

  /**
   * 预览「按目录页生成目录」：解析目录页 + 估计页码偏移，不保存、不改变现有目录。
   *
   * 供界面在确认生成前先看识别结果（条目、物理页码、偏移置信度、警告）。
   */
  async previewTocNavigation(documentId: string, tocPages: unknown): Promise<TocNavigationPreview> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const pages = normalizeTocPages(tocPages, document.pages);
    if (pages.length === 0) throw new Error('请先指定目录页（1 起，可多页）');
    const layout = await this.readLayout(documentId);
    const masks = this.listPageMasks(documentId);
    const blocks = recognizeBlocks(layout, masks, { documentId, tocPages: pages });
    const result = tocNavigation(layout, masks, pages, document.pages, blocks);
    return {
      toc_pages: pages,
      nodes: result.nodes,
      entries: result.entries,
      stats: result.stats,
      warnings: result.warnings
    };
  }

  navigationStatus(documentId: string): NavigationStatus {
    const job = navigationJobs.get(documentId);
    const row = this.db
      .prepare(
        `SELECT enabled, built_at, source_hash, node_count, build_state, error,
                last_used, file_stamp, mask_revision
         FROM doc_navigation_state WHERE document_id = ?`
      )
      .get(documentId) as unknown as
      | {
          enabled: number;
          built_at: string;
          source_hash: string;
          node_count: number;
          build_state: string;
          error: string;
          last_used: string;
          file_stamp: string;
          mask_revision: string;
        }
      | undefined;
    const { stamp, sourceHash } = this.navigationStamp(documentId);
    const maskRevision = this.pageMaskRevision(documentId);
    // 过期原因要能区分"文件换了"和"遮罩规则改了"，否则用户不知道要不要重建索引。
    const staleReason =
      row && row.source_hash !== sourceHash
        ? row.file_stamp && row.file_stamp !== stamp
          ? '文献文件已变化'
          : (row.mask_revision ?? '') !== maskRevision
            ? '无关区域规则已变化'
            : '索引已过期'
        : '';
    const base = {
      enabled: Boolean(row?.enabled),
      nodeCount: row?.node_count ?? 0,
      builtAt: row?.built_at ?? '',
      sourceHash: row?.source_hash ?? '',
      error: row?.error ?? '',
      done: job?.done ?? 0,
      total: job?.total ?? 0,
      stale_reason: staleReason,
      last_used: row?.last_used ?? '',
      toc_pages: this.getNavigationTocPages(documentId),
      manual: row?.build_state === 'manual',
      materialized: row?.build_state === 'materialized'
    };
    if (job?.state === 'building') return { ...base, state: 'building', done: job.done, total: job.total };
    if (!row) return { ...base, state: 'missing' };
    if (row.build_state === 'failed') return { ...base, state: 'failed' };
    // 启用但从未生成（set_enabled 只插入 enabled/build_state='missing'、没有 source_hash）：
    // 必须报 missing，不能报 stale。
    if (!row.source_hash) return { ...base, state: 'missing' };
    if (row.source_hash !== sourceHash) return { ...base, state: 'stale' };
    return { ...base, state: 'ready' };
  }

  /** 导航生成失败：写 build_state='failed'，但保留用户原来的 enabled（不能悄悄关掉已启用目录）。 */
  private markNavigationFailed(
    documentId: string,
    sourceHash: string,
    stamp: string,
    error: unknown
  ): void {
    let enabled = 0;
    try {
      const row = this.db
        .prepare('SELECT enabled FROM doc_navigation_state WHERE document_id = ?')
        .get(documentId) as unknown as { enabled?: number } | undefined;
      enabled = Number(row?.enabled ?? 0) === 1 ? 1 : 0;
    } catch {
      enabled = 0;
    }
    const message =
      error instanceof Error ? error.message.slice(0, 300) : String(error ?? '未知原因').slice(0, 300);
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO doc_navigation_state
           (document_id, enabled, built_at, source_hash, node_count, file_stamp, mask_revision, build_state, error)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'failed', ?)`
        )
        .run(documentId, enabled, '', sourceHash, stamp, this.pageMaskRevision(documentId), message);
    } catch {
      // 状态写失败不能盖住原始错误；调用方仍会拿到失败原因。
    }
  }

  private storeNavigation(
    documentId: string,
    nodes: Array<{ page: number; kind: string; label: string }>,
    stamp: string,
    sourceHash: string
  ): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT enabled FROM doc_navigation_state WHERE document_id = ?')
      .get(documentId) as unknown as { enabled: number } | undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM doc_navigation WHERE document_id = ?').run(documentId);
      const insert = this.db.prepare(
        'INSERT INTO doc_navigation(document_id, page, kind, label) VALUES (?, ?, ?, ?)'
      );
      for (const node of nodes) insert.run(documentId, node.page, node.kind, node.label);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO doc_navigation_state
           (document_id, enabled, built_at, source_hash, node_count, file_stamp, mask_revision, build_state, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', '')`
        )
        .run(
          documentId,
          existing?.enabled ?? 0,
          now,
          sourceHash,
          nodes.length,
          stamp,
          this.pageMaskRevision(documentId)
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setNavigationEnabled(documentId: string, enabled: boolean): NavigationStatus {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const row = this.db
      .prepare('SELECT document_id FROM doc_navigation_state WHERE document_id = ?')
      .get(documentId);
    if (row) {
      this.db
        .prepare('UPDATE doc_navigation_state SET enabled = ? WHERE document_id = ?')
        .run(enabled ? 1 : 0, documentId);
    } else {
      this.db
        .prepare(
          `INSERT INTO doc_navigation_state
           (document_id, enabled, build_state, error) VALUES (?, ?, 'missing', '')`
        )
        .run(documentId, enabled ? 1 : 0);
    }
    return this.navigationStatus(documentId);
  }

  /**
   * 规划可用的目录节点：**只有 ready 且 enabled** 才给。
   * 未启用/未生成/过期/生成中/失败一律返回空——调用方据此回退逐页读取。
   */
  planningNavigation(documentId: string): NavigationNode[] {
    const status = this.navigationStatus(documentId);
    if (status.state !== 'ready' || !status.enabled) return [];
    // 真正被规划使用时记一次 last_used，
    // 让用户能看出"这个目录上次被用是什么时候"。
    this.db
      .prepare('UPDATE doc_navigation_state SET last_used = ? WHERE document_id = ?')
      .run(new Date().toISOString(), documentId);
    return this.listNavigation(documentId).slice(0, NAV_PLANNING_LIMIT);
  }

  /** 规划上下文里的 navigation 字段；enabled=False 时必有 reason（对齐 planning_view）。 */
  navigationPlanningView(documentId: string): NavigationPlanningView {
    const status = this.navigationStatus(documentId);
    if (status.state === 'ready' && status.enabled) {
      return {
        enabled: true,
        state: status.state,
        nodes: this.planningNavigation(documentId)
      };
    }
    return {
      enabled: false,
      state: status.state,
      nodes: [],
      reason: navigationReason(status)
    };
  }

  private async buildNavigationNow(
    documentId: string,
    stamp: string,
    sourceHash: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const documentPath = this.getDocumentPath(documentId);
    if (!documentPath) throw new Error('PDF 副本不存在');
    const masks = this.listPageMasks(documentId);
    const layout = this.mergeOcrLayout(
      documentId,
      await extractPdfLayout(readFileSync(documentPath), onProgress)
    );
    const tocPages = this.getNavigationTocPages(documentId);
    if (tocPages.length > 0) {
      // 用户指定了目录页：只信这张印刷目录，不再用标题规则猜。
      const blocks = recognizeBlocks(layout, masks, { documentId, tocPages });
      const document = this.getDocument(documentId);
      const result = tocNavigation(
        layout,
        masks,
        tocPages,
        document?.pages ?? layout.pages.length,
        blocks
      );
      if (result.nodes.length === 0) {
        throw new Error(
          `目录页（第 ${tocPages.join('、')} 页）没有解析出可用目录条目：${
            result.warnings.join('；') || '请检查目录页范围'
          }`
        );
      }
      this.storeNavigation(documentId, result.nodes, stamp, sourceHash);
      return;
    }
    const nodes = navigationNodes(layout, masks);
    if (nodes.length === 0) {
      // 标题规则一条都没有：最后再试"文献自带的印刷目录"。
      // 很多书没有 PDF 书签，但正文前印了一张目录页；自动认出来后就能直接建导航，
      // 不必要求用户手工指定目录页（那条路实际上没人会走）。
      const detected = detectTocPages(layout, masks, layout.pages.length);
      if (detected.length > 0) {
        const tocBlocks = recognizeBlocks(layout, masks, { documentId, tocPages: detected });
        const tocResult = tocNavigation(
          layout,
          masks,
          detected,
          this.getDocument(documentId)?.pages ?? layout.pages.length,
          tocBlocks
        );
        if (tocResult.nodes.length > 0) {
          this.storeNavigation(documentId, tocResult.nodes, stamp, sourceHash);
          return;
        }
      }
      // 0 条目录不能当"生成成功"落库：否则界面只会关掉弹窗、什么都不显示，
      // 看起来像点击没反应（用户报告 5）。这里抛明确错误，让 buildError 能显示，
      // 也避免用空目录覆盖用户已有的本地目录。
      const rawText = layout.pages.some((page) =>
        page.lines.some((line) => line.text.trim().length > 0)
      );
      const visibleText =
        rawText &&
        layout.pages.some((page) =>
          visibleLines(page, masks).some((line) => line.text.trim().length > 0)
        );
      throw new Error(
        !rawText
          ? '按标题规则没有识别到任何目录条目：这篇 PDF 没有可解析的文字层（可能是扫描件）。请先在页面识别里 OCR 出文字，或改用「按目录页生成」，或手动添加目录。'
          : !visibleText
            ? '按标题规则没有识别到任何目录条目：当前「无关区域」规则遮住了全篇文字。请先检查或清除无关区域规则，再重新生成目录。'
            : '按标题规则没有识别到任何目录条目：这篇 PDF 没有明显的章节标题字号/编号规律。请改用「按目录页生成」，或手动添加目录。'
      );
    }
    this.storeNavigation(documentId, nodes, stamp, sourceHash);
  }

  async buildNavigation(
    documentId: string,
    rebuild = false,
    options: { tocPages?: number[] } = {}
  ): Promise<NavigationStatus> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    // 先落目录页设置，再算 sourceHash：设置变化会让旧目录变成 stale 并被重建。
    if (Array.isArray(options.tocPages)) {
      this.setNavigationTocPages(documentId, options.tocPages);
    }
    const { stamp, sourceHash } = this.navigationStamp(documentId);
    if (!stamp) throw new Error('PDF 副本不存在');
    const current = this.navigationStatus(documentId);
    if (!rebuild && current.state === 'ready' && current.sourceHash === sourceHash) {
      return current;
    }
    const syncLimit = Number(process.env.STUDIANDA_NAV_SYNC_LIMIT ?? NAV_SYNC_LIMIT);
    if (document.pages > syncLimit) {
      if (navigationJobs.get(documentId)?.state === 'building') return this.navigationStatus(documentId);
      navigationJobs.set(documentId, {
        state: 'building',
        done: 0,
        total: document.pages
      });
      void (async () => {
        try {
          await this.buildNavigationNow(documentId, stamp, sourceHash, (done, total) => {
            const job = navigationJobs.get(documentId);
            if (job?.state === 'building') navigationJobs.set(documentId, { ...job, done, total });
          });
          navigationJobs.set(documentId, { state: 'done', done: document.pages, total: document.pages });
        } catch (error) {
          navigationJobs.set(documentId, {
            state: 'failed',
            done: 0,
            total: document.pages,
            error
          });
          this.markNavigationFailed(documentId, sourceHash, stamp, error);
        }
      })();
      return this.navigationStatus(documentId);
    }
    try {
      await this.buildNavigationNow(documentId, stamp, sourceHash, (done, total) => {
        navigationJobs.set(documentId, { state: 'building', done, total });
      });
      navigationJobs.delete(documentId);
    } catch (error) {
      navigationJobs.set(documentId, {
        state: 'failed',
        done: 0,
        total: document.pages,
        error
      });
      // 同步生成失败也要落 build_state='failed'，否则刷新后状态回到"未生成"，看不到原因。
      this.markNavigationFailed(documentId, sourceHash, stamp, error);
      throw error;
    }
    return this.navigationStatus(documentId);
  }

  deleteNavigation(documentId: string): void {
    this.db.prepare('DELETE FROM doc_navigation WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM doc_navigation_state WHERE document_id = ?').run(documentId);
    navigationJobs.delete(documentId);
  }

  private mergeOcrLayout(documentId: string, layout: PdfLayout): PdfLayout {
    // 不原地改缓存：按当前 page_edits 生成合并后的视图，缓存里始终是原始文本层。
    return {
      ...layout,
      pages: layout.pages.map((page) => {
        if (page.lines.some((line) => line.text.trim())) return page;
        const ocr = this.ocrLayoutPage(documentId, page.page);
        if (ocr.lines.length === 0) return page;
        return { ...page, lines: ocr.lines, width: ocr.width, height: ocr.height };
      })
    };
  }

  private async readLayout(documentId: string) {
    const documentPath = this.getDocumentPath(documentId);
    if (!documentPath) throw new Error('PDF 副本不存在');
    let stats;
    try {
      stats = statSync(documentPath);
    } catch {
      throw new Error('PDF 副本不存在');
    }
    const stamp = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
    let cached = this.layoutCache.get(documentPath);
    if (!cached || cached.stamp !== stamp) {
      // 先查持久化的页版面（跨重启复用）；没有再解析 PDF 并写回。
      const stored = this.loadStoredLayout(documentId, documentPath, stamp);
      if (stored) {
        cached = { stamp, layout: stored };
      } else {
        cached = { stamp, layout: await extractPdfLayout(readFileSync(documentPath)) };
        this.storeLayoutPages(documentPath, stamp, cached.layout);
      }
      if (this.layoutCache.size >= 8) {
        const oldest = this.layoutCache.keys().next().value;
        if (oldest !== undefined) this.layoutCache.delete(oldest);
      }
      this.layoutCache.set(documentPath, cached);
    }
    return this.mergeOcrLayout(documentId, cached.layout);
  }

  /** 从 structure_pages 读回整篇版面；版本不一致/缺页时返回 null 重新解析。 */
  private loadStoredLayout(
    documentId: string,
    documentPath: string,
    stamp: string
  ): PdfLayout | null {
    try {
      const document = this.getDocument(documentId);
      if (!document) return null;
      const rows = this.db
        .prepare('SELECT page, value FROM structure_pages WHERE path = ?')
        .all(documentPath) as unknown as Array<{ page: number; value: string }>;
      if (rows.length < document.pages) return null;
      const byPage = new Map<number, string>();
      for (const row of rows) byPage.set(Number(row.page), row.value);
      const metaRaw = byPage.get(0);
      if (!metaRaw) return null;
      const meta = JSON.parse(metaRaw) as {
        version?: string;
        author?: string;
        outline?: OutlineEntry[];
      };
      if (meta.version !== stamp) return null;
      const pages: LayoutPage[] = [];
      for (let page = 1; page <= document.pages; page += 1) {
        const raw = byPage.get(page);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { version?: string; page?: LayoutPage };
        if (parsed.version !== stamp || !parsed.page) return null;
        pages.push(parsed.page);
      }
      return { pages, author: meta.author ?? '', outline: meta.outline ?? [] };
    } catch {
      return null;
    }
  }

  private storeLayoutPages(documentPath: string, stamp: string, layout: PdfLayout): void {
    try {
      const statement = this.db.prepare(
        'INSERT OR REPLACE INTO structure_pages(path, page, version, value) VALUES (?, ?, ?, ?)'
      );
      this.db.exec('BEGIN IMMEDIATE');
      try {
        statement.run(
          documentPath,
          0,
          stamp,
          JSON.stringify({
            version: stamp,
            author: layout.author,
            outline: layout.outline
          })
        );
        for (const page of layout.pages) {
          statement.run(documentPath, page.page, stamp, JSON.stringify({ version: stamp, page }));
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch {
      // 版面缓存是加速项：写失败不影响本次解析结果。
    }
  }

  /** 整篇版面（页数据接口用）：文档不存在返回 null；PDF 副本缺失时抛错由调用方转 404。 */
  async getPageLayout(documentId: string): Promise<PdfLayout | null>;
  /** 单页版面（阅读/翻译链路既有用法）：页码不存在时抛"页码超出范围"。 */
  async getPageLayout(documentId: string, page: number): Promise<LayoutPage>;
  async getPageLayout(
    documentId: string,
    page?: number
  ): Promise<PdfLayout | LayoutPage | null> {
    if (page === undefined) {
      if (!this.getDocument(documentId)) return null;
      return this.readLayout(documentId);
    }
    const layout = await this.readLayout(documentId);
    const target = layout.pages.find((item) => item.page === page);
    if (!target) throw new Error('页码超出范围');
    return target;
  }

  /**
   * 摘引定位（详细结果）：先查记录页；记录页没有时按由近到远的页序
   * 在**已有文本层/OCR 缓存**里找（最多 60 页，不含自身），
   * 绝不在这里触发新的整页识别。找不到就如实返回 method='none'，不猜位置。
   */
  async locateCitationEx(
    documentId: string,
    page: number,
    quote: string
  ): Promise<QuoteLocation> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    if (!Number.isInteger(page) || page < 1 || page > document.pages) {
      throw new Error('页码超出范围');
    }
    const layout = await this.readLayout(documentId);
    const masks = this.listPageMasks(documentId);
    const primary = this.locateCitationOnPage(documentId, layout, page, quote, masks);
    if (primary.boxes.length > 0) {
      return {
        boxes: primary.boxes,
        page,
        method: primary.method,
        corrected: false,
        message:
          primary.method === 'ocr'
            ? '已定位到该页识别出的对应文字区域。'
            : '已定位到该页文本层的对应文字。'
      };
    }
    for (const candidate of searchOrder(page, document.pages)) {
      const found = this.locateCitationOnPage(documentId, layout, candidate, quote, masks);
      if (found.boxes.length > 0) {
        return {
          boxes: found.boxes,
          page: candidate,
          method: found.method,
          corrected: true,
          message: `这段文字实际在第 ${candidate} 页（记录为第 ${page} 页），已按实际位置定位。`
        };
      }
    }
    return {
      boxes: [],
      page,
      method: 'none',
      corrected: false,
      message:
        '这一页和全文都没有找到这段文字：它可能来自模型的转述、图表解读，或该页文字已被你校订改写。'
    };
  }

  /** 兼容旧调用方（zotero 迁移、既有测试）：只返回命中框。 */
  async locateCitation(
    documentId: string,
    page: number,
    quote: string
  ): Promise<LocatedQuote[]> {
    return (await this.locateCitationEx(documentId, page, quote)).boxes;
  }

  private locateCitationOnPage(
    documentId: string,
    layout: PdfLayout,
    page: number,
    quote: string,
    masks: PageMask[]
  ): { boxes: LocatedQuote[]; method: 'text_layer' | 'ocr' } {
    const target = layout.pages.find((item) => item.page === page);
    if (!target) return { boxes: [], method: 'text_layer' };
    // readLayout 已把"扫描页已保存的 OCR 行框"并入该页 lines，因此这里无需再 OCR。
    const method = this.getPageEdit(documentId, page)?.origin === 'ocr' ? 'ocr' : 'text_layer';
    const native = locateQuoteOnPage(target, quote, masks);
    if (native.length > 0) return { boxes: native, method };
    // 页面文本经过段落复原后与 PDF 原始行的顺序可能不同，整段引文不一定连续：
    // 用句子级片段再定位一次，返回第一个能落到原文行的片段。
    for (const fragment of this.citationFragments(quote)) {
      const located = locateQuoteOnPage(target, fragment, masks);
      if (located.length > 0) return { boxes: located, method };
    }
    // 旧文档的布局缓存可能为空，但 chunks 里保留了每行 bbox；直接用它们定位。
    const byChunks = this.locateCitationInChunks(
      documentId,
      page,
      quote,
      target.width,
      target.height
    );
    if (byChunks.length > 0) return { boxes: byChunks, method: 'text_layer' };
    // 扫描页没有 PDF 文本层：用已保存的 OCR 行框兜底，引用/批注仍能落到具体区域。
    const ocr = locateQuoteOnPage(this.ocrLayoutPage(documentId, page), quote, masks);
    if (ocr.length > 0) return { boxes: ocr, method: 'ocr' };
    return { boxes: [], method };
  }

  /** 长引文的句子级片段（固定切分与长度门槛）。 */
  private citationFragments(quote: string): string[] {
    return quote
      .split(/[。！？；\n]/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 12)
      .slice(0, 12);
  }

  private locateCitationInChunks(
    documentId: string,
    page: number,
    quote: string,
    width: number,
    height: number
  ): LocatedQuote[] {
    const rows = this.db
      .prepare('SELECT text, bbox FROM chunks WHERE document_id = ? AND page = ? ORDER BY rowid')
      .all(documentId, page) as unknown as Array<{ text: string; bbox: string }>;
    if (rows.length === 0 || !width || !height) return [];
    const lines: LayoutLine[] = [];
    for (const row of rows) {
      try {
        const box = JSON.parse(row.bbox) as number[];
        if (box.length !== 4) continue;
        lines.push({
          text: String(row.text ?? ''),
          bbox: [
            box[0]! / width,
            box[1]! / height,
            box[2]! / width,
            box[3]! / height
          ],
          size: 0
        });
      } catch {
        // 损坏的 bbox 不影响其他行
      }
    }
    if (lines.length === 0) return [];
    const pageText = lines.map((line) => line.text).join('\n');
    const direct = locateQuote(pageText, quote, lines);
    if (direct.length > 0) return direct;
    for (const fragment of this.citationFragments(quote)) {
      const located = locateQuote(pageText, fragment, lines);
      if (located.length > 0) return located;
    }
    return [];
  }

  private ocrLayoutPage(documentId: string, page: number): LayoutPage {
    const saved = this.getPageEdit(documentId, page);
    let lines: LayoutLine[] = [];
    if (saved?.boxes) {
      try {
        const parsed = JSON.parse(saved.boxes) as Array<{
          text?: string;
          bbox?: number[];
        }>;
        if (Array.isArray(parsed)) {
          lines = parsed
            .filter(
              (row) =>
                typeof row.text === 'string' &&
                Array.isArray(row.bbox) &&
                row.bbox.length === 4
            )
            .map((row) => ({
              text: row.text as string,
              bbox: row.bbox as [number, number, number, number]
            }));
        }
      } catch {
        lines = [];
      }
    }
    return { page, width: 1, height: 1, lines };
  }

  async getVisualNodes(
    documentId: string
  ): Promise<ReturnType<typeof visualNodes>> {
    const info = this.structureStamp(documentId);
    if (info) {
      const cached = this.readStructureCache(documentId, info.stamp);
      if (cached && Array.isArray(cached.visual_nodes)) {
        return cached.visual_nodes as ReturnType<typeof visualNodes>;
      }
    }
    const layout = await this.readLayout(documentId);
    const nodes = visualNodes(layout, this.listPageMasks(documentId));
    this.writeStructureCache(documentId, info, { visual_nodes: nodes });
    return nodes;
  }

  async getStructure(
    documentId: string
  ): Promise<ReturnType<typeof documentStructure>> {
    const info = this.structureStamp(documentId);
    if (info) {
      const cached = this.readStructureCache(documentId, info.stamp);
      if (cached && Array.isArray(cached.sections)) {
        return cached.sections as ReturnType<typeof documentStructure>;
      }
    }
    const layout = await this.readLayout(documentId);
    const sections = documentStructure(layout, this.listPageMasks(documentId));
    this.writeStructureCache(documentId, info, { sections });
    return sections;
  }

  /**
   * 识别整篇文献的内容块与章节（版面粒度：段落/标题/列表/题注/公式/脚注/参考文献）。
   *
   * 与 `getStructure`（只到"标题在哪一页"）不同：这里给出每块的文字、bbox、所属章节，
   * 用于引用锚定、章节级问答索引与界面结构视图。结果**不是**新的原文证据：
   * 块文字就是版面上的同一段文字。
   */
  async getDocumentBlocks(documentId: string): Promise<DocumentBlocks> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const info = this.structureStamp(documentId);
    const cached = this.blocksCache.get(documentId);
    if (cached && info && cached.stamp === info.stamp) return cached.blocks;
    const layout = await this.readLayout(documentId);
    const tocPages = detectTocPages(layout, this.listPageMasks(documentId), document.pages);
    const blocks = recognizeBlocks(layout, this.listPageMasks(documentId), {
      documentId,
      title: document.name,
      tocPages
    });
    if (info) {
      if (this.blocksCache.size >= 8) {
        const oldest = this.blocksCache.keys().next().value;
        if (oldest !== undefined) this.blocksCache.delete(oldest);
      }
      this.blocksCache.set(documentId, { stamp: info.stamp, blocks });
    }
    return blocks;
  }

  /**
   * 只读已就绪的内容块缓存（不做 PDF 解析）。
   *
   * 检索结果/来源列表需要"命中在哪一节"时用它：没识别过就返回 null，调用方缺省处理，
   * 不为了展示元数据去解析整篇 PDF、拖慢搜索。需要识别时用 `getDocumentBlocks`。
   */
  peekDocumentBlocks(documentId: string): DocumentBlocks | null {
    const info = this.structureStamp(documentId);
    const cached = this.blocksCache.get(documentId);
    if (!cached || !info || cached.stamp !== info.stamp) return null;
    return cached.blocks;
  }

  /**
   * 章节级问答索引片段（带章节标题、起止页）；纯派生索引材料，不作原文证据。
   *
   * 结果按「结构版本 + maxChars + overlap」缓存：这是从已识别内容块派生的纯函数，
   * 同一篇文献反复请求（界面翻索引、导出、测试）不该每次都重新拼几 MB 字符串。
   * 结构一变（重解析/编辑页）`structureStamp` 变化，旧缓存自然失效。
   */
  async getSectionIndex(
    documentId: string,
    options: SectionIndexOptions = {}
  ): Promise<DocumentSectionIndex> {
    const blocks = await this.getDocumentBlocks(documentId);
    const stamp = this.structureStamp(documentId)?.stamp ?? '';
    const key = `${documentId}\u0000${stamp}\u0000${options.maxChars ?? ''}\u0000${options.overlap ?? ''}`;
    const cached = this.sectionIndexCache.get(key);
    if (cached) return cached;
    const index = sectionIndexChunks(documentId, blocks, options);
    if (this.sectionIndexCache.size >= 16) {
      const oldest = this.sectionIndexCache.keys().next().value;
      if (oldest !== undefined) this.sectionIndexCache.delete(oldest);
    }
    this.sectionIndexCache.set(key, index);
    return index;
  }

  /**
   * 参考文献识别（文末列表 + 页面底部脚注式引用）与页面内引用标记。
   *
   * 结果是结构化识别，不是新的原文证据：条目文字就是版面上的同一段文字；
   * 作者/年份/标题等字段是尽力解析（解析不出就留空）。用户编辑（修改/删除/新增）
   * 以覆盖层方式套用，识别版本变化后旧编辑会失效并在 `stats.staleEdits` 里如实计数。
   */
  async getDocumentReferences(documentId: string): Promise<DocumentReferences> {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const blocks = await this.getDocumentBlocks(documentId);
    const version = this.structureStamp(documentId)?.stamp ?? '';
    const recognized = recognizeReferences(documentId, blocks, version);
    const edits = this.listReferenceEdits(documentId);
    return applyReferenceEdits(recognized, edits, version);
  }

  /** 读取某文献的用户参考文献编辑记录（持久化在 reference_edits）。 */
  listReferenceEdits(documentId: string): ReferenceEditRecord[] {
    const rows = this.db
      .prepare('SELECT entry_id, kind, value FROM reference_edits WHERE document_id = ? ORDER BY entry_id')
      .all(documentId) as unknown as Array<{ entry_id: string; kind: string; value: string }>;
    const result: ReferenceEditRecord[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as {
          stamp?: string;
          patch?: ReferenceEntryInput;
          entry?: ReferenceEntryInput;
        };
        const kind = row.kind === 'add' || row.kind === 'delete' ? row.kind : 'override';
        result.push({
          entryId: row.entry_id,
          kind,
          stamp: String(parsed.stamp ?? ''),
          ...(parsed.patch ? { patch: parsed.patch } : {}),
          ...(parsed.entry ? { entry: parsed.entry } : {})
        });
      } catch {
        // 损坏的编辑记录跳过，不影响识别结果。
      }
    }
    return result;
  }

  private upsertReferenceEdit(
    documentId: string,
    entryId: string,
    kind: 'override' | 'add' | 'delete',
    value: { stamp: string; patch?: ReferenceEntryInput; entry?: ReferenceEntryInput }
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reference_edits(document_id, entry_id, kind, value, updated)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(documentId, entryId, kind, JSON.stringify(value));
  }

  private referenceEditStamp(documentId: string): string {
    return this.structureStamp(documentId)?.stamp ?? '';
  }

  /** 修改一条识别条目（或手动条目）的字段；返回套用编辑后的完整参考文献结果。 */
  async updateReferenceEntry(
    documentId: string,
    entryId: string,
    patch: ReferenceEntryInput
  ): Promise<DocumentReferences> {
    if (!this.getDocument(documentId)) throw new Error('文档不存在');
    const current = await this.getDocumentReferences(documentId);
    if (!current.entries.some((entry) => entry.id === entryId)) {
      throw new Error('参考文献条目不存在（可能已因重新识别失效）');
    }
    const clean = sanitizeReferenceInput(patch);
    const stamp = this.referenceEditStamp(documentId);
    if (entryId.startsWith('u')) {
      // 手动条目：把修改合并进 add 记录里的 entry。
      const existing = this.listReferenceEdits(documentId).find(
        (edit) => edit.entryId === entryId && edit.kind === 'add'
      );
      const merged: ReferenceEntryInput = { ...(existing?.entry ?? {}), ...clean };
      this.upsertReferenceEdit(documentId, entryId, 'add', { stamp, entry: merged });
    } else {
      const existing = this.listReferenceEdits(documentId).find(
        (edit) => edit.entryId === entryId && edit.kind === 'override'
      );
      const merged: ReferenceEntryInput = { ...(existing?.patch ?? {}), ...clean };
      this.upsertReferenceEdit(documentId, entryId, 'override', { stamp, patch: merged });
    }
    return this.getDocumentReferences(documentId);
  }

  /** 删除一条条目：识别条目隐藏（可重置恢复），手动条目直接移除。 */
  async deleteReferenceEntry(documentId: string, entryId: string): Promise<DocumentReferences> {
    if (!this.getDocument(documentId)) throw new Error('文档不存在');
    if (entryId.startsWith('u')) {
      this.db
        .prepare('DELETE FROM reference_edits WHERE document_id = ? AND entry_id = ?')
        .run(documentId, entryId);
    } else {
      this.upsertReferenceEdit(documentId, entryId, 'delete', {
        stamp: this.referenceEditStamp(documentId)
      });
    }
    return this.getDocumentReferences(documentId);
  }

  /** 手动新增一条参考文献条目（id 以 u 开头），返回套用后的完整结果。 */
  async addReferenceEntry(
    documentId: string,
    input: ReferenceEntryInput
  ): Promise<DocumentReferences> {
    if (!this.getDocument(documentId)) throw new Error('文档不存在');
    const clean = sanitizeReferenceInput(input);
    if (!clean.raw && !clean.title) throw new Error('新增条目需要条目文字或标题');
    const entryId = `u${randomUUID()}`;
    this.upsertReferenceEdit(documentId, entryId, 'add', {
      stamp: this.referenceEditStamp(documentId),
      entry: clean
    });
    return this.getDocumentReferences(documentId);
  }

  /** 清空该文献的全部参考文献编辑，恢复自动识别结果。 */
  async resetReferenceEdits(documentId: string): Promise<DocumentReferences> {
    if (!this.getDocument(documentId)) throw new Error('文档不存在');
    this.db.prepare('DELETE FROM reference_edits WHERE document_id = ?').run(documentId);
    return this.getDocumentReferences(documentId);
  }

  /** 把视觉读页的派生解读写入结构缓存（semantic_nodes），供派生检索使用。 */
  addStructureSemantic(documentId: string, page: number, description: string): void {
    const text = String(description ?? '').trim();
    if (!text) return;
    const info = this.structureStamp(documentId);
    if (!info) return;
    const existing = this.readStructureCache(documentId, info.stamp) ?? {};
    const semantics = Array.isArray(existing.semantic_nodes)
      ? [...(existing.semantic_nodes as Array<Record<string, unknown>>)]
      : [];
    if (
      semantics.some(
        (node) =>
          Number(node.page) === Math.trunc(page) &&
          String(node.description ?? '') === text
      )
    ) {
      return;
    }
    semantics.push({
      page: Math.max(1, Math.trunc(page)),
      description: text.slice(0, 4000),
      derived: true
    });
    this.writeStructureCache(documentId, info, { semantic_nodes: semantics });
  }

  /** 结构缓存版本：文献路径 + 文件大小/mtime + 页遮罩版本；任一变化后自然失效。 */
  private structureStamp(documentId: string): { path: string; stamp: string } | null {
    const documentPath = this.getDocumentPath(documentId);
    if (!documentPath) return null;
    try {
      const stats = statSync(documentPath);
      return {
        path: documentPath,
        stamp: `${stats.size}:${Math.trunc(stats.mtimeMs)}:${this.pageMaskRevision(documentId)}`
      };
    } catch {
      return null;
    }
  }

  private readStructureCache(
    documentId: string,
    stamp: string
  ): {
    sections?: unknown[];
    visual_nodes?: unknown[];
    semantic_nodes?: unknown[];
  } | null {
    try {
      const row = this.db
        .prepare('SELECT version, value FROM structures WHERE document = ?')
        .get(documentId) as { version?: string; value?: string } | undefined;
      if (!row || row.version !== stamp || !row.value) return null;
      return JSON.parse(row.value) as {
        sections?: unknown[];
        visual_nodes?: unknown[];
        semantic_nodes?: unknown[];
      };
    } catch {
      return null;
    }
  }

  private writeStructureCache(
    documentId: string,
    info: { path: string; stamp: string } | null,
    patch: {
      sections?: unknown[];
      visual_nodes?: unknown[];
      semantic_nodes?: unknown[];
    }
  ): void {
    if (!info) return;
    try {
      const existing = this.readStructureCache(documentId, info.stamp) ?? {};
      const value = {
        ...existing,
        ...patch,
        generated_at: new Date().toISOString()
      };
      this.db
        .prepare('INSERT OR REPLACE INTO structures(document, path, version, value) VALUES (?, ?, ?, ?)')
        .run(documentId, info.path, info.stamp, JSON.stringify(value));
    } catch {
      // 结构缓存是加速项：写失败不影响读取。
    }
  }

  /**
   * 读取一页文本（精读热路径：单页已索引查询 + 行重排，不缓存、不额外扫描）。
   * 实现与 page_edits / page_masks 合并语义见 store/documents.ts 的 getPageText。
   */
  getPageText(documentId: string, page: number): string {
    return documentDomain.getPageText(this.db, this.documentDomainDeps, documentId, page);
  }

  /**
   * 落一条**不可变**的选区快照（用户带选中原文提问时调用）。
   *
   * - `text` 保留用户选中的原文（首尾裁剪）；比较时再做空白归一化，避免 OCR 换行差异误判；
   * - `page` 优先用调用方给的当前页，页文本对不上时再按页找一次（用户可能翻页后提问）；
   * - `revision` 是提问时该页文本的 sha256：OCR 重跑/页校订改写后 revision 必变，
   *   同一选区会落成新快照，旧快照原样保留（不 UPDATE）。
   *
   * 同一 (document, text_hash, revision) 幂等：重复提问不会重复落行。
   * 文献不存在/选区为空时返回 null（调用方按“无快照”处理，不影响回答）。
   */
  saveSelectionSnapshot(input: {
    documentId: string;
    text: string;
    page?: number;
    question?: string;
  }): SelectionSnapshotRecord | null {
    const document = this.getDocument(input.documentId);
    const text = String(input.text ?? '').trim();
    if (!document || !normalizeSnapshotText(text)) return null;
    const page = this.resolveSelectionSnapshotPage(document.id, text, input.page, document.pages);
    const revision = page > 0 ? pageTextRevision(this.getPageText(document.id, page)) : '';
    const textHash = snapshotTextHash(text);
    const existing = this.db
      .prepare(
        `SELECT id, document_id, page, text, text_hash, revision, question, created
         FROM selection_snapshots
         WHERE document_id = ? AND text_hash = ? AND revision = ?`
      )
      .get(document.id, textHash, revision) as unknown as SelectionSnapshotRow | undefined;
    if (existing) return toSelectionSnapshot(existing);
    const record: SelectionSnapshotRecord = {
      id: randomUUID(),
      documentId: document.id,
      page,
      text,
      textHash,
      revision,
      question: String(input.question ?? '').trim(),
      created: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO selection_snapshots
           (id, document_id, page, text, text_hash, revision, question, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.documentId,
        record.page,
        record.text,
        record.textHash,
        record.revision,
        record.question,
        record.created
      );
    // 并发插入同一条快照时以库里的为准（INSERT OR IGNORE 之后回查一次）。
    const stored = this.db
      .prepare(
        `SELECT id, document_id, page, text, text_hash, revision, question, created
         FROM selection_snapshots
         WHERE document_id = ? AND text_hash = ? AND revision = ?`
      )
      .get(document.id, textHash, revision) as unknown as SelectionSnapshotRow | undefined;
    return stored ? toSelectionSnapshot(stored) : record;
  }

  /** 选区快照定位到的页码：优先调用方给的页；该页文本不含选区时再逐页找一遍。 */
  private resolveSelectionSnapshotPage(
    documentId: string,
    normalizedText: string,
    preferredPage: number | undefined,
    totalPages: number
  ): number {
    const preferred =
      typeof preferredPage === 'number' &&
      Number.isInteger(preferredPage) &&
      preferredPage >= 1 &&
      preferredPage <= totalPages
        ? preferredPage
        : 0;
    if (preferred > 0 && snapshotStillPresent(normalizedText, this.getPageText(documentId, preferred))) {
      return preferred;
    }
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (pageNumber === preferred) continue;
      if (snapshotStillPresent(normalizedText, this.getPageText(documentId, pageNumber))) {
        return pageNumber;
      }
    }
    // 找不到（例如选区跨页）：保留调用方给的页号，revision 记当时的页文本。
    return preferred;
  }

  /** 某文献最近的选区快照（新的在前）；供审计/界面溯源。 */
  listSelectionSnapshots(documentId: string, limit = 20): SelectionSnapshotRecord[] {
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 20;
    const rows = this.db
      .prepare(
        `SELECT id, document_id, page, text, text_hash, revision, question, created
         FROM selection_snapshots WHERE document_id = ?
         ORDER BY created DESC, rowid DESC LIMIT ?`
      )
      .all(documentId, safeLimit) as unknown as SelectionSnapshotRow[];
    return rows.map(toSelectionSnapshot);
  }

  /**
   * 快照相对**当前**页文本的状态：`current` 命中、`source_changed` 原文已变更、
   * `unknown` 快照没有页号。同时返回当前页文本，供归因逻辑判断“缺证”是否为原文变化所致。
   */
  selectionSnapshotEvidence(snapshot: Pick<SelectionSnapshotRecord, 'text' | 'page' | 'documentId'>): {
    status: SelectionSnapshotStatus;
    currentPageText: string | null;
  } {
    if (!snapshot.page || snapshot.page <= 0) {
      return { status: 'unknown', currentPageText: null };
    }
    const currentPageText = this.getPageText(snapshot.documentId, snapshot.page);
    return {
      status: selectionSnapshotStatus(snapshot, currentPageText),
      currentPageText
    };
  }


  /** 读取某页的 page_edits（校订/OCR 结果，含 sha256 版本校验）；语义见 store/documents.ts。 */
  getPageEdit(
    documentId: string,
    page: number
  ): { text: string; origin: string; boxes: string; version: string } | null {
    return documentDomain.getPageEdit(this.db, this.documentDomainDeps, documentId, page);
  }

  /**
   * 保存用户校订的页文本（page_edits）并同步该页检索索引。
   * 事务/顺序与 db.isOpen 检查见 store/documents.ts 的 savePageTextEdit。
   */
  async savePageTextEdit(
    documentId: string,
    page: number,
    text: string
  ): Promise<{ text: string; origin: string; boxes: string }> {
    return documentDomain.savePageTextEdit(
      this.db,
      this.documentDomainDeps,
      documentId,
      page,
      text
    );
  }

  /** 用页文本重建该页 chunks（含 FTS 行号），按删除+重写的口径。 */
  private rebuildPageChunks(
    documentId: string,
    page: number,
    text: string,
    boxesJson: string,
    layoutPage?: LayoutPage
  ): void {
    const chunks = this.pageEditChunks(text, boxesJson, layoutPage);
    const old = this.db
      .prepare('SELECT rowid AS rowid FROM chunks WHERE document_id = ? AND page = ?')
      .all(documentId, page) as unknown as Array<{ rowid: number }>;
    const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    const deleteChunk = this.db.prepare(
      'DELETE FROM chunks WHERE document_id = ? AND page = ? AND rowid = ?'
    );
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks(id, document_id, page, text, bbox, bbox_space)
       VALUES (?, ?, ?, ?, ?, 'visual')`
    );
    const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of old) {
        deleteFts.run(row.rowid);
        deleteChunk.run(documentId, page, row.rowid);
      }
      for (const chunk of chunks) {
        const chunkId = `${documentId}:${page}:${randomUUID()}`;
        const result = insertChunk.run(chunkId, documentId, page, chunk.text, chunk.bbox);
        insertFts.run(Number(result.lastInsertRowid), chunk.text);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 校订文本 → chunk 列表。
   * 有 OCR 行框时按行切块（1000 步长 / 1200 窗口）并写回页面点坐标；
   * 没有行框时按 1600 字平铺、bbox='null'（遮罩重建不会删掉它）。
   */
  private pageEditChunks(
    text: string,
    boxesJson: string,
    layoutPage?: LayoutPage
  ): Array<{ text: string; bbox: string }> {
    const boxes = parsePageEditBoxes(boxesJson);
    if (boxes.length > 0) {
      const chunks: Array<{ text: string; bbox: string }> = [];
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').trim();
        if (!line) continue;
        const box = boxes[index]?.bbox;
        const bbox = box && layoutPage
          ? JSON.stringify([
              box[0] * layoutPage.width,
              box[1] * layoutPage.height,
              box[2] * layoutPage.width,
              box[3] * layoutPage.height
            ])
          : 'null';
        for (let start = 0; start < line.length; start += 1000) {
          chunks.push({ text: line.slice(start, start + 1200), bbox });
        }
      }
      if (chunks.length > 0) return chunks;
    }
    const flat: Array<{ text: string; bbox: string }> = [];
    for (let start = 0; start < text.length; start += 1600) {
      const piece = text.slice(start, start + 1600);
      if (piece) flat.push({ text: piece, bbox: 'null' });
    }
    return flat;
  }

  /** 缓存整页 OCR 结果（page_edits，origin='ocr'）；语义见 store/documents.ts。 */
  cacheOcrPage(
    documentId: string,
    page: number,
    text: string,
    boxes: unknown[]
  ): void {
    documentDomain.cacheOcrPage(this.db, this.documentDomainDeps, documentId, page, text, boxes);
  }

  /**
   * 新增一条"区域识别"得到的 visual chunk（bbox 为归一化页面坐标或 null）。
   *
   * 与整页 OCR 缓存不同：区域识别只把这一块文字并入检索索引，**不写 page_edits**、
   * 不覆盖整页文本。同文档同页同 text 已存在时返回 false（避免重复框选反复插入）。
   */
  addVisualChunk(
    documentId: string,
    page: number,
    text: string,
    bbox: [number, number, number, number] | null
  ): boolean {
    const document = this.getDocument(documentId);
    if (!document) throw new Error('文档不存在');
    const value = String(text ?? '');
    if (!value.trim()) return false;
    const target = Math.max(1, Math.trunc(page));
    const existing = this.db
      .prepare('SELECT id FROM chunks WHERE document_id = ? AND page = ? AND text = ?')
      .get(documentId, target, value) as { id: string } | undefined;
    if (existing) return false;
    const chunkId = `${documentId}:${target}:${randomUUID()}`;
    const storedBbox = bbox ? JSON.stringify(bbox) : 'null';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `INSERT INTO chunks(id, document_id, page, text, bbox, bbox_space)
           VALUES (?, ?, ?, ?, ?, 'visual')`
        )
        .run(chunkId, documentId, target, value, storedBbox);
      this.db
        .prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)')
        .run(Number(result.lastInsertRowid), value);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  listDerivedChunks(documentIds: string[]): Array<{
    id: string;
    documentId: string;
    page: number;
    text: string;
    derived: boolean;
    translation: boolean;
    /** 译文段号（translation_segments.segment）；结构派生行没有。 */
    segment?: number;
    /** 译文是否人工改稿；结构派生行没有。 */
    edited?: boolean;
    /** 译文行 id；结构派生行没有。 */
    translation_id?: string;
    /** 译文引擎；结构派生行没有。 */
    engine?: string;
    sourceText?: string;
  }> {
    if (documentIds.length === 0) return [];
    const marks = documentIds.map(() => '?').join(',');
    const result: Array<{
      id: string;
      documentId: string;
      page: number;
      text: string;
      derived: boolean;
      translation: boolean;
      segment?: number;
      edited?: boolean;
      translation_id?: string;
      engine?: string;
      sourceText?: string;
    }> = [];

    // structures.version 必须与当前 structureStamp（size:mtime:maskRevision）一致；
    // 不一致的派生节点跳过、不删除，等下一次 getStructure/getVisualNodes 重算覆盖。
    const currentStamps = new Map<string, string>();
    const currentStamp = (documentId: string): string => {
      if (!currentStamps.has(documentId)) {
        currentStamps.set(documentId, this.structureStamp(documentId)?.stamp ?? '');
      }
      return currentStamps.get(documentId) ?? '';
    };
    const structureRows = this.db
      .prepare(
        `SELECT document, version, value FROM structures WHERE document IN (${marks})`
      )
      .all(...documentIds) as unknown as Array<{
      document: string;
      version: string;
      value: string;
    }>;
    for (const row of structureRows) {
      const version = String(row.version ?? '');
      const expected = currentStamp(row.document);
      if (!expected || version !== expected) continue;
      try {
        const value = JSON.parse(row.value) as {
          sections?: Array<{ title?: string; page?: number; derived?: boolean }>;
          visual_nodes?: Array<{ caption?: string; page?: number; kind?: string }>;
          semantic_nodes?: Array<{ description?: string; page?: number; derived?: boolean }>;
        };
        const nodes = [
          ...(value.sections ?? []).map((node) => ({ text: node.title, page: node.page, derived: false })),
          ...(value.visual_nodes ?? []).map((node) => ({
            text: node.caption,
            page: node.page,
            derived: false
          })),
          ...(value.semantic_nodes ?? []).map((node) => ({
            text: node.description,
            page: node.page,
            derived: true
          }))
        ];
        nodes.forEach((node, index) => {
          const text = String(node.text ?? '').trim();
          const page = Number(node.page);
          if (!text || !Number.isFinite(page) || page < 1) return;
          result.push({
            id: `structure:${row.document}:${index}`,
            documentId: row.document,
            page,
            text: text.slice(0, 8000),
            derived: Boolean(node.derived),
            translation: false
          });
        });
      } catch {
        // 损坏的结构缓存不参与检索
      }
    }

    const translationRows = this.db
      .prepare(
        `SELECT id, document_id, page, segment, text, source, edited, engine
         FROM translation_segments
         WHERE document_id IN (${marks}) AND text <> '' ORDER BY document_id, page, segment`
      )
      .all(...documentIds) as unknown as Array<{
      id: string;
      document_id: string;
      page: number;
      segment: number;
      text: string;
      source: string;
      edited: number;
      engine: string;
    }>;
    for (const row of translationRows) {
      const text = String(row.text ?? '').trim();
      if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) continue;
      // 文本质量可疑（替换字符/私用区/控制字符占比 >2%）的译文不作为派生检索来源。
      if (textQuality(text).suspect) continue;
      result.push({
        id: `T:${row.id}`,
        documentId: row.document_id,
        page: row.page,
        text,
        derived: true,
        translation: true,
        segment: Number(row.segment ?? 0),
        edited: Number(row.edited ?? 0) === 1,
        translation_id: String(row.id),
        engine: String(row.engine ?? ''),
        sourceText: row.source ?? ''
      });
    }
    return result;
  }

  /** 检索索引版本号（chunks/派生结构/译文/改名变化时由触发器递增）；语义见 store/documents.ts。 */
  getRetrievalRevision(): number {
    return documentDomain.getRetrievalRevision(this.db);
  }

  /** 单篇文献的检索版本号；语义见 store/documents.ts。 */
  getDocumentRetrievalRevision(documentId: string): number {
    return documentDomain.getDocumentRetrievalRevision(this.db, documentId);
  }

  /** 批量读取多篇文献的检索版本（scope 检索缓存键）；语义见 store/documents.ts。 */
  getDocumentRetrievalRevisions(documentIds: readonly string[]): Record<string, number> {
    return documentDomain.getDocumentRetrievalRevisions(this.db, documentIds);
  }

  listChunks(documentId?: string): Array<{
    id: string;
    documentId: string;
    page: number;
    text: string;
  }> {
    const rows = documentId
      ? (this.db
          .prepare('SELECT id, document_id, page, text FROM chunks WHERE document_id = ? ORDER BY page, rowid')
          .all(documentId) as unknown as Array<{
          id: string;
          document_id: string;
          page: number;
          text: string;
        }>)
      : (this.db
          .prepare('SELECT id, document_id, page, text FROM chunks ORDER BY document_id, page, rowid')
          .all() as unknown as Array<{
          id: string;
          document_id: string;
          page: number;
          text: string;
        }>);
    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      page: row.page,
      text: row.text
    }));
  }

  countChunks(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count
    );
  }

  countVectors(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM vectors').get() as { count: number }).count
    );
  }

  vectorModel(): string | null {
    const row = this.db
      .prepare('SELECT model FROM vectors ORDER BY updated DESC LIMIT 1')
      .get() as { model: string } | undefined;
    return row?.model ?? null;
  }

  saveVectors(entries: Array<{ chunkId: string; model: string; vector: Float32Array }>): void {
    const statement = this.db.prepare(
      `INSERT INTO vectors(chunk_id, model, dim, vector, updated)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         model = excluded.model, dim = excluded.dim, vector = excluded.vector, updated = excluded.updated`
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        statement.run(
          entry.chunkId,
          entry.model,
          entry.vector.length,
          Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength),
          new Date().toISOString()
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getVectors(ids: string[]): Map<string, Float32Array> {
    const result = new Map<string, Float32Array>();
    const statement = this.db.prepare('SELECT vector FROM vectors WHERE chunk_id = ?');
    for (const id of ids) {
      const row = statement.get(id) as { vector: Uint8Array } | undefined;
      if (!row?.vector) continue;
      const copy = Buffer.from(row.vector);
      result.set(id, new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4));
    }
    return result;
  }

  getAuditCache(key: string): unknown | null {
    const row = this.db
      .prepare('SELECT report FROM audit_cache WHERE key = ?')
      .get(key) as { report?: string } | undefined;
    if (!row?.report) return null;
    try {
      return JSON.parse(row.report) as unknown;
    } catch {
      return null;
    }
  }

  saveAuditCache(key: string, report: unknown): void {
    this.db
      .prepare(
        `INSERT INTO audit_cache(key, report, updated) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET report = excluded.report, updated = excluded.updated`
      )
      .run(key, JSON.stringify(report), new Date().toISOString());
  }

  /** 视觉读页缓存（派生资料）：同一文献/页/模型/版本命中后不再调用视觉模型。 */
  getVisualCache(
    documentId: string,
    page: number,
    model: string,
    version: string
  ): unknown | null {
    const row = this.db
      .prepare(
        `SELECT result FROM visual_cache
         WHERE document_id = ? AND page = ? AND model = ? AND version = ?`
      )
      .get(documentId, Math.max(1, Math.trunc(page)), model, version) as
      | { result?: string }
      | undefined;
    if (!row?.result) return null;
    try {
      return JSON.parse(row.result) as unknown;
    } catch {
      return null;
    }
  }

  saveVisualCache(
    documentId: string,
    page: number,
    model: string,
    version: string,
    result: unknown
  ): void {
    this.db
      .prepare(
        `INSERT INTO visual_cache(document_id, page, model, version, result, updated)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id, page, model, version)
         DO UPDATE SET result = excluded.result, updated = excluded.updated`
      )
      .run(
        documentId,
        Math.max(1, Math.trunc(page)),
        model,
        version,
        JSON.stringify(result),
        new Date().toISOString()
      );
  }

  getEmbeddingCache(keys: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    const statement = this.db.prepare('SELECT value FROM embedding_cache WHERE key = ?');
    for (const key of keys) {
      const row = statement.get(key) as { value: string } | undefined;
      if (!row?.value) continue;
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'number')) {
          result.set(key, parsed as number[]);
        }
      } catch {
        // 缓存损坏时忽略，后续重新请求
      }
    }
    return result;
  }

  saveEmbeddingCache(entries: Array<{ key: string; vector: number[] }>): void {
    const statement = this.db.prepare(
      `INSERT INTO embedding_cache(key, value, updated) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`
    );
    const updated = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        statement.run(entry.key, JSON.stringify(entry.vector), updated);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  countEmbeddingCache(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM embedding_cache').get() as { count: number })
        .count
    );
  }

  /**
   * 从旧版 data 目录迁移文档/批注/笔记/消息/设置/向量缓存。源库只读。
   *
   * 源目录允许直接传入 reader.sqlite3 文件。PDF 按以下顺序查找：Zotero 外部路径、
   * `documents.path`（相对源目录，兼容新版本资料目录）、`papers/<sha256>.pdf`、
   * `papers/<文档 ID>.pdf`、源目录下的 `<文档 ID>.pdf`（旧 Python 版布局）。
   */
  migrateLegacy(legacyDir: string): LegacyMigrationReport {
    const inputPath = path.resolve(legacyDir);
    const legacyDbPath = inputPath.endsWith('reader.sqlite3')
      ? inputPath
      : path.join(inputPath, 'reader.sqlite3');
    if (!existsSync(legacyDbPath)) throw new Error(`旧版数据库不存在：${legacyDbPath}`);
    const sourceDir = path.dirname(legacyDbPath);
    if (path.resolve(sourceDir) === path.resolve(this.dataDir)) {
      throw new Error('源目录就是当前资料目录：请用「资料位置」迁移，而不是「从旧版迁移数据」');
    }

    const legacy = new DatabaseSync(legacyDbPath);
    const report: LegacyMigrationReport = {
      documents: 0,
      chunks: 0,
      annotations: 0,
      notes: 0,
      messages: 0,
      settings: 0,
      embeddings: 0,
      translations: 0,
      pageEdits: 0,
      navigation: 0,
      pageMasks: 0,
      readingTasks: 0,
      structures: 0,
      connections: 0,
      skippedDocuments: 0,
      warnings: []
    };

    // 迁移前备份新库（旧库只读，不需要改）。出现问题时可直接用该文件恢复。
    try {
      const backupDir = path.join(this.dataDir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(
        backupDir,
        `pre-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3`
      );
      this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      report.backupPath = backupPath;
    } catch {
      report.warnings.push('迁移前自动备份失败；请手动备份 data 目录。');
    }
    const hasTableIn = (db: DatabaseSync, name: string): boolean =>
      Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
      );
    const columnsOfIn = (db: DatabaseSync, table: string): Set<string> =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
          (column) => column.name
        )
      );
    const hasTable = (name: string): boolean => hasTableIn(legacy, name);

    const value = (row: Record<string, unknown>, key: string, fallback: unknown): unknown =>
      row[key] ?? fallback;

    const migratedDocuments = new Set<string>();

    /**
     * 旧版资料目录里 PDF 的可能位置（按优先级去重，只生成路径，不判断存在）。
     *
     * 旧 Python 版把副本放在 data 目录根部的 `<文档 ID>.pdf`；新版资料目录用
     * `papers/<sha256>.pdf` 并在 `documents.path` 记相对路径；Zotero 文献是外部路径。
     * 迁移目标目录可能正是上一版的资料目录，因此这几种布局都要认。
     */
    const legacyPdfCandidates = (row: Record<string, unknown>): string[] => {
      const id = String(value(row, 'id', ''));
      const storageKind = String(value(row, 'storage_kind', 'copy'));
      const externalPath = String(value(row, 'external_path', '')).trim();
      const storedPath = String(value(row, 'path', '')).trim();
      const sha256 = String(value(row, 'sha256', '')).trim().toLowerCase();
      const candidates: string[] = [];
      const add = (candidate: string): void => {
        if (!candidate) return;
        const resolved = path.resolve(candidate);
        if (!candidates.includes(resolved)) candidates.push(resolved);
      };
      if (storageKind === 'zotero' && externalPath) add(externalPath);
      if (storedPath) {
        add(path.isAbsolute(storedPath) ? storedPath : path.join(sourceDir, storedPath));
      }
      if (sha256) add(path.join(sourceDir, 'papers', `${sha256}.pdf`));
      if (id) {
        add(path.join(sourceDir, 'papers', `${id}.pdf`));
        add(path.join(sourceDir, `${id}.pdf`));
      }
      return candidates;
    };

    if (hasTable('documents')) {
      const rows = legacy.prepare('SELECT * FROM documents').all() as unknown as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const id = String(value(row, 'id', ''));
        if (!id) continue;
        const candidate = legacyPdfCandidates(row).find((pdfPath) => existsSync(pdfPath));
        if (!candidate) {
          report.skippedDocuments += 1;
          report.warnings.push(`文档 ${id} 的 PDF 不存在，已跳过`);
          continue;
        }
        const bytes = readFileSync(candidate);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const relativePath = path.join('papers', `${sha256}.pdf`);
        const destination = path.join(this.dataDir, relativePath);
        mkdirSync(path.dirname(destination), { recursive: true });
        if (!existsSync(destination)) copyFileSync(candidate, destination);

        this.db
          .prepare(
            `INSERT OR IGNORE INTO documents
             (id, name, pages, current_page, created, deleted, storage_kind, external_path,
              external_key, file_stamp, tags, author, publication, doi, title_key, sha256,
              size_bytes, path, manual_order)
             VALUES (?, ?, ?, ?, ?, ?, 'copy', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            String(value(row, 'name', '')),
            Number(value(row, 'pages', 0)),
            Number(value(row, 'current_page', 1)),
            String(value(row, 'created', new Date().toISOString())),
            Number(value(row, 'deleted', 0)),
            String(value(row, 'external_key', '')),
            String(value(row, 'file_stamp', '')),
            String(value(row, 'tags', '[]')),
            String(value(row, 'author', '')),
            String(value(row, 'publication', '')),
            normalizeDoi(String(value(row, 'doi', ''))),
            normalizeKey(String(value(row, 'name', ''))),
            sha256,
            bytes.length,
            relativePath,
            this.nextManualOrder()
          );
        migratedDocuments.add(id);
        report.documents += 1;
      }
      if (report.skippedDocuments > 0) {
        report.warnings.push(
          '找不到 PDF 的文档不会被复制：旧 Python 版资料目录在根部放 <文档 ID>.pdf，' +
            '新版本资料目录在 papers/ 下按 sha256 命名；请确认所选目录就是文档所在的数据目录。'
        );
      }
    }

    if (hasTable('chunks')) {
      const rows = legacy.prepare('SELECT * FROM chunks').all() as unknown as Array<
        Record<string, unknown>
      >;
      const insertChunk = this.db.prepare(
        `INSERT OR IGNORE INTO chunks(id, document_id, page, text, bbox, bbox_space)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const findRowid = this.db.prepare('SELECT rowid AS rowid FROM chunks WHERE id = ?');
      const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
      const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)');
      for (const row of rows) {
        const documentId = String(value(row, 'document_id', ''));
        if (!migratedDocuments.has(documentId)) continue;
        const chunkId = String(value(row, 'id', ''));
        const text = String(value(row, 'text', ''));
        if (!chunkId || !text.trim()) continue;
        const result = insertChunk.run(
          chunkId,
          documentId,
          Number(value(row, 'page', 1)),
          text,
          String(value(row, 'bbox', '')),
          String(value(row, 'bbox_space', 'legacy'))
        );
        const rowid = findRowid.get(chunkId) as { rowid: number } | undefined;
        if (rowid?.rowid) {
          deleteFts.run(rowid.rowid);
          insertFts.run(rowid.rowid, text);
        }
        if (result.changes > 0) report.chunks += 1;
      }
    }

    const copyTable = (
      table: 'annotations' | 'notes' | 'messages',
      target: 'annotations' | 'notes' | 'messages'
    ): void => {
      if (!hasTable(table)) return;
      const rows = legacy.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const documentId = String(value(row, 'document_id', ''));
        if (documentId && !migratedDocuments.has(documentId)) continue;
        if (table === 'annotations') {
          const result = this.db
            .prepare(
              `INSERT OR IGNORE INTO annotations
               (id, document_id, page, quote, content, rects, color, deleted, style,
                translation_excerpt, external_key, created)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              String(value(row, 'id', randomUUID())),
              documentId,
              Number(value(row, 'page', 1)),
              String(value(row, 'quote', '')),
              String(value(row, 'content', '')),
              String(value(row, 'rects', '')),
              String(value(row, 'color', 'yellow')),
              Number(value(row, 'deleted', 0)),
              String(value(row, 'style', 'highlight')),
              String(value(row, 'translation_excerpt', '')),
              String(value(row, 'external_key', '')),
              String(value(row, 'created', new Date().toISOString()))
            );
          if (result.changes > 0) report.annotations += 1;
        } else if (table === 'notes') {
          const result = this.db
            .prepare(
              `INSERT OR IGNORE INTO notes(id, document_id, page, quote, content, created, deleted)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              String(value(row, 'id', randomUUID())),
              documentId,
              Number(value(row, 'page', 1)),
              String(value(row, 'quote', '')),
              String(value(row, 'content', '')),
              String(value(row, 'created', new Date().toISOString())),
              Number(value(row, 'deleted', 0))
            );
          if (result.changes > 0) report.notes += 1;
        } else {
          const result = this.db
            .prepare(
              `INSERT OR IGNORE INTO messages(id, document_id, role, content, sources, created, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              Number(value(row, 'id', 0)),
              documentId,
              String(value(row, 'role', '')),
              String(value(row, 'content', '')),
              String(value(row, 'sources', '')),
              String(value(row, 'created', new Date().toISOString())),
              String(value(row, 'metadata', '{}'))
            );
          if (result.changes > 0) report.messages += 1;
        }
      }
      void target;
    };

    copyTable('annotations', 'annotations');
    copyTable('notes', 'notes');
    copyTable('messages', 'messages');

    const copyAux = (
      sourceDb: DatabaseSync,
      sourceTable: string,
      targetTable: string,
      targetColumns: string[]
    ): number => {
      if (!hasTableIn(sourceDb, sourceTable)) return 0;
      const sourceColumns = columnsOfIn(sourceDb, sourceTable);
      const columns = targetColumns.filter((column) => sourceColumns.has(column));
      if (columns.length === 0) return 0;
      const rows = sourceDb.prepare(`SELECT * FROM ${sourceTable}`).all() as unknown as Array<
        Record<string, unknown>
      >;
      const statement = this.db.prepare(
        `INSERT OR IGNORE INTO ${targetTable}(${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`
      );
      // 文档被跳过（PDF 找不到）时，它名下的译文/页面编辑/结构等也不该进新库，
      // 否则新库会出现指向不存在文献的孤儿数据。
      const scopedColumn = sourceColumns.has('document_id')
        ? 'document_id'
        : sourceTable === 'structures' && sourceColumns.has('document')
          ? 'document'
          : '';
      let migrated = 0;
      for (const row of rows) {
        if (hasTable('documents') && scopedColumn) {
          const documentId = String(row[scopedColumn] ?? '');
          if (documentId && !migratedDocuments.has(documentId)) continue;
        }
        const result = statement.run(
          ...columns.map((column) => (row[column] ?? null) as string | number | null)
        );
        if (result.changes > 0) migrated += 1;
      }
      return migrated;
    };

    report.translations += copyAux(legacy, 'translation_pages', 'translation_pages', [
      'document_id',
      'page',
      'source_hash',
      'engine',
      'status',
      'error',
      'done',
      'total',
      'updated'
    ]);
    report.translations += copyAux(legacy, 'translation_segments', 'translation_segments', [
      'id',
      'document_id',
      'page',
      'segment',
      'source',
      'source_hash',
      'text',
      'engine',
      'service',
      'terms',
      'unknown_terms',
      'coverage',
      'edited',
      'origin',
      'previous_text',
      'previous_origin',
      'created',
      'updated'
    ]);
    report.pageEdits += copyAux(legacy, 'page_edits', 'page_edits', [
      'document_id',
      'page',
      'version',
      'text',
      'origin',
      'boxes'
    ]);
    report.navigation += copyAux(legacy, 'doc_navigation', 'doc_navigation', [
      'document_id',
      'page',
      'kind',
      'label',
      'created'
    ]);
    report.navigation += copyAux(legacy, 'doc_navigation_state', 'doc_navigation_state', [
      'document_id',
      'enabled',
      'built_at',
      'source_hash',
      'node_count',
      'last_used',
      'file_stamp',
      'mask_revision',
      'build_state',
      'error'
    ]);
    report.pageMasks += copyAux(legacy, 'page_masks', 'page_masks', [
      'id',
      'document_id',
      'page',
      'x0',
      'y0',
      'x1',
      'y1',
      'created'
    ]);
    // 27：旧版 platform_connections 可能含平台 API Key 的 DPAPI 密文（当前代码零读零写），
    // **不再复制**到新库；迁移报告的 connections 保持 0，由启动迁移清空既有库的该表。

    const legacyReading = path.join(sourceDir, 'reading.sqlite3');
    if (existsSync(legacyReading)) {
      try {
        const reading = new DatabaseSync(legacyReading);
        report.readingTasks += copyAux(reading, 'reading_tasks', 'reading_tasks', [
          'task',
          'payload',
          'documents',
          'updated'
        ]);
        report.readingTasks += copyAux(reading, 'checkpoints', 'checkpoints', [
          'task',
          'stage',
          'value',
          'documents',
          'updated'
        ]);
        reading.close();
      } catch {
        report.warnings.push('旧版 reading.sqlite3 无法读取，已跳过阅读任务');
      }
    }

    const legacyStructure = path.join(sourceDir, 'structure.sqlite3');
    if (existsSync(legacyStructure)) {
      try {
        const structure = new DatabaseSync(legacyStructure);
        report.structures += copyAux(structure, 'pages', 'structure_pages', [
          'path',
          'page',
          'version',
          'value'
        ]);
        report.structures += copyAux(structure, 'structures', 'structures', [
          'document',
          'path',
          'version',
          'value'
        ]);
        structure.close();
        // 迁移来的 structures.version 是元组形式的 JSON，与 TS structureStamp
        // （size:mtime:maskRevision）不是同一口径；按当前文件版本重写，
        // 否则严格的版本校验会把这份可用结构缓存全部丢弃。
        const migrated = this.db
          .prepare('SELECT document FROM structures')
          .all() as unknown as Array<{ document: string }>;
        const updateVersion = this.db.prepare(
          'UPDATE structures SET version = ? WHERE document = ?'
        );
        for (const row of migrated) {
          const stamp = this.structureStamp(row.document)?.stamp;
          if (stamp) updateVersion.run(stamp, row.document);
        }
      } catch {
        report.warnings.push('旧版 structure.sqlite3 无法读取，已跳过结构缓存');
      }
    }

    const legacyVectors = path.join(sourceDir, 'vectors.sqlite3');
    if (existsSync(legacyVectors)) {
      try {
        const vectors = new DatabaseSync(legacyVectors);
        const rows = vectors
          .prepare('SELECT key, value FROM vectors')
          .all() as unknown as Array<{ key: string; value: string }>;
        const insert = this.db.prepare(
          `INSERT OR IGNORE INTO embedding_cache(key, value, updated) VALUES (?, ?, ?)`
        );
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.value) as unknown;
            if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'number')) continue;
            const result = insert.run(row.key, row.value, new Date().toISOString());
            if (result.changes > 0) report.embeddings += 1;
          } catch {
            // 跳过损坏的缓存
          }
        }
        vectors.close();
      } catch {
        report.warnings.push('旧版 vectors.sqlite3 无法读取，已跳过向量缓存');
      }
    }

    legacy.close();
    // 旧库复制过来的笔记/批注内容可能带图片引用：重建一次资源引用表。
    noteAssets.rebuildRefs(this.db, this.noteAssetDeps);
    this.invalidateReferenceGraphCache();
    return report;
  }

  /**
   * 笔记图片单图上限：`note_image.max_mb`（1..20，默认 2）与
   * `note_image.max_pixels`（1..25,000,000，默认 8,000,000）；每次实时读取 settings，
   * 非法/缺失/越界都回退默认值，设置更新后立即生效。
   */
  getNoteImageLimits(): NoteImageLimits {
    const settings = this.getSettings();
    const maxMb = integerSetting(
      settings['note_image.max_mb'],
      NOTE_IMAGE_MIN_MAX_MB,
      NOTE_IMAGE_MAX_MAX_MB,
      NOTE_IMAGE_DEFAULT_MAX_MB
    );
    const maxPixels = integerSetting(
      settings['note_image.max_pixels'],
      NOTE_IMAGE_MIN_MAX_PIXELS,
      NOTE_IMAGE_MAX_MAX_PIXELS,
      NOTE_IMAGE_DEFAULT_MAX_PIXELS
    );
    return { maxBytes: maxMb * 1024 * 1024, maxPixels };
  }

  /**
   * 可嵌套事务：外层 BEGIN IMMEDIATE；已在事务里则内部降级为 SAVEPOINT。
   * 变更集 apply 用它包多条领域写；领域函数自身也必须走 beginTransaction。
   */
  withTransaction<T>(fn: () => T): T {
    return runWithTransaction(this.db, fn);
  }

  getSettings(): SettingsMap {
    const rows = this.db.prepare('SELECT key, value FROM settings ORDER BY key').all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  deleteSettings(keys: string[]): void {
    const statement = this.db.prepare('DELETE FROM settings WHERE key = ?');
    for (const key of keys) statement.run(key);
  }

  updateSettings(patch: SettingsMap, manageTransaction = true): SettingsMap {
    const statement = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    if (manageTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(patch)) {
        statement.run(key, String(value));
      }
      if (manageTransaction) this.db.exec('COMMIT');
    } catch (error) {
      if (manageTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getSettings();
  }
}
