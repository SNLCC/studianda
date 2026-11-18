#!/usr/bin/env node
/**
 * 旧库升级验证脚本（可重复，默认只碰临时副本）。
 *
 * 用法：
 *   node scripts/verify-migration.mjs <资料目录副本> [--yes]
 *   node scripts/verify-migration.mjs <资料目录> --yes      # 确认该目录已经是副本后才可对非临时路径运行
 *
 * 它做什么：
 *   1. 只读地计算源目录 reader.sqlite3 的 sha256，然后**整体复制**到系统临时目录；
 *   2. 在副本上报告迁移前的 schema_version / 表清单 / 行数（documents、notes、annotations、messages…）；
 *   3. 直接调用真实的 `Store` 构造函数（内部执行 store.ts 的 `migrate()`，含迁移前 VACUUM INTO 快照），
 *      记录迁移耗时；
 *   4. 迁移后报告 schema_version / 表清单 / 行数 / 新增或删除的表，并跑 `PRAGMA integrity_check`；
 *   5. 复核源目录 reader.sqlite3 的 sha256 未变（证明从未改动原目录），最后给出 PASS/FAIL。
 *
 * 安全约定：
 *   - 脚本**永远不写**传入的目录；所有迁移都在一次性临时副本上完成（成功即删，失败时保留并打印路径）。
 *   - 传入目录不在系统临时目录下时，必须显式加 `--yes`（防止把正在使用的原目录当副本误操作）。
 *
 * 注意：迁移实现取自 packages/core/src/store.ts（esbuild 现场打包，确保测的是当前源码而不是过期 dist）；
 * 需要仓库已安装依赖（esbuild 为根目录 devDependency）。
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const STORE_ENTRY = path.join(REPO_ROOT, 'packages', 'core', 'src', 'store.ts');
const SHARED_ENTRY = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'index.ts');
const BUNDLE_DIR = path.join(
  REPO_ROOT,
  'packages',
  'core',
  'node_modules',
  '.cache',
  'studianda-verify-migration'
);
const DB_FILE = 'reader.sqlite3';
/** 行数必须保持不变的业务表（迁移只加列/建表，不动行）。 */
const COUNTED_TABLES = ['documents', 'notes', 'annotations', 'messages', 'document_chat_sessions'];
/** 23 之后必须存在的表（20 基线新增 + 19/20 都依赖 + 21/22/23 新增）。 */
const EXPECTED_TABLES = [
  'selection_snapshots',
  'book_summaries',
  'notes',
  'annotations',
  'projects',
  'project_documents',
  'corpus_sessions',
  'corpus_session_documents'
];
const EXPECTED_VERSION = '23';

/** @type {string[]} */
const failures = [];
let sourceDir = '';
let copyRoot = '';

function usage() {
  return [
    '用法: node scripts/verify-migration.mjs <资料目录副本> [--yes]',
    '',
    '  <资料目录副本>  包含 reader.sqlite3 的 Studianda 资料目录的副本（脚本只读它，并复制到临时目录）',
    '  --yes           允许对不在系统临时目录下的路径运行（确认该路径已是副本、不是正在使用的原目录）',
    '  -h, --help      显示本帮助',
    '',
    '示例:',
    '  node scripts/verify-migration.mjs D:\\\\backups\\\\studianda-copy --yes',
    '  node scripts/verify-migration.mjs %TEMP%\\\\studianda-copy'
  ].join('\n');
}

function refuse(message) {
  failures.push(message);
  console.error(`[拒绝] ${message}`);
  console.error('');
  console.error(usage());
  process.exit(2);
}

function isInsideTemp(target) {
  const relative = path.relative(path.resolve(tmpdir()), target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 现场用 esbuild 打包真实源码（workspace 包指向 TS 源码，避免测到过期 dist）。 */
async function loadStore() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error(
      '需要仓库依赖 esbuild（根目录 devDependency）。请先在仓库根目录执行 pnpm.cmd install。'
    );
  }
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const bundlePath = path.join(BUNDLE_DIR, 'store.bundle.mjs');
  const started = performance.now();
  await esbuild.build({
    entryPoints: [STORE_ENTRY],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 第三方/原生依赖保持外部；workspace 的 @studianda/shared 指向源码一起打包，
    // 这样即使 packages/shared/dist 是旧的也不影响迁移验证。
    packages: 'external',
    alias: { '@studianda/shared': SHARED_ENTRY },
    logLevel: 'silent'
  });
  const bundleMs = performance.now() - started;
  try {
    const module = await import(pathToFileURL(bundlePath).href);
    if (typeof module.Store !== 'function') throw new Error('打包结果里没有导出 Store');
    return { Store: module.Store, bundleMs };
  } finally {
    rmSync(BUNDLE_DIR, { recursive: true, force: true });
  }
}

