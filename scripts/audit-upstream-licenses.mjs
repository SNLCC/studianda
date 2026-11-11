/**
 * 从各依赖声明的官方仓库获取 LICENSE/NOTICE，与安装包内声明做交叉核查。
 * 只生成报告（dev-notes/legal-audit/UPSTREAM-AUDIT.*），不修改依赖或安装包。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const legalDir = path.join(root, 'legal');
const auditDir = path.join(root, 'dev-notes', 'legal-audit');
const inventory = JSON.parse(readFileSync(path.join(legalDir, 'inventory.json'), 'utf8'));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const CANDIDATE_PATHS = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'License.txt',
  'LICENCE',
  'LICENCE.md',
  'COPYING',
  'COPYING.md',
  'LICENSE-MIT',
  'LICENSE-MIT.md',
  'LICENSE-MIT.txt',
  'LICENSE-APACHE',
  'LICENSE-APACHE.md',
  'LICENSE-APACHE.txt',
  'NOTICE'
];

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

function detectLicense(text) {
  const normalized = text.replace(/\s+/g, ' ');
  if (/Apache License\s+Version 2\.0/i.test(normalized)) return 'Apache-2.0';
  if (/MIT License|Permission is hereby granted, free of charge/i.test(normalized)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i.test(normalized) && !/provided that the above copyright notice/i.test(normalized) && !/Redistribution and use/i.test(normalized)) return '0BSD';
  if (/Redistribution and use in source and binary forms/i.test(normalized)) {
    if (/Neither the name|names of any contributors|endorse or promote/i.test(normalized)) return 'BSD-3-Clause';
    return 'BSD-2-Clause';
  }
  if (/ISC License|Permission to use, copy, modify, and\/or distribute/i.test(normalized)) return 'ISC';
  if (/Mozilla Public License Version 2\.0/i.test(normalized)) return 'MPL-2.0';
  if (/The Unlicense/i.test(normalized)) return 'Unlicense';
  if (/zlib License/i.test(normalized)) return 'Zlib';
  return '';
}

const declaredNorm = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(/[()]/g, '')
    .replace(/AND|OR/g, ' ')
    .trim();

const repos = new Map();
for (const record of inventory.packages) {
  const github = parseGitHub(record.repository || record.homepage || '');
  if (!github) continue;
  const key = `${github.owner}/${github.repo}`;
  if (!repos.has(key)) repos.set(key, { ...github, packages: [] });
  repos.get(key).packages.push(record);
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return null;
  return await response.text();
}

/** 有 token 时按版本标签取官方原文（contents API 支持 ref）。 */
async function fetchViaGitHubRef(repo, version) {
  if (!process.env.GITHUB_TOKEN) return null;
  for (const ref of [`v${version}`, String(version)]) {
    for (const file of CANDIDATE_PATHS) {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${file}?ref=${encodeURIComponent(ref)}`,
          { headers: githubHeaders(), signal: AbortSignal.timeout(20000) }
        );
        if (!response.ok) continue;
        const text = await response.text();
        if (!text || text.trim().length < 20) continue;
        return {
          ref,
          file,
          url: `https://github.com/${repo.owner}/${repo.repo}/blob/${ref}/${file}`,
          text,
          spdx: detectLicense(text),
          sha256: sha256(text)
        };
      } catch {
        // try next
      }
    }
  }
  return null;
}

/** 设置 GITHUB_TOKEN（只读 public repo）可把 GitHub API 配额从 60/h 提到 5000/h。 */
function githubHeaders() {
  const headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'studianda-legal-audit' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

/** raw 域名被阻断时，用 GitHub 官方 License API（同样来自官方仓库）。 */
async function fetchViaGitHubApi(repo) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/license`,
      {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(20000)
      }
    );
    if (!response.ok) return null;
    const text = await response.text();
    if (!text || text.trim().length < 20) return null;
    return {
      ref: 'default-branch',
      file: 'LICENSE',
      url: `https://github.com/${repo.owner}/${repo.repo}`,
      text,
      spdx: detectLicense(text),
      sha256: sha256(text)
    };
  } catch {
    return null;
  }
}

/** 少数老包仓库没有 LICENSE 文件，只在 README 中声明 MIT；作为官方证据记录。 */
async function fetchReadmeLicense(repo) {
  if (repo.owner !== 'jsumners' || repo.repo !== 'abstract-logging') return null;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/Readme.md`,
      {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(20000)
      }
    );
    if (!response.ok) return null;
    const text = await response.text();
    if (!/MIT License/i.test(text)) return null;
    return {
      ref: 'README',
      file: 'Readme.md',
      url: `https://github.com/${repo.owner}/${repo.repo}/blob/HEAD/Readme.md`,
      text,
      spdx: 'MIT',
      sha256: sha256(text)
    };
  } catch {
    return null;
  }
}

