import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legalDir = path.join(root, 'legal');
const licensesDir = path.join(legalDir, 'licenses');
const asarPath =
  process.env.STUDIANDA_ASAR ??
  path.join(root, 'apps/desktop/release/win-unpacked/resources/app.asar');
if (!existsSync(asarPath)) {
  console.error(`missing packaged app.asar: ${asarPath}`);
  console.error('先运行 electron-builder --dir，再运行本审计脚本。');
  process.exitCode = 1;
  process.exit();
}

function loadAsar() {
  const pnpmDir = path.join(root, 'node_modules/.pnpm');
  const match = readdirSync(pnpmDir).find((name) => name.startsWith('@electron+asar@'));
  if (!match) throw new Error('@electron/asar not installed');
  return createRequire(import.meta.url)(
    path.join(pnpmDir, match, 'node_modules/@electron/asar')
  );
}

const asar = loadAsar();
const extractRoot = mkdtempSync(path.join(tmpdir(), 'studianda-legal-asar-'));
asar.extractAll(asarPath, extractRoot);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (entry) =>
  entry.split(String.fromCharCode(92)).join('/').replace(/^\/+/, '');
const entries = asar.listPackage(asarPath).map(normalize);
console.log(`asarEntries=${entries.length}`);
const licensePattern =
  /(^|\/)(LICEN[CS]E|LICENCE|COPYING|NOTICE|MODEL-LICENSES|THIRD[-_ ]?PARTY|PATENTS|AUTHORS|COPYRIGHT)([-_.].*)?$/i;

rmSync(licensesDir, { recursive: true, force: true });
mkdirSync(licensesDir, { recursive: true });
mkdirSync(path.join(legalDir, 'upstream'), { recursive: true });

function walkFiles(dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) result.push(...walkFiles(full));
    else result.push(full);
  }
  return result;
}

function packageRecords() {
  const records = new Map();
  const extractedFiles = walkFiles(extractRoot);
  const packageFiles = extractedFiles.filter((file) => path.basename(file) === 'package.json');
  for (const packageFile of packageFiles) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name || !pkg.version || pkg.name.startsWith('@studianda/')) continue;
    const dir = path.dirname(packageFile);
    if (!dir.split(path.sep).includes('node_modules')) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (!records.has(key)) {
      records.set(key, {
        name: pkg.name,
        version: pkg.version,
        license:
          typeof pkg.license === 'string'
            ? pkg.license
            : Array.isArray(pkg.licenses)
              ? pkg.licenses.map((item) => item?.type ?? String(item)).join(' OR ')
              : pkg.license?.type ?? '未声明',
        repository:
          typeof pkg.repository === 'string'
            ? pkg.repository
            : pkg.repository?.url ?? pkg.homepage ?? '',
        homepage: pkg.homepage ?? '',
        packageJson: path.relative(extractRoot, packageFile).split(path.sep).join('/'),
        licenseFiles: []
      });
    }
    const record = records.get(key);
    for (const fullPath of walkFiles(dir)) {
      const relative = path.relative(dir, fullPath).split(path.sep).join('/');
      if (relative.split('/').includes('node_modules')) continue;
      if (!licensePattern.test(relative)) continue;
      if (!statSync(fullPath).isFile()) continue;
      const targetName = `${key.replace(/[\\/:*?"<>|]/g, '_')}-${relative.replace(
        /[\\/:*?"<>|]/g,
        '_'
      )}`;
      const targetPath = path.join(licensesDir, targetName);
      if (record.licenseFiles.some((entry) => entry.path === `licenses/${targetName}`)) continue;
      copyFileSync(fullPath, targetPath);
      record.licenseFiles.push({
        path: `licenses/${targetName}`,
        entry: relative,
        sha256: sha256(readFileSync(fullPath))
      });
    }
  }
  return records;
}

const records = [...packageRecords().values()];

