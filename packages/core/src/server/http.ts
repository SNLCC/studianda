import type { FastifyReply } from 'fastify';
import { API_ERROR_CODES } from '@studianda/shared';
import type { DuplicateImportError } from '../store.js';

/** HTTP 错误响应统一出口（server 各路由共用）。 */
export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: API_ERROR_CODES.badRequest, message });
}

export function notFound(reply: FastifyReply, message = '资源不存在'): FastifyReply {
  return reply.code(404).send({ error: API_ERROR_CODES.notFound, message });
}

export function duplicateReply(reply: FastifyReply, error: DuplicateImportError): FastifyReply {
  const names = error.candidates.map((candidate) => candidate.name).slice(0, 3).join('；');
  return reply.code(409).send({
    error: API_ERROR_CODES.duplicateRequired,
    message: `文献库中已有相同或高度相似的文献：${names}`,
    details: {
      candidates: error.candidates,
      canOverride: error.canOverride
    }
  });
}
