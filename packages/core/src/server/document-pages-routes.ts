import type { FastifyInstance } from 'fastify';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { API_ERROR_CODES, API_PREFIX, type PageData } from '@studianda/shared';
import { isAiExportRefused } from '../export-marker.js';
import { ensureOcrBoxes, hasUsableOcrBoxes, renderPdfPage } from '../ocr.js';
import { getPageSpans } from '../page-spans-cache.js';
import { masksForPage, visibleLines } from '../structure.js';
import type { SecretStore } from '../secrets.js';
import { AttachmentChangedError, type Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface DocumentPageRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** 批注 PDF 的下载文件名：中文走 filename*，ASCII 兜底保证旧客户端可用。 */
function annotatedContentDisposition(name: string): string {
  const cleaned =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 80) || '文献';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_') || 'document';
  return (
    `attachment; filename="${ascii}-annotated.pdf"; ` +
    `filename*=UTF-8''${encodeURIComponent(`${cleaned}-批注副本.pdf`)}`
  );
}

/** 页图缩小的最小目标宽度：更小的请求直接忽略，避免请求 1px 的图。 */
const MIN_SCALED_PAGE_WIDTH = 160;
/** 缩略图固定宽度。 */
const THUMBNAIL_WIDTH = 240;

/**
 * 把整页渲染 PNG 缩到目标宽度。**只允许缩小**：
 * 目标宽度必须 >160 且小于原图宽度，否则原样返回整页 PNG（不做放大）。
 */
async function scalePagePng(
  png: Uint8Array,
  fullWidth: number,
  targetWidth: number
): Promise<Uint8Array> {
  if (!Number.isFinite(targetWidth) || targetWidth <= MIN_SCALED_PAGE_WIDTH) return png;
  if (fullWidth <= MIN_SCALED_PAGE_WIDTH) return png;
  const width = Math.max(1, Math.min(fullWidth, Math.round(targetWidth)));
  if (width >= fullWidth) return png;
  const image = await loadImage(Buffer.from(png));
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  return canvas.encode('png');
}

