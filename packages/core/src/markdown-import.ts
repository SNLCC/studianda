import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type {
  MarkdownImportDuplicatePreview,
  MarkdownImportItem,
  MarkdownImportJob,
  MarkdownImportReport,
  MarkdownImportReportPage,
  MarkdownJobSnapshot,
  MarkdownScanJob,
  MarkdownScanSearchResult,
  MarkdownScanTreePage,
  MarkdownSelectionInput,
  MarkdownSelectionResult,
  MarkdownTreeEntry,
  MarkdownVaultFile,
  MarkdownVaultScan
} from '@studianda/shared';
import type { Store } from './store.js';

const MAX_VAULT_FILES = 200000;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const WARNING_LIMIT = 200;
const SETTINGS_IMPORT_JOB = 'markdown.import_job';
const SETTINGS_SCAN_JOB = 'markdown.scan_job';
const NOTE_EXTENSIONS = new Set(['.md', '.markdown']);
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
};
const SKIP_DIRECTORIES = new Set(['.markdown', '.git', 'node_modules']);
const AMBIGUOUS = Symbol('ambiguous');
type ResolvedNote = string | typeof AMBIGUOUS;

// ---------------------------------------------------------------------------
// 后台任务状态（模块级单例：单个 core 进程同一时间只跑一个导入）
// ---------------------------------------------------------------------------

function idleJob(): MarkdownImportJob {
  return {
    status: 'idle',
    phase: 'idle',
    total: 0,
    done: 0,
    currentPath: '',
    report: null,
    error: '',
    input: null,
    resultCompletedAt: null,
    resultStale: false,
    resultMissing: false,
    lastAttemptStatus: ''
  };
}

let markdownImportJob: MarkdownImportJob = idleJob();
let markdownImportRunning = false;
let markdownImportCancelRequested = false;
/** 最近一次任务使用的 Store（getStatus 运行期 stat 结果文件用）。 */
let markdownJobStore: Store | null = null;

/** 被删除/损坏的结果文件状态（供 getStatus/SSE 热路径判断）。 */
function resultArtifactStatus(
  store: Store,
  pair: ResultFilePair
): { missing: boolean; corrupted: boolean } {
  return checkResultArtifact(store, pair);
}

/** 把旧 settings 的 lastAttemptStatus='failed' 兼容映射为 'error'。 */
function mapLegacyAttemptStatus<T extends { lastAttemptStatus?: string }>(job: T): T {
  if (String(job.lastAttemptStatus ?? '') === 'failed') {
    return { ...job, lastAttemptStatus: 'error' };
  }
  return job;
}

function snapshotJob(): MarkdownImportJob {
  let job: MarkdownImportJob = {
    ...markdownImportJob,
    report: markdownImportJob.report
  };
  job = mapLegacyAttemptStatus(job);
  // 运行期 stat（TTL 缓存）：done 但结果文件被删除/外部改坏 → 立即标记缺失。
  if (job.status === 'done' && markdownJobStore) {
    const status = resultArtifactStatus(markdownJobStore, IMPORT_RESULT);
    if (status.missing || status.corrupted) {
      job = {
        ...job,
        report: null,
        resultMissing: true,
        resultStale: true,
        error: '结果文件缺失或损坏，请重新导入'
      };
    }
  }
  return job;
}

export function getMarkdownImportStatus(): MarkdownImportJob {
  return snapshotJob();
}

/** 取消正在进行的导入：立即把状态置为 cancelled，处理循环在下一个检查点停止。 */
export function cancelMarkdownImport(): MarkdownImportJob {
  if (markdownImportRunning) {
    markdownImportCancelRequested = true;
    markdownImportJob = {
      ...markdownImportJob,
      status: 'cancelled',
      lastAttemptStatus: 'cancelled',
      resultStale: Boolean(markdownImportJob.resultCompletedAt)
    };
    notifyJobChange();
  }
  return snapshotJob();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function normalizedKey(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Markdown 导入的身份前缀：vault 绝对路径 hash（不同库/移动后的库互不误判）。 */
function markdownVaultKeyPrefix(vaultRoot: string): string {
  const vaultId = createHash('sha256').update(vaultRoot).digest('hex').slice(0, 16);
  return `markdown:${vaultId}:`;
}

/** 某篇笔记的 externalKey：vault hash + 规范化相对路径（同名不同目录是不同笔记）。 */
function markdownExternalKey(vaultRoot: string, relativePath: string): string {
  return `${markdownVaultKeyPrefix(vaultRoot)}${normalizedKey(relativePath)}`;
}

/** 重复预览里展示的标题：文件名（去 Markdown 扩展名），不按正文推断以免同名文件混淆。 */
function importPreviewTitle(relativePath: string): string {
  const base = path.posix.basename(normalizeRelative(relativePath));
  return base.replace(/\.(md|markdown)$/i, '') || base;
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (process.platform === 'win32') {
    const rootLower = normalizedRoot.toLowerCase();
    const targetLower = normalizedTarget.toLowerCase();
    return targetLower === rootLower || targetLower.startsWith(`${rootLower}${path.sep}`);
  }
  return (
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function isNotePath(filePath: string): boolean {
  return NOTE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function assertVaultDirectory(vaultPath: string): { root: string; scanBase: MarkdownVaultScan } {
  const raw = typeof vaultPath === 'string' ? vaultPath.trim() : '';
  if (!raw) throw new Error('需要笔记文件夹路径');
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) throw new Error('笔记文件夹不存在');
  let root: string;
  try {
    root = realpathSync(resolved);
  } catch {
    throw new Error('无法读取笔记文件夹');
  }
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new Error('无法读取笔记文件夹');
  }
  if (!stats.isDirectory()) throw new Error('路径不是目录');
  return {
    root,
    scanBase: { vaultPath: root, vaultName: path.basename(root), notes: [], attachments: [] }
  };
}

/** 扫描 Markdown 库：跳过隐藏项/`.markdown`/`.git`/`node_modules`/符号链接，文件数上限 20000。 */
export function scanMarkdownVault(vaultPath: string): MarkdownVaultScan {
  const { root, scanBase } = assertVaultDirectory(vaultPath);
  const notes: MarkdownVaultFile[] = [];
  const attachments: MarkdownVaultFile[] = [];
  let count = 0;
  const walk = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.resolve(directory, entry.name);
      if (!isInside(root, fullPath)) continue;
      let stats;
      try {
        stats = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (stats.isDirectory()) {
        walk(fullPath, relativePath);
        continue;
      }
      if (!stats.isFile()) continue;
      count += 1;
      if (count > MAX_VAULT_FILES) {
        throw new Error(`笔记文件夹文件数超过上限（最多 ${MAX_VAULT_FILES} 个）`);
      }
      const record: MarkdownVaultFile = {
        relativePath,
        name: entry.name,
        sizeBytes: stats.size,
        modified: stats.mtime.toISOString()
      };
      if (isNotePath(entry.name)) notes.push(record);
      else attachments.push(record);
    }
  };
  walk(root, '');
  return { ...scanBase, notes, attachments };
}

// ---------------------------------------------------------------------------
// 文本预处理：frontmatter / tags / callouts / block refs / 代码围栏
// ---------------------------------------------------------------------------

function addWarning(report: MarkdownImportReport, message: string): void {
  if (report.warnings.length >= WARNING_LIMIT) {
    if (!report.warnings.includes('（更多警告已省略）')) report.warnings.push('（更多警告已省略）');
    return;
  }
  if (!report.warnings.includes(message)) report.warnings.push(message);
}

function parseFrontmatterTags(yaml: string): string[] {
  const tags: string[] = [];
  const lines = yaml.split('\n');
  let collecting = false;
  for (const line of lines) {
    const keyMatch = /^\s*(?:tags?|Tags|TAGS)\s*:\s*(.*)$/.exec(line);
    if (keyMatch) {
      collecting = true;
      const inline = keyMatch[1]!.trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const item of inline.slice(1, -1).split(',')) {
          const value = item.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '');
          if (value) tags.push(value);
        }
        collecting = false;
      } else if (inline) {
        for (const item of inline.split(',')) {
          const value = item.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '');
          if (value) tags.push(value);
        }
        collecting = false;
      }
      continue;
    }
    if (collecting) {
      const listMatch = /^\s*-\s+(.+)$/.exec(line);
      if (listMatch) {
        const value = listMatch[1]!.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '');
        if (value) tags.push(value);
      } else if (line.trim() !== '') {
        collecting = false;
      }
    }
  }
  return [...new Set(tags)];
}

/** 处理 frontmatter（支持 BOM/前导空白、`---`/`...` 结束），提取 tags 转为正文标签行。 */
function stripFrontmatter(
  content: string,
  report: MarkdownImportReport,
  relativePath: string
): { content: string; tags: string[] } {
  const source = content.replace(/^\uFEFF/, '');
  const match = /^\s*---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { content: source, tags: [] };
  const tags = parseFrontmatterTags(match[1] ?? '');
  addWarning(report, `「${relativePath}」已移除 YAML frontmatter`);
  let rest = source.slice(match[0].length);
  if (tags.length > 0) {
    rest = `${rest.replace(/\s+$/, '')}\n\n> 标签：${tags.join(', ')}\n`;
  }
  return { content: rest, tags };
}

