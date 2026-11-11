import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { MarkdownJobSnapshot, MarkdownScanJob } from '@studianda/shared';
import {
  cancelMarkdownScan,
  getMarkdownImportStatus,
  getMarkdownResultStatCount,
  getMarkdownScanStatus,
  hydrateMarkdownJobs,
  resetMarkdownResultCheckStats,
  startMarkdownImport,
  startMarkdownScan
} from '../src/markdown-import.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-phase18-'));
const token = 'test-token';

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function writeFile(dir: string, relativePath: string, content: string | Buffer): string {
  const file = path.join(dir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

async function waitScan(timeoutMs = 20000): Promise<MarkdownScanJob> {
  const started = Date.now();
  for (;;) {
    const job = getMarkdownScanStatus();
    if (job.status !== 'running' && job.status !== 'idle') return job;
    if (Date.now() - started > timeoutMs) throw new Error('scan timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeVault(name: string, count: number): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFile(dir, `n-${index}.md`, `# N${index}`);
  }
  return dir;
}

function settingsJson(store: Store, key: string): Record<string, unknown> {
  return JSON.parse(String(store.getSettings()[key] ?? '{}')) as Record<string, unknown>;
}

/** 等待 settings 中的扫描任务快照到达指定终态（说明引擎终态已落盘且运行标记已释放）。 */
async function waitPersistedScan(
  store: Store,
  status: MarkdownScanJob['status'],
  timeoutMs = 20000
): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    try {
      const snapshot = settingsJson(store, 'markdown.scan_job');
      if (snapshot.status === status) return snapshot;
    } catch {
      // 解析失败：继续等
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`persisted scan job did not reach ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitPersistedImport(
  store: Store,
  status: string,
  timeoutMs = 20000
): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    try {
      const snapshot = settingsJson(store, 'markdown.import_job');
      if (snapshot.status === status) return snapshot;
    } catch {
      // 解析失败：继续等
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`persisted import job did not reach ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readGzipJson(file: string): Record<string, unknown> {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Record<string, unknown>;
}

interface SseReader {
  next(timeoutMs?: number): Promise<MarkdownJobSnapshot>;
  close(): void;
}

// 测试失败/超时时也确保 SSE 连接被关闭，避免名额泄漏导致后续用例 503。
const activeStreams = new Set<SseReader>();

afterEach(async () => {
  for (const stream of activeStreams) {
    try {
      stream.close();
    } catch {
      // 忽略
    }
  }
  activeStreams.clear();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

async function openEventStream(url: string): Promise<SseReader> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok) {
    controller.abort();
    throw new Error(`SSE HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    controller.abort();
    throw new Error(`unexpected content-type: ${contentType}`);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (timeoutMs = 20_000): Promise<MarkdownJobSnapshot> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = buffer.indexOf('\n\n');
      if (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          return JSON.parse(dataLine.slice('data: '.length)) as MarkdownJobSnapshot;
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error('SSE event timeout');
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE read timeout')), Math.max(1, deadline - Date.now()))
        )
      ]);
      if (result.done) throw new Error('SSE stream ended');
      buffer += decoder.decode(result.value, { stream: true });
    }
  };
  let closed = false;
  const stream: SseReader = {
    next,
    close: () => {
      if (closed) return;
      closed = true;
      activeStreams.delete(stream);
      controller.abort();
      void reader.cancel().catch(() => {});
    }
  };
  activeStreams.add(stream);
  return stream;
}

describe('SSE /api/v1/markdown/events', () => {
  it('初始快照 + start/进度/完成事件推送；token 错误 401', async () => {
    const store = storeAt('sse-store');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${new URL(address).port}`;
    try {
      // token 错误 → 401。
      const unauthorized = await fetch(`${base}/api/v1/markdown/events?token=wrong`);
      expect(unauthorized.status).toBe(401);
      const noToken = await fetch(`${base}/api/v1/markdown/events`);
      expect(noToken.status).toBe(401);

      const stream = await openEventStream(`${base}/api/v1/markdown/events?token=${token}`);
      try {
        // 连接即推送当前 lite 快照。
        const initial = await stream.next();
        expect(initial).toHaveProperty('scanJob');
        expect(initial).toHaveProperty('importJob');
        expect(initial.lite).toBe(true);
        expect(initial.scanJob.scan).toBeNull();
        expect(initial.importJob.report).toBeNull();
        expect(initial.scanJob.input).toBeNull();
        expect(initial.importJob.input).toBeNull();

        const vault = makeVault('sse-vault', 8);
        startMarkdownScan(store, vault);
        const statuses = new Set<string>();
        let doneSnapshot: MarkdownJobSnapshot | null = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const snapshot = await stream.next(20000);
          // 所有事件一律 lite：无完整 scan/report/input。
          expect(snapshot.lite).toBe(true);
          expect(snapshot.scanJob.scan).toBeNull();
          expect(snapshot.importJob.report).toBeNull();
          expect(snapshot.scanJob.input).toBeNull();
          expect(snapshot.importJob.input).toBeNull();
          statuses.add(snapshot.scanJob.status);
          if (snapshot.scanJob.status === 'done') {
            doneSnapshot = snapshot;
            break;
          }
        }
        expect(statuses.has('running')).toBe(true);
        expect(doneSnapshot).not.toBeNull();
        expect(doneSnapshot!.terminal).toBe(true);
        expect(doneSnapshot!.scanJob.total).toBe(8);
        // 终态事件体积不再随结果增大（scan 被裁掉）。
        expect(JSON.stringify(doneSnapshot).length).toBeLessThan(2000);
      } finally {
        stream.close();
      }
    } finally {
      await server.close();
      store.close();
    }
  });

  it('运行中事件为 lite（无 scan/report）且节流；终态立即 full 含完整结果', async () => {
    const store = storeAt('sse-lite-store');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${new URL(address).port}`;
    try {
      const stream = await openEventStream(`${base}/api/v1/markdown/events?token=${token}`);
      try {
        // 上一个测试结束时任务已完成：初始事件同样是 lite，并带 terminal:true。
        const initial = await stream.next();
        expect(initial.lite).toBe(true);
        expect(initial.terminal).toBe(true);
        expect(initial.scanJob.scan).toBeNull();

        const vault = makeVault('sse-lite-vault', 400);
        startMarkdownScan(store, vault);
        let runningEvents = 0;
        let finalSnapshot: MarkdownJobSnapshot | null = null;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const snapshot = await stream.next(20000);
          expect(snapshot.lite).toBe(true);
          expect(snapshot.scanJob.scan).toBeNull();
          expect(snapshot.importJob.report).toBeNull();
          expect(snapshot.scanJob.input).toBeNull();
          if (snapshot.scanJob.status === 'running') {
            runningEvents += 1;
            expect(snapshot.terminal).not.toBe(true);
          } else if (snapshot.scanJob.status === 'done') {
            finalSnapshot = snapshot;
            break;
          }
        }
        expect(runningEvents).toBeGreaterThan(0);
        // 400 个文件会产生大量进度变化，但 SSE 全局节流到少数几条。
        expect(runningEvents).toBeLessThanOrEqual(10);
        expect(finalSnapshot).not.toBeNull();
        expect(finalSnapshot!.lite).toBe(true);
        expect(finalSnapshot!.terminal).toBe(true);
        expect(finalSnapshot!.scanJob.total).toBe(400);
        expect(JSON.stringify(finalSnapshot).length).toBeLessThan(3000);
      } finally {
        stream.close();
      }
    } finally {
      await server.close();
      store.close();
    }
  });

  it('连接时任务运行中：初始事件为 lite，终态事件恢复 full', async () => {
    const importVault = path.join(root, 'sse-import-vault');
    mkdirSync(importVault, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      writeFile(importVault, `i-${index}.md`, `# I${index}`);
      files.push(`i-${index}.md`);
    }
    const store = storeAt('sse-import-store');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${new URL(address).port}`;
    try {
      startMarkdownImport(store, { vaultPath: importVault, files });
      const stream = await openEventStream(`${base}/api/v1/markdown/events?token=${token}`);
      try {
        const initial = await stream.next(20000);
        // 运行中连接：初始事件是 lite、无 report/input，且不是 terminal。
        expect(initial.lite).toBe(true);
        expect(initial.terminal).not.toBe(true);
        expect(initial.importJob.status).toBe('running');
        expect(initial.importJob.report).toBeNull();
        expect(initial.scanJob.scan).toBeNull();
        expect(initial.importJob.input).toBeNull();

        let finalSnapshot: MarkdownJobSnapshot | null = null;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const snapshot = await stream.next(20000);
          expect(snapshot.lite).toBe(true);
          expect(snapshot.importJob.report).toBeNull();
          expect(snapshot.importJob.input).toBeNull();
          if (snapshot.importJob.status === 'done') {
            finalSnapshot = snapshot;
            break;
          }
        }
        expect(finalSnapshot).not.toBeNull();
        expect(finalSnapshot!.lite).toBe(true);
        expect(finalSnapshot!.terminal).toBe(true);
        expect(finalSnapshot!.importJob.total).toBe(300);
      } finally {
        stream.close();
      }
    } finally {
      await server.close();
      store.close();
    }
  });

  it('订阅上限可配置：超限 503，断连释放名额；多连接共享全局节流', async () => {
    process.env.STUDIANDA_SSE_MAX_CLIENTS = '2';
    const store = storeAt('sse-limit-store');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${new URL(address).port}`;
    const eventUrl = `${base}/api/v1/markdown/events?token=${token}`;
    const streams: SseReader[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        streams.push(await openEventStream(eventUrl));
      }
      const rejected = await fetch(eventUrl);
      expect(rejected.status).toBe(503);
      const rejectedBody = (await rejected.json()) as { error?: string; message?: string };
      expect(rejectedBody.error).toBe('too_many_requests');
      expect(rejectedBody.message).toContain('连接过多');

      const vault = makeVault('sse-limit-vault', 300);
      startMarkdownScan(store, vault);

      // 现有连接都能收到终态事件；进度事件受全局 300ms 节流限制。
      for (const stream of streams) {
        let runningEvents = 0;
        let terminalSeen = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const snapshot = await stream.next(20000);
          expect(snapshot.lite).toBe(true);
          expect(snapshot.scanJob.scan).toBeNull();
          if (snapshot.scanJob.status === 'running') runningEvents += 1;
          if (snapshot.terminal === true && snapshot.scanJob.status === 'done') {
            terminalSeen = true;
            break;
          }
        }
        expect(terminalSeen).toBe(true);
        expect(runningEvents).toBeLessThanOrEqual(10);
      }

      // 断开所有连接，名额释放后可重新建立。
      for (const stream of streams) stream.close();
      let reconnected: SseReader | null = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          reconnected = await openEventStream(eventUrl);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(reconnected).not.toBeNull();
      reconnected!.close();
    } finally {
      delete process.env.STUDIANDA_SSE_MAX_CLIENTS;
      for (const stream of streams) {
        try {
          stream.close();
        } catch {
          // 忽略
        }
      }
      await server.close();
      store.close();
    }
  }, 20000);
});