/** 页数据/页文本/页图/缩略图。从 server.ts 抽出。 */
export function registerDocumentPageRoutes(app: FastifyInstance, options: DocumentPageRouteOptions): void {
  app.post(`${API_PREFIX}/documents/:id/snapshot`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.store.snapshotZoteroDocument(id);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存本机副本失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/pages/:page/text`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    const edit = options.store.getPageEdit(id, page);
    return {
      page,
      text: options.store.getPageText(id, page),
      origin: edit?.origin ?? 'native',
      boxes: edit?.boxes ?? ''
    };
  });

  app.put(`${API_PREFIX}/documents/:id/pages/:page/text`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') return badRequest(reply, '需要 text');
    if (!body.text.trim()) return badRequest(reply, '页文本不能为空');
    if (body.text.length > 500_000) return badRequest(reply, '页文本过长（上限 500000 字符）');
    return options.store.savePageTextEdit(id, page, body.text);
  });

  // 页数据：
  // 返回归一化行坐标 + 该页生效的遮罩，界面用于文字层/高亮对齐。
  app.get(`${API_PREFIX}/documents/:id/pages/:page`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    try {
      // 旧 OCR 页只有整页文本、没有行框：按需补识别一次（失败静默），再读版面。
      const editBefore = options.store.getPageEdit(id, page);
      const oldOcrPage =
        editBefore?.origin === 'ocr' &&
        Boolean(editBefore.text.trim()) &&
        !hasUsableOcrBoxes(editBefore.boxes);
      if (oldOcrPage) {
        await ensureOcrBoxes(options.store, options.secrets, id, page).catch(() => undefined);
      }
      const layout = await options.store.getPageLayout(id);
      const pageLayout = layout?.pages.find((item) => item.page === page) ?? null;
      const masks = options.store.listPageMasks(id);
      const lines = pageLayout ? visibleLines(pageLayout, masks) : [];
      // width/height 是 PDF 点（只用于比例换算）；布局缺失时退回行 bbox 最大边界。
      const width =
        pageLayout?.width ??
        (lines.length > 0 ? Math.max(...lines.map((line) => line.bbox[2])) : 1);
      const height =
        pageLayout?.height ??
        (lines.length > 0 ? Math.max(...lines.map((line) => line.bbox[3])) : 1);
      const payload: PageData = {
        page,
        width,
        height,
        lines: lines.map((line) => ({ text: line.text, bbox: line.bbox })),
        masks: masksForPage(masks, page),
        masks_revision: options.store.pageMaskRevision(id)
      };
      if (oldOcrPage) {
        // 补出来的 lines 来自 OCR 行框（原本就没有文本项），不伪造 spans；遮罩过滤沿用上面逻辑。
        payload.spans = [];
      } else {
        // 文本项粒度 + 旋转矩阵：比整行更细，供前端精确对齐选区；失败不影响页数据。
        try {
          const documentPath = options.store.getDocumentPath(id);
          if (documentPath) {
            const spanInfo = await getPageSpans(documentPath, page);
            payload.spans = spanInfo.spans.map((span) => ({
              text: span.text,
              bbox: span.bbox
            }));
            payload.rotation_matrix = spanInfo.rotationMatrix;
          }
        } catch {
          // 可选增强：拿不到就不返回 spans。
        }
      }
      return payload;
    } catch (error) {
      if (error instanceof AttachmentChangedError) {
        return reply.code(409).send({ error: API_ERROR_CODES.attachmentChanged, message: error.message });
      }
      return notFound(reply, error instanceof Error ? error.message : '页面数据不可用');
    }
  });

  // 页图：整页渲染 PNG；`width` 只允许缩小（>160 才处理），不放大。
  app.get(`${API_PREFIX}/documents/:id/pages/:page/image`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    const query = request.query as { width?: string };
    const requested = query.width === undefined ? 0 : Number(query.width);
    try {
      const rendered = await renderPdfPage(id, page, options.store, 2);
      const png = await scalePagePng(rendered.png, rendered.width, requested);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=3600')
        .send(png);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '页面图像不可用');
    }
  });

  // 缩略图：固定小宽度，复用同一缩放逻辑。
  app.get(`${API_PREFIX}/documents/:id/pages/:page/thumbnail`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    try {
      const rendered = await renderPdfPage(id, page, options.store, 2);
      const png = await scalePagePng(rendered.png, rendered.width, THUMBNAIL_WIDTH);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=3600')
        .send(png);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '页面缩略图不可用');
    }
  });
}

/** 文献导出（Markdown 与批注 PDF）。从 server.ts 抽出。 */
export function registerDocumentExportRoutes(app: FastifyInstance, options: DocumentPageRouteOptions): void {
  app.get(`${API_PREFIX}/documents/:id/export`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const exported = options.store.exportMarkdown(id);
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', 'attachment; filename="reading-notes.md"')
        .send(exported.markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败';
      // fail-closed：含 AI 内容却写不进标识头 → 明确 4xx，不产出“去标识”文件。
      if (isAiExportRefused(error)) {
        return reply.code(422).send({ error: API_ERROR_CODES.exportFailed, message });
      }
      return notFound(reply, message);
    }
  });

  app.get(`${API_PREFIX}/documents/:id/annotated.pdf`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    try {
      const exported = await options.store.exportAnnotatedPdf(id);
      return reply
        .header('content-type', 'application/pdf')
        // 固定名会让多篇文献互相覆盖；用「文献名-批注副本.pdf」并给 ASCII 兜底。
        .header('content-disposition', annotatedContentDisposition(document.name))
        .header('cache-control', 'no-store')
        .header('x-studianda-placed', String(exported.placed))
        .header('x-studianda-unplaced', String(exported.unplaced))
        .header('x-studianda-unplaced-reasons', JSON.stringify(exported.unplacedReasons))
        .send(Buffer.from(exported.bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 PDF 失败';
      // fail-closed：含 AI 内容却写不进 AI 元数据 → 明确 4xx，不产出“去标识”副本。
      if (isAiExportRefused(error)) {
        return reply.code(422).send({ error: API_ERROR_CODES.exportFailed, message });
      }
      // 打不开/写不出/加密等文件级失败：用 409 表明"原文件未改动"，与参数错误区分。
      if (/未改动|写入|打开|占用|加密|锁定/.test(message)) {
        return reply.code(409).send({ error: API_ERROR_CODES.exportFailed, message });
      }
      return badRequest(reply, message);
    }
  });
}
