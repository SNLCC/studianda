/**
 * 把 MCP bridge 打成单个 ESM 文件（含 SDK / zod / agent-core），
 * 供安装包作为 `resources/agent-bridge.mjs` 由 Electron-as-node 直接运行。
 */
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.join(root, 'packages', 'agent-bridge', 'dist', 'agent-bridge.mjs');

await build({
  entryPoints: [path.join(root, 'packages', 'agent-bridge', 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'info'
});

console.log(`[agent-bridge] bundled -> ${path.relative(root, outfile)}`);
