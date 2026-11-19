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
// 字体构建清单提供每个 woff2/水印 TTF 的字节数与哈希，用来给 inventory 的 artifacts 做交叉核对：
// 随包字体文件必须与构建时写出的哈希一致，否则说明清单/文件已经不同步。
const fontBuildHashes = new Map();
const fontBuildManifestPath = path.join(
  root,
  'packages/ui/src/styles/assets/fonts/fonts.manifest.json'
);
if (existsSync(fontBuildManifestPath)) {
  for (const item of JSON.parse(readFileSync(fontBuildManifestPath, 'utf8'))) {
    if (item?.file && item?.sha256) fontBuildHashes.set(item.file, String(item.sha256).toUpperCase());
  }
}
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
      fontUpstreamName: font.upstreamName ?? '',
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
    // 字体的实物文件（woff2 与水印 TTF）全部在仓库工作区内，逐文件现算 bytes/sha256；
    // 同时与 scripts/build-fonts.py 写出的 fonts.manifest.json 对照，避免"声明一套、实物另一套"。
    record.ecosystem = 'bundled';
    record.kind = 'font-file';
    record.artifacts = [];
    let fontArtifactsMatchManifest = fontBuildHashes.size > 0;
    for (const relative of font.files ?? []) {
      const fullPath = path.join(root, relative);
      if (!existsSync(fullPath)) {
        console.warn(`[legal] 字体实物不存在：${relative}`);
        fontArtifactsMatchManifest = false;
        continue;
      }
      const artifact = {
        path: normalize(relative),
        bytes: statSync(fullPath).size,
        sha256: sha256(readFileSync(fullPath))
      };
      if (fontBuildHashes.get(path.basename(relative)) !== artifact.sha256.toUpperCase()) {
        fontArtifactsMatchManifest = false;
      }
      record.artifacts.push(artifact);
    }
    if (record.artifacts.length === 0) fontArtifactsMatchManifest = false;
    record.source = {
      url: font.upstream,
      sha256: font.sourceSha256 ?? null,
      verified: Boolean(font.sourceSha256) && fontArtifactsMatchManifest,
      reason: fontArtifactsMatchManifest
        ? 'source.sha256 为构建输入（上游变量字体）的哈希，记录于 legal/fonts.json；随包 woff2/TTF 的 bytes 与 sha256 由生成器现算，并与 packages/ui/src/styles/assets/fonts/fonts.manifest.json 逐文件核对一致。'
        : '缺少上游 sourceSha256，或随包字体文件与 fonts.manifest.json 记录不一致；需重新运行 scripts/build-fonts.py 并复核 legal/fonts.json。'
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

// ---------------------------------------------------------------------------
// 非 npm 随包组件：安装器插件/stub、预编译原生二进制、内嵌 WASM、随包源码归档、
// Electron 运行时平台文件。身份信息在 legal/bundled.json，bytes/sha256 一律现算：
// 没有实物文件就报错，不允许清单里出现"没有哈希的传说"。
// ---------------------------------------------------------------------------
const bundledManifestPath = path.join(legalDir, 'bundled.json');
if (!existsSync(bundledManifestPath)) {
  console.error('[legal] 缺少 legal/bundled.json：非 npm 随包组件清单无法生成。');
  process.exit(1);
}
const bundledManifest = JSON.parse(readFileSync(bundledManifestPath, 'utf8'));
const rootPackageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const installerContainerPath = `apps/desktop/release/Studianda-Setup-${rootPackageVersion}.exe`;
const bundledRecords = [];

function hashArtifact(relativePath, componentName) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`[legal] 组件「${componentName}」的实物文件不存在：${relativePath}`);
  }
  return {
    path: normalize(relativePath),
    bytes: statSync(fullPath).size,
    sha256: sha256(readFileSync(fullPath))
  };
}

function nonNpmArtifacts(component) {
  const artifacts = [];
  for (const spec of component.artifacts ?? []) {
    if (spec && typeof spec === 'object' && spec.container === 'asar') {
      // app.asar 内资源：从本脚本已解包的临时目录取实际随包文件，
      // path 记 asar 内路径，container 记容器文件，避免把临时目录写进清单。
      const entry = String(spec.path).replace(/^\/+/, '');
      const fullPath = path.join(extractRoot, entry);
      if (!existsSync(fullPath)) {
        throw new Error(`[legal] 组件「${component.name}」的 asar 实物不存在：${entry}`);
      }
      artifacts.push({
        path: `/${entry}`,
        container: normalize(path.relative(root, asarPath)),
        bytes: statSync(fullPath).size,
        sha256: sha256(readFileSync(fullPath))
      });
      continue;
    }
    artifacts.push(hashArtifact(typeof spec === 'string' ? spec : spec.path, component.name));
  }
  return artifacts;
}

function nonNpmLicenseFiles(component) {
  const files = [];
  for (const relative of component.licenseFiles ?? []) {
    const fullPath = path.join(legalDir, relative);
    if (!existsSync(fullPath)) {
      throw new Error(`[legal] 组件「${component.name}」的许可证原文不存在：legal/${relative}`);
    }
    files.push({ path: normalize(relative), sha256: sha256(readFileSync(fullPath)) });
  }
  return files;
}

