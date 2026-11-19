import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import {
  ChatBudgetError,
  type ChatBudgetPolicy,
  type ChatBudgetRequest
} from '../chat-budget-policy.js';
import { badRequest, notFound } from './http.js';

export interface ChatBudgetRouteOptions {
  /** 无状态预算策略（每 server 实例一个，由 `buildServer` 创建后注入）。 */
  budget: ChatBudgetPolicy;
}

/**
 * 预算估算路由（1 条）：`POST /chat/budget`。从 `server.ts` 抽出。
 *
 * 纯估算：只读本地索引/目录，**不调用模型、不写库**；估算逻辑与校验都在
 * `../chat-budget-policy.js` 的 `estimate()` 里，本模块只做 transport 映射。
 *
 * 错误语义（与 ask 的预算闸门**不同，不要统一**）：
 * - 闸门估算失败 → 返回 `null`，不阻断提问；
 * - 本路由估算失败 → `ChatBudgetError` → **400**（项目不存在 → 404，与拆分前一致）。
 *   非预算域的意外错误不在这里改写状态码，直接抛出交给 Fastify 错误处理器（拆分前也是 500）。
 */
export function registerChatBudgetRoutes(
  app: FastifyInstance,
  options: ChatBudgetRouteOptions
): void {
  app.post(`${API_PREFIX}/chat/budget`, async (request, reply) => {
    const body = (request.body ?? {}) as ChatBudgetRequest;
    try {
      return await options.budget.estimate(body);
    } catch (error) {
      if (error instanceof ChatBudgetError) {
        return error.status === 404
          ? notFound(reply, error.message)
          : badRequest(reply, error.message);
      }
      throw error;
    }
  });
}
