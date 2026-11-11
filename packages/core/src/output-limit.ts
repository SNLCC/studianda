import { officialModelMetadata } from './model-metadata.js';

/**
 * 各链路在「官方没登记最大输出」时沿用的任务上限。
 * 这些值就是改动前写死在请求体里的数字：官方元数据缺失时行为必须与历史完全一致。
 */
export const TASK_MAX_TOKENS = {
  /** 整页/整篇翻译：每段一次请求。 */
  translation: 4096,
  /** 视觉读页：只回一段 JSON（图表/公式解读）。 */
  visualReading: 2048,
  /** vision 方式识别整页文字。 */
  ocrVision: 8192,
  /** vision 方式识别框选区域（单块裁图）。 */
  ocrRegionVision: 4096,
  /** 语音转写纠错：只校正一段文字，不回答问题。 */
  speechCorrection: 4096
} as const;

/** 官方最大输出的合理范围：太小/越界视为没登记，不拿它去压任务上限。 */
const MIN_OFFICIAL_MAX_OUTPUT = 64;
const MAX_OFFICIAL_MAX_OUTPUT = 8_000_000;

function validOfficialMaxOutput(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_OFFICIAL_MAX_OUTPUT &&
    value <= MAX_OFFICIAL_MAX_OUTPUT
    ? value
    : undefined;
}

/**
 * 官方文档登记的最大输出（token）。
 *
 * 只认 `model-metadata.ts` 里人工核对过、带官方来源链接与快照日期的条目：
 * 不抓网页、不按模型名猜测、不引入第三方数据。未登记/值非法返回 undefined。
 */
export function officialModelMaxOutput(baseUrl: string, model: string): number | undefined {
  const official = officialModelMetadata(baseUrl ?? '', (model ?? '').trim());
  return validOfficialMaxOutput(official?.maxOutput);
}

/**
 * 单次请求的输出上限：`min(任务上限, 官方最大输出)`。
 *
 * 官方没登记（或值非法）时原样返回任务上限 —— 和改动前的写死值一样，
 * 请求里永远是一个确定的正整数，不会因为元数据缺失而报错或留空。
 */
export function requestMaxTokens(taskCap: number, officialMaxOutput?: number): number {
  const cap = Number.isInteger(taskCap) && taskCap > 0 ? taskCap : TASK_MAX_TOKENS.translation;
  const official = validOfficialMaxOutput(officialMaxOutput);
  return official === undefined ? cap : Math.min(cap, official);
}

/** 便捷版本：按连接地址 + 模型名查官方快照后再取 min。 */
export function requestMaxTokensFor(taskCap: number, baseUrl: string, model: string): number {
  return requestMaxTokens(taskCap, officialModelMaxOutput(baseUrl, model));
}