/** 从正文提取 Markdown 标签 `#tag`（跳过代码围栏与 Markdown 标题/锚点）。 */
function extractBodyTags(content: string): string[] {
  const tags: string[] = [];
  let fence: string | null = null;
  for (const line of content.split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!.slice(0, 3);
      if (fence === null) fence = marker;
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const lineWithoutHeadings = line.replace(/^\s*#+\s+/, '');
    for (const match of lineWithoutHeadings.matchAll(/(^|[\s(（[【])#([\p{L}\p{N}_/-]+)/gu)) {
      const tag = String(match[2] ?? '').replace(/^#+/, '');
      if (tag && !/^\d+$/.test(tag)) tags.push(tag);
    }
  }
  return tags;
}

/** 去掉 Markdown 注释、block 行尾 `^id`、转换 callout；代码围栏内容保持原样。 */
function preprocessMarkdown(
  content: string,
  report: MarkdownImportReport,
  relativePath: string
): string {
  const withoutComments = content.replace(/%%[\s\S]*?%%/g, '');
  const lines = withoutComments.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let fence: string | null = null;
  let warnedMermaid = false;
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!.slice(0, 3);
      if (fence === null) {
        fence = marker;
        const language = (fenceMatch[2] ?? '').toLowerCase();
        if ((language === 'mermaid' || language === 'dataview') && !warnedMermaid) {
          warnedMermaid = true;
          addWarning(report, 'Mermaid/Dataview 未渲染，已按原样保留');
        }
        output.push(line);
        continue;
      }
      if (line.trim().startsWith(fence)) {
        fence = null;
        output.push(line);
        continue;
      }
    }
    if (fence !== null) {
      output.push(line);
      continue;
    }
    // 单独一行的 block id
    if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) continue;
    let value = line.replace(/\s+\^[A-Za-z0-9-]+\s*$/, '');
    // callout：`> [!note] Title` / `> [!warning]-`
    const callout = /^(\s*)>\s*\[!([^\]]+)\][+-]?\s*(.*)$/.exec(value);
    if (callout) {
      const prefix = callout[1] ?? '';
      const type = (callout[2] ?? '').trim();
      const title = (callout[3] ?? '').trim();
      value = `${prefix}> **${title || type}**`;
    }
    value = value.replace(/%%/g, '');
    output.push(value);
  }
  void relativePath;
  return output.join('\n');
}

// ---------------------------------------------------------------------------
// 链接映射与重写
// ---------------------------------------------------------------------------

function registerMapping(map: Map<string, ResolvedNote>, key: string, noteId: string): void {
  const normalized = normalizedKey(key);
  if (!normalized) return;
  const existing = map.get(normalized);
  if (existing === undefined) {
    map.set(normalized, noteId);
    return;
  }
  if (existing !== noteId) map.set(normalized, AMBIGUOUS);
}

function buildMapping(
  entries: Array<{ id: string; relativePath: string }>
): Map<string, ResolvedNote> {
  const map = new Map<string, ResolvedNote>();
  for (const entry of entries) {
    const normalized = normalizeRelative(entry.relativePath);
    const withoutExt = normalized.replace(/\.(md|markdown)$/i, '');
    const base = path.posix.basename(normalized);
    const baseWithoutExt = base.replace(/\.(md|markdown)$/i, '');
    for (const key of [normalized, withoutExt, base, baseWithoutExt]) {
      registerMapping(map, key, entry.id);
    }
  }
  return map;
}

function lookupTarget(
  map: Map<string, ResolvedNote>,
  rawTarget: string,
  sourceRelativePath: string
): ResolvedNote | null {
  let target = normalizeRelative(rawTarget).replace(/#\^?.*$/, '').trim();
  if (!target) return null;
  const sourceDir = path.posix.dirname(normalizeRelative(sourceRelativePath));
  const candidates = [target, path.posix.normalize(path.posix.join(sourceDir, target))];
  for (const candidate of candidates) {
    if (!candidate || candidate === '.') continue;
    const withoutExt = candidate.replace(/\.(md|markdown)$/i, '');
    const base = path.posix.basename(candidate);
    const baseWithoutExt = base.replace(/\.(md|markdown)$/i, '');
    for (const key of [candidate, withoutExt, base, baseWithoutExt]) {
      const found = map.get(normalizedKey(key));
      if (found !== undefined) return found;
    }
  }
  // 最后按 basename 唯一匹配。
  return map.get(normalizedKey(path.posix.basename(target))) ?? null;
}

interface LinkRewriteResult {
  content: string;
  rewritten: number;
  unresolved: number;
}

/** 在代码围栏之外执行转换，Mermaid/Dataview 等块内容保持原样。 */
function mapOutsideFences(content: string, transform: (segment: string) => string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (buffer.length > 0) {
      output.push(transform(buffer.join('\n')));
      buffer = [];
    }
  };
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fenceMatch) {
      if (fence === null) {
        flush();
        fence = fenceMatch[1]!.slice(0, 3);
        output.push(line);
        continue;
      }
      if (line.trim().startsWith(fence)) {
        output.push(line);
        fence = null;
        continue;
      }
    }
    if (fence !== null) output.push(line);
    else buffer.push(line);
  }
  flush();
  return output.join('\n');
}