/** 排除 FTS5 的影子表，只保留用户可读的表名。 */
function listTables(db) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return rows
    .map((row) => String(row.name))
    .filter((name) => !(name.startsWith('chunks_fts_') && name !== 'chunks_fts'))
    .sort();
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

/**
 * 打开副本上的库做只读快照。极少数情况下（源目录遗留 -wal 但没有 -shm）只读打开会失败，
 * 此时回退为读写打开**副本**（仍然不碰源目录），让 SQLite 自行恢复 WAL 后再读。
 */
function openSnapshotDb(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return new DatabaseSync(dbPath);
  }
}

function readSnapshot(dbPath) {
  const db = openSnapshotDb(dbPath);
  try {
    let version = null;
    if (tableExists(db, 'schema_meta')) {
      const row = db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get();
      version = row?.value === undefined ? null : String(row.value);
    }
    const counts = {};
    for (const table of COUNTED_TABLES) {
      counts[table] = tableExists(db, table)
        ? Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n ?? 0)
        : null;
    }
    return { version, tables: listTables(db), counts };
  } finally {
    db.close();
  }
}

function integrityCheck(dbPath) {
  const db = openSnapshotDb(dbPath);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    return rows.map((row) => String(Object.values(row)[0] ?? '')).join('; ') || '(空结果)';
  } finally {
    db.close();
  }
}

function countMigrationBackups(dir) {
  const folder = path.join(dir, 'migration-backups');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.startsWith('reader-before-v') && name.endsWith('.sqlite3'))
    .sort();
}

function printTables(prefix, tables) {
  console.log(`${prefix}（${tables.length} 张）: ${tables.join(', ')}`);
}

function printCounts(label, counts) {
  const parts = Object.entries(counts).map(([table, count]) =>
    count === null ? `${table}=(无表)` : `${table}=${count}`
  );
  console.log(`${label}: ${parts.join('  ')}`);
}

