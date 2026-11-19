import { describe, expect, it } from 'vitest';
import type { BookSummaryPlan, BookSummaryResult } from '@studianda/shared';
import type { RunBookSummaryOptions } from '../src/book-summary.js';
import { BookSummaryRunner } from '../src/book-summary-runner.js';
import type { ReadingChatConfig } from '../src/reading-chat.js';
import { DocumentRequestRegistry } from '../src/server/document-request-registry.js';
import type { Store } from '../src/store.js';

/**
 * `BookSummaryRunner` 状态机单测（**不经过 HTTP**）：
 * start 幂等、cancel、remove、close、并发双开（TOCTOU）、终态回写的身份比较。
 *
 * 生成计划与执行生成都注入假实现，不读 PDF、不调用模型；`store` 在本测试里从未被使用
 * （默认实现才会用到它），因此传一个空壳即可。
 */

const CONFIG: ReadingChatConfig = {
  baseUrl: 'https://model.test/v1',
  apiKey: 'k',
  model: 'summary-model'
};

const PLAN: BookSummaryPlan = {
  document_id: 'doc-1',
  document_name: '测试文献',
  total_pages: 2,
  blocks: [{ index: 0, title: '第 1–2 页', page: 1, end_page: 2, pages: 2, cached: false }],
  cached: 0,
  total: 1,
  source: 'range',
  content_version: 'v1',
  estimate: { pending_blocks: 1, calls: 1, input_tokens: 10, output_tokens: 5, model: 'summary-model' },
  book_available: false
};

const RESULT: BookSummaryResult = {
  document_id: 'doc-1',
  kind: 'book',
  content: '全书摘要',
  model: 'summary-model',
  created: '2026-11-19T00:00:00.000Z',
  content_version: 'v1',
  merge_levels: 0,
  blocks: []
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PendingRun {
  options: RunBookSummaryOptions;
  done: Deferred<BookSummaryResult>;
}

/** 假 runner：plan 可注入（默认立即返回 PLAN），run 一律挂起，由测试手动 resolve/reject。 */
function makeRunner(overrides?: {
  plan?: (documentId: string, model: string) => Promise<BookSummaryPlan>;
}) {
  const requests = new DocumentRequestRegistry();
  const planCalls: string[] = [];
  const runs: PendingRun[] = [];
  const plan = async (documentId: string, model: string): Promise<BookSummaryPlan> => {
    planCalls.push(documentId);
    if (overrides?.plan) return overrides.plan(documentId, model);
    return { ...PLAN, document_id: documentId, estimate: { ...PLAN.estimate, model } };
  };
  const run = (options: RunBookSummaryOptions): Promise<BookSummaryResult> => {
    const done = deferred<BookSummaryResult>();
    runs.push({ options, done });
    return done.promise;
  };
  const runner = new BookSummaryRunner({
    store: {} as unknown as Store,
    requests,
    plan,
    run
  });
  return { runner, requests, planCalls, runs };
}

function abortError(): Error {
  const error = new Error('已取消');
  error.name = 'AbortError';
  return error;
}

/** 等待后台 run 的 promise 链把状态写完（不依赖定时器，只让出事件循环）。 */
async function settle(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('等待状态收敛超时');
}

/** 让出若干轮事件循环（用于"旧 run 恢复后不应该发生任何回写"这类否定断言）。 */
async function flush(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('BookSummaryRunner.start（幂等）', () => {
  it('首次 start 返回 running 视图 + plan，并把 controller 登记进请求表', async () => {
    const { runner, requests, runs } = makeRunner();
    const started = await runner.start({ documentId: 'doc-1', config: CONFIG });

    expect(started.plan).toBeDefined();
    expect(started.job).toMatchObject({
      document_id: 'doc-1',
      status: 'running',
      done: 0,
      total: 1,
      phase: '准备中'
    });
    expect(started.job.started_at).toBeTruthy();
    expect(runs).toHaveLength(1);
    expect(requests.pending('doc-1')).toBe(1);

    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');
    expect(runner.view('doc-1')).toMatchObject({ status: 'done', done: 1, total: 1, phase: '已完成' });
    // 终态后 untrack：purge 不会再 aborts 已完成的任务。
    await settle(() => requests.pending('doc-1') === 0);
  });

  it('running 时重复 start 只返回 { job }：不带 plan、不再起后台 run、不抛错', async () => {
    const { runner, planCalls, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });

    const again = await runner.start({ documentId: 'doc-1', config: CONFIG });
    expect(again.job.status).toBe('running');
    expect(again.plan).toBeUndefined();
    expect(planCalls).toHaveLength(1);
    expect(runs).toHaveLength(1);

    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');
  });

  it('进度回写只改 running 的当前任务视图', async () => {
    const { runner, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });
    runs[0]!.options.onProgress?.(1, 1, '全书摘要已完成');
    expect(runner.view('doc-1')).toMatchObject({ status: 'running', done: 1, total: 1, phase: '全书摘要已完成' });
    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');
  });

  it('计划失败：撤掉 running 占位（不会永久卡住），视图回 idle 并可再次 start', async () => {
    let attempt = 0;
    const { runner, requests, planCalls, runs } = makeRunner({
      plan: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('文献不存在');
        return PLAN;
      }
    });

    await expect(runner.start({ documentId: 'doc-1', config: CONFIG })).rejects.toThrow('文献不存在');
    expect(runner.view('doc-1').status).toBe('idle');
    expect(requests.pending('doc-1')).toBe(0);

    // 占位已撤销：第二次 start 不会被"永远 running"的残留条目挡住。
    const retried = await runner.start({ documentId: 'doc-1', config: CONFIG });
    expect(retried.job.status).toBe('running');
    expect(planCalls).toHaveLength(2);
    expect(runs).toHaveLength(1);
    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');
  });
});

