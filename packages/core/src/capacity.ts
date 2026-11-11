/**
 * 阅读容量设置的读取、并发上限与输入预算计算。
 *
 * 设置键（四个数字，全部由用户在本机设置里填写）：
 * - `reading.max_parallel`：同一批独立任务最多几个模型调用在飞；0 = 自动（0-8）；
 * - `reading.max_read_batches`：一次提问最多新增多少批阅读；到上限后剩余页保存为
 *   「继续阅读」，**不抽样**（1-64，默认 12）；
 * - `reading.context_window`：模型上下文窗口（token，8192-4000000，默认 65536）——
 *   用来限制一次送入模型的最大材料量；
 * - `reading.output_reserve`：每次输出预留（token，512-32768，默认 4096）——
 *   必须小于上下文窗口的一半，否则回退默认值。
 *
 * 这里只做解析与钳制，**不抛错**：设置是用户手填的字符串，坏值不能让阅读直接失败；
 * 认不出来就退回默认值（设置由用户手填，读取侧必须宽容）。
 */

/** 并发上限的硬上限：再高收益基本吃尽，只会更容易触发平台限流（MAX_WORKERS）。 */
export const MAX_WORKERS = 8;
/** 远程服务的自动并发：实测 4 是收益拐点（DEFAULT_REMOTE_WORKERS）。 */
export const DEFAULT_REMOTE_WORKERS = 4;
/** 自动并发（用户没填）的取值。 */
export const DEFAULT_MAX_PARALLEL = 0;
/** 单轮批次上限的默认值。 */
export const DEFAULT_MAX_BATCHES = 12;
/** 单轮批次上限的硬上限。 */
export const MAX_READ_BATCHES = 64;

/** 上下文窗口默认值与允许范围（token）。 */
export const DEFAULT_CONTEXT_WINDOW = 65536;
export const MIN_CONTEXT_WINDOW = 8192;
export const MAX_CONTEXT_WINDOW = 4_000_000;
/** 输出预留默认值与允许范围（token）。 */
export const DEFAULT_OUTPUT_RESERVE = 4096;
export const MIN_OUTPUT_RESERVE = 512;
export const MAX_OUTPUT_RESERVE = 32768;
/** 输入预算的下限（token）：再小也放不下哪怕一批正文。 */
export const MIN_INPUT_BUDGET = 1024;

export interface ReadingCapacity {
  maxParallel: number;
  maxReadBatches: number;
  contextWindow: number;
  outputReserve: number;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 读设置里的阅读容量；坏字符串/缺省/越界都落到默认值或边界，不抛错。
 *
 * 输出预留额外受一条硬约束：必须小于上下文窗口的一半（否则模型没有足够空间同时
 * 容纳材料与输出）。用户填了不合法的组合时退回默认预留，并保证退回后的值仍满足约束。
 */
export function readCapacity(
  settings: Readonly<Record<string, unknown>> | null | undefined
): ReadingCapacity {
  const source = settings ?? {};
  const rawParallel = numberFrom(source['reading.max_parallel']);
  const maxParallel =
    rawParallel === null
      ? DEFAULT_MAX_PARALLEL
      : clamp(Math.trunc(rawParallel), 0, MAX_WORKERS);
  const rawBatches = numberFrom(source['reading.max_read_batches']);
  const maxReadBatches =
    rawBatches === null
      ? DEFAULT_MAX_BATCHES
      : clamp(Math.trunc(rawBatches), 1, MAX_READ_BATCHES);
  const rawContext = numberFrom(source['reading.context_window']);
  const contextWindow =
    rawContext === null
      ? DEFAULT_CONTEXT_WINDOW
      : clamp(Math.trunc(rawContext), MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
  const rawReserve = numberFrom(source['reading.output_reserve']);
  let outputReserve =
    rawReserve === null
      ? DEFAULT_OUTPUT_RESERVE
      : clamp(Math.trunc(rawReserve), MIN_OUTPUT_RESERVE, MAX_OUTPUT_RESERVE);
  if (outputReserve * 2 >= contextWindow) {
    // 回退默认值，并且当窗口很小时（例如 8192）把默认值也压到窗口一半以下。
    outputReserve = Math.max(
      MIN_OUTPUT_RESERVE,
      Math.min(DEFAULT_OUTPUT_RESERVE, Math.floor(contextWindow / 2) - 1)
    );
  }
  return { maxParallel, maxReadBatches, contextWindow, outputReserve };
}

/**
 * 这一轮最多能塞进模型多少材料（token）。
 *
 * 先扣掉输出预留，再留 1024 token 给提示词与协议开销；下限 1024，避免负值或空预算
 * 让阅读链路直接卡死。阅读链路据此压缩"派生分析"（批次分析、合并摘要等），
 * **逐字证据不参与压缩**。
 */
export function inputBudget(
  capacity: Pick<ReadingCapacity, 'contextWindow' | 'outputReserve'>
): number {
  return Math.max(
    MIN_INPUT_BUDGET,
    capacity.contextWindow - capacity.outputReserve - 1024
  );
}

/**
 * 带「模型容量覆盖」的输入预算：
 * 模型给的合法 contextWindow / outputReserve 覆盖全局值，其余规则不变
 * （先扣输出预留、再留 1024 协议开销、下限 1024）；越界值忽略、退回全局。
 */
export function inputBudgetFor(
  capacity: Pick<ReadingCapacity, 'contextWindow' | 'outputReserve'>,
  overrideContextWindow?: number,
  overrideOutputReserve?: number
): number {
  const override = numberFrom(overrideContextWindow);
  const contextWindow =
    override !== null &&
    Number.isInteger(override) &&
    override >= MIN_CONTEXT_WINDOW &&
    override <= MAX_CONTEXT_WINDOW
      ? override
      : capacity.contextWindow;
  const reserve = numberFrom(overrideOutputReserve);
  const outputReserve =
    reserve !== null && reserve >= MIN_OUTPUT_RESERVE && reserve <= MAX_OUTPUT_RESERVE
      ? reserve
      : capacity.outputReserve;
  return inputBudget({ contextWindow, outputReserve });
}

function hostnameOf(baseUrl: unknown): string {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) return '';
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
  // URL API 会保留 IPv6 的方括号；这里去掉方括号后返回。
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

/**
 * 这一轮实际用几个并发 worker：
 * - 用户显式填了 >0：用它，但不超过 MAX_WORKERS；
 * - 否则本机/局域网（localhost、127.0.0.1、::1、*.local）按 1——瓶颈是 CPU/GPU，
 *   并发只会互相拖慢；
 * - 其余（远程服务）按 4（实测收益拐点；8 与 4 同速，只会更容易触发限流）。
 *
 * 并发只改变耗时：调用次数、批数与证据条数在任何取值下都完全相同。
 */
export function gotoWorkers(baseUrl: unknown, maxParallel: number): number {
  const chosen = numberFrom(maxParallel);
  if (chosen !== null && chosen > 0) {
    return clamp(Math.trunc(chosen), 1, MAX_WORKERS);
  }
  const host = hostnameOf(baseUrl);
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return 1;
  }
  return DEFAULT_REMOTE_WORKERS;
}
