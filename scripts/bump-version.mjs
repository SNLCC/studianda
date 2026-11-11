/**
 * 同步升级 workspace 版本号。
 *
 * 用法（仓库根目录）：
 *   node scripts/bump-version.mjs 0.1.0
 *
 * 会改写 root package.json、apps/desktop/package.json、packages/*\/package.json 的
 * version 字段（只改 version，保留其余字段与两空格缩进）。
 *
 * 为什么要同步：electron-builder 读 apps/desktop/package.json 的 version 决定安装包名
 * 与 latest.yml 里的 version；root / packages 的 version 用于 workspace 内部标识和
 * build-manifest.json 的一致性校验。任何一处不一致都会让 node scripts/check-version.mjs 失败。
 *
 * 不做：不执行 git / pnpm 命令，不提交、不打 tag；只打印下一步命令，由人确认后执行。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// SemVer 2.0.0 官方推荐正则（禁止前导 0）。
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const target = process.argv[2];
if (!target) {
  console.error('[bump-version] 缺少版本号。用法：node scripts/bump-version.mjs <x.y.z>');
  process.exit(1);
}
if (target.startsWith('v')) {
  console.error(
    `[bump-version] 版本号不要带 v 前缀：${target}。请传 ${target.replace(/^v/, '')}（v 前缀只用于 git tag）。`
  );
  process.exit(1);
}
if (!SEMVER_RE.test(target)) {
  console.error(`[bump-version] 不是合法的 semver 版本号：${target}`);
  console.error('  期望 x.y.z（可带 -预发布 / +build 后缀），每段不能有前导 0，例如 0.2.0、1.0.0-rc.1。');
  process.exit(1);
}

/** 需要同步 version 的 package.json：root、桌面端、全部 packages。 */
const files = [path.join(root, 'package.json'), path.join(root, 'apps', 'desktop', 'package.json')];
const packagesDir = path.join(root, 'packages');
if (!existsSync(packagesDir)) {
  console.error(`[bump-version] 找不到 packages 目录：${packagesDir}`);
  process.exit(1);
}
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(packagesDir, entry.name, 'package.json');
  if (existsSync(file)) files.push(file);
}

const packages = [];
for (const file of files) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[bump-version] 无法解析 ${path.relative(root, file)}：${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (typeof json.version !== 'string' || !SEMVER_RE.test(json.version)) {
    console.error(`[bump-version] ${path.relative(root, file)} 的 version 不是合法 semver：${json.version}`);
    process.exit(1);
  }
  packages.push({ file, json });
}

// 升级前先报告不一致，避免在已漂移的仓库上静默"抹平"问题。
const currentVersions = new Set(packages.map(({ json }) => json.version));
if (currentVersions.size > 1) {
  console.warn('[bump-version] 注意：升级前各 package.json 的版本并不一致：');
  for (const { file, json } of packages) {
    console.warn(`  ${path.relative(root, file)}: ${json.version}`);
  }
  console.warn(`[bump-version] 本次会统一改写为 ${target}。`);
}

for (const { file, json } of packages) {
  json.version = target;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

console.log(`[bump-version] 版本已更新为 ${target}：`);
for (const { file } of packages) {
  console.log(`  ${path.relative(root, file)}`);
}
console.log('');
console.log('下一步（确认改动无误后手动执行）：');
console.log(`  1. 写发版说明：docs/releases/v${target}.md（可从 docs/releases/v0.1.0.md 复制后修改）`);
console.log('  2. 自检：pnpm check:version');
console.log(
  `  3. 提交：git add package.json apps/desktop/package.json packages && git commit -m "chore(release): v${target}"`
);
console.log(`  4. 打 tag 并推送：git tag v${target} && git push origin main --tags`);
console.log('  5. GitHub Actions 会打包并创建 draft Release，检查产物后手动发布。');
console.log('');
console.log(
  '注意：本脚本不执行任何 git / pnpm 命令。若本地 pnpm install 后 pnpm-lock.yaml 有变化，' +
    '请一并提交 lockfile。'
);