// 随包字体：不在 node_modules 里，来源与覆盖口径见 legal/fonts.json，
// woof2 由 scripts/build-fonts.py 从官方发行物生成；许可证原文放 legal/font-licenses/。
const fontsManifestPath = path.join(legalDir, 'fonts.json');
const bundledFonts = [];
if (existsSync(fontsManifestPath)) {
  const fontsManifest = JSON.parse(readFileSync(fontsManifestPath, 'utf8'));
  for (const font of fontsManifest.fonts ?? []) {
    const licensePath = path.join(root, font.licenseFile);
    if (!existsSync(licensePath)) {
      console.warn(`missing font license: ${font.licenseFile}`);
      continue;
    }
    const targetName = `font-${font.id}-${path.basename(font.licenseFile)}`;
    copyFileSync(licensePath, path.join(licensesDir, targetName));
    const record = {
      font: true,
      name: font.name,
      version: font.version,
      license: font.license,
      repository: font.upstream,
      homepage: font.upstream,
      packageJson: '',
      fontAlias: font.alias,
      fontWeights: font.weights,
      fontRenamed: Boolean(font.renamed),
      fontReservedName: font.reservedFontName,
      fontCopyright: font.copyright ?? '',
      licenseFiles: [
        {
          path: `licenses/${targetName}`,
          entry: font.licenseFile,
          sha256: sha256(readFileSync(licensePath))
        }
      ]
    };
    bundledFonts.push(record);
    records.unshift(record);
  }
}

function byName(name) {
  return records.find((record) => record.name === name);
}

// 这些包没有随包许可证文件，使用上游仓库/发行包中的许可证原文。
function supplement(record) {
  const addUpstream = (file) => {
    const full = path.join(legalDir, file);
    if (!existsSync(full)) return;
    if (record.licenseFiles.some((entry) => entry.path === file)) return;
    record.licenseFiles.push({
      path: file,
      entry: file,
      sha256: sha256(readFileSync(full))
    });
  };

  if (record.name.startsWith('@img/sharp-libvips-')) {
    addUpstream('upstream/LGPL-3.0.txt');
    addUpstream('upstream/GPL-3.0.txt');
    record.licenseSource = 'upstream LGPL-3.0';
    return;
  }
  if (record.name.startsWith('@img/sharp-win32-')) {
    const parent = byName('sharp');
    if (parent?.licenseFiles.length) {
      for (const file of parent.licenseFiles) {
        if (!record.licenseFiles.some((entry) => entry.path === file.path)) {
          record.licenseFiles.push({ ...file });
        }
      }
      record.licenseSource = `${parent.name}@${parent.version} + LGPL-3.0`;
    }
    addUpstream('upstream/LGPL-3.0.txt');
    addUpstream('upstream/GPL-3.0.txt');
    return;
  }
  if (record.licenseFiles.length > 0) return;
  const parent = record.name.startsWith('@napi-rs/canvas-')
    ? byName('@napi-rs/canvas')
    : record.name.startsWith('@img/sharp-') && !record.name.startsWith('@img/sharp-libvips-')
      ? byName('sharp')
      : null;
  if (parent?.licenseFiles.length) {
    record.licenseFiles = parent.licenseFiles.map((file) => ({ ...file }));
    record.licenseSource = `${parent.name}@${parent.version}`;
    return;
  }
  const file =
    record.name === 'onnxruntime-node' || record.name === 'onnxruntime-common'
      ? 'upstream/ONNXRuntime-MIT.txt'
      : record.name.startsWith('@img/sharp-libvips-')
        ? 'upstream/LGPL-3.0.txt'
        : record.name === 'clipper-lib'
          ? 'upstream/BSL-1.0.txt'
          : record.name === 'abstract-logging'
            ? 'upstream/AbstractLogging-MIT.txt'
            : record.name === 'lazy-val'
              ? 'upstream/LazyVal-MIT.txt'
              : record.name === 'tr46'
              ? 'upstream/tr46-MIT.txt'
              : '';
  if (file && existsSync(path.join(legalDir, file))) {
    record.licenseFiles = [
      {
        path: file,
        entry: file,
        sha256: sha256(readFileSync(path.join(legalDir, file)))
      }
    ];
    record.licenseSource = file;
  }
}

