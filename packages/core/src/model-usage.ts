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
  calls: number;
  estimatedCalls: number;
}

const usageStorage = new AsyncLocalStorage<UsageTotals>();

export function estimateTokens(text: string): number {
  // 中英混排的粗略估算：约 2 字符 ≈ 1 token；只用于“估算”展示，不作为计费依据。
  return Math.max(1, Math.ceil(text.length / 2));
}

/** 由 callChatModel 在每次成功调用后上报；不在收集上下文里时静默忽略。 */
export function recordModelUsage(
  inputText: string,
  outputText: string,
  actual: { input: number; output: number } | null
): void {
  const totals = usageStorage.getStore();
  if (!totals) return;
  totals.calls += 1;
  const estimatedInput = estimateTokens(inputText);
  const estimatedOutput = estimateTokens(outputText);
  if (actual && (actual.input > 0 || actual.output > 0)) {
    totals.input += actual.input > 0 ? actual.input : estimatedInput;
    totals.output += actual.output > 0 ? actual.output : estimatedOutput;
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
  const totals: UsageTotals = { input: 0, output: 0, calls: 0, estimatedCalls: 0 };
  const result = await usageStorage.run(totals, fn);
  if (totals.calls === 0) return { result };
  return {
    result,
    usage: {
      input_tokens: totals.input,
      output_tokens: totals.output,
      total_tokens: totals.input + totals.output,
      calls: totals.calls,
      estimated: totals.estimatedCalls > 0
    }
  };
}
