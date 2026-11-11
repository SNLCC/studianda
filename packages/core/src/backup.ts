import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import type { BackupRecord } from '@studianda/shared';
import type { Store } from './store.js';

const PREFIX = 'studianda-data-';
const EXCLUDED_DIRS = new Set(['backups', 'diagnostics', 'cache', 'migration-backups']);
const EXCLUDED_PREFIXES = ['.pre-restore-', '.restore-staging-', '.studianda-lock'];
const MARKER_NAME = 'restore-pending.json';
const SKIP_SUFFIXES = ['-wal', '-shm', '-journal'];

export interface BackupResult {
  backup: BackupRecord;
  files: number;
  databases: string[];
  entries: string[];
}

/** 备份进度（文件收集阶段可取消；zip 压缩阶段是同步阻塞）。 */
export interface BackupProgress {
  stage: 'databases' | 'files' | 'zip' | 'done';
  percent: number;
  filesDone?: number;
  filesTotal?: number;
}

export class BackupCancelledError extends Error {
  constructor() {
    super('备份已取消');
    this.name = 'BackupCancelledError';
  }
}

export function requestRestore(
  dataDir: string,
  name: string
): { marker: string; pending: PendingRestore } {
  const verified = verifyBackup(dataDir, name);
  if (verified.integrity !== 'ok') {
    throw new Error(`备份数据库完整性检查失败：${verified.integrity}`);
  }
  const pending: PendingRestore = {
    backup: name,
    requestedAt: new Date().toISOString()
  };
  const marker = path.join(dataDir, MARKER_NAME);
  writeFileSync(marker, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  return { marker, pending };
}

export function pendingRestore(dataDir: string): PendingRestore | null {
  const marker = path.join(dataDir, MARKER_NAME);
  if (!existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as Partial<PendingRestore>;
    return typeof parsed.backup === 'string' && parsed.backup
      ? { backup: parsed.backup, requestedAt: String(parsed.requestedAt ?? '') }
      : null;
  } catch {
    return null;
  }
}

/** 启动时调用：先完整解压校验，再原子换入；旧数据保留在 .pre-restore-*。 */
export function applyPendingRestore(dataDir: string): RestoreResult | null {
  const pending = pendingRestore(dataDir);
  if (!pending) return null;
  const backupPath = path.join(backupFolder(dataDir), pending.backup);
  if (!existsSync(backupPath)) throw new Error('待恢复的备份不存在');
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(readFileSync(backupPath)));
  } catch {
    throw new Error('待恢复的备份不是有效 zip');
  }
  const stageName = `.restore-staging-${randomUUID()}`;
  const staging = path.join(dataDir, stageName);
  mkdirSync(staging, { recursive: true });
  try {
    let files = 0;
    for (const [relative, bytes] of Object.entries(archive)) {
      const normalized = relative.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new Error('备份包含非法路径');
      }
      if (normalized === MARKER_NAME) continue;
      const target = path.join(staging, normalized);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      files += 1;
    }
    const stagedDatabases = readdirSync(staging).filter((name) => name.endsWith('.sqlite3'));
    if (stagedDatabases.length === 0) throw new Error('备份里没有数据库快照');
    const db = new DatabaseSync(path.join(staging, stagedDatabases[0]!), {
      readOnly: true
    });
    try {
      const rows = db.prepare('PRAGMA quick_check').all() as unknown as Array<
        Record<string, unknown>
      >;
      const integrity = rows
        .map((row) => String(Object.values(row)[0] ?? ''))
        .filter(Boolean)
        .join('; ') || 'ok';
      if (integrity !== 'ok') throw new Error(`备份数据库完整性检查失败：${integrity}`);
    } finally {
      db.close();
    }

    const rollbackDir = path.join(dataDir, `.pre-restore-${stamp()}`);
    mkdirSync(rollbackDir, { recursive: true });
    const preserved = new Set(['backups', 'diagnostics', MARKER_NAME]);
    const current = readdirSync(dataDir).filter(
      (name) =>
        !preserved.has(name) &&
        name !== stageName &&
        !name.startsWith('.pre-restore-') &&
        !name.startsWith('.restore-staging-')
    );
    for (const name of current) {
      renameSync(path.join(dataDir, name), path.join(rollbackDir, name));
    }
    try {
      for (const name of readdirSync(staging)) {
        renameSync(path.join(staging, name), path.join(dataDir, name));
      }
    } catch (error) {
      // 换入失败：把旧数据移回，避免留下“新旧混在一起”的目录。
      for (const name of readdirSync(dataDir)) {
        if (preserved.has(name) || name.startsWith('.pre-restore-')) continue;
        try {
          rmSync(path.join(dataDir, name), { recursive: true, force: true });
        } catch {
          // 尽力回滚；原始错误仍向上抛出。
        }
      }
      for (const name of readdirSync(rollbackDir)) {
        renameSync(path.join(rollbackDir, name), path.join(dataDir, name));
      }
      throw error;
    }
    rmSync(path.join(dataDir, MARKER_NAME), { force: true });
    rmSync(staging, { recursive: true, force: true });
    return { restored: pending.backup, rollbackDir, files };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBackup(dataDir: string, name: string): BackupVerification {
  if (path.basename(name) !== name || !name.startsWith(PREFIX) || !name.endsWith('.zip')) {
    throw new Error('备份文件名不合法');
  }
  const target = path.join(backupFolder(dataDir), name);
  if (!existsSync(target)) throw new Error('备份不存在');
  const info = statSync(target);
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(readFileSync(target)));
  } catch {
    throw new Error('备份不是有效 zip');
  }
  const databases = Object.keys(archive)
    .filter((entry) => entry.endsWith('.sqlite3'))
    .sort();
  if (databases.length === 0) throw new Error('备份里没有数据库快照');
  const temporary = path.join(tmpdir(), `studianda-verify-${randomUUID()}.sqlite3`);
  let integrity = '';
  try {
    writeFileSync(temporary, archive[databases[0]!]!);
    const db = new DatabaseSync(temporary, { readOnly: true });
    try {
      const rows = db.prepare('PRAGMA quick_check').all() as unknown as Array<
        Record<string, unknown>
      >;
      integrity = rows
        .map((row) => String(Object.values(row)[0] ?? ''))
        .filter(Boolean)
        .join('; ') || 'ok';
    } finally {
      db.close();
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件清理失败不影响校验结果。
    }
  }
  return {
    name,
    sizeBytes: info.size,
    entries: Object.keys(archive).length,
    databases,
    integrity
  };
}


