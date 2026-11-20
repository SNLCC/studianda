#!/usr/bin/env node
/**
 * agent 能力覆盖门禁：
 * 每条后端路由必须命中 `packages/agent-core/src/registry.json` 里的一个 op，或落在 never（带理由）。
 * 新增路由忘了登记 → 这里失败，`pnpm verify` 变红。
 *
 * 用法：node scripts/check-agent-coverage.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'docs/api/route-manifest.json'), 'utf8'));
const registry = JSON.parse(
  readFileSync(path.join(root, 'packages/agent-core/src/registry.json'), 'utf8')
);

const manifestRoutes = new Set(manifest.serverRoutes);
const errors = [];
const warnings = [];

const allowedTools = new Set([
  'scope',
  'capabilities',
  'library',
  'notes',
  'annotations',
  'organize',
  'reading',
  'compute',
  'system'
]);
const allowedEffects = new Set(['read', 'write', 'costly', 'files']);
const allowedRisks = new Set(['low', 'medium', 'high']);
const allowedPhases = new Set(['P0', 'P1', 'P2', 'P3']);

/** @type {Map<string, {kind: 'op'|'never', id: string}>} */
const owners = new Map();

function claim(route, kind, id) {
  if (!manifestRoutes.has(route)) {
    errors.push(`registry 里的路由不在 route-manifest：${route}（${id}）`);
    return;
  }
  const existing = owners.get(route);
  if (existing) {
    errors.push(`路由重复登记：${route} -> ${existing.kind}:${existing.id} 与 ${kind}:${id}`);
    return;
  }
  owners.set(route, { kind, id });
}

const opIds = new Set();
for (const op of registry.ops ?? []) {
  for (const field of ['id', 'tool', 'action', 'effect', 'risk', 'phase']) {
    if (typeof op[field] !== 'string' || !op[field]) errors.push(`op 缺少字段 ${field}：${JSON.stringify(op)}`);
  }
  if (opIds.has(op.id)) errors.push(`op id 重复：${op.id}`);
  opIds.add(op.id);
  if (!allowedTools.has(op.tool)) errors.push(`未知 tool：${op.tool}（${op.id}）`);
  if (!allowedEffects.has(op.effect)) errors.push(`未知 effect：${op.effect}（${op.id}）`);
  if (!allowedRisks.has(op.risk)) errors.push(`未知 risk：${op.risk}（${op.id}）`);
  if (!allowedPhases.has(op.phase)) errors.push(`未知 phase：${op.phase}（${op.id}）`);
  if (!Array.isArray(op.caps) || op.caps.length === 0) errors.push(`op 缺少 caps：${op.id}`);
  if (!Array.isArray(op.routes) || op.routes.length === 0) errors.push(`op 没有 routes：${op.id}`);
  for (const route of op.routes ?? []) claim(route, 'op', op.id);
}

for (const entry of registry.never ?? []) {
  if (!entry.id || !entry.reason) errors.push(`never 条目缺少 id/reason：${JSON.stringify(entry)}`);
  if (!Array.isArray(entry.routes) || entry.routes.length === 0) errors.push(`never 条目没有 routes：${entry.id}`);
  for (const route of entry.routes ?? []) claim(route, 'never', entry.id);
}

const unclassified = [...manifestRoutes].filter((route) => !owners.has(route));
const missing = [...owners.keys()].filter((route) => !manifestRoutes.has(route));

if (unclassified.length) {
  errors.push(`未登记路由 ${unclassified.length} 条（新增路由必须归类到 op 或 never）：`);
  for (const route of unclassified) errors.push(`  ${route}`);
}
if (missing.length) {
  errors.push(`registry 里存在 manifest 中不存在的路由 ${missing.length} 条：`);
  for (const route of missing) errors.push(`  ${route}`);
}
if ((registry.ops ?? []).length === 0) errors.push('registry.ops 为空');
if ((registry.never ?? []).length === 0) warnings.push('registry.never 为空（可疑）');

const byPhase = { P0: 0, P1: 0, P2: 0, P3: 0 };
for (const op of registry.ops ?? []) byPhase[op.phase] = (byPhase[op.phase] ?? 0) + 1;

const summary = {
  routes: manifestRoutes.size,
  registered: owners.size,
  ops: (registry.ops ?? []).length,
  never: (registry.never ?? []).length,
  unclassified: unclassified.length,
  byPhase
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: errors.length === 0, summary, errors, warnings }, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

if (warnings.length) for (const warning of warnings) console.warn(`[agent-coverage] warning: ${warning}`);
if (errors.length) {
  console.error(`[agent-coverage] failed (${errors.length}):`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(
  `[agent-coverage] routes=${summary.routes} registered=${summary.registered} ops=${summary.ops} ` +
    `never=${summary.never} unclassified=0 phases=${JSON.stringify(summary.byPhase)} -> ok`
);
