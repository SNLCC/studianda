import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES, API_PREFIX, type BackupJobRecord } from '@studianda/shared';
import {
  BackupCancelledError,
  createSnapshot,
  listBackups,
  requestRestore,
  verifyBackup
} from '../backup.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

/**
 * 备份相关路由（从 server.ts 拆出的第一个领域模块）。
 * 行为与原实现一致：同步 `/backups` 保留，另提供可轮询/取消的 job 接口。
 */
export function registerBackupRoutes(app: FastifyInstance, store: Store): void {
  const backupJobs = new Map<string, BackupJobRecord>();

  app.get(`${API_PREFIX}/backups`, async () => listBackups(store.dataDir));

  app.post(`${API_PREFIX}/backups`, async (request, reply) => {
    const body = (request.body ?? {}) as { include_logs?: unknown };
    try {
      return await createSnapshot(store, {
        includeLogs: body.include_logs === true
      });
    } catch (error) {
      return reply.code(500).send({
        error: API_ERROR_CODES.backupFailed,
        message: error instanceof Error ? error.message : '备份失败'
      });
    }
  });

  app.post(`${API_PREFIX}/backups/:name/restore`, async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      return requestRestore(store.dataDir, decodeURIComponent(name));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '恢复准备失败');
    }
  });

  app.post(`${API_PREFIX}/backups/:name/verify`, async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      return verifyBackup(store.dataDir, decodeURIComponent(name));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '备份校验失败');
    }
  });

  // 备份任务：文件收集阶段可取消；zipSync 压缩阶段是同步阻塞（记录会停在 zip 阶段）。
  app.post(`${API_PREFIX}/backups/start`, async (request) => {
    const body = (request.body ?? {}) as { include_logs?: unknown };
    const id = randomUUID();
    const record: BackupJobRecord = {
      id,
      state: 'queued',
      progress: 0,
      stage: 'queued',
      startedAt: new Date().toISOString()
    };
    backupJobs.set(id, record);
    void (async () => {
      record.state = 'running';
      try {
        const result = await createSnapshot(store, {
          includeLogs: body.include_logs === true,
          onProgress: (progress) => {
            record.progress = progress.percent;
            record.stage = progress.stage;
            record.filesDone = progress.filesDone;
            record.filesTotal = progress.filesTotal;
          },
          isCancelled: () => record.state === 'cancelling' || record.state === 'cancelled'
        });
        record.state = 'done';
        record.progress = 100;
        record.stage = 'done';
        record.backup = result.backup;
      } catch (error) {
        if (error instanceof BackupCancelledError) {
          record.state = 'cancelled';
          record.progress = 0;
          record.stage = 'cancelled';
        } else {
          record.state = 'failed';
          record.error = { message: error instanceof Error ? error.message : '备份失败' };
        }
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    })();
    const cleanup = setTimeout(() => backupJobs.delete(id), 10 * 60 * 1000);
    cleanup.unref?.();
    return { jobId: id };
  });

  app.get(`${API_PREFIX}/backups/jobs/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    return backupJobs.get(id) ?? notFound(reply, '备份任务不存在或已过期');
  });

  app.post(`${API_PREFIX}/backups/jobs/:id/cancel`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = backupJobs.get(id);
    if (!record) return notFound(reply, '备份任务不存在或已过期');
    if (record.state === 'queued' || record.state === 'running') {
      record.state = 'cancelling';
      record.stage = 'cancelling';
    }
    return record;
  });
}
