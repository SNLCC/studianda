/**
 * 从 esbuild metafile 生成 agent-bridge bundle 的第三方许可证清单。
 *
 * bundle 把 MCP SDK / zod 等包内嵌进单个 agent-bridge.mjs，它们不再出现在安装包的
 * node_modules 依赖树里，因此不能靠 asar 扫描发现。这里以 metafile 的实际输入为准，
 * 只登记真正被 bundle 的包，输出到 legal/upstream/agent-bridge/。
 *
 * 用法：node scripts/sync-agent-bridge-legal.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const metaFile = path.join(root, 'packages', 'agent-bridge', 'dist', 'agent-bridge.mjs.meta.json');
const outputDir = path.join(root, 'legal', 'upstream', 'agent-bridge');
const licenseDir = path.join(outputDir, 'licenses');

if (!existsSync(metaFile)) {
  console.error(`缺少 ${metaFile}；先运行 pnpm --filter @studianda/agent-bridge build`);
  process.exit(1);
}

const metafile = JSON.parse(readFileSync(metaFile, 'utf8'));
const packageRoots = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = input.match(/^(node_modules\/\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packageRoots.add(match[1]);
}

const packages = [];
for (const relative of [...packageRoots].sort()) {
  const dir = path.join(root, relative);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const name = String(manifest.name ?? '');
  if (!name || name.startsWith('@studianda/')) continue;
  const version = String(manifest.version ?? '');
  const files = readdirSync(dir).filter((file) =>
    /^(LICEN[CS]E|COPYING|NOTICE)([-_.].*)?$/i.test(file)
  );
  const licenseFile = files[0] ?? null;
  const licenseText = licenseFile ? readFileSync(path.join(dir, licenseFile), 'utf8').trim() : null;
  const safe = name.replace(/^@/, '').replace(/[\\/]/g, '_').replace(/[^\w.-]/g, '_');
  packages.push({
    name,
    version,
    license: String(manifest.license ?? '未标注'),
    repository:
      typeof manifest.repository === 'string'
        ? manifest.repository
        : (manifest.repository?.url ?? ''),
    licenseFile,
    licenseText,
    safe
  });
}

if (packages.length === 0) {
  console.error('[agent-bridge-legal] metafile 里没有找到第三方包');
  process.exit(1);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(licenseDir, { recursive: true });
for (const pkg of packages) {
  if (!pkg.licenseText) {
    pkg.copied = null;
    continue;
  }
  const target = path.join(licenseDir, `${pkg.safe}@${pkg.version}-${pkg.licenseFile}`);
  writeFileSync(target, `${pkg.licenseText}\n`, 'utf8');
  pkg.copied = path.relative(path.join(root, 'legal'), target).split(path.sep).join('/');
}
const lines = [
  '# Agent MCP bridge 内嵌第三方组件',
  '',
  '`resources/agent-bridge.mjs` 是由本仓库用 esbuild 打出的单文件 bundle。以下 npm 包被实际',
  'bundle 进该文件（依据 `packages/agent-bridge/dist/agent-bridge.mjs.meta.json` 的输入清单），',
  '不再出现在安装包的 `node_modules` 依赖树中，因此单独在此登记。',
  '',
  '| 包 | 版本 | 许可证 | 仓库 |',
  '|---|---|---|---|',
  ...packages.map(
    (pkg) => `| \`${pkg.name}\` | ${pkg.version} | ${pkg.license} | ${pkg.repository || '—'} |`
  ),
  '',
  '各许可证原文按包保存在 `licenses/` 下。',
  ''
];
for (const pkg of packages) {
  lines.push(`## ${pkg.name}@${pkg.version}`, '', `- 许可证：${pkg.license}`);
  if (pkg.repository) lines.push(`- 仓库：${pkg.repository}`);
  if (pkg.licenseText) lines.push('', '```text', pkg.licenseText, '```');
  else lines.push('', '（该包未随附独立 LICENSE 文件；许可证声明见 package.json。）');
  lines.push('');
}
writeFileSync(path.join(outputDir, 'THIRD-PARTY.md'), lines.join('\n'), 'utf8');
writeFileSync(
  path.join(outputDir, 'deps.json'),
  `${JSON.stringify({ generatedFrom: 'packages/agent-bridge/dist/agent-bridge.mjs.meta.json', packages }, null, 2)}\n`,
  'utf8'
);
console.log(
  `[agent-bridge-legal] ${packages.length} 个包 -> ${path.relative(root, outputDir)}`
);