// 打包后的 fixture 包可能没有独立许可证；它们不是应用运行时依赖。
const fixtureNames = new Set(['benchmarks', 'benchmark', 'busboy-benchmarks', 'transport']);
for (const record of records) {
  supplement(record);
  if (fixtureNames.has(record.name) && record.licenseFiles.length === 0) {
    record.fixture = true;
  }
}

const electronDir = path.join(root, 'apps/desktop/node_modules/electron/dist');
const electronLicense = path.join(electronDir, 'LICENSE');
const electronChromium = path.join(electronDir, 'LICENSES.chromium.html');
const electronVersion = JSON.parse(
  readFileSync(path.join(root, 'apps/desktop/node_modules/electron/package.json'), 'utf8')
).version;
const runtimeDir = path.join(legalDir, 'runtime');
mkdirSync(runtimeDir, { recursive: true });
if (existsSync(electronLicense)) {
  copyFileSync(electronLicense, path.join(legalDir, 'electron/LICENSE.txt'));
}
if (existsSync(electronChromium)) {
  copyFileSync(electronChromium, path.join(legalDir, 'electron/LICENSES.chromium.html'));
}
const nodeLicenseDest = path.join(runtimeDir, 'Node-LICENSE.txt');
const nodeLicenseCandidates = [
  path.join(path.dirname(process.execPath), 'LICENSE'),
  path.join(path.dirname(path.dirname(process.execPath)), 'LICENSE')
];
const nodeLicense = nodeLicenseCandidates.find((candidate) => existsSync(candidate));
if (nodeLicense) copyFileSync(nodeLicense, nodeLicenseDest);
if (!existsSync(nodeLicenseDest)) {
  console.error('[legal] 缺少 Node.js 许可证：请在 legal/runtime/Node-LICENSE.txt 放好官方 LICENSE 后重试。');
  process.exitCode = 1;
}
const nodeLicenseHash = existsSync(nodeLicenseDest) ? sha256(readFileSync(nodeLicenseDest)) : '';
const runtimeRecords = [  {
    name: 'Electron',
    version: electronVersion,
    license: 'MIT',
    repository: 'https://github.com/electron/electron',
    licenseFiles: [
      { path: 'electron/LICENSE.txt', sha256: existsSync(electronLicense) ? sha256(readFileSync(electronLicense)) : '' }
    ]
  },
  {
    name: 'Chromium',
    version: `bundled with Electron ${electronVersion}`,
    license: 'BSD-3-Clause and third-party notices',
    repository: 'https://www.chromium.org/',
    licenseFiles: [
      {
        path: 'electron/LICENSES.chromium.html',
        sha256: existsSync(electronChromium) ? sha256(readFileSync(electronChromium)) : ''
      }
    ]
  },
  {
    name: 'Node.js',
    version: process.versions.node,
    license: 'MIT',
    repository: 'https://github.com/nodejs/node',
    licenseFiles: nodeLicenseHash
      ? [{ path: 'runtime/Node-LICENSE.txt', sha256: nodeLicenseHash }]
      : []
  }
];

const generatedAt = '__GENERATED_AT__';
const missing = records.filter((record) => record.licenseFiles.length === 0 && !record.fixture);
const rows = records
  .filter((record) => !record.font)
  .map(
    (record) =>
      `| ${record.name} | ${record.version} | ${record.license} | ${
        record.licenseFiles.length > 0
          ? record.licenseFiles.map((file) => `[${path.basename(file.path)}](${file.path})`).join('<br>')
          : record.fixture
            ? '测试/基准 fixture，无独立许可证文件'
            : '缺失（需补充）'
      } |`
  )
  .join('\n');

