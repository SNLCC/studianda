import type { FastifyInstance } from 'fastify';
import { API_PREFIX, type SettingsMap } from '@studianda/shared';
import type { SecretStore } from '../secrets.js';
import { importTokenizer, tokenizerStatus } from '../tokenizer.js';
import type { Store } from '../store.js';
import { badRequest } from './http.js';

export interface SettingsRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** 设置读取、tokenizer 导入、密钥状态与增删。从 server.ts 抽出。 */
export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  app.get(`${API_PREFIX}/settings`, async () => options.store.getSettings());

  app.get(`${API_PREFIX}/settings/tokenizer`, async () => tokenizerStatus(options.store));

  // 导入本地 tokenizer.json（base64 或纯文本 JSON），校验后保存并立即生效。
  app.post(
    `${API_PREFIX}/settings/tokenizer`,
    { bodyLimit: 45 * 1024 * 1024 },
    async (request, reply) => {
      const body = (request.body ?? {}) as { data?: unknown; text?: unknown };
      try {
        return importTokenizer(options.store, {
          data: typeof body.data === 'string' ? body.data : undefined,
          text: typeof body.text === 'string' ? body.text : undefined
        });
      } catch (error) {
        return badRequest(reply, error instanceof Error ? error.message : '导入 tokenizer 失败');
      }
    }
  );

  app.get(`${API_PREFIX}/secrets/status`, async () => ({
    configured: options.secrets.configured()
  }));

  app.post(`${API_PREFIX}/secrets`, async (request, reply) => {
    const body = request.body as { name?: unknown; value?: unknown } | null;
    if (!body || typeof body.name !== 'string' || typeof body.value !== 'string') {
      return badRequest(reply, '需要 name 与 value');
    }
    try {
      options.secrets.set(body.name, body.value);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存密钥失败');
    }
    return { configured: options.secrets.configured() };
  });

  app.delete(`${API_PREFIX}/secrets/:name`, async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      options.secrets.clear(name);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '清除密钥失败');
    }
    return { configured: options.secrets.configured() };
  });
}

/** 设置批量写入（`PUT /settings`，原注册位置在 chat 路由之后，保持不动）。 */
export function registerSettingsUpdateRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  app.put(`${API_PREFIX}/settings`, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '设置必须是对象');
    }
    const patch: SettingsMap = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value !== 'string') return badRequest(reply, `设置项 ${key} 必须是字符串`);
      patch[key] = value;
    }
    return options.store.updateSettings(patch);
  });
}
