/**
 * 双宿主边界门禁。
 *
 * 目标：共享包（app/ui/shared/host/api-client）不重新长回 Electron/DSH 专用代码，
 * 防止“双端/双宿主”准备在后续功能开发中被悄悄破坏。
 *
 * 只做静态检查；宿主适配实现（apps/desktop、未来的 host-dsh）不在扫描范围。
 * 例外必须写进 scripts/host-boundary-allowlist.json，并给出原因。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistFile = path.join(root, 'scripts', 'host-boundary-allowlist.json');

/** 宿主专用实现：不允许被共享包导入，也不作为共享包扫描。 */
const HOST_SPECIFIC_PACKAGES = new Set(['core', 'host-dsh']);

/** 共享包：自动发现 packages/*，避免新包漏检。 */
const SOURCE_DIRS = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !HOST_SPECIFIC_PACKAGES.has(entry.name))
  .map((entry) => `packages/${entry.name}/src`)
  .filter((relative) => existsSync(path.join(root, relative)));

/** 只检查样式里的视口单位；其它 CSS 规则不在这里管。 */
const CSS_FILES = ['packages/ui/src/styles/styles.css', 'packages/ui/src/styles/qa.css'];

const allowlist = JSON.parse(readFileSync(allowlistFile, 'utf8'));
const violations = [];
const checked = [];

function allowed(rule, file, value) {
  const entries = allowlist[rule];
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (entry) =>
      entry.file === file &&
      (entry.value == null || entry.value === value) &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
  );
}

function report(rule, file, line, value) {
  if (allowed(rule, file, value)) return;
  violations.push({ rule, file, line, value });
}

function lineAt(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function checkSource(file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (/\.(test|spec)\./.test(relative)) return;
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  checked.push(relative);

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      const value = ts.isStringLiteralLike(specifier) ? specifier.text : '';
      if (
        value === 'electron' ||
        value.startsWith('@deepseek-ai/') ||
        value.startsWith('node:')
      ) {
        report('host-import', relative, lineAt(sourceFile, node), value);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'window' &&
      node.name.text === 'studianda'
    ) {
      report('window-studianda', relative, lineAt(sourceFile, node), 'window.studianda');
    }

    if (ts.isIdentifier(node) && node.text === 'safeStorage') {
      report('safe-storage', relative, lineAt(sourceFile, node), 'safeStorage');
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'addEventListener' ||
        node.expression.name.text === 'removeEventListener') &&
      ts.isIdentifier(node.expression.expression) &&
      ['window', 'document'].includes(node.expression.expression.text)
    ) {
      const first = node.arguments[0];
      if (ts.isStringLiteralLike(first) && first.text === 'keydown') {
        report(
          'global-keydown',
          relative,
          lineAt(sourceFile, node),
          `${node.expression.expression.text}.${node.expression.name.text}('keydown')`
        );
      }
    }

    if (ts.isStringLiteralLike(node) && /studianda-asset:/i.test(node.text)) {
      report('asset-url-literal', relative, lineAt(sourceFile, node), node.text);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

for (const dir of SOURCE_DIRS) {
  const full = path.join(root, dir);
  try {
    walk(full, checkSource);
  } catch {
    // 目录不存在时跳过；新增共享包应同步加入 SOURCE_DIRS。
  }
}

for (const relative of CSS_FILES) {
  const full = path.join(root, relative);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  checked.push(relative);
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/var\(--kr-viewport-(?:height|width),\s*100(?:vh|vw)\)/g, '');
  const lines = stripped.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/\b100(?:vh|vw)\b/.test(line)) {
      report('raw-viewport-unit', relative, index + 1, line.trim());
    }
  });
}

/**
 * 契约门禁：RuntimeAdapter 的新能力默认必须是可选的。
 *
 * 只允许三个所有宿主都能实现的基础方法为必需；新增必需成员会迫使 DSH/Web 宿主
 * 无法省略能力，必须走 allowlist 复审，不能静默放宽。
 */
const CONTRACT_FILE = 'packages/host/src/index.ts';
const REQUIRED_CONTRACT_METHODS = new Set(['getRuntime', 'pickPdf', 'pickDirectory']);
const contractPath = path.join(root, CONTRACT_FILE);
if (existsSync(contractPath)) {
  checked.push(CONTRACT_FILE);
  const text = readFileSync(contractPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    CONTRACT_FILE,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let found = false;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'RuntimeAdapter') {
      found = true;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
        if (member.questionToken) continue;
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : '';
        if (name && !REQUIRED_CONTRACT_METHODS.has(name)) {
          report('required-capability', CONTRACT_FILE, lineAt(sourceFile, member), name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) report('contract-missing', CONTRACT_FILE, 1, 'interface RuntimeAdapter');
}

if (violations.length > 0) {
  console.error(`[host-boundary] 检查 ${checked.length} 个文件，发现 ${violations.length} 处违规：`);
  for (const violation of violations) {
    console.error(
      `  - ${violation.file}:${violation.line} [${violation.rule}] ${violation.value}`
    );
  }
  console.error(
    '  共享包只能通过 @studianda/host / host-scope / asset-url 触点接触宿主差异；' +
      '确需例外请写入 scripts/host-boundary-allowlist.json 并说明原因。'
  );
  process.exit(1);
}
console.log(`[host-boundary] ok：检查 ${checked.length} 个文件，未发现宿主耦合回流`);
