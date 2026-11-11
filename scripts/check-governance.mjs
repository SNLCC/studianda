import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRS = ['packages/core/src', 'packages/app/src', 'packages/ui/src', 'apps/desktop/src'];
const failures = [];

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target, visit);
    else visit(target);
  }
}

function sourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    try {
      walk(path.join(root, dir), (file) => {
        if (/\.(ts|tsx|js|mjs|cjs)$/.test(file)) files.push(file);
      });
    } catch {
    }
  }
  return files;
}

const coreIndex = path.join(root, 'packages', 'core', 'src', 'index.ts');
try {
  const text = readFileSync(coreIndex, 'utf8');
  if (!/\.listen\(\s*\{[^}]*host:\s*['"]127\.0\.0\.1['"]/s.test(text)) {
    failures.push('packages/core/src/index.ts: 未找到 listen({ host: \'127.0.0.1\' })；不得改为对外监听地址');
  }
} catch {
  failures.push('packages/core/src/index.ts: 读取失败');
}
for (const file of sourceFiles()) {
  if (!file.includes(`${path.sep}core${path.sep}src${path.sep}`)) continue;
  const text = readFileSync(file, 'utf8');
  const listenHosts = [...text.matchAll(/\.listen\(\s*\{[^}]*host:\s*['"]([^'"]+)['"]/gs)].map(
    (match) => match[1]
  );
  for (const host of listenHosts) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      failures.push(`${path.relative(root, file)}: listen host「${host}」不是回环地址`);
    }
  }
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\btvly-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/
];
for (const file of sourceFiles()) {
  if (file.includes(`${path.sep}test${path.sep}`)) continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match) failures.push(`${path.relative(root, file)}: 疑似硬编码密钥（${match[0].slice(0, 8)}…）`);
  }
}

const TRAINING_PATTERNS = [/\/v1\/(?:fine-tunes|fine_tuning|training)\b/i, /\bfine[-_]?tune\b/i];
for (const file of sourceFiles()) {
  if (file.includes(`${path.sep}test${path.sep}`)) continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of TRAINING_PATTERNS) {
    if (pattern.test(text)) {
      failures.push(`${path.relative(root, file)}: 命中训练/微调相关调用或配置（${pattern}）`);
    }
  }
}

for (const file of sourceFiles()) {
  if (file.includes(`${path.sep}test${path.sep}`)) continue;
  const text = readFileSync(file, 'utf8');
  if (/\bcrashReporter\b/.test(text) || /\bsendBeacon\s*\(/.test(text)) {
    failures.push(`${path.relative(root, file)}: 命中崩溃上报/埋点调用`);
  }
}

if (failures.length > 0) {
  console.error('[check-governance] 失败：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('[check-governance] ok：本地监听/无硬编码密钥/无训练微调/无崩溃上报');