const fontRows = bundledFonts
  .map(
    (record) =>
      `| ${record.name} | ${record.version} | \`${record.fontAlias}\` | ${record.license} | ${
        record.licenseFiles.map((file) => `[${path.basename(file.path)}](${file.path})`).join('<br>')
      } |`
  )
  .join('\n');

const fontNotes = bundledFonts
  .map((record) => {
    const weights = Array.isArray(record.fontWeights) ? record.fontWeights.join(' / ') : '';
    const rename = record.fontRenamed
      ? `已按 OFL 第 3 条改名（原保留名：${record.fontReservedName}），版权声明、作者与许可字段原样保留`
      : '保留字体内部名（其保留名与本项目命名不冲突）';
    return `- \`${record.fontAlias}\`：字重 ${weights}；${rename}；版权声明：${record.fontCopyright || '见许可证原文'}；来源 ${record.repository}；覆盖口径见 \`legal/fonts.json\`。`;
  })
  .join('\n');

const sourceRows = records
  .filter((record) => !record.font)
  .map(
    (record) =>
      `| ${record.name} | ${record.version} | ${record.repository || '未声明'} | ${record.license} | ${
        record.licenseFiles.map((file) => file.sha256).join('<br>') || '—'
      } |`
  )
  .join('\n');

const embeddedNotes = `## 内嵌原生二进制（native binary）/ WASM / 安装器组件

以下组件内嵌在二进制、WASM 或安装器中，不单独出现在 node_modules 依赖树；本节的许可证原文均在 \`legal/upstream/\` 下随包分发。

- @napi-rs/canvas 原生二进制（Node-API native addon）：包含 Skia、ICU、libavif 0.14.0 / libavif-sys 0.17.0、libaom-sys 0.17.2（BSD-2-Clause）、libjpeg-turbo（IJG/BSD/Zlib）、libloading 0.9.0（ISC）、foldhash 0.2.0 / bytemuck 1.25.2（Zlib）、MPL-2.0 组件（cssparser、cssparser-macros、dtoa-short、selectors）等 142 个 SBOM 组件。清单与逐组件许可证类型见 \`upstream/official/napi-canvas/NAPI-CANVAS-THIRD-PARTY.md\` 、\`COMPONENTS.md\` 、\`COMPONENT-LICENSES.md\` 与 \`sbom.cdx.json\`，原文见同目录；MPL-2.0 源码获取方式见该说明。
- Tesseract.js-core WASM：内嵌 Tesseract、Leptonica、giflib、libjpeg-turbo、libpng、libtiff、libwebp、openlibm、zlib；说明见 \`upstream/Tesseract-core-THIRD-PARTY.md\`，原文见 \`upstream/official/tesseract-core/\`。
- PDF.js WASM / 资源：JBIG2、OpenJPEG、QCMS、CMaps、标准字体、ICC；说明见 \`upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md\`。
- tesseract.js 预构建 dist：内嵌 buffer 6.0.3（MIT）、ieee754 1.2.1（BSD-3-Clause）、regenerator-runtime（MIT）、zlib.js（MIT）；buffer/ieee754 原文见 \`upstream/official/tesseract-embedded/\`。
- NSIS 安装器：安装器 stub 使用 NSIS 3.0.4.1（zlib/libpng license），许可证原文见 \`upstream/official/nsis-COPYING.txt\`。
- nsis7z.dll：NSIS 的 7z 解压插件（安装时解压 app-64.7z），基于 7-Zip 19.00 源码（Nik Medved / Igor Pavlov）；按 7-Zip License（GNU LGPL-2.1+，含 unRAR 限制）分发。许可原文、来源与完整对应源码见 \`upstream/official/nsis7z/\`。
- StdUtils.dll：NSIS 插件（electron-builder 模板使用），作者 LoRd_MuldeR；按 GNU LGPL-2.1-or-later 分发，许可、澄清说明与完整对应源码见 \`upstream/official/nsis-plugins/stdutils/\`。
- UAC.dll：NSIS 提权插件，作者 Anders；按 ZLIB/LIBPNG License 分发，许可与源码见 \`upstream/official/nsis-plugins/uac/\`。
- WinShell.dll：NSIS 快捷方式/AppUserModelID 插件，作者 Anders；上游页面标注 Freeware，来源记录见 \`upstream/official/nsis-plugins/winshell/\`。
- elevate.exe：NSIS 提权辅助程序（MIT，Copyright (c) 2007 Johannes Passing），原文见 \`upstream/official/elevate-MIT.txt\`。
- FFmpeg：Electron 内置 \`ffmpeg.dll\`（LGPL-2.1-or-later，Electron 官方构建，未修改）；源代码与构建配置见 https://github.com/electron/electron ，许可证见 \`upstream/official/ffmpeg-LGPL-2.1.txt\`。
- pako 的 zlib 兼容层：说明见 \`upstream/official/pako-zlib-README.txt\`。
`;