function safeLabel(value: string): string {
  return value.replace(/[|\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 重写一篇笔记里的 wikilink 与 Markdown 链接（在代码围栏外）。 */
function rewriteLinks(
  content: string,
  sourceRelativePath: string,
  mapping: Map<string, ResolvedNote>,
  report: MarkdownImportReport
): LinkRewriteResult {
  let rewritten = 0;
  let unresolved = 0;
  const transform = (segment: string): string => {
    let value = segment.replace(/\[\[([^\]\n]+)\]\]/g, (full, inner: string) => {
      const [targetPartRaw, aliasRaw] = inner.split('|');
      const alias = safeLabel((aliasRaw ?? '').trim());
      const targetPart = (targetPartRaw ?? '').trim();
      const [targetRaw, ...headingParts] = targetPart.split('#');
      const heading = headingParts.join('#').trim();
      if (!targetRaw) {
        // `[[#heading]]` 自锚点 → 纯文本。
        return alias || heading || full;
      }
      const label = alias || (heading ? `${targetRaw} § ${heading}` : targetRaw);
      const resolved = lookupTarget(mapping, targetRaw, sourceRelativePath);
      if (resolved === AMBIGUOUS) {
        addWarning(report, `链接目标重名，无法确定：${targetRaw}`);
        unresolved += 1;
        return full;
      }
      if (resolved) {
        rewritten += 1;
        return `[[note:${resolved}|${safeLabel(label) || targetRaw}]]`;
      }
      // 未解析：保留原 wikilink 文本，后续导入目标时由 resolving 阶段自动改写。
      unresolved += 1;
      return full;
    });
    value = mapOutsideFences(value, (segment2) =>
      segment2.replace(
        /(?<!!)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (full, text: string, rawTarget: string) => {
          let target = rawTarget.trim().replace(/^<|>$/g, '').replace(/[?#].*$/, '');
          if (!target || /^(?:https?:|data:|mailto:|studianda-asset:|file:)/i.test(target)) {
            return full;
          }
          try {
            target = decodeURIComponent(target);
          } catch {
            // 保留原样
          }
          const resolved = lookupTarget(mapping, target, sourceRelativePath);
          if (resolved === AMBIGUOUS) {
            addWarning(report, `链接目标重名，无法确定：${target}`);
            return full;
          }
          if (!resolved) return full;
          rewritten += 1;
          return `[[note:${resolved}|${safeLabel(text) || target}]]`;
        }
      )
    );
    return value;
  };
  const output = mapOutsideFences(content, (segment) => transform(segment));
  return { content: output, rewritten, unresolved };
}

// ---------------------------------------------------------------------------
// 图片 / 附件
// ---------------------------------------------------------------------------

/** 相对路径的目录部分（'' = 根目录；统一 / 分隔）。 */
function relativeDirOf(relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  const dir = path.posix.dirname(normalized);
  return dir === '.' || dir === '/' ? '' : dir;
}

/**
 * 解析笔记里的图片/附件目标（相对库根目录）。
 *
 * 顺序：① 笔记同目录相对路径；② vault 根相对路径；③ 按 basename 候选列表：
 * 唯一候选直接用；多候选时优先与笔记同目录者，其次按相对路径深度/字典序取最近候选，
 * 并 addWarning 说明选择（同名附件是合法的，不得仅因重名跳过真实附件）。
 * 只有确实不存在/越界才带原因跳过。
 */
function resolveAttachmentPath(
  vaultRoot: string,
  noteAbsPath: string,
  rawTarget: string,
  attachmentsByBasename: Map<string, MarkdownVaultFile[]>,
  report: MarkdownImportReport
): { absPath?: string; name: string; reason?: string } {
  let target = rawTarget.trim().replace(/^<|>$/g, '');
  if (!target) return { name: '', reason: '路径为空' };
  try {
    target = decodeURIComponent(target);
  } catch {
    // 非法 URL 编码：按原文处理
  }
  target = target.replace(/[?#].*$/, '');
  if (!target) return { name: '', reason: '路径为空' };
  if (/^(?:https?:|data:|mailto:|studianda-asset:|file:)/i.test(target)) {
    return { name: target, reason: '非本地附件' };
  }
  const slashTarget = target.replace(/\\/g, '/');
  // ① 笔记同目录相对路径优先。
  const direct = path.resolve(path.dirname(noteAbsPath), slashTarget);
  if (isInside(vaultRoot, direct) && existsSync(direct) && statSync(direct).isFile()) {
    return { absPath: direct, name: path.basename(direct) };
  }
  // ② vault 根相对路径（例如笔记在子目录、但链接写的是从库根算起的路径）。
  const fromRoot = path.resolve(vaultRoot, slashTarget);
  if (isInside(vaultRoot, fromRoot) && existsSync(fromRoot) && statSync(fromRoot).isFile()) {
    return { absPath: fromRoot, name: path.basename(fromRoot) };
  }
  // ③ basename 候选（扫描结果里的附件；越界/不存在的候选剔除）。
  const baseName = path.posix.basename(slashTarget);
  const candidates = attachmentsByBasename.get(baseName.toLowerCase()) ?? [];
  const usable: MarkdownVaultFile[] = [];
  for (const candidate of candidates) {
    const candidatePath = path.resolve(vaultRoot, candidate.relativePath);
    if (!isInside(vaultRoot, candidatePath)) continue;
    try {
      if (!statSync(candidatePath).isFile()) continue;
    } catch {
      continue;
    }
    usable.push(candidate);
  }
  const noteRelativeDir = relativeDirOf(path.relative(vaultRoot, noteAbsPath));
  if (usable.length === 1) {
    const chosen = usable[0]!;
    return {
      absPath: path.resolve(vaultRoot, chosen.relativePath),
      name: chosen.name
    };
  }
  if (usable.length > 1) {
    const depthOf = (relativePath: string): number => relativePath.split('/').length;
    const sorted = [...usable].sort((left, right) => {
      const leftSameDir = relativeDirOf(left.relativePath) === noteRelativeDir ? 0 : 1;
      const rightSameDir = relativeDirOf(right.relativePath) === noteRelativeDir ? 0 : 1;
      if (leftSameDir !== rightSameDir) return leftSameDir - rightSameDir;
      const leftDepth = depthOf(left.relativePath);
      const rightDepth = depthOf(right.relativePath);
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      return left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0;
    });
    const chosen = sorted[0]!;
    addWarning(report, `附件重名，已按最近路径选择：${chosen.relativePath}`);
    return {
      absPath: path.resolve(vaultRoot, chosen.relativePath),
      name: chosen.name
    };
  }
  // 兜底：带目录的相对路径解析到库外 → 越界；否则确实不存在。
  if (/[\\/]/.test(slashTarget) && !isInside(vaultRoot, direct)) {
    return { name: path.basename(slashTarget), reason: '附件路径越界' };
  }
  return { name: path.basename(slashTarget), reason: '附件不存在' };
}

/** 对大图做有损压缩，直到满足当前 note image 大小/像素限制；失败返回 null。 */
async function compressImageToLimits(
  store: Store,
  bytes: Buffer
): Promise<{ bytes: Buffer; mime: string } | null> {
  const limits = store.getNoteImageLimits();
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    return null;
  }
  const width = Number(image.width);
  const height = Number(image.height);
  if (!width || !height) return null;
  let pixels = width * height;
  let scale = Math.min(1, Math.sqrt(limits.maxPixels / pixels));
  let quality = 0.86;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const targetWidth = Math.max(1, Math.min(20000, Math.floor(width * scale)));
    const targetHeight = Math.max(1, Math.min(20000, Math.floor(height * scale)));
    if (targetWidth * targetHeight > limits.maxPixels) {
      scale *= 0.85;
      continue;
    }
    const canvas = createCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    let encoded: Buffer;
    try {
      encoded = Buffer.from(await canvas.encode('jpeg', quality));
    } catch {
      return null;
    }
    if (encoded.length <= limits.maxBytes) {
      return { bytes: encoded, mime: 'image/jpeg' };
    }
    quality = Math.max(0.4, quality - 0.1);
    scale *= 0.85;
    pixels = targetWidth * targetHeight;
    if (scale <= 0.02) break;
  }
  return null;
}

async function replaceMatches(
  content: string,
  pattern: RegExp,
  handler: (match: { text: string; index: number; groups: string[] }) => Promise<string> | string
): Promise<string> {
  const matches: Array<{ text: string; index: number; groups: string[] }> = [];
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  );
  let matched: RegExpExecArray | null;
  while ((matched = regex.exec(content)) !== null) {
    matches.push({ text: matched[0], index: matched.index, groups: matched.slice(1) });
    if (matched[0].length === 0) regex.lastIndex += 1;
  }
  const pieces: string[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    pieces.push(content.slice(lastIndex, match.index));
    pieces.push(await handler(match));
    lastIndex = match.index + match.text.length;
  }
  pieces.push(content.slice(lastIndex));
  return pieces.join('');
}

async function replaceEmbeds(
  store: Store,
  vaultRoot: string,
  noteAbsPath: string,
  content: string,
  attachmentsByBasename: Map<string, MarkdownVaultFile[]>,
  report: MarkdownImportReport
): Promise<string> {
  let output = content;
  output = await replaceMatches(output, /!\[\[([^\]\n]+)\]\]/g, async (match) => {
    const inner = match.groups[0] ?? '';
    const [targetRaw, aliasRaw] = inner.split('|');
    const target = (targetRaw ?? '').replace(/#.*$/, '').trim();
    const alias = safeLabel((aliasRaw ?? '').trim()) || path.basename(target);
    if (!target) return match.text;
    const resolved = resolveAttachmentPath(
      vaultRoot,
      noteAbsPath,
      target,
      attachmentsByBasename,
      report
    );
    if (!resolved.absPath) {
      addWarning(
        report,
        `「${path.basename(noteAbsPath)}」附件无法读取：${resolved.name}（${resolved.reason ?? '未知原因'}）`
      );
      return `\`[附件] ${resolved.name}\``;
    }
    const ext = path.extname(resolved.absPath).toLowerCase().slice(1);
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) {
      return copyAttachment(store, resolved, report, `[附件] ${resolved.name}`);
    }
    try {
      const bytes = readFileSync(resolved.absPath);
      const asset = await store.saveNoteAsset({
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        filename: resolved.name
      });
      report.imagesCopied += 1;
      return `![${alias}](${asset.url})`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const compressed = /不能超过|尺寸过大|无法解码/.test(message)
        ? await tryCompress(store, readFileSync(resolved.absPath), resolved.name, report)
        : null;
      if (compressed) return `![${alias}](${compressed})`;
      addWarning(report, `「${path.basename(noteAbsPath)}」图片未导入：${resolved.name}（${message}）`);
      return `**[图片未导入：${resolved.name}]**`;
    }
  });
  output = await replaceMatches(
    output,
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    async (match) => {
      const alt = match.groups[0] ?? '';
      const rawTarget = match.groups[1] ?? '';
      if (/^(?:https?:|data:|studianda-asset:|file:)/i.test(rawTarget.trim())) return match.text;
      const resolved = resolveAttachmentPath(
        vaultRoot,
        noteAbsPath,
        rawTarget,
        attachmentsByBasename,
        report
      );
      const ext = resolved.absPath ? path.extname(resolved.absPath).toLowerCase().slice(1) : '';
      const mime = IMAGE_MIME_BY_EXT[ext];
      if (!resolved.absPath || !mime) {
        if (resolved.absPath) {
          return copyAttachment(store, resolved, report, `[附件] ${resolved.name}`);
        }
        addWarning(
          report,
          `「${path.basename(noteAbsPath)}」图片无法读取：${resolved.name}（${resolved.reason ?? '未知原因'}）`
        );
        return match.text;
      }
      try {
        const bytes = readFileSync(resolved.absPath);
        const asset = await store.saveNoteAsset({
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
          filename: resolved.name
        });
        report.imagesCopied += 1;
        return `![${alt}](${asset.url})`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const compressed = /不能超过|尺寸过大|无法解码/.test(message)
          ? await tryCompress(store, readFileSync(resolved.absPath), resolved.name, report)
          : null;
        if (compressed) return `![${alt}](${compressed})`;
        addWarning(report, `「${path.basename(noteAbsPath)}」图片未导入：${resolved.name}（${message}）`);
        return match.text;
      }
    }
  );
  return output;
}

async function tryCompress(
  store: Store,
  bytes: Buffer,
  name: string,
  report: MarkdownImportReport
): Promise<string | null> {
  const compressed = await compressImageToLimits(store, bytes);
  if (!compressed) return null;
  try {
    const asset = await store.saveNoteAsset({
      dataUrl: `data:${compressed.mime};base64,${compressed.bytes.toString('base64')}`,
      filename: name
    });
    report.imagesCopied += 1;
    addWarning(report, `图片已压缩后导入：${name}`);
    return asset.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addWarning(report, `压缩后仍无法导入图片：${name}（${message}）`);
    return null;
  }
}

function copyAttachment(
  store: Store,
  resolved: { absPath?: string; name: string; reason?: string },
  report: MarkdownImportReport,
  fallbackText: string
): string {
  if (!resolved.absPath) {
    addWarning(report, `附件无法读取：${resolved.name}（${resolved.reason ?? '未知原因'}）`);
    return `\`${fallbackText}\``;
  }
  const bytes = readFileSync(resolved.absPath);
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    report.skippedAttachments += 1;
    addWarning(report, `附件超过 50MB，已跳过：${resolved.name}`);
    return `\`${fallbackText}\``;
  }
  try {
    const asset = store.saveNoteFile(resolved.name, bytes);
    report.attachmentsCopied += 1;
    return `[附件：${asset.filename}](${asset.url})`;
  } catch (error) {
    report.skippedAttachments += 1;
    const message = error instanceof Error ? error.message : String(error);
    addWarning(report, `附件导入失败：${resolved.name}（${message}）`);
    return `\`${fallbackText}\``;
  }
}

// ---------------------------------------------------------------------------
// 导入主流程
// ---------------------------------------------------------------------------

interface ImportHooks {
  onProgress?: (state: {
    phase: MarkdownImportJob['phase'];
    done: number;
    total: number;
    currentPath: string;
  }) => void;
  shouldCancel?: () => boolean;
}

export interface MarkdownImportOutcome {
  report: MarkdownImportReport;
  cancelled: boolean;
}

function createEmptyReport(vaultPath: string): MarkdownImportReport {
  return {
    vaultPath: '',
    requested: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    skippedExisting: 0,
    failed: 0,
    imagesCopied: 0,
    linksRewritten: 0,
    unresolvedLinks: 0,
    skippedAttachments: 0,
    attachmentsCopied: 0,
    notes: [],
    warnings: []
  };
}

/** 旧版（schema/结果文件）报告没有 skippedExisting 时按 0 兜底。 */
function withReportDefaults(report: MarkdownImportReport | null): MarkdownImportReport | null {
  if (!report) return null;
  return {
    ...report,
    skippedExisting: Number(report.skippedExisting ?? 0) || 0
  };
}

/**
 * 导入前的重复检查预览：按 externalKey（vault 绝对路径 hash + 规范化相对路径）判断
 * 哪些文件此前已导入。**不能用文件名/标题判断**——同名不同目录是不同笔记。
 * 不读正文、不写库，供 UI 弹窗让用户选择 update / skip。
 */
export function previewMarkdownImportDuplicates(
  store: Store,
  input: { vaultPath: string; files: string[] }
): MarkdownImportDuplicatePreview {
  const { root: vaultRoot } = assertVaultDirectory(input.vaultPath);
  const files = Array.isArray(input.files) ? input.files : [];
  const items: MarkdownImportDuplicatePreview['items'] = [];
  const seenKeys = new Set<string>();
  for (const raw of files) {
    const relativePath = normalizeRelative(String(raw ?? ''));
    if (!relativePath) continue;
    if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) continue;
    const externalKey = markdownExternalKey(vaultRoot, relativePath);
    if (seenKeys.has(externalKey)) continue;
    const existing = store.findNoteByExternalKey('', externalKey);
    if (!existing) continue;
    seenKeys.add(externalKey);
    items.push({
      relativePath,
      noteId: existing.id,
      title: importPreviewTitle(relativePath)
    });
  }
  return {
    total: files.length,
    alreadyImported: items.length,
    newCount: Math.max(0, files.length - items.length),
    items
  };
}

