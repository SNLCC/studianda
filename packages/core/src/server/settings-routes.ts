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

/**
 * `PUT /settings` 允许写入的键白名单。
 *
 * 背景：该接口原先接受任意字符串键值，协议上可以把 `platform.x.api_key` 之类的
 * 凭据明文写进 `reader.sqlite3`（并随备份外流）。这里只放**确实通过这个通用接口
 * 写入**的界面偏好键；密钥、服务地址等有专门接口（`/secrets`、`/zotero/config`、
 * `/parsing/config`、`/speech/config` 等）负责校验，不能借道 `/settings` 绕过。
 *
 * 来源：`packages/app/src` 里的 `api.updateSettings` 调用（快捷键/界面字号/视觉读页/
 * 笔记图片上限）与现有测试通过 HTTP 写入的键；`theme` / `language` 是早期版本设置页
 * 用过的偏好键，保留兼容（非敏感）。新增可写键时请同步更新这里。
 */
const SETTINGS_WRITE_WHITELIST = new Set([
  // 界面偏好（设置页「快捷键与阅读」）。
  'ui.fontSize',
  'ui.answerFontSize',
  'ui.wheelAction',
  'audit.rewrite_mode',
  'reading.budget_pages',
  'reading.budget_tokens',
  // 视觉读页开关（设置页「阅读」）。
  'reading.visual_enabled',
  'reading.visual_use_ocr_model',
  'reading.visual_max_pages',
  // 笔记图片上限。
  'note_image.max_mb',
  'note_image.max_pixels',
  // 快捷键键位（`packages/app/src/shortcut-defaults.ts` 的单一来源）。
  'shortcut.prevPage',
  'shortcut.nextPage',
  'shortcut.zoomIn',
  'shortcut.zoomOut',
  'shortcut.fitWidth',
  'shortcut.askSelection',
  'shortcut.ocrBox',
  'shortcut.send',
  'shortcut.newline',
  'shortcut.stop',
  'shortcut.toggleSidebar',
  'shortcut.readAnswer',
  // 兼容键：早期设置页写过的语言/主题偏好；不敏感，保留避免旧客户端报错。
  'theme',
  'language',
  // Zotero 增量同步「保留本地标题」开关（非密钥；由设置界面/测试经 /settings 读写）。
  'zotero.sync_preserve_local_title'
]);

/** 设置批量写入（`PUT /settings`，原注册位置在 chat 路由之后，保持不动）。 */
export function registerSettingsUpdateRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  app.put(`${API_PREFIX}/settings`, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '设置必须是对象');
    }
    const patch: SettingsMap = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (!SETTINGS_WRITE_WHITELIST.has(key)) {
        return badRequest(
          reply,
          `不允许通过 /settings 写入设置项 ${key}；密钥与服务配置请使用对应的设置接口。`
        );
      }
      if (typeof value !== 'string') return badRequest(reply, `设置项 ${key} 必须是字符串`);
      patch[key] = value;
    }
    return options.store.updateSettings(patch);
  });
}