describe('BookSummaryRunner TOCTOU（并发双开）', () => {
  it('计划挂起期间并发两次 start：只调用一次 plan、只起一个后台 run', async () => {
    const planGate = deferred<BookSummaryPlan>();
    const { runner, planCalls, runs } = makeRunner({ plan: () => planGate.promise });

    // 第一次 start：在 await plan 之前已同步占位（修复前这里还没有条目，status 仍是 idle）。
    const first = runner.start({ documentId: 'doc-1', config: CONFIG });
    expect(runner.view('doc-1').status).toBe('running');
    expect(planCalls).toHaveLength(1);

    // 第二次 start：修复前它会再次通过 running 检查并再次 await plan（planCalls=2），
    // 最终启动第二个后台 run；修复后它直接拿到 running 视图、不带 plan。
    const second = await runner.start({ documentId: 'doc-1', config: CONFIG });
    expect(second.job.status).toBe('running');
    expect(second.plan).toBeUndefined();
    expect(planCalls).toHaveLength(1);
    expect(runs).toHaveLength(0);

    planGate.resolve(PLAN);
    const firstResult = await first;
    expect(firstResult.plan).toBeDefined();
    // 修复前这里会是 2（两个 run 同时跑同一篇文献、进度互相覆盖）。
    expect(runs).toHaveLength(1);

    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');
  });
});

