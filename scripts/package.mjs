/**
 * 可复现打包 + 更新元数据。
 *
 * 把「构建 → 清理 → deploy core → 打包 → 校验 core 产物 hash → 写 latest.yml /
 * SHA256SUMS → 写 manifest」固化为一条命令，避免安装包与源码脱节。
 *
 * 用法（仓库根目录）：
 *   node scripts/package.mjs             # 只生成未安装目录 release/win-unpacked
 *   node scripts/package.mjs --installer # 额外生成 NSIS 安装包与更新元数据
 *   node scripts/package.mjs --skip-build # 跳过构建（复用已有 dist/out，仅重打包）
 *
 * electron-builder 调用一律显式带 --publish never：本仓库的发布只由
 * .github/workflows/release.yml 用 gh release 完成，避免 CI 里被 electron-builder 隐式发布。
 *
 * 版本：electron-builder 读取 apps/desktop/package.json 的 version。脚本启动时断言它与
 * root package.json 一致；两者用 node scripts/bump-version.mjs 同步升级。
 *
 * 更新元数据（应用内更新依赖）：
 * - win-unpacked/resources/app-update.yml 是更新渠道配置。electron-builder 只在真正打包
 *   NSIS target 的 afterPack 阶段写它，本脚本的 --dir / --prepackaged 两段式打包不经过该
 *   阶段，所以缺省时按 electron-builder.yml 的 publish 配置补齐，并校验字段。
 * - apps/desktop/release/latest.yml 优先保留 electron-builder 生成的文件（校验
 *   version/path/files[0].size/files[0].sha512），缺失或对不上时按实际安装包自行生成
 *   electron-updater v6 兼容格式。
 * - 同目录输出 SHA256SUMS.txt；build-manifest.json 同时记录 root 与 desktop 的版本。
 *
 * 依赖安装与 Core deploy 都按 pnpm-lock.yaml 解析版本；deploy 需要访问 registry
 * （本地 store 已缓存全部 tarball 时可离线）。
 *
 * 不做：代码签名、安装测试；这些属于发布流程（见 docs/RELEASE.md）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createReadStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const desktopDir = path.join(root, 'apps', 'desktop');
const builderConfigFile = path.join(desktopDir, 'electron-builder.yml');
const outCoreDir = path.join(desktopDir, 'out', 'core');
const releaseDir = path.join(desktopDir, 'release');
const unpackedDir = path.join(releaseDir, 'win-unpacked');
const resourcesDir = path.join(unpackedDir, 'resources');
const appUpdateFile = path.join(resourcesDir, 'app-update.yml');
const sourceCoreFile = path.join(root, 'packages', 'core', 'dist', 'index.js');
const deployedCoreFile = path.join(outCoreDir, 'dist', 'index.js');
const installer = process.argv.includes('--installer');
const skipBuild = process.argv.includes('--skip-build');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** 统一失败出口：中文说明 + 细节，一律退出码 1。 */
function fail(message, details = []) {
  console.error(`[package] ${message}`);
  for (const line of details) console.error(`  ${line}`);
  process.exit(1);
}

