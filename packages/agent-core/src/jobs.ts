import type { CoreApi } from './tools.js';

/**
 * MCP 侧的 ask 异步任务。
 *
 * `/chat/ask` 是同步长请求，没有 Core 任务 id；这里在 bridge 进程内保存 job 状态，
 * 让 MCP 客户端 start 后可以轮询 status / cancel。局限：bridge 重启会丢任务，
 * 属已知边界（P2 可迁到 Core job 表）。
 */
export type AskJobState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AskJobSnapshot {
  id: string;
  state: AskJobState;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

interface AskJobRecord extends AskJobSnapshot {
  owner: string;
  controller: AbortController;
}

export interface AskJobInput {
  documentId: string;
  question: string;
  page?: number;
  selection?: string;
  chatSessionId?: string;
}

const MAX_RUNNING = 4;
const MAX_KEPT = 30;
const TIMEOUT_MS = 15 * 60 * 1000;

export class AskJobManager {
  private readonly jobs = new Map<string, AskJobRecord>();

  start(api: CoreApi, input: AskJobInput, owner: string): AskJobSnapshot {
    const running = [...this.jobs.values()].filter(
      (job) => job.owner === owner && job.state === 'running'
    ).length;
    if (running >= MAX_RUNNING) {
      throw new Error(`同时最多 ${MAX_RUNNING} 个 ask 任务，请先轮询或取消已有任务。`);
    }
    const now = new Date().toISOString();
    const record: AskJobRecord = {
      id: globalThis.crypto.randomUUID(),
      owner,
      state: 'running',
      createdAt: now,
      updatedAt: now,
      controller: new AbortController()
    };
    this.jobs.set(record.id, record);
    this.trim();
    void this.run(api, record, input);
    return this.snapshot(record);
  }

  get(jobId: string, owner: string): AskJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job && job.owner === owner ? this.snapshot(job) : null;
  }

  list(owner: string): AskJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => job.owner === owner)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => this.snapshot(job));
  }

  cancel(jobId: string, owner: string): AskJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job || job.owner !== owner) return null;
    if (job.state === 'running') {
      job.controller.abort();
      job.state = 'cancelled';
      job.updatedAt = new Date().toISOString();
    }
    return this.snapshot(job);
  }

  private async run(api: CoreApi, job: AskJobRecord, input: AskJobInput): Promise<void> {
    try {
      const result = await api.request(
        'POST',
        '/chat/ask',
        {
          question: input.question,
          documentId: input.documentId,
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(input.selection !== undefined ? { selection: input.selection } : {}),
          ...(input.chatSessionId !== undefined ? { chat_session_id: input.chatSessionId } : {})
        },
        { signal: job.controller.signal, timeoutMs: TIMEOUT_MS }
      );
      if (job.state === 'cancelled') return;
      job.result = result;
      job.state = 'succeeded';
    } catch (error) {
      if (job.state === 'cancelled') return;
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.updatedAt = new Date().toISOString();
    }
  }

  private snapshot(job: AskJobRecord): AskJobSnapshot {
    return {
      id: job.id,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {})
    };
  }

  private trim(): void {
    if (this.jobs.size <= MAX_KEPT) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.state !== 'running')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const job of finished) {
      if (this.jobs.size <= MAX_KEPT) break;
      this.jobs.delete(job.id);
    }
  }
}
