import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface NotesRouteOptions {
  store: Store;
}

/** 独立笔记（不含文献）：CRUD/回收站/批量排序删除移动/虚拟文件夹/标签。从 server.ts 抽出。 */
export function registerNotesRoutes(app: FastifyInstance, options: NotesRouteOptions): void {
  // 独立笔记（不属于任何文献）：document_id=''。
  app.get(`${API_PREFIX}/notes/standalone`, async (request) => {
    const query = request.query as { trash?: string };
    return options.store.listStandaloneNotes(
      query.trash === 'true' || query.trash === '1'
    );
  });

  app.post(`${API_PREFIX}/notes`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      documentId?: unknown;
      page?: unknown;
      quote?: unknown;
      content?: unknown;
      externalKey?: unknown;
      origin?: unknown;
    };
    if (body.documentId != null && typeof body.documentId !== 'string') {
      return badRequest(reply, 'documentId 必须是字符串');
    }
    // 内容来源：「回答存为笔记」等系统代写 AI 内容的路径必须显式传 'ai'；
    // 用户手工新建不传（落库 'user'）。只接受这两个值，避免拼写错误把 AI 内容误标成用户内容。
    if (body.origin !== undefined && body.origin !== 'user' && body.origin !== 'ai') {
      return badRequest(reply, 'origin 必须是 user 或 ai');
    }
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
    const pageValue = body.page == null ? 0 : body.page;
    if (typeof pageValue !== 'number' || !Number.isInteger(pageValue)) {
      return badRequest(reply, 'page 必须是整数');
    }
    // 独立笔记没有页码；带上非 0 页码视为参数错误。
    if (!documentId && pageValue !== 0) {
      return badRequest(reply, '独立笔记的 page 必须为 0');
    }
    try {
      return options.store.createNote({
        documentId,
        page: pageValue,
        quote: typeof body.quote === 'string' ? body.quote : '',
        content: typeof body.content === 'string' ? body.content : '',
        // 外部稳定标识（例如「回答存为笔记」的 chat-answer:...）：同 key 重复保存返回已有笔记。
        externalKey: typeof body.externalKey === 'string' ? body.externalKey : undefined,
        origin: body.origin as 'user' | 'ai' | undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存笔记失败');
    }
  });

  app.patch(`${API_PREFIX}/notes/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      page?: unknown;
      quote?: unknown;
      content?: unknown;
      folderPath?: unknown;
    };
    try {
      return options.store.updateNote(id, {
        page:
          typeof body.page === 'number' && Number.isInteger(body.page) ? body.page : undefined,
        quote: typeof body.quote === 'string' ? body.quote : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        folderPath: typeof body.folderPath === 'string' ? body.folderPath : undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '更新笔记失败');
    }
  });

  app.delete(`${API_PREFIX}/notes/:id/purge`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.purgeNote(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '笔记不存在');
    }
  });

  app.delete(`${API_PREFIX}/notes/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.deleteNote(id);
      return reply.code(204).send();
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '笔记不存在');
    }
  });

  app.post(`${API_PREFIX}/notes/:id/restore`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.restoreNote(id);
      return { ok: true };
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '笔记不存在');
    }
  });

  // ---- 独立笔记批量操作（拖拽排序 / 批量删除 / 批量移动） ----
  app.post(`${API_PREFIX}/notes/reorder`, async (request, reply) => {
    const body = (request.body ?? {}) as { folderPath?: unknown; ids?: unknown };
    if (typeof body.folderPath !== 'string') return badRequest(reply, '需要文件夹路径');
    if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) {
      return badRequest(reply, 'ids 必须是字符串数组');
    }
    try {
      return options.store.reorderStandaloneNotes(body.folderPath, body.ids as string[]);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '笔记排序失败');
    }
  });

  app.post(`${API_PREFIX}/notes/batch-delete`, async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) {
      return badRequest(reply, 'ids 必须是字符串数组');
    }
    try {
      return options.store.batchDeleteStandaloneNotes(body.ids as string[]);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '批量删除笔记失败');
    }
  });

  app.post(`${API_PREFIX}/notes/batch-move`, async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown; folderPath?: unknown };
    if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) {
      return badRequest(reply, 'ids 必须是字符串数组');
    }
    if (typeof body.folderPath !== 'string') return badRequest(reply, '需要文件夹路径');
    try {
      return options.store.batchMoveStandaloneNotes(body.ids as string[], body.folderPath);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '批量移动笔记失败');
    }
  });

  // ---- 笔记虚拟文件夹 ----
  app.get(`${API_PREFIX}/notes/folders`, async () => options.store.listNoteFolders());

  app.post(`${API_PREFIX}/notes/folders`, async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown };
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return badRequest(reply, '需要文件夹路径');
    }
    try {
      return options.store.createNoteFolder(body.path);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建文件夹失败');
    }
  });

  app.post(`${API_PREFIX}/notes/folders/rename`, async (request, reply) => {
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown };
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      return badRequest(reply, '需要原路径与目标路径');
    }
    try {
      return options.store.renameNoteFolder(body.from, body.to);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重命名文件夹失败');
    }
  });

  app.delete(`${API_PREFIX}/notes/folders`, async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path || !query.path.trim()) return badRequest(reply, '需要文件夹路径');
    try {
      return options.store.deleteNoteFolder(query.path);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除文件夹失败');
    }
  });

  app.patch(`${API_PREFIX}/notes/:id/folder`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { folderPath?: unknown };
    if (typeof body.folderPath !== 'string') return badRequest(reply, '需要文件夹路径');
    try {
      return options.store.moveNoteToFolder(id, body.folderPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '移动笔记失败';
      if (message === '笔记不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  // ---- 笔记标签 ----
  app.get(`${API_PREFIX}/notes/tags`, async () => options.store.listNoteTags());

  app.put(`${API_PREFIX}/notes/:id/tags`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { tags?: unknown };
    if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string')) {
      return badRequest(reply, '标签必须是字符串数组');
    }
    try {
      return options.store.setNoteTags(id, body.tags as string[]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '设置标签失败';
      if (message === '笔记不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });
}

/** 单篇文献的笔记清单（`GET /documents/:id/notes`），与独立笔记路由同属笔记域。 */
export function registerDocumentNotesRoute(app: FastifyInstance, options: NotesRouteOptions): void {
  app.get(`${API_PREFIX}/documents/:id/notes`, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { trash?: string };
    return options.store.listNotes(id, query.trash === 'true' || query.trash === '1');
  });
}
