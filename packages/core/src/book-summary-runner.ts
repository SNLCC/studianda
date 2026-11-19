import type { BookSummaryJob, BookSummaryPlan, BookSummaryResult } from '@studianda/shared';
import {
  bookSummaryPlan,
  runBookSummary,
  type RunBookSummaryOptions
} from './book-summary.js';
import type { ReadingChatConfig } from './reading-chat.js';
import type { DocumentRequestRegistry } from './server/document-request-registry.js';
import type { Store } from './store.js';

/**
 * 全书摘要长任务运行器（每个 server 实例一份，由 `buildServer` 创建后注入路由模块）。
 *
 * 为什么独立成类：全书摘要是有状态机的长任务（idle/running/done/error/cancelled），
 * 有单并发、取消、可恢复（缓存落库在 `book_summary` 表，重启后视图回 idle 但缓存可用）。
 * 把状态收进对象后，路由模块只做 transport，不再共享 `buildServer` 闭包里的可变 Map。
 * 参照 `note-asset-reindexer.ts` 的"状态收进对象"；但它**不进 Store**：Store 不该知道
 * AbortController/HTTP 任务，且它的生命周期是 server 实例而不是数据库。
 *
 * 与 `DocumentRequestRegistry` 的分工：本运行器只把 controller **登记**进请求表（purge /
 * 清空数据时能被中止），登记表本身不归本类所有，也不代它 abort。
 *
 * 约束（后人不要改坏）：
 * 1. **同步占位在 `await plan` 之前**：并发 start 只有第一个能占到 running 占位，第二个
 *    直接返回当前视图（不带 plan、不 409、不再起后台 run）。这是原实现 TOCTOU 双开的修复点。
 * 2. **终态回写用身份比较**（`this.jobs.get(id) !== job`）：DELETE 后立刻 start 的新任务
 *    不会被旧 run 的 catch/done 覆盖成 cancelled/done。
 * 3. **取消只发信号**：`cancel` 只 abort + 把 phase 改"正在取消"，终态由 run 自己写回。
 * 4. 任务条目里不再保存 `content`（原 `BookSummaryRunJob.content` 无任何读者，白留整篇摘要）。
 */
interface BookSummaryRunJob extends BookSummaryJob {
  controller: AbortController;
}

export interface BookSummaryRunnerDeps {
  store: Store;
  /** purge / 清空数据时的中止通道：start 时把 controller 登记进去。 */
  requests: DocumentRequestRegistry;
  /** 生成计划（异步、只读本地目录与缓存，不调用模型）；默认 `bookSummaryPlan`，测试可注入。 */
  plan?: (documentId: string, model: string) => Promise<BookSummaryPlan>;
  /** 执行生成；默认 `runBookSummary`，测试可注入以避免调用模型。 */
  run?: (options: RunBookSummaryOptions) => Promise<BookSummaryResult>;
}

/** start 的返回：幂等命中（已在跑）时只有 job；新开任务时附带 plan（既有行为）。 */
export interface BookSummaryStartResult {
  job: BookSummaryJob;
  plan?: BookSummaryPlan;
}

export class BookSummaryRunner {
  private readonly jobs = new Map<string, BookSummaryRunJob>();
  private readonly store: Store;
  private readonly requests: DocumentRequestRegistry;
  private readonly plan: (documentId: string, model: string) => Promise<BookSummaryPlan>;
  private readonly run: (options: RunBookSummaryOptions) => Promise<BookSummaryResult>;
  private closed = false;

  constructor(deps: BookSummaryRunnerDeps) {
    this.store = deps.store;
    this.requests = deps.requests;
    this.plan = deps.plan ?? ((documentId, model) => bookSummaryPlan(deps.store, documentId, model));
    this.run = deps.run ?? runBookSummary;
  }

  /**
   * 进度视图（无任务时 status/phase 为 idle，与拆分前 `bookSummaryJobView` 一致）。
   * 返回新对象，调用方改不到内部状态。
   */
  view(documentId: string): BookSummaryJob {
    const job = this.jobs.get(documentId);
    if (!job) {
      return { document_id: documentId, status: 'idle', done: 0, total: 0, phase: '' };
    }
    return {
      document_id: job.document_id,
      status: job.status,
      done: job.done,
      total: job.total,
      phase: job.phase,
      ...(job.error ? { error: job.error } : {}),
      ...(job.started_at ? { started_at: job.started_at } : {}),
      ...(job.finished_at ? { finished_at: job.finished_at } : {})
    };
  }

