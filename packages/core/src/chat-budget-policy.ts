import type { BudgetEstimate, ChatRequest, ReadingPlanRecord } from '@studianda/shared';
import { budgetThresholds, estimateBudgetForScope, estimateTurnBudget } from './budget.js';
import { readCapacity } from './capacity.js';
import { resolveChapterReading } from './chapters.js';
import { planQuestion } from './planning.js';
import { resolveProjectScope } from './project-scope.js';
import { readingBatchBudget } from './reading-chat.js';
import type { Store } from './store.js';

/**
 * 预算策略（**无状态**）：从 `buildServer` 闭包里抽出的预算估算逻辑。
 *
 * 两个入口共享 4 个纯 helper，但**错误语义必须分开保留**（看起来"不一致"，是既有行为，不要统一）：
 * - `gate`（`/chat/ask*` 的预算闸门）：估算失败一律吞掉返回 `null`，**不阻断提问**；
 *   超预算只是提醒，由调用方回 200 + `needs_confirmation`。
 * - `estimate`（`/chat/budget`）：估算失败**抛 `ChatBudgetError`**，由路由映射 400；
 *   参数错误（缺 question 等）也是 400，`projectId` 项目不存在是 404——文案与拆分前逐字一致。
 *
 * 约束（后人不要改坏）：
 * 1. **每次调用都重新读设置**（`store.getSettings()` / `readCapacity` / `readingBatchBudget`），
 *    构造时不快照阈值——设置改动必须立即生效（`budget.test.ts` 的 live gate 用例）。
 * 2. **不调模型**：闸门要在任何模型调用之前给提示，`planQuestion`/`resolveChapterReading` 只读
 *    本地目录与结构树，不发网络请求。
 * 3. 两套实现允许重复少量代码；不要为了 DRY 把错误语义（吞错 vs 抛错）合并成一条。
 */
export interface ChatBudgetPolicyDeps {
  store: Store;
}

/**
 * `POST /chat/budget` 的请求体（字段按 `unknown` 收，校验在 `estimate` 内完成，
 * 与拆分前路由内的手写校验逐条对应）。
 */
export interface ChatBudgetRequest {
  question?: unknown;
  documentId?: unknown;
  selection?: unknown;
  page?: unknown;
  budget?: unknown;
  reading_scope?: unknown;
  reading_chapter_index?: unknown;
  scopeDocuments?: unknown;
  scope_documents?: unknown;
  projectId?: unknown;
}

/**
 * 预算域的校验/估算失败：`status` 决定 HTTP 映射。
 * - 400：参数错误或估算失败（文案沿用拆分前 `/chat/budget` 的 400 文案）；
 * - 404：`projectId` 对应的项目不存在（拆分前就是 404，不能因为"统一为 400"而改）。
 */
export class ChatBudgetError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = 'ChatBudgetError';
    this.status = status;
  }
}

export interface ChatBudgetPolicy {
  /** 闸门：估算失败返回 `null`（不阻断请求），超预算返回估算（由调用方回 200 + needs_confirmation）。 */
  gate(body: Partial<ChatRequest>): Promise<BudgetEstimate | null>;
  /** `/chat/budget`：校验失败/估算失败抛 `ChatBudgetError`（路由映射 400/404），成功返回估算。 */
  estimate(body: ChatBudgetRequest): Promise<BudgetEstimate>;
}

/**
 * 闸门估算用的阅读范围：显式 `reading_scope` 优先（用户在输入栏选了就按它估），
 * 否则用不调模型的规则规划（`planQuestion`）。
 *
 * 这里刻意**不**调模型路由：闸门必须在任何模型调用之前给出提示，不能为了估成本先花一次调用。
 * 代价是 auto 时按规则/保守规划估，可能比模型最终判定的范围保守——所以下面用"单轮口径"截断，
 * 让提示反映"这一轮到底会读多少"。
 */
export function planForBudget(
  body: Pick<Partial<ChatRequest>, 'question' | 'selection' | 'page'>
): ReadingPlanRecord {
  // 范围只剩"自动 / 跨文献"：闸门只按问题与选文做**不调模型**的规则规划，
  // 不再有"用户指定本页/整篇"的分支（局部范围由 `planFromRules` 从问题里解析）。
  return planQuestion(body.question ?? '', typeof body.selection === 'string' ? body.selection : '');
}

