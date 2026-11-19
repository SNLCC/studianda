import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES, API_PREFIX } from '@studianda/shared';
import type { Store } from '../store.js';
import { stopDocumentTranslation } from '../translation-service.js';
import { badRequest, notFound } from './http.js';

export interface DocumentManageRouteOptions {
  store: Store;
  /** 彻底删除前取消该文献进行中的请求（进程内登记表由 server.ts 维护）。 */
  abortDocumentRequests: (documentId: string) => void;
}

/** 文献元数据更新/排序/回收站/彻底删除/标签/作者/重新连接。从 server.ts 抽出。 */
export function registerDocumentManageRoutes(app: FastifyInstance, options: DocumentManageRouteOptions): void {
  const { abortDocumentRequests } = options;
  app.patch(`${API_PREFIX}/documents/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      currentPage?: unknown;
      name?: unknown;
      author?: unknown;
      docType?: unknown;
      folderId?: unknown;
    };
    try {
      const document = options.store.updateDocument(id, {
        currentPage:
          typeof body.currentPage === 'number' && Number.isFinite(body.currentPage)
            ? body.currentPage
            : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        author: typeof body.author === 'string' ? body.author : undefined,
        // 文献类型（Zotero itemType 原文，'' = 未分类）与文件夹归属（'' = 未分类）。
        docType: typeof body.docType === 'string' ? body.docType : undefined,
        folderId: typeof body.folderId === 'string' ? body.folderId : undefined
      });
      return document ?? notFound(reply, '文档不存在');
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '更新失败');
    }
  });

  // 默认排序拖拽：把文献移动到 beforeId 与 afterId 之间（null 表示最前/最后）。
  app.post(`${API_PREFIX}/documents/:id/move`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { beforeId?: unknown; afterId?: unknown };
    if (body.beforeId != null && typeof body.beforeId !== 'string') {
      return badRequest(reply, 'beforeId 必须是字符串或 null');
    }
    if (body.afterId != null && typeof body.afterId !== 'string') {
      return badRequest(reply, 'afterId 必须是字符串或 null');
    }
    try {
      return options.store.moveDocument(id, {
        beforeId: (body.beforeId as string | null | undefined) ?? null,
        afterId: (body.afterId as string | null | undefined) ?? null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '移动文献失败';
      if (message === '文献不存在' || message === '相邻文献不存在') {
        return notFound(reply, message);
      }
      return badRequest(reply, message);
    }
  });

  app.delete(`${API_PREFIX}/documents/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.deleteDocument(id);
      return { ok: true };
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '文档不存在');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/restore`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.restoreDocument(id);
      return { ok: true };
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '文档不存在');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/purge`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { confirmName?: unknown };
    if (typeof body.confirmName !== 'string') return badRequest(reply, '需要确认文献名称');
    try {
      // 彻底删除是破坏性操作：先停掉这份文献上正在进行的阅读/翻译请求，
      // 否则后台任务会继续写已删除的数据，并在控制台抛出“文档不存在”。
      abortDocumentRequests(id);
      stopDocumentTranslation(id);
      options.store.purgeDocument(id, body.confirmName);
      return { ok: true };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '彻底删除失败');
    }
  });

  app.put(`${API_PREFIX}/documents/:id/tags`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { tags?: unknown };
    if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string')) {
      return badRequest(reply, 'tags 必须是字符串数组');
    }
    try {
      const tags = options.store.setDocumentTags(id, body.tags as string[]);
      return { ok: true, tags };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存标签失败');
    }
  });

  app.put(`${API_PREFIX}/documents/:id/author`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { author?: unknown };
    if (typeof body.author !== 'string') return badRequest(reply, 'author 必须是字符串');
    const document = options.store.updateDocument(id, { author: body.author });
    return document ?? notFound(reply, '文档不存在');
  });

  app.post(`${API_PREFIX}/documents/:id/relink`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    const isMultipart = contentType.includes('multipart/form-data');
    let sourcePath: string | null = null;
    let temporaryPath: string | null = null;
    let confirmLarge = false;

    const removeTemporary = (): void => {
      if (!temporaryPath) return;
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 临时文件已被清理
      }
      temporaryPath = null;
    };

    if (isMultipart) {
      let upload;
      try {
        upload = await request.file();
      } catch {
        return badRequest(reply, '需要 multipart 文件上传');
      }
      if (!upload) return badRequest(reply, '缺少 PDF 文件');
      const tempDir = path.join(options.store.dataDir, 'imports');
      mkdirSync(tempDir, { recursive: true });
      temporaryPath = path.join(tempDir, `${randomUUID()}.pdf`);
      try {
        await pipeline(upload.file, createWriteStream(temporaryPath));
      } catch (error) {
        removeTemporary();
        return badRequest(reply, error instanceof Error ? error.message : '上传失败');
      }
      sourcePath = temporaryPath;
      confirmLarge = request.headers['x-studianda-confirm-large'] === 'true';
    } else {
      const body = request.body as { path?: unknown; confirmLarge?: unknown } | null;
      if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
        return badRequest(reply, '需要文件路径');
      }
      sourcePath = body.path;
      confirmLarge = body.confirmLarge === true;
    }

    if (!sourcePath) return badRequest(reply, '需要文件路径');
    const resolvedSourcePath = sourcePath;
    const warningThreshold = Number(process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024);
    try {
      const stats = statSync(resolvedSourcePath);
      if (!confirmLarge && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续重新连接会增加解析时间，后续问答/翻译/OCR 可能消耗更多 token 并变慢。' +
            '确认后仍会重新连接并重建索引。',
          details: { sizeBytes: stats.size, thresholdBytes: warningThreshold }
        });
      }
      return await options.store.relinkDocument(id, resolvedSourcePath);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重新连接失败');
    } finally {
      removeTemporary();
    }
  });
}
