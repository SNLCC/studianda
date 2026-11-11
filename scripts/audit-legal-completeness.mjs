/**
 * 校验法律相关文件：源码仓库与安装包两侧必须**各自完备**，而不是互补。
 *
 * 用法（仓库根目录）：
 *   node scripts/audit-legal-completeness.mjs             # 只校验仓库内法律文件集合与内部一致性
 *   node scripts/audit-legal-completeness.mjs --package   # 额外校验 apps/desktop/release/win-unpacked
 *
 * 退出码：0 = 通过；1 = 有缺项/不一致（逐条打印原因）。
 */
import { createHash } from 'node:crypto';
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
  'apps/desktop/build/INSTALLER-NOTICE.txt'
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
// 2) 仓库内同一法律文本的多份副本必须一致
// ---------------------------------------------------------------------------
const copyPairs = [
  ['LICENSE', 'legal/PROJECT-LICENSE.txt'],
  ['NOTICE', 'legal/PROJECT-NOTICE.txt']
];
for (const [canonical, copy] of copyPairs) {
  if (!existsSync(path.join(root, canonical)) || !existsSync(path.join(root, copy))) continue;
  if (sha256Of(canonical) !== sha256Of(copy)) {
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
    'PolyForm Noncommercial',
    'LICENSE',
    'NOTICE',
    'USAGE-NOTICE.md',
    'resources/legal/'
  ]) {
    if (!text.includes(needle)) {
      fail(`INSTALLER-NOTICE.txt 未提及 ${needle}`);
    }
  }
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
      } else if (sha256(readFileSync(packaged)) !== sha256Of(name)) {
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
      } else if (sha256(readFileSync(packaged)) !== sha256Of(repoName)) {
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