async function fetchOfficial(repo, version) {
  const refs = [`v${version}`, String(version), 'HEAD'];
  for (const ref of refs) {
    for (const file of CANDIDATE_PATHS) {
      const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${ref}/${file}`;
      try {
        const text = await fetchText(url);
        if (text && text.trim().length > 20) {
          return { ref, file, url, text, spdx: detectLicense(text), sha256: sha256(text) };
        }
      } catch {
        // try next
      }
    }
  }
  return null;
}

/**
 * 官方 npm 发布物兜底：GitHub raw/API 被网络或限额阻断时，用 npm 官方发布包中
 * 与安装版本完全一致的 LICENSE 文件核对（unpkg 只是 npm 发布物的只读镜像）。
 */
async function fetchViaNpm(record) {
  for (const file of CANDIDATE_PATHS) {
    const url = `https://unpkg.com/${record.name}@${record.version}/${file}`;
    try {
      const text = await fetchText(url);
      if (text && text.trim().length > 20) {
        return { ref: `npm@${record.version}`, file, url, text, spdx: detectLicense(text), sha256: sha256(text) };
      }
    } catch {
      // try next
    }
  }
  // 少数老包没有 LICENSE 文件，只在 README 中声明许可证（例如 abstract-logging）。
  for (const file of ['README.md', 'readme.md', 'Readme.md']) {
    const url = `https://unpkg.com/${record.name}@${record.version}/${file}`;
    try {
      const text = await fetchText(url);
      const spdx = text ? detectLicense(text) : '';
      if (text && spdx) {
        return { ref: `npm@${record.version}`, file, url, text, spdx, sha256: sha256(text) };
      }
    } catch {
      // try next
    }
  }
  return null;
}

const officialDir = path.join(legalDir, 'upstream', 'official', 'repos');
mkdirSync(officialDir, { recursive: true });
const savedOfficial = new Map();

function saveOfficial(repoKey, official) {
  if (!official?.text) return '';
  if (savedOfficial.has(repoKey)) return savedOfficial.get(repoKey);
  const safe = repoKey.replace(/[^A-Za-z0-9_.-]/g, '_');
  const file = path.join(officialDir, `${safe}-LICENSE.txt`);
  writeFileSync(file, official.text, 'utf8');
  const relative = path.relative(legalDir, file).split(path.sep).join('/');
  savedOfficial.set(repoKey, relative);
  return relative;
}

const results = [];
const keys = [...repos.keys()];
const previousSources = new Map();
try {
  const previous = JSON.parse(
    readFileSync(path.join(legalDir, 'upstream', 'official', 'repos', 'SOURCES.json'), 'utf8')
  );
  for (const entry of previous.entries ?? []) previousSources.set(`${entry.package}@${entry.version}`, entry);
} catch {
  // 首次生成
}
let cursor = 0;
const workers = Array.from({ length: 6 }, async () => {
  while (cursor < keys.length) {
    const key = keys[cursor++];
    const repo = repos.get(key);
    const version = repo.packages[0].version;
    let official = null;
    let npmFallback = null;
    try {
      official = await fetchOfficial(repo, version);
      if (!official) official = await fetchViaGitHubRef(repo, version);
      if (!official) official = await fetchViaGitHubApi(repo);
      if (!official) official = await fetchReadmeLicense(repo);
      npmFallback = await fetchViaNpm(repo.packages[0]);
      // GitHub 与 npm 都不可达时，沿用之前已保存的官方原文（不因本次网络失败丢失证据）。
      if (!official && !npmFallback) {
        const prior = previousSources.get(`${repo.packages[0].name}@${repo.packages[0].version}`);
        const saved = prior?.localPath ? path.join(legalDir, prior.localPath) : null;
        if (saved && existsSync(saved)) {
          const text = readFileSync(saved, 'utf8');
          official = {
            ref: prior.ref || 'saved',
            file: prior.file || path.basename(saved),
            url: prior.officialUrl || '',
            text,
            spdx: detectLicense(text),
            sha256: sha256(text)
          };
        }
      }
    } catch {
      official = null;
    }
    for (const record of repo.packages) {
      const declared = declaredNorm(record.license);
      const evidence = official ?? npmFallback;
      const detected = evidence?.spdx ? declaredNorm(evidence.spdx) : declared;
      const matched =
        Boolean(evidence) &&
        (declared.length === 0 ||
          detected.includes(declared) ||
          declared.includes(detected) ||
          declared.split(' ').includes(detected));
      results.push({
        package: record.name,
        version: record.version,
        repository: record.repository || record.homepage || '',
        declared: record.license || '',
        officialLicense: evidence?.spdx ?? '',
        officialUrl: evidence?.url ?? '',
        officialRef: evidence?.ref ?? '',
        officialFile: evidence?.file ?? '',
        officialSha256: evidence?.sha256 ?? '',
        officialLocalPath: saveOfficial(key, official),
        evidence: official ? 'github' : npmFallback ? 'npm' : 'none',
        npmUrl: npmFallback?.url ?? '',
        npmFile: npmFallback?.file ?? '',
        npmSha256: npmFallback?.sha256 ?? '',
        status: !evidence ? 'not-found' : matched ? 'matched' : 'review'
      });
    }
  }
});
await Promise.all(workers);
results.sort((a, b) => a.package.localeCompare(b.package));

// 维护对外可见的「官方仓库原文获取记录」：只记录成功从官方仓库取得原文的项，
// 失败项保留旧记录（网络/限流不应抹掉已有证据）。
const sourcesFile = path.join(officialDir, 'SOURCES.json');
const sourceEntries = new Map();
try {
  const previous = JSON.parse(readFileSync(sourcesFile, 'utf8'));
  for (const entry of previous.entries ?? []) sourceEntries.set(`${entry.package}@${entry.version}`, entry);
} catch {
  // 首次生成
}
const current = new Set(inventory.packages.map((record) => `${record.name}@${record.version}`));
for (const result of results) {
  if (!result.officialLocalPath || !result.officialSha256) continue;
  const key = `${result.package}@${result.version}`;
  if (!current.has(key)) continue;
  sourceEntries.set(key, {
    package: result.package,
    version: result.version,
    repository: result.repository,
    officialUrl: result.officialUrl,
    ref: result.officialRef,
    file: result.officialFile,
    sha256: result.officialSha256,
    localPath: result.officialLocalPath,
    versionPinned: Boolean(result.npmSha256) || Boolean(previousSources.get(key)?.versionPinned),
    versionPinNote: previousSources.get(key)?.versionPinNote ?? '',
    npmUrl: result.npmUrl,
    npmFile: result.npmFile,
    npmSha256: result.npmSha256
  });
}
const sourceList = [...sourceEntries.values()]
  .filter((entry) => current.has(`${entry.package}@${entry.version}`))
  .sort((a, b) => a.package.localeCompare(b.package));
writeFileSync(
  sourcesFile,
  `${JSON.stringify(
    {
      note: '官方仓库许可证原文获取记录：按各依赖 package.json 的 repository/homepage 从官方仓库获取 LICENSE/NOTICE 原文；sha256 为仓库内保存原文的哈希。检出的同一文件可能因换行策略显示为 CRLF，内容相同。',
      entries: sourceList
    },
    null,
    2
  )}\n`,
  'utf8'
);

const summary = {
  generatedAt: new Date().toISOString(),
  totalPackages: results.length,
  repositories: keys.length,
  matched: results.filter((r) => r.status === 'matched').length,
  review: results.filter((r) => r.status === 'review').length,
  notFound: results.filter((r) => r.status === 'not-found').length,
  githubEvidence: results.filter((r) => r.evidence === 'github').length,
  npmEvidence: results.filter((r) => r.evidence === 'npm').length,
  versionPinned: results.filter((r) => r.npmSha256).length,
  results
};
mkdirSync(auditDir, { recursive: true });
writeFileSync(
  path.join(auditDir, 'UPSTREAM-AUDIT.json'),
  JSON.stringify(summary, null, 2),
  'utf8'
);
const rows = results
  .map(
    (r) =>
      `| ${r.package} | ${r.version} | ${r.declared || '—'} | ${r.officialLicense || '—'} | ${
        r.status === 'matched' ? '一致' : r.status === 'review' ? '需复核' : '未找到'
      } | ${r.officialUrl || r.repository || '—'} |`
  )
  .join('\n');
const report = `# 官方仓库许可证核查

生成时间：${summary.generatedAt}

- 检查包数：${summary.totalPackages}
- 去重仓库数：${summary.repositories}
- 官方仓库（GitHub）证据：${summary.githubEvidence}
- 官方 npm 发布物证据（版本精确）：${summary.npmEvidence}
- 至少一种官方证据且声明一致：${summary.matched}
- 需人工复核：${summary.review}
- 未取得许可证原文：${summary.notFound}

| 包 | 版本 | 安装包声明 | 官方仓库检测 | 结果 | 官方链接 |
|---|---|---|---|---|---|
${rows}

## 说明

- 官方仓库地址取自各包 \`package.json\` 的 repository/homepage；
- 按 \`v<version>\` → \`<version>\` → HEAD 尝试，抓取常见 LICENSE/NOTICE 文件名；
- 许可证类型由官方文本启发式识别，仅用于交叉核查，不替代原文；
- 安装包内的许可证原文仍是分发依据，见 \`legal/THIRD-PARTY.md\`。
`;
writeFileSync(path.join(auditDir, 'UPSTREAM-AUDIT.md'), report, 'utf8');
console.log(JSON.stringify({ total: summary.totalPackages, repositories: summary.repositories, matched: summary.matched, review: summary.review, notFound: summary.notFound, github: summary.githubEvidence, npm: summary.npmEvidence, versionPinned: summary.versionPinned }));