const markdown = `# 第三方组件与许可证声明

生成时间：${generatedAt}

本清单从**实际安装包** \`resources/app.asar\` 的依赖树生成，覆盖渲染器、Core 和生产依赖；不是仅根据源码清单推测。

本项目的 PolyForm Noncommercial 1.0.0 许可证仅适用于本项目原创代码；随包分发的第三方组件仍分别适用其自身许可证，本项目许可证不改变、不限制这些组件在其许可证下的权利。

## Electron 与 Chromium

- Electron：${electronVersion}，MIT License；
- Chromium：Electron 内置，第三方许可证全文见 \`electron/LICENSES.chromium.html\`；
- Electron 自身许可证：\`electron/LICENSE.txt\`；
- Node.js：${process.versions.node}，MIT License，许可证见 \`runtime/Node-LICENSE.txt\`。

## 随安装包分发的运行时依赖

| 组件 | 版本 | 许可证 | 许可证文件 |
|---|---|---|---|
${rows}

## 随包字体

字体文件由 \`scripts/build-fonts.py\` 从官方发行物生成（冻结静态字重 + 子集化 + woff2），不属于 npm 依赖树，故单独列出。

| 字体 | 版本 | 部署别名 | 许可证 | 许可证文件 |
|---|---|---|---|---|
${fontRows}

${fontNotes}

${embeddedNotes}

## 运行时下载、不随包分发的资源

- Tesseract 语言训练数据（eng、chi_sim、chi_tra、jpn、kor、deu、fra、rus 等）：不包含在 npm 包中，也不随本安装包分发；用户在本机 OCR 设置里选择语言并点「下载所选语言包」后，才由主进程从 Tesseract 官方 tessdata_fast 发行物按需下载（Apache-2.0，官方仓库 https://github.com/tesseract-ocr/tessdata_fast ）；下载先走官方 raw（https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/<语言代码>.traineddata），该域名不可达时回退 GitHub 官方 Contents API（https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents/<语言代码>.traineddata?ref=main，Accept: application/vnd.github.raw），两者都是 HTTPS、同一仓库同一文件，不用第三方镜像；官方许可证原文见 legal/upstream/Tesseract-tessdata-APACHE-2.0.txt；缓存在用户数据目录 ocr-tessdata/langs/，删除数据目录即移除；这是用户主动触发的数据下载（只取模型文件，不上传文献或问题），首次下载会向 GitHub 下载域名暴露 IP/时间；
- Tesseract.js-core 的 WASM 内嵌 Tesseract、Leptonica、giflib、libjpeg、libpng、libtiff、libwebp、openlibm、zlib；官方许可证已补入 legal/upstream/official/tesseract-core/，说明见 legal/upstream/Tesseract-core-THIRD-PARTY.md；
- @napi-rs/canvas 原生二进制（Node-API native addon）包含 Skia、ICU 和 Rust 组件；SBOM 与 Skia/ICU/MPL/各 Rust 组件许可证已补入 legal/upstream/official/napi-canvas/，SBOM 142 个组件的许可证类型已全部映射（0 个未覆盖）；具体版权行见该目录下对应组件原文；其中 MPL-2.0 组件（cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0）的源码可从 https://github.com/servo/rust-cssparser 、https://github.com/upsuper/dtoa-short 、https://github.com/servo/stylo 获取，许可证原文见 legal/upstream/official/napi-canvas/MPL-2.0.txt；
- PDF.js 的 WASM 解码组件（JBIG2、OpenJPEG、QCMS）以及 CMaps、标准字体、ICC 随应用分发；它们属于 pdfjs-dist 包内资源，不是新增 npm 依赖，许可证和版权声明见 legal/upstream/official/pdfjs-wasm/；

## 清单范围

本清单的 npm 依赖表只列安装包 \`node_modules\` 中实际存在的包；字体、内嵌原生二进制/WASM 组件、安装器组件与运行时下载资源分别见上文各节。

## 说明

- 许可证文件来自安装包内的实际文件；缺失项用 \`legal/upstream/\` 中的上游原文补充，并在 \`inventory.json\` 标记来源；
- \`legal/SOURCES.md\` 记录每个组件的官方仓库地址和许可证文件哈希；
- 官方仓库许可证原文证据保存在 \`legal/upstream/official/repos/\`；
- 本文件是工程记录，不构成法律意见；商业发布前应做人工法律复核。

## 再分发

安装包内保留 \`legal/\` 目录。再分发时不得删除该目录及其中的许可证原文。
`;

