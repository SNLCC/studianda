import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { API_PREFIX, type AgentJobStatus } from '@studianda/shared';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

const MAX_RUNNING = 4;
const TERMINAL = new Set<AgentJobStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'needs_confirmation'
]);

function ownerOf(body: unknown): string {
  const value = (body as { agentName?: unknown } | null)?.agentName;
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function snapshot(store: Store, id: string): unknown {
  const job = store.getAgentJob(id);
  if (!job) return null;
  return {
    id: job.id,
    agentName: job.agentName,
    kind: job.kind,
    status: job.status,
    created: job.created,
    updated: job.updated,
    finishedAt: job.finishedAt,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {})
  };
}

/** Agent 长任务持久化：bridge 执行、Core 落状态，DSH/bridge 重启后结果仍可查。 */
export function registerAgentJobsRoutes(
  app: FastifyInstance,
  options: { store: Store }
): void {
  app.post(`${API_PREFIX}/agent/jobs`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      kind?: unknown;
      documentId?: unknown;
      question?: unknown;
      page?: unknown;
      selection?: unknown;
      chat_session_id?: unknown;
      pages?: unknown;
      force?: unknown;
      scale?: unknown;
      project_id?: unknown;
      document_ids?: unknown;
      include_memory?: unknown;
      agentName?: unknown;
    };
    if (body.kind !== 'ask' && body.kind !== 'ocr' && body.kind !== 'corpus_ask') {
      return badRequest(reply, '当前只支持 kind=ask / ocr / corpus_ask');
    }
    if (typeof body.documentId !== 'string' || !body.documentId.trim()) {
      return badRequest(reply, '需要 documentId');
    }
    if (
      (body.kind === 'ask' || body.kind === 'corpus_ask') &&
      (typeof body.question !== 'string' || !body.question.trim())
    ) {
      return badRequest(reply, '需要 question');
    }
    if (body.kind === 'corpus_ask') {
      if (
        typeof body.project_id !== 'string' &&
        (!Array.isArray(body.document_ids) ||
          body.document_ids.length === 0 ||
          !body.document_ids.every((id) => typeof id === 'string' && id.trim()))
      ) {
        return badRequest(reply, 'corpus_ask 需要 project_id 或 document_ids');
      }
    }
    if (body.kind === 'ocr' && body.pages !== undefined) {
      if (
        !Array.isArray(body.pages) ||
        !body.pages.every((page) => Number.isInteger(page) && Number(page) >= 1)
      ) {
        return badRequest(reply, 'pages 必须是正整数数组');
      }
    }
    if (
      typeof body.question === 'string' &&
      body.question.length > 4000
    ) {
      return badRequest(reply, 'question 最多 4000 字');
    }
    if (!options.store.getDocument(body.documentId)) return notFound(reply, '文档不存在');
    const agentName = ownerOf(body);
    if (options.store.countRunningAgentJobs(agentName) >= MAX_RUNNING) {
      return badRequest(reply, `同时最多 ${MAX_RUNNING} 个任务`);
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    options.store.createAgentJob({
      id,
      agentName,
      kind: body.kind,
      requestJson: JSON.stringify({
        documentId: body.documentId,
        ...(typeof body.question === 'string' ? { question: body.question } : {}),
        ...(typeof body.page === 'number' ? { page: body.page } : {}),
        ...(typeof body.selection === 'string' ? { selection: body.selection } : {}),
        ...(typeof body.chat_session_id === 'string'
          ? { chat_session_id: body.chat_session_id }
          : {}),
        ...(Array.isArray(body.pages) ? { pages: body.pages } : {}),
        ...(body.force === true ? { force: true } : {}),
        ...(typeof body.scale === 'number' ? { scale: body.scale } : {}),
        ...(typeof body.project_id === 'string' ? { project_id: body.project_id } : {}),
        ...(Array.isArray(body.document_ids) ? { document_ids: body.document_ids } : {}),
        ...(body.include_memory === true ? { include_memory: true } : {})
      }),
      created: now
    });
    return snapshot(options.store, id);
  });

  app.get(`${API_PREFIX}/agent/jobs`, async (request) => {
    const query = request.query as { agent?: string; limit?: string };
    const limit = Number(query.limit ?? 20);
    return options.store.listAgentJobs(
      (query.agent ?? '').trim().slice(0, 80),
      Number.isFinite(limit) ? limit : 20
    );
  });

  app.get(`${API_PREFIX}/agent/jobs/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { agent?: string };
    const job = options.store.getAgentJob(id);
    if (!job) return notFound(reply, '任务不存在');
    if (job.agentName !== (query.agent ?? '').trim().slice(0, 80)) {
      return notFound(reply, '任务不存在');
    }
    return snapshot(options.store, id);
  });

  app.post(`${API_PREFIX}/agent/jobs/:id/finish`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      agentName?: unknown;
      status?: unknown;
      result?: unknown;
      error?: unknown;
    };
    const job = options.store.getAgentJob(id);
    if (!job) return notFound(reply, '任务不存在');
    if (job.agentName !== ownerOf(body)) return notFound(reply, '任务不存在');
    if (typeof body.status !== 'string' || !TERMINAL.has(body.status as AgentJobStatus)) {
      return badRequest(reply, 'status 不合法');
    }
    const updated = new Date().toISOString();
    options.store.updateAgentJob(id, {
      status: body.status,
      ...(body.result !== undefined ? { resultJson: JSON.stringify(body.result) } : {}),
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
      updated
    });
    return snapshot(options.store, id);
  });

  app.post(`${API_PREFIX}/agent/jobs/:id/cancel`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { agentName?: unknown };
    const job = options.store.getAgentJob(id);
    if (!job) return notFound(reply, '任务不存在');
    if (job.agentName !== ownerOf(body)) return notFound(reply, '任务不存在');
    if (job.status === 'running') {
      options.store.updateAgentJob(id, {
        status: 'cancelled',
        updated: new Date().toISOString()
      });
    }
    return snapshot(options.store, id);
  });
}
