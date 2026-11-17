import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatUsage } from '@studianda/shared';

/**
 * 单轮回答的模型 token 用量收集。
 *
 * 用 AsyncLocalStorage 包住整轮 `answerQuestion`，阅读链路里所有内部 callChatModel
 * （规划/批次/综合/审计/修订）都不会漏；供应商返回 usage 时用真实值，没返回时按字符估算
 * 并标记 estimated（界面明确写“估算”，不假装账单）。
 */

interface UsageTotals {
  input: number;
  output: number;
  /** 输入中命中上下文缓存的部分（已包含在 input 里）。 */
  cached: number;
  /** 输出中用于思维链的部分（已包含在 output 里）。 */
  reasoning: number;
  calls: number;
  estimatedCalls: number;
}

const usageStorage = new AsyncLocalStorage<UsageTotals>();

/**
 * 最近若干次调用的实测吞吐（token/秒）。
 *
 * 用途只有一个：给用户估"这一轮大概要等多久"。**没有样本就不估**——
 * 拿一个凭空假设的常数当"估算"比不给更糟：它会被当成事实。
 */
const THROUGHPUT_SAMPLES = 20;
const throughputs: number[] = [];

function observeThroughput(tokens: number, elapsedMs: number): void {
  const perSecond = (tokens / elapsedMs) * 1000;
  if (!Number.isFinite(perSecond) || perSecond <= 0) return;
  throughputs.push(perSecond);
  if (throughputs.length > THROUGHPUT_SAMPLES) throughputs.shift();
}

/** 实测吞吐的中位数与样本数；样本不足（<3）时返回 null。 */
export function observedThroughput(): { tokensPerSecond: number; samples: number } | null {
  if (throughputs.length < 3) return null;
  const sorted = [...throughputs].sort((left, right) => left - right);
  return {
    tokensPerSecond: sorted[Math.floor(sorted.length / 2)] ?? 0,
    samples: throughputs.length
  };
}

/** 只给测试用：清空吞吐样本。 */
export function resetThroughputSamples(): void {
  throughputs.length = 0;
}

/**
 * 已观测到的思维链 token 分布（用于自适应预留）。
 *
 * 预留给"思考"的输出空间不能是固定常数：同一平台不同模型的思维链长度差十倍。
 * 取最近若干次的 p90 × 1.2 作为预留；样本不足时返回 null，调用方退回平台常量。
 */
const reasoningSamples: number[] = [];

export function recordReasoningTokens(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  reasoningSamples.push(Math.trunc(tokens));
  if (reasoningSamples.length > THROUGHPUT_SAMPLES) reasoningSamples.shift();
}

export function observedReasoningTokens(): { p90: number; samples: number } | null {
  if (reasoningSamples.length < 3) return null;
  const sorted = [...reasoningSamples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
  return { p90: sorted[index] ?? 0, samples: reasoningSamples.length };
}

/** 只给测试用：清空思维链样本。 */
export function resetReasoningSamples(): void {
  reasoningSamples.length = 0;
}

export function estimateTokens(text: string): number {
  // 中英混排的粗略估算：约 2 字符 ≈ 1 token；只用于“估算”展示，不作为计费依据。
  return Math.max(1, Math.ceil(text.length / 2));
}

/** 由 callChatModel 在每次成功调用后上报；不在收集上下文里时静默忽略。 */
export function recordModelUsage(
  inputText: string,
  outputText: string,
  actual: { input: number; output: number; cached?: number; reasoning?: number } | null,
  /** 本次调用耗时（毫秒）；用于给用户估"大概要等多久"。 */
  elapsedMs?: number
): void {
  const tokens =
    actual && (actual.input > 0 || actual.output > 0)
      ? actual.input + actual.output
      : estimateTokens(inputText) + estimateTokens(outputText);
  if (typeof elapsedMs === 'number' && elapsedMs > 0 && tokens > 0) {
    observeThroughput(tokens, elapsedMs);
  }
  const totals = usageStorage.getStore();
  if (!totals) return;
  totals.calls += 1;
  const estimatedInput = estimateTokens(inputText);
  const estimatedOutput = estimateTokens(outputText);
  if (actual && (actual.input > 0 || actual.output > 0)) {
    totals.input += actual.input > 0 ? actual.input : estimatedInput;
    totals.output += actual.output > 0 ? actual.output : estimatedOutput;
    // 缓存命中只可能来自供应商返回的真实 usage；缺 usage 的调用不计入。
    totals.cached += Math.max(0, actual.cached ?? 0);
    // 思维链 token 已包含在 output 里，这里只是单独记一份给用户看。
    totals.reasoning += Math.max(0, actual.reasoning ?? 0);
    // 只有“有 usage 的调用”与“缺 usage 的调用”混在一起时才标记估算。
    if (actual.input <= 0 || actual.output <= 0) totals.estimatedCalls += 1;
  } else {
    totals.input += estimatedInput;
    totals.output += estimatedOutput;
    totals.estimatedCalls += 1;
  }
}

/** 包住一轮回答，收集其中所有模型调用的 token 用量。 */
export async function collectModelUsage<T>(
  fn: () => Promise<T>
): Promise<{ result: T; usage?: ChatUsage }> {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    calls: 0,
    estimatedCalls: 0
  };
  const result = await usageStorage.run(totals, fn);
  if (totals.calls === 0) return { result };
  return {
    result,
    usage: {
      input_tokens: totals.input,
      output_tokens: totals.output,
      total_tokens: totals.input + totals.output,
      // 0 命中时不写该字段：没有缓存字段的供应商，界面不该多一行“缓存命中 0”。
      ...(totals.cached > 0 ? { cached_tokens: totals.cached } : {}),
      // 同理：完全不思考的轮次不写 reasoning_tokens，界面不该多一行“思考 0”。
      ...(totals.reasoning > 0 ? { reasoning_tokens: totals.reasoning } : {}),
      calls: totals.calls,
      estimated: totals.estimatedCalls > 0
    }
  };
}
