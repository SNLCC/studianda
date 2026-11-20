import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import { applyChanges, previewChanges, undoChanges } from '../agent-changes.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

/** Agent 可撤销写操作：preview（dry-run）/ apply（事务 + 审计）/ undo（按 before 恢复）。 */
export function registerAgentChangesRoutes(
  app: FastifyInstance,
  options: { store: Store }
): void {
  app.post(`${API_PREFIX}/agent/changes/preview`, async (request, reply) => {
    try {
      return previewChanges(options.store, request.body);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '预览变更失败');
    }
  });

  app.post(`${API_PREFIX}/agent/changes/apply`, async (request, reply) => {
    const body = (request.body ?? {}) as { agentName?: unknown };
    const agentName =
      typeof body.agentName === 'string' && body.agentName.trim()
        ? body.agentName.trim().slice(0, 80)
        : 'agent';
    try {
      return applyChanges(options.store, request.body, agentName);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '应用变更失败');
    }
  });

  app.post(`${API_PREFIX}/agent/changes/undo`, async (request, reply) => {
    const body = (request.body ?? {}) as { operationId?: unknown };
    if (typeof body.operationId !== 'string' || !body.operationId.trim()) {
      return badRequest(reply, '需要 operationId');
    }
    try {
      return undoChanges(options.store, body.operationId.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : '撤销变更失败';
      if (message === '变更记录不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });
}
