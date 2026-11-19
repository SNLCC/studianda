import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, type OcrJobRecord } from '@studianda/shared';
import { recognizePage, recognizeRegion } from '../ocr.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import type { DocumentRequestRegistry } from './document-request-registry.js';
import { badRequest, notFound } from './http.js';

/** OCR 路由（整页/区域/区域任务），从 server.ts 抽出。 */
export function registerOcrRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    secrets: SecretStore;
    /** 文档级在途请求登记表：区域 OCR 后台任务按文献登记，purge/清空数据时中止。 */
    documentRequests: DocumentRequestRegistry;
  }
): void {
  const { store, secrets, documentRequests } = deps;
  const ocrJobs = new Map<string, OcrJobRecord>();
  // 每个后台任务一个取消信号：取消时真的中断正在识别的页（destroy 取图 worker / tesseract 实例）。
  const ocrJobAborts = new Map<string, AbortController>();

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
    const controller = new AbortController();
    const record: OcrJobRecord = {
      id: jobId,
      state: 'queued',
      progress: 0,
      stage: 'queued',
      page,
      startedAt: new Date().toISOString()
    };
    ocrJobs.set(jobId, record);
    ocrJobAborts.set(jobId, controller);
    // 区域 OCR 是**文档级在途任务**：登记到 documentRequests，彻底删除该文献（purge）或
    // 清空用户数据时，`abort(id)` 会同步中止本次识别（信号沿 recognizeRegion 传到取图与
    // tesseract 实例，不留后台线程）；与用户点「取消」共用同一个 controller/abort 通道，
    // 但两者收尾时的**语义不同**（见 abortByServer 的注释）。untrack 放在 finally，
    // 成功/失败/中止三条路径都会归零。
    const untrackDocument = documentRequests.track([id], controller);
    const wasCancelled = (): boolean => record.state === 'cancelling';
    /**
     * 服务端中止（purge 删文 / 清空数据 / app.close）的收尾。
     *
     * 语义选择：**明确报失败，不静默结束**。
     * - 不用 `state='cancelled'`：那是用户点「取消区域识别」的专属状态，前端固定显示
     *   「区域识别已取消。」；把服务端删文也塞进去，用户会以为自己取消了、或不知道为何没结果。
     * - 不照抄跨篇追问的 409/conflict：那边是「一个 HTTP 请求正在等回答」，409 是请求级状态码；
     *   这里是任务式接口，start 早已返回 200 + jobId，状态查询 GET jobs 是**读资源**，
     *   把它改成 409 会增加轮询分支且丢掉任务记录本身。原因编码进任务记录：
     *   `state='failed'` + `error.code='document_deleted'` + 中文文案，前端失败通道会显示
     *   「区域识别失败：文献已删除，区域识别已中止」，与「我取消的」可区分。
     * - 不用 503/499：删掉的文献不会因重试恢复，499 在本仓库专指客户端断开。
     */
    const abortByServer = (): void => {
      record.state = 'failed';
      record.progress = 0;
      record.stage = 'failed';
      record.error = store.getDocument(id)
        ? {
            code: 'server_aborted',
            message: '服务端已中止区域识别（应用关闭或数据正在被清空）'
          }
        : { code: 'document_deleted', message: '文献已删除，区域识别已中止' };
    };
    void (async () => {
      record.state = 'running';
      record.stage = 'recognizing';
      record.progress = 10;
      try {
        const result = await recognizeRegion(
          store,
          secrets,
          id,
          page,
          {
            x0: coords[0] as number,
            y0: coords[1] as number,
            x1: coords[2] as number,
            y1: coords[3] as number
          },
          { signal: controller.signal }
        );
        if (wasCancelled()) {
          record.state = 'cancelled';
          record.progress = 0;
          record.stage = 'cancelled';
        } else if (controller.signal.aborted) {
          // 识别晚于中止完成（视觉路径不吃 signal）：结果属于已删除的文献，丢弃不返回。
          abortByServer();
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
        } else if (controller.signal.aborted) {
          abortByServer();
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
        untrackDocument();
        record.finishedAt = new Date().toISOString();
        ocrJobAborts.delete(jobId);
      }
    })();
    const cleanup = setTimeout(() => {
      ocrJobs.delete(jobId);
      ocrJobAborts.delete(jobId);
    }, 10 * 60 * 1000);
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
      // 真取消：中断正在渲图/识别的页；任务收尾时清理 worker/实例，不留后台线程与临时文件。
      ocrJobAborts.get(jobId)?.abort();
    }
    return record;
  });
}
