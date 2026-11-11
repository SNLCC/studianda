import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';
import { resolveModelService } from './model-services.js';

interface RerankConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function getRerankConfig(store: Store, secrets: SecretStore): RerankConfig | null {
  const routed = resolveModelService(store, secrets, 'rerank');
  if (routed) {
    return { baseUrl: routed.baseUrl, model: routed.model, apiKey: routed.apiKey };
  }
  // 环境变量覆盖：只给无界面运行与调试用。
  const baseUrl = process.env.STUDIANDA_RERANK_BASE_URL?.trim();
  const model = process.env.STUDIANDA_RERANK_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey:
      process.env.STUDIANDA_RERANK_API_KEY?.trim() ||
      process.env.STUDIANDA_MODEL_API_KEY?.trim() ||
      ''
  };
}

export async function rerankDocuments(
  store: Store,
  secrets: SecretStore,
  query: string,
  documents: string[]
): Promise<number[] | null> {
  const config = getRerankConfig(store, secrets);
  if (!config || documents.length < 2) return null;

  try {
    const response = await fetch(`${config.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.model,
        query,
        documents,
        top_n: documents.length
      }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      results?: Array<{ index?: number; relevance_score?: number }>;
      data?: Array<{ index?: number; relevance_score?: number }>;
    };
    const results = payload.results ?? payload.data;
    if (!Array.isArray(results)) return null;
    return results
      .filter((item) => typeof item.index === 'number')
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
      .map((item) => item.index as number)
      .filter((index) => index >= 0 && index < documents.length);
  } catch {
    // 外部 rerank 失败时保留本地排序
    return null;
  }
}
