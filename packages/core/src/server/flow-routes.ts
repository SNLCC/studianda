import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  API_PREFIX,
  type FlowDeleteResult,
  type FlowDetailRecord,
  type FlowListResponse
} from '@studianda/shared';
import {
  FlowWriteError,
  createFlow,
  deleteFlow,
  flowDetail,
  flowListResponse,
  updateFlow,
  type FlowWriteInput
} from '../flows.js';
import { badRequest, notFound } from './http.js';

/**
 * L1 阅读流程的读写路由（文件系统为唯一存储，不落库）。
 *
 * - `GET /flows` 只读清单（元数据 + 被跳过原因，不含正文）；
 * - `GET /flows/:id` 详情（含完整正文，供 Markdown 编辑器打开）；
 * - `POST /flows` 新建（name + markdown，id 由名称派生）；
 * - `PUT /flows/:id` 更新 name / markdown / enabled 的任意组合；
 * - `DELETE /flows/:id` 删除流程目录。
 *
 * 所有写入口都在 `flows.ts` 里统一复用既有校验（id 规则、路径穿越/符号链接防护、8000 字符上限、
 * 空值、sha256 由服务端重算、拒绝 scripts），失败时把其中文错误原样返回给界面。
 */
export function registerFlowRoutes(
  app: FastifyInstance,
  options: { dataDir: string }
): void {
  const { dataDir } = options;

  app.get(`${API_PREFIX}/flows`, async (): Promise<FlowListResponse> => flowListResponse(dataDir));

  app.get(`${API_PREFIX}/flows/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return flowDetail(dataDir, id);
    } catch (error) {
      return flowErrorReply(reply, error);
    }
  });

  app.post(`${API_PREFIX}/flows`, async (request, reply) => {
    const body = request.body;
    try {
      const flow = createFlow(dataDir, body as FlowWriteInput);
      return reply.code(201).send(flow satisfies FlowDetailRecord);
    } catch (error) {
      return flowErrorReply(reply, error);
    }
  });

  app.put(`${API_PREFIX}/flows/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body;
    try {
      const flow = updateFlow(dataDir, id, body as FlowWriteInput);
      return flow satisfies FlowDetailRecord;
    } catch (error) {
      return flowErrorReply(reply, error);
    }
  });

  app.delete(`${API_PREFIX}/flows/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return deleteFlow(dataDir, id) satisfies FlowDeleteResult;
    } catch (error) {
      return flowErrorReply(reply, error);
    }
  });
}

/** 把写入/读取错误映射成中文 400/404；未知异常不把底层堆栈泄漏给界面。 */
function flowErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FlowWriteError) {
    if (error.kind === 'not_found') return notFound(reply, error.message);
    return badRequest(reply, error.message);
  }
  console.error('[flows] operation failed:', error instanceof Error ? error.message : String(error));
  return badRequest(reply, '流程操作失败，请检查资料目录的读写权限');
}
