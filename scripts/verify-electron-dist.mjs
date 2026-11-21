/**
 * 校验 `apps/desktop/node_modules/electron/dist` 与官方 Electron 发行 zip 逐字节一致。
 *
 * 背景：打包配置使用 `electronDist: node_modules/electron/dist`（避免打包阶段联网下载），
 * 因此需要证明“本机已安装的 Electron 目录”就是官方发行物，而不是被替换/损坏的目录。
 *
 * 依赖：只用 Node 内置模块 + 系统 7-Zip（`7z`；electron-builder 打 NSIS 本来也需要它，
 * 不是新增 npm 依赖，也没有新增许可义务）。本脚本只在构建期运行，不随安装包分发。
 *
 * 用法（仓库根目录）：
 *   node scripts/verify-electron-dist.mjs
 *   node scripts/verify-electron-dist.mjs --allow-missing-zip   # 无本地官方 zip 时降级为版本/关键文件检查
 *   node scripts/verify-electron-dist.mjs --zip <electron-vX-win32-x64.zip>
 *
 * 退出码：0 = 一致/可接受；1 = 不一致或缺少必要证据。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowMissingZip = args.includes('--allow-missing-zip');
const explicitZipIndex = args.indexOf('--zip');
const explicitZip = explicitZipIndex >= 0 ? args[explicitZipIndex + 1] : null;

const fail = (message, details = []) => {
  console.error(`[verify-electron-dist] ${message}`);
  for (const line of details) console.error(`  ${line}`);
  process.exit(1);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const formatBytes = (bytes) => `${bytes} B`;

// ---- 1) 期望版本与官方 zip 的 SHA-256（唯一来源：legal/bundled.json） -------------
const bundled = JSON.parse(readFileSync(path.join(root, 'legal/bundled.json'), 'utf8'));
const electronComponent = (bundled.components ?? []).find(
  (component) => component.kind === 'electron-runtime-binary'
);
if (!electronComponent) {
  fail('legal/bundled.json 中找不到 kind=electron-runtime-binary 的 Electron 运行时条目。');
}
const expectedVersion = String(electronComponent.version ?? '');
const expectedZipSha256 = String(electronComponent.source?.sha256 ?? '').toLowerCase();
if (!/^\d+\.\d+\.\d+/.test(expectedVersion)) {
  fail(`legal/bundled.json 的 Electron 版本不可识别：${expectedVersion || '(空)'}`);
}
if (!/^[0-9a-f]{64}$/.test(expectedZipSha256)) {
  fail(
    'legal/bundled.json 未记录 Electron 官方发行 zip 的 SHA-256；' +
      '请先在该条目 source.sha256 固化官方 digest（见 GitHub Release API 的 assets digest）。'
  );
}

// ---- 2) 本机安装的 Electron 版本 ------------------------------------------------
const electronDir = path.join(root, 'apps', 'desktop', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const installScript = path.join(electronDir, 'install.js');
if (!existsSync(distDir)) {
  // electron@44 的 npm 包不带 postinstall（pnpm 10 也不会自动跑依赖脚本），
  // `install.js` 是其官方安装入口：优先从 @electron/get 缓存取 zip 并解压到 dist，再校验。
  if (!existsSync(installScript)) {
    fail(
      `缺少 Electron 发行目录：${path.relative(root, distDir)}，且找不到官方安装脚本 ` +
        `${path.relative(root, installScript)}。先运行 pnpm install。`
    );
  }
  console.log(
    `[verify-electron-dist] 未找到 electron/dist，运行官方 install.js 获取 Electron 发行物…`
  );
  const install = spawnSync(process.execPath, [installScript], {
    cwd: electronDir,
    stdio: 'inherit'
  });
  if (install.error || install.status !== 0) {
    fail(`Electron 官方 install.js 执行失败（status ${install.status ?? 'unknown'}）。`);
  }
}
if (!existsSync(distDir)) {
  fail(`Electron 官方 install.js 执行后仍未生成 ${path.relative(root, distDir)}。`);
}
const installedPkg = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8'));
if (String(installedPkg.version) !== expectedVersion) {
  fail(
    `node_modules/electron 版本 ${installedPkg.version} 与 legal/bundled.json 记录的 ${expectedVersion} 不一致。`
  );
}
const distVersionFile = path.join(distDir, 'version');
const distVersion = existsSync(distVersionFile) ? readFileSync(distVersionFile, 'utf8').trim() : '';
if (distVersion !== expectedVersion) {
  fail(`electron/dist/version = ${distVersion || '(缺失)'}，与期望 ${expectedVersion} 不一致。`);
}

// ---- 3) 用系统 7-Zip 解出官方 zip，逐文件比对 -----------------------------------
function find7z() {
  const candidates = [
    process.env.ELECTRON_DIST_7Z,
    '7z',
    '7za',
    '7zr',
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe')
  ].filter(Boolean);
  for (const candidate of candidates) {
    // 用一条极短命令探测可执行性；stdio 忽略，避免依赖管道。
    const probe = spawnSync(candidate, ['i'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function zipCandidates() {
  if (explicitZip) return [path.resolve(root, explicitZip)];
  const fileName = `electron-v${expectedVersion}-win32-x64.zip`;
  const roots = [
    process.env.ELECTRON_CACHE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'),
    path.join(os.homedir(), '.cache', 'electron'),
    path.join(os.homedir(), 'Library', 'Caches', 'electron')
  ].filter(Boolean);
  const found = [];
  for (const cacheRoot of roots) {
    if (!existsSync(cacheRoot)) continue;
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(cacheRoot, entry.name, fileName);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

function walkFiles(base, dir = base, result = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(base, full, result);
    else if (entry.isFile()) result.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return result;
}

function fileHashes(base) {
  const map = new Map();
  for (const relative of walkFiles(base)) {
    const full = path.join(base, relative);
    map.set(relative, { bytes: statSync(full).size, sha256: sha256(full) });
  }
  return map;
}

const sevenZip = find7z();
const candidates = zipCandidates();
const verifiedZip = candidates
  .map((file) => ({ file, sha256: sha256(file) }))
  .find((candidate) => candidate.sha256 === expectedZipSha256);

if (!verifiedZip) {
  if (!allowMissingZip) {
    fail('找不到与 legal/bundled.json 记录一致的官方 Electron zip，无法做逐字节校验。', [
      `期望：electron-v${expectedVersion}-win32-x64.zip，SHA-256 ${expectedZipSha256}`,
      '可先运行 pnpm install（会下载并缓存官方 zip），或显式传 --zip <路径>。',
      '确有必要跳过时可用 --allow-missing-zip（仅做版本/关键文件检查，证据较弱）。'
    ]);
  }
  // 降级：只校验版本与关键文件存在，并明确打印“未做逐字节校验”。
  for (const required of [
    'electron.exe',
    'ffmpeg.dll',
    'icudtl.dat',
    'LICENSES.chromium.html',
    'resources/default_app.asar'
  ]) {
    if (!existsSync(path.join(distDir, required))) {
      fail(`electron/dist 缺少关键文件：${required}`);
    }
  }
  console.warn(
    `[verify-electron-dist] 未找到官方 zip（或 SHA-256 不匹配），已按 --allow-missing-zip 降级：` +
      `仅确认版本 ${expectedVersion} 与关键文件存在，未做逐字节校验。`
  );
  process.exit(0);
}

if (!sevenZip) {
  fail('找不到 7-Zip（7z/7za/7zr）。它用于解出官方 zip 做逐字节校验，也是 electron-builder NSIS 打包所需工具。');
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'studianda-electron-dist-'));
try {
  const extractDir = path.join(tempRoot, `electron-v${expectedVersion}-win32-x64`);
  const extract = spawnSync(sevenZip, ['x', '-y', `-o${extractDir}`, verifiedZip.file], {
    stdio: 'ignore'
  });
  if (extract.error || extract.status !== 0) {
    fail(`7-Zip 解压官方 zip 失败（status ${extract.status ?? 'unknown'}）：${verifiedZip.file}`);
  }
  const official = fileHashes(extractDir);
  const installed = fileHashes(distDir);

  const missing = [...official.keys()].filter((relative) => !installed.has(relative));
  const extra = [...installed.keys()].filter((relative) => !official.has(relative));
  const changed = [...official.keys()].filter((relative) => {
    const a = official.get(relative);
    const b = installed.get(relative);
    return b && (a.bytes !== b.bytes || a.sha256 !== b.sha256);
  });

  if (missing.length || extra.length || changed.length) {
    const details = [];
    if (missing.length) details.push(`缺少 ${missing.length} 个文件：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' …' : ''}`);
    if (extra.length) details.push(`多出 ${extra.length} 个文件：${extra.slice(0, 8).join('、')}${extra.length > 8 ? ' …' : ''}`);
    if (changed.length) details.push(`内容不同 ${changed.length} 个文件：${changed.slice(0, 8).join('、')}${changed.length > 8 ? ' …' : ''}`);
    details.push(`官方 zip：${verifiedZip.file}（SHA-256 ${expectedZipSha256}）`);
    fail('electron/dist 与官方 Electron 发行 zip 不一致，拒绝继续打包。', details);
  }

  const totalBytes = [...official.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(
    `[verify-electron-dist] 通过：electron/dist 与官方 electron-v${expectedVersion}-win32-x64.zip ` +
      `逐字节一致（${official.size} 个文件，${formatBytes(totalBytes)}）。`
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