/** 页码归一：非有限数字按第 1 页；保留拆分前 `Math.max(1, Math.trunc(...))` 的钳制语义。 */
export function pageFrom(body: { page?: unknown }): number {
  return typeof body.page === 'number' && Number.isFinite(body.page)
    ? Math.max(1, Math.trunc(body.page))
    : 1;
}

/** `/chat/budget` 与闸门共用的 scope 参数解析：同时接受 camel 与 snake 写法（camel 优先）。 */
export function scopeDocumentIds(camel: unknown, snake: unknown): string[] {
  const source = Array.isArray(camel) ? camel : Array.isArray(snake) ? snake : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of source) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 这一轮要不要按"跨文献精读"估算：显式 corpus，或旧调用没有当前文献但给了跨书范围。
 * 独立问答的「库内检索」（reading_scope='auto' + scope_documents）只做检索，不读全文，不估算。
 * 现已无该入口，仅保留旧调用兼容。
 */
export function isCorpusBudgetRequest(
  readingScope: unknown,
  documentId: unknown,
  scopeDocuments: readonly string[]
): boolean {
  if (readingScope === 'corpus') return true;
  return readingScope === undefined && typeof documentId !== 'string' && scopeDocuments.length > 0;
}

/**
 * 创建无状态预算策略。`buildServer` 每实例创建一次并注入路由模块（策略本身不持有可变状态，
 * 只持有 `store` 引用；注意这是"实例对象"，不是模块级单例，方便测试注入）。
 */
