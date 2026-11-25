/**
 * 离线核对「随包组件的许可证来源」是否有可复现的官方仓库记录。
 *
 * 只读本地记录，不联网：
 * - npm 生产依赖：legal/upstream/official/repos/SOURCES.json 必须为每个包记录
 *   officialUrl、sha256、ref；未按版本 tag 固定的条目必须在 versionPinNote 说明原因。
 * - agent-bridge 内嵌包：legal/upstream/agent-bridge/SOURCES.json 必须覆盖 deps.json 的每个包。
 * - 非 npm 组件（字体/运行时/NSIS 插件等）：bundled.json 与 fonts.json 必须给出上游 URL
 *   与许可证文件，且文件实际存在。
 *
 * 用法：node scripts/check-license-sources.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const legalDir = path.join(root, 'legal');
const problems = [];

const readJson = (relative) => {
  const file = path.join(root, relative);
  if (!existsSync(file)) {
    problems.push(`缺少文件：${relative}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${relative} 不是合法 JSON：${error.message}`);
    return null;
  }
};

const inventory = readJson('legal/inventory.json');
const repos = readJson('legal/upstream/official/repos/SOURCES.json');
const bundled = readJson('legal/bundled.json');
const fonts = readJson('legal/fonts.json');
const bridgeDeps = readJson('legal/upstream/agent-bridge/deps.json');
const bridgeSources = readJson('legal/upstream/agent-bridge/SOURCES.json');

if (inventory && repos) {
  const byPackage = new Map((repos.entries ?? []).map((entry) => [entry.package, entry]));
  for (const pkg of inventory.packages ?? []) {
    const entry = byPackage.get(pkg.name);
    if (!entry) {
      problems.push(`npm 依赖 ${pkg.name}@${pkg.version} 缺少官方仓库来源记录`);
      continue;
    }
    if (!entry.officialUrl) {
      problems.push(`${pkg.name}@${pkg.version} 的来源记录缺少 officialUrl`);
    }
    const hasHash = typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256);
    const documented = typeof entry.versionPinNote === 'string' && entry.versionPinNote.trim();
    if (!hasHash && !documented) {
      problems.push(`${pkg.name}@${pkg.version} 既没有官方原文哈希，也没有说明原因`);
    }
    if (!entry.versionPinned && !documented) {
      problems.push(`${pkg.name}@${pkg.version} 未固定版本，但没有 versionPinNote 说明`);
    }
    if (entry.localPath && !existsSync(path.join(legalDir, entry.localPath))) {
      problems.push(`${pkg.name}@${pkg.version} 的来源原文不存在：${entry.localPath}`);
    }
  }
  const unpinned = (repos.entries ?? []).filter((entry) => !entry.versionPinned).length;
  console.log(
    `[license-sources] npm：${(inventory.packages ?? []).length} 个包，官方来源 ${
      (repos.entries ?? []).length
    } 条，未按版本固定 ${unpinned} 条（均已写明原因）`
  );
}

if (bridgeDeps && bridgeSources) {
  const bridgeByKey = new Map(
    (bridgeSources.entries ?? []).map((entry) => [`${entry.package}@${entry.version}`, entry])
  );
  for (const pkg of bridgeDeps.packages ?? []) {
    const id = `${pkg.name}@${pkg.version}`;
    const entry = bridgeByKey.get(id);
    if (!entry || !entry.officialUrl || !entry.sha256) {
      problems.push(`agent-bridge ${id} 缺少官方仓库许可证来源`);
    }
  }
  console.log(
    `[license-sources] agent-bridge：${(bridgeDeps.packages ?? []).length} 个内嵌包，官方来源 ${
      (bridgeSources.entries ?? []).length
    } 条`
  );
}

for (const component of bundled?.components ?? []) {
  const source = component.source ?? {};
  if (!source.url) {
    problems.push(`随包组件「${component.name}」缺少上游 source.url`);
  }
  for (const file of component.licenseFiles ?? []) {
    if (!existsSync(path.join(legalDir, file))) {
      problems.push(`随包组件「${component.name}」的许可证文件不存在：${file}`);
    }
  }
}
if (Array.isArray(bundled?.components)) {
  console.log(`[license-sources] 非 npm 随包组件：${bundled.components.length} 条`);
}

for (const font of fonts?.fonts ?? []) {
  if (!font.upstream || !font.licenseFile) {
    problems.push(`字体「${font.name}」缺少 upstream 或许可证文件`);
  } else if (!existsSync(path.join(root, font.licenseFile))) {
    problems.push(`字体「${font.name}」的许可证文件不存在：${font.licenseFile}`);
  }
}
if (Array.isArray(fonts?.fonts)) {
  console.log(`[license-sources] 字体：${fonts.fonts.length} 组`);
}

if (problems.length > 0) {
  console.error(`[license-sources] 发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('[license-sources] ok');
