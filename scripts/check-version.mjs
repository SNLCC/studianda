/**
 * 校验版本一致性。
 *
 * 用法（仓库根目录）：
 *   node scripts/check-version.mjs                # root / apps/desktop / packages 的 version 必须一致
 *   node scripts/check-version.mjs --tag v0.1.0   # 额外断言 tag === 'v' + version
 *
 * CI：release workflow 里的 pnpm check:version 会自动读取 GITHUB_REF_NAME。
 * 只有以 v 开头的 ref 才做 tag 断言；从分支手动触发 workflow_dispatch 时 ref 不是标签，
 * 不应因此失败（workflow 自身另有一道"必须由 v* 标签触发"的检查）。
 *
 * 退出码：一致返回 0；版本不一致、tag 对不上或参数错误返回 1。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const problems = [];

function readVersion(relativeFile) {
  const file = path.join(root, relativeFile);
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`无法读取 ${relativeFile}：${error instanceof Error ? error.message : error}`);
    return null;
  }
  if (typeof json.version !== 'string' || json.version.trim() === '') {
    problems.push(`${relativeFile} 缺少有效的 version 字段。`);
    return null;
  }
  return json.version;
}

// 1) 读取所有参与发布的 package.json 版本。
const entries = [
  { label: 'package.json', version: readVersion('package.json') },
  { label: 'apps/desktop/package.json', version: readVersion('apps/desktop/package.json') }
];
try {
  for (const entry of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const label = `packages/${entry.name}/package.json`;
    let json;
    try {
      json = JSON.parse(readFileSync(path.join(root, label), 'utf8'));
    } catch {
      // 没有 package.json 的目录（例如构建产物目录）不参与版本校验。
      continue;
    }
    entries.push({ label, version: typeof json.version === 'string' ? json.version : null });
  }
} catch (error) {
  problems.push(`无法枚举 packages 目录：${error instanceof Error ? error.message : error}`);
}

const rootVersion = entries[0].version;
if (rootVersion != null) {
  for (const { label, version } of entries.slice(1)) {
    if (version == null) {
      problems.push(`${label} 缺少有效的 version 字段。`);
    } else if (version !== rootVersion) {
      problems.push(`${label} 的 version 是 ${version}，与 package.json 的 ${rootVersion} 不一致。`);
    }
  }
}

// 2) tag 断言：--tag 优先，其次 GITHUB_REF_NAME（仅当它是 v* 标签）。
const args = process.argv.slice(2);
let tag = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--tag') {
    if (args[index + 1] == null || args[index + 1] === '') {
      problems.push('--tag 缺少版本标签，例如 --tag v0.1.0。');
      index += 1;
    } else {
      tag = args[index + 1];
      index += 1;
    }
  } else if (arg.startsWith('--tag=')) {
    tag = arg.slice('--tag='.length);
  } else {
    problems.push(`未知参数：${arg}。用法：node scripts/check-version.mjs [--tag vX.Y.Z]`);
  }
}
if (tag != null) {
  tag = tag.replace(/^refs\/tags\//, '');
}
if (tag == null) {
  const ref = process.env.GITHUB_REF_NAME;
  if (ref && ref.startsWith('v')) {
    tag = ref;
  } else if (ref) {
    console.log(`[check-version] GITHUB_REF_NAME=${ref} 不是 v* 标签，跳过 tag 校验（只校验版本一致）。`);
  }
}
if (tag != null && rootVersion != null) {
  const expected = `v${rootVersion}`;
  if (tag !== expected) {
    problems.push(`tag ${tag} 与版本号不匹配：应为 ${expected}（tag 必须是 v + root package.json 的 version）。`);
  }
}

if (problems.length > 0) {
  console.error('[check-version] 校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[check-version] 版本一致：${rootVersion}`);
for (const { label } of entries) {
  console.log(`  ${label}`);
}
if (tag != null) {
  console.log(`[check-version] tag 校验通过：${tag}`);
}
