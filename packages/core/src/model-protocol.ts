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
  if (row.finish_reason === 'length') {
    throw new ModelResponseFormatError(
      '模型达到输出上限，正文或结构化结果可能被截断；请提高输出预留，或使用非推理模式。'
    );
  }
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
 * 任务型调用是否附带 thinking 参数：
 *
 * - DeepSeek 官方地址：任务型调用关闭思考、最终回答显式开启（官方协议支持）；
 * - 其它平台：只有用户显式打开「任务型调用关闭深度思考」时，才在任务型调用发 disabled；
 *   最终回答一律不发（各厂商字段不统一，猜着发会把无关服务打挂）。
 */
export function taskThinkingOptions(
  baseUrl: string,
  task: boolean,
  taskThinking: boolean
): Record<string, unknown> {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === 'api.deepseek.com') {
    return { thinking: { type: task ? 'disabled' : 'enabled' } };
  }
  if (task && taskThinking) {
    return { thinking: { type: 'disabled' } };
  }
  return {};
}
