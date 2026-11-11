/**
 * 库构建：把一个 workspace 包打成可被外部宿主消费的 dist。
 *
 * - JS：esbuild（ESM，`packages: 'external'` 保留 react/@studianda/shared 等运行时依赖）；
 * - 类型：`tsc -p tsconfig.build.json` 只产 .d.ts；
 * - Vite 专属资源（例如 `pdfjs-dist/...?url`）：保留为外部 import，由使用方 bundler 解析
 *   （文档需写明：非 Vite 宿主必须提供等价 worker/资源解析）。
 *
 * 用法（仓库根目录）：node scripts/build-lib.mjs packages/ui
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
// pnpm 在包目录执行 script（参数 "."），根目录手动执行时可传 packages/xxx。
const pkgDir = path.resolve(process.cwd(), process.argv[2] ?? '.');
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const entry = path.join(pkgDir, 'src', 'index.ts');
const outfile = path.join(pkgDir, 'dist', 'index.js');

/** 保留 Vite 风格的 `?url` 导入，交给消费方 bundler 解析。 */
const keepAssetQueryPlugin = {
  name: 'keep-asset-query',
  setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, (args) => ({
      path: args.path,
      external: true
    }));
  }
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: true,
  packages: 'external',
  plugins: [keepAssetQueryPlugin],
  logLevel: 'info'
});

const tsc = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(pkgDir, 'tsconfig.build.json')],
  { cwd: pkgDir, stdio: 'inherit' }
);
if (tsc.status !== 0) {
  console.error(`[build-lib] ${pkg.name} 类型声明生成失败（exit ${tsc.status}）`);
  process.exit(tsc.status ?? 1);
}

console.log(`[build-lib] ${pkg.name} → ${path.relative(root, outfile)} + index.d.ts`);
