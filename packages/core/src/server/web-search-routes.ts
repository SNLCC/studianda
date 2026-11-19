import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES, API_PREFIX } from '@studianda/shared';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import {
  createSearchPlan,
  getSearchConfig,
  saveSearchConfig,
  searchWeb
} from '../web-search.js';
import { badRequest } from './http.js';

export interface WebSearchRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** 联网搜索配置、搜索计划（审批凭证）与直接搜索。从 server.ts 抽出。 */
export function registerWebSearchRoutes(app: FastifyInstance, options: WebSearchRouteOptions): void {
  app.get(`${API_PREFIX}/web-search/config`, async () =>
    getSearchConfig(options.store, options.secrets)
  );

  app.put(`${API_PREFIX}/web-search/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return saveSearchConfig(options.store, options.secrets, {
        provider: body.provider as never,
        base_url: typeof body.base_url === 'string' ? body.base_url : undefined,
        connection_id:
          typeof body.connection_id === 'string' ? body.connection_id : undefined,
        permission: body.permission as never,
        followup: typeof body.followup === 'boolean' ? body.followup : undefined,
        planner: typeof body.planner === 'boolean' ? body.planner : undefined,
        privacy_mode:
          body.privacy_mode === 'keywords-only' ||
          body.privacy_mode === 'question' ||
          body.privacy_mode === 'scope'
            ? body.privacy_mode
            : undefined,
        allow_question:
          typeof body.allow_question === 'boolean' ? body.allow_question : undefined,
        allow_history: typeof body.allow_history === 'boolean' ? body.allow_history : undefined,
        allow_selection:
          typeof body.allow_selection === 'boolean' ? body.allow_selection : undefined,
        allow_notes: typeof body.allow_notes === 'boolean' ? body.allow_notes : undefined,
        allow_annotations:
          typeof body.allow_annotations === 'boolean' ? body.allow_annotations : undefined,
        allow_answer: typeof body.allow_answer === 'boolean' ? body.allow_answer : undefined,
        allow_document: typeof body.allow_document === 'boolean' ? body.allow_document : undefined,
        allow_current_page:
          typeof body.allow_current_page === 'boolean' ? body.allow_current_page : undefined,
        allow_surrounding:
          typeof body.allow_surrounding === 'boolean' ? body.allow_surrounding : undefined,
        allow_title: typeof body.allow_title === 'boolean' ? body.allow_title : undefined,
        api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
        clear_key: body.clear_key === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存搜索配置失败');
    }
  });

  app.post(`${API_PREFIX}/web-search/search`, async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown };
    if (typeof body.query !== 'string' || !body.query.trim()) {
      return badRequest(reply, '需要 query');
    }
    try {
      return await searchWeb(options.store, options.secrets, body.query.trim());
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '联网搜索失败');
    }
  });

  // 搜索计划（审批凭证）：先给出脱敏后的公共搜索词与 warning，review 模式下由用户确认后
  // 再把 token + confirmSearch 带进 /chat/ask。
  app.post(`${API_PREFIX}/search-plan`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return badRequest(reply, '需要 question');
    }
    try {
      return await createSearchPlan(options.store, options.secrets, {
        question: body.question,
        documentId: typeof body.documentId === 'string' ? body.documentId : undefined,
        selection: typeof body.selection === 'string' ? body.selection : undefined,
        history: Array.isArray(body.history) ? (body.history as never) : undefined,
        gap_claim: typeof body.gap_claim === 'string' ? body.gap_claim : undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索计划生成失败';
      if (message.includes('允许联网搜索')) {
        return reply.code(403).send({ error: API_ERROR_CODES.forbidden, message });
      }
      if (message.includes('搜索规划失败')) {
        return reply.code(502).send({ error: API_ERROR_CODES.badGateway, message });
      }
      return badRequest(reply, message);
    }
  });
}
