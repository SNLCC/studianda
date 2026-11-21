/**
 * 校验法律相关文件：源码仓库与安装包两侧必须**各自完备**，而不是互补。
 *
 * 用法（仓库根目录）：
 *   node scripts/audit-legal-completeness.mjs             # 只校验仓库内法律文件集合与内部一致性
 *   node scripts/audit-legal-completeness.mjs --package   # 额外校验 apps/desktop/release/win-unpacked
 *
 * 退出码：0 = 通过；1 = 有缺项/不一致（逐条打印原因）。
 *
 * 除"清单完备性"外，还做反向核对：legal/inventory.json 里的每个 npm 组件都必须在
 * 锁文件（根目录 pnpm-lock.yaml，或 package-lock.json）里真实存在且版本一致；
 * Electron/Chromium/Node 运行时、字体等非 npm 来源按显式分类跳过（见 6.5 节）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkPackage = process.argv.includes('--package');
const problems = [];
const notes = [];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const read = (relativePath) => readFileSync(path.join(root, relativePath));
const sha256Of = (relativePath) => sha256(read(relativePath));
const fail = (message) => problems.push(message);

function walkFiles(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walkFiles(full, base));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

// 法律文本在 Git/CI 上可能因 core.autocrlf 出现 CRLF/LF 差异，内容比较按归一化换行处理。
const sameTextFiles = (a, b) => normalize(readFileSync(a, 'utf8')) === normalize(readFileSync(b, 'utf8'));

// ---------------------------------------------------------------------------
// 锁文件解析（反向核对用）：只索引"组件名 -> 版本集合"，不引入 YAML 依赖。
// pnpm-lock.yaml 的包键格式固定：name@version（可能带引号，snapshots 段还可能带
// peer 后缀 `name@1.2.3(peer@4.5.6)`）；lockfile v6 则是路径式 /name/1.2.3。
// ---------------------------------------------------------------------------
function parsePnpmPackageKey(rawKey) {
  let key = rawKey.trim();
  if (
    (key.startsWith("'") && key.endsWith("'")) ||
    (key.startsWith('"') && key.endsWith('"'))
  ) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\(.*\)$/, '');
  if (key.startsWith('/')) {
    const parts = key.split('/');
    const version = parts.pop();
    const name = parts.slice(1).join('/');
    return name && version ? { name, version } : null;
  }
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function addComponent(versionsByName, name, version) {
  if (!name || !version) return;
  if (!versionsByName.has(name)) versionsByName.set(name, new Set());
  versionsByName.get(name).add(version);
}

function collectPnpmLockComponents(text) {
  const versionsByName = new Map();
  let section = null;
  for (const line of normalize(text).split('\n')) {
    if (line.trim() === '') continue;
    if (!line.startsWith(' ')) {
      section = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*$/)?.[1] ?? null;
      continue;
    }
    // packages/ 与 snapshots/ 都是 2 空格缩进的 `name@version:` 键；4 空格以上是字段。
    if (section !== 'packages' && section !== 'snapshots') continue;
    const key = line.match(/^ {2}(\S.*?):\s*$/)?.[1];
    if (!key) continue;
    const parsed = parsePnpmPackageKey(key);
    if (parsed) addComponent(versionsByName, parsed.name, parsed.version);
  }
  return versionsByName;
}

function collectNpmLockComponents(lock) {
  const versionsByName = new Map();
  // package-lock v2/v3：packages 的键是 node_modules/... 路径。
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const marker = 'node_modules/';
    if (!key.includes(marker) || !entry?.version) continue;
    addComponent(versionsByName, key.slice(key.lastIndexOf(marker) + marker.length), entry.version);
  }
  // package-lock v1：嵌套 dependencies。
  const visit = (dependencies) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      addComponent(versionsByName, name, dependency?.version);
      visit(dependency?.dependencies);
    }
  };
  visit(lock.dependencies);
  return versionsByName;
}

function readLockfileComponents() {
  const candidates = [
    { file: 'pnpm-lock.yaml', parse: collectPnpmLockComponents },
    { file: 'package-lock.json', parse: (text) => collectNpmLockComponents(JSON.parse(text)) },
    {
      file: 'apps/desktop/package-lock.json',
      parse: (text) => collectNpmLockComponents(JSON.parse(text))
    }
  ];
  for (const candidate of candidates) {
    const full = path.join(root, candidate.file);
    if (!existsSync(full)) continue;
    return { file: candidate.file, versionsByName: candidate.parse(readFileSync(full, 'utf8')) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1) 仓库必备法律文件（缺失即失败）
// ---------------------------------------------------------------------------
const repoRequiredFiles = [
  'LICENSE',
  'NOTICE',
  'legal/PROJECT-LICENSE.txt',
  'legal/PROJECT-NOTICE.txt',
  'legal/COMPATIBILITY.md',
  'legal/BRAND.md',
  'legal/fonts.json',
  'legal/bundled.json',
  'legal/THIRD-PARTY.md',
  'legal/SOURCES.md',
  'legal/NOTICE.html',
  'legal/inventory.json',
  'legal/electron/LICENSE.txt',
  'legal/electron/LICENSES.chromium.html',
  'legal/runtime/Node-LICENSE.txt',
  'legal/upstream/official/nsis7z/README.md',
  'legal/upstream/official/nsis7z/LICENSE.txt',
  'legal/upstream/official/nsis7z/LGPL-2.1.txt',
  'legal/upstream/official/nsis7z/unRAR-LICENSE.txt',
  'legal/upstream/official/nsis7z/7z1900-src.7z',
  'legal/upstream/official/nsis7z/source/nsis7z/CPP/7zip/Bundles/Nsis7z/nsis7z.cpp',
  'legal/upstream/official/nsis-plugins/README.md',
  'legal/upstream/official/nsis-plugins/stdutils/README.md',
  'legal/upstream/official/nsis-plugins/stdutils/LICENSE-LGPL-2.1.txt',
  'legal/upstream/official/nsis-plugins/stdutils/LICENSE-CLARIFICATION.txt',
  'legal/upstream/official/nsis-plugins/stdutils/source/Contrib/StdUtils/StdUtils.vcxproj',
  'legal/upstream/official/nsis-plugins/uac/README.md',
  'legal/upstream/official/nsis-plugins/uac/LICENSE.txt',
  'legal/upstream/official/nsis-plugins/uac/source/uac.cpp',
  'legal/upstream/official/nsis-plugins/winshell/README.md',
  'docs/USAGE-NOTICE.md',
  'apps/desktop/build/INSTALLER-NOTICE.txt',
  'legal/font-licenses/README.md',
  'legal/upstream/official/electron-runtime-dlls.md',
  'legal/upstream/official/napi-canvas/mpl-sources/README.md'
];
for (const file of repoRequiredFiles) {
  if (!existsSync(path.join(root, file))) fail(`仓库缺少法律文件：${file}`);
}

// 7-Zip / nsis7z 的随包源码必须与说明中的版本、哈希一致（防止换成别的源码却仍声称合规）。
const nsis7zDir = 'legal/upstream/official/nsis7z';
const sevenZipSourceHash = '9ba70a5e8485cf9061b30a2a84fe741de5aeb8dd271aab8889da0e9b3bf1868e';
const sevenZipSourceFile = path.join(root, nsis7zDir, '7z1900-src.7z');
if (existsSync(sevenZipSourceFile)) {
  if (sha256(readFileSync(sevenZipSourceFile)) !== sevenZipSourceHash) {
    fail(`${nsis7zDir}/7z1900-src.7z 的 SHA-256 与说明不一致（应为 ${sevenZipSourceHash}）`);
  }
}
const sevenZipLicenseText = path.join(root, nsis7zDir, 'LICENSE.txt');
if (existsSync(sevenZipLicenseText)) {
  const text = normalize(readFileSync(sevenZipLicenseText, 'utf8'));
  for (const needle of ['GNU LGPL', 'unRAR license restriction']) {
    if (!text.includes(needle)) fail(`${nsis7zDir}/LICENSE.txt 缺少「${needle}」说明`);
  }
}

// ---------------------------------------------------------------------------
// 1.7) legal/ 必须只由 Git 跟踪的文件组成：未跟踪/被忽略的文件会进入安装包（legal/ 被整体
//      复制为 extraResources），却不出现在源码发行物（git archive）里，造成两侧不一致，
//      并可能带入未登记来源的第三方二进制（例如上游源码树里的构建工具 .exe）。
// ---------------------------------------------------------------------------
try {
  const listLegal = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) return [];
    return (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  };
  const strayLegalFiles = [
    ...listLegal(['ls-files', '--others', '--exclude-standard', '--', 'legal/']),
    ...listLegal(['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'legal/'])
  ];
  if (strayLegalFiles.length > 0) {
    fail(
      `legal/ 下存在 ${strayLegalFiles.length} 个未纳入 Git 的文件（会随安装包分发但不在源码发行物中）：` +
        strayLegalFiles.slice(0, 10).join('、') +
        (strayLegalFiles.length > 10 ? ' 等' : '')
    );
  }
} catch {
  // 非 Git 工作区（例如只拿到源码 zip）跳过；安装包侧的一致性仍由 --package 检查覆盖。
}

// ---------------------------------------------------------------------------
// 2) 仓库内同一法律文本的多份副本必须一致
// ---------------------------------------------------------------------------
const copyPairs = [
  ['LICENSE', 'legal/PROJECT-LICENSE.txt'],
  ['NOTICE', 'legal/PROJECT-NOTICE.txt']
];
for (const [canonical, copy] of copyPairs) {
  if (!existsSync(path.join(root, canonical)) || !existsSync(path.join(root, copy))) continue;
  if (!sameTextFiles(path.join(root, canonical), path.join(root, copy))) {
    fail(`${copy} 与 ${canonical} 内容不一致（同一法律文本不能有两份不同版本）`);
  }
}

// ---------------------------------------------------------------------------
// 3) 安装许可提示：UTF-8 BOM、内容要点
// ---------------------------------------------------------------------------
const installerNoticeFile = path.join(root, 'apps/desktop/build/INSTALLER-NOTICE.txt');
if (existsSync(installerNoticeFile)) {
  const bytes = readFileSync(installerNoticeFile);
  if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    fail('apps/desktop/build/INSTALLER-NOTICE.txt 缺少 UTF-8 BOM（安装向导会按 ANSI 解码导致乱码）');
  }
  const text = normalize(bytes.toString('utf8'));
  for (const needle of [
    'Apache License 2.0',
    'LICENSE',
    'NOTICE',
    'USAGE-NOTICE.md',
    'resources/legal/',
    'Independent JPEG Group',
    'MPL-2.0',
    'font-licenses'
  ]) {
    if (!text.includes(needle)) {
      fail(`INSTALLER-NOTICE.txt 未提及 ${needle}`);
    }
  }
  // WinShell 已由本项目脚本实现替代，安装页不应再把它列为随包组件。
  if (text.includes('WinShell')) {
    fail('INSTALLER-NOTICE.txt 仍提到 WinShell：该插件已从安装包移除，安装页不应再列为随包组件');
  }
  if (/PolyForm/i.test(text)) {
    fail('INSTALLER-NOTICE.txt 仍包含 PolyForm');
  }
}

// ---------------------------------------------------------------------------
// 3.5) 项目自身许可：Apache License 2.0（防止误改回非商业许可或替换许可文本）
// ---------------------------------------------------------------------------
const licenseText = normalize(readFileSync(path.join(root, 'LICENSE'), 'utf8'));
for (const needle of ['Apache License', 'Version 2.0, January 2004']) {
  if (!licenseText.includes(needle)) {
    fail(`LICENSE 不是 Apache License 2.0 全文（缺少「${needle}」）`);
  }
}
const rootLicenseField = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).license;
if (rootLicenseField !== 'Apache-2.0') {
  fail(`根 package.json 的 license 应为 Apache-2.0（当前 ${rootLicenseField ?? '(缺失)'}）`);
}

// 各 workspace 包的 license 字段也必须是 Apache-2.0（防止只改根包）。
for (const relative of [
  'apps/desktop/package.json',
  'packages/shared/package.json',
  'packages/core/package.json',
  'packages/host/package.json',
  'packages/ui/package.json',
  'packages/app/package.json',
  'packages/api-client/package.json'
]) {
  const field = JSON.parse(readFileSync(path.join(root, relative), 'utf8')).license;
  if (field !== 'Apache-2.0') {
    fail(`${relative} 的 license 应为 Apache-2.0（当前 ${field ?? '(缺失)'}）`);
  }
}

// NOTICE 必须是归属声明：含版权行、不含 PolyForm、也不含 Apache 许可全文。
const noticeText = normalize(readFileSync(path.join(root, 'NOTICE'), 'utf8'));
if (!/Copyright\s+\d{4}/.test(noticeText)) {
  fail('NOTICE 缺少版权行（Copyright <year>）');
}
if (/PolyForm/i.test(noticeText)) {
  fail('NOTICE 仍包含 PolyForm；历史许可说明应只放在 README/发布说明中');
}
if (noticeText.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')) {
  fail('NOTICE 不应包含 Apache 许可全文（全文应只在 LICENSE）');
}

// ---------------------------------------------------------------------------
// 3.6) 许可原文有效性：不得是 404 占位、不得为空
// ---------------------------------------------------------------------------
const legalRoot = path.join(root, 'legal');
const legalFiles = existsSync(legalRoot) ? walkFiles(legalRoot) : [];
for (const relative of legalFiles) {
  const text = normalize(readFileSync(path.join(legalRoot, relative), 'utf8'));
  if (/404:\s*Not Found/.test(text)) {
    fail(`legal/${relative} 是 404 占位内容，不是真实许可原文`);
  }
  const base = path.basename(relative);
  if (/^(LICEN[CS]E|COPYING)/i.test(base) && text.trim().length < 200) {
    fail(`legal/${relative} 疑似不是完整许可原文（去空白后不足 200 字符）`);
  }
}

// 清单与字体清单引用的每一份许可原文都必须非空、且不能是占位内容。
const referencedLicenseFiles = new Set();
const inventoryForLicenses = JSON.parse(readFileSync(path.join(root, 'legal/inventory.json'), 'utf8'));
for (const record of [
  ...(inventoryForLicenses.runtime ?? []),
  ...(inventoryForLicenses.fonts ?? []),
  ...(inventoryForLicenses.bundled ?? []),
  ...(inventoryForLicenses.packages ?? [])
]) {
  for (const file of record.licenseFiles ?? []) {
    const relative = String(file.path ?? '').replace(/^\//, '');
    if (!relative) continue;
    referencedLicenseFiles.add(relative);
  }
}
for (const font of JSON.parse(readFileSync(path.join(root, 'legal/fonts.json'), 'utf8')).fonts ?? []) {
  if (font.licenseFile) {
    referencedLicenseFiles.add(font.licenseFile.replace(/^legal\//, ''));
  }
}
for (const relative of referencedLicenseFiles) {
  const full = path.join(legalRoot, relative);
  if (!existsSync(full)) {
    fail(`引用的许可原文不存在：legal/${relative}`);
    continue;
  }
  const bytes = readFileSync(full);
  if (bytes.length < 100) {
    fail(`引用的许可原文过短（${bytes.length} B）：legal/${relative}`);
  }
  if (/404:\s*Not Found/.test(normalize(bytes.toString('utf8')))) {
    fail(`引用的许可原文是 404 占位：legal/${relative}`);
  }
}

// MPL-2.0 固定版本源码归档必须与说明同在（R2 回归保护）。
const mplSources = path.join(legalRoot, 'upstream/official/napi-canvas/mpl-sources');
if (existsSync(mplSources)) {
  const archives = readdirSync(mplSources).filter((name) => /\.(crate|tar\.gz)$/i.test(name));
  if (archives.length < 4) {
    fail(`MPL-2.0 源码归档不足 4 个（当前 ${archives.length} 个）：legal/upstream/official/napi-canvas/mpl-sources/`);
  }
} else {
  fail('缺少 legal/upstream/official/napi-canvas/mpl-sources/（MPL-2.0 源码归档）');
}

// ---------------------------------------------------------------------------
// 4) 使用须知版本：docs 与应用内常量一致
// ---------------------------------------------------------------------------
const noticeDocPath = path.join(root, 'docs/USAGE-NOTICE.md');
const noticeAppPath = path.join(root, 'packages/app/src/usage-notice.tsx');
if (existsSync(noticeDocPath) && existsSync(noticeAppPath)) {
  const doc = normalize(readFileSync(noticeDocPath, 'utf8'));
  const app = readFileSync(noticeAppPath, 'utf8');
  const docVersion = doc.match(/文档版本[：:]\s*(v\d+(?:\.\d+)*)/)?.[1] ?? '';
  const docDate = doc.match(/生效日期[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
  const appVersion = app.match(/USAGE_NOTICE_VERSION\s*=\s*'([^']+)'/)?.[1] ?? '';
  const appDate = app.match(/USAGE_NOTICE_EFFECTIVE_DATE\s*=\s*'([^']+)'/)?.[1] ?? '';
  if (!docVersion || !docDate) fail('docs/USAGE-NOTICE.md 缺少「文档版本」或「生效日期」');
  if (!appVersion || !appDate) fail('packages/app/src/usage-notice.tsx 缺少版本/生效日期常量');
  if (docVersion && appVersion && docVersion !== appVersion) {
    fail(`使用须知版本不一致：docs=${docVersion}，应用=${appVersion}`);
  }
  if (docDate && appDate && docDate !== appDate) {
    fail(`使用须知生效日期不一致：docs=${docDate}，应用=${appDate}`);
  }
}

// ---------------------------------------------------------------------------
// 5) CLA 已移除且不应再被引用（PR 功能暂时关闭）
// ---------------------------------------------------------------------------
if (existsSync(path.join(root, 'CLA.md'))) fail('CLA.md 仍存在；PR 关闭期间不应随仓库公开');
const claReferenceFiles = [
  'README.md',
  'CONTRIBUTING.md',
  ...(existsSync(path.join(root, 'docs')) ? walkFiles(path.join(root, 'docs')).map((file) => `docs/${file}`) : [])
];
for (const file of claReferenceFiles) {
  const full = path.join(root, file);
  if (!existsSync(full) || !file.endsWith('.md')) continue;
  if (normalize(readFileSync(full, 'utf8')).includes('CLA.md')) {
    fail(`${file} 仍链接到已移除的 CLA.md`);
  }
}

// ---------------------------------------------------------------------------
// 6) legal/inventory.json 引用的许可证文件必须全部存在，且 missing 为空
// ---------------------------------------------------------------------------
const inventoryPath = path.join(root, 'legal/inventory.json');
if (existsSync(inventoryPath)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const records = [
    ...(inventory.runtime ?? []),
    ...(inventory.fonts ?? []),
    ...(inventory.bundled ?? []),
    ...(inventory.packages ?? [])
  ];
  for (const record of records) {
    for (const file of record.licenseFiles ?? []) {
      const relative = String(file.path ?? '').replace(/^\//, '');
      if (!relative) {
        fail(`inventory.json 中 ${record.name ?? '?'} 有空的 licenseFiles.path`);
        continue;
      }
      if (!existsSync(path.join(root, 'legal', relative))) {
        fail(`inventory.json 引用的许可证不存在：legal/${relative}（${record.name ?? '?'}）`);
      }
    }
  }
  if (Array.isArray(inventory.missing) && inventory.missing.length > 0) {
    fail(`inventory.json 仍有 ${inventory.missing.length} 个缺失许可证的组件`);
  }
}

// 字体清单的 licenseFile 也必须存在
const fontsPath = path.join(root, 'legal/fonts.json');
if (existsSync(fontsPath)) {
  const fonts = JSON.parse(readFileSync(fontsPath, 'utf8')).fonts ?? [];
  for (const font of fonts) {
    if (font.licenseFile && !existsSync(path.join(root, font.licenseFile))) {
      fail(`legal/fonts.json 引用的字体许可证不存在：${font.licenseFile}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6.5) 反向核对：清单里的每个 npm 组件必须真实存在于锁文件且版本一致
//      防止清单只增不减、版本过期，变成"历史遗留的传说"。
//
// 清单不是单一来源，只有 npm 组件需要和锁文件交叉核对：
//   runtime[]：Electron/Chromium/Node 运行时，来自官方发行包，不经过 npm；
//   fonts[]：字体文件，来源与覆盖口径由 legal/fonts.json 管理；
//   packages[]：默认视为 npm 依赖（取自安装包 node_modules）。
// packages[] 里若出现非 npm 组件（安装器插件、原生二进制、WASM 等），必须登记在
// NON_NPM_PACKAGES 显式白名单并写明来源；声明了非 npm ecosystem 却没登记的条目
// 会直接报错——不允许用 try/catch 静默吞掉。
// ---------------------------------------------------------------------------
const NON_NPM_PACKAGES = new Map([
  // 组件名 -> 来源说明，例如：
  // ['winShell', 'NSIS 插件：官方发布页下载，不经过 npm']
]);

const reverse = {
  checked: 0,
  matched: 0,
  missing: 0,
  versionMismatch: 0,
  skippedRuntime: 0,
  skippedFonts: 0,
  skippedBundled: 0,
  skippedAllowlisted: 0,
  unregisteredNonNpm: 0
};

if (existsSync(inventoryPath)) {
  const inventoryForLockCheck = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  reverse.skippedRuntime = (inventoryForLockCheck.runtime ?? []).length;
  reverse.skippedFonts = (inventoryForLockCheck.fonts ?? []).length;
  reverse.skippedBundled = (inventoryForLockCheck.bundled ?? []).length;
  const lockfile = readLockfileComponents();

  if (!lockfile) {
    fail('反向核对失败：未找到 pnpm-lock.yaml 或 package-lock.json，无法核对清单里的 npm 组件');
  } else {
    for (const record of inventoryForLockCheck.packages ?? []) {
      const name = typeof record?.name === 'string' ? record.name : '';
      const version = typeof record?.version === 'string' ? record.version : '';
      const ecosystem = String(record?.ecosystem ?? 'npm').toLowerCase();

      if (NON_NPM_PACKAGES.has(name)) {
        reverse.skippedAllowlisted += 1;
        continue;
      }
      if (ecosystem !== 'npm') {
        reverse.unregisteredNonNpm += 1;
        fail(
          `反向核对失败：inventory.json 的 packages[] 中 ${name || '?'} 声明为非 npm 来源` +
            `（ecosystem=${ecosystem}），但未在 NON_NPM_PACKAGES 白名单登记来源`
        );
        continue;
      }

      reverse.checked += 1;
      if (!name || !version) {
        reverse.missing += 1;
        fail(`反向核对失败：inventory.json 的 npm 组件 ${name || '?'} 缺少可核对的 name/version`);
        continue;
      }
      const lockedVersions = lockfile.versionsByName.get(name);
      if (!lockedVersions || lockedVersions.size === 0) {
        reverse.missing += 1;
        fail(
          `反向核对失败：inventory.json 记录了 ${name}@${version}，` +
            `但 ${lockfile.file} 中完全没有这个组件`
        );
        continue;
      }
      if (!lockedVersions.has(version)) {
        reverse.versionMismatch += 1;
        fail(
          `反向核对失败：inventory.json 记录 ${name}@${version}，` +
            `但 ${lockfile.file} 中的版本是 ${[...lockedVersions].sort().join('、')}`
        );
        continue;
      }
      reverse.matched += 1;
    }

    notes.push(
      `清单反向核对（${lockfile.file}）：checked=${reverse.checked}，matched=${reverse.matched}，` +
        `missing=${reverse.missing}，version-mismatch=${reverse.versionMismatch}；` +
        `跳过非 npm 组件 ` +
        `${reverse.skippedRuntime + reverse.skippedFonts + reverse.skippedBundled + reverse.skippedAllowlisted} 个` +
        `（runtime ${reverse.skippedRuntime}、fonts ${reverse.skippedFonts}、bundled ${reverse.skippedBundled}、` +
        `显式白名单 ${reverse.skippedAllowlisted}）` +
        (reverse.unregisteredNonNpm > 0
          ? `；另有 ${reverse.unregisteredNonNpm} 个未登记来源的非 npm 组件（见失败项）`
          : '')
    );
  }
}

// ---------------------------------------------------------------------------
// 6.6) 非 npm 随包组件：结构 + 随包实物哈希核对
//       非 npm 组件没有锁文件可核，但不能因此免检：清单必须带实物路径、字节数与
//       SHA-256；仓库内存在的实物逐文件复算，legal/ 内的证据文件必须存在，
//       构建产物（node_modules/release/asar 内资源）在未构建时允许缺席。
// ---------------------------------------------------------------------------
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
let verifiedNonNpmArtifacts = 0;
let missingNonNpmArtifacts = 0;
if (existsSync(inventoryPath)) {
  const inventoryForArtifacts = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const nonNpmGroups = [
    ['runtime', inventoryForArtifacts.runtime ?? []],
    ['fonts', inventoryForArtifacts.fonts ?? []],
    ['bundled', inventoryForArtifacts.bundled ?? []]
  ];
  let nonNpmEntries = 0;
  for (const [group, groupRecords] of nonNpmGroups) {
    for (const record of groupRecords) {
      // 旧版 runtime[]（Electron/Chromium/Node）没有 ecosystem 字段，其完整性由第 6 节
      // 的许可证文件检查覆盖；这里只校验本次扩展显式声明 ecosystem=bundled 的条目。
      if (record?.ecosystem !== 'bundled') continue;
      nonNpmEntries += 1;
      const label = `${group}[] 条目「${record.name ?? '?'}」`;
      for (const field of ['name', 'version', 'license', 'kind']) {
        if (typeof record[field] !== 'string' || record[field].trim() === '') {
          fail(`inventory.json 的 ${label} 缺少 ${field}`);
        }
      }
      const source = record.source ?? {};
      if (typeof source.url !== 'string' || source.url.trim() === '') {
        fail(`inventory.json 的 ${label} 缺少 source.url`);
      }
      if (typeof source.verified !== 'boolean') {
        fail(`inventory.json 的 ${label} 的 source.verified 必须是布尔值`);
      }
      if (source.verified === false && String(source.reason ?? '').trim() === '') {
        fail(`inventory.json 的 ${label} 标了 source.verified=false，但没有在 source.reason 写明原因`);
      }
      if (!Array.isArray(record.licenseFiles) || record.licenseFiles.length === 0) {
        fail(`inventory.json 的 ${label} 必须至少登记一份许可证原文（licenseFiles[]）`);
      }
      if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
        fail(`inventory.json 的 ${label} 必须至少登记一个随包实物（artifacts[]）`);
        continue;
      }
      for (const artifact of record.artifacts) {
        const artifactPath = typeof artifact?.path === 'string' ? artifact.path : '';
        if (artifactPath === '') {
          fail(`inventory.json 的 ${label} 有空的 artifacts[].path`);
          continue;
        }
        if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
          fail(`inventory.json 的 ${label} 的 artifacts[].bytes 必须是非负整数：${artifactPath}`);
        }
        if (typeof artifact.sha256 !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) {
          fail(`inventory.json 的 ${label} 的 artifacts[].sha256 必须是 64 位小写十六进制：${artifactPath}`);
        }
        if (artifact.container) {
          // asar 内资源只在构建产物里存在；生成器从实际 app.asar 解出后算哈希，
          // 这里不强制构建产物在场，但容器字段不能为空。
          if (typeof artifact.container !== 'string' || artifact.container.trim() === '') {
            fail(`inventory.json 的 ${label} 的 artifacts[].container 为空：${artifactPath}`);
          }
          continue;
        }
        const relative = artifactPath.replace(/^\.?\//, '');
        const full = path.join(root, relative);
        if (existsSync(full)) {
          const actualBytes = statSync(full).size;
          const actualSha256 = sha256(readFileSync(full));
          if (actualBytes !== artifact.bytes) {
            fail(
              `随包实物字节数与清单不一致：${relative}（清单 ${artifact.bytes} B，实际 ${actualBytes} B）`
            );
          }
          if (actualSha256 !== artifact.sha256) {
            fail(`随包实物 SHA-256 与清单不一致：${relative}`);
          }
          verifiedNonNpmArtifacts += 1;
        } else if (relative.startsWith('legal/')) {
          fail(`inventory.json 的 ${label} 登记的仓库内法律证据不存在：${relative}`);
        } else {
          missingNonNpmArtifacts += 1;
        }
      }
    }
  }
  // 安装器容器：安装器插件/stub 的实际二进制被编译进安装器本体，只登记一次。
  const installer = inventoryForArtifacts.installer;
  if (installer && typeof installer === 'object') {
    const installerRelative =
      typeof installer.path === 'string' ? installer.path.replace(/^\.?\//, '') : '';
    const installerShapeOk =
      installerRelative !== '' &&
      Number.isInteger(installer.bytes) &&
      typeof installer.sha256 === 'string' &&
      SHA256_PATTERN.test(installer.sha256);
    if (!installerShapeOk) {
      fail('inventory.json 的 installer 记录缺少可核对的 path/bytes/sha256');
    } else if (existsSync(path.join(root, installerRelative))) {
      const full = path.join(root, installerRelative);
      if (statSync(full).size !== installer.bytes) {
        fail(`安装器容器字节数与清单不一致：${installerRelative}`);
      }
      if (sha256(readFileSync(full)) !== installer.sha256) {
        fail(`安装器容器 SHA-256 与清单不一致：${installerRelative}`);
      }
      verifiedNonNpmArtifacts += 1;
    } else {
      missingNonNpmArtifacts += 1;
    }
  }
  notes.push(
    `非 npm 随包组件 ${nonNpmEntries} 条（runtime/fonts/bundled 中 ecosystem=bundled 的条目）：` +
      `随包实物哈希复算 ${verifiedNonNpmArtifacts} 个，构建产物未在场 ${missingNonNpmArtifacts} 个`
  );
}

// ---------------------------------------------------------------------------
// 7) legal/NOTICE.html 中的相对链接必须能落地到 legal/ 内的文件或目录
// ---------------------------------------------------------------------------
const noticeHtmlPath = path.join(root, 'legal/NOTICE.html');
if (existsSync(noticeHtmlPath)) {
  const html = readFileSync(noticeHtmlPath, 'utf8');
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  for (const href of hrefs) {
    if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    if (!existsSync(path.join(root, 'legal', href))) {
      fail(`legal/NOTICE.html 的相对链接失效：${href}`);
    }
  }
  notes.push(`NOTICE.html 相对链接 ${seen.size} 个`);
}

// ---------------------------------------------------------------------------
// 8) 安装包侧：与仓库各自完备且一致
// ---------------------------------------------------------------------------
const version =
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '';
const unpackedDir = path.join(root, 'apps/desktop/release/win-unpacked');
const resourcesDir = path.join(unpackedDir, 'resources');
const repoLegalFiles = existsSync(path.join(root, 'legal'))
  ? walkFiles(path.join(root, 'legal'))
  : [];
notes.push(`仓库 legal/ 文件 ${repoLegalFiles.length} 个`);

if (checkPackage) {
  if (!existsSync(unpackedDir)) {
    fail('--package 需要先构建 apps/desktop/release/win-unpacked');
  } else {
    // 8.1 根 LICENSE / NOTICE
    for (const name of ['LICENSE', 'NOTICE']) {
      const packaged = path.join(resourcesDir, name);
      if (!existsSync(packaged)) {
        fail(`安装包缺少 resources/${name}`);
      } else if (!sameTextFiles(packaged, path.join(root, name))) {
        fail(`安装包 resources/${name} 与仓库 ${name} 内容不一致`);
      }
    }

    // 8.2 安装包 legal/ = 仓库 legal/ + docs/USAGE-NOTICE.md
    const packagedLegalDir = path.join(resourcesDir, 'legal');
    const expected = new Map(repoLegalFiles.map((file) => [`legal/${file}`, path.join(root, 'legal', file)]));
    if (existsSync(path.join(root, 'docs/USAGE-NOTICE.md'))) {
      expected.set('legal/USAGE-NOTICE.md', path.join(root, 'docs/USAGE-NOTICE.md'));
    }
    const packagedLegalFiles = existsSync(packagedLegalDir) ? walkFiles(packagedLegalDir) : [];
    notes.push(`安装包 legal/ 文件 ${packagedLegalFiles.length} 个`);
    const packagedSet = new Set(packagedLegalFiles);
    for (const [relative, source] of expected) {
      const packagedRelative = relative.replace(/^legal\//, '');
      if (!packagedSet.has(packagedRelative)) {
        fail(`安装包 legal/ 缺少 ${packagedRelative}（仓库对应 ${path.relative(root, source)}）`);
        continue;
      }
      if (
        sha256(readFileSync(path.join(packagedLegalDir, packagedRelative))) !==
        sha256(readFileSync(source))
      ) {
        fail(`安装包 legal/${packagedRelative} 与仓库对应文件内容不一致`);
      }
    }
    const expectedPackagedNames = new Set(
      [...expected.keys()].map((relative) => relative.replace(/^legal\//, ''))
    );
    for (const file of packagedLegalFiles) {
      if (!expectedPackagedNames.has(file)) {
        fail(`安装包 legal/ 出现仓库没有的额外文件：${file}（两侧必须同为完整集合）`);
      }
    }

    // 8.3 Electron 运行时许可证（安装根目录）与 legal/electron 副本一致
    const runtimeLicenses = [
      ['LICENSE.electron.txt', 'legal/electron/LICENSE.txt'],
      ['LICENSES.chromium.html', 'legal/electron/LICENSES.chromium.html']
    ];
    for (const [packagedName, repoName] of runtimeLicenses) {
      const packaged = path.join(unpackedDir, packagedName);
      if (!existsSync(packaged)) {
        fail(`安装包缺少 ${packagedName}`);
      } else if (!sameTextFiles(packaged, path.join(root, repoName))) {
        fail(`安装包 ${packagedName} 与仓库 ${repoName} 内容不一致`);
      }
    }

    // 8.4 app.asar：LICENSE/NOTICE 由 electron-builder 放在 resources 根目录（上面已核对），
    //     这里只确认 asar 内不再残留已移除的 CLA.md。
    const asarPath = path.join(resourcesDir, 'app.asar');
    if (!existsSync(asarPath)) {
      fail('安装包缺少 resources/app.asar');
    } else {
      try {
        const pnpmDir = path.join(root, 'node_modules/.pnpm');
        const asarDir = readdirSync(pnpmDir).find((name) => name.startsWith('@electron+asar@'));
        const asar = asarDir
          ? createRequire(import.meta.url)(path.join(pnpmDir, asarDir, 'node_modules/@electron/asar'))
          : null;
        if (!asar) {
          fail('缺少 @electron/asar，无法检查 app.asar 内的法律文件');
        } else {
          const entries = asar
            .listPackage(asarPath)
            .map((entry) => entry.split(String.fromCharCode(92)).join('/'));
          if (entries.some((entry) => entry.endsWith('/CLA.md') || entry === '/CLA.md')) {
            fail('app.asar 中包含已移除的 CLA.md');
          }
        }
      } catch (error) {
        fail(`检查 app.asar 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 8.5 安装包 / 更新元数据版本与 package.json 一致
    const releaseDir = path.join(root, 'apps/desktop/release');
    const installerName = `Studianda-Setup-${version}.exe`;
    const installerFile = path.join(releaseDir, installerName);
    const anyInstallers = existsSync(releaseDir)
      ? readdirSync(releaseDir).filter((name) => /^Studianda-Setup-.*\.exe$/i.test(name))
      : [];
    if (installerFile && existsSync(installerFile)) {
      const latestPath = path.join(releaseDir, 'latest.yml');
      if (!existsSync(latestPath)) {
        fail('安装包已生成但缺少 latest.yml');
      } else {
        const latestVersion = normalize(readFileSync(latestPath, 'utf8')).match(
          /^version:\s*(.+)$/m
        )?.[1];
        if (latestVersion?.trim() !== version) {
          fail(`latest.yml 版本 ${latestVersion ?? '(缺失)'} 与 package.json ${version} 不一致`);
        }
      }
      const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt');
      if (!existsSync(sumsPath)) {
        fail('安装包已生成但缺少 SHA256SUMS.txt');
      } else {
        const sumsText = normalize(readFileSync(sumsPath, 'utf8'));
        const expectedHash = sha256(readFileSync(installerFile));
        if (!sumsText.toLowerCase().includes(expectedHash)) {
          fail('SHA256SUMS.txt 中的安装包哈希与文件不一致');
        }
      }
      const manifestPath = path.join(releaseDir, 'build-manifest.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.version !== version || manifest.versions?.root !== version) {
          fail('build-manifest.json 版本与 package.json 不一致');
        }
      }
      notes.push(`安装包 ${installerName}（${sha256(readFileSync(installerFile)).slice(0, 16)}…）`);
    } else if (anyInstallers.length > 0) {
      // 只构建 --dir 时 release 目录可能残留旧版本安装包；安装包版本由 scripts/package.mjs 把关。
      notes.push(`当前未生成 ${installerName}；忽略 release 目录中的旧安装包：${anyInstallers.join(', ')}`);
    } else {
      notes.push('未生成安装包（仅 --dir）：跳过安装包/更新元数据版本校验');
    }
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
if (notes.length > 0) {
  for (const note of notes) console.log(`[check:legal] ${note}`);
}
if (problems.length > 0) {
  console.error(`[check:legal] 失败：发现 ${problems.length} 个问题`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `[check:legal] 通过：仓库与${checkPackage ? '安装包' : '（未检查安装包，使用 --package 检查）'}法律文件完备且一致`
);