/** 重复命中时的策略：update = 覆盖更新（旧行为）；skip = 保留已有笔记、不改内容与链接。 */
export type MarkdownImportDuplicatePolicy = 'update' | 'skip';

interface MarkdownImportInput {
  vaultPath: string;
  files: string[];
  duplicatePolicy?: MarkdownImportDuplicatePolicy;
}

function resolveDuplicatePolicy(value: unknown): MarkdownImportDuplicatePolicy {
  if (value === undefined || value === null || value === '') return 'update';
  if (value === 'update' || value === 'skip') return value;
  throw new Error('duplicatePolicy 必须是 update 或 skip');
}

/** 同步导入（旧接口）：内部复用异步主流程，等全部完成后返回报告。 */
export async function importMarkdownNotes(
  store: Store,
  input: MarkdownImportInput
): Promise<MarkdownImportReport> {
  const outcome = await runMarkdownImport(store, input);
  return outcome.report;
}

/** 后台任务入口：启动异步分块导入（单并发；运行中再 start 返回当前快照）。 */
export function startMarkdownImport(store: Store, input: MarkdownImportInput): MarkdownImportJob {
  if (markdownImportRunning) return snapshotJob();
  if (!Array.isArray(input?.files) || !input.files.every((file) => typeof file === 'string')) {
    throw new Error('需要 files 字符串数组');
  }
  const duplicatePolicy = resolveDuplicatePolicy(input.duplicatePolicy);
  // 先做一次同步校验（非法路径/不存在目录直接 400，而不是异步 error）。
  const { root } = assertVaultDirectory(input.vaultPath);
  const previousResult = markdownImportJob;
  markdownImportRunning = true;
  markdownImportCancelRequested = false;
  // 开始新任务前清理残留 tmp/旧 json；失败/取消不会触碰上一次成功结果文件。
  markdownJobStore = store;
  cleanupResultArtifacts(store, IMPORT_RESULT);
  markdownImportJob = {
    status: 'running',
    phase: 'scanning',
    total: input.files.length,
    done: 0,
    currentPath: '',
    report: null,
    error: '',
    input: { vaultPath: root, files: [...input.files] },
    resultCompletedAt: previousResult.resultCompletedAt ?? null,
    resultStale: previousResult.resultStale ?? false,
    resultMissing: previousResult.resultMissing ?? false,
    lastAttemptStatus: 'running'
  };
  persistImportJob(store, markdownImportJob);
  notifyJobChange();
  let lastPersisted = 0;
  void runMarkdownImport(
    store,
    { vaultPath: root, files: input.files, duplicatePolicy },
    {
      onProgress: (state) => {
        markdownImportJob = { ...markdownImportJob, ...state };
        notifyJobChange();
        // 节流写盘：每 20 项或阶段变化时持久化一次。
        if (state.done - lastPersisted >= 20) {
          lastPersisted = state.done;
          persistImportJob(store, markdownImportJob);
        }
      },
      shouldCancel: () => markdownImportCancelRequested
    }
  )
    .then((outcome) => {
      markdownImportRunning = false;
      const cancelled = markdownImportCancelRequested || outcome.cancelled;
      const completedAt = cancelled ? null : new Date().toISOString();
      markdownImportJob = {
        ...markdownImportJob,
        status: cancelled ? 'cancelled' : 'done',
        phase: 'finalizing',
        done: Math.min(markdownImportJob.total, markdownImportJob.done),
        currentPath: '',
        report: outcome.report,
        resultCompletedAt: cancelled
          ? (markdownImportJob.resultCompletedAt ?? null)
          : completedAt,
        resultStale: cancelled ? Boolean(markdownImportJob.resultCompletedAt) : false,
        resultMissing: false,
        lastAttemptStatus: cancelled ? 'cancelled' : 'done'
      };
      persistImportJob(store, markdownImportJob);
      notifyJobChange();
    })
    .catch((error) => {
      markdownImportRunning = false;
      markdownImportJob = {
        ...markdownImportJob,
        status: 'error',
        error: `导入 Markdown 笔记失败：${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        resultStale: Boolean(markdownImportJob.resultCompletedAt),
        resultMissing: false,
        lastAttemptStatus: 'error'
      };
      persistImportJob(store, markdownImportJob);
      notifyJobChange();
    });
  return snapshotJob();
}

/** 实际执行导入：importing 阶段逐篇写库，resolving 阶段统一重写同 vault 链接。 */
export async function runMarkdownImport(
  store: Store,
  input: MarkdownImportInput,
  hooks: ImportHooks = {}
): Promise<MarkdownImportOutcome> {
  const { root: vaultRoot } = assertVaultDirectory(input.vaultPath);
  const duplicatePolicy = resolveDuplicatePolicy(input.duplicatePolicy);
  const report = createEmptyReport(vaultRoot);
  report.vaultPath = vaultRoot;
  report.requested = input.files.length;
  const keyPrefix = markdownVaultKeyPrefix(vaultRoot);
  const scan = scanMarkdownVault(vaultRoot);
  const attachmentsByBasename = new Map<string, MarkdownVaultFile[]>();
  for (const attachment of scan.attachments) {
    const key = attachment.name.toLowerCase();
    const existing = attachmentsByBasename.get(key);
    if (existing) existing.push(attachment);
    else attachmentsByBasename.set(key, [attachment]);
  }
  const checkCancel = (): boolean => hooks.shouldCancel?.() === true;
  const seen = new Set<string>();
  // duplicatePolicy='skip' 命中的已有笔记：不做内容更新/链接改写。
  const skippedExistingIds = new Set<string>();
  let cancelled = false;

  // importing
  hooks.onProgress?.({ phase: 'importing', done: 0, total: input.files.length, currentPath: '' });
  for (let index = 0; index < input.files.length; index += 1) {
    if (checkCancel()) {
      cancelled = true;
      break;
    }
    const relativeRaw = String(input.files[index] ?? '');
    const relativePath = normalizeRelative(relativeRaw);
    const item: MarkdownImportItem = { relativePath, status: 'skipped' };
    hooks.onProgress?.({
      phase: 'importing',
      done: index,
      total: input.files.length,
      currentPath: relativePath
    });
    try {
      if (!relativePath) throw new Error('路径为空');
      if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
        throw new Error('必须是库内相对路径');
      }
      const absPath = path.resolve(vaultRoot, relativePath);
      if (!isInside(vaultRoot, absPath)) throw new Error('路径越界，已拒绝');
      if (!existsSync(absPath) || !statSync(absPath).isFile()) throw new Error('文件不存在');
      if (!isNotePath(absPath)) throw new Error('不是 Markdown 笔记');
      const dedupeKey = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
      if (seen.has(dedupeKey)) throw new Error('重复的导入路径');
      seen.add(dedupeKey);

      // 身份只由 externalKey 决定（vault 绝对路径 hash + 规范化相对路径），不能用文件名判断。
      const externalKey = markdownExternalKey(vaultRoot, relativePath);
      const folderPath = relativeDirOf(relativePath);
      const existing = store.findNoteByExternalKey('', externalKey);
      if (existing && duplicatePolicy === 'skip') {
        // 已导入过且策略为 skip：不读文件、不复制附件、不写库、不改链接。
        item.status = 'skipped';
        item.noteId = existing.id;
        item.message = '文件已导入过，按跳过策略跳过';
        report.skipped += 1;
        report.skippedExisting += 1;
        skippedExistingIds.add(existing.id);
        report.notes.push(item);
        if (index % 5 === 4) await yieldToEventLoop();
        continue;
      }

      const frontmatterResult = stripFrontmatter(
        readFileSync(absPath, 'utf8'),
        report,
        relativePath
      );
      const frontmatterTags = frontmatterResult.tags;
      let content = frontmatterResult.content.replace(/\r\n?/g, '\n');
      content = preprocessMarkdown(content, report, relativePath);
      const bodyTags = extractBodyTags(content);
      const tags = [...new Set([...frontmatterTags, ...bodyTags])];
      content = await replaceEmbeds(
        store,
        vaultRoot,
        absPath,
        content,
        attachmentsByBasename,
        report
      );

      // 写入笔记前登记文件夹层级（Markdown 导入产生的目录必须能重命名/删除）。
      store.ensureNoteFolderHierarchy(folderPath);
      let noteId: string;
      if (existing) {
        if (existing.deleted) store.restoreNote(existing.id);
        store.updateNote(existing.id, { content, folderPath, tags });
        noteId = existing.id;
        report.updated += 1;
        item.status = 'updated';
      } else {
        const note = store.createNote({
          documentId: '',
          page: 0,
          content,
          externalKey,
          folderPath,
          tags
        });
        noteId = note.id;
        report.imported += 1;
        item.status = 'imported';
      }
      item.noteId = noteId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      item.message = message;
      const skipMessages = new Set([
        '路径为空',
        '必须是库内相对路径',
        '路径越界，已拒绝',
        '文件不存在',
        '不是 Markdown 笔记',
        '重复的导入路径'
      ]);
      if (skipMessages.has(message)) {
        item.status = 'skipped';
        report.skipped += 1;
      } else {
        item.status = 'failed';
        report.failed += 1;
      }
    }
    report.notes.push(item);
    if (index % 5 === 4) await yieldToEventLoop();
  }

  // resolving：扫描同一 vault 的所有已导入笔记，把可解析的 [[target]] 改写为内部引用。
  if (!cancelled && !checkCancel()) {
    hooks.onProgress?.({
      phase: 'resolving',
      done: report.notes.length,
      total: input.files.length,
      currentPath: ''
    });
    const imported = store.listNotesByExternalKeyPrefix(keyPrefix);
    const mapping = buildMapping(
      imported.map((note) => ({
        id: note.id,
        relativePath: note.externalKey.startsWith(keyPrefix)
          ? note.externalKey.slice(keyPrefix.length)
          : note.folderPath || ''
      }))
    );
    for (let index = 0; index < imported.length; index += 1) {
      if (checkCancel()) {
        cancelled = true;
        break;
      }
      const note = imported[index]!;
      const sourceRelativePath = note.externalKey.startsWith(keyPrefix)
        ? note.externalKey.slice(keyPrefix.length)
        : note.folderPath || '';
      if (!skippedExistingIds.has(note.id)) {
        try {
          const result = rewriteLinks(note.content, sourceRelativePath, mapping, report);
          report.linksRewritten += result.rewritten;
          report.unresolvedLinks += result.unresolved;
          if (result.content !== note.content) {
            store.updateNote(note.id, { content: result.content });
          }
        } catch (error) {
          report.failed += 1;
          addWarning(
            report,
            `链接解析失败：${sourceRelativePath}（${error instanceof Error ? error.message : String(error)}）`
          );
        }
      }
      hooks.onProgress?.({
        phase: 'resolving',
        done: index + 1,
        total: imported.length,
        currentPath: sourceRelativePath
      });
      if (index % 5 === 4) await yieldToEventLoop();
    }
  }

  hooks.onProgress?.({
    phase: 'finalizing',
    done: report.notes.length,
    total: input.files.length,
    currentPath: ''
  });
  return { report, cancelled: cancelled || checkCancel() };
}

// ---------------------------------------------------------------------------
// 扫描后台任务 + 任务快照持久化
// settings 只存小快照；完整结果 gzip 压缩后写独立文件（兼容旧 .json 并自动迁移）。
// ---------------------------------------------------------------------------

interface ResultFilePair {
  /** 最新格式（gzip）文件名。 */
  gzipName: string;
  /** 旧格式（未压缩 JSON）文件名，用于兼容/迁移。 */
  legacyName: string;
}

const IMPORT_RESULT: ResultFilePair = {
  gzipName: 'markdown-import-result.json.gz',
  legacyName: 'markdown-import-result.json'
};
const SCAN_RESULT: ResultFilePair = {
  gzipName: 'markdown-scan-result.json.gz',
  legacyName: 'markdown-scan-result.json'
};

function resultFilePath(store: Store, name: string): string {
  return path.join(store.dataDir, name);
}

const RESULT_ENVELOPE_VERSION = 1;

function resultSidecarPath(store: Store, pair: ResultFilePair): string {
  return resultFilePath(store, `${pair.gzipName}.sha256`);
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 原子写 sidecar（内容 sha256 + 大小），供热路径免解压校验。 */
function writeResultSidecar(store: Store, pair: ResultFilePair, buffer: Buffer): void {
  const sidecarFile = resultSidecarPath(store, pair);
  const tempFile = `${sidecarFile}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify({ sha256: sha256Hex(buffer), size: buffer.length }));
    try {
      renameSync(tempFile, sidecarFile);
    } catch {
      writeFileSync(sidecarFile, JSON.stringify({ sha256: sha256Hex(buffer), size: buffer.length }));
    }
  } catch {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch {
      // 清理失败忽略
    }
  }
}

/** 读取 sidecar；缺失/损坏返回 null。 */
function readResultSidecar(store: Store, pair: ResultFilePair): { sha256: string; size: number } | null {
  try {
    const sidecarFile = resultSidecarPath(store, pair);
    if (!existsSync(sidecarFile)) return null;
    const parsed = JSON.parse(readFileSync(sidecarFile, 'utf8')) as {
      sha256?: unknown;
      size?: unknown;
    };
    if (typeof parsed.sha256 !== 'string') return null;
    return {
      sha256: parsed.sha256,
      size: typeof parsed.size === 'number' ? parsed.size : -1
    };
  } catch {
    return null;
  }
}

/** 原子写 gzip envelope `{version, completedAt, data}` + sidecar；成功后删除旧 .json 与残留 tmp。 */
function writeResultGzip(
  store: Store,
  pair: ResultFilePair,
  value: unknown,
  completedAt: string | null
): boolean {
  const gzipFile = resultFilePath(store, pair.gzipName);
  const legacyFile = resultFilePath(store, pair.legacyName);
  const tempFile = `${gzipFile}.tmp`;
  let payload: Buffer;
  try {
    payload = gzipSync(
      Buffer.from(JSON.stringify({ version: RESULT_ENVELOPE_VERSION, completedAt, data: value }))
    );
    writeFileSync(tempFile, payload);
    try {
      renameSync(tempFile, gzipFile);
    } catch {
      // Windows 上目标被占用等场景：退回直接覆盖。
      writeFileSync(gzipFile, payload);
    }
  } catch {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch {
      // 清理失败忽略
    }
    return false;
  }
  // 成功后写 sidecar（失败不影响结果文件本身，热路径回退解压校验）。
  writeResultSidecar(store, pair, payload);
  // 只保留一个成功结果文件：删除旧未压缩文件与残留 tmp。
  try {
    if (existsSync(legacyFile)) unlinkSync(legacyFile);
  } catch {
    // 删除失败不影响结果
  }
  return true;
}

interface ReadResult {
  value: unknown;
  completedAt: string | null;
  legacy: boolean;
}

/**
 * 读结果文件：优先 gzip envelope；兼容旧格式（未压缩 .json 或 gzip 内直接是 data）；
 * 返回 completedAt（旧格式未知为 null）与是否来自旧格式。
 */
function readResultFile(store: Store, pair: ResultFilePair): ReadResult {
  const gzipFile = resultFilePath(store, pair.gzipName);
  if (existsSync(gzipFile)) {
    try {
      const parsed = JSON.parse(gunzipSync(readFileSync(gzipFile)).toString('utf8')) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'data' in (parsed as Record<string, unknown>) &&
        'version' in (parsed as Record<string, unknown>)
      ) {
        const envelope = parsed as {
          version?: number;
          completedAt?: string | null;
          data?: unknown;
        };
        return {
          value: envelope.data ?? null,
          completedAt: envelope.completedAt ?? null,
          legacy: false
        };
      }
      // 旧 gzip：直接存 data，无 envelope。
      return { value: parsed, completedAt: null, legacy: true };
    } catch {
      // gzip 损坏：继续尝试旧 json。
    }
  }
  const legacyFile = resultFilePath(store, pair.legacyName);
  if (existsSync(legacyFile)) {
    try {
      return { value: JSON.parse(readFileSync(legacyFile, 'utf8')) as unknown, completedAt: null, legacy: true };
    } catch {
      return { value: null, completedAt: null, legacy: true };
    }
  }
  return { value: null, completedAt: null, legacy: false };
}

