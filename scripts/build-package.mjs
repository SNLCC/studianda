import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkgDir = process.cwd();
const entry = path.join(pkgDir, 'src', 'index.ts');
const outfile = path.join(pkgDir, 'dist', 'index.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // 保持第三方和 workspace 包为运行时依赖，便于之后替换 sidecar/Node 版本。
  packages: 'external',
  logLevel: 'info'
});

console.log(`built ${path.relative(root, outfile)}`);