function buildNonNpmRecord(component) {
  if (!component.name || !component.version || !component.license) {
    throw new Error('[legal] legal/bundled.json 的组件缺少 name/version/license');
  }
  const source = { ...(component.source ?? {}) };
  if (Array.isArray(component.observed)) source.observed = component.observed;
  if (source.sha256From) {
    source.sha256 = sha256(readFileSync(path.join(root, source.sha256From)));
    delete source.sha256From;
  }
  if (typeof source.verified !== 'boolean' || !source.url) {
    throw new Error(
      `[legal] 组件「${component.name}」的 source 必须包含 url 与布尔值 verified（未核对时写明 reason）`
    );
  }
  if (!source.verified && !String(source.reason ?? '').trim()) {
    throw new Error(`[legal] 组件「${component.name}」标了 source.verified=false，但没有写明原因`);
  }
  const licenseFiles = nonNpmLicenseFiles(component);
  const artifacts = nonNpmArtifacts(component);
  if (licenseFiles.length === 0 || artifacts.length === 0) {
    throw new Error(
      `[legal] 组件「${component.name}」必须至少登记一份许可证原文与一个可核对的随包实物`
    );
  }
  return {
    name: component.name,
    version: component.version,
    license: component.license,
    ecosystem: 'bundled',
    kind: component.kind ?? 'bundled',
    source,
    licenseFiles,
    artifacts
  };
}

const nonNpmRuntimeRecords = [];
for (const component of bundledManifest.components ?? []) {
  const record = buildNonNpmRecord(component);
  if (component.class === 'runtime') nonNpmRuntimeRecords.push(record);
  else if (component.class === 'bundled') bundledRecords.push(record);
  else throw new Error(`[legal] legal/bundled.json 的 class 只能是 runtime 或 bundled：${component.name}`);
}
runtimeRecords.push(...nonNpmRuntimeRecords);

// 安装器插件/stub 的实际二进制被编译进安装器本体：只登记一次安装器容器并列出
// 随其分发的组件，避免同一个 236 MB 安装包在每个插件条目里重复出现。
const installerArtifact = existsSync(path.join(root, installerContainerPath))
  ? hashArtifact(installerContainerPath, '安装器容器')
  : null;
if (!installerArtifact) {
  console.warn(
    `[legal] 未找到 ${installerContainerPath}（只构建 --dir 时正常），inventory.installer 记 null。`
  );
}
const installerBundledComponents = (bundledManifest.components ?? [])
  .filter((component) => component.installerContainer)
  .map((component) => component.name);

const generatedAt = '__GENERATED_AT__';
const missing = records.filter((record) => record.licenseFiles.length === 0 && !record.fixture);

// 非 npm 组件（运行时平台文件 + bundled[] + fonts[]）的统一声明文本。三份对外声明与
// inventory.json 共用同一批条目和字段，避免"文本一套、清单另一套"。
const nonNpmEntries = [...nonNpmRuntimeRecords, ...bundledRecords];
const nonNpmAllEntries = [...nonNpmEntries, ...bundledFonts];
const KIND_LABELS = {
  'electron-runtime-binary': 'Electron 运行时',
  'ffmpeg-binary': '运行时（FFmpeg）',
  'installer-stub': '安装器 stub',
  'installer-plugin': '安装器插件',
  'installer-helper': '安装器辅助程序',
  'native-addon-binary': '预编译原生二进制',
  'source-archive': '随包源码归档',
  'wasm-runtime': '内嵌 WASM',
  'font-file': '随包字体'
};
const kindLabel = (record) => KIND_LABELS[record.kind] ?? record.kind ?? '非 npm';
const nonNpmVerification = (record) =>
  record.source?.verified ? '来源哈希已核对' : '来源哈希未核对（原因见 inventory.json 的 source.reason）';
const artifactContainerNote = (artifact) =>
  artifact.container ? `（容器 \`${artifact.container}\`）` : '';
const nonNpmRows = nonNpmEntries
  .map(
    (record) =>
      `| ${record.name} | ${record.version} | ${kindLabel(record)} | ${record.license} | ${nonNpmVerification(record)} |`
  )
  .join('\n');
const nonNpmSourceRows = nonNpmEntries
  .map(
    (record) =>
      `| ${record.name} | ${record.version} | ${kindLabel(record)} | ${
        record.source.url || '—'
      } | ${record.source.sha256 || '—'} | ${record.source.verified ? '已核对' : '未核对'} | ${
        record.artifacts.length
      } |`
  )
  .join('\n');
const nonNpmArtifactBullets = nonNpmAllEntries
  .filter((record) => record.artifacts.length > 0)
  .map((record) => {
    const lines = record.artifacts.map(
      (artifact) =>
        `  - \`${artifact.path}\`${artifactContainerNote(artifact)} — ${artifact.bytes} B — SHA-256 \`${artifact.sha256}\``
    );
    return `- **${record.name}**（${record.version}）\n${lines.join('\n')}`;
  })
  .join('\n');
const installerContainerText = installerArtifact
  ? `安装器容器：\`${installerArtifact.path}\`（${installerArtifact.bytes} B，SHA-256 \`${installerArtifact.sha256}\`）；随其分发的组件：${installerBundledComponents.join('、')}。`
  : '本次未找到当前版本的安装器（只构建 --dir 时正常），安装器容器实物未登记。';
const nonNpmSourceReasonLines = nonNpmEntries
  .map(
    (record) =>
      `- ${record.name}：**${record.source.verified ? '已核对' : '未核对'}** —— ${record.source.reason}${
        Array.isArray(record.source.observed) && record.source.observed.length > 0
          ? `；随包二进制观测哈希：${record.source.observed
              .map((item) => `\`${item.file}\`（${item.bytes} B，\`${item.sha256}\`）`)
              .join('、')}`
          : ''
      }`
  )
  .join('\n');

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
    const copyright = String(record.fontCopyright || '见许可证原文').replace(/\s*\n\s*/g, ' ');
    return `- \`${record.fontAlias}\`：字重 ${weights}；${rename}；版权声明：${copyright}；来源 ${record.repository}；覆盖口径见 \`legal/fonts.json\`。`;
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