/** 清理残留 .tmp/sidecar；若只有旧 .json 则迁移成 gzip 并删除旧文件。返回是否执行了迁移。 */
function cleanupResultArtifacts(store: Store, pair: ResultFilePair): boolean {
  const gzipFile = resultFilePath(store, pair.gzipName);
  const legacyFile = resultFilePath(store, pair.legacyName);
  const sidecarFile = resultSidecarPath(store, pair);
  for (const tempFile of [
    `${gzipFile}.tmp`,
    `${legacyFile}.tmp`,
    `${sidecarFile}.tmp`
  ]) {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch {
      // 清理失败忽略
    }
  }
  if (!existsSync(gzipFile)) {
    // gzip 不存在：sidecar 无意义，清理掉避免孤儿文件。
    try {
      if (existsSync(sidecarFile)) unlinkSync(sidecarFile);
    } catch {
      // 忽略
    }
  }
  if (existsSync(gzipFile)) {
    // 最新 gzip 可解析：删除旧未压缩文件，保证只保留一个。
    const gzipRead = readResultFile(store, pair);
    if (gzipRead.value != null) {
      // 旧文件没有 sidecar（或 sidecar 与当前内容不匹配）：补写/修正 sidecar。
      if (!readResultSidecar(store, pair)) {
        try {
          writeResultSidecar(store, pair, readFileSync(gzipFile));
        } catch {
          // 忽略补写失败
        }
      }
      try {
        if (existsSync(legacyFile)) unlinkSync(legacyFile);
      } catch {
        // 忽略
      }
      return false;
    }
    // gzip 损坏但旧 json 可用：用旧内容重建 gzip（恢复优先）。
    if (existsSync(legacyFile)) {
      try {
        const legacyValue = JSON.parse(readFileSync(legacyFile, 'utf8')) as unknown;
        if (legacyValue != null) {
          writeResultGzip(store, pair, legacyValue, null);
          return true;
        }
      } catch {
        // 旧文件也损坏：下面按损坏处理
      }
    }
    return false;
  }
  if (!existsSync(legacyFile)) return false;
  const { value } = readResultFile(store, pair);
  if (value == null) {
    // 旧文件损坏：删除，避免反复解析。
    try {
      unlinkSync(legacyFile);
    } catch {
      // 忽略
    }
    return false;
  }
  writeResultGzip(store, pair, value, null);
  return true;
}