export function createChatBudgetPolicy(deps: ChatBudgetPolicyDeps): ChatBudgetPolicy {
  const { store } = deps;

  return {
    /**
     * 预算闸门：超过确认阈值返回估算（调用方回 200 + needs_confirmation），不拒绝、不读任何页。
     *
     * 单篇用**单轮口径**（estimateTurnBudget）：按 `reading.max_read_batches` 截断后本轮实际会读的页算，
     * 不再拿整本页数吓人；跨文献仍按 scope 总页数（discovery 口径）。
     * 阈值来自设置 `reading.budget_pages` / `reading.budget_tokens`（默认 20 页 / 60000 token）。
     */
    async gate(body: Partial<ChatRequest>): Promise<BudgetEstimate | null> {
      // 语音直接提问没有文字问题（录音本身是输入），不做预算估算。
      if (body.confirm_budget || !body.question || body.audio) return null;
      const settings = store.getSettings();
      const thresholds = budgetThresholds(settings);
      const page = pageFrom(body);
      const scopeDocuments = scopeDocumentIds(undefined, body.scope_documents);
      if (isCorpusBudgetRequest(body.reading_scope, body.documentId, scopeDocuments)) {
        const scopeIds =
          scopeDocuments.length > 0
            ? scopeDocuments
            : store.listDocuments(false).map((document) => document.id);
        if (scopeIds.length === 0) return null;
        try {
          return estimateBudgetForScope(
            store,
            { ...planForBudget(body), breadth: 'discovery' },
            scopeIds,
            { thresholds, scope: 'discovery' }
          );
        } catch {
          // 估算失败不阻断请求：预算闸门只是提醒，不能因为估算错误让提问失败。
          return null;
        }
      }
      if (!body.documentId) return null;
      const document = store.getDocument(body.documentId);
      const plan = planForBudget(body);
      try {
        // 与真实阅读保持一致：自动选章不裁剪，只有显式指定章节时才按章估。
        const explicitChapterIndex =
          typeof body.reading_chapter_index === 'number' &&
          Number.isInteger(body.reading_chapter_index) &&
          body.reading_chapter_index >= 1;
        const planForEstimate = explicitChapterIndex
          ? (
              await resolveChapterReading(store, body.documentId, plan, {
                scope: (body.reading_scope ?? 'auto') as 'auto' | 'local' | 'document' | 'corpus',
                page,
                question: body.question,
                selection: typeof body.selection === 'string' ? body.selection : '',
                chapterIndex: body.reading_chapter_index
              })
            ).plan
          : plan;
        return estimateTurnBudget(store, planForEstimate, body.documentId, {
          page,
          maxBatches: readCapacity(settings).maxReadBatches,
          // 与实际阅读同一口径：批预算跟随模型容量（环境变量覆盖只用于测试/调试）。
          batchBudget: readingBatchBudget(store),
          thresholds,
          scope: planForEstimate.breadth === 'local' ? 'local' : 'document',
          documentCategory: document?.docCategory
        });
      } catch {
        return null;
      }
    },

    /**
     * `/chat/budget` 的估算：结构逐条对应拆分前的路由 handler。
     *
     * 校验部分（question / projectId / 空项目）与拆分前一样在"估算 try"之外，抛 `ChatBudgetError`
     * 交给路由映射；估算部分包在 try 里，任何失败也转成 `ChatBudgetError(400)`——**不吞错**。
     * 注意：这里与 `gate` 的吞错是两套语义，不要合并。
     */
    async estimate(body: ChatBudgetRequest): Promise<BudgetEstimate> {
      if (typeof body.question !== 'string' || body.question.trim() === '') {
        throw new ChatBudgetError('需要 question', 400);
      }
      // 逻辑项目范围：projectId 代替显式文献列表（与精读入口同一口径）。
      // 同时给 400、项目不存在 404、项目没有文献 400——空范围不能静默退化成"全库"。
      const rawProjectId = body.projectId;
      let scopeDocuments = scopeDocumentIds(body.scopeDocuments, body.scope_documents);
      if (rawProjectId !== undefined) {
        const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
        if (!projectId) throw new ChatBudgetError('projectId 必须是非空字符串', 400);
        if (scopeDocuments.length > 0) {
          throw new ChatBudgetError('projectId 与 scopeDocuments 不能同时给：请二选一', 400);
        }
        const projectScope = resolveProjectScope(store, projectId);
        if (projectScope === null) throw new ChatBudgetError('项目不存在', 404);
        if (projectScope.length === 0) {
          throw new ChatBudgetError('项目里还没有可用于估算的文献', 400);
        }
        scopeDocuments = projectScope;
      }
      const settings = store.getSettings();
      const thresholds = budgetThresholds(settings);
      const page = pageFrom(body);
      const plan = planForBudget({
        question: body.question,
        selection: typeof body.selection === 'string' ? body.selection : '',
        page
      });
      // 项目范围本身就是跨文献：给了 projectId 就按跨文献口径估算，不依赖调用方是否带 reading_scope。
      const corpus =
        rawProjectId !== undefined
          ? true
          : isCorpusBudgetRequest(body.reading_scope, body.documentId, scopeDocuments);
      try {
        if (corpus) {
          const scopeIds =
            scopeDocuments.length > 0
              ? scopeDocuments
              : store.listDocuments(false).map((document) => document.id);
          if (scopeIds.length === 0) throw new ChatBudgetError('没有可估算的文献', 400);
          // 跨文献请求按"整轮要读这些文献"估：用 discovery 口径（页数=scope 内页数之和）。
          return estimateBudgetForScope(
            store,
            { ...plan, breadth: 'discovery' },
            scopeIds,
            { thresholds, scope: 'discovery' }
          );
        }
        if (typeof body.documentId !== 'string') {
          throw new ChatBudgetError('需要 question 与 documentId', 400);
        }
        const document = store.getDocument(body.documentId);
        // 估算口径与实际阅读一致：自动选章不裁剪（结构只标注），只有用户**显式指定**章节时才按章估。
        const planForEstimate =
          typeof body.reading_chapter_index === 'number' &&
          Number.isInteger(body.reading_chapter_index) &&
          body.reading_chapter_index >= 1
            ? (
                await resolveChapterReading(store, body.documentId, plan, {
                  scope: (body.reading_scope ?? 'auto') as 'auto' | 'local' | 'document' | 'corpus',
                  page,
                  question: body.question,
                  selection: typeof body.selection === 'string' ? body.selection : '',
                  chapterIndex: body.reading_chapter_index
                })
              ).plan
            : plan;
        return estimateTurnBudget(store, planForEstimate, body.documentId, {
          page,
          maxBatches: readCapacity(settings).maxReadBatches,
          // 与实际阅读同一口径：批预算跟随模型容量（环境变量覆盖只用于测试/调试）。
          batchBudget: readingBatchBudget(store),
          thresholds,
          scope: planForEstimate.breadth === 'local' ? 'local' : 'document',
          documentCategory: document?.docCategory
        });
      } catch (error) {
        if (error instanceof ChatBudgetError) throw error;
        throw new ChatBudgetError(
          error instanceof Error ? error.message : '预算估算失败',
          400
        );
      }
    }
  };
}
