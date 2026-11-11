import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { BackupRecord, DiagnosticsPackageRecord } from '@studianda/shared';
import type { Store } from './store.js';
import { listBackups } from './backup.js';
import {
  errorLogPath,
  readRecentErrors,
  redactSensitive,
  type ErrorLogEntry
} from './error-log.js';

export interface DiagnosticsReport {
  generatedAt: string;
  app: {
    name: string;
    version: string;
    platform: string;
    node: string;
  };
  /** 运行环境：OS/架构/CPU/内存/运行时版本（排障时确认用户到底装在哪）。 */
  environment: {
    platform: string;
    arch: string;
    release: string;
    cpus: number;
    totalMemoryBytes: number;
    versions: Record<string, string>;
  };
  /** 代码版本（开发/源码运行时为 git describe；打包运行通常为空）。 */
  git: string;
  /**
   * 关键依赖版本：
   * 只读，读不到的包如实列进 `missing`，不阻断诊断包生成。
   */
  dependencies: {
    node: string;
    electron: string;
    packages: Record<string, string>;
    missing: string[];
  };
  counts: Record<string, number>;
  integrity: string;
  missingFiles: number;
  recentErrors: ErrorLogEntry[];
  failedTasks: Array<{
    category: string;
    count: number;
    lastContext: string;
    lastMessage: string;
    lastTimestamp: string;
  }>;
  usage: {
    databaseBytes: number;
    papersBytes: number;
    backupsBytes: number;
    backups: number;
  };
}

/** 诊断包最多保留 5 个；更旧的按创建时间删除。 */
const MAX_DIAGNOSTICS_PACKAGES = 5;
/** 只带日志尾部，避免把陈年日志整份塞进包里。 */
const LOG_TAIL_BYTES = 256 * 1024;
const PACKAGE_PREFIX = 'studianda-diagnostics-';

function diagnosticsDir(store: Store): string {
  return path.join(store.dataDir, 'diagnostics');
}

function readLogTail(dataDir: string): string {
  const file = errorLogPath(dataDir);
  if (!existsSync(file)) return '';
  try {
    const buffer = readFileSync(file);
    const tail = buffer.subarray(Math.max(0, buffer.byteLength - LOG_TAIL_BYTES));
    return redactSensitive(tail.toString('utf8'));
  } catch {
    return '';
  }
}

function prunePackages(store: Store): void {
  const packages = listDiagnosticsPackages(store);
  for (const stale of packages.slice(MAX_DIAGNOSTICS_PACKAGES)) {
    try {
      unlinkSync(stale.path);
    } catch {
      // 删不掉旧包不影响本次导出。
    }
  }
}

/** 已导出的诊断包列表（按创建时间从新到旧）。 */
export function listDiagnosticsPackages(store: Store): DiagnosticsPackageRecord[] {
  const dir = diagnosticsDir(store);
  if (!existsSync(dir)) return [];
  const rows: DiagnosticsPackageRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(PACKAGE_PREFIX) || !name.endsWith('.zip')) continue;
    const file = path.join(dir, name);
    try {
      const stats = statSync(file);
      rows.push({
        name,
        path: file,
        bytes: stats.size,
        createdAt: new Date(stats.mtimeMs).toISOString()
      });
    } catch {
      // 文件刚好被清理：跳过。
    }
  }
  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * 生成诊断包（zip）写入 `dataDir/diagnostics/`：
 * - diagnostics.json：脱敏诊断报告（完整性/计数/用量/失败任务分类等）；
 * - recent-errors.json：最近 100 条脱敏错误日志；
 * - logs/application.log：当前日志尾部（最多 256KB）。
 *
 * **不含 PDF、文献正文或密钥**；最多保留最近 5 个包。文件名带 UTC 时间。
 */
