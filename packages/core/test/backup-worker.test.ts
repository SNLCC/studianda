import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupJobRecord } from '@studianda/shared';
import {
  BackupCancelledError,
  backupFolder,
  createSnapshot,
  listBackups
} from '../src/backup.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'studianda-backup-worker-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

/** 写一个不可压缩的伪随机文件（xorshift），顺便返回 sha256，避免把内容留在内存里。 */
function seedFile(target: string, bytes: number, seed: number): string {
  mkdirSync(path.dirname(target), { recursive: true });
  const fd = openSync(target, 'w');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash('sha256');
  let state = seed >>> 0 || 1;
  let remaining = bytes;
  try {
    while (remaining > 0) {
      const size = Math.min(chunk.length, remaining);
      for (let index = 0; index < size; index += 1) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        chunk[index] = state & 0xff;
      }
      const slice = chunk.subarray(0, size);
      const view = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
      let written = 0;
      while (written < view.byteLength) written += writeSync(fd, view.subarray(written));
      hash.update(slice);
      remaining -= size;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function stagingDirs(root: string): string[] {
  const folder = backupFolder(root);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.startsWith('.staging-'));
}

function backupZips(root: string): string[] {
  const folder = backupFolder(root);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.zip'));
}

describe('backup worker（备份 zip 压缩离开主线程）', () => {
  it('大目录：zip 可解压、文件数与哈希一致，压缩阶段主线程定时器仍在跑', async () => {
    const root = tempRoot();
    const store = new Store(root);
    try {
      const sources = Array.from({ length: 6 }, (_, index) => ({
        relative: `papers/paper-${index}.pdf`,
        size: 4 * 1024 * 1024,
        seed: 0x9e3779b9 ^ (index * 2654435761)
      }));
      const hashes = new Map<string, string>();
      for (const source of sources) {
        hashes.set(
          source.relative,
          seedFile(path.join(root, ...source.relative.split('/')), source.size, source.seed)
        );
      }

      // 5ms 定时器：如果 zip 压缩还在主线程同步执行，压缩期间它一次都不会触发。
      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(Date.now()), 5);
      const stages = new Set<string>();
      const percents: number[] = [];
      let zipStartTicks = -1;
      let zipFileProgress = 0;
      let result: Awaited<ReturnType<typeof createSnapshot>>;
      try {
        result = await createSnapshot(store, {
          onProgress: (progress) => {
            stages.add(progress.stage);
            percents.push(progress.percent);
            if (progress.stage !== 'zip') return;
            if (zipStartTicks < 0) zipStartTicks = ticks.length;
            if ((progress.filesDone ?? 0) > 0) zipFileProgress += 1;
          }
        });
      } finally {
        clearInterval(timer);
      }

      // 关键断言：压缩阶段开始后，主线程事件循环至少转了一圈（不再被 zipSync 占满）。
      expect(zipStartTicks).toBeGreaterThanOrEqual(0);
      expect(ticks.length - zipStartTicks).toBeGreaterThan(0);
      // worker 的文件级进度也传回了主线程（压缩阶段不是「停在 zip」）。
      expect(zipFileProgress).toBeGreaterThan(0);
      expect([...stages]).toEqual(expect.arrayContaining(['databases', 'files', 'zip', 'done']));
      for (let index = 1; index < percents.length; index += 1) {
        expect(percents[index]!).toBeGreaterThanOrEqual(percents[index - 1]!);
      }
      expect(percents[percents.length - 1]).toBe(100);

      expect(result.files).toBe(sources.length);
      expect(result.databases).toContain('reader.sqlite3');
      expect(result.entries).toHaveLength(sources.length + result.databases.length);
      expect(result.backup.sizeBytes).toBeGreaterThan(0);
      expect(listBackups(root)).toHaveLength(1);

      const archive = unzipSync(new Uint8Array(readFileSync(result.backup.path)));
      expect(Object.keys(archive)).toHaveLength(result.entries.length);
      for (const source of sources) {
        const bytes = archive[source.relative];
        expect(bytes, `${source.relative} 缺失`).toBeInstanceOf(Uint8Array);
        expect(bytes!.byteLength).toBe(source.size);
        expect(createHash('sha256').update(bytes!).digest('hex')).toBe(hashes.get(source.relative));
      }
      for (const database of result.databases) {
        expect(archive[database]?.byteLength).toBeGreaterThan(0);
      }
      expect(stagingDirs(root)).toEqual([]);
    } finally {
      store.close();
    }
  }, 60000);

  it('worker 抛错：createSnapshot 拒绝，半成品/临时目录被清理，锁随后释放', async () => {
    const root = tempRoot();
    const store = new Store(root);
    try {
      const source = path.join(root, 'papers', 'vanishing.bin');
      seedFile(source, 2 * 1024 * 1024, 7);
      let removed = false;
      await expect(
        createSnapshot(store, {
          onProgress: (progress) => {
            // zip 阶段回调发生在 worker 启动之前：此时删掉源文件，worker 必然读失败。
            if (progress.stage === 'zip' && !removed) {
              removed = true;
              rmSync(source, { force: true });
            }
          }
        })
      ).rejects.toThrow(/ENOENT|no such file/i);
      expect(removed).toBe(true);
      expect(stagingDirs(root)).toEqual([]);
      expect(backupZips(root)).toEqual([]);

      // 失败后单任务锁必须释放：再备份（源文件已删，目录里只剩数据库快照）应成功。
      const retried = await createSnapshot(store);
      expect(retried.backup.name).toMatch(/^studianda-data-\d{8}-\d{6}\.zip$/);
      expect(backupZips(root)).toHaveLength(1);
    } finally {
      store.close();
    }
  }, 60000);

  it('压缩中取消：抛 BackupCancelledError，不留下半成品或最终 zip', async () => {
    const root = tempRoot();
    const store = new Store(root);
    try {
      const sources = Array.from({ length: 6 }, (_, index) => ({
        relative: `papers/cancel-${index}.pdf`,
        size: 4 * 1024 * 1024,
        seed: 0x85ebca6b ^ (index * 2246822519)
      }));
      for (const source of sources) {
        seedFile(path.join(root, ...source.relative.split('/')), source.size, source.seed);
      }
      let cancelled = false;
      await expect(
        createSnapshot(store, {
          isCancelled: () => cancelled,
          onProgress: (progress) => {
            // 收到 worker 的第一个文件级进度后才取消：确保取消发生在压缩线程工作期间。
            if (progress.stage === 'zip' && (progress.filesDone ?? 0) >= 1) cancelled = true;
          }
        })
      ).rejects.toBeInstanceOf(BackupCancelledError);
      expect(cancelled).toBe(true);
      expect(stagingDirs(root)).toEqual([]);
      expect(backupZips(root)).toEqual([]);
    } finally {
      store.close();
    }
  }, 60000);

  it('任务路由：压缩阶段可轮询观察，期间轻量路由仍及时响应；失败会标记 failed 并清理', async () => {
    const root = tempRoot();
    const store = new Store(root);
    const server = buildServer({
      token: 'backup-worker-token',
      version: 'test',
      store,
      secrets: new SecretStore()
    });
    const headers = { 'x-studianda-token': 'backup-worker-token' };
    const start = async (): Promise<{ status: number; jobId?: string }> => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/backups/start',
        headers,
        payload: { include_logs: false }
      });
      return {
        status: response.statusCode,
        jobId: (response.json() as { jobId?: string }).jobId
      };
    };
    const getJob = async (id: string): Promise<BackupJobRecord> => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/backups/jobs/${id}`,
        headers
      });
      expect(response.statusCode).toBe(200);
      return response.json() as BackupJobRecord;
    };
    const waitJob = async (id: string): Promise<BackupJobRecord> => {
      const deadline = Date.now() + 30000;
      for (;;) {
        const job = await getJob(id);
        if (['done', 'failed', 'cancelled'].includes(job.state)) return job;
        if (Date.now() > deadline) throw new Error('backup job timeout');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      // 3 个 4MB 文件：压缩阶段足够长，能在轮询里观察 zip 进度。
      for (let index = 0; index < 3; index += 1) {
        seedFile(path.join(root, 'papers', `big-${index}.pdf`), 4 * 1024 * 1024, 99 + index);
      }
      const first = await start();
      expect(first.status).toBe(200);
      // 同时只允许一个备份任务。
      const second = await start();
      expect(second.status).toBe(409);

      // 等到 zip 阶段：若压缩仍在主线程同步执行，这个阶段根本不会被观察到
      //（记录会被一次同步 zipSync 直接推进到 done），下面的断言会超时。
      const deadline = Date.now() + 20000;
      let observedZip = false;
      let job: BackupJobRecord | null = null;
      while (Date.now() < deadline) {
        job = await getJob(first.jobId!);
        if (job.stage === 'zip') {
          observedZip = true;
          break;
        }
        if (['done', 'failed', 'cancelled'].includes(job.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedZip).toBe(true);
      // 压缩期间主线程还能处理别的路由请求（不再被同步压缩占满）。
      const startedAt = Date.now();
      const list = await server.inject({ method: 'GET', url: '/api/v1/backups', headers });
      expect(list.statusCode).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(1000);

      const done = await waitJob(first.jobId!);
      expect(done.state).toBe('done');
      expect(done.stage).toBe('done');
      expect(done.progress).toBe(100);
      expect(listBackups(root)).toHaveLength(1);

      // worker 抛错 -> 任务 failed、半成品清理。
      const vanishing = path.join(root, 'papers', 'vanishing.pdf');
      seedFile(vanishing, 1 * 1024 * 1024, 1234);
      const failing = await start();
      expect(failing.status).toBe(200);
      // 路由返回时 createSnapshot 正停在文件收集的 setImmediate 上（压缩线程尚未启动），
      // 此刻删掉源文件，worker 打开时必然 ENOENT。
      rmSync(vanishing, { force: true });
      const failed = await waitJob(failing.jobId!);
      expect(failed.state).toBe('failed');
      expect(failed.error?.message ?? '').toMatch(/ENOENT|no such file/i);
      expect(stagingDirs(root)).toEqual([]);
      expect(backupZips(root)).toHaveLength(1);

      // 失败任务结束后仍能启动新任务。
      const retried = await start();
      expect(retried.status).toBe(200);
      expect((await waitJob(retried.jobId!)).state).toBe('done');
      expect(listBackups(root)).toHaveLength(2);
    } finally {
      await server.close();
      store.close();
    }
  }, 90000);
});
