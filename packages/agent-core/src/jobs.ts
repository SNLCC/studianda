import type { CoreApi } from './tools.js';

/**
 * MCP 侧的 ask 异步任务：状态持久化在 Core `agent_jobs` 表，执行仍在 bridge。
 *
 * - bridge 重启后，已完成的 job 仍可通过 status 查到结果；
 * - 执行中的 job 在 Core 启动时会被标成 interrupted（不会永久 running）；
 * - `/chat/ask` 是同步长请求，所以用本地 AbortController 配合 Core 的 cancel 状态。
 */
export type AskJobState =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_confirmation'
  | 'interrupted'
  | string;

export interface AskJobSnapshot {
  id: string;
  state: AskJobState;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

export interface AskJobInput {
  documentId: string;
  question: string;
  page?: number;
  selection?: string;
  chatSessionId?: string;
}

export interface OcrJobInput {
  documentId: string;
  pages?: number[];
  force?: boolean;
  scale?: number;
}

export interface CorpusAskInput {
  documentId: string;
  question: string;
  projectId?: string;
  documentIds?: string[];
  includeMemory?: boolean;
}

export interface EmbedJobInput {
  documentId?: string;
}

interface RemoteJob {
  id?: unknown;
  status?: unknown;
  created?: unknown;
  updated?: unknown;
  finishedAt?: unknown;
  result?: unknown;
  error?: unknown;
}

const TIMEOUT_MS = 15 * 60 * 1000;

function toSnapshot(row: unknown): AskJobSnapshot {
  const job = (row ?? {}) as RemoteJob;
  const state = typeof job.status === 'string' ? job.status : 'running';
  return {
    id: String(job.id ?? ''),
    state,
    createdAt: String(job.created ?? ''),
    updatedAt: String(job.updated ?? job.created ?? ''),
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(typeof job.error === 'string' ? { error: job.error } : {})
  };
}

export class AskJobManager {
  private readonly controllers = new Map<string, AbortController>();

  async start(api: CoreApi, input: AskJobInput, owner: string): Promise<AskJobSnapshot> {
    const created = await api.request('POST', '/agent/jobs', {
      kind: 'ask',
      agentName: owner,
      documentId: input.documentId,
      question: input.question,
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
      ...(input.chatSessionId !== undefined
        ? { chat_session_id: input.chatSessionId }
        : {})
    });
    const snapshot = toSnapshot(created);
    const controller = new AbortController();
    this.controllers.set(snapshot.id, controller);
    void this.run(api, snapshot.id, owner, input, controller);
    return snapshot;
  }

  async startCorpusAsk(
    api: CoreApi,
    input: CorpusAskInput,
    owner: string
  ): Promise<AskJobSnapshot> {
    const created = await api.request('POST', '/agent/jobs', {
      kind: 'corpus_ask',
      agentName: owner,
      documentId: input.documentId,
      question: input.question,
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.documentIds && input.documentIds.length > 0
        ? { document_ids: input.documentIds }
        : {}),
      ...(input.includeMemory ? { include_memory: true } : {})
    });
    const snapshot = toSnapshot(created);
    const controller = new AbortController();
    this.controllers.set(snapshot.id, controller);
    void this.runCorpus(api, snapshot.id, owner, input, controller);
    return snapshot;
  }

  async startEmbed(
    api: CoreApi,
    input: EmbedJobInput,
    owner: string
  ): Promise<AskJobSnapshot> {
    const created = await api.request('POST', '/agent/jobs', {
      kind: 'embed',
      agentName: owner,
      ...(input.documentId ? { documentId: input.documentId } : {})
    });
    const snapshot = toSnapshot(created);
    const controller = new AbortController();
    this.controllers.set(snapshot.id, controller);
    void this.runEmbed(api, snapshot.id, owner, input, controller);
    return snapshot;
  }