export function createDiagnosticsPackage(
  store: Store,
  app: { name: string; version: string }
): { path: string; name: string; bytes: number } {
  const dir = diagnosticsDir(store);
  mkdirSync(dir, { recursive: true });
  const report = generateDiagnostics(store, app);
  const entries: Record<string, Uint8Array> = {
    'diagnostics.json': strToU8(JSON.stringify(report, null, 2)),
    'recent-errors.json': strToU8(
      JSON.stringify(readRecentErrors(store.dataDir, 100), null, 2)
    ),
    'README.txt': strToU8(
      '勘读诊断包：只包含脱敏诊断报告与最近错误日志；不包含 PDF、文献正文或密钥。\n'
    )
  };
  const logTail = readLogTail(store.dataDir);
  if (logTail) entries['logs/application.log'] = strToU8(logTail);
  const zipped = zipSync(entries, { level: 6 });
  const name = `${PACKAGE_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const target = path.join(dir, name);
  writeFileSync(target, zipped);
  prunePackages(store);
  return { path: target, name, bytes: zipped.byteLength };
}

function directoryBytes(folder: string): number {
  if (!existsSync(folder)) return 0;
  let total = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += statSync(target).size;
      } catch {
        // 读不到的文件不猜测大小。
      }
    }
  };
  walk(folder);
  return total;
}

function classifyFailure(context: string): string {
  const value = context.toLowerCase();
  if (value.includes('/chat/ask') || value.includes('/chat/continue')) return '问答/阅读';
  if (value.includes('/translation')) return '翻译';
  if (value.includes('/parsing') || value.includes('/ocr')) return '识别/OCR';
  if (value.includes('/zotero')) return 'Zotero';
  if (value.includes('/backup')) return '备份/恢复';
  if (value.includes('/speech')) return '语音';
  if (value.includes('/search') || value.includes('/web')) return '联网';
  return '其他';
}

function failedTasks(errors: ErrorLogEntry[]): Array<{
  category: string;
  count: number;
  lastContext: string;
  lastMessage: string;
  lastTimestamp: string;
}> {
  const grouped = new Map<string, { count: number; last: ErrorLogEntry }>();
  for (const entry of errors) {
    const category = classifyFailure(entry.context);
    const existing = grouped.get(category);
    if (existing) {
      existing.count += 1;
      existing.last = entry;
    } else {
      grouped.set(category, { count: 1, last: entry });
    }
  }
  return [...grouped.entries()]
    .map(([category, value]) => ({
      category,
      count: value.count,
      lastContext: value.last.context,
      lastMessage: value.last.message,
      lastTimestamp: value.last.timestamp
    }))
    .sort((left, right) => right.count - left.count);
}

/** 尽量拿到源码版本；打包运行/没有 git 时返回空串（不报错、不猜版本）。 */
function gitDescription(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: process.cwd(),
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .trim()
      .slice(0, 120);
  } catch {
    return '';
  }
}

/** 诊断包里带的关键依赖。 */
const DEPENDENCY_PACKAGES = [
  'pdfjs-dist',
  'pdf-lib',
  '@napi-rs/canvas',
  'tesseract.js',
  'fflate',
  'fastify',
  '@fastify/multipart'
] as const;

const requireFromCore = createRequire(import.meta.url);

/**
 * 读取一个已安装依赖的版本；只读、失败返回空串。
 * 先解析包入口再向上找 package.json（兼容 exports 不暴露 package.json 的包），
 * 找不到时再试直接 require `<pkg>/package.json`。
 */
function dependencyVersion(name: string): string {
  try {
    let dir = path.dirname(requireFromCore.resolve(name));
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
            name?: unknown;
            version?: unknown;
          };
          if (
            parsed.name === name &&
            typeof parsed.version === 'string' &&
            parsed.version.trim()
          ) {
            return parsed.version.trim();
          }
        } catch {
          // 损坏的 package.json 不阻断，继续向上找。
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // 入口解析失败时退回直接读 package.json。
  }
  try {
    const direct = requireFromCore(`${name}/package.json`) as { version?: unknown };
    return typeof direct.version === 'string' ? direct.version.trim() : '';
  } catch {
    return '';
  }
}

/** 运行时 + 关键依赖版本；读不到的包列进 missing，不抛错。 */
function dependencyVersions(): DiagnosticsReport['dependencies'] {
  const packages: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of DEPENDENCY_PACKAGES) {
    const version = dependencyVersion(name);
    if (version) packages[name] = version;
    else missing.push(name);
  }
  return {
    node: process.versions.node,
    electron: (process.versions as Record<string, string | undefined>).electron ?? '',
    packages,
    missing
  };
}

export function generateDiagnostics(
  store: Store,
  app: { name: string; version: string }
): DiagnosticsReport {
  const databasePath = path.join(store.dataDir, 'reader.sqlite3');
  let databaseBytes = 0;
  try {
    databaseBytes = statSync(databasePath).size;
  } catch {
    databaseBytes = 0;
  }
  const papers = path.join(store.dataDir, 'papers');
  const backups: BackupRecord[] = listBackups(store.dataDir);
  const recentErrors = readRecentErrors(store.dataDir, 20);
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: app.name,
      version: app.version,
      platform: process.platform,
      node: process.version
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      versions: Object.fromEntries(
        ['node', 'v8', 'openssl', 'uv', 'zlib']
          .map((name) => [name, process.versions[name as keyof typeof process.versions]])
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    },
    git: gitDescription(),
    dependencies: dependencyVersions(),
    counts: store.diagnosticCounts(),
    integrity: store.quickCheck(),
    missingFiles: store.missingDocumentFiles(),
    recentErrors,
    failedTasks: failedTasks(recentErrors),
    usage: {
      databaseBytes,
      papersBytes: directoryBytes(papers),
      backupsBytes: directoryBytes(path.join(store.dataDir, 'backups')),
      backups: backups.length
    }
  };
}