// ---------------------------------------------------------------------------
// 结果文件检查缓存：TTL（默认 1s）+ mtime/size 签名；未变化时热路径不再 stat/解析。
// ---------------------------------------------------------------------------

interface ResultArtifactCacheEntry {
  checkedAt: number;
  signature: string;
  missing: boolean;
  corrupted: boolean;
}

const resultArtifactCache = new Map<string, ResultArtifactCacheEntry>();
let resultArtifactStatCount = 0;

/** 测试用：统计实际发生的 stat 次数（TTL 内命中不计数）。 */
export function getMarkdownResultStatCount(): number {
  return resultArtifactStatCount;
}

/** 测试用：清空缓存与计数。 */
export function resetMarkdownResultCheckStats(): void {
  resultArtifactCache.clear();
  resultArtifactStatCount = 0;
}

function resultCheckTtlMs(): number {
  const raw = Number(process.env.STUDIANDA_RESULT_CHECK_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
}

function statResultArtifact(
  store: Store,
  pair: ResultFilePair
): { signature: string; missing: boolean } {
  resultArtifactStatCount += 1;
  const signatures: string[] = [];
  // sidecar 也纳入签名：sidecar 缺失/被改时触发一次重新验证/自愈。
  const files = [pair.gzipName, pair.legacyName, `${pair.gzipName}.sha256`];
  for (const file of files) {
    try {
      const stats = statSync(resultFilePath(store, file));
      // 签名包含 mtime+size+ctime+ino：覆盖「同大小同 mtime 写入」（ctime 会变）。
      signatures.push(
        `${file}:${stats.mtimeMs}:${stats.size}:${stats.ctimeMs}:${Number(stats.ino ?? 0)}`
      );
    } catch {
      signatures.push(`${file}:-`);
    }
  }
  const missing =
    signatures[0]!.endsWith(':-') && signatures[1]!.endsWith(':-');
  return { signature: signatures.join('|'), missing };
}

/**
 * 用 sidecar 校验 gzip 内容：hash 匹配 → 健康（无需解压）；不匹配/缺失返回 false 由兜底验证。
 * sidecar 与文件大小也做一致性检查。
 */
function verifyWithSidecar(store: Store, pair: ResultFilePair): boolean | null {
  const gzipFile = resultFilePath(store, pair.gzipName);
  if (!existsSync(gzipFile)) return null;
  const sidecar = readResultSidecar(store, pair);
  if (!sidecar) return null;
  try {
    const bytes = readFileSync(gzipFile);
    if (sidecar.size >= 0 && sidecar.size !== bytes.length) return false;
    return sha256Hex(bytes) === sidecar.sha256;
  } catch {
    return false;
  }
}

/**
 * 检查结果文件：TTL 内直接复用缓存；过期后 stat 一次（mtime+size+ctime+ino），
 * 签名变化时先用 sidecar 哈希比对（免解压）；缺失/不匹配才 gzip/JSON 兜底验证。
 * 返回 missing/corrupted；供 getStatus/SSE 快照使用。
 */
function checkResultArtifact(
  store: Store,
  pair: ResultFilePair
): { missing: boolean; corrupted: boolean } {
  const cacheKey = `${store.dataDir}::${pair.gzipName}`;
  const now = Date.now();
  const cached = resultArtifactCache.get(cacheKey);
  if (cached && now - cached.checkedAt < resultCheckTtlMs()) {
    return { missing: cached.missing, corrupted: cached.corrupted };
  }
  const { signature, missing } = statResultArtifact(store, pair);
  let corrupted = false;
  if (!missing && cached && cached.signature === signature) {
    // 文件没有变化：复用上次验证结果（不再读文件）。
    corrupted = cached.corrupted;
  } else if (!missing) {
    // 首次或文件发生变化：sidecar 优先，缺失/不匹配才解压验证。
    const sidecarResult = verifyWithSidecar(store, pair);
    if (sidecarResult === true) {
      corrupted = false;
    } else {
      corrupted = readResultFile(store, pair).value == null;
      if (!corrupted && existsSync(resultFilePath(store, pair.gzipName))) {
        // sidecar 缺失或错误但 gzip 本身有效：补写正确 sidecar（自愈）。
        try {
          writeResultSidecar(store, pair, readFileSync(resultFilePath(store, pair.gzipName)));
        } catch {
          // 忽略自愈失败
        }
      }
    }
  }
  resultArtifactCache.set(cacheKey, { checkedAt: now, signature, missing, corrupted });
  return { missing, corrupted };
}

function invalidateResultArtifactCache(store: Store, pair: ResultFilePair): void {
  resultArtifactCache.delete(`${store.dataDir}::${pair.gzipName}`);
}

function isVaultScan(value: unknown): value is MarkdownVaultScan {  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MarkdownVaultScan>;
  return (
    Array.isArray(candidate.notes) &&
    Array.isArray(candidate.attachments) &&
    typeof candidate.vaultPath === 'string'
  );
}

function isImportReport(value: unknown): value is MarkdownImportReport {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MarkdownImportReport>;
  return Array.isArray(candidate.notes) && typeof candidate.requested === 'number';
}

/** settings 里的报告裁剪：只保留统计 + 前 5 条警告 + 失败项明细，避免撑大 settings。 */
function trimImportReport(report: MarkdownImportReport | null): MarkdownImportReport | null {
  if (!report) return null;
  return {
    ...report,
    notes: report.notes.filter((item) => item.status === 'failed').slice(0, 20),
    warnings: report.warnings.slice(0, 5)
  };
}

function persistImportJob(store: Store, job: MarkdownImportJob): void {
  const completedAt =
    job.resultCompletedAt ?? (job.status === 'done' ? new Date().toISOString() : null);
  try {
    store.updateSettings({
      [SETTINGS_IMPORT_JOB]: JSON.stringify({
        ...job,
        resultCompletedAt: completedAt,
        report: trimImportReport(job.report),
        input: job.input ?? null
      })
    });
  } catch {
    // 任务持久化失败不影响任务本身。
  }
  // 完整报告 gzip envelope 写独立文件（仅成功完成时覆盖；失败/取消不动上一次成功结果）。
  if (job.status === 'done' && job.report) {
    writeResultGzip(store, IMPORT_RESULT, job.report, completedAt);
    invalidateResultArtifactCache(store, IMPORT_RESULT);
  }
}

function persistScanJob(store: Store, job: MarkdownScanJob): void {
  const completedAt =
    job.resultCompletedAt ?? (job.status === 'done' ? new Date().toISOString() : null);
  try {
    store.updateSettings({
      [SETTINGS_SCAN_JOB]: JSON.stringify({
        ...job,
        resultCompletedAt: completedAt,
        scan: null,
        input: job.input ?? null
      })
    });
  } catch {
    // 任务持久化失败不影响任务本身。
  }
  // 完整扫描结果 gzip envelope 写独立文件（仅成功完成时覆盖；失败/取消保留上一次结果）。
  if (job.status === 'done' && job.scan) {
    writeResultGzip(store, SCAN_RESULT, job.scan, completedAt);
    invalidateResultArtifactCache(store, SCAN_RESULT);
  }
}

function idleScanJob(): MarkdownScanJob {
  return {
    status: 'idle',
    phase: 'idle',
    total: 0,
    done: 0,
    currentPath: '',
    scan: null,
    error: '',
    input: null,
    resultCompletedAt: null,
    resultStale: false,
    resultMissing: false,
    lastAttemptStatus: ''
  };
}

let markdownScanJob: MarkdownScanJob = idleScanJob();
let markdownScanRunning = false;
let markdownScanCancelRequested = false;

function snapshotScanJob(): MarkdownScanJob {
  let job: MarkdownScanJob = { ...markdownScanJob, scan: markdownScanJob.scan };
  job = mapLegacyAttemptStatus(job);
  // 运行期 stat（TTL 缓存）：done 但结果文件被删除/外部改坏 → 立即标记缺失。
  if (job.status === 'done' && markdownJobStore) {
    const status = resultArtifactStatus(markdownJobStore, SCAN_RESULT);
    if (status.missing || status.corrupted) {
      job = {
        ...job,
        scan: null,
        resultMissing: true,
        resultStale: true,
        error: '结果文件缺失或损坏，请重新扫描'
      };
    }
  }
  return job;
}

export function getMarkdownScanStatus(): MarkdownScanJob {
  return snapshotScanJob();
}

// ---- 任务实时事件总线（SSE 用；不写 settings） ----

const markdownJobListeners = new Set<(snapshot: MarkdownJobSnapshot) => void>();

/** 当前扫描/导入任务组合快照（SSE 初始事件用）。 */
export function getMarkdownJobSnapshot(): MarkdownJobSnapshot {
  return { scanJob: snapshotScanJob(), importJob: snapshotJob() };
}

/** 订阅任务状态变化；返回取消订阅函数。 */
export function subscribeMarkdownJobChanges(
  listener: (snapshot: MarkdownJobSnapshot) => void
): () => void {
  markdownJobListeners.add(listener);
  return () => {
    markdownJobListeners.delete(listener);
  };
}

/** 任务状态任何变化（start/进度/终态/取消）都广播给订阅者。 */
function notifyJobChange(): void {
  if (markdownJobListeners.size === 0) return;
  const snapshot = getMarkdownJobSnapshot();
  for (const listener of [...markdownJobListeners]) {
    try {
      listener(snapshot);
    } catch {
      // 单个订阅者异常不影响其它订阅者。
    }
  }
}

export function cancelMarkdownScan(): MarkdownScanJob {
  if (markdownScanRunning) {
    markdownScanCancelRequested = true;
    markdownScanJob = {
      ...markdownScanJob,
      status: 'cancelled',
      lastAttemptStatus: 'cancelled',
      resultStale: Boolean(markdownScanJob.resultCompletedAt)
    };
    notifyJobChange();
  }
  return snapshotScanJob();
}

/** 后台异步扫描：逐目录/逐文件上报进度并支持取消，上限 200000 个文件。 */
async function scanVaultWithProgress(
  vaultPath: string,
  hooks: {
    onProgress?: (state: { done: number; currentPath: string }) => void;
    shouldCancel?: () => boolean;
  }
): Promise<MarkdownVaultScan | null> {
  const { root, scanBase } = assertVaultDirectory(vaultPath);
  const notes: MarkdownVaultFile[] = [];
  const attachments: MarkdownVaultFile[] = [];
  let done = 0;
  let cancelled = false;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    if (cancelled) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (hooks.shouldCancel?.()) {
        cancelled = true;
        return;
      }
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.resolve(directory, entry.name);
      if (!isInside(root, fullPath)) continue;
      let stats;
      try {
        stats = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (stats.isDirectory()) {
        await walk(fullPath, relativePath);
        if (cancelled) return;
        continue;
      }
      if (!stats.isFile()) continue;
      done += 1;
      if (done > MAX_VAULT_FILES) {
        throw new Error(`库文件数超过上限（最多 ${MAX_VAULT_FILES} 个）`);
      }
      const record: MarkdownVaultFile = {
        relativePath,
        name: entry.name,
        sizeBytes: stats.size,
        modified: stats.mtime.toISOString()
      };
      if (isNotePath(entry.name)) notes.push(record);
      else attachments.push(record);
      hooks.onProgress?.({ done, currentPath: relativePath });
      if (done % 50 === 0) await yieldToEventLoop();
    }
  };
  await walk(root, '');
  if (cancelled) return null;
  return { ...scanBase, notes, attachments };
}