async function main() {
  const argv = process.argv.slice(2);
  let yes = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--yes') {
      yes = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--')) {
      refuse(`未知参数：${arg}`);
    } else if (sourceDir) {
      refuse(`只接受一个资料来源目录参数，多余的：${arg}`);
    } else {
      sourceDir = arg;
    }
  }
  if (help) {
    console.log(usage());
    process.exit(0);
  }
  if (!sourceDir) refuse('缺少资料来源目录参数（应为包含 reader.sqlite3 的资料目录副本）。');

  const resolvedSource = path.resolve(sourceDir);
  if (!existsSync(resolvedSource) || !statSync(resolvedSource).isDirectory()) {
    refuse(`目录不存在或不是目录：${resolvedSource}`);
  }
  const sourceDb = path.join(resolvedSource, DB_FILE);
  if (!existsSync(sourceDb)) {
    refuse(`不是 Studianda 资料目录（缺少 ${DB_FILE}）：${resolvedSource}`);
  }

  // ---- 安全门：非临时路径必须显式 --yes ----
  if (!yes && !isInsideTemp(resolvedSource)) {
    console.error(`[拒绝] 目标目录不在系统临时目录下，看起来不是「资料目录副本」：`);
    console.error(`  ${resolvedSource}`);
    console.error('');
    console.error('为防止误把正在使用的原目录当副本操作，未加 --yes 时只允许系统临时目录下的路径。');
    console.error('如果确认它已经是副本（不是原目录），请显式确认后重跑：');
    console.error(`  node scripts/verify-migration.mjs "${sourceDir}" --yes`);
    console.error('');
    console.error('无论是否加 --yes，脚本都不会写源目录：先只读复制到临时目录，再只在副本上跑迁移。');
    process.exit(2);
  }
  const liveMarkers = ['runtime.json', '.instance-lock.sqlite3'].filter((name) =>
    existsSync(path.join(resolvedSource, name))
  );
  if (liveMarkers.length > 0) {
    console.warn(
      `[警告] 源目录含应用运行痕迹（${liveMarkers.join('、')}），可能正在被使用；` +
        '复制件可能不是一致性快照。建议先关闭 Studianda，或复制一份再验证。'
    );
  }

  console.log('Studianda 旧库升级验证（可重复）');
  console.log(`仓库: ${REPO_ROOT}`);
  console.log(`源目录（只读）: ${resolvedSource}`);
  const sourceSize = statSync(sourceDb).size;
  const sourceHashBefore = sha256File(sourceDb);
  console.log(`源 ${DB_FILE}: ${formatBytes(sourceSize)}，sha256=${sourceHashBefore}`);

  // ---- 1. 复制到临时目录（源目录全程只读） ----
  copyRoot = mkdtempSync(path.join(tmpdir(), 'studianda-verify-migration-'));
  const copyDir = path.join(copyRoot, 'data');
  const copyStarted = performance.now();
  cpSync(resolvedSource, copyDir, { recursive: true, force: true });
  const copyMs = performance.now() - copyStarted;
  console.log(
    `[1/4] 已复制到临时目录: ${copyDir}（${copyMs.toFixed(1)} ms）`
  );

  const copyDb = path.join(copyDir, DB_FILE);
  const before = readSnapshot(copyDb);
  console.log(`[2/4] 迁移前 schema_version=${before.version ?? '(未知)'}`);
  printTables('      迁移前表清单', before.tables);
  printCounts('      迁移前行数', before.counts);

  // ---- 2. 真实迁移 ----
  const { Store, bundleMs } = await loadStore();
  console.log(`[3/4] 打包当前迁移实现 ${bundleMs.toFixed(0)} ms，运行真实 Store 迁移…`);
  let store = null;
  const migrationStarted = performance.now();
  try {
    store = new Store(copyDir);
  } catch (error) {
    failures.push(`迁移抛错：${error instanceof Error ? error.message : String(error)}`);
    return finish();
  } finally {
    try {
      store?.close();
    } catch {
      // 关闭失败不覆盖迁移结果判定。
    }
  }
  const migrationMs = performance.now() - migrationStarted;
  console.log(`      迁移用时: ${migrationMs.toFixed(1)} ms`);

  // ---- 3. 迁移后 ----
  const after = readSnapshot(copyDb);
  console.log(`[4/4] 迁移后 schema_version=${after.version ?? '(未知)'}`);
  printTables('      迁移后表清单', after.tables);
  printCounts('      迁移后行数', after.counts);
  const addedTables = after.tables.filter((table) => !before.tables.includes(table));
  const removedTables = before.tables.filter((table) => !after.tables.includes(table));
  console.log(
    `      表变化: 新增 [${addedTables.length > 0 ? addedTables.join(', ') : '无'}]，` +
      `删除 [${removedTables.length > 0 ? removedTables.join(', ') : '无'}]`
  );
  const backups = countMigrationBackups(copyDir);
  console.log(
    `      迁移前快照: ${backups.length > 0 ? backups.join(', ') : '（未产生：源库已是当前版本）'}`
  );

  const integrity = integrityCheck(copyDb);
  console.log(`PRAGMA integrity_check: ${integrity}`);

  // ---- 4. 校验 ----
  if (after.version !== EXPECTED_VERSION) {
    failures.push(`迁移后 schema_version=${after.version ?? '(未知)'}，期望 ${EXPECTED_VERSION}`);
  }
  for (const table of EXPECTED_TABLES) {
    if (!after.tables.includes(table)) failures.push(`迁移后缺少表：${table}`);
  }
  for (const table of COUNTED_TABLES) {
    if (before.counts[table] !== after.counts[table]) {
      failures.push(
        `行数变化：${table} ${before.counts[table] ?? '(无表)'} → ${after.counts[table] ?? '(无表)'}`
      );
    }
  }
  if (removedTables.length > 0) failures.push(`迁移删除了表：${removedTables.join(', ')}`);
  if (integrity !== 'ok') failures.push(`integrity_check 未通过：${integrity}`);

  const sourceHashAfter = sha256File(sourceDb);
  if (sourceHashAfter !== sourceHashBefore) {
    failures.push(`源目录 ${DB_FILE} 的 sha256 变了：${sourceHashBefore} → ${sourceHashAfter}`);
  }
  console.log(
    `原目录未被修改: sha256 ${sourceHashAfter === sourceHashBefore ? '前后一致 ✓' : '前后不一致 ✗'}`
  );
  console.log(`源目录 ${DB_FILE} 大小: ${formatBytes(sourceSize)}（未变）`);

  return finish();
}

function finish() {
  if (failures.length > 0) {
    console.error('');
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    if (copyRoot) {
      // 失败时保留副本便于排查，打印路径让用户自行清理。
      console.error(`[信息] 临时副本已保留便于排查：${copyRoot}`);
    }
    console.error('[结论] FAIL');
    process.exit(1);
  }
  if (copyRoot) {
    try {
      rmSync(copyRoot, { recursive: true, force: true });
      console.log(`[清理] 已删除临时副本 ${copyRoot}`);
    } catch (error) {
      console.warn(`[警告] 临时副本删除失败：${error instanceof Error ? error.message : error}`);
    }
  }
  console.log('[结论] PASS：迁移完成、版本/表/行数/完整性检查通过，源目录未被修改');
  process.exit(0);
}

try {
  await main();
} catch (error) {
  console.error(`[FAIL] 未预期错误：${error instanceof Error ? error.message : String(error)}`);
  if (copyRoot) console.error(`[信息] 临时副本已保留便于排查：${copyRoot}`);
  console.error('[结论] FAIL');
  process.exit(1);
}
