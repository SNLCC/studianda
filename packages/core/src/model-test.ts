import type { SecretStore } from './secrets.js';
import { resolveModelService } from './model-services.js';
import type { Store } from './store.js';

export interface ModelTestResult {
  ok: boolean;
  model: string;
  baseUrl: string;
  latencyMs: number;
  message: string;
}

/** 只发一条极短消息验证模型连接；不发送文献内容。 */
export async function testModelConnection(
  store: Store,
  secrets: SecretStore,
  signal?: AbortSignal
): Promise<ModelTestResult> {
  // 新式配置在「模型服务 · 会话模型」的 routing 里；环境变量覆盖只给无界面运行/调试用。
  const routed = resolveModelService(store, secrets, 'chat');
  const baseUrl = (
    routed?.baseUrl ||
    process.env.STUDIANDA_MODEL_BASE_URL?.trim() ||
    ''
  ).replace(/\/+$/, '');
  const model =
    routed?.model?.trim() ||
    process.env.STUDIANDA_MODEL_NAME?.trim() ||
    '';
  if (!baseUrl || !model) {
    return {
      ok: false,
      model,
      baseUrl,
      latencyMs: 0,
      message: '尚未配置会话模型：请到「设置 → 模型服务」添加平台并选择模型。'
    };
  }
  const apiKey =
    routed?.apiKey?.trim() ||
    process.env.STUDIANDA_MODEL_API_KEY?.trim() ||
    '';
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: '只回复 OK' }]
      }),
      signal: signal ?? AbortSignal.timeout(30_000)
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        model,
        baseUrl,
        latencyMs,
        message: `模型服务返回 HTTP ${response.status}`
      };
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    return {
      ok: true,
      model,
      baseUrl,
      latencyMs,
      message: typeof content === 'string' && content.trim()
        ? content.trim().slice(0, 80)
        : '连接成功（返回内容为空）'
    };
  } catch (error) {
    return {
      ok: false,
      model,
      baseUrl,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : '连接失败'
    };
  }
}
