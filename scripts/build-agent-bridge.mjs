/**
 * 把 MCP bridge 打成单个 ESM 文件（含 SDK / zod / agent-core），
 * 供安装包作为 `resources/agent-bridge.mjs` 由 Electron-as-node 直接运行。
 */
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.join(root, 'packages', 'agent-bridge', 'dist', 'agent-bridge.mjs');

const result = await build({
  entryPoints: [path.join(root, 'packages', 'agent-bridge', 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  absWorkingDir: root,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'info'
});

/**
 * 把对象/数组递归规范化：对象键按字典序、数组按序列化结果排序。
 *
 * 为什么需要：esbuild metafile 里对象键/数组顺序取决于文件系统遍历顺序，在不同机器/CI 上
 * 可能生成 **字节数相同但 SHA-256 不同** 的 meta.json；而 legal 清单会记录这个文件的哈希。
 * 排序后的 metafile 在本地与 CI 上可复现（是否被 bundle 的内容本身不受影响）。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalJson)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalJson(value[key]);
    return result;
  }
  return value;
}

writeFileSync(
  `${outfile}.meta.json`,
  `${JSON.stringify(canonicalJson(result.metafile), null, 2)}\n`
);
console.log(`[agent-bridge] bundled -> ${path.relative(root, outfile)}`);