const sources = `# 许可证来源与哈希

生成时间：${generatedAt}

“官方仓库”列取自各包 \`package.json\` 的 repository/homepage；许可证文件哈希取自安装包内实际文件。

| 组件 | 版本 | 官方仓库 | 声明许可证 | 许可证 SHA-256 |
|---|---|---|---|---|
${sourceRows}

## Electron / Chromium

- Electron 官方发行物：\`apps/desktop/node_modules/electron/dist\`
- Electron LICENSE: \`electron/LICENSE.txt\`
- Chromium 第三方声明: \`electron/LICENSES.chromium.html\`
- Node.js 官方发行物许可证: \`runtime/Node-LICENSE.txt\`（SHA-256: ${nodeLicenseHash || '缺失'}）
- Electron 版本：${electronVersion}
- Node.js 版本：${process.versions.node}

## 安装器组件

- NSIS 3.0.4.1（zlib/libpng license）：\`upstream/official/nsis-COPYING.txt\`
- nsis7z.dll（基于 7-Zip 19.00，7-Zip License / LGPL-2.1+，含 unRAR 限制）：许可与来源见 \`upstream/official/nsis7z/\`
- StdUtils.dll（LoRd_MuldeR，GNU LGPL-2.1+）：许可、澄清与源码见 \`upstream/official/nsis-plugins/stdutils/\`
- UAC.dll（Anders，ZLIB/LIBPNG）：许可与源码见 \`upstream/official/nsis-plugins/uac/\`
- WinShell.dll（Anders，上游页面标注 Freeware）：来源记录见 \`upstream/official/nsis-plugins/winshell/\`
- elevate.exe（MIT）：\`upstream/official/elevate-MIT.txt\`
- FFmpeg（Electron 内置 ffmpeg.dll，LGPL-2.1-or-later）：\`upstream/official/ffmpeg-LGPL-2.1.txt\`

${missing.length === 0 ? '' : `## 缺失项\n\n${missing.map((record) => `- ${record.name}@${record.version}（${record.license}）`).join('\n')}\n`}
## 免责声明

本清单由脚本自动生成；官方仓库地址和许可证文本可能随上游更新。升级依赖后请重新运行 \`node scripts/audit-packaged-legal.mjs\`。
`;
const htmlEscape = (value) =>
  String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const licenseBlocks = [];