以下组件内嵌在二进制、WASM 或安装器中，不单独出现在 node_modules 依赖树；本节的许可证原文均在 \`legal/upstream/\` 下随包分发。这些组件已全部纳入机器可读清单：Electron 运行时平台文件（DLL/ICU/Pak/V8 快照）与 FFmpeg 在 \`legal/inventory.json\` 的 \`runtime[]\`，安装器组件、预编译原生二进制、内嵌 WASM 与随包源码归档在 \`bundled[]\`，随包字体在 \`fonts[]\`；每条都带随包实物路径、字节数与 SHA-256，来源哈希无法与官方发布物核对的条目标 \`source.verified: false\` 并写明原因。下表组件名与版本即 \`inventory.json\` 中的 \`name\`/\`version\`。

- @napi-rs/canvas 原生二进制（Node-API native addon，\`bundled[]\` 中 name「@napi-rs/canvas 预编译原生二进制（Skia / ICU / SBOM 142 个组件）」、version 1.0.13）：包含 Skia、ICU、libavif 0.14.0 / libavif-sys 0.17.0、libaom-sys 0.17.2（BSD-2-Clause）、libjpeg-turbo（IJG/BSD/Zlib）、libloading 0.9.0（ISC）、foldhash 0.2.0 / bytemuck 1.25.2（Zlib）、MPL-2.0 组件（cssparser、cssparser-macros、dtoa-short、selectors）等 142 个 SBOM 组件。清单与逐组件许可证类型见 \`upstream/official/napi-canvas/NAPI-CANVAS-THIRD-PARTY.md\` 、\`COMPONENTS.md\` 、\`COMPONENT-LICENSES.md\` 与 \`sbom.cdx.json\`，原文见同目录。四个 MPL-2.0 组件的**未修改上游源码归档**随包提供于 \`upstream/official/napi-canvas/mpl-sources/\`（含 SHA-256 清单，\`bundled[]\` 中 name「MPL-2.0 组件源码归档（cssparser / cssparser-macros / dtoa-short / selectors）」），同时保留官方仓库地址。
- Tesseract.js-core WASM（\`bundled[]\` 中 name「tesseract.js-core WASM（内嵌 Tesseract / Leptonica / libjpeg-turbo / libpng / libtiff / libwebp / giflib / openlibm / zlib）」、version「tesseract.js-core 7.0.0」）：内嵌 Tesseract、Leptonica、giflib、libjpeg-turbo、libpng、libtiff、libwebp、openlibm、zlib；说明见 \`upstream/Tesseract-core-THIRD-PARTY.md\`，原文见 \`upstream/official/tesseract-core/\`。其 Tesseract 来自 \`naptha/tesseract.js-core\` 为 WebAssembly 适配而修改的上游分支（本项目未修改该 WASM），修改清单与源码地址见 \`upstream/official/tesseract-core/README.md\`。
- PDF.js WASM / 资源（\`bundled[]\` 中 name「PDF.js WASM 解码器（JBIG2 / OpenJPEG / QCMS）」、version 6.4.299（pdfjs-dist））：JBIG2、OpenJPEG、QCMS、CMaps、标准字体、ICC；说明见 \`upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md\`。
- tesseract.js 预构建 dist：内嵌 buffer 6.0.3（MIT）、ieee754 1.2.1（BSD-3-Clause）、regenerator-runtime（MIT）、zlib.js（MIT）；buffer/ieee754 原文见 \`upstream/official/tesseract-embedded/\`。
- NSIS 安装器 stub（\`bundled[]\` 中 name「NSIS 安装器 stub」、version 3.0.4.1）：安装器 stub 使用 NSIS 3.0.4.1（zlib/libpng license），许可证原文见 \`upstream/official/nsis-COPYING.txt\`。
- nsis7z.dll（\`bundled[]\` 中 name「nsis7z.dll」、version「19.00（Nsis7z 19.00，基于 7-Zip 19.00）」）：NSIS 的 7z 解压插件（安装时解压 app-64.7z），基于 7-Zip 19.00 源码（Nik Medved / Igor Pavlov）；按 7-Zip License（GNU LGPL-2.1+，含 unRAR 限制）分发。许可原文、来源与完整对应源码见 \`upstream/official/nsis7z/\`；实际随包 DLL 的来源包与 SHA-256 见该目录 \`README.md\`。
- StdUtils.dll（\`bundled[]\` 中 name「StdUtils.dll」、version 1.1.4.0）：NSIS 插件（electron-builder 模板使用），作者 LoRd_MuldeR；按 GNU LGPL-2.1-or-later 分发，许可、澄清说明与完整对应源码见 \`upstream/official/nsis-plugins/stdutils/\`。
- electron-builder / app-builder-lib 26.18.0：构建期使用其 NSIS 模板生成安装器（MIT，Copyright (c) 2015 Loopline Systems）；不随包分发其源码或二进制，但安装器脚本由其模板生成，声明见 \`upstream/official/electron-builder-NOTICE.md\` 与 \`upstream/official/repos/electron-userland_electron-builder-LICENSE.txt\`。
- UAC.dll（\`bundled[]\` 中 name「UAC.dll」、version 0.2.4c）：NSIS 提权插件，作者 Anders；按 ZLIB/LIBPNG License 分发，许可与源码见 \`upstream/official/nsis-plugins/uac/\`；本安装器使用 electron-builder \`nsis-resources-3.4.1\` 的 \`x86-unicode/UAC.dll\`（14,848 字节，SHA-256 \`2F7F8FC05DC4FD0D5CDA501B47E4433357E887BBFED7292C028D99C73B52DC08\`），未修改。
- elevate.exe（\`bundled[]\` 中 name「elevate.exe」、version「未标注（随 NSIS 3.0.4.1 / electron-builder nsis-resources 提供）」）：NSIS 提权辅助程序（MIT，Copyright (c) 2007 Johannes Passing），原文见 \`upstream/official/elevate-MIT.txt\`。
- FFmpeg（\`runtime[]\` 中 name「FFmpeg（Electron 内置 ffmpeg.dll）」）：Electron 内置 \`ffmpeg.dll\`（LGPL-2.1-or-later，Electron 官方构建，未修改）；许可证见 \`upstream/official/ffmpeg-LGPL-2.1.txt\`，**LGPL 2.1 §6(c) 书面源码要约**见 \`upstream/official/ffmpeg-SOURCE-OFFER.md\`（三年有效，接收方无需预先回应），构建说明见 \`legal/COMPATIBILITY.md\`。
- Electron 运行时二进制（\`runtime[]\` 中 name「Electron 运行时二进制（第三方 DLL / ICU / Pak / V8 快照）」、version 44.5.1，\`ffmpeg.dll\`、\`d3dcompiler_47.dll\`、\`dxcompiler.dll\`、\`dxil.dll\`、\`vulkan-1.dll\`、\`vk_swiftshader.dll\`、\`icudtl.dat\` 等）：由 Electron/Chromium 发行物原样提供、本项目未修改；版权与许可声明随 \`electron/LICENSE.txt\` 与 \`electron/LICENSES.chromium.html\` 分发，补充说明见 \`upstream/official/electron-runtime-dlls.md\`。
- pako 的 zlib 兼容层：zlib 许可通知见 \`upstream/official/pako-zlib-README.txt\`（\`NOTICE.html\` 也收录全文）。

> 安装器**不随包分发 WinShell 插件**，但保留其行为：该插件上游只有 "Freeware" 标注、没有许可文本或源码，不构成再分发授权；构建期由 \`scripts/patch-nsis-templates.mjs\` 把调用改写为 \`apps/desktop/build/nsis/aumid.nsh\` 的宏（NSIS 自带 System 插件 + Windows 公开 API），快捷方式 AUMID 仍照常写入/清除。证据见 \`upstream/official/nsis-plugins/winshell/README.md\`。

## 强制署名与特别声明

- **libjpeg-turbo（IJG）**：随包分发的 Tesseract WASM 与 \`skia.node\` 只含 libjpeg-turbo 二进制、不含其源码，按 IJG 许可需在产品文档中写明：\`This software is based in part on the work of the Independent JPEG Group.\`
- **MPL-2.0**：cssparser、cssparser-macros、dtoa-short、selectors 四个组件按 MPL-2.0 §3.2(a) 随包提供未修改源码归档（见上文 \`mpl-sources/\`），并同时给出官方仓库地址。
- **随包字体**：9 个 woff2 与 1 个水印专用子集 TTF（\`StudiandaWatermark.ttf\`，源自 Noto Sans CJK SC，经 \`extraResources\` 放在 \`resources/assets/fonts/\`）按各自自身许可分发，不属于本项目许可范围；逐款许可、版权行、保留名与改名说明见 \`legal/fonts.json\`、\`legal/font-licenses/README.md\` 与本文件「随包字体」一节。
`;

