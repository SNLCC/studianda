/**
 * Agent bridge bundle 的第三方依赖声明完整性检查。
 *
 * `resources/agent-bridge.mjs` 把 MCP SDK / zod 等包打进单文件，这些包不出现在
 * app.asar 的 node_modules 里，因此普通 asar 依赖审计看不到它们。本脚本以 esbuild
 * metafile 的实际输入为准，核对 legal/upstream/agent-bridge/deps.json、licenses/ 与
 * NOTICE.html，防止以后新增依赖却漏掉许可证声明。
 *
 * 用法：node scripts/audit-bridge-bundle-legal.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const metaFile = path.join(root, 'packages/agent-bridge/dist/agent-bridge.mjs.meta.json');
const legalDir = path.join(root, 'legal/upstream/agent-bridge');
const depsFile = path.join(legalDir, 'deps.json');
const sourcesFile = path.join(legalDir, 'SOURCES.json');
const noticeFile = path.join(root, 'legal/NOTICE.html');

const fail = (message) => {
  console.error(`[bridge-legal] 失败：${message}`);
  process.exitCode = 1;
};

for (const file of [metaFile, depsFile, noticeFile]) {
  if (!existsSync(file)) {
    fail(`缺少文件 ${path.relative(root, file)}；先运行 pnpm --filter @studianda/agent-bridge build 和 sync-agent-bridge-legal.mjs。`);
    process.exit();
  }
}
if (!existsSync(sourcesFile)) {
  fail(
    '缺少 legal/upstream/agent-bridge/SOURCES.json（官方仓库来源记录）；' +
      '先运行 node scripts/audit-agent-bridge-upstream.mjs，再运行 sync-agent-bridge-legal.mjs。'
  );
}

const metafile = JSON.parse(readFileSync(metaFile, 'utf8'));
const deps = JSON.parse(readFileSync(depsFile, 'utf8'));
const sources = existsSync(sourcesFile)
  ? JSON.parse(readFileSync(sourcesFile, 'utf8'))
  : { entries: [] };
const sourceByKey = new Map(
  (sources.entries ?? []).map((entry) => [`${entry.package}@${entry.version}`, entry])
);
const sha256Of = (text) =>
  createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n').trim()).digest('hex');
const notice = readFileSync(noticeFile, 'utf8');

const bundled = new Set();
for (const input of Object.keys(metafile.inputs ?? {})) {
  const normalized = input.replace(/\\/g, '/');
  const match = normalized.match(
    /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//
  );
  if (!match) continue;
  const pnpmDir = match[1];
  const name = match[2];
  const encoded = name.startsWith('@')
    ? `@${name.slice(1).replace(/\//g, '+')}`
    : name;
  const escaped = encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionMatch = pnpmDir.match(new RegExp(`^${escaped}@([^_]+)`));
  const version = versionMatch?.[1];
  if (!version) continue;
  bundled.add(`${name}@${version}`);
}

const declared = new Set((deps.packages ?? []).map((pkg) => `${pkg.name}@${pkg.version}`));
const missing = [...bundled].filter((id) => !declared.has(id));
const extra = [...declared].filter((id) => !bundled.has(id));
if (missing.length > 0) fail(`bundle 里有未声明包：${missing.join(', ')}`);
if (extra.length > 0) fail(`声明了未 bundle 的包：${extra.join(', ')}`);

for (const pkg of deps.packages ?? []) {
  if (typeof pkg.license !== 'string' || !pkg.license.trim()) {
    fail(`${pkg.name}@${pkg.version} 缺少 license 字段`);
  }
  if (!pkg.licenseText || !pkg.copied) {
    fail(`${pkg.name}@${pkg.version} 缺少许可证原文或 copied 路径`);
    continue;
  }
  const copiedFile = path.join(root, 'legal', pkg.copied);
  if (!existsSync(copiedFile)) {
    fail(`${pkg.name}@${pkg.version} 的许可证文件不存在：${pkg.copied}`);
    continue;
  }
  const copied = readFileSync(copiedFile, 'utf8').replace(/\r\n/g, '\n').trim();
  const expected = pkg.licenseText.replace(/\r\n/g, '\n').trim();
  if (copied !== expected) {
    fail(`${pkg.name}@${pkg.version} 的许可证文件内容与 deps.json 不一致`);
  }
  if (!notice.includes(pkg.name)) {
    fail(`${pkg.name}@${pkg.version} 未出现在 legal/NOTICE.html`);
  }
  // 许可证必须来自官方仓库（或明确记录的例外），并记录可核对的 URL / ref / 哈希。
  const id = `${pkg.name}@${pkg.version}`;
  const source = sourceByKey.get(id);
  if (!source) {
    fail(`${id} 缺少官方仓库来源记录（SOURCES.json）`);
  } else {
    if (!source.officialUrl || !source.sha256) {
      fail(`${id} 的官方来源缺少 officialUrl 或 sha256`);
    }
    if (pkg.licenseSource !== 'official') {
      fail(`${id} 的许可证不是取自官方仓库（licenseSource=${pkg.licenseSource ?? '未标注'}）`);
    }
    if (source.sha256 && source.sha256 !== sha256Of(pkg.licenseText)) {
      fail(`${id} 的许可证原文哈希与官方来源记录不一致`);
    }
    if (!source.versionPinned) {
      console.warn(
        `[bridge-legal] 注意：${id} 的官方原文未固定版本（ref=${source.ref}）；${source.versionPinNote}`
      );
    }
  }
}

console.log(
  `[bridge-legal] bundle=${bundled.size} declared=${declared.size} missing=${missing.length} extra=${extra.length} -> ${
    process.exitCode ? 'FAIL' : 'ok'
  }`
);