/** 启动后台扫描（单并发；运行中再 start 返回当前快照）。 */
export function startMarkdownScan(store: Store, vaultPath: string): MarkdownScanJob {
  if (markdownScanRunning) return snapshotScanJob();
  // 同步校验非法路径（路由 400），后台只负责扫描进度。
  const { root } = assertVaultDirectory(vaultPath);
  const previousResult = markdownScanJob;
  markdownScanRunning = true;
  markdownScanCancelRequested = false;
  // 开始新任务前清理残留 tmp/旧 json；失败/取消不会触碰上一次成功结果文件。
  markdownJobStore = store;
  cleanupResultArtifacts(store, SCAN_RESULT);
  markdownScanJob = {
    status: 'running',
    phase: 'scanning',
    total: 0,
    done: 0,
    currentPath: '',
    scan: null,
    error: '',
    input: { vaultPath: root },
    resultCompletedAt: previousResult.resultCompletedAt ?? null,
    resultStale: previousResult.resultStale ?? false,
    resultMissing: previousResult.resultMissing ?? false,
    lastAttemptStatus: 'running'
  };
  persistScanJob(store, markdownScanJob);
  notifyJobChange();
  let lastPersisted = 0;
  void scanVaultWithProgress(root, {
    onProgress: (state) => {
      markdownScanJob = { ...markdownScanJob, done: state.done, currentPath: state.currentPath };
      notifyJobChange();
      if (state.done - lastPersisted >= 20) {
        lastPersisted = state.done;
        persistScanJob(store, markdownScanJob);
      }
    },
    shouldCancel: () => markdownScanCancelRequested
  })
    .then((scan) => {
      markdownScanRunning = false;
      if (!scan) {
        markdownScanJob = {
          ...markdownScanJob,
          status: 'cancelled',
          phase: 'scanning',
          currentPath: '',
          resultStale: Boolean(markdownScanJob.resultCompletedAt),
          resultMissing: false,
          lastAttemptStatus: 'cancelled'
        };
        persistScanJob(store, markdownScanJob);
        notifyJobChange();
        return;
      }
      const total = scan.notes.length + scan.attachments.length;
      markdownScanJob = {
        ...markdownScanJob,
        status: 'done',
        phase: 'done',
        total,
        done: total,
        currentPath: '',
        scan,
        resultCompletedAt: new Date().toISOString(),
        resultStale: false,
        resultMissing: false,
        lastAttemptStatus: 'done'
      };
      persistScanJob(store, markdownScanJob);
      notifyJobChange();
    })
    .catch((error) => {
      markdownScanRunning = false;
      markdownScanJob = {
        ...markdownScanJob,
        status: 'error',
        error: `扫描笔记库失败：${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        resultStale: Boolean(markdownScanJob.resultCompletedAt),
        resultMissing: false,
        lastAttemptStatus: 'error'
      };
      persistScanJob(store, markdownScanJob);
      notifyJobChange();
    });
  return snapshotScanJob();
}

/**
 * 启动时读回上次任务快照：持久化里 status=running 的改为 interrupted（进程重启中断），
 * done/cancelled/error 原样保留；内存里正在运行的任务优先，不被覆盖。
 *
 * 扫描/导入的完整结果 gzip 保存在 dataDir 独立文件（settings 只存小快照）；
 * 启动时清理残留 .tmp、把旧 .json 结果迁移为 gzip 并删除旧文件；
 * 兼容旧格式（scan/report 内联在 settings）：读到内联结果时迁移为独立文件。
 */
/** 校验并规范化选中/树路径（拒绝绝对路径与 `..` 越界）。 */
function validVaultRelative(value: string): string {
  const normalized = normalizeRelative(value);
  if (!normalized) return '';
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('路径必须是库内相对路径');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) throw new Error('路径越界，已拒绝');
  return segments.filter((segment) => segment && segment !== '.').join('/');
}

/** 最近一次完成的扫描结果（vaultPath 必须匹配）；没有则返回 null，不做同步扫描。 */
export function getCompletedMarkdownScan(vaultPath: string): MarkdownVaultScan | null {
  const job = markdownScanJob;
  if (job.status !== 'done' || !job.scan) return null;
  try {
    if (path.resolve(job.scan.vaultPath) === path.resolve(vaultPath)) return job.scan;
  } catch {
    return null;
  }
  return null;
}

function completedScanOrThrow(vaultPath: string): MarkdownVaultScan {
  const scan = getCompletedMarkdownScan(vaultPath);
  if (!scan) throw new Error('扫描结果不可用，请先完成扫描');
  return scan;
}

/**
 * 扫描结果树懒加载：返回 parent 目录下的直接子项（文件夹 + 文件），支持 offset/limit 分页。
 * 文件夹带 childCount（直接子项数）与 noteCount（子树内 Markdown 笔记数）。
 */
export function getMarkdownScanTree(input: {
  vaultPath: string;
  parent?: string;
  offset?: number;
  limit?: number;
}): MarkdownScanTreePage {
  const scan = completedScanOrThrow(input.vaultPath);
  const parent = validVaultRelative(input.parent ?? '');
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));

  const folderStats = new Map<string, { children: Set<string>; noteCount: number }>();
  const fileEntry = new Map<string, MarkdownVaultFile>();
  const folderSet = new Set<string>();
  const ensureFolder = (folderPath: string): { children: Set<string>; noteCount: number } => {
    let entry = folderStats.get(folderPath);
    if (!entry) {
      entry = { children: new Set<string>(), noteCount: 0 };
      folderStats.set(folderPath, entry);
    }
    return entry;
  };
  const allFiles = [...scan.notes, ...scan.attachments];
  for (const file of allFiles) {
    fileEntry.set(validVaultRelative(file.relativePath), file);
  }
  for (const relativePath of fileEntry.keys()) {
    const segments = relativePath.split('/');
    const fileName = segments[segments.length - 1]!;
    const parentFolder = segments.slice(0, -1).join('/');
    const isNote = isNotePath(fileName);
    // parentFolder 的直接子文件
    ensureFolder(parentFolder).children.add(fileName);
    // 祖先目录（含 parentFolder）的笔记计数
    for (let index = 1; index <= segments.length - 1; index += 1) {
      const folder = segments.slice(0, index).join('/');
      folderSet.add(folder);
      const stats = ensureFolder(folder);
      stats.children.add(segments[index]!);
      if (isNote) stats.noteCount += 1;
    }
    if (isNote) {
      // 根目录笔记计数归属为整个选择面（这里不单独生成根条目，只用于父目录统计）
      const rootStats = ensureFolder('');
      void rootStats;
    }
  }

  const direct: MarkdownTreeEntry[] = [];
  for (const folder of folderSet) {
    const folderParent = folder.split('/').slice(0, -1).join('/');
    if (folderParent !== parent) continue;
    const stats = ensureFolder(folder);
    direct.push({
      path: folder,
      name: folder.split('/').pop() ?? folder,
      kind: 'folder',
      childCount: stats.children.size,
      noteCount: stats.noteCount
    });
  }
  for (const [relativePath, file] of fileEntry) {
    const fileParent = relativePath.split('/').slice(0, -1).join('/');
    if (fileParent !== parent) continue;
    direct.push({
      path: relativePath,
      name: file.name,
      kind: 'file',
      sizeBytes: file.sizeBytes,
      modified: file.modified
    });
  }
  if (parent && !folderSet.has(parent)) {
    throw new Error('父路径不存在');
  }
  direct.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return {
    vaultPath: scan.vaultPath,
    parent,
    total: direct.length,
    entries: direct.slice(offset, offset + limit)
  };
}

/**
 * 服务端解析选择：全选 / 文件夹前缀 / 精确文件，并用排除项过滤；去重后返回 Markdown 笔记清单。
 * 请求但不存在（或文件夹无匹配笔记）的路径收集到 missingFiles。
 */
export function resolveMarkdownSelection(input: MarkdownSelectionInput): MarkdownSelectionResult {
  const scan = completedScanOrThrow(input.vaultPath);
  const allNotes = scan.notes.map((note) => validVaultRelative(note.relativePath));
  const allFilePaths = [...scan.notes, ...scan.attachments].map((file) =>
    validVaultRelative(file.relativePath)
  );
  const allFileSet = new Set(allFilePaths);
  const noteSet = new Set(allNotes);
  const selected = new Set<string>();
  const missingFiles = new Set<string>();
  const folders = (input.folders ?? []).map((folder) => validVaultRelative(String(folder)));
  const files = (input.files ?? []).map((file) => validVaultRelative(String(file)));
  const excludedFolders = (input.excludedFolders ?? []).map((folder) =>
    validVaultRelative(String(folder))
  );
  const excludedFiles = new Set(
    (input.excludedFiles ?? []).map((file) => validVaultRelative(String(file)))
  );

  const addFile = (relativePath: string): void => {
    if (noteSet.has(relativePath)) selected.add(relativePath);
  };
  if (input.all === true) {
    for (const note of allNotes) selected.add(note);
  } else {
    for (const folder of folders) {
      if (!folder) {
        for (const note of allNotes) selected.add(note);
        continue;
      }
      const prefix = `${folder}/`;
      const matched = allNotes.filter((note) => note.startsWith(prefix));
      if (matched.length === 0) missingFiles.add(folder);
      for (const note of matched) selected.add(note);
    }
    for (const file of files) {
      if (!allFileSet.has(file)) missingFiles.add(file);
      addFile(file);
    }
  }
  for (const file of excludedFiles) selected.delete(file);
  for (const folder of excludedFolders) {
    if (!folder) {
      selected.clear();
      continue;
    }
    const prefix = `${folder}/`;
    for (const note of [...selected]) if (note.startsWith(prefix)) selected.delete(note);
  }
  const result = allNotes.filter((note) => selected.has(note));
  return {
    files: result,
    count: result.length,
    missingFiles: [...missingFiles]
  };
}

/** 在最近扫描结果中按相对路径/文件名做大小写不敏感子串搜索（仅 Markdown 笔记），支持分页。 */
export function searchMarkdownScan(
  vaultPath: string,
  query: string,
  limit = 50,
  offset = 0
): MarkdownScanSearchResult {
  const scan = completedScanOrThrow(vaultPath);
  const needle = (query ?? '').trim().toLowerCase();
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const entries: MarkdownTreeEntry[] = [];
  for (const note of scan.notes) {
    const relativePath = validVaultRelative(note.relativePath);
    if (
      needle &&
      !relativePath.toLowerCase().includes(needle) &&
      !note.name.toLowerCase().includes(needle)
    ) {
      continue;
    }
    entries.push({
      path: relativePath,
      name: note.name,
      kind: 'file',
      sizeBytes: note.sizeBytes,
      modified: note.modified
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    total: entries.length,
    offset: safeOffset,
    limit: safeLimit,
    entries: entries.slice(safeOffset, safeOffset + safeLimit)
  };
}

/** 最近一次导入报告的明细分页；无报告返回 null。 */
export function getMarkdownImportReportPage(
  offset: number,
  limit: number
): MarkdownImportReportPage | null {
  let report = markdownImportJob.report;
  if (!report && markdownJobStore) {
    const read = readResultFile(markdownJobStore, IMPORT_RESULT);
    if (isImportReport(read.value)) report = read.value;
  }
  if (!report) return null;
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  return {
    total: report.notes.length,
    offset: safeOffset,
    limit: safeLimit,
    items: report.notes.slice(safeOffset, safeOffset + safeLimit)
  };
}

/**
 * 启动时读回上次任务快照：持久化里 status=running 的改为 interrupted（进程重启中断），
 * done/cancelled/error 原样保留；内存里正在运行的任务优先，不被覆盖。
 *
 * 扫描/导入的完整结果 gzip 保存在 dataDir 独立文件（settings 只存小快照）；
 * 启动时清理残留 .tmp、把旧 .json 结果迁移为 gzip 并删除旧文件；
 * 兼容旧格式（scan/report 内联在 settings）：读到内联结果时迁移为独立文件。
 */
export function hydrateMarkdownJobs(store: Store): void {
  markdownJobStore = store;
  // 启动清理/迁移：只保留一个成功结果文件（最新 gzip）；失败/取消不清除成功结果。
  resultArtifactCache.clear();
  cleanupResultArtifacts(store, IMPORT_RESULT);
  cleanupResultArtifacts(store, SCAN_RESULT);
  const settings = store.getSettings();
  const rawImport = settings[SETTINGS_IMPORT_JOB];
  if (rawImport && !markdownImportRunning) {
    try {
      const parsed = JSON.parse(rawImport) as MarkdownImportJob;
      const status = parsed.status === 'running' ? 'interrupted' : parsed.status;
      let report: MarkdownImportReport | null = parsed.report ?? null;
      const read = readResultFile(store, IMPORT_RESULT);
      let resultMissing = false;
      if (status === 'done' || status === 'cancelled') {
        if (isImportReport(read.value)) report = read.value;
        else if (status === 'done') {
          report = null;
          resultMissing = true;
        }
      }
      report = withReportDefaults(report);
      const completedAt = parsed.resultCompletedAt ?? read.completedAt ?? null;
      let lastAttemptStatus: MarkdownImportJob['lastAttemptStatus'] =
        status === 'interrupted'
          ? 'interrupted'
          : (parsed.lastAttemptStatus ??
            (status === 'done'
              ? 'done'
              : status === 'cancelled'
                ? 'cancelled'
                : status === 'error'
                  ? 'error'
                  : ''));
      // 兼容旧 settings 的 'failed' 命名。
      if (String(lastAttemptStatus) === 'failed') lastAttemptStatus = 'error';
      const missing = status === 'done' && resultMissing;
      markdownImportJob = {
        ...idleJob(),
        ...parsed,
        report,
        input: parsed.input ?? null,
        status,
        resultCompletedAt: completedAt,
        resultStale: status === 'done' ? missing : Boolean(completedAt),
        resultMissing: missing,
        lastAttemptStatus,
        error:
          parsed.status === 'running'
            ? '上次任务因进程重启中断'
            : missing
              ? '结果文件缺失或损坏，请重新导入'
              : String(parsed.error ?? '')
      };
    } catch {
      // 快照损坏时忽略，保持 idle。
    }
  }
  const rawScan = settings[SETTINGS_SCAN_JOB];
  if (rawScan && !markdownScanRunning) {
    try {
      const parsed = JSON.parse(rawScan) as MarkdownScanJob;
      const status = parsed.status === 'running' ? 'interrupted' : parsed.status;
      let scan: MarkdownVaultScan | null = null;
      let migrateInline = false;
      const read = readResultFile(store, SCAN_RESULT);
      let resultMissing = false;
      if (isVaultScan(parsed.scan)) {
        // 旧格式：完整 scan 内联在 settings 里。
        scan = parsed.scan;
        migrateInline = true;
      } else if (status === 'done') {
        if (isVaultScan(read.value)) scan = read.value;
        else resultMissing = true;
      }
      const completedAt = parsed.resultCompletedAt ?? read.completedAt ?? null;
      let lastAttemptStatus: MarkdownScanJob['lastAttemptStatus'] =
        status === 'interrupted'
          ? 'interrupted'
          : (parsed.lastAttemptStatus ??
            (status === 'done'
              ? 'done'
              : status === 'cancelled'
                ? 'cancelled'
                : status === 'error'
                  ? 'error'
                  : ''));
      if (String(lastAttemptStatus) === 'failed') lastAttemptStatus = 'error';
      const missing = status === 'done' && resultMissing;
      markdownScanJob = {
        ...idleScanJob(),
        ...parsed,
        scan,
        input: parsed.input ?? null,
        status,
        resultCompletedAt: completedAt,
        resultStale: status === 'done' ? missing : Boolean(completedAt),
        resultMissing: missing,
        lastAttemptStatus,
        error:
          parsed.status === 'running'
            ? '上次任务因进程重启中断'
            : missing
              ? '结果文件缺失或损坏，请重新扫描'
              : String(parsed.error ?? '')
      };
      if (migrateInline && status === 'done') persistScanJob(store, markdownScanJob);
    } catch {
      // 快照损坏时忽略。
    }
  }
}