  async startOcr(api: CoreApi, input: OcrJobInput, owner: string): Promise<AskJobSnapshot> {    const created = await api.request('POST', '/agent/jobs', {
      kind: 'ocr',
      agentName: owner,
      documentId: input.documentId,
      ...(input.pages && input.pages.length > 0 ? { pages: input.pages } : {}),
      ...(input.force === true ? { force: true } : {}),
      ...(input.scale !== undefined ? { scale: input.scale } : {})
    });
    const snapshot = toSnapshot(created);
    const controller = new AbortController();
    this.controllers.set(snapshot.id, controller);
    void this.runOcr(api, snapshot.id, owner, input, controller);
    return snapshot;
  }

  async get(api: CoreApi, jobId: string, owner: string): Promise<AskJobSnapshot> {    const row = await api.request(
      'GET',
      `/agent/jobs/${encodeURIComponent(jobId)}?agent=${encodeURIComponent(owner)}`
    );
    return toSnapshot(row);
  }

  async list(api: CoreApi, owner: string): Promise<AskJobSnapshot[]> {
    const rows = await api.request<unknown[]>(
      'GET',
      `/agent/jobs?agent=${encodeURIComponent(owner)}&limit=20`
    );
    return (Array.isArray(rows) ? rows : []).map(toSnapshot);
  }

  async cancel(api: CoreApi, jobId: string, owner: string): Promise<AskJobSnapshot> {
    this.controllers.get(jobId)?.abort();
    this.controllers.delete(jobId);
    const row = await api.request('POST', `/agent/jobs/${encodeURIComponent(jobId)}/cancel`, {
      agentName: owner
    });
    return toSnapshot(row);
  }