const markdown = `# 第三方组件与许可证声明

生成时间：${generatedAt}

本清单从**实际安装包** \`resources/app.asar\` 的依赖树生成，覆盖渲染器、Core 和生产依赖；不是仅根据源码清单推测。

本项目的 Apache License 2.0 许可证仅适用于本项目原创代码；随包分发的第三方组件仍分别适用其自身许可证，本项目许可证不改变、不限制这些组件在其许可证下的权利。随包字体、PDF.js 包内的第三方资源（CMaps、标准字体、ICC、WASM 解码器）与 Electron 运行时文件（含 Chromium、FFmpeg、ICU 等）均分别按各自自身许可分发，均不属于本项目许可范围；逐项许可见 \`legal/THIRD-PARTY.md\`、\`legal/upstream/official/pdfjs-wasm/\` 与 \`legal/upstream/official/electron-runtime-dlls.md\`；随包字体的逐款许可、版权与保留名见 \`legal/fonts.json\` 与 \`legal/font-licenses/\`。

## Electron 与 Chromium

- Electron：${electronVersion}，MIT License；
- Chromium：Electron 内置，第三方许可证全文见 \`electron/LICENSES.chromium.html\`；
- Electron 自身许可证：\`electron/LICENSE.txt\`；
- Node.js：${process.versions.node}，MIT License，许可证见 \`runtime/Node-LICENSE.txt\`。

## 随安装包分发的运行时依赖

| 组件 | 版本 | 许可证 | 许可证文件 |
|---|---|---|---|
${rows}

## 非 npm 随包组件（机器可读清单）

以下组件不经过 npm 依赖树进入安装包，却实际随包分发：安装器 stub 与插件、Electron 运行时平台文件、FFmpeg、预编译原生二进制、内嵌 WASM、随包源码归档。逐条记录（含随包实物路径、字节数、SHA-256）在 \`legal/inventory.json\`：平台运行时条目在 \`runtime[]\`，其余在 \`bundled[]\`（本表来自同一批条目，组件名与版本即清单中的 \`name\`/\`version\`）。\`source.verified\` 为 \`false\` 的表示上游未发布可对照的官方哈希或二进制只在安装器/工具缓存中，原因写在该条目的 \`source.reason\`。

| 组件 | 版本 | 类别 | 许可证 | 来源核对 |
|---|---|---|---|---|
${nonNpmRows}

${installerContainerText}

## 随包字体

字体文件由 \`scripts/build-fonts.py\` 从官方发行物生成（冻结静态字重 + 子集化 + woff2），不属于 npm 依赖树，故单独列出。另有 1 个水印专用子集 TTF（\`packages/core/assets/fonts/StudiandaWatermark.ttf\`，源自 Noto Sans CJK SC，经 \`extraResources\` 放在 \`resources/assets/fonts/\`），其版权与许可见下表的 Noto Sans CJK SC 一行。逐文件的字节数与 SHA-256 见 \`legal/inventory.json\` 的 \`fonts[].artifacts\`，并与 \`packages/ui/src/styles/assets/fonts/fonts.manifest.json\` 交叉核对。

| 字体 | 版本 | 部署别名 | 许可证 | 许可证文件 |
|---|---|---|---|---|
${fontRows}

${fontNotes}

${embeddedNotes}

## 运行时下载、不随包分发的资源

- Tesseract 语言训练数据（eng、chi_sim、chi_tra、jpn、kor、deu、fra、rus 等）：不包含在 npm 包中，也不随本安装包分发；用户在本机 OCR 设置里选择语言并点「下载所选语言包」后，才由主进程从 Tesseract 官方 tessdata_fast 发行物按需下载（Apache-2.0，官方仓库 https://github.com/tesseract-ocr/tessdata_fast ）；下载先走官方 raw（https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/<语言代码>.traineddata），该域名不可达时回退 GitHub 官方 Contents API（https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents/<语言代码>.traineddata?ref=main，Accept: application/vnd.github.raw），两者都是 HTTPS、同一仓库同一文件，不用第三方镜像；官方许可证原文见 legal/upstream/Tesseract-tessdata-APACHE-2.0.txt，来源与哈希见 legal/upstream/official/tessdata_fast-SOURCES.json；缓存在用户数据目录 ocr-tessdata/langs/，删除数据目录即移除；这是用户主动触发的数据下载（只取模型文件，不上传文献或问题），首次下载会向 GitHub 下载域名暴露 IP/时间；
- electron-builder / app-builder-lib 26.18.0（MIT）：仅构建期使用，安装器 NSIS 脚本由其模板生成；不随包分发其源码或构建二进制。声明见 legal/upstream/official/electron-builder-NOTICE.md 与 legal/upstream/official/repos/electron-userland_electron-builder-LICENSE.txt；
- Tesseract.js-core 的 WASM 内嵌 Tesseract、Leptonica、giflib、libjpeg、libpng、libtiff、libwebp、openlibm、zlib；官方许可证已补入 legal/upstream/official/tesseract-core/，说明见 legal/upstream/Tesseract-core-THIRD-PARTY.md；其 Tesseract 为 naptha/tesseract.js-core 为 WebAssembly 适配而修改的上游分支（本项目未修改该 WASM），修改清单见 legal/upstream/official/tesseract-core/README.md；
- @napi-rs/canvas 原生二进制（Node-API native addon）包含 Skia、ICU 和 Rust 组件；SBOM 与 Skia/ICU/MPL/各 Rust 组件许可证已补入 legal/upstream/official/napi-canvas/，SBOM 142 个组件的许可证类型已全部映射（0 个未覆盖）；具体版权行见该目录下对应组件原文；其中 MPL-2.0 组件（cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0）的源码可从 https://github.com/servo/rust-cssparser 、https://github.com/upsuper/dtoa-short 、https://github.com/servo/stylo 获取，许可证原文见 legal/upstream/official/napi-canvas/MPL-2.0.txt；
- PDF.js 的 WASM 解码组件（JBIG2、OpenJPEG、QCMS）以及 CMaps、标准字体、ICC 随应用分发；它们属于 pdfjs-dist 包内资源，不是新增 npm 依赖，许可证和版权声明见 legal/upstream/official/pdfjs-wasm/；

## 清单范围

本清单的 npm 依赖表只列安装包 \`node_modules\` 中实际存在的包；字体、内嵌原生二进制/WASM 组件、安装器组件与运行时下载资源分别见上文各节。非 npm 随包组件的机器可读记录在 \`legal/inventory.json\`：\`runtime[]\`（Electron 运行时平台文件、FFmpeg）、\`bundled[]\`（安装器 stub/插件、预编译原生二进制、内嵌 WASM、随包源码归档）与 \`fonts[]\`（逐字体文件），每条都带 \`artifacts[].bytes\` 与 \`artifacts[].sha256\`。

## 说明

- 许可证文件来自安装包内的实际文件；缺失项用 \`legal/upstream/\` 中的上游原文补充，并在 \`inventory.json\` 标记来源；
- \`legal/SOURCES.md\` 记录每个组件的官方仓库地址、许可证文件哈希与非 npm 组件的随包实物哈希；
- 非 npm 组件的 \`bytes\`/\`sha256\` 由 \`scripts/audit-packaged-legal.mjs\` 从仓库工作区内的实际文件现算，不手写、不编造；\`source.verified: false\` 的条目在 \`source.reason\` 写明无法核对的原因；
- 官方仓库许可证原文证据保存在 \`legal/upstream/official/repos/\`；
- 本文件是工程记录，不构成法律意见；商业发布前应做人工法律复核。

## 再分发

安装包内保留 \`legal/\` 目录。再分发时请保留该目录及其中的许可证原文（Apache-2.0 要求保留 LICENSE/NOTICE，各第三方许可证也要求保留其声明）。
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
- nsis7z.dll（基于 7-Zip 19.00，7-Zip License / LGPL-2.1+，含 unRAR 限制）：许可、来源、随包源码与实际 DLL 的 SHA-256 见 \`upstream/official/nsis7z/\`
- StdUtils.dll（LoRd_MuldeR，GNU LGPL-2.1+，版本 1.1.4.0，DLL SHA-256 B72E9013A6204E9F01076DC38DABBF30870D44DFC66962ADBF73619D4331601E）：许可、澄清与源码见 \`upstream/official/nsis-plugins/stdutils/\`
- UAC.dll（Anders，0.2.4c，ZLIB/LIBPNG）：许可与源码见 \`upstream/official/nsis-plugins/uac/\`；本安装器使用 \`nsis-resources-3.4.1\` 的 x86-unicode DLL（14,848 B，SHA-256 \`2F7F8FC05DC4FD0D5CDA501B47E4433357E887BBFED7292C028D99C73B52DC08\`）
- elevate.exe（MIT）：\`upstream/official/elevate-MIT.txt\`
- FFmpeg（Electron 内置 ffmpeg.dll，LGPL-2.1-or-later）：\`upstream/official/ffmpeg-LGPL-2.1.txt\`；**LGPL 2.1 §6(c) 书面源码要约**见 \`upstream/official/ffmpeg-SOURCE-OFFER.md\`（三年有效，接收方无需预先回应）
- electron-builder / app-builder-lib 26.18.0（MIT，构建期 NSIS 模板）：\`upstream/official/electron-builder-NOTICE.md\`、\`upstream/official/repos/electron-userland_electron-builder-LICENSE.txt\`
- WinShell.dll：**已由脚本实现替代**，不再随包分发 DLL（AUMID 行为保留）；依据与证据见 \`upstream/official/nsis-plugins/winshell/README.md\`

## 非 npm 随包组件（inventory.json）

下表与 \`legal/inventory.json\` 的 \`runtime[]\`/\`bundled[]\` 由同一次生成产出，组件名、版本、来源哈希与核对状态一一对应；\`source.verified=false\` 的原因见下方说明与清单条目。

| 组件 | 版本 | 类别 | 官方来源 | 来源 SHA-256 | 核对 | 实物数 |
|---|---|---|---|---|---|---|
${nonNpmSourceRows}

**来源哈希核对说明**

${nonNpmSourceReasonLines}

### 随包实物逐文件哈希

以下哈希由生成器从仓库工作区内的实际文件现算（asar 内资源从真实 \`app.asar\` 解出后计算）：

${installerContainerText}

${nonNpmArtifactBullets}

## 运行时下载 / 特殊组件

- Tesseract tessdata_fast（Apache-2.0，运行时按需下载）：\`upstream/official/tessdata_fast-SOURCES.json\`、\`upstream/Tesseract-tessdata-APACHE-2.0.txt\`
- pako zlib 兼容层：\`upstream/official/pako-zlib-README.txt\`
- Tesseract.js-core 修改版 Tesseract fork：\`upstream/official/tesseract-core/README.md\`

## 内嵌组件的固定版本源码

- MPL-2.0 组件源码归档（cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0）：\`upstream/official/napi-canvas/mpl-sources/\`，逐文件 SHA-256 见该目录 \`README.md\`
- Electron 运行时二进制说明（ffmpeg/d3dcompiler/dxcompiler/dxil/vulkan/swiftshader/icu）：\`upstream/official/electron-runtime-dlls.md\`

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
for (const extra of [
  {
    name: 'pako',
    version: '1.0.11 · zlib notice',
    file: 'upstream/official/pako-zlib-README.txt'
  },
  {
    name: 'Tesseract tessdata_fast',
    version: 'Apache-2.0（运行时下载）',
    file: 'upstream/Tesseract-tessdata-APACHE-2.0.txt'
  },
  {
    name: 'electron-builder',
    version: '26.18.0 · MIT',
    file: 'upstream/official/repos/electron-userland_electron-builder-LICENSE.txt'
  }
]) {
  const fullPath = path.join(legalDir, extra.file);
  let content = '';
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    content = '（无法读取）';
  }
  licenseBlocks.push(
    `<h3>${htmlEscape(extra.name)} · ${htmlEscape(extra.version)} · ${htmlEscape(
      path.basename(extra.file)
    )}</h3><pre>${htmlEscape(content.replace(/[ \t]+$/gm, ''))}</pre>`
  );
}

// 非 npm 组件引用的许可证原文也收进 HTML 全文（与上表逐条对应）；超大文件
// （如 Chromium 的 LICENSES.chromium.html）只保留链接，避免把声明文件撑到几十 MB。
const emittedLicensePaths = new Set(
  records.flatMap((record) => record.licenseFiles.map((file) => file.path))
);
for (const record of [...runtimeRecords, ...bundledRecords]) {
  for (const file of record.licenseFiles ?? []) {
    if (emittedLicensePaths.has(file.path)) continue;
    const fullPath = path.join(legalDir, file.path);
    if (!existsSync(fullPath) || statSync(fullPath).size > 200 * 1024) continue;
    emittedLicensePaths.add(file.path);
    const content = readFileSync(fullPath, 'utf8');
    licenseBlocks.push(
      `<h3>${htmlEscape(record.name)} · ${htmlEscape(path.basename(file.path))}</h3><pre>${htmlEscape(
        content.replace(/[ \t]+$/gm, '')
      )}</pre>`
    );
  }
}

const htmlArtifactCell = (artifact) => {
  const label = artifact.container
    ? `<code>${htmlEscape(artifact.path)}</code>（容器 ${htmlEscape(artifact.container)}）`
    : String(artifact.path).startsWith('legal/')
      ? `<a href="${htmlEscape(String(artifact.path).slice('legal/'.length))}">${htmlEscape(
          artifact.path
        )}</a>`
      : `<code>${htmlEscape(artifact.path)}</code>`;
  return `${label} · ${artifact.bytes} B · SHA-256 <code>${htmlEscape(artifact.sha256)}</code>`;
};
const nonNpmHtmlRows = nonNpmEntries
  .map((record) => {
    const artifacts = record.artifacts
      .map((artifact) => htmlArtifactCell(artifact))
      .join('<br>');
    const licenseFiles = record.licenseFiles
      .map((file) => `<a href="${htmlEscape(file.path)}">${htmlEscape(path.basename(file.path))}</a>`)
      .join('<br>');
    const source = record.source.url
      ? `<a href="${htmlEscape(record.source.url)}">${htmlEscape(record.source.url)}</a>`
      : '—';
    return `<tr><td>${htmlEscape(record.name)}</td><td>${htmlEscape(record.version)}</td><td>${htmlEscape(
      kindLabel(record)
    )}</td><td>${htmlEscape(record.license)}</td><td>${source}</td><td>${
      record.source.verified ? '已核对' : '未核对'
    }</td><td>${artifacts}</td><td>${licenseFiles}</td></tr>`;
  })
  .join('\n');
const nonNpmReasonList = nonNpmEntries
  .map(
    (record) =>
      `<li>${htmlEscape(record.name)}：<strong>${
        record.source.verified ? '已核对' : '未核对'
      }</strong> —— ${htmlEscape(record.source.reason)}</li>`
  )
  .join('\n');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>勘读 Studianda 第三方声明</title>
<style>body{max-width:1000px;margin:40px auto;padding:0 20px;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#2c2a24;background:#f4eedf}h1,h2,h3{font-family:Georgia,serif}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #d8cdb8;padding:5px 7px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#fbf7ed;border:1px solid #e3d9c5;padding:10px;font-size:11px;max-height:420px;overflow:auto}a{color:#4f765e}</style></head><body>
<h1>勘读 Studianda 第三方组件与许可证声明</h1><p>生成时间：${htmlEscape(generatedAt)}</p>
<p>本项目的 Apache License 2.0 许可证仅适用于本项目原创代码；随包分发的第三方组件仍分别适用其自身许可证，本项目许可证不改变、不限制这些组件在其许可证下的权利。随包字体、PDF.js 包内的第三方资源（CMaps、标准字体、ICC、WASM 解码器）与 Electron 运行时文件（含 Chromium、FFmpeg、ICU 等）均分别按各自自身许可分发，均不属于本项目许可范围；逐项许可见 <a href="upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md">PDF.js 资源声明</a>、<a href="upstream/official/electron-runtime-dlls.md">Electron 运行时说明</a> 与本文件下方清单；随包字体的逐款许可、版权与保留名见 <a href="fonts.json">fonts.json</a> 与 <a href="font-licenses/README.md">font-licenses/README.md</a>。</p>
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
  ? `<h2>随包字体</h2><p>字体由官方发行物子集化并转为 woff2（另有 1 个水印专用子集 TTF，经 extraResources 放在 resources/assets/fonts/），随安装包分发；按各自自身许可分发（见 fonts.json 的 license 字段），不属于本项目许可范围。版权行、保留名与改名说明见 <a href="fonts.json">fonts.json</a> 与 <a href="font-licenses/README.md">font-licenses/README.md</a>；许可证原文见下方。</p>
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
<h2>非 npm 随包组件（机器可读清单）</h2>
<p>以下组件不经过 npm 依赖树进入安装包，却实际随包分发；逐条记录（含随包实物路径、字节数与 SHA-256）在 <a href="inventory.json">inventory.json</a> 的 <code>runtime[]</code>（Electron 运行时平台文件、FFmpeg）与 <code>bundled[]</code>（安装器 stub/插件、预编译原生二进制、内嵌 WASM、随包源码归档）；随包字体在 <code>fonts[]</code>。组件名与版本以该清单为准。来源哈希无法与官方发布物核对的条目在 <code>source.verified</code> 标 <code>false</code> 并写明原因（见下方说明）。</p>
<p>${installerArtifact ? `安装器容器：<code>${htmlEscape(installerArtifact.path)}</code>（${installerArtifact.bytes} B，SHA-256 <code>${htmlEscape(installerArtifact.sha256)}</code>）；随其分发的组件：${htmlEscape(installerBundledComponents.join('、'))}。` : '本次未找到当前版本的安装器（只构建 --dir 时正常），安装器容器实物未登记。'}</p>
<table><thead><tr><th>组件</th><th>版本</th><th>类别</th><th>许可证</th><th>官方来源</th><th>来源核对</th><th>随包实物（路径 · 字节 · SHA-256）</th><th>许可证文件</th></tr></thead><tbody>
${nonNpmHtmlRows}
</tbody></table>
${nonNpmReasonList ? `<h3>来源哈希核对说明</h3><ul>\n${nonNpmReasonList}\n</ul>` : ''}
<h2>内嵌原生二进制（native binary）/ WASM / 安装器组件</h2>
<p>以下组件内嵌在二进制、WASM 或安装器中，不单独出现在 node_modules 表；原文见 <a href="upstream/">legal/upstream/</a>。</p>
<ul>
<li><a href="upstream/official/napi-canvas/NAPI-CANVAS-THIRD-PARTY.md">@napi-rs/canvas 原生二进制（Node-API native addon）</a>（Skia、ICU、libavif/libaom、libjpeg-turbo、MPL-2.0 等 142 个组件；<a href="upstream/official/napi-canvas/sbom.cdx.json">SBOM</a> / <a href="upstream/official/napi-canvas/COMPONENTS.md">组件清单</a> / <a href="upstream/official/napi-canvas/COMPONENT-LICENSES.md">许可证全文</a> / <a href="upstream/official/napi-canvas/COMPONENT-COMPLIANCE.md">合规矩阵</a> / <a href="upstream/official/napi-canvas/COMPONENT-LICENSES.md">许可证全文</a>）</li>
<li><a href="upstream/Tesseract-core-THIRD-PARTY.md">Tesseract.js-core WASM</a>（Tesseract、Leptonica、libjpeg-turbo、libpng、libtiff、libwebp、giflib、openlibm、zlib；Tesseract 来自上游为 WebAssembly 适配而修改的分支，本项目未修改该 WASM，<a href="upstream/official/tesseract-core/README.md">修改说明</a>）</li>
<li><a href="upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md">PDF.js WASM/资源</a>（JBIG2、OpenJPEG、QCMS、CMaps、标准字体、ICC）</li>
<li><a href="upstream/official/tesseract-embedded/SOURCES.json">tesseract.js 预构建 dist</a>（buffer、ieee754、regenerator-runtime、zlib.js）</li>
<li><a href="upstream/official/nsis-COPYING.txt">NSIS 安装器 stub</a>（zlib/libpng license）</li>
<li><a href="upstream/official/nsis7z/README.md">nsis7z.dll</a>（NSIS 7z 解压插件，基于 7-Zip 19.00；7-Zip License / LGPL-2.1+，含 unRAR 限制；<a href="upstream/official/nsis7z/README.md">许可、来源与随包源码</a>）</li>
<li><a href="upstream/official/nsis-plugins/stdutils/README.md">StdUtils.dll</a>（NSIS 插件，LoRd_MuldeR；GNU LGPL-2.1+；版本 1.1.4.0，DLL SHA-256 B72E9013A6204E9F01076DC38DABBF30870D44DFC66962ADBF73619D4331601E；<a href="upstream/official/nsis-plugins/stdutils/">许可、澄清与随包源码</a>）</li>
<li><a href="upstream/official/nsis-plugins/uac/README.md">UAC.dll</a>（NSIS 提权插件，Anders；ZLIB/LIBPNG；<a href="upstream/official/nsis-plugins/uac/">许可与源码</a>）</li>
<li><a href="upstream/official/electron-builder-NOTICE.md">electron-builder / app-builder-lib</a>（MIT，构建期 NSIS 模板；<a href="upstream/official/repos/electron-userland_electron-builder-LICENSE.txt">LICENSE</a>；安装器脚本由模板生成）</li>
<li><a href="upstream/official/nsis-plugins/winshell/README.md">WinShell.dll：已由脚本实现替代</a>（上游无许可文本，不随包分发；快捷方式 AUMID 仍由安装脚本写入）</li>
<li><a href="upstream/official/elevate-MIT.txt">elevate.exe</a>（MIT，Copyright (c) 2007 Johannes Passing）</li>
<li><a href="upstream/official/napi-canvas/mpl-sources/README.md">MPL-2.0 源码归档</a>（cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0，随包提供）</li>
<li><a href="upstream/official/electron-runtime-dlls.md">Electron 运行时二进制</a>（ffmpeg/d3dcompiler/dxcompiler/dxil/vulkan/swiftshader/icu，来源与声明依据）</li>
<li><a href="upstream/official/ffmpeg-LGPL-2.1.txt">FFmpeg（Electron 内置 ffmpeg.dll，LGPL-2.1-or-later）</a>；<a href="upstream/official/ffmpeg-SOURCE-OFFER.md">对应源码书面要约</a>；源代码与书面说明见 <a href="COMPATIBILITY.md">legal/COMPATIBILITY.md</a></li>
<li><a href="upstream/official/pako-zlib-README.txt">pako 的 zlib 兼容层</a>（MIT 根许可之外的 Zlib 通知全文）</li>
</ul>
<h2>运行时下载 / 构建期组件</h2>
<ul>
<li><a href="upstream/official/tessdata_fast-SOURCES.json">Tesseract tessdata_fast 语言包</a>（Apache-2.0；不随包分发，用户点击下载时从官方仓库获取；<a href="upstream/Tesseract-tessdata-APACHE-2.0.txt">许可全文</a>）</li>
<li><a href="upstream/official/electron-builder-NOTICE.md">electron-builder / app-builder-lib</a>（MIT，构建期；<a href="upstream/official/repos/electron-userland_electron-builder-LICENSE.txt">LICENSE</a>）</li>
<li><a href="upstream/official/ffmpeg-SOURCE-OFFER.md">FFmpeg 对应源码书面要约</a>（LGPL 2.1 §6(c)；三年有效，接收方无需预先回应）</li>
<li><a href="upstream/official/tesseract-core/README.md">Tesseract.js-core 修改版 Tesseract fork 说明</a>（Apache-2.0）</li>
</ul>
<h2>pako 的 Zlib 声明（完整原文）</h2><pre>pako 根 LICENSE 为 MIT；其 lib/zlib 部分还适用 Zlib 许可。完整通知见 <a href="upstream/official/pako-zlib-README.txt">upstream/official/pako-zlib-README.txt</a>。</pre>

