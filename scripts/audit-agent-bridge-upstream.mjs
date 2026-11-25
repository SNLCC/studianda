/**
 * 校验 Agent MCP bridge 内嵌第三方包的许可证是否能在其**官方仓库**找到原文，
 * 并把官方原文（含 ref / URL / SHA-256）保存为可复现的来源记录。
 *
 * 背景：agent-bridge.mjs 是 esbuild 单文件 bundle，内嵌的 8 个 npm 包不会出现在
 * 安装包 node_modules 依赖树里，因此不能靠 asar 扫描发现；而 npm 包里的 LICENSE
 * 可能被发布者改动或与仓库不一致。本脚本按 package.json 的 repository 找到 GitHub
 * 官方仓库，优先按版本 tag 取 LICENSE/NOTICE，失败再退回默认分支，并记录是否版本固定。
 *
 * 用法：node scripts/audit-agent-bridge-upstream.mjs
 * 产物：legal/upstream/agent-bridge-official/{SOURCES.json,licenses/*}
 * 之后运行 node scripts/sync-agent-bridge-legal.mjs，会把官方原文写进随包 legal/。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const legalDir = path.join(root, 'legal');
const depsFile = path.join(legalDir, 'upstream', 'agent-bridge', 'deps.json');
const outputDir = path.join(legalDir, 'upstream', 'agent-bridge-official');
const licensesDir = path.join(outputDir, 'licenses');
const CANDIDATE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE'];
const USER_AGENT = 'studianda-legal-audit';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const normalize = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim();

function parseGitHub(repository) {
  if (!repository) return null;
  const value = String(repository)
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  const shorthand = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, '') };
  const match = value.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

async function fetchOfficial(owner, repo, version) {
  const refs = [`v${version}`, String(version), 'main', 'master'];
  for (const ref of refs) {
    for (const file of CANDIDATE_FILES) {
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`;
      let response;
      try {
        response = await fetch(apiUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/vnd.github+json'
          },
          signal: AbortSignal.timeout(20_000)
        });
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const body = await response.json().catch(() => null);
      if (!body || body.type !== 'file' || typeof body.content !== 'string') continue;
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      if (text.trim().length < 20) continue;
      return {
        ref,
        file,
        text,
        url: body.html_url ?? `https://github.com/${owner}/${repo}/blob/${ref}/${file}`
      };
    }
  }
  return null;
}

if (!existsSync(depsFile)) {
  console.error(`[bridge-upstream] 缺少 ${path.relative(root, depsFile)}；先构建 agent-bridge`);
  process.exit(1);
}

const packages = JSON.parse(readFileSync(depsFile, 'utf8')).packages;
mkdirSync(licensesDir, { recursive: true });

const entries = [];
let failed = 0;
for (const pkg of packages) {
  const localPath = pkg.copied ? path.join(legalDir, pkg.copied) : null;
  const localText = localPath && existsSync(localPath) ? readFileSync(localPath, 'utf8') : '';
  const github = parseGitHub(pkg.repository);
  const entry = {
    package: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    officialUrl: null,
    ref: null,
    file: null,
    sha256: null,
    localPath: pkg.copied,
    localSha256: localText ? sha256(normalize(localText)) : null,
    match: null,
    versionPinned: false,
    versionPinNote: ''
  };
  if (!github) {
    entry.versionPinNote = '无法从 package.json 解析 GitHub 官方仓库。';
    failed += 1;
    entries.push(entry);
    console.log(`[bridge-upstream] ${pkg.name}@${pkg.version}: 无 GitHub 仓库`);
    continue;
  }
  const official = await fetchOfficial(github.owner, github.repo, pkg.version);
  if (!official) {
    entry.versionPinNote = `官方仓库 ${github.owner}/${github.repo} 未找到 LICENSE/NOTICE。`;
    failed += 1;
    entries.push(entry);
    console.log(`[bridge-upstream] ${pkg.name}@${pkg.version}: 官方仓库无许可证原文`);
    continue;
  }
  const officialText = official.text;
  const safe = pkg.name.replace(/^@/, '').replace(/[\\/]/g, '_').replace(/[^\w.-]/g, '_');
  const relativeLicense = path
    .join('upstream', 'agent-bridge-official', 'licenses', `${safe}@${pkg.version}-${official.file}`)
    .split(path.sep)
    .join('/');
  mkdirSync(path.dirname(path.join(legalDir, relativeLicense)), { recursive: true });
  writeFileSync(path.join(legalDir, relativeLicense), `${normalize(officialText)}\n`, 'utf8');
  entry.officialUrl = official.url;
  entry.ref = official.ref;
  entry.file = official.file;
  entry.sha256 = sha256(normalize(officialText));
  entry.match = normalize(officialText) === normalize(localText);
  entry.versionPinned = official.ref !== 'main' && official.ref !== 'master';
  entry.versionPinNote = entry.versionPinned
    ? `按版本 tag ${official.ref} 取官方原文。`
    : `官方仓库没有 ${pkg.version} 对应的 tag，取 ${official.ref} 分支原文；已记录哈希，需随包核对。`;
  entry.officialLicensePath = relativeLicense;
  entries.push(entry);
  console.log(
    `[bridge-upstream] ${pkg.name}@${pkg.version}: ${official.ref}/${official.file} match=${entry.match}`
  );
}

const sourcesFile = path.join(outputDir, 'SOURCES.json');
writeFileSync(
  sourcesFile,
  `${JSON.stringify(
    {
      note:
        'Agent MCP bridge 内嵌第三方包的官方仓库许可证来源记录。由 scripts/audit-agent-bridge-upstream.mjs 生成；' +
        'sha256 为规范化换行后的官方原文哈希，match 表示与 npm 包内 LICENSE 原文一致。',
      generatedAt: new Date().toISOString(),
      entries
    },
    null,
    2
  )}\n`,
  'utf8'
);

const matched = entries.filter((entry) => entry.match).length;
console.log(
  `[bridge-upstream] ${entries.length} 个包，官方原文匹配 ${matched}，未找到/未固定 ${failed}；来源记录：${path.relative(root, sourcesFile)}`
);
if (failed > 0) process.exitCode = 1;
