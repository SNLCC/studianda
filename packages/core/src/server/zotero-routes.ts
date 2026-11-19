import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import type { SecretStore } from '../secrets.js';
import { DuplicateImportError, type Store } from '../store.js';
import {
  diagnoseZotero,
  getZoteroConfig,
  importZoteroAnnotations,
  listZoteroCollections,
  listZoteroItems,
  probeZotero,
  saveZoteroConfig,
  syncZoteroCollection,
  zoteroAttachment
} from '../zotero.js';
import { badRequest, duplicateReply, notFound } from './http.js';

export interface ZoteroRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** Zotero 连接配置、分类/条目读取、诊断、附件导入与批注导入。从 server.ts 抽出。 */
export function registerZoteroRoutes(app: FastifyInstance, options: ZoteroRouteOptions): void {
  app.get(`${API_PREFIX}/zotero/config`, async () =>
    getZoteroConfig(options.store, options.secrets)
  );

  app.put(`${API_PREFIX}/zotero/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      // WebDAV 附件模式要保存地址、账号与应用密码；少透传任何一个字段都会让
      // 用户在设置里填好却仍然下载不了附件（保存后地址变空）。
      return saveZoteroConfig(options.store, options.secrets, {
        mode: body.mode as never,
        library_type: body.library_type as never,
        library_id: typeof body.library_id === 'string' ? body.library_id : undefined,
        webdav_url: typeof body.webdav_url === 'string' ? body.webdav_url : undefined,
        webdav_user: typeof body.webdav_user === 'string' ? body.webdav_user : undefined,
        api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
        clear_key: body.clear_key === true,
        webdav_password:
          typeof body.webdav_password === 'string' ? body.webdav_password : undefined,
        clear_password: body.clear_password === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存 Zotero 配置失败');
    }
  });

  app.get(`${API_PREFIX}/zotero/collections`, async (_request, reply) => {
    try {
      return await listZoteroCollections(options.store, options.secrets);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取 Zotero 分类失败');
    }
  });

  // 增量同步一个 Zotero collection 到本地文献库（只读 Zotero，不写回）。
  // 新增条目插入、已有条目按条目标识就地更新；Zotero 侧删除只标记 zotero_missing，
  // 绝不自动删除本地文献/标签/笔记/批注。幂等：重复调用不产生重复行。
  app.post(`${API_PREFIX}/zotero/collections/:key/sync`, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!/^[A-Z0-9]{8}$/.test(key)) return badRequest(reply, '分类标识无效');
    try {
      return await syncZoteroCollection(options.store, options.secrets, key);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '同步 Zotero 分类失败');
    }
  });

  app.get(`${API_PREFIX}/zotero/items`, async (request, reply) => {
    const query = request.query as { collection?: string; start?: string; q?: string };
    const collection = (query.collection ?? '').trim();
    if (collection && !/^[A-Z0-9]{8}$/.test(collection)) {
      return badRequest(reply, '分类标识无效');
    }
    const start = query.start === undefined ? 0 : Number(query.start);
    if (!Number.isInteger(start) || start < 0) {
      return badRequest(reply, 'start 必须是非负整数');
    }
    const q = (query.q ?? '').trim();
    if (q.length > 500) return badRequest(reply, '搜索词过长（上限 500 字符）');
    try {
      return await listZoteroItems(
        options.store,
        options.secrets,
        collection,
        start,
        q
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取 Zotero 条目失败');
    }
  });

  // Zotero 只读诊断：返回连接模式、成功/失败原因与可执行细节；不返回任何密钥。
  app.get(`${API_PREFIX}/zotero/diagnose`, async () => diagnoseZotero(options.store, options.secrets));

  app.post(`${API_PREFIX}/zotero/items/:key/open`, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = request.body as { confirmDuplicate?: unknown } | null;
    try {
      const attachment = await zoteroAttachment(options.store, options.secrets, key);
      return await options.store.importZoteroDocument({
        ...attachment,
        confirmDuplicate: body?.confirmDuplicate === true
      });
    } catch (error) {
      if (error instanceof DuplicateImportError) return duplicateReply(reply, error);
      return badRequest(reply, error instanceof Error ? error.message : '打开 Zotero 附件失败');
    }
  });

  app.post(
    `${API_PREFIX}/documents/:id/zotero-annotations/preview`,
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      try {
        return await importZoteroAnnotations(options.store, options.secrets, id, false);
      } catch (error) {
        return badRequest(
          reply,
          error instanceof Error ? error.message : '读取 Zotero 批注与笔记失败'
        );
      }
    }
  );

  app.post(
    `${API_PREFIX}/documents/:id/zotero-annotations/import`,
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      try {
        return await importZoteroAnnotations(options.store, options.secrets, id, true);
      } catch (error) {
        return badRequest(
          reply,
          error instanceof Error ? error.message : '导入 Zotero 批注与笔记失败'
        );
      }
    }
  );

  app.post(`${API_PREFIX}/zotero/test`, async () =>
    probeZotero(options.store, options.secrets)
  );
}