<p><strong>强制署名：</strong>libjpeg-turbo（IJG）— This software is based in part on the work of the Independent JPEG Group.</p>
<h2>许可证原文</h2>${licenseBlocks.join('\n')}
</body></html>`;
const nonNpmAllArtifacts = nonNpmAllEntries.flatMap((record) => record.artifacts);
const nonNpmSummary = {
  entries: nonNpmAllEntries.length,
  runtime: nonNpmRuntimeRecords.length,
  bundled: bundledRecords.length,
  fonts: bundledFonts.length,
  artifacts: nonNpmAllArtifacts.length,
  artifactBytes: nonNpmAllArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
  sourceVerified: nonNpmAllEntries.filter((record) => record.source?.verified).length,
  sourceUnverified: nonNpmAllEntries.filter((record) => !record.source?.verified).length
};
const inventory = {
  generatedAt,
  electron: electronVersion,
  node: process.versions.node,
  asar: path.basename(asarPath),
  installer: installerArtifact
    ? {
        version: rootPackageVersion,
        path: installerArtifact.path,
        bytes: installerArtifact.bytes,
        sha256: installerArtifact.sha256,
        components: installerBundledComponents
      }
    : null,
  runtime: runtimeRecords,
  fonts: bundledFonts,
  bundled: bundledRecords,
  nonNpm: nonNpmSummary,
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
console.log(
  `nonNpmEntries=${nonNpmSummary.entries}（runtime ${nonNpmSummary.runtime}、bundled ${nonNpmSummary.bundled}、fonts ${nonNpmSummary.fonts}）` +
    ` artifacts=${nonNpmSummary.artifacts} bytes=${nonNpmSummary.artifactBytes}` +
    ` sourceVerified=${nonNpmSummary.sourceVerified} sourceUnverified=${nonNpmSummary.sourceUnverified}`
);
console.log(`output=${legalDir}`);
rmSync(extractRoot, { recursive: true, force: true });
