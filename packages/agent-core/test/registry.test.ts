import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registry = JSON.parse(
  readFileSync(new URL('../src/registry.json', import.meta.url), 'utf8')
) as {
  ops: Array<{ id: string; routes: string[] }>;
  never: Array<{ id: string; reason: string; routes: string[] }>;
};

const manifest = JSON.parse(
  readFileSync(new URL('../../../docs/api/route-manifest.json', import.meta.url), 'utf8')
) as { serverRoutes: string[] };

describe('agent 能力注册表', () => {
  it('每条后端路由恰好归类一次', () => {
    const seen = new Map<string, string>();
    for (const op of registry.ops) {
      for (const route of op.routes) {
        expect(seen.has(route), `重复：${route}`).toBe(false);
        seen.set(route, op.id);
      }
    }
    for (const entry of registry.never) {
      expect(entry.reason.length).toBeGreaterThan(0);
      for (const route of entry.routes) {
        expect(seen.has(route), `重复：${route}`).toBe(false);
        seen.set(route, entry.id);
      }
    }
    expect(seen.size).toBe(manifest.serverRoutes.length);
    for (const route of manifest.serverRoutes) expect(seen.has(route), `未归类：${route}`).toBe(true);
  });

  it('op id 唯一且带 caps/phase', () => {
    const ids = new Set<string>();
    for (const op of registry.ops) {
      expect(ids.has(op.id), `重复 op：${op.id}`).toBe(false);
      ids.add(op.id);
      expect(op.routes.length).toBeGreaterThan(0);
    }
  });
});
