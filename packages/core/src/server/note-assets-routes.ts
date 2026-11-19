import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface NoteAssetRouteOptions {
  store: Store;
}

/** note-assets 只存图片；读取路由按扩展名给出类型，未知类型按二进制下载。 */
const NOTE_ASSET_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

/** 笔记/批注图片资源（note-assets）路由：上传、GC、统计、重建索引、读取。从 server.ts 抽出。 */
export function registerNoteAssetRoutes(app: FastifyInstance, options: NoteAssetRouteOptions): void {
  // 笔记/批注里粘贴的本地图片：base64 data URL → 数据目录 note-assets/ 下的资源文件。
  // 路由放宽 body 上限：图片上限由设置控制（1..20MB），20MB 经 base64 后约 26.7MB，
  // 这里留到 32MB；真正的单图大小/像素限制在 store 里按解码结果判断，返回中文 400。
  app.post(
    `${API_PREFIX}/note-assets`,
    { bodyLimit: 32 * 1024 * 1024 },
    async (request, reply) => {
      const body = (request.body ?? {}) as { dataUrl?: unknown; filename?: unknown };
      if (typeof body.dataUrl !== 'string' || !body.dataUrl.trim()) {
        return badRequest(reply, '需要 dataUrl 图片数据');
      }
      if (body.filename != null && typeof body.filename !== 'string') {
        return badRequest(reply, 'filename 必须是字符串');
      }
      try {
        return await options.store.saveNoteAsset({
          dataUrl: body.dataUrl,
          filename: typeof body.filename === 'string' ? body.filename : undefined
        });
      } catch (error) {
        return badRequest(reply, error instanceof Error ? error.message : '保存图片失败');
      }
    }
  );

  // 图片资源 GC：默认只清理「无引用且早于 24h」的文件；dryRun 只统计。
  app.post(`${API_PREFIX}/note-assets/gc`, async (request, reply) => {
    const body = request.body as
      | { dryRun?: unknown; includeDeleted?: unknown }
      | null
      | undefined;
    if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
      return badRequest(reply, '请求体必须是对象');
    }
    if (body?.dryRun != null && typeof body.dryRun !== 'boolean') {
      return badRequest(reply, 'dryRun 必须是布尔值');
    }
    if (body?.includeDeleted != null && typeof body.includeDeleted !== 'boolean') {
      return badRequest(reply, 'includeDeleted 必须是布尔值');
    }
    return options.store.gcNoteAssets({
      dryRun: body?.dryRun === true,
      includeDeleted:
        typeof body?.includeDeleted === 'boolean' ? body.includeDeleted : undefined
    });
  });

  // 本地图片资源使用统计（文件数/占用/被引用/孤儿/上次清理时间）。
  app.get(`${API_PREFIX}/note-assets/usage`, async () =>
    options.store.getNoteAssetUsage()
  );

  // 手动重建资源索引：修复外部直接改库造成的 refs 漂移，返回并更新 indexed 统计。
  app.post(`${API_PREFIX}/note-assets/reindex`, async () => options.store.reindexNoteAssets());

  // 后台分块重建资源索引（带进度，单并发）。
  app.post(`${API_PREFIX}/note-assets/reindex/start`, async () =>
    options.store.startNoteAssetReindex()
  );
  app.get(`${API_PREFIX}/note-assets/reindex/status`, async () =>
    options.store.getNoteAssetReindexStatus()
  );

  /**
   * 读取笔记/批注图片的原始字节。
   *
   * Electron 仍走 studianda-asset:// 自定义协议；DSH/Web 宿主可以把同一份
   * `studianda-asset://note-assets/<file>` 映射到这里，从而不改写 Markdown 存储格式。
   * 只允许 note-assets 目录下的纯文件名，拒绝分隔符与 ..，避免任意文件读取。
   */
  app.get(`${API_PREFIX}/note-assets/:file`, async (request, reply) => {
    const { file } = request.params as { file?: string };
    if (
      !file ||
      file.includes('\0') ||
      file.includes('..') ||
      file !== path.basename(file) ||
      file.includes('/') ||
      file.includes('\\')
    ) {
      return notFound(reply, '图片不存在');
    }
    const target = path.join(options.store.dataDir, 'note-assets', file);
    let data: Buffer;
    try {
      data = readFileSync(target);
    } catch {
      return notFound(reply, '图片不存在');
    }
    const contentType =
      NOTE_ASSET_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    return reply
      .header('content-type', contentType)
      .header('cache-control', 'private, max-age=86400')
      .send(data);
  });
}