function run(command, args, cwd = root) {
  console.log(`\n[package] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    fail(`失败：${command} ${args.join(' ')}（exit ${result.status ?? 'unknown'}）`);
  }
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

/** 一次读取同时算 sha256（SHA256SUMS.txt）与 sha512（latest.yml，base64）。 */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha256Hash = createHash('sha256');
    const sha512Hash = createHash('sha512');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      sha256Hash.update(chunk);
      sha512Hash.update(chunk);
    });
    stream.on('end', () => {
      resolve({ sha256: sha256Hash.digest('hex'), sha512: sha512Hash.digest('base64') });
    });
  });
}

function describe(file) {
  if (!existsSync(file)) return null;
  const stats = statSync(file);
  return {
    bytes: stats.size,
    sha256: sha256(file)
  };
}

function stripYamlQuotes(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * 读取 electron-builder.yml 里本脚本关心的两个字段。
 * 只支持单 provider 的映射写法（本仓库 electron-builder.yml 即如此）；publish 不是映射时
 * 会解析为空对象，随后报错提示，避免静默写出错误的 app-update.yml。
 */
function readElectronBuilderConfig() {
  if (!existsSync(builderConfigFile)) {
    fail(`缺少 ${path.relative(root, builderConfigFile)}。`);
  }
  const text = readFileSync(builderConfigFile, 'utf8');
  const artifactMatch = text.match(/^artifactName:\s*(.+)$/m);
  const lines = text.split(/\r?\n/);
  const publishStart = lines.findIndex((line) => /^publish:\s*$/.test(line));
  const publish = {};
  if (publishStart >= 0) {
    for (let index = publishStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      // 空行忽略；遇到下一个顶层键结束（publish 块内的行都有缩进）。
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) publish[match[1]] = stripYamlQuotes(match[2]);
    }
  }
  return {
    artifactName: artifactMatch ? stripYamlQuotes(artifactMatch[1]) : null,
    publish
  };
}

/** 读取 app-update.yml / latest.yml 里扁平的 key: value 行（够用即可，不引入 YAML 依赖）。 */
function readYamlFields(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) fields[match[1]] = stripYamlQuotes(match[2]);
  }
  return fields;
}

/** 读取 latest.yml：顶层字段 + files[0] 的 url/size/sha512。 */
function parseLatestYml(text) {
  const top = readYamlFields(text);
  const lines = text.split(/\r?\n/);
  const filesStart = lines.findIndex((line) => /^files:\s*$/.test(line));
  const firstFile = {};
  if (filesStart >= 0) {
    for (let index = filesStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s+(?:-\s*)?([A-Za-z0-9_-]+):\s*(.+)$/);
      if (!match) continue;
      // 只取第一个 files 条目：URL 里可能还有别的安装包条目，与本次校验无关。
      if (match[1] in firstFile) break;
      firstFile[match[1]] = stripYamlQuotes(match[2]);
    }
  }
  return {
    version: top.version ?? null,
    path: top.path ?? null,
    sha512: firstFile.sha512 ?? null,
    url: firstFile.url ?? null,
    size: firstFile.size == null ? null : Number(firstFile.size)
  };
}

function renderLatestYml(info) {
  return [
    `version: ${info.version}`,
    'files:',
    `  - url: ${info.url}`,
    `    sha512: ${info.sha512}`,
    `    size: ${info.size}`,
    `path: ${info.path}`,
    `sha512: ${info.sha512}`,
    `releaseDate: ${new Date().toISOString()}`,
    ''
  ].join('\n');
}

/**
 * 与 app-builder-lib 的 AppInfo#updaterCacheDirName 保持一致：
 * sanitize-filename(metadata.name).toLowerCase() + '-updater'。
 * 本项目包名是 @studianda/desktop，只涉及 "/" 与 "@"，这里只镜像必要的清洗规则。
 */
function computeUpdaterCacheDirName(packageName) {
  const sanitized = packageName
    .replace(/[/?<>\\:*|"]/g, '')
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/^\.+$/, '')
    .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '')
    .replace(/[. ]+$/, '');
  return `${sanitized.toLowerCase()}-updater`;
}

// 0) 版本与 publish 配置预检：electron-builder 用 desktop 的 version，root 必须同步。
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const version = desktopPkg.version;
if (rootPkg.version !== version) {
  fail('版本不一致：root package.json 与 apps/desktop/package.json 的 version 必须相等。', [
    `  root package.json:          ${rootPkg.version}`,
    `  apps/desktop/package.json:  ${version}`,
    '  先运行 node scripts/bump-version.mjs <x.y.z> 同步版本。'
  ]);
}
const builderConfig = readElectronBuilderConfig();
const expectedArtifactName = 'Studianda-Setup-${version}.${ext}';
if (builderConfig.artifactName !== expectedArtifactName) {
  fail(`apps/desktop/electron-builder.yml 的 artifactName 应为 ${expectedArtifactName}。`, [
    `  当前值：${builderConfig.artifactName ?? '(缺失)'}`,
    '  本脚本按 Studianda-Setup-<version>.exe 查找安装包，两者必须一致。'
  ]);
}
if (builderConfig.publish.provider !== 'github' || !builderConfig.publish.owner || !builderConfig.publish.repo) {
  fail('apps/desktop/electron-builder.yml 的 publish 配置不完整。', [
    '  provider 必须为 github，且 owner / repo 不能为空；',
    '  应用内更新依赖这份配置生成 app-update.yml。'
  ]);
}
if (builderConfig.publish.releaseType && builderConfig.publish.releaseType !== 'draft') {
  console.warn(`[package] 注意：publish.releaseType 为 ${builderConfig.publish.releaseType}，本仓库发布流程按 draft 管理。`);
}
console.log(
  `[package] 版本 ${version}；publish：github ${builderConfig.publish.owner}/${builderConfig.publish.repo}` +
    `${builderConfig.publish.releaseType ? `（${builderConfig.publish.releaseType}）` : ''}`
);

// 1) 构建 shared + core + desktop（shared 是 core 的运行时依赖，必须先构建）。
if (!skipBuild) {
  run(pnpm, ['--filter', '@studianda/shared', 'build']);
  run(pnpm, ['--filter', '@studianda/core', 'build']);
  run(pnpm, ['--filter', '@studianda/desktop', 'build']);
} else {
  console.log('[package] --skip-build：跳过构建步骤');
}

// 2) 清理后重新 deploy Core 的生产依赖，避免残留旧版本（pnpm deploy 要求目录为空）。
//    不使用 --legacy：deploy 从共享 lockfile 解析，版本与 pnpm-lock.yaml 一致。
rmSync(outCoreDir, { recursive: true, force: true });
run(pnpm, [
  '--filter',
  '@studianda/core',
  'deploy',
  '--prod',
  '--config.node-linker=hoisted',
  '--store-dir',
  path.join(root, '.pnpm-store'),
  'apps/desktop/out/core'
]);

// 3) 校验部署后的 Core 入口与源码构建产物一致（防止打出手工旧副本）。
if (!existsSync(sourceCoreFile)) {
  fail('缺少 packages/core/dist/index.js，请先构建 core。');
}
if (!existsSync(deployedCoreFile)) {
  fail('缺少 apps/desktop/out/core/dist/index.js，Core deploy 失败。');
}
const sourceHash = sha256(sourceCoreFile);
const deployedHash = sha256(deployedCoreFile);
if (sourceHash !== deployedHash) {
  fail('Core 产物不一致：out/core 与 packages/core/dist 的 sha256 不同。', [
    `  source=${sourceHash}`,
    `  deployed=${deployedHash}`
  ]);
}
console.log(`[package] Core hash 校验通过：${sourceHash.slice(0, 16)}…`);

// 2.5) 移除 deploy 产生的本机构建路径元数据（不进安装包）。
for (const artifact of [
  path.join(outCoreDir, 'node_modules', '.modules.yaml'),
  path.join(outCoreDir, 'node_modules', '.pnpm-workspace-state-v1.json'),
  path.join(outCoreDir, 'node_modules', '.pnpm', 'lock.yaml')
]) {
  rmSync(artifact, { force: true });
}
rmSync(path.join(outCoreDir, 'node_modules', '.pnpm'), { recursive: true, force: true });
// 清理历史 deploy 试验目录，避免被打进 asar。
rmSync(path.join(outCoreDir, 'apps'), { recursive: true, force: true });
for (const entry of existsSync(path.join(desktopDir, 'out'))
  ? readdirSync(path.join(desktopDir, 'out'))
  : []) {
  if (entry.startsWith('deploy-test-')) {
    rmSync(path.join(desktopDir, 'out', entry), { recursive: true, force: true });
  }
}

// 4) 先用 --dir 生成一次 app.asar，再据此重新生成 legal/，然后把 legal/ 同步进
//    win-unpacked；安装包用 --prepackaged 基于同一目录生成，避免重复打包与下载。
//    两处都显式 --publish never：发布只由 release workflow 负责。
run(
  pnpm,
  ['exec', 'electron-builder', '--dir', '--publish', 'never', '--config', 'electron-builder.yml'],
  desktopDir
);
run('node', [path.join(root, 'scripts', 'audit-packaged-legal.mjs')]);
const packagedLegalDir = path.join(resourcesDir, 'legal');
rmSync(packagedLegalDir, { recursive: true, force: true });
cpSync(path.join(root, 'legal'), packagedLegalDir, { recursive: true });

// 4.2) app-update.yml：应用内更新的渠道配置，必须进安装包的 resources。
//      electron-builder 26 的 --dir / --prepackaged 两条路径都不会写它（只走真正的
//      NSIS target 的 afterPack），所以这里按 publish 配置生成。
//      每次都重写而不是"存在就保留"：该文件很小、内容由 publish 配置唯一决定，
//      保留旧文件会把上一次构建留下的非法内容继续打进安装包。
const expectedAppUpdate = {
  provider: builderConfig.publish.provider,
  owner: builderConfig.publish.owner,
  repo: builderConfig.publish.repo,
  ...(builderConfig.publish.releaseType ? { releaseType: builderConfig.publish.releaseType } : {}),
  updaterCacheDirName: computeUpdaterCacheDirName(desktopPkg.name)
};
if (!existsSync(resourcesDir)) {
  fail('缺少 win-unpacked/resources，无法生成 app-update.yml。');
}
// 值一律加 YAML 双引号：updaterCacheDirName 由包名清洗而来、以 @ 开头，
// 裸写会被 js-yaml 当作保留指令，electron-updater 加载配置时直接抛 YAMLException
// （表现为客户端"检查更新失败"，不是打包失败，必须在这里拦住）。
const appUpdateLines = Object.entries(expectedAppUpdate).map(
  ([key, value]) => `${key}: ${JSON.stringify(String(value))}`
);
for (const line of appUpdateLines) {
  if (!/^[A-Za-z0-9_-]+: "[^"\\]*"$/.test(line)) {
    fail(`app-update.yml 生成的 YAML 行不合法：${line}`);
  }
}
writeFileSync(appUpdateFile, `${appUpdateLines.join('\n')}\n`, 'utf8');
const written = readYamlFields(readFileSync(appUpdateFile, 'utf8'));
const bad = Object.entries(expectedAppUpdate).filter(([key, value]) => written[key] !== value);
if (bad.length > 0) {
  fail(`app-update.yml 校验失败：${bad.map(([key]) => key).join('、')} 与 publish 配置不一致。`);
}
console.log(
  `[package] 已写入 app-update.yml：${path.relative(root, appUpdateFile)}` +
    '（electron-builder 的 --dir/--prepackaged 路径不生成此文件）'
);

if (installer) {
  run(
    pnpm,
    [
      'exec',
      'electron-builder',
      '--win',
      'nsis',
      '--prepackaged',
      unpackedDir,
      '--publish',
      'never',
      '--config',
      'electron-builder.yml'
    ],
    desktopDir
  );
}

// 4.5) 一致性校验：inventory 的第三方包集合必须与最终 asar 一致，字体必须出现在声明中。
const packagedAsarPath = path.join(resourcesDir, 'app.asar');
const inventory = JSON.parse(readFileSync(path.join(root, 'legal', 'inventory.json'), 'utf8'));
const asarModule = (() => {
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const match = readdirSync(pnpmDir).find((name) => name.startsWith('@electron+asar@'));
  return match ? createRequire(import.meta.url)(path.join(pnpmDir, match, 'node_modules/@electron/asar')) : null;
})();
if (!asarModule) {
  fail('缺少 @electron/asar，无法做 inventory/asar 一致性校验。');
}
const asarEntries = asarModule.listPackage(packagedAsarPath).map((entry) => entry.split('\\').join('/'));
const asarPackages = new Set();
for (const entry of asarEntries) {
  const match = entry.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/);
  if (match && !match[1].startsWith('@studianda/')) asarPackages.add(match[1]);
}
const inventoryPackages = new Set(inventory.packages.filter((record) => !record.fixture).map((record) => record.name));
const missingDeclarations = [...asarPackages].filter((name) => !inventoryPackages.has(name));
const missingPackages = [...inventoryPackages].filter((name) => !asarPackages.has(name));
if (missingDeclarations.length || missingPackages.length) {
  fail('legal/inventory.json 与 asar 不一致。', [
    ...(missingDeclarations.length ? [`  未声明：${missingDeclarations.join(', ')}`] : []),
    ...(missingPackages.length ? [`  声明但未打包：${missingPackages.join(', ')}`] : [])
  ]);
}
const thirdParty = readFileSync(path.join(root, 'legal', 'THIRD-PARTY.md'), 'utf8');
for (const font of inventory.fonts) {
  if (!thirdParty.includes(font.name)) {
    fail(`字体未出现在 legal/THIRD-PARTY.md：${font.name}`);
  }
}
console.log(
  `[package] legal 一致性校验通过：${inventoryPackages.size} 个包、${inventory.fonts.length} 组字体。`
);

// 5) 安装包、latest.yml、SHA256SUMS：release workflow 直接上传这些文件。
const installerName = `Studianda-Setup-${version}.exe`;
let installerFile = null;
let blockmapFile = null;
let latestFile = null;
let sumsFile = null;
if (installer) {
  installerFile = path.join(releaseDir, installerName);
  if (!existsSync(installerFile)) {
    const candidates = existsSync(releaseDir)
      ? readdirSync(releaseDir).filter((name) => name.toLowerCase().endsWith('.exe'))
      : [];
    fail(`未找到安装包 ${installerName}。`, [
      ...(candidates.length > 0 ? [`release 目录现有 exe：${candidates.join(', ')}`] : []),
      '请检查 apps/desktop/electron-builder.yml 的 artifactName 是否与 scripts/package.mjs 的命名一致。'
    ]);
  }
  blockmapFile = `${installerFile}.blockmap`;
  if (!existsSync(blockmapFile)) {
    fail(`缺少差分更新文件 ${path.basename(blockmapFile)}（electron-builder 的 NSIS blockmap）。`);
  }
  if (!existsSync(appUpdateFile)) {
    fail('NSIS 打包后 win-unpacked/resources/app-update.yml 丢失，安装包不会带更新配置。');
  }

  const installerHash = await hashFile(installerFile);
  const installerSize = statSync(installerFile).size;
  latestFile = path.join(releaseDir, 'latest.yml');
  const expectedLatest = {
    version,
    url: installerName,
    path: installerName,
    size: installerSize,
    sha512: installerHash.sha512
  };
  const describeProblems = (parsed) => {
    const problems = [];
    if (parsed.version !== expectedLatest.version) problems.push(`version=${parsed.version ?? '(缺失)'}`);
    if (parsed.path !== expectedLatest.path) problems.push(`path=${parsed.path ?? '(缺失)'}`);
    if (parsed.url !== expectedLatest.url) problems.push(`files[0].url=${parsed.url ?? '(缺失)'}`);
    if (parsed.size !== expectedLatest.size) problems.push(`files[0].size=${parsed.size ?? '(缺失)'}`);
    if (parsed.sha512 !== expectedLatest.sha512) problems.push('files[0].sha512 与安装包不一致');
    return problems;
  };

  let keepExisting = false;
  if (existsSync(latestFile)) {
    const problems = describeProblems(parseLatestYml(readFileSync(latestFile, 'utf8')));
    if (problems.length === 0) {
      keepExisting = true;
      console.log('[package] 保留 electron-builder 生成的 latest.yml（version/path/size/sha512 校验通过）。');
    } else {
      console.warn(
        `[package] electron-builder 生成的 latest.yml 与安装包不一致（${problems.join('；')}），按实际产物重新生成。`
      );
    }
  } else {
    console.log('[package] electron-builder 没有生成 latest.yml，按实际产物自行生成。');
  }
  if (!keepExisting) {
    writeFileSync(latestFile, renderLatestYml(expectedLatest), 'utf8');
  }
  const latestProblems = describeProblems(parseLatestYml(readFileSync(latestFile, 'utf8')));
  if (latestProblems.length > 0) {
    fail(`latest.yml 校验失败：${latestProblems.join('；')}。`);
  }
  console.log(`[package] latest.yml 校验通过：${installerName}（${installerSize} 字节）。`);

  sumsFile = path.join(releaseDir, 'SHA256SUMS.txt');
  writeFileSync(sumsFile, `${installerHash.sha256}  ${installerName}\n`, 'utf8');
  console.log(`[package] SHA256SUMS.txt：${installerHash.sha256.slice(0, 16)}…  ${installerName}`);
}

// 6) 写 manifest：版本、commit、是否 dirty、关键产物 hash。
const packagedAsar = path.join(resourcesDir, 'app.asar');
if (existsSync(packagedAsar) && readFileSync(packagedAsar).includes(Buffer.from(root))) {
  fail('app.asar 中仍包含构建机绝对路径，拒绝产出安装包。');
}
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
const commit = (git.stdout ?? '').trim();
const dirty = (status.stdout ?? '').trim().length > 0;
const manifest = {
  name: rootPkg.name,
  // electron-builder 使用 apps/desktop/package.json 的 version；manifest.version 与之保持一致。
  version,
  versions: {
    root: rootPkg.version,
    desktop: desktopPkg.version
  },
  packagedAt: new Date().toISOString(),
  git: {
    commit: commit || null,
    dirty
  },
  runtime: {
    node: process.versions.node,
    electron: desktopPkg.devDependencies?.electron
  },
  core: {
    entry: 'out/core/dist/index.js',
    source: describe(sourceCoreFile),
    deployed: describe(deployedCoreFile)
  },
  artifacts: {
    winUnpacked: describe(path.join(unpackedDir, 'Studianda.exe')),
    asar: describe(packagedAsar),
    appUpdateYml: describe(appUpdateFile),
    ...(installer
      ? {
          installer: describe(installerFile),
          installerBlockmap: describe(blockmapFile),
          latestYml: describe(latestFile),
          sha256Sums: describe(sumsFile)
        }
      : {})
  }
};
// manifest 记录的一致性断言：root / desktop / version 三处必须相等。
if (
  manifest.version !== manifest.versions.desktop ||
  manifest.versions.root !== manifest.versions.desktop
) {
  fail('build-manifest 版本记录不一致：root 与 apps/desktop 的 version 必须相等。', [
    `  version=${manifest.version}，root=${manifest.versions.root}，desktop=${manifest.versions.desktop}`
  ]);
}
mkdirSync(releaseDir, { recursive: true });
const manifestFile = path.join(releaseDir, 'build-manifest.json');
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
// 写回校验，避免 manifest 与磁盘上的安装包版本脱节。
const writtenManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (
  writtenManifest.version !== version ||
  writtenManifest.versions?.root !== version ||
  writtenManifest.versions?.desktop !== version
) {
  fail('build-manifest.json 写回校验失败：版本记录不一致。');
}

console.log('\n[package] 完成');
console.log(`  版本：${version}（root / apps/desktop 一致）`);
console.log(`  产物目录：${path.relative(root, unpackedDir)}`);
if (installer) {
  console.log(`  安装包：${path.relative(root, installerFile)}`);
  console.log(`  更新元数据：${path.relative(root, latestFile)}、${path.relative(root, sumsFile)}`);
}
console.log(`  manifest：${path.relative(root, manifestFile)}`);
console.log(`  git：${commit || '(无)'}${dirty ? ' + dirty' : ''}`);
