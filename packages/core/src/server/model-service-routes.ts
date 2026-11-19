import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import {
  applyFetchedCapacityToConnection,
  fetchConnectionModelsDetailed,
  modelServicesImpact,
  publicModelServices,
  saveModelServices
} from '../model-services.js';
import { testModelConnection } from '../model-test.js';
import { listProviders } from '../providers.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { badRequest } from './http.js';

export interface ModelServiceRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** 模型连接测试（`POST /model/test`）。从 server.ts 抽出。 */
export function registerModelTestRoute(app: FastifyInstance, options: ModelServiceRouteOptions): void {
  app.post(`${API_PREFIX}/model/test`, async (request, reply) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    // 用响应流的 close / request 的 aborted 判断真正的取消：
    // request.raw 的 'close' 在正常收完请求体时也会触发，会把还在跑的测试立刻取消。
    reply.raw.once('close', abort);
    request.raw.once('aborted', abort);
    try {
      return await testModelConnection(options.store, options.secrets, controller.signal);
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    }
  });
}

/** 平台/模型服务配置、用途路由、密钥状态与容量元数据。从 server.ts 抽出。 */
export function registerModelServiceRoutes(app: FastifyInstance, options: ModelServiceRouteOptions): void {
  app.get(`${API_PREFIX}/providers`, async () => listProviders());

  app.get(`${API_PREFIX}/model-services`, async () =>
    publicModelServices(options.store, options.secrets)
  );

  // 删除平台连接前的只读影响预览：哪些用途会一起解绑。
  app.get(`${API_PREFIX}/model-services/impact`, async (request, reply) => {
    const query = request.query as { connectionId?: string };
    if (!query.connectionId?.trim()) return badRequest(reply, '需要 connectionId');
    return modelServicesImpact(options.store, query.connectionId.trim());
  });

  app.put(`${API_PREFIX}/model-services`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      connections?: unknown;
      routing?: unknown;
    };
    try {
      const saved = saveModelServices(
        options.store,
        {
          connections: Array.isArray(body.connections)
            ? (body.connections as never)
            : undefined,
          routing:
            body.routing && typeof body.routing === 'object'
              ? (body.routing as never)
              : undefined
        },
        options.secrets
      );
      // 删除连接时触发的降级清单（unbound）：
      // 让界面能如实提示"语音已改回本机/视觉已改回本机 OCR"等，而不是只报保存成功。
      const publicConfig = publicModelServices(options.store, options.secrets) ?? saved;
      return { ...publicConfig, unbound: saved.unbound };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存模型服务失败');
    }
  });

  app.post(`${API_PREFIX}/model-services/models`, async (request, reply) => {
    const body = (request.body ?? {}) as { connectionId?: unknown; metadata?: unknown };
    if (typeof body.connectionId !== 'string') {
      return badRequest(reply, '需要 connectionId');
    }
    // 默认响应保持 `{models:[...]}`（既有 UI/客户端不变）；加 metadata 时才多带容量元数据。
    const query = (request.query ?? {}) as { metadata?: unknown };
    const wantsMetadata =
      body.metadata === true || query.metadata === 'true' || query.metadata === true;
    try {
      if (wantsMetadata) {
        const detailed = await fetchConnectionModelsDetailed(
          options.store,
          options.secrets,
          body.connectionId
        );
        // 显式要 metadata 时，把平台容量回写到**已保存**的模型上（manual 不覆盖、幂等）；
        // 默认路径（只要模型名）保持只读，不产生隐藏写库副作用。
        const { updated } = applyFetchedCapacityToConnection(
          options.store,
          body.connectionId,
          detailed.metadata
        );
        return { ...detailed, updated };
      }
      // 默认路径也走同一份解析：失败时返回 {models, notice}（已保存模型+官方语音快照），
      // 保持既有 `{models:[...]}` 形状不变，旧调用只读 models 不会崩。
      const detailed = await fetchConnectionModelsDetailed(
        options.store,
        options.secrets,
        body.connectionId
      );
      return {
        models: detailed.models,
        ...(detailed.notice ? { notice: detailed.notice } : {})
      };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '获取模型列表失败');
    }
  });
}