  /**
   * 开始生成（幂等）：同一文献 running 时只返回 `{ job }`（不带 plan、不抛错）。
   * 计划阶段失败（文献被删/无可用页面）时撤掉占位并原样抛错，视图回到 idle。
   */
  async start(input: {
    documentId: string;
    config: ReadingChatConfig;
  }): Promise<BookSummaryStartResult> {
    if (this.closed) throw new Error('全书摘要运行器已关闭，拒绝开始新任务');
    const { documentId, config } = input;
    const existing = this.jobs.get(documentId);
    if (existing?.status === 'running') return { job: this.view(documentId) };

    // TOCTOU 修复：占位必须在 `await this.plan(...)` 之前同步写入，否则并发两次 start
    // 都会通过上面的检查，最后起两个后台 run 跑同一篇文献（双倍模型开销 + 进度互相覆盖）。
    const controller = new AbortController();
    const job: BookSummaryRunJob = {
      document_id: documentId,
      status: 'running',
      done: 0,
      total: 0,
      phase: '准备中',
      started_at: new Date().toISOString(),
      controller
    };
    this.jobs.set(documentId, job);
    const untrack = this.requests.track([documentId], controller);

    let plan: BookSummaryPlan;
    try {
      plan = await this.plan(documentId, config.model);
    } catch (error) {
      // 计划失败：撤掉占位，保持"失败后视图回 idle"的既有行为（否则该文献永久 running）。
      if (this.jobs.get(documentId) === job) this.jobs.delete(documentId);
      untrack();
      throw error;
    }
    // 计划期间可能被 DELETE 摘掉条目：条目已经不是本次 start 的就不要再启动生成。
    if (this.jobs.get(documentId) !== job) {
      untrack();
      return { job: this.view(documentId), plan };
    }
    job.total = plan.total;
    void this.runJob(documentId, job, config, untrack, plan.total);
    return { job: this.view(documentId), plan };
  }

  /**
   * 只发取消信号（保持既有语义）：abort 控制器 + phase='正在取消'；终态由后台 run 的
   * catch 写回。文档不存在/没有任务时返回 idle 视图，**不返回 404**。
   */
  cancel(documentId: string): BookSummaryJob {
    const job = this.jobs.get(documentId);
    if (job?.status === 'running') {
      job.controller.abort();
      job.phase = '正在取消';
    }
    return this.view(documentId);
  }

  /**
   * DELETE 用：先 abort（在途 run 收到停止信号）、再移除条目。缓存清理仍由路由调用
   * `resetBookSummary`（职责不变）。顺序反了会留下"已删缓存但任务还活着"的孤儿 run。
   */
  remove(documentId: string): void {
    const job = this.jobs.get(documentId);
    if (job?.status === 'running') job.controller.abort();
    this.jobs.delete(documentId);
  }

  /**
   * 关闭：abort 全部在途任务 + 清空条目 + 拒绝后续 start。
   * 后台 run 恢复时通过 `closed`/身份比较放弃回写（进程随即 exit，不再写已关闭的 store）。
   */
  close(): void {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
  }

  /** 后台生成：进度与终态都只在"条目仍是本次 job"时回写（身份比较）。 */
  private async runJob(
    documentId: string,
    job: BookSummaryRunJob,
    config: ReadingChatConfig,
    untrack: () => void,
    total: number
  ): Promise<void> {
    try {
      await this.run({
        store: this.store,
        config,
        documentId,
        signal: job.controller.signal,
        onProgress: (done, nextTotal, phase) => {
          const current = this.jobs.get(documentId);
          if (current !== job || current.status !== 'running') return;
          current.done = done;
          current.total = nextTotal;
          current.phase = phase;
        }
      });
      if (this.closed || this.jobs.get(documentId) !== job) return;
      job.status = 'done';
      job.done = total;
      job.total = total;
      job.phase = '已完成';
      job.finished_at = new Date().toISOString();
    } catch (error) {
      if (this.closed || this.jobs.get(documentId) !== job) return;
      const aborted =
        job.controller.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError';
      job.status = aborted ? 'cancelled' : 'error';
      job.phase = aborted ? '已取消' : '生成失败';
      job.error = aborted ? undefined : error instanceof Error ? error.message : '生成失败';
      job.finished_at = new Date().toISOString();
    } finally {
      untrack();
    }
  }
}
