import registryData from './registry.json';

/** Agent 能力面：一份注册表，两个适配器（MCP bridge / DSH Host）共用。 */

export type AgentPhase = 'P0' | 'P1' | 'P2' | 'P3';
export type AgentTool =
  | 'scope'
  | 'capabilities'
  | 'library'
  | 'notes'
  | 'annotations'
  | 'organize'
  | 'reading'
  | 'compute'
  | 'system';
export type AgentEffect = 'read' | 'write' | 'costly' | 'files';
export type AgentRisk = 'low' | 'medium' | 'high';

export interface AgentOp {
  id: string;
  tool: AgentTool;
  action: string;
  effect: AgentEffect;
  risk: AgentRisk;
  phase: AgentPhase;
  caps: string[];
  /** `METHOD /api/v1/...` 形式，与 docs/api/route-manifest.json 一致。 */
  routes: string[];
}

export interface NeverRoute {
  id: string;
  reason: string;
  routes: string[];
}

export interface AgentRegistry {
  version: number;
  generatedFrom: string;
  ops: AgentOp[];
  never: NeverRoute[];
}

export const AGENT_REGISTRY = registryData as AgentRegistry;

const routeOwner = new Map<string, AgentOp | NeverRoute>();
for (const op of AGENT_REGISTRY.ops) {
  for (const route of op.routes) routeOwner.set(route, op);
}
for (const entry of AGENT_REGISTRY.never) {
  for (const route of entry.routes) routeOwner.set(route, entry);
}

/** 某条后端路由由哪个 op / never 条目负责；null 表示尚未登记（覆盖门禁会失败）。 */
export function ownerOfRoute(route: string): AgentOp | NeverRoute | null {
  return routeOwner.get(route) ?? null;
}

export function isAgentOp(value: AgentOp | NeverRoute): value is AgentOp {
  return 'tool' in value;
}

/** 当前 scope 可用的 op 清单（由注册表按 caps 裁剪，供 `capabilities` 工具使用）。 */
export function opsForCaps(caps: readonly string[], includePhases: readonly AgentPhase[] = ['P0']): AgentOp[] {
  const allowed = new Set(caps);
  return AGENT_REGISTRY.ops.filter(
    (op) => includePhases.includes(op.phase) && op.caps.every((cap) => allowed.has(cap))
  );
}

export function registrySummary(): {
  ops: number;
  never: number;
  routes: number;
  byPhase: Record<AgentPhase, number>;
} {
  const byPhase: Record<AgentPhase, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const op of AGENT_REGISTRY.ops) byPhase[op.phase] += 1;
  return {
    ops: AGENT_REGISTRY.ops.length,
    never: AGENT_REGISTRY.never.length,
    routes: routeOwner.size,
    byPhase
  };
}
