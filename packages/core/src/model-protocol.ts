/**
 * 模型协议兼容层：只认标准 Chat Completions 字段，不猜厂商私有格式。
 */

/** 服务返回了结构不合规的内容（不是网络/HTTP 错误）。 */
export class ModelResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResponseFormatError';
  }
}

/** 把非流式响应解析成正文；content 数组、截断、拒答、只有推理都如实报错。 */
export function responseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    throw new ModelResponseFormatError('服务未返回 JSON 对象。');
  }
  const rows = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ModelResponseFormatError(
      '服务未返回 choices；请选择兼容 Chat Completions 的会话接口。'
    );
  }
  const row = (rows[0] ?? {}) as {
    message?: {
      content?: unknown;
      refusal?: unknown;
      reasoning_content?: unknown;
    };
    finish_reason?: unknown;
  };
  const message = row.message ?? {};
  let content = message.content;
  if (Array.isArray(content)) {
    content = content
      .filter(
        (part): part is { type?: unknown; text?: unknown } =>
          Boolean(part) && typeof part === 'object'
      )
      .filter((part) => part.type === 'text' || part.type === 'output_text')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  const finishMessage = finishReasonMessage(row.finish_reason);
  if (finishMessage) throw new ModelResponseFormatError(finishMessage);
  if (message.refusal) {
    throw new ModelResponseFormatError('模型拒绝处理本次请求。');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new ModelResponseFormatError(
      message.reasoning_content
        ? '模型仅返回推理或空正文；请增加输出预留或切换非推理模式。'
        : '模型没有返回可显示的正文。'
    );
  }
  return content.trim();
}

/** HTTP 状态码 → 可执行中文提示（不转述上游响应体，避免回显密钥/输入）。 */
export function serviceErrorMessage(status: number): string {
  const known: Record<number, string> = {
    401: 'API Key 无效，请重新填写。',
    403: '此密钥没有访问权限，请检查平台授权。',
    404: '接口或模型不存在，请检查服务根地址和模型名称。',
    429: '请求受限或额度不足，请检查平台额度后重试。'
  };
  return known[status] ?? `模型服务返回 HTTP ${status}，请稍后重试或检查服务配置。`;
}

/** 网络层错误 → 可执行提示；取消/其它错误返回 null 由调用方原样抛出。 */
export function networkErrorMessage(error: unknown): string | null {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'TimeoutError') {
    return '连接超时。本地模型首次加载可能较慢，请确认模型已加载后重试。';
  }
  if (error instanceof TypeError) {
    return '无法连接服务。请检查地址，并确认本地模型服务已启动。';
  }
  return null;
}

/**
 * 是否 DeepSeek 官方接口。
 *
 * 只有官方端点支持 `thinking` / `reasoning_effort` 这两个字段；其它 OpenAI 兼容服务
 * 字段不统一，猜着发会把无关服务打挂，所以所有思考参数都只对官方地址发。
 */
export function isDeepSeekHost(baseUrl: string): boolean {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  return host === 'api.deepseek.com';
}

/**
 * 是否 MiniMax 官方接口（国内站/国际站）。
 *
 * MiniMax 的 M3.1 Flash 强制开启思考且不可关闭，思考 token 也计入 `max_tokens`；
 * 直接沿用其他平台的输出上限会出现"正文为空、finish_reason=length"的假失败。
 */
export function isMiniMaxHost(baseUrl: string): boolean {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  return host === 'api.minimax.cn' || host === 'api.minimaxi.com' || host === 'api.minimax.io';
}

/** DeepSeek 官方地址上的思考开关；其它平台返回空对象（见 isDeepSeekHost 的说明）。 */
export function thinkingOptions(baseUrl: string, enabled: boolean): Record<string, unknown> {
  return isDeepSeekHost(baseUrl)
    ? { thinking: { type: enabled ? 'enabled' : 'disabled' } }
    : {};
}

/** 思考强度：官方支持 none/low/high/max，这里只暴露一档「省时」到「最强」的集合。 */
export type ReasoningEffort = 'low' | 'high' | 'max';

/**
 * DeepSeek 官方的思考强度参数。
 *
 * 不配置时不发该字段（沿用平台默认 high）；非官方地址不发（见 isDeepSeekHost）。
 * 注意：`thinking` 对象优先于 `reasoning_effort`，关闭思考时强度没有意义，调用方应先判断。
 * 字段语义以官方文档为准（本模块按公开协议独立实现，不复制其示例代码）：
 * https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
export function reasoningEffortOptions(
  baseUrl: string,
  effort?: ReasoningEffort
): Record<string, unknown> {
  if (!effort || !isDeepSeekHost(baseUrl)) return {};
  return { reasoning_effort: effort };
}

/** MiniMax 思考预留：M3.1 Flash 默认 effort=max，给正文留出足够空间。 */
export const MINIMAX_THINKING_RESERVE = 8192;