for (const record of records) {
  for (const file of record.licenseFiles) {
    const fullPath = path.join(legalDir, file.path);
    let content = '';
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      content = '（无法读取）';
    }
    licenseBlocks.push(
      `<h3>${htmlEscape(record.name)}@${htmlEscape(record.version)} · ${htmlEscape(
        path.basename(file.path)
      )}</h3><pre>${htmlEscape(content.replace(/[ \t]+$/gm, ''))}</pre>`
    );
  }
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>勘读 Studianda 第三方声明</title>
<style>body{max-width:1000px;margin:40px auto;padding:0 20px;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#2c2a24;background:#f4eedf}h1,h2,h3{font-family:Georgia,serif}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #d8cdb8;padding:5px 7px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#fbf7ed;border:1px solid #e3d9c5;padding:10px;font-size:11px;max-height:420px;overflow:auto}a{color:#4f765e}</style></head><body>
<h1>勘读 Studianda 第三方组件与许可证声明</h1><p>生成时间：${htmlEscape(generatedAt)}</p>
<p>本项目的 PolyForm Noncommercial 1.0.0 许可证仅适用于本项目原创代码；随包分发的第三方组件仍分别适用其自身许可证，本项目许可证不改变、不限制这些组件在其许可证下的权利。</p>
<p>Electron ${htmlEscape(electronVersion)} / Chromium：许可证见 <a href="electron/LICENSE.txt">electron/LICENSE.txt</a> 与 <a href="electron/LICENSES.chromium.html">Chromium 第三方声明</a>；Node.js ${htmlEscape(process.versions.node)}：<a href="runtime/Node-LICENSE.txt">Node-LICENSE.txt</a>。</p>
<table><thead><tr><th>组件</th><th>版本</th><th>许可证</th><th>许可证文件</th></tr></thead><tbody>
${records
  .map(
    (record) =>
      `<tr><td>${htmlEscape(record.name)}</td><td>${htmlEscape(record.version)}</td><td>${htmlEscape(
        record.license
      )}</td><td>${record.licenseFiles
        .map((file) => `<a href="${htmlEscape(file.path)}">${htmlEscape(path.basename(file.path))}</a>`)
        .join('<br>') || (record.fixture ? '测试/基准 fixture' : '缺失')}</td></tr>`
  )
  .join('\n')}
</tbody></table>
${bundledFonts.length
  ? `<h2>随包字体</h2><p>字体由官方发行物子集化并转为 woff2，随安装包分发；许可证原文见下方。</p>
<table><thead><tr><th>字体</th><th>版本</th><th>部署别名</th><th>许可证</th><th>许可证文件</th></tr></thead><tbody>
${bundledFonts
  .map(
    (record) =>
      `<tr><td>${htmlEscape(record.name)}</td><td>${htmlEscape(record.version)}</td><td>${htmlEscape(
        record.fontAlias
      )}</td><td>${htmlEscape(record.license)}</td><td>${record.licenseFiles
        .map((file) => `<a href="${htmlEscape(file.path)}">${htmlEscape(path.basename(file.path))}</a>`)
        .join('<br>')}</td></tr>`
  )
  .join('\n')}
</tbody></table>`
  : ''}
<h2>内嵌原生二进制（native binary）/ WASM / 安装器组件</h2>
<p>以下组件内嵌在二进制、WASM 或安装器中，不单独出现在 node_modules 表；原文见 <a href="upstream/">legal/upstream/</a>。</p>
<ul>
<li><a href="upstream/official/napi-canvas/NAPI-CANVAS-THIRD-PARTY.md">@napi-rs/canvas 原生二进制（Node-API native addon）</a>（Skia、ICU、libavif/libaom、libjpeg-turbo、MPL-2.0 等 142 个组件；<a href="upstream/official/napi-canvas/sbom.cdx.json">SBOM</a> / <a href="upstream/official/napi-canvas/COMPONENTS.md">组件清单</a> / <a href="upstream/official/napi-canvas/COMPONENT-LICENSES.md">许可证全文</a> / <a href="upstream/official/napi-canvas/COMPONENT-COMPLIANCE.md">合规矩阵</a> / <a href="upstream/official/napi-canvas/COMPONENT-LICENSES.md">许可证全文</a>）</li>
<li><a href="upstream/Tesseract-core-THIRD-PARTY.md">Tesseract.js-core WASM</a>（Tesseract、Leptonica、libjpeg-turbo、libpng、libtiff、libwebp、giflib、openlibm、zlib）</li>
<li><a href="upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md">PDF.js WASM/资源</a>（JBIG2、OpenJPEG、QCMS、CMaps、标准字体、ICC）</li>
<li><a href="upstream/official/tesseract-embedded/SOURCES.json">tesseract.js 预构建 dist</a>（buffer、ieee754、regenerator-runtime、zlib.js）</li>
<li><a href="upstream/official/nsis-COPYING.txt">NSIS 安装器 stub</a>（zlib/libpng license）</li>
<li><a href="upstream/official/nsis7z/README.md">nsis7z.dll</a>（NSIS 7z 解压插件，基于 7-Zip 19.00；7-Zip License / LGPL-2.1+，含 unRAR 限制；<a href="upstream/official/nsis7z/README.md">许可、来源与随包源码</a>）</li>
<li><a href="upstream/official/nsis-plugins/stdutils/README.md">StdUtils.dll</a>（NSIS 插件，LoRd_MuldeR；GNU LGPL-2.1+；<a href="upstream/official/nsis-plugins/stdutils/">许可、澄清与随包源码</a>）</li>
<li><a href="upstream/official/nsis-plugins/uac/README.md">UAC.dll</a>（NSIS 提权插件，Anders；ZLIB/LIBPNG；<a href="upstream/official/nsis-plugins/uac/">许可与源码</a>）</li>
<li><a href="upstream/official/nsis-plugins/winshell/README.md">WinShell.dll</a>（NSIS 快捷方式/AppUserModelID 插件，Anders；来源记录）</li>
<li><a href="upstream/official/elevate-MIT.txt">elevate.exe</a>（MIT，Copyright (c) 2007 Johannes Passing）</li>
<li><a href="upstream/official/ffmpeg-LGPL-2.1.txt">FFmpeg（Electron 内置 ffmpeg.dll，LGPL-2.1-or-later）</a>；源代码见 <a href="https://github.com/electron/electron">electron/electron</a></li>
</ul>
<h2>许可证原文</h2>${licenseBlocks.join('\n')}
</body></html>`;
const inventory = {
  generatedAt,
  electron: electronVersion,
  node: process.versions.node,
  asar: path.basename(asarPath),
  runtime: runtimeRecords,
  fonts: bundledFonts,
  missing,
  packages: records.filter((record) => !record.font)
};

const pendingFiles = [
  { file: path.join(legalDir, 'THIRD-PARTY.md'), content: markdown },
  { file: path.join(legalDir, 'SOURCES.md'), content: sources },
  { file: path.join(legalDir, 'NOTICE.html'), content: html },
  { file: path.join(legalDir, 'inventory.json'), content: JSON.stringify(inventory, null, 2) }
];
const normalizeGeneratedAt = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/生成时间：[^\n<]*/g, '生成时间：__GENERATED_AT__')
    .replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt": "__GENERATED_AT__"');
const declarationsChanged = pendingFiles.some(({ file, content }) => {
  try {
    return normalizeGeneratedAt(readFileSync(file, 'utf8')) !== normalizeGeneratedAt(content);
  } catch {
    return true;
  }
});
if (declarationsChanged) {
  const timestamp = new Date().toISOString();
  for (const { file, content } of pendingFiles) {
    writeFileSync(file, content.replaceAll('__GENERATED_AT__', timestamp), 'utf8');
  }
  console.log('legal declarations updated');
} else {
  console.log('legal declarations unchanged');
}

console.log(`packages=${records.length} licenses=${records.reduce((sum, r) => sum + r.licenseFiles.length, 0)} missing=${missing.length}`);
console.log(`output=${legalDir}`);
rmSync(extractRoot, { recursive: true, force: true });
