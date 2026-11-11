/**
 * 合规 P1-13 / P2-16：构建期防遥测检查。
 *
 * 目标：本地优先定位下，禁止把遥测/统计/崩溃上报 SDK 引入运行时代码。
 * 只做保守检查（已知 SDK 名 + 源码里的已知调用），避免误伤普通依赖。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  'dist',
  'out',
  'release',
  'coverage',
  '.font-build-cache'
]);

const TELEMETRY_PACKAGES = [
  /^@sentry\//,
  /^@bugsnag\//,
  /^@datadog\//,
  /^posthog-/,
  /^mixpanel/,
  /^amplitude/,
  /^newrelic/,
  /^@newrelic\//,
  /^umami/,
  /^@segment\//,
  /^analytics-node$/,
  /^firebase$/,
  /^@firebase\/analytics$/
];

const TELEMETRY_CALLS = [/\bcrashReporter\b/, /\bsendBeacon\s*\(/, /\bposthog\.capture\b/];

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target, visit);
    else visit(target);
  }
}

const failures = [];

// 1) 依赖清单：workspace 的各 package.json。
walk(root, (file) => {
  if (path.basename(file) !== 'package.json') return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(parsed[field] ?? {})) {
      if (TELEMETRY_PACKAGES.some((pattern) => pattern.test(name))) {
        failures.push(`${path.relative(root, file)}: ${field} 含遥测 SDK「${name}」`);
      }
    }
  }
});

// 2) 源码：已知的崩溃上报/埋点调用。
walk(root, (file) => {
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) return;
  if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}scripts${path.sep}`)) {
    return;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const pattern of TELEMETRY_CALLS) {
    if (pattern.test(text)) {
      failures.push(`${path.relative(root, file)}: 命中遥测/崩溃上报调用 ${pattern}`);
    }
  }
});

if (failures.length > 0) {
  console.error('[check-telemetry] 失败：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('[check-telemetry] ok：未发现遥测/统计/崩溃上报 SDK 或调用');