/**
 * DeepSeek 思考预留：思维链 token 计入 `completion_tokens`（usage 里有
 * `completion_tokens_details.reasoning_tokens`），而 `max_tokens` 限制的是 completion
 * 生成量——所以开着思考时，原先只按正文长度给的预算会被思维链吃掉，出现「只返回推理」
 * 或 finish_reason=length。开启思考的请求至少多留这么多空间。
 */
export const DEEPSEEK_THINKING_RESERVE = 4096;

/**
 * 单个模型请求里的输出上限/思考参数。
 *
 * - MiniMax：增加思考预留，并要求把思考拆到 `reasoning_content`，避免 `<think>` 标签混进正文；
 * - DeepSeek 官方且开启思考：增加思维链预留（MiniMax 同因，方向一致）；
 * - 其它情况（含 DeepSeek 非思考模式）：原样使用 `max_tokens`，与改动前一致。
 *
 * `thinking` 为调用方算好的「本次请求确实会思考」；不传时按不会思考处理，
 * 保持 OCR/翻译/纠错这些过程性链路的请求体不变。
 */
export function chatOutputOptions(
  baseUrl: string,
  maxTokens: number,
  thinking = false
): Record<string, unknown> {
  const budget = Math.max(1, Math.trunc(maxTokens));
  if (isMiniMaxHost(baseUrl)) {
    return {
      max_tokens: Math.min(budget + MINIMAX_THINKING_RESERVE, 131_072),
      reasoning_split: true
    };
  }
  if (thinking && isDeepSeekHost(baseUrl)) {
    return { max_tokens: Math.min(budget + DEEPSEEK_THINKING_RESERVE, 131_072) };
  }
  return { max_tokens: budget };
}

/**
 * 任务型调用是否附带 thinking 参数：
 *
 * - DeepSeek 官方地址：任务型调用关闭思考、最终回答显式开启（官方协议支持）；
 * - MiniMax：M3.1 Flash 不允许关闭思考，发 disabled 会 400，因此一律不发；
 * - 其它平台：只有用户显式打开「任务型调用关闭深度思考」时，才在任务型调用发 disabled；
 *   最终回答一律不发（各厂商字段不统一，猜着发会把无关服务打挂）。
 */
export function taskThinkingOptions(
  baseUrl: string,
  task: boolean,
  taskThinking: boolean
): Record<string, unknown> {
  if (isDeepSeekHost(baseUrl)) {
    return { thinking: { type: task ? 'disabled' : 'enabled' } };
  }
  if (isMiniMaxHost(baseUrl)) return {};
  if (task && taskThinking) {
    return { thinking: { type: 'disabled' } };
  }
  return {};
}

/**
 * 内容安全审核增强（DeepSeek `safety_check: high`）。
 *
 * 不传/关闭时仍有平台默认的低档检查；`high` 是在其之上的增强层。
 * 只对官方地址发送；其它平台没有这个字段，猜着发会打挂请求。
 * 增强层会增加审核 token 与收尾延迟，且可能误拒学术材料——
 * 因此只用在面向用户的回答请求里，内部过程性调用不发。
 */
export function safetyCheckOptions(
  baseUrl: string,
  enabled: boolean
): Record<string, unknown> {
  return enabled && isDeepSeekHost(baseUrl) ? { safety_check: { level: 'high' } } : {};
}

/**
 * finish_reason → 可执行中文提示；`stop` / `tool_calls` 等正常结束返回 null。
 *
 * 官方定义里除了 `length`，还有三个会让正文为空或不完整、但原因完全不同的结束状态：
 * `insufficient_system_resource`（服务端推理资源不足，可重试）、`content_filter`（内容
 * 安全过滤）与 `aborted`。不区分会把它们都显示成"模型没有返回可显示的正文"。
 * 取值与含义见官方 Chat Completions 参考：
 * https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
 */
export function finishReasonMessage(reason: unknown): string | null {
  switch (reason) {
    case 'length':
      return '模型达到输出上限，正文或结构化结果可能被截断；请提高输出预留，或使用非推理模式。';
    case 'insufficient_system_resource':
      return '模型服务端推理资源不足，本次生成被中断（与你的配置无关）；请稍后重试。';
    case 'content_filter':
      return '模型服务因内容安全策略过滤了本次输出；请调整问题或材料后重试。';
    case 'aborted':
      return '模型生成被中断（服务端中止）；请重试。';
    default:
      return null;
  }
}
