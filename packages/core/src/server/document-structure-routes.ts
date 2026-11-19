import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES, API_PREFIX } from '@studianda/shared';
import { chapterOutline, chaptersFromLocalNavigation } from '../chapters.js';
import { ensureOcrBoxes } from '../ocr.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';
import { sendJsonMaybeGzip } from './json-response.js';

export interface DocumentStructureRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** 结构/内容块/参考文献/章节索引/图表/引文定位/页遮罩（结构域）。从 server.ts 抽出。 */
export function registerDocumentStructureRoutes(app: FastifyInstance, options: DocumentStructureRouteOptions): void {
  app.get(`${API_PREFIX}/documents/:id/structure`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.store.getStructure(id);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取结构失败');
    }
  });

  /**
   * 内容块 / 章节识别（版面粒度）：段落、标题、列表、题注、公式、脚注、参考文献条目，
   * 每块带文字、页码、bbox 与所属章节。`?text=0` 只返回类别与位置（结构视图用）。
   *
   * 识别结果不是原文证据：块文字来自版面上的同一段文字；问答索引消费的是
   * `/section-index`（章节级片段），命中后仍要回原页逐字核对。
   */
  app.get(`${API_PREFIX}/documents/:id/blocks`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const query = request.query as { text?: string };
    try {
      const result = await options.store.getDocumentBlocks(id);
      const includeText = query.text !== '0' && query.text !== 'false';
      const payload = includeText
        ? result
        : {
            ...result,
            blocks: result.blocks.map(({ text: _text, ...rest }) => rest)
          };
      return await sendJsonMaybeGzip(request, reply, payload);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取内容块失败');
    }
  });

  /**
   * 参考文献识别：文末参考文献列表 + 页面底部脚注式引用 + 页面内引用标记
   * （`[1]`、`[1–3]`、`(Smith, 2020)`、（张三，2020））。
   *
   * 条目字段（作者/年份/标题/出处）是尽力解析；解析不出留空，不做猜测。
   * 识别结果只用于阅读时查看"这条引用是哪篇文献"，不是新的原文证据。
   */
  app.get(`${API_PREFIX}/documents/:id/references`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      const result = await options.store.getDocumentReferences(id);
      return await sendJsonMaybeGzip(request, reply, result);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取参考文献失败');
    }
  });

  /**
   * 参考文献用户编辑：修改 / 删除 / 新增 / 重置。
   *
   * 编辑是识别结果之上的覆盖层（改坏了可重置恢复自动识别）；识别版本变化后旧编辑失效，
   * 接口返回的 `stats.staleEdits` 会如实说明。
   */
  app.put(`${API_PREFIX}/documents/:id/references/entries/:entryId`, async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) return badRequest(reply, '需要条目字段');
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.updateReferenceEntry(id, entryId, body)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '修改参考文献失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/references/entries`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) return badRequest(reply, '需要条目字段');
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.addReferenceEntry(id, body)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '新增参考文献失败');
    }
  });

  app.delete(`${API_PREFIX}/documents/:id/references/entries/:entryId`, async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.deleteReferenceEntry(id, entryId)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除参考文献失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/references/reset`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      return await sendJsonMaybeGzip(request, reply, await options.store.resetReferenceEdits(id));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重置参考文献失败');
    }
  });

  /** 章节级问答索引片段（带章节标题与起止页）；索引材料，不作原文证据。 */
  app.get(`${API_PREFIX}/documents/:id/section-index`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const query = request.query as { max_chars?: string; overlap?: string };
    let maxChars: number | undefined;
    let overlap: number | undefined;
    if (query.max_chars !== undefined) {
      if (!/^\d+$/.test(query.max_chars.trim())) {
        return badRequest(reply, 'max_chars 必须是 200..20000 的整数');
      }
      maxChars = Number(query.max_chars);
      if (maxChars < 200 || maxChars > 20_000) {
        return badRequest(reply, 'max_chars 必须是 200..20000 的整数');
      }
    }
    if (query.overlap !== undefined) {
      if (!/^\d+$/.test(query.overlap.trim())) {
        return badRequest(reply, 'overlap 必须是 0..1000 的整数');
      }
      overlap = Number(query.overlap);
      if (overlap > 1000) return badRequest(reply, 'overlap 必须是 0..1000 的整数');
    }
    try {
      const result = await options.store.getSectionIndex(id, { maxChars, overlap });
      return await sendJsonMaybeGzip(request, reply, result);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '生成章节索引失败');
    }
  });

  /** 著作章节：目录派生，只用于展示与"读哪一章"的选择；目录不足/非著作时 available=false。 */
  app.get(`${API_PREFIX}/documents/:id/chapters`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const document = options.store.getDocument(id);
      if (!document) return reply.code(404).send({ error: API_ERROR_CODES.notFound, message: '文献不存在' });
      // 启用的本地目录优先（用户编辑过的目录要能影响"读哪一章"）；否则回退结构树。
      let chapters = await chaptersFromLocalNavigation(options.store, id, document.pages);
      let source: 'navigation' | 'structure' = 'navigation';
      if (chapters.length < 2) {
        const tree = await options.store.getStructure(id);
        chapters = chapterOutline(tree, document.pages);
        source = 'structure';
      }
      const available = document.docCategory === 'book' && chapters.length >= 2;
      return {
        chapters: chapters.map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          page: chapter.page,
          end_page: chapter.endPage,
          level: chapter.level
        })),
        total_pages: document.pages,
        available,
        source
      };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取章节失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/visual-nodes`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.store.getVisualNodes(id);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取图表结构失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/quote-locate`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { page?: unknown; quote?: unknown };
    if (typeof body.page !== 'number' || typeof body.quote !== 'string' || !body.quote.trim()) {
      return badRequest(reply, '需要 page 与 quote');
    }
    try {
      // 旧 OCR 页若缺行框，先按需补识别一次再定位。
      await ensureOcrBoxes(options.store, options.secrets, id, body.page);
      // 返回详细结果：命中页、来源（text_layer/ocr）、是否跨页更正与如实说明。
      return await options.store.locateCitationEx(id, body.page, body.quote);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '定位失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/masks`, async (request) => {
    const { id } = request.params as { id: string };
    return options.store.listPageMasks(id);
  });

  // 页遮罩重建状态：用户改一条规则后能看到"正在重建/已完成/失败原因"。
  app.get(`${API_PREFIX}/documents/:id/masks/status`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return options.store.maskIndexStatus(id);
  });

  app.post(`${API_PREFIX}/documents/:id/masks`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      page?: unknown;
      scope?: unknown;
      rangeStart?: unknown;
      rangeEnd?: unknown;
      excludePages?: unknown;
      x0?: unknown;
      y0?: unknown;
      x1?: unknown;
      y1?: unknown;
    };
    if (
      typeof body.page !== 'number' ||
      typeof body.x0 !== 'number' ||
      typeof body.y0 !== 'number' ||
      typeof body.x1 !== 'number' ||
      typeof body.y1 !== 'number'
    ) {
      return badRequest(reply, '需要 page 与四个坐标');
    }
    try {
      return await options.store.addPageMask(id, {
        page: body.page,
        scope: typeof body.scope === 'string' ? (body.scope as never) : undefined,
        rangeStart: typeof body.rangeStart === 'number' ? body.rangeStart : undefined,
        rangeEnd: typeof body.rangeEnd === 'number' ? body.rangeEnd : undefined,
        excludePages: Array.isArray(body.excludePages)
          ? body.excludePages.filter((item): item is number => Number.isInteger(item))
          : undefined,
        x0: body.x0,
        y0: body.y0,
        x1: body.x1,
        y1: body.y1
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存屏蔽规则失败');
    }
  });

  app.patch(
    `${API_PREFIX}/documents/:id/masks/:maskId`,
    async (request, reply) => {
      const { id, maskId } = request.params as { id: string; maskId: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        return await options.store.updatePageMask(id, maskId, {
          scope: typeof body.scope === 'string' ? (body.scope as never) : undefined,
          page: typeof body.page === 'number' ? body.page : undefined,
          rangeStart: typeof body.rangeStart === 'number' ? body.rangeStart : undefined,
          rangeEnd: typeof body.rangeEnd === 'number' ? body.rangeEnd : undefined,
          excludePages: Array.isArray(body.excludePages)
            ? body.excludePages.filter((item): item is number => Number.isInteger(item))
            : undefined,
          x0: typeof body.x0 === 'number' ? body.x0 : undefined,
          y0: typeof body.y0 === 'number' ? body.y0 : undefined,
          x1: typeof body.x1 === 'number' ? body.x1 : undefined,
          y1: typeof body.y1 === 'number' ? body.y1 : undefined
        });
      } catch (error) {
        return badRequest(
          reply,
          error instanceof Error ? error.message : '更新屏蔽规则失败'
        );
      }
    }
  );

  app.delete(`${API_PREFIX}/documents/:id/masks/:maskId`, async (request, reply) => {
    const { id, maskId } = request.params as { id: string; maskId: string };
    try {
      await options.store.removePageMask(id, maskId);
      return reply.code(204).send();
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '屏蔽规则不存在');
    }
  });
}
