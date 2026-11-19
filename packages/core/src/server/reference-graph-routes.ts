import type { FastifyInstance } from 'fastify';
import { API_PREFIX, type ReferenceNodeKind } from '@studianda/shared';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';
import { sendJsonMaybeGzip } from './json-response.js';

export interface ReferenceGraphRouteOptions {
  store: Store;
}

/** 全库引用关系图与反向链接（`[[…]]` 引用域）。从 server.ts 抽出。 */
export function registerReferenceGraphRoutes(app: FastifyInstance, options: ReferenceGraphRouteOptions): void {
  // 全库引用关系图：文献/笔记/批注节点 + `[[…]]` 引用边。
  // all=1 为全量模式（一次返回全部节点/边，超硬上限才退回分页）；旧 limit/offset 分页参数保留兼容。
  app.get(`${API_PREFIX}/reference-graph`, async (request, reply) => {
    const query = request.query as {
      limit?: string;
      offset?: string;
      kinds?: string;
      search?: string;
      all?: string;
    };
    const paging: {
      limit?: number;
      offset?: number;
      kinds?: ReferenceNodeKind[];
      search?: string;
      all?: boolean;
    } = {};
    // 全量模式开关：all=1/true（或 0/false 显式关闭）；非法值 400。
    if (query.all !== undefined) {
      const raw = query.all.trim().toLowerCase();
      if (raw === '1' || raw === 'true') paging.all = true;
      else if (raw === '0' || raw === 'false') paging.all = false;
      else return badRequest(reply, 'all 必须是 1/0 或 true/false');
    }
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit.trim())) {
        return badRequest(reply, 'limit 必须是 1..500 的整数');
      }
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return badRequest(reply, 'limit 必须是 1..500 的整数');
      }
      paging.limit = limit;
    }
    if (query.offset !== undefined) {
      if (!/^\d+$/.test(query.offset.trim())) {
        return badRequest(reply, 'offset 必须是非负整数');
      }
      const offset = Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        return badRequest(reply, 'offset 必须是非负整数');
      }
      paging.offset = offset;
    }
    // 可选类型过滤（document,note,annotation 逗号分隔）：先过滤再分页，totalNodes 为过滤后总数。
    if (query.kinds !== undefined) {
      const kinds = query.kinds
        .split(',')
        .map((kind) => kind.trim())
        .filter((kind) => kind.length > 0);
      if (
        kinds.length === 0 ||
        kinds.some((kind) => kind !== 'document' && kind !== 'note' && kind !== 'annotation')
      ) {
        return badRequest(reply, 'kinds 必须是 document/note/annotation（逗号分隔）');
      }
      paging.kinds = [...new Set(kinds)] as ReferenceNodeKind[];
    }
    // 可选节点名关键字过滤（不区分大小写子串）：同样发生在分页之前。
    if (query.search !== undefined) {
      const search = query.search.trim();
      if (search.length > 100) return badRequest(reply, 'search 最多 100 个字符');
      if (search) paging.search = search;
    }
    try {
      // 全量图可能包含数千节点，统一交给带 gzip 的 JSON 响应（客户端没带 Accept-Encoding 时退回普通 JSON）。
      return await sendJsonMaybeGzip(request, reply, options.store.getReferenceGraph(paging));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取关系图失败');
    }
  });

  // 反向链接：哪些笔记/批注引用了指定笔记/批注/文献。
  app.get(`${API_PREFIX}/backlinks`, async (request, reply) => {
    const query = request.query as { kind?: string; documentId?: string; id?: string };
    const kind = (query.kind ?? '').trim();
    if (kind !== 'note' && kind !== 'annotation' && kind !== 'document') {
      return badRequest(reply, 'kind 必须是 note/annotation/document');
    }
    const documentId = (query.documentId ?? '').trim();
    // 独立笔记目标：kind=note 且 documentId 为空串，不做文献存在性检查（404 会误报）。
    const standaloneNoteTarget = kind === 'note' && !documentId;
    if (!documentId && !standaloneNoteTarget) return badRequest(reply, '需要 documentId');
    const id = (query.id ?? '').trim();
    if (kind !== 'document' && !id) return badRequest(reply, '需要 id');
    if (!standaloneNoteTarget && !options.store.getDocument(documentId)) {
      return notFound(reply, '文献不存在');
    }
    return options.store.listBacklinks({ kind, documentId, id: id || undefined });
  });
}
