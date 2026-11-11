/**
 * UI 包可消费性 smoke test。
 *
 * 在不启动桌面壳的前提下验证：
 * 1. `@studianda/ui` 的 package exports 能解析到 JS 与两份 CSS（styles.css / qa.css）；
 * 2. CSS 内含 @font-face 与主题 token，且引用的字体文件真实存在；
 * 3. dist 产物里没有 Vite 专属 `?url`（ui 包应可被任意 bundler 消费）；
 * 4. 从 workspace 里能实际 import 到 UI 组件导出（Node ESM + peer react）。
 *
 * 运行：node scripts/check-ui-consumable.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const appPkg = path.join(root, 'packages', 'app', 'package.json');
const requireFromApp = createRequire(appPkg);
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? `（${detail}）` : ''}`);
    console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

console.log('[ui-consumable] 解析 exports');
const stylesPath = requireFromApp.resolve('@studianda/ui/styles.css');
const qaPath = requireFromApp.resolve('@studianda/ui/qa.css');
const jsPath = requireFromApp.resolve('@studianda/ui');
check('styles.css 解析', existsSync(stylesPath), stylesPath);
check('qa.css 解析', existsSync(qaPath), qaPath);
check('JS 入口解析', existsSync(jsPath), jsPath);

console.log('[ui-consumable] 检查样式内容与字体');
const styles = readFileSync(stylesPath, 'utf8');
check('包含 @font-face', /@font-face/.test(styles));
check('包含宣纸主题 token', /--kr-paper\s*:/.test(styles));
const fontRefs = [...styles.matchAll(/url\("\.\/(assets\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
check('引用字体数量 > 0', fontRefs.length > 0, `refs=${fontRefs.length}`);
let missingFonts = 0;
for (const ref of new Set(fontRefs)) {
  const fontPath = path.join(path.dirname(stylesPath), ref);
  if (!existsSync(fontPath)) {
    missingFonts += 1;
    console.error(`    缺少字体：${ref}`);
  }
}
check('引用的字体文件全部存在', missingFonts === 0, `missing=${missingFonts}`);

console.log('[ui-consumable] 检查 dist 是否与 Vite 解耦');
const distFile = path.join(root, 'packages', 'ui', 'dist', 'index.js');
if (!existsSync(distFile)) {
  failures.push('packages/ui/dist/index.js 不存在（先运行 pnpm --filter @studianda/ui build）');
  console.error('  ✗ dist 不存在，跳过后续 import 检查');
} else {
  const dist = readFileSync(distFile, 'utf8');
  check('dist 不含 ?url', !dist.includes('?url'));
  check('dist 不含 import.meta.url 资源语义', !dist.includes('import.meta.url'));
}

console.log('[ui-consumable] 实际 import 组件');
try {
  // 用 exports 解析出的真实文件 URL 导入（脚本所在目录没有 node_modules 链接）。
  const ui = await import(pathToFileURL(jsPath).href);
  for (const name of ['BrandMark', 'ChatPanel', 'DocumentList', 'MarkdownEditor', 'HealthCard']) {
    check(`导出 ${name}`, typeof ui[name] !== 'undefined');
  }
} catch (error) {
  failures.push(`import @studianda/ui 失败：${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error(`\n[ui-consumable] 失败 ${failures.length} 项`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\n[ui-consumable] ok');
