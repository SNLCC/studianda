import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, type OcrJobRecord } from '@studianda/shared';
import { recognizePage, recognizeRegion } from '../ocr.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

/** OCR 路由（整页/区域/区域任务），从 server.ts 抽出。 */
export function registerOcrRoutes(
  app: FastifyInstance,
  deps: { store: Store; secrets: SecretStore }
): void {
  const { store, secrets } = deps;
  const ocrJobs = new Map<string, OcrJobRecord>();

  app.post(`${API_PREFIX}/documents/:id/ocr/pages/:page`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    if (!store.getDocument(id)) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) {
      return badRequest(reply, '页码必须是正整数');
    }
    const body = (request.body ?? {}) as { scale?: unknown };
    const scale = typeof body.scale === 'number' ? body.scale : 2;
    try {
      return await recognizePage(store, secrets, id, page, scale);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '本机 OCR 失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/ocr`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as {
      page?: unknown;
      x0?: unknown;
      y0?: unknown;
      x1?: unknown;
      y1?: unknown;
    };
    const page = typeof body.page === 'number' ? body.page : Number.NaN;
    const coords = [body.x0, body.y0, body.x1, body.y1];
    if (!Number.isInteger(page) || page < 1) {
      return badRequest(reply, '页码必须是正整数');
    }
    if (!coords.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return badRequest(reply, '区域坐标必须是数字');
    }
    try {
      return await recognizeRegion(store, secrets, id, page, {
        x0: coords[0] as number,
        y0: coords[1] as number,
        x1: coords[2] as number,
        y1: coords[3] as number
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '区域识别失败';
      if (message.includes('未识别到文字')) return reply.code(422).send({ error: message });
      if (message.includes('本地 OCR 识别失败')) return reply.code(503).send({ error: message });
      return badRequest(reply, message);
    }
  });

  // 区域 OCR 后台任务（长任务可显示进度/取消；tesseract worker 是进程内缓存，取消不中断本次识别）。
  app.post(`${API_PREFIX}/documents/:id/ocr/start`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as {
      page?: unknown;
      x0?: unknown;
      y0?: unknown;
      x1?: unknown;
      y1?: unknown;
    };
    const page = typeof body.page === 'number' ? body.page : Number.NaN;
    const coords = [body.x0, body.y0, body.x1, body.y1];
    if (!Number.isInteger(page) || page < 1) {
      return badRequest(reply, '页码必须是正整数');
    }
    if (!coords.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return badRequest(reply, '区域坐标必须是数字');
    }
    const jobId = randomUUID();
    const record: OcrJobRecord = {
      id: jobId,
      state: 'queued',
      progress: 0,
      stage: 'queued',
      page,
      startedAt: new Date().toISOString()
    };
    ocrJobs.set(jobId, record);
    const wasCancelled = (): boolean => record.state === 'cancelling';
    void (async () => {
      record.state = 'running';
      record.stage = 'recognizing';
      record.progress = 10;
      try {
        const result = await recognizeRegion(store, secrets, id, page, {
          x0: coords[0] as number,
          y0: coords[1] as number,
          x1: coords[2] as number,
          y1: coords[3] as number
        });
        if (wasCancelled()) {
          record.state = 'cancelled';
          record.progress = 0;
          record.stage = 'cancelled';
        } else {
          record.state = 'done';
          record.progress = 100;
          record.stage = 'done';
          record.result = result;
        }
      } catch (error) {
        if (wasCancelled()) {
          record.state = 'cancelled';
          record.progress = 0;
          record.stage = 'cancelled';
        } else {
          const message = error instanceof Error ? error.message : '区域识别失败';
          record.state = 'failed';
          record.stage = 'failed';
          record.error = {
            code: message.includes('未识别到文字') ? 'no_text' : 'ocr_failed',
            message
          };
        }
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    })();
    const cleanup = setTimeout(() => ocrJobs.delete(jobId), 10 * 60 * 1000);
    cleanup.unref?.();
    return { jobId };
  });

  app.get(`${API_PREFIX}/documents/:id/ocr/jobs/:jobId`, async (request, reply) => {
    const { jobId } = request.params as { id: string; jobId: string };
    return ocrJobs.get(jobId) ?? notFound(reply, 'OCR 任务不存在或已过期');
  });

  app.post(`${API_PREFIX}/documents/:id/ocr/jobs/:jobId/cancel`, async (request, reply) => {
    const { jobId } = request.params as { id: string; jobId: string };
    const record = ocrJobs.get(jobId);
    if (!record) return notFound(reply, 'OCR 任务不存在或已过期');
    if (record.state === 'queued' || record.state === 'running') {
      record.state = 'cancelling';
      record.stage = 'cancelling';
    }
    return record;
  });
}