  private async runEmbed(
    api: CoreApi,
    jobId: string,
    owner: string,
    input: EmbedJobInput,
    controller: AbortController
  ): Promise<void> {
    const finish = async (
      status: 'succeeded' | 'failed' | 'cancelled',
      result?: unknown,
      error?: string
    ): Promise<void> => {
      try {
        await api.request('POST', `/agent/jobs/${encodeURIComponent(jobId)}/finish`, {
          agentName: owner,
          status,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {})
        });
      } catch {
        // Core 已退出：下次启动会标 interrupted。
      }
    };
    try {
      const result = await api.request(
        'POST',
        '/embeddings/index',
        input.documentId ? { documentId: input.documentId } : {},
        { signal: controller.signal, timeoutMs: 20 * 60 * 1000 }
      );
      if (controller.signal.aborted) {
        await finish('cancelled');
        return;
      }
      await finish('succeeded', result);
    } catch (error) {
      if (controller.signal.aborted) {
        await finish('cancelled');
        return;
      }
      await finish(
        'failed',
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async runOcr(
    api: CoreApi,
    jobId: string,
    owner: string,
    input: OcrJobInput,
    controller: AbortController
  ): Promise<void> {
    const finish = async (
      status: 'succeeded' | 'failed' | 'cancelled',
      result?: unknown,
      error?: string
    ): Promise<void> => {
      try {
        await api.request('POST', `/agent/jobs/${encodeURIComponent(jobId)}/finish`, {
          agentName: owner,
          status,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {})
        });
      } catch {
        // Core 已退出：下次启动会标 interrupted。
      }
    };
    try {
      const document = await api.request<{ pages?: unknown }>(
        'GET',
        `/documents/${encodeURIComponent(input.documentId)}`
      );
      const totalPages = Math.max(1, Number(document?.pages ?? 1));
      let candidates = input.pages?.filter((page) => Number.isInteger(page) && page >= 1);
      if (!candidates || candidates.length === 0) {
        candidates = Array.from({ length: totalPages }, (_, index) => index + 1);
      }
      const done: number[] = [];
      const skipped: number[] = [];
      const failed: Array<{ page: number; error: string }> = [];
      for (const page of candidates) {
        if (controller.signal.aborted) {
          await finish('cancelled');
          return;
        }
        const existing = await api.request<{ text?: unknown; origin?: unknown }>(
          'GET',
          `/documents/${encodeURIComponent(input.documentId)}/pages/${page}/text`,
          undefined,
          { signal: controller.signal }
        );
        const hasOcr = existing?.origin === 'ocr';
        const hasText = typeof existing?.text === 'string' && existing.text.trim().length > 0;
        if (hasOcr && input.force !== true) {
          skipped.push(page);
          continue;
        }
        if (!hasOcr && hasText && input.force !== true) {
          skipped.push(page);
          continue;
        }
        try {
          await api.request(
            'POST',
            `/documents/${encodeURIComponent(input.documentId)}/ocr/pages/${page}`,
            { scale: input.scale ?? 2 },
            { signal: controller.signal, timeoutMs: 5 * 60 * 1000 }
          );
          done.push(page);
        } catch (error) {
          if (controller.signal.aborted) {
            await finish('cancelled');
            return;
          }
          failed.push({
            page,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (controller.signal.aborted) {
        await finish('cancelled');
        return;
      }
      await finish('succeeded', {
        documentId: input.documentId,
        pages: candidates,
        done,
        skipped,
        failed
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await finish('cancelled');
        return;
      }
      await finish(
        'failed',
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async runCorpus(
    api: CoreApi,
    jobId: string,
    owner: string,
    input: CorpusAskInput,
    controller: AbortController
  ): Promise<void> {
    const finish = async (
      status: 'succeeded' | 'failed' | 'cancelled' | 'needs_confirmation',
      result?: unknown,
      error?: string
    ): Promise<void> => {
      try {
        await api.request('POST', `/agent/jobs/${encodeURIComponent(jobId)}/finish`, {
          agentName: owner,
          status,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {})
        });
      } catch {
        // Core 已退出时 finish 失败：任务会在下次 Core 启动时标 interrupted。
      }
    };
    try {
      const result = await api.request(
        'POST',
        '/chat/ask',
        {
          question: input.question,
          documentId: input.documentId,
          reading_scope: 'corpus',
          ...(input.projectId
            ? { projectId: input.projectId }
            : { scope_documents: input.documentIds ?? [] }),
          ...(input.includeMemory ? { include_memory: true } : {})
        },
        { signal: controller.signal, timeoutMs: TIMEOUT_MS }
      );
      if (controller.signal.aborted) return;
      const needsConfirmation =
        result !== null &&
        typeof result === 'object' &&
        (result as { needs_confirmation?: unknown }).needs_confirmation === true;
      await finish(needsConfirmation ? 'needs_confirmation' : 'succeeded', result);
    } catch (error) {
      if (controller.signal.aborted) {
        await finish('cancelled');
        return;
      }
      await finish(
        'failed',
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async run(
    api: CoreApi,
    jobId: string,
    owner: string,
    input: AskJobInput,
    controller: AbortController
  ): Promise<void> {
    const finish = async (
      status: 'succeeded' | 'failed' | 'cancelled' | 'needs_confirmation',
      result?: unknown,
      error?: string
    ): Promise<void> => {
      try {
        await api.request('POST', `/agent/jobs/${encodeURIComponent(jobId)}/finish`, {
          agentName: owner,
          status,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {})
        });
      } catch {
        // Core 已退出时 finish 失败：任务会在下次 Core 启动时标 interrupted。
      }
    };
    try {
      const result = await api.request(
        'POST',
        '/chat/ask',
        {
          question: input.question,
          documentId: input.documentId,
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(input.selection !== undefined ? { selection: input.selection } : {}),
          ...(input.chatSessionId !== undefined
            ? { chat_session_id: input.chatSessionId }
            : {})
        },
        { signal: controller.signal, timeoutMs: TIMEOUT_MS }
      );
      if (controller.signal.aborted) return;
      const needsConfirmation =
        result !== null &&
        typeof result === 'object' &&
        (result as { needs_confirmation?: unknown }).needs_confirmation === true;
      await finish(needsConfirmation ? 'needs_confirmation' : 'succeeded', result);
    } catch (error) {
      if (controller.signal.aborted) {
        await finish('cancelled');
        return;
      }
      await finish(
        'failed',
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.controllers.delete(jobId);
    }
  }
}
