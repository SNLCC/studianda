import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES, API_PREFIX, type ImportJobRecord } from '@studianda/shared';
import { DuplicateImportError, ImportCancelledError, type Store } from '../store.js';
import { badRequest, duplicateReply, notFound } from './http.js';

export interface DocumentImportRouteOptions {
  store: Store;
}

/** 文献上传与导入任务（同步/后台 job）。从 server.ts 抽出。 */
export function registerDocumentImportRoutes(app: FastifyInstance, options: DocumentImportRouteOptions): void {
  // 导入任务（进程内、按 Core 实例隔离）：解析 PDF 在后台跑，前端轮询状态并可请求取消。
  const importJobs = new Map<string, ImportJobRecord>();
  // 文献上传：multipart/form-data。
  app.post(`${API_PREFIX}/documents`, async (request, reply) => {
    let upload;
    try {
      upload = await request.file();
    } catch {
      return badRequest(reply, '需要 multipart 文件上传');
    }
    if (!upload) return badRequest(reply, '缺少 PDF 文件');

    const tempDir = path.join(options.store.dataDir, 'imports');
    mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${randomUUID()}.pdf`);
    try {
      await pipeline(upload.file, createWriteStream(tempPath));
      const stats = statSync(tempPath);
      const warningThreshold = Number(
        process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024
      );
      const confirmed = request.headers['x-studianda-confirm-large'] === 'true';
      if (!confirmed && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续导入会增加解析时间；后续问答、翻译或 OCR 可能消耗更多 token、占用更多内存并变慢。确认后仍会导入。',
          details: { sizeBytes: stats.size, thresholdBytes: warningThreshold }
        });
      }
      const safeName =
        path.basename(upload.filename || '未命名.pdf').replace(/[\\/]/g, '') || '未命名.pdf';
      const confirmDuplicate = request.headers['x-studianda-confirm-duplicate'] === 'true';
      const document = await options.store.importDocument(tempPath, safeName, confirmDuplicate);
      return { ...document, chunks: options.store.listChunks(document.id).length };
    } catch (error) {
      if (error instanceof DuplicateImportError) return duplicateReply(reply, error);
      return badRequest(reply, error instanceof Error ? error.message : '上传失败');
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // 临时文件已清理
      }
    }
  });

  app.post(`${API_PREFIX}/documents/import`, async (request, reply) => {
    const body = request.body as {
      path?: unknown;
      confirmLarge?: unknown;
      confirmDuplicate?: unknown;
    } | null;
    if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
      return badRequest(reply, '需要文件路径');
    }
    const warningThreshold = Number(process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024);
    try {
      const stats = statSync(body.path);
      if (!body.confirmLarge && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续导入会增加解析时间；后续问答、翻译或 OCR 可能消耗更多 token、占用更多内存并变慢。' +
            '这不是硬性拒绝，确认后仍会导入。',
          details: {
            sizeBytes: stats.size,
            thresholdBytes: warningThreshold
          }
        });
      }
      return await options.store.importDocument(
        body.path,
        undefined,
        body.confirmDuplicate === true
      );
    } catch (error) {
      if (error instanceof DuplicateImportError) return duplicateReply(reply, error);
      return badRequest(reply, error instanceof Error ? error.message : '导入失败');
    }
  });

  // 导入任务：解析在后台跑，返回 jobId；前端轮询 /documents/import/jobs/:id 显示进度并可取消。
  // 同时接受 JSON（本机路径，桌面壳）与 multipart（浏览器/DSH 上传）两种来源。
  app.post(`${API_PREFIX}/documents/import/start`, async (request, reply) => {
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    const isMultipart = contentType.includes('multipart/form-data');
    let sourcePath: string | null = null;
    let sourceName: string | undefined;
    let temporaryPath: string | null = null;
    let confirmLarge = false;
    let confirmDuplicate = false;

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
      sourceName =
        path.basename(upload.filename || '未命名.pdf').replace(/[\\/]/g, '') || '未命名.pdf';
      confirmLarge = request.headers['x-studianda-confirm-large'] === 'true';
      confirmDuplicate = request.headers['x-studianda-confirm-duplicate'] === 'true';
    } else {
      const body = request.body as {
        path?: unknown;
        confirmLarge?: unknown;
        confirmDuplicate?: unknown;
      } | null;
      if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
        return badRequest(reply, '需要文件路径');
      }
      sourcePath = body.path;
      confirmLarge = body.confirmLarge === true;
      confirmDuplicate = body.confirmDuplicate === true;
    }

    if (!sourcePath) return badRequest(reply, '需要文件路径');
    const resolvedSourcePath = sourcePath;
    const warningThreshold = Number(process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024);
    try {
      const stats = statSync(resolvedSourcePath);
      if (!confirmLarge && stats.size > warningThreshold) {
        removeTemporary();
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续导入会增加解析时间；后续问答、翻译或 OCR 可能消耗更多 token、占用更多内存并变慢。' +
            '这不是硬性拒绝，确认后仍会导入。',
          details: {
            sizeBytes: stats.size,
            thresholdBytes: warningThreshold
          }
        });
      }
    } catch (error) {
      removeTemporary();
      return badRequest(reply, error instanceof Error ? error.message : '文件不存在');
    }

    const id = randomUUID();
    const record: ImportJobRecord = {
      id,
      state: 'queued',
      progress: 0,
      stage: 'queued',
      startedAt: new Date().toISOString()
    };
    importJobs.set(id, record);
    void (async () => {
      record.state = 'running';
      try {
        const document = await options.store.importDocument(
          resolvedSourcePath,
          sourceName,
          confirmDuplicate,
          {
            onProgress: (progress) => {
              record.progress = progress.percent;
              record.stage = progress.stage;
            },
            isCancelled: () => record.state === 'cancelling' || record.state === 'cancelled'
          }
        );
        record.state = 'done';
        record.progress = 100;
        record.stage = 'done';
        record.documentId = document.id;
        record.documentName = document.name;
        record.pages = document.pages;
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          record.state = 'cancelled';
          record.progress = 0;
          record.stage = 'cancelled';
        } else if (error instanceof DuplicateImportError) {
          const names = error.candidates.map((candidate) => candidate.name).slice(0, 3).join('；');
          record.state = 'failed';
          record.error = {
            code: 'duplicate_required',
            message: `文献库中已有相同或高度相似的文献：${names}`,
            details: {
              candidates: error.candidates,
              canOverride: error.canOverride
            }
          };
        } else {
          record.state = 'failed';
          record.error = {
            message: error instanceof Error ? error.message : '导入失败'
          };
        }
      } finally {
        removeTemporary();
        record.finishedAt = new Date().toISOString();
      }
    })();
    // 任务记录保留 10 分钟供轮询；之后清理，避免内存无限增长。
    const cleanup = setTimeout(() => importJobs.delete(id), 10 * 60 * 1000);
    cleanup.unref?.();
    return { jobId: id };
  });

  app.get(`${API_PREFIX}/documents/import/jobs/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = importJobs.get(id);
    return record ?? notFound(reply, '导入任务不存在或已过期');
  });

  app.post(`${API_PREFIX}/documents/import/jobs/:id/cancel`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = importJobs.get(id);
    if (!record) return notFound(reply, '导入任务不存在或已过期');
    if (record.state === 'queued' || record.state === 'running') {
      record.state = 'cancelling';
      record.stage = 'cancelling';
    }
    return record;
  });

  app.get(`${API_PREFIX}/documents/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    return document ?? notFound(reply, '文档不存在');
  });
}