describe('结果元数据 / stale 标记', () => {
  it('成功写入 completedAt/stale=false/lastAttemptStatus=done；gzip envelope 含元数据', async () => {
    const dir = makeVault('meta-vault', 5);
    const store = storeAt('meta-store');
    try {
      startMarkdownScan(store, dir);
      await waitPersistedScan(store, 'done');
      const job = getMarkdownScanStatus();
      expect(job.status).toBe('done');
      expect(job.resultStale).toBe(false);
      expect(job.resultMissing).toBe(false);
      expect(job.lastAttemptStatus).toBe('done');
      expect(Number.isNaN(Date.parse(job.resultCompletedAt ?? ''))).toBe(false);

      const snapshot = settingsJson(store, 'markdown.scan_job');
      expect(snapshot.resultStale).toBe(false);
      expect(snapshot.lastAttemptStatus).toBe('done');
      expect(snapshot.resultCompletedAt).toBe(job.resultCompletedAt);

      const envelope = readGzipJson(path.join(store.dataDir, 'markdown-scan-result.json.gz'));
      expect(envelope.version).toBe(1);
      expect(envelope.completedAt).toBe(job.resultCompletedAt);
      expect((envelope.data as { notes: unknown[] }).notes).toHaveLength(5);
    } finally {
      store.close();
    }
  });

  it('取消保留旧成功结果但 stale=true/lastAttemptStatus=cancelled；成功清除 stale', async () => {
    const smallVault = makeVault('meta-retry-small', 4);
    const store = storeAt('meta-retry-store');
    try {
      startMarkdownScan(store, smallVault);
      await waitPersistedScan(store, 'done');
      const success = getMarkdownScanStatus();
      expect(success.status).toBe('done');
      const firstCompletedAt = success.resultCompletedAt;
      const gzipFile = path.join(store.dataDir, 'markdown-scan-result.json.gz');
      const firstEnvelope = readGzipJson(gzipFile);
      const firstData = JSON.stringify(firstEnvelope.data);

      // 取消一次大扫描：旧成功结果保留，但标记 stale。
      const bigVault = makeVault('meta-retry-big', 400);
      startMarkdownScan(store, bigVault);
      cancelMarkdownScan();
      await waitPersistedScan(store, 'cancelled');
      const cancelled = getMarkdownScanStatus();
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.resultStale).toBe(true);
      expect(cancelled.resultMissing).toBe(false);
      expect(cancelled.lastAttemptStatus).toBe('cancelled');
      expect(cancelled.resultCompletedAt).toBe(firstCompletedAt);
      expect(JSON.stringify(readGzipJson(gzipFile).data)).toBe(firstData);

      const cancelledSnapshot = settingsJson(store, 'markdown.scan_job');
      expect(cancelledSnapshot.status).toBe('cancelled');
      expect(cancelledSnapshot.resultStale).toBe(true);
      expect(cancelledSnapshot.lastAttemptStatus).toBe('cancelled');
      expect(cancelledSnapshot.resultCompletedAt).toBe(firstCompletedAt);

      // 再次成功：清 stale、更新 completedAt。
      startMarkdownScan(store, smallVault);
      await waitPersistedScan(store, 'done');
      const retried = getMarkdownScanStatus();
      expect(retried.status).toBe('done');
      expect(retried.resultStale).toBe(false);
      expect(retried.lastAttemptStatus).toBe('done');
      expect(retried.resultCompletedAt).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('重启 hydrate：running→interrupted 保留 completedAt 并置 stale；无 envelope 旧格式兼容', () => {
    const store = storeAt('meta-hydrate-store');
    try {
      // 先造一个成功结果文件（envelope 格式）与已完成快照。
      writeFileSync(
        path.join(store.dataDir, 'markdown-scan-result.json.gz'),
        gzipSync(
          Buffer.from(
            JSON.stringify({
              version: 1,
              completedAt: '2026-01-02T03:04:05.000Z',
              data: { vaultPath: '/vault', vaultName: 'vault', notes: [], attachments: [] }
            })
          )
        )
      );
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'running',
          phase: 'scanning',
          total: 10,
          done: 3,
          currentPath: 'x.md',
          scan: null,
          error: '',
          input: { vaultPath: '/vault' },
          resultCompletedAt: '2026-01-02T03:04:05.000Z',
          resultStale: false,
          lastAttemptStatus: 'running'
        })
      });
      hydrateMarkdownJobs(store);
      const interrupted = getMarkdownScanStatus();
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.error).toContain('进程重启中断');
      expect(interrupted.lastAttemptStatus).toBe('interrupted');
      expect(interrupted.resultStale).toBe(true);
      expect(interrupted.resultCompletedAt).toBe('2026-01-02T03:04:05.000Z');
      expect(interrupted.input).toEqual({ vaultPath: '/vault' });

      // 旧 gzip 格式（无 envelope）：仍可读，completedAt 走 settings/为空。
      writeFileSync(
        path.join(store.dataDir, 'markdown-scan-result.json.gz'),
        gzipSync(
          Buffer.from(
            JSON.stringify({ vaultPath: '/old', vaultName: 'old', notes: [], attachments: [] })
          )
        )
      );
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 0,
          done: 0,
          currentPath: '',
          scan: null,
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      const legacy = getMarkdownScanStatus();
      expect(legacy.status).toBe('done');
      expect(legacy.scan?.vaultPath).toBe('/old');
      expect(legacy.resultStale).toBe(false);
      expect(legacy.lastAttemptStatus).toBe('done');
    } finally {
      store.close();
    }
  });

  it('结果文件缺失/损坏时：status 保持 done，resultMissing/resultStale=true 并提示重新扫描/导入', () => {
    const store = storeAt('meta-missing-store');
    try {
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 1,
          done: 1,
          currentPath: '',
          scan: null,
          error: '',
          resultCompletedAt: '2026-01-01T00:00:00.000Z'
        }),
        'markdown.import_job': JSON.stringify({
          status: 'done',
          phase: 'finalizing',
          total: 1,
          done: 1,
          currentPath: '',
          report: null,
          error: '',
          resultCompletedAt: '2026-01-01T00:00:00.000Z'
        })
      });
      hydrateMarkdownJobs(store);
      const scanJob = getMarkdownScanStatus();
      expect(scanJob.status).toBe('done');
      expect(scanJob.scan).toBeNull();
      expect(scanJob.resultMissing).toBe(true);
      expect(scanJob.resultStale).toBe(true);
      expect(scanJob.error).toContain('重新扫描');
      expect(scanJob.lastAttemptStatus).toBe('done');
      expect(scanJob.resultCompletedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(existsSync(path.join(store.dataDir, 'markdown-scan-result.json.gz'))).toBe(false);

      const importJob = getMarkdownImportStatus();
      expect(importJob.status).toBe('done');
      expect(importJob.report).toBeNull();
      expect(importJob.resultMissing).toBe(true);
      expect(importJob.resultStale).toBe(true);
      expect(importJob.error).toContain('重新导入');
    } finally {
      store.close();
    }
  });

  it('结果文件损坏（gzip 解析失败）同样标记 resultMissing', () => {
    const store = storeAt('meta-corrupt-store');
    try {
      writeFileSync(path.join(store.dataDir, 'markdown-scan-result.json.gz'), '{broken');
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 2,
          done: 2,
          currentPath: '',
          scan: null,
          error: '',
          resultCompletedAt: '2026-01-03T00:00:00.000Z'
        })
      });
      hydrateMarkdownJobs(store);
      const job = getMarkdownScanStatus();
      expect(job.status).toBe('done');
      expect(job.resultMissing).toBe(true);
      expect(job.resultStale).toBe(true);
      expect(job.scan).toBeNull();
      expect(job.error).toContain('结果文件缺失或损坏');
    } finally {
      store.close();
    }
  });

  it('lastAttemptStatus：error 命名、旧 settings 的 failed 兼容映射为 error', () => {
    const store = storeAt('meta-error-name-store');
    try {
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'error',
          phase: 'scanning',
          total: 1,
          done: 0,
          currentPath: '',
          scan: null,
          error: '扫描失败',
          lastAttemptStatus: 'failed',
          resultCompletedAt: null,
          resultStale: false
        })
      });
      hydrateMarkdownJobs(store);
      const job = getMarkdownScanStatus();
      expect(job.status).toBe('error');
      expect(job.lastAttemptStatus).toBe('error');
      expect(job.resultMissing).toBe(false);
    } finally {
      store.close();
    }
  });

  it('运行期删除结果文件：getStatus 立即 resultMissing/stale（无需重启）', async () => {
    process.env.STUDIANDA_RESULT_CHECK_TTL_MS = '0';
    const scanVault = makeVault('runtime-missing-vault', 5);
    const store = storeAt('runtime-missing-store');
    try {
      startMarkdownScan(store, scanVault);
      await waitPersistedScan(store, 'done');
      expect(getMarkdownScanStatus().resultMissing).toBe(false);
      expect(getMarkdownScanStatus().scan).not.toBeNull();

      // 外部删除 gzip 后立刻查询：stat 检测为缺失。
      rmSync(path.join(store.dataDir, 'markdown-scan-result.json.gz'), { force: true });
      const missing = getMarkdownScanStatus();
      expect(missing.status).toBe('done');
      expect(missing.resultMissing).toBe(true);
      expect(missing.resultStale).toBe(true);
      expect(missing.scan).toBeNull();
      expect(missing.error).toContain('结果文件缺失或损坏');

      // 恢复文件后再次查询恢复可读。
      writeFileSync(
        path.join(store.dataDir, 'markdown-scan-result.json.gz'),
        gzipSync(
          Buffer.from(
            JSON.stringify({
              version: 1,
              completedAt: missing.resultCompletedAt,
              data: { vaultPath: '/x', vaultName: 'x', notes: [], attachments: [] }
            })
          )
        )
      );
      const restored = getMarkdownScanStatus();
      expect(restored.resultMissing).toBe(false);
      expect(restored.scan).not.toBeNull();
    } finally {
      delete process.env.STUDIANDA_RESULT_CHECK_TTL_MS;
      store.close();
    }
  });

  it('运行期删除导入报告文件：getStatus 立即 resultMissing', async () => {
    process.env.STUDIANDA_RESULT_CHECK_TTL_MS = '0';
    const importVault = path.join(root, 'runtime-import-vault');
    mkdirSync(importVault, { recursive: true });
    writeFile(importVault, 'a.md', '# A');
    const store = storeAt('runtime-import-store');
    try {
      startMarkdownImport(store, { vaultPath: importVault, files: ['a.md'] });
      await waitPersistedImport(store, 'done');
      expect(getMarkdownImportStatus().resultMissing).toBe(false);
      rmSync(path.join(store.dataDir, 'markdown-import-result.json.gz'), { force: true });
      const missing = getMarkdownImportStatus();
      expect(missing.status).toBe('done');
      expect(missing.resultMissing).toBe(true);
      expect(missing.resultStale).toBe(true);
      expect(missing.report).toBeNull();
      expect(missing.error).toContain('结果文件缺失或损坏');
    } finally {
      delete process.env.STUDIANDA_RESULT_CHECK_TTL_MS;
      store.close();
    }
  });
});

