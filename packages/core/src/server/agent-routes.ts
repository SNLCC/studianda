import type { FastifyInstance } from 'fastify';
import {
  API_PREFIX,
  defaultAgentScope,
  type AgentScope,
  type AgentScopeKind
} from '@studianda/shared';
import type { Store } from '../store.js';
import { badRequest } from './http.js';

const SETTING_KEY = 'agent.scope';
const ALLOWED_CAPS = new Set(['read', 'write', 'costly', 'files']);
const MAX_SELECTION = 2000;
const MAX_DOCUMENTS = 200;
const MAX_TTL_MS = 8 * 60 * 60 * 1000;

function readScope(store: Store): AgentScope {
  try {
    const raw = store.getSettings()[SETTING_KEY];
    if (!raw) return defaultAgentScope();
    const parsed = JSON.parse(raw) as AgentScope;
    return normalizeScope(parsed, { allowPastExpiry: true });
  } catch {
    return defaultAgentScope();
  }
}

function normalizeScope(
  input: unknown,
  options: { allowPastExpiry?: boolean } = {}
): AgentScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('scope 必须是对象');
  }
  const body = input as Record<string, unknown>;
  const kind = body.kind;
  if (kind !== 'none' && kind !== 'library' && kind !== 'documents') {
    throw new Error('kind 必须是 none / library / documents');
  }
  const projectId =
    body.projectId == null
      ? null
      : typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim()
        : null;
  const rawIds = Array.isArray(body.documentIds) ? body.documentIds : [];
  if (rawIds.length > MAX_DOCUMENTS) throw new Error(`documentIds 最多 ${MAX_DOCUMENTS} 个`);
  if (!rawIds.every((id) => typeof id === 'string' && id.trim())) {
    throw new Error('documentIds 必须是非空字符串数组');
  }
  const documentIds = [...new Set(rawIds.map((id) => String(id).trim()))];
  if (kind === 'documents' && documentIds.length === 0) {
    throw new Error('kind=documents 时 documentIds 不能为空');
  }
  const page =
    body.page == null
      ? null
      : typeof body.page === 'number' && Number.isInteger(body.page) && body.page >= 1
        ? body.page
        : (() => {
            throw new Error('page 必须是正整数或 null');
          })();
  const selection = body.selection == null ? '' : body.selection;
  if (typeof selection !== 'string') throw new Error('selection 必须是字符串');
  if (selection.length > MAX_SELECTION) throw new Error(`selection 最多 ${MAX_SELECTION} 字`);
  const rawCaps = Array.isArray(body.caps) ? body.caps : [];
  if (!rawCaps.every((cap) => typeof cap === 'string' && ALLOWED_CAPS.has(cap))) {
    throw new Error('caps 只能包含 read / write / costly / files');
  }
  const caps = [...new Set(rawCaps.map(String))];
  const expiresAt =
    body.expiresAt == null
      ? null
      : typeof body.expiresAt === 'string'
        ? body.expiresAt
        : (() => {
            throw new Error('expiresAt 必须是 ISO 字符串或 null');
          })();
  if (expiresAt) {
    const time = Date.parse(expiresAt);
    if (!Number.isFinite(time)) throw new Error('expiresAt 不是合法时间');
    if (!options.allowPastExpiry && time <= Date.now()) throw new Error('expiresAt 必须晚于当前时间');
    if (time - Date.now() > MAX_TTL_MS) throw new Error('expiresAt 最多 8 小时');
  }
  return {
    kind: kind as AgentScopeKind,
    projectId,
    documentIds: kind === 'documents' ? documentIds : [],
    page: kind === 'none' ? null : page,
    selection: kind === 'none' ? '' : selection,
    caps: kind === 'none' ? [] : caps.length > 0 ? caps : ['read'],
    expiresAt: kind === 'none' ? null : expiresAt
  };
}

/** Agent 共享范围：单一活跃 scope，存 settings（随备份走、不新建表）。 */
export function registerAgentRoutes(app: FastifyInstance, options: { store: Store }): void {
  app.get(`${API_PREFIX}/agent/scope`, async () => readScope(options.store));

  app.put(`${API_PREFIX}/agent/scope`, async (request, reply) => {
    try {
      const scope = normalizeScope(request.body);
      options.store.updateSettings({ [SETTING_KEY]: JSON.stringify(scope) });
      return scope;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存共享范围失败');
    }
  });

  app.delete(`${API_PREFIX}/agent/scope`, async () => {
    options.store.deleteSettings([SETTING_KEY]);
    return defaultAgentScope();
  });
}