describe('BookSummaryRunner.cancel', () => {
  it('没有任务时返回 idle 视图（不抛错 / 不等于 404）', () => {
    const { runner } = makeRunner();
    expect(runner.cancel('missing-doc')).toEqual({
      document_id: 'missing-doc',
      status: 'idle',
      done: 0,
      total: 0,
      phase: ''
    });
  });

  it('running：只发 abort 信号 + phase「正在取消」，终态由 run 的 catch 写回 cancelled', async () => {
    const { runner, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });

    const cancelled = runner.cancel('doc-1');
    // cancel 自己不同步改终态（既有语义）：仍显示 running，只是提示正在取消。
    expect(cancelled.status).toBe('running');
    expect(cancelled.phase).toBe('正在取消');
    expect(runs[0]!.options.signal?.aborted).toBe(true);

    runs[0]!.done.reject(abortError());
    await settle(() => runner.view('doc-1').status === 'cancelled');
    const view = runner.view('doc-1');
    expect(view).toMatchObject({ status: 'cancelled', phase: '已取消' });
    // 取消不是"失败"：不带 error 字段。
    expect('error' in view).toBe(false);
  });

  it('已终态的任务不会被 cancel 重新 abort 或改 phase', async () => {
    const { runner, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });
    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');

    expect(runner.cancel('doc-1')).toMatchObject({ status: 'done', phase: '已完成' });
    expect(runs[0]!.options.signal?.aborted).toBe(false);
  });
});

describe('BookSummaryRunner.remove（DELETE 用）', () => {
  it('running：先 abort 再摘条目；旧 run 迟到的 AbortError 不会把视图重新标成 cancelled', async () => {
    const { runner, requests, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });

    // abort 是同步派发的：若先删条目再 abort，监听器里会看到 idle。
    const viewsAtAbort: string[] = [];
    runs[0]!.options.signal?.addEventListener('abort', () => {
      viewsAtAbort.push(runner.view('doc-1').status);
    });
    runner.remove('doc-1');
    expect(viewsAtAbort).toEqual(['running']);
    expect(runs[0]!.options.signal?.aborted).toBe(true);
    expect(runner.view('doc-1').status).toBe('idle');

    runs[0]!.done.reject(abortError());
    await settle(() => requests.pending('doc-1') === 0);
    // 条目已被摘掉：旧 run 的 catch 因身份比较放弃回写，不会凭空重建一条 cancelled。
    expect(runner.view('doc-1').status).toBe('idle');
  });

  it('终态身份比较：DELETE 后立刻 start 的新任务不会被旧 run 标成 cancelled / 覆盖进度', async () => {
    const { runner, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });
    runner.remove('doc-1');
    const restarted = await runner.start({ documentId: 'doc-1', config: CONFIG });
    expect(restarted.job.status).toBe('running');
    expect(runs).toHaveLength(2);

    // 旧 run（第 0 个）在新 run 开始后才恢复：即使抛 AbortError 也不能改新 job。
    runs[0]!.options.onProgress?.(7, 9, '旧任务的进度');
    runs[0]!.done.reject(abortError());
    await flush();
    expect(runner.view('doc-1')).toMatchObject({ status: 'running', done: 0, total: 1 });

    // 新 run 正常收尾 → done。
    runs[1]!.done.resolve(RESULT);
    await settle(() => runner.view('doc-1').status === 'done');
    expect(runner.view('doc-1')).toMatchObject({ status: 'done', done: 1, phase: '已完成' });
  });
});

describe('BookSummaryRunner.close', () => {
  it('close：abort 全部在途任务、清空视图、之后 start 一律拒绝', async () => {
    const { runner, runs } = makeRunner();
    await runner.start({ documentId: 'doc-1', config: CONFIG });
    await runner.start({ documentId: 'doc-2', config: CONFIG });
    expect(runs).toHaveLength(2);

    runner.close();
    expect(runs[0]!.options.signal?.aborted).toBe(true);
    expect(runs[1]!.options.signal?.aborted).toBe(true);
    expect(runner.view('doc-1').status).toBe('idle');
    expect(runner.view('doc-2').status).toBe('idle');

    // 关闭后旧 run 恢复也不再回写（进程随即退出）。
    runs[0]!.done.resolve(RESULT);
    runs[1]!.done.reject(abortError());
    await flush();
    expect(runner.view('doc-1').status).toBe('idle');
    expect(runner.view('doc-2').status).toBe('idle');

    await expect(runner.start({ documentId: 'doc-3', config: CONFIG })).rejects.toThrow('已关闭');
    expect(runner.cancel('doc-1').status).toBe('idle');
  });
});