export interface BackupVerification {
  name: string;
  sizeBytes: number;
  entries: number;
  databases: string[];
  integrity: string;
}

export interface PendingRestore {
  backup: string;
  requestedAt: string;
}

export interface RestoreResult {
  restored: string;
  rollbackDir: string;
  files: number;
}

export function backupFolder(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

function stamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function nextTarget(folder: string): string {
  const base = `${PREFIX}${stamp()}`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const name = `${base}${attempt === 1 ? '' : `-${attempt}`}.zip`;
    const target = path.join(folder, name);
    if (!existsSync(target)) return target;
  }
  throw new Error('备份文件重名过多，未能生成新文件。');
}

function collectRelativePaths(
  dataDir: string,
  databaseNames: Set<string>,
  includeLogs: boolean
): string[] {
  const output: string[] = [];
  const walk = (folder: string, relativeBase: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue;
        if (EXCLUDED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
        walk(path.join(folder, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === MARKER_NAME) continue;
      // 单实例锁/旧版锁文件不进备份：恢复时不能把锁状态带回来。
      if (entry.name === '.instance-lock.sqlite3' || entry.name === '.studianda-lock') continue;
      if (relativeBase === '' && databaseNames.has(entry.name)) continue;
      if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      if (!includeLogs && entry.name.toLowerCase().endsWith('.log')) continue;
      output.push(relative);
    }
  };
  walk(dataDir, '');
  return output;
}

export async function createSnapshot(
  store: Store,
  options: {
    includeLogs?: boolean;
    outputFolder?: string;
    onProgress?: (progress: BackupProgress) => void;
    isCancelled?: () => boolean;
  } = {}
): Promise<BackupResult> {
  const dataDir = store.dataDir;
  if (!existsSync(dataDir)) throw new Error(`数据目录不存在：${dataDir}`);
  const folder = options.outputFolder ?? backupFolder(dataDir);
  mkdirSync(folder, { recursive: true });
  const staging = path.join(folder, `.staging-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    if (options.isCancelled?.()) throw new BackupCancelledError();
    const databases = readdirSync(dataDir)
      .filter((name) => name.endsWith('.sqlite3'))
      .sort();
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < databases.length; index += 1) {
      if (options.isCancelled?.()) throw new BackupCancelledError();
      const name = databases[index]!;
      const target = path.join(staging, name);
      store.backupDatabase(target);
      entries[name] = new Uint8Array(readFileSync(target));
      options.onProgress?.({
        stage: 'databases',
        percent: 5 + Math.floor(((index + 1) / Math.max(1, databases.length)) * 10)
      });
    }

    const relativePaths = collectRelativePaths(dataDir, new Set(databases), options.includeLogs === true);
    const total = relativePaths.length;
    for (let index = 0; index < total; index += 1) {
      if (options.isCancelled?.()) throw new BackupCancelledError();
      const relative = relativePaths[index]!;
      entries[relative] = new Uint8Array(
        readFileSync(path.join(dataDir, ...relative.split('/')))
      );
      // 每 10 个文件让出事件循环，让取消请求/进度查询有机会被处理。
      if ((index + 1) % 10 === 0 || index + 1 === total) {
        options.onProgress?.({
          stage: 'files',
          percent: 20 + Math.floor(((index + 1) / Math.max(1, total)) * 60),
          filesDone: index + 1,
          filesTotal: total
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (options.isCancelled?.()) throw new BackupCancelledError();
    options.onProgress?.({ stage: 'zip', percent: 85 });
    const target = nextTarget(folder);
    const zipped = zipSync(entries);
    if (options.isCancelled?.()) throw new BackupCancelledError();
    writeFileSync(target, zipped);
    const info = statSync(target);
    options.onProgress?.({ stage: 'done', percent: 100 });
    return {
      backup: {
        name: path.basename(target),
        path: target,
        sizeBytes: info.size,
        created: info.mtime.toISOString()
      },
      files: total,
      databases,
      entries: Object.keys(entries).sort()
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function listBackups(dataDir: string): BackupRecord[] {  const folder = backupFolder(dataDir);
  if (!existsSync(folder)) return [];
  const items: BackupRecord[] = [];
  for (const name of readdirSync(folder)) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.zip')) continue;
    const target = path.join(folder, name);
    try {
      const info = statSync(target);
      items.push({
        name,
        path: target,
        sizeBytes: info.size,
        created: info.mtime.toISOString()
      });
    } catch {
      // 读取失败的备份不展示；不伪造记录。
    }
  }
  return items.sort((left, right) => right.created.localeCompare(left.created)).slice(0, 50);
}
