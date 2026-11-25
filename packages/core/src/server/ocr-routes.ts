import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, type BookOcrJobRecord, type BookOcrJobState, type OcrJobRecord } from '@studianda/shared';
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

  // ---- 整本书 OCR：逐页识别并写入 page_edits（扫描版文献可检索、可问答） ----
  type BookOcrControl = {
    record: BookOcrJobRecord;
    controller: AbortController;
    paused: boolean;
    cancelled: boolean;
    untrack: () => void;
  };
  const bookJobs = new Map<string, BookOcrControl>();
  const bookJobByDocument = new Map<string, string>();
  /** 每篇文献最近一次整本 OCR 任务：结束后仍可让界面显示结果（30 分钟后随 bookJobs 一起过期）。 */
  const bookJobLastByDocument = new Map<string, string>();
  const nowIso = (): string => new Date().toISOString();
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  const isActiveBookState = (state: BookOcrJobState): boolean =>
    state === 'queued' || state === 'running' || state === 'paused' || state === 'cancelling';

  const finishBookJob = (
    control: BookOcrControl,
    state: BookOcrJobState,
    error?: BookOcrJobRecord['error']
  ): void => {
    const { record } = control;
    record.state = state;
    record.stage = state;
    record.error = error;
    record.updatedAt = nowIso();
    record.finishedAt = record.updatedAt;
    const current = bookJobByDocument.get(record.documentId);
    if (current === record.id) bookJobByDocument.delete(record.documentId);
    bookJobLastByDocument.set(record.documentId, record.id);
    control.untrack();
    // 任务记录保留 30 分钟：刷新界面/回到工作台后还能看到上次结果；过期后释放。
    const cleanup = setTimeout(() => {
      bookJobs.delete(record.id);
      if (bookJobLastByDocument.get(record.documentId) === record.id) {
        bookJobLastByDocument.delete(record.documentId);
      }
    }, 30 * 60 * 1000);
    cleanup.unref?.();
  };

  const runBookOcr = async (control: BookOcrControl): Promise<void> => {
    const { record, controller } = control;
    if (!store.getDocument(record.documentId)) {
      finishBookJob(control, 'failed', {
        code: 'document_deleted',
        message: '文献已删除，整本 OCR 已中止'
      });
      return;
    }
    record.state = 'running';
    record.stage = 'ocr';
    record.updatedAt = nowIso();
    let consecutiveFailures = 0;
    for (let page = record.currentPage; page <= record.total; page += 1) {
      if (control.cancelled || controller.signal.aborted) {
        finishBookJob(control, 'cancelled');
        return;
      }
      // 暂停只在两页之间生效：正在识别的一页先完成并落库，避免半页结果。
      while (control.paused && !control.cancelled) {
        record.state = 'paused';
        record.stage = 'paused';
        record.updatedAt = nowIso();
        await sleep(200);
      }
      if (control.cancelled) {
        finishBookJob(control, 'cancelled');
        return;
      }
      record.state = 'running';
      record.stage = `ocr:${page}`;
      record.currentPage = page;
      record.updatedAt = nowIso();
      try {
        const cached = store.getPageEdit(record.documentId, page);
        if (cached?.origin === 'ocr' && cached.text.trim()) {
          record.skipped += 1;
        } else {
          const result = await recognizePage(
            store,
            secrets,
            record.documentId,
            page,
            record.scale,
            { signal: controller.signal }
          );
          record.engine = result.engine;
          record.done += 1;
        }
        consecutiveFailures = 0;
      } catch (error) {
        if (control.cancelled || controller.signal.aborted) {
          finishBookJob(control, 'cancelled');
          return;
        }
        record.failed += 1;
        consecutiveFailures += 1;
        // 连续 5 页失败通常是引擎/语言包/网络问题：中止并给出可读原因，不把整本耗完。
        if (consecutiveFailures >= 5) {
          finishBookJob(control, 'failed', {
            code: 'ocr_failed',
            message: error instanceof Error ? error.message : '整本 OCR 连续失败'
          });
          return;
        }
      }
      record.updatedAt = nowIso();
    }
    finishBookJob(control, 'done');
  };

  /** 所有整本 OCR 任务（按更新时间倒序）：工作台与阅读页共用，用于显示进度。 */
  app.get(`${API_PREFIX}/ocr/book-jobs`, async () => ({
    jobs: [...bookJobs.values()]
      .map((control) => control.record)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }));

  app.get(`${API_PREFIX}/documents/:id/ocr/book`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = store.getDocument(id);
    if (!document) return notFound(reply, '文献不存在');
    const jobId = bookJobByDocument.get(id);
    const control = jobId ? bookJobs.get(jobId) : undefined;
    if (control) return control.record;
    const lastId = bookJobLastByDocument.get(id);
    const last = lastId ? bookJobs.get(lastId) : undefined;
    if (last) return last.record;
    const idle: BookOcrJobRecord = {
      id: '',
      documentId: id,
      state: 'idle',
      total: document.pages,
      done: 0,
      skipped: 0,
      failed: 0,
      currentPage: 0,
      stage: 'idle',
      scale: 2,
      startedAt: '',
      updatedAt: ''
    };
    return idle;
  });

  app.post(`${API_PREFIX}/documents/:id/ocr/book/start`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = store.getDocument(id);
    if (!document) return notFound(reply, '文献不存在');
    const body = (request.body ?? {}) as { fromPage?: unknown; scale?: unknown };
    const existingJobId = bookJobByDocument.get(id);
    const existing = existingJobId ? bookJobs.get(existingJobId) : undefined;
    // 同一篇文献同时只跑一个整本任务：重复点击开始返回正在跑的那个。
    if (existing && isActiveBookState(existing.record.state)) return existing.record;

    const total = Math.max(1, document.pages);
    const fromPage =
      typeof body.fromPage === 'number' && Number.isInteger(body.fromPage)
        ? Math.min(Math.max(1, body.fromPage), total)
        : 1;
    const scale =
      typeof body.scale === 'number' && Number.isFinite(body.scale)
        ? Math.min(3, Math.max(1, body.scale))
        : 2;
    const controller = new AbortController();
    const record: BookOcrJobRecord = {
      id: randomUUID(),
      documentId: id,
      state: 'queued',
      total,
      done: 0,
      skipped: 0,
      failed: 0,
      currentPage: fromPage,
      stage: 'queued',
      scale,
      startedAt: nowIso(),
      updatedAt: nowIso()
    };
    const control: BookOcrControl = {
      record,
      controller,
      paused: false,
      cancelled: false,
      untrack: documentRequests.track([id], controller)
    };
    bookJobs.set(record.id, control);
    bookJobByDocument.set(id, record.id);
    bookJobLastByDocument.set(id, record.id);
    void runBookOcr(control);
    return record;
  });

  app.post(`${API_PREFIX}/documents/:id/ocr/book/:jobId/pause`, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    const control = bookJobs.get(jobId);
    if (!control || control.record.documentId !== id) {
      return notFound(reply, '整本 OCR 任务不存在或已过期');
    }
    if (control.record.state === 'running' || control.record.state === 'queued') {
      control.paused = true;
      control.record.state = 'paused';
      control.record.stage = 'paused';
      control.record.updatedAt = nowIso();
    }
    return control.record;
  });

  app.post(`${API_PREFIX}/documents/:id/ocr/book/:jobId/resume`, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    const control = bookJobs.get(jobId);
    if (!control || control.record.documentId !== id) {
      return notFound(reply, '整本 OCR 任务不存在或已过期');
    }
    if (control.record.state === 'paused') {
      control.paused = false;
      control.record.state = 'running';
      control.record.stage = 'ocr';
      control.record.updatedAt = nowIso();
    }
    return control.record;
  });

  app.post(`${API_PREFIX}/documents/:id/ocr/book/:jobId/cancel`, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    const control = bookJobs.get(jobId);
    if (!control || control.record.documentId !== id) {
      return notFound(reply, '整本 OCR 任务不存在或已过期');
    }
    if (isActiveBookState(control.record.state)) {
      control.cancelled = true;
      control.record.state = 'cancelling';
      control.record.stage = 'cancelling';
      control.record.updatedAt = nowIso();
      control.controller.abort();
    }
    return control.record;
  });
}
