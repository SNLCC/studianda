import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface LibraryRouteOptions {
  store: Store;
}

/** 文献列表、单层文件夹、逻辑项目（schema 22，文献分组）路由。从 server.ts 抽出。 */
export function registerLibraryRoutes(
  app: FastifyInstance,
  options: LibraryRouteOptions
): void {
    app.get(`${API_PREFIX}/documents`, async (request) => {
    const query = request.query as { trash?: string };
    return options.store.listDocuments(query.trash === 'true' || query.trash === '1');
  });

  // 单层文件夹 + 未分类（id='' 的虚拟集合）。删除文件夹只把文献移回未分类，不删文献。
  app.get(`${API_PREFIX}/folders`, async () => options.store.listFolders());

  app.post(`${API_PREFIX}/folders`, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string') return badRequest(reply, 'name 必须是字符串');
    try {
      return options.store.createFolder(body.name);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建文件夹失败');
    }
  });

  app.patch(`${API_PREFIX}/folders/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string') return badRequest(reply, 'name 必须是字符串');
    try {
      return options.store.renameFolder(id, body.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : '重命名文件夹失败';
      if (message === '文件夹不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  app.delete(`${API_PREFIX}/folders/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.deleteFolder(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '文件夹不存在');
    }
  });

  // 逻辑项目（schema_version 22）：不绑目录的文献分组，只存链接。
  // 默认列表不含归档项目；`?archived=true|1`（或 `?includeArchived=true|1`）可连归档一起列出。
  app.get(`${API_PREFIX}/projects`, async (request) => {
    const query = request.query as { archived?: string; includeArchived?: string };
    const includeArchived =
      query.archived === 'true' ||
      query.archived === '1' ||
      query.includeArchived === 'true' ||
      query.includeArchived === '1';
    return options.store.listProjects(includeArchived);
  });

  app.post(`${API_PREFIX}/projects`, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; description?: unknown };
    if (typeof body.name !== 'string') return badRequest(reply, 'name 必须是字符串');
    if (body.description !== undefined && typeof body.description !== 'string') {
      return badRequest(reply, 'description 必须是字符串');
    }
    try {
      return options.store.createProject({
        name: body.name,
        description: typeof body.description === 'string' ? body.description : undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建项目失败');
    }
  });

  app.patch(`${API_PREFIX}/projects/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      archived?: unknown;
    };
    if (body.name !== undefined && typeof body.name !== 'string') {
      return badRequest(reply, 'name 必须是字符串');
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      return badRequest(reply, 'description 必须是字符串');
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') {
      return badRequest(reply, 'archived 必须是布尔值');
    }
    if (body.name === undefined && body.description === undefined && body.archived === undefined) {
      return badRequest(reply, '需要至少一个可更新字段（name/description/archived）');
    }
    try {
      return options.store.updateProject(id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新项目失败';
      if (message === '项目不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  app.delete(`${API_PREFIX}/projects/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.deleteProject(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '项目不存在');
    }
  });

  app.get(`${API_PREFIX}/projects/:id/documents`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.listProjectDocuments(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '项目不存在');
    }
  });

  app.post(`${API_PREFIX}/projects/:id/documents`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { documentId?: unknown };
    if (typeof body.documentId !== 'string' || !body.documentId.trim()) {
      return badRequest(reply, 'documentId 必须是字符串');
    }
    try {
      return options.store.addProjectDocument(id, body.documentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '加入项目失败';
      if (message === '项目不存在' || message === '文档不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  app.delete(`${API_PREFIX}/projects/:id/documents/:documentId`, async (request, reply) => {
    const { id, documentId } = request.params as { id: string; documentId: string };
    try {
      options.store.removeProjectDocument(id, documentId);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '移出项目失败';
      return notFound(reply, message);
    }
  });
}