describe('GET /markdown/jobs + gzip 响应 / stat 缓存', () => {
  it('/markdown/jobs 一次返回完整 scanJob+importJob；Accept-Encoding gzip 压缩可解析', async () => {
    const scanVault = makeVault('jobs-scan-vault', 3);
    const importVault = path.join(root, 'jobs-import-vault');
    mkdirSync(importVault, { recursive: true });
    writeFile(importVault, 'n.md', '# N');
    const store = storeAt('jobs-store');
    const server = buildServer({
      token,
      version: 'test-version',
      store,
      secrets: new SecretStore()
    });
    try {
      startMarkdownScan(store, scanVault);
      await waitPersistedScan(store, 'done');
      startMarkdownImport(store, { vaultPath: importVault, files: ['n.md'] });
      await waitPersistedImport(store, 'done');

      const plain = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/jobs',
        headers: { 'x-studianda-token': token }
      });
      expect(plain.statusCode).toBe(200);
      const snapshot = plain.json() as MarkdownJobSnapshot;
      expect(snapshot.scanJob.status).toBe('done');
      expect(snapshot.scanJob.scan?.notes).toHaveLength(3);
      expect(snapshot.importJob.status).toBe('done');
      expect(snapshot.importJob.report?.imported).toBe(1);
      expect(snapshot.scanJob.input?.vaultPath).toContain('jobs-scan-vault');
      expect(snapshot.importJob.input?.files).toEqual(['n.md']);

      const gzipped = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/jobs',
        headers: { 'x-studianda-token': token, 'accept-encoding': 'gzip' }
      });
      expect(gzipped.statusCode).toBe(200);
      expect(gzipped.headers['content-encoding']).toBe('gzip');
      // worker 压缩后异步写回：带 content-length（不再走 chunked 流）。
      expect(Number(gzipped.headers['content-length'])).toBeGreaterThan(0);
      // 成功扫描同时写出 sidecar。
      expect(
        existsSync(path.join(store.dataDir, 'markdown-scan-result.json.gz.sha256'))
      ).toBe(true);
      const decoded = JSON.parse(gunzipSync(gzipped.rawPayload).toString('utf8')) as
        MarkdownJobSnapshot;
      expect(decoded.scanJob.scan?.notes).toHaveLength(3);
      expect(decoded.importJob.report?.imported).toBe(1);
      expect(decoded.importJob.input?.files).toEqual(['n.md']);

      // status 完整响应同样支持 gzip。
      const statusGzip = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/import/status',
        headers: { 'x-studianda-token': token, 'accept-encoding': 'gzip' }
      });
      expect(statusGzip.headers['content-encoding']).toBe('gzip');
      const statusDecoded = JSON.parse(
        gunzipSync(statusGzip.rawPayload).toString('utf8')
      ) as typeof snapshot.importJob;
      expect(statusDecoded.report?.imported).toBe(1);
      expect(statusDecoded.input?.files).toEqual(['n.md']);

      // 不带 gzip 时仍为普通 JSON。
      const plainStatus = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/import/status',
        headers: { 'x-studianda-token': token }
      });
      expect(plainStatus.headers['content-encoding']).toBeUndefined();
      expect((plainStatus.json() as typeof snapshot.importJob).report?.imported).toBe(1);
    } finally {
      await server.close();
      store.close();
    }
  }, 20000);

  it('结果文件 stat 缓存：TTL 内不重复 stat；文件变化时验证损坏并支持恢复', async () => {
    const dir = makeVault('cache-vault', 3);
    const store = storeAt('cache-store');
    try {
      startMarkdownScan(store, dir);
      await waitPersistedScan(store, 'done');
      delete process.env.STUDIANDA_RESULT_CHECK_TTL_MS;
      resetMarkdownResultCheckStats();
      getMarkdownScanStatus();
      getMarkdownScanStatus();
      // 默认 TTL 1s：连续两次 getStatus 只发生一次 stat。
      expect(getMarkdownResultStatCount()).toBe(1);

      // TTL 过期但文件未变化：再 stat 一次，不重新解析。
      await new Promise((resolve) => setTimeout(resolve, 1050));
      getMarkdownScanStatus();
      expect(getMarkdownResultStatCount()).toBe(2);

      const gzipFile = path.join(store.dataDir, 'markdown-scan-result.json.gz');
      const goodBytes = readFileSync(gzipFile);

      // TTL 置 0：外部改坏文件，getStatus 立即发现 corrupted。
      process.env.STUDIANDA_RESULT_CHECK_TTL_MS = '0';
      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(gzipFile, '{broken');
      const corrupted = getMarkdownScanStatus();
      expect(corrupted.status).toBe('done');
      expect(corrupted.resultMissing).toBe(true);
      expect(corrupted.resultStale).toBe(true);
      expect(corrupted.scan).toBeNull();
      expect(corrupted.error).toContain('结果文件缺失或损坏');

      // 恢复有效 gzip：再次 getStatus 恢复可读。
      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(gzipFile, goodBytes);
      const recovered = getMarkdownScanStatus();
      expect(recovered.resultMissing).toBe(false);
      expect(recovered.resultStale).toBe(false);
      expect(recovered.scan?.notes).toHaveLength(3);

      // 删除文件：TTL 0 下一次 getStatus 即缺失。
      await new Promise((resolve) => setTimeout(resolve, 10));
      rmSync(gzipFile, { force: true });
      const deleted = getMarkdownScanStatus();
      expect(deleted.resultMissing).toBe(true);
      expect(deleted.scan).toBeNull();
    } finally {
      delete process.env.STUDIANDA_RESULT_CHECK_TTL_MS;
      store.close();
    }
  }, 20000);

  it('sidecar 校验：写成功生成正确哈希；无 sidecar 自愈；同大小替换可检出', async () => {
    const dir = makeVault('sidecar-vault', 3);
    const store = storeAt('sidecar-store');
    const sha256 = (buffer: Buffer): string =>
      createHash('sha256').update(buffer).digest('hex');
    try {
      startMarkdownScan(store, dir);
      await waitPersistedScan(store, 'done');
      const gzipFile = path.join(store.dataDir, 'markdown-scan-result.json.gz');
      const sidecarFile = `${gzipFile}.sha256`;
      const goodBytes = readFileSync(gzipFile);
      expect(existsSync(sidecarFile)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarFile, 'utf8')) as {
        sha256: string;
        size: number;
      };
      expect(sidecar.sha256).toBe(sha256(goodBytes));
      expect(sidecar.size).toBe(goodBytes.length);

      process.env.STUDIANDA_RESULT_CHECK_TTL_MS = '0';

      // 旧文件无 sidecar：getStatus 仍健康，并自动补写 sidecar。
      rmSync(sidecarFile, { force: true });
      const noSidecar = getMarkdownScanStatus();
      expect(noSidecar.resultMissing).toBe(false);
      expect(noSidecar.scan).not.toBeNull();
      expect(existsSync(sidecarFile)).toBe(true);
      expect((JSON.parse(readFileSync(sidecarFile, 'utf8')) as { sha256: string }).sha256).toBe(
        sha256(goodBytes)
      );

      // sidecar 错误但 gzip 有效：回退解压验证通过，并自愈 sidecar。
      writeFileSync(
        sidecarFile,
        JSON.stringify({ sha256: '0'.repeat(64), size: goodBytes.length })
      );
      const badSidecar = getMarkdownScanStatus();
      expect(badSidecar.resultMissing).toBe(false);
      expect(badSidecar.scan).not.toBeNull();
      expect((JSON.parse(readFileSync(sidecarFile, 'utf8')) as { sha256: string }).sha256).toBe(
        sha256(goodBytes)
      );

      // 同大小内容替换：还原 mtime，仅 ctime 变化 → 签名仍变化，sidecar 不匹配 → 检出损坏。
      const stats = statSync(gzipFile);
      const mutated = Buffer.from(goodBytes);
      mutated[mutated.length - 1] = (mutated[mutated.length - 1]! + 1) % 256;
      writeFileSync(gzipFile, mutated);
      utimesSync(gzipFile, stats.atime, stats.mtime);
      const replaced = getMarkdownScanStatus();
      expect(replaced.status).toBe('done');
      expect(replaced.resultMissing).toBe(true);
      expect(replaced.resultStale).toBe(true);
      expect(replaced.scan).toBeNull();

      // 恢复原 gzip + sidecar：再次 getStatus 恢复可读。
      writeFileSync(gzipFile, goodBytes);
      writeFileSync(sidecarFile, JSON.stringify({ sha256: sha256(goodBytes), size: goodBytes.length }));
      const recovered = getMarkdownScanStatus();
      expect(recovered.resultMissing).toBe(false);
      expect(recovered.scan?.notes).toHaveLength(3);
    } finally {
      delete process.env.STUDIANDA_RESULT_CHECK_TTL_MS;
      store.close();
    }
  }, 20000);
});
