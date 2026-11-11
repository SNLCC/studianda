import { randomUUID } from 'node:crypto';
import type {
  ChatResponse,
  ChatSource,
  CorpusDocumentReport,
  DiscoveryReportRecord,
  ReadingPlanRecord
} from '@studianda/shared';
import { ensureAutoOcr } from './ocr.js';
import { planReading } from './reading-plan.js';
import {
  readInBatches,
  evidenceBank,
  fitBank,
  turnReadBatches,
  type EvidenceBankRecord,
  type ReadInBatchesResult,
  type ReadingFinding
} from './reading-executor.js';
import { recordModelUsage } from './model-usage.js';
import { extractKeywords } from './keywords.js';
import { hasActiveTokenizer } from './tokenizer.js';
import { batches, cost, sourceText, splitSources, type ReadingSource } from './reading.js';
import {
  coverageLedger,
  DEFAULT_DIMENSIONS,
  documentAnswerability,
  ledgerSummary,
  readingCoverage,
  unrecordedLedger,
  type ReadingCoverage
} from './coverage.js';
import { citationBindings, citationSupport, invalidCitations } from './citations.js';
import { answerAnchors } from './citation.js';
import { stripUnsupportedPages } from './review.js';
import {
  auditAnswer,
  auditClaimsList,
  rewriteAuditedAnswer,
  type AuditClaim,
  type AuditEvidence,
  type AuditOriginal,
  type AuditReport
} from './audit.js';
import { answerInstruction } from './prompts.js';
import { contrastPages, falsificationReport } from './falsify.js';
import { REREAD_SKIPPED_NOTE, worthRereading } from './reread.js';
import { inputCost, messages, PER_MESSAGE_COST } from './request-budget.js';
import type { Store } from './store.js';
import type { SecretStore } from './secrets.js';
import {
  discoveryReport,
  documentScores,
  orderDocuments,
  termsOf
} from './discovery.js';
import { semanticReversePages, type SemanticReverseResult } from './semantic-reverse.js';
import { cosine, vectorsFor } from './embeddings.js';
import { pickPages } from './semantic.js';
import { gotoWorkers, inputBudgetFor, readCapacity } from './capacity.js';
import { resolveModelCapacity } from './model-services.js';
import {
  networkErrorMessage,
  responseText,
  serviceErrorMessage,
  taskThinkingOptions
} from './model-protocol.js';
import type { SourceKind } from './routing.js';
import { sweepReport, type SweepReport } from './sweep.js';
import { expandSections, textQuality } from './structure.js';
import {
  chapterRecord,
  navigationSectionPages,
  nextChapterContinuePlan,
  type ChapterRange
} from './chapters.js';
import {
  visualReadingSupplement,
  type VisualReadingSupplement
} from './visual-reading.js';
import { MEMORY_RULES } from './memory-sources.js';

export interface ReadingChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 平台模型元数据里的 task_thinking：任务型调用（审计/修订/批次/回读）是否关闭深思。
   *
   * 只有模型服务路由存在时才由 chat.ts 从 `resolveModelCapacity(store,'chat')` 写入；
   * 旧设置路径不设置该字段，因此旧配置的请求体与改动前完全一致。
   */
  taskThinking?: boolean;
  /**
   * 证据审计的输出模式（合规 P2-19）：
   * - `rewrite`（默认）：按审计结果确定性改写缺证段落、推断加前缀、移除未核验引用/页码；
   * - `annotate`：只标注，不改写模型正文；缺证/推断/未核验引用在审计报告与界面里展示。
   * 规则固定、可复现，不做开放式二次创作；用户可在设置中显式切回 `annotate`。
   */
  auditRewrite?: 'annotate' | 'rewrite';
}

// 单机桌面端同时只处理一个阅读任务；审计包用这个回调把阶段进度送回界面。
let activeStageCallback: ((text: string) => void) | undefined;
let activeAuditCallback: ((claims: AuditClaim[]) => void) | undefined;
let activeAuditStore: Store | undefined;

interface ReadingTaskPayload {
  question: string;
  selection: string;
  documentId: string;
  plan: ReadingPlanRecord;
  pagesRead: number[];
  findings: ReadingFinding[];
  answer: string;
  sources: ChatSource[];
  unread_pages?: number[];
}

/**
 * 跨文献阅读任务（继续阅读用）。
 *
 * 与单篇任务的区别：一轮可能读多篇，已读页按文献分别记录；继续阅读时只把**未读页**
 * 交给阅读器，已读批次的派生记录与逐字证据从任务里原样带上，不重新调用模型。
 * 任务只保存派生记录与摘引，不保存整页原文。
 */
interface CorpusTaskPayload {
  kind: 'corpus';
  question: string;
  selection: string;
  documentIds: string[];
  /** 本轮的单批原文预算；续读沿用它，否则内容寻址的批次键会变、已读批次被重读。 */
  budget: number;
  /** 扁平并集：供 `listReadingTasks` 展示"还剩多少页"（界面据此决定是否显示继续入口）。 */
  pagesRead: number[];
  unread_pages: number[];
  readByDocument: Record<string, number[]>;
  /**
   * 已读的**原文分段**（按 `documentId+page+offset`）：大页会被 splitSources 切成多段，
   * 只按页记"已读"会让续读每轮都从同一页开头重来（真实 E2E 踩到）。旧任务没有该字段时
   * 退回按页排除。
   */
  readSegments?: Array<{ documentId: string; page: number; start: number; end: number }>;
  /** 本轮结束时仍未读的页；非空就保留任务，空则删除。 */
  deferredByDocument: Record<string, number[]>;
  /** 用于最终综合的批次记录（可能已过压缩层）。 */
  findings: ReadingFinding[];
  /** 批次原始记录（含逐字证据）；继续阅读合并证据银行时用它。 */
  sourceFindings: ReadingFinding[];
  answer: string;
  sources: ChatSource[];
}

/**
 * 本轮请求可用的输入容量。
 *
 * 模型元数据里的容量优先：只有当会话模型被用户显式设为 `capacity_mode='manual'`
 * 且 `context_window` 合法（8192–4000000）时才覆盖全局设置；其余情况（auto/未配置模型/
 * 窗口越界）完全沿用 `readCapacity(settings)`——未设置模型的用户默认行为不变。
 *
 * 导出用于测试/诊断；生产调用点都在本模块内。
 */
export function chatInputLimit(store: Store): number {
  const capacity = readCapacity(store.getSettings());
  const modelCapacity = resolveModelCapacity(store, 'chat');
  // auto 由 `resolveModelCapacity` 统一解析：已保存的平台元数据或官方快照（DeepSeek 1M）；
  // manual 只用用户保存值。没有模型容量时完全沿用全局设置。
  return inputBudgetFor(
    capacity,
    modelCapacity?.contextWindow,
    modelCapacity?.outputReserve
  );
}

/**
 * 审计分包的容量上限（内部使用，导出供测试）。
 *
 * 与 `chatInputLimit` 同口径：会话模型的手动容量（`capacity_mode='manual'`）生效；
 * 没有 store（跨文献路径没有 activeAuditStore）时退回原来的保守值 12000，
 * auto/未配置模型时与改动前完全一致。
 */
export function auditPacketBudgetFor(store?: Store): number {
  return store ? chatInputLimit(store) : 12000;
}

/**
 * 综合材料的 room（内部使用，导出供测试）：`max(1024, 输入上限 − 指令成本 − 1024)`。
 * 输入上限跟随手动模型容量；auto/未配置模型时与 `inputBudget(readCapacity(...))` 相等。
 */
export function synthesisRoomFor(store: Store, instruction: string): number {
  return Math.max(1024, chatInputLimit(store) - cost(instruction) - 1024);
}

/** 历史消息（只允许 user/assistant：历史是对话记录，不是资料或系统指令）。 */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 多轮历史存在时追加给模型的引用隔离规则。
 *
 * 历史里的 [1][2] 指向的是当时那一轮的 sources，本轮证据会重新编号；不明确隔离时模型容易
 * 用历史编号冒充本轮依据。阅读页与独立问答用同一口径（独立问答另有自己的提示词封装）。
 */
const HISTORY_CITATION_RULE =
  '\n\n历史轮次的回答里可能出现 [1][2] 这类编号，那些编号只属于当时那一轮、对应的是当时的来源，'
  + '不能当作本轮引用，也不要用它们代替本轮给出的原文/证据编号；本轮引用只能指向本轮材料里的来源。';

/** 有非空历史时返回引用隔离规则，否则空串。 */
export function historyCitationRule(history: unknown): string {
  return Array.isArray(history) && history.length > 0 ? HISTORY_CITATION_RULE : '';
}

function numericToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function usageFromPayload(payload: unknown): { input: number; output: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const row = usage as Record<string, unknown>;
  const input = numericToken(row.prompt_tokens) ?? numericToken(row.input_tokens);
  const output = numericToken(row.completion_tokens) ?? numericToken(row.output_tokens);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

const HISTORY_SUMMARY_RULE =
  '\n\n【本会话早期摘要（由会话模型生成，只是理解上下文用的回忆，不是文献原文/证据）】\n';

/**
 * 把「历史旧引用隔离」与「会话早期摘要」拼成提示词片段。
 *
 * 摘要只能帮助理解前文；本轮回答的引用编号仍必须只指向本轮材料里的来源。
 */
export function historyContextRules(history: unknown, summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) return historyCitationRule(history);
  return (
    HISTORY_SUMMARY_RULE +
    trimmed +
    '\n\n摘要使用规则：摘要只用于理解用户之前问过什么、已经确认过什么；不要把摘要里的内容当作' +
    '本轮文献证据，不要从摘要里生成或沿用 [1][2] 这类引用编号；本轮引用只能指向本轮材料里的来源。' +
    historyCitationRule(history)
  );
}

export interface PreparedHistory {
  /** 按原顺序保留的历史（从旧到新）。 */
  prior: HistoryMessage[];
  /** 因容量被省略的**轮数**（从最旧开始丢；0 表示没丢）。 */
  dropped: number;
}

/** 历史条数上限与单条字符上限（防止把整轮回答塞回请求）。 */
export const HISTORY_MAX_MESSAGES = 20;
export const HISTORY_MAX_CHARS = 4000;

/** 历史消息本身的成本（每条一次固定开销；与 request_budget 的消息计数口径一致）。 */
function historyCost(prior: readonly HistoryMessage[]): number {
  return prior.reduce((total, row) => total + cost(row.content) + PER_MESSAGE_COST, 0);
}

/** 在给定 system/材料下，历史还能占多少容量（负数表示连正文都紧，历史全丢）。 */
function historyRoomFor(inputLimit: number, system: string, user: string): number {
  return inputLimit - inputCost(messages(system, user));
}

/** 历史消息成本与「省略轮数」口径：一条 user 算一轮；没有 user 时按两条一轮估算。 */
function droppedTurnsOf(rows: readonly HistoryMessage[]): number {
  const users = rows.filter((row) => row.role === 'user').length;
  return users > 0 ? users : Math.ceil(rows.length / 2);
}

/**
 * 把 `ChatRequest.history` 收敛成 prior messages。
 *
 * 规则：只保留 user/assistant 与**非空**内容；单条截到 4000 字；最多保留最近 20 条；
 * 超容量时**从最旧开始丢**（按整轮丢：user 连同它的 assistant 答；绝不截断当前问题或证据）。
 * 返回的 `dropped` 是被丢掉的历史轮数——包含「超过 20 条上限」裁掉的部分，调用方必须写进
 * notice，不能静默丢历史。
 */
export function prepareHistory(
  history: unknown,
  room = Number.POSITIVE_INFINITY
): PreparedHistory {
  const list = Array.isArray(history) ? history : [];
  const collected: HistoryMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      role?: unknown;
      content?: unknown;
      question?: unknown;
      answer?: unknown;
    };
    // 兼容两种历史形状：{role,content} 的消息对，或 ChatRequest 的 {question,answer} 问答对。
    if (typeof value.role === 'string' && typeof value.content === 'string') {
      const role = value.role;
      const content = value.content.trim();
      if ((role === 'user' || role === 'assistant') && content) {
        collected.push({ role, content: content.slice(0, HISTORY_MAX_CHARS) });
      }
      continue;
    }
    const question = typeof value.question === 'string' ? value.question.trim() : '';
    if (question) {
      collected.push({ role: 'user', content: question.slice(0, HISTORY_MAX_CHARS) });
    }
    const answer = typeof value.answer === 'string' ? value.answer.trim() : '';
    if (answer) {
      collected.push({ role: 'assistant', content: answer.slice(0, HISTORY_MAX_CHARS) });
    }
  }
  // 只保留最近 N 条：历史是理解追问的上下文，越旧越不重要；
  // 被条数上限裁掉的部分也算「省略的历史轮数」，要如实报出去。
  const overflow = collected.slice(0, Math.max(0, collected.length - HISTORY_MAX_MESSAGES));
  let prior = collected.slice(-HISTORY_MAX_MESSAGES);
  let dropped = droppedTurnsOf(overflow);
  while (prior.length > 0 && historyCost(prior) > room) {
    // 按整轮丢：user + 紧随其后的 assistant 一起丢，避免留下没有提问的答。
    if (prior[0]?.role === 'user') {
      prior = prior.slice(1);
      if (prior[0]?.role === 'assistant') prior = prior.slice(1);
    } else {
      prior = prior.slice(1);
    }
    dropped += 1;
  }
  return { prior, dropped };
}

/**
 * 把「最终回答」与「审计」两个阶段的历史丢弃合成**一条**说明（避免同一件事报两遍）。
 *
 * - 两个阶段处理的是同一份历史，**不能相加**（同一批历史会在两次请求里分别被丢）；
 * - 只在真的发生丢弃时返回文案；无丢弃返回空串（调用方据此决定是否 push）；
 * - 两阶段都丢时分别说明各自轮数，用户能看出是哪一步丢的。
 */
export function historyDropNotice(
  answerDropped: number,
  auditDropped?: number
): string {
  const answer = Number.isFinite(answerDropped) ? Math.max(0, Math.trunc(answerDropped)) : 0;
  const audit = Number.isFinite(auditDropped) ? Math.max(0, Math.trunc(auditDropped ?? 0)) : 0;
  if (answer <= 0 && audit <= 0) return '';
  if (audit <= 0) {
    return `为容量省略了 ${answer} 轮历史（从最旧开始）；逐字证据未截断。`;
  }
  if (answer <= 0) {
    return `审计阶段为容量省略了 ${audit} 轮历史（从最旧开始）；逐字证据未截断。`;
  }
  return (
    '为容量省略了历史（从最旧开始；最终回答 ' +
    `${answer} 轮、审计核对 ${audit} 轮）；逐字证据未截断。`
  );
}

export async function callChatModel(
  config: ReadingChatConfig,
  system: string,
  user: string,
  maxTokens = 1200,
  signal?: AbortSignal,
  onDelta?: (delta: string) => void,
  onMeta?: (meta: { finishReason?: string }) => void,
  inputLimit?: number,
  phase = '',
  prior: readonly HistoryMessage[] = [],
  /**
   * 任务型调用标记（审计/修订/批次阅读/回读规划等过程性请求）。
   *
   * 只有 `config.taskThinking === true && task === true` 时才在请求体加
   * `thinking: { type: 'disabled' }`；其他情况（默认 task=false、旧配置无 taskThinking）
   * 请求体**完全不出现**该字段，保持与改动前一致。最终回答不传 task（保留平台深思）。
   */
  task = false
): Promise<string> {
  const stream = Boolean(onDelta);
  // 请求消息与容量检查用同一份数组：历史作为 prior 夹在系统指令与材料之间。
  const requestMessages = messages(system, user, prior);
  const inputText = requestMessages.map((message) => message.content).join('\n');
  // 最后一道降级：装不下就**如实报错**，
  // 既不发一个注定失败的请求，也绝不把材料截断后冒充成功。
  if (inputLimit !== undefined) {
    const expected = inputCost(requestMessages);
    if (expected > inputLimit) {
      throw new Error(
        `${phase ? `${phase}：` : ''}预计输入 ${expected}，有效输入上限 ${inputLimit}；当前问题或材料无法完整装入，未截断原文。`
      );
    }
  }
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        stream,
        messages: requestMessages,
        // DeepSeek 官方地址：任务型关闭思考、最终回答显式开启；其它平台只在用户明确
        // 打开 task_thinking 时对任务型调用发 disabled。
        ...taskThinkingOptions(config.baseUrl, task, config.taskThinking === true)
      }),
      signal: signal ?? AbortSignal.timeout(120_000)
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    const message = networkErrorMessage(error);
    if (message) throw new Error(`${phase ? `${phase}：` : ''}${message}`);
    throw error;
  }
  if (!response.ok) {
    throw new Error(`${phase ? `${phase}：` : ''}${serviceErrorMessage(response.status)}`);
  }
  if (onDelta && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = '';
    let reasoningOnly = false;
    let done = false;
    let streamUsage: { input: number; output: number } | null = null;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true;
            break;
          }
          try {
            const payload = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: unknown; reasoning_content?: unknown };
                finish_reason?: unknown;
              }>;
              usage?: unknown;
            };
            streamUsage = usageFromPayload(payload) ?? streamUsage;
            const choice = payload.choices?.[0];
            if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
            const rawDelta = choice?.delta?.content;
            let delta = '';
            if (Array.isArray(rawDelta)) {
              delta = rawDelta
                .filter(
                  (part): part is { type?: unknown; text?: unknown } =>
                    Boolean(part) && typeof part === 'object'
                )
                .filter((part) => part.type === 'text' || part.type === 'output_text')
                .map((part) => (typeof part.text === 'string' ? part.text : ''))
                .join('');
            } else if (typeof rawDelta === 'string') {
              delta = rawDelta;
            }
            if (!delta && choice?.delta?.reasoning_content) reasoningOnly = true;
            if (delta) {
              content += delta;
              onDelta(delta);
            }
          } catch {
            // 忽略非 JSON 心跳行
          }
        }
        boundary = buffer.indexOf('\n');
      }
    }
    if (finishReason === 'length') {
      throw new Error('模型达到输出上限，正文或结构化结果可能被截断；请提高输出预留，或使用非推理模式。');
    }
    if (!content.trim()) {
      throw new Error(
        reasoningOnly
          ? '模型仅返回推理或空正文；请增加输出预留或切换非推理模式。'
          : '模型没有返回可显示的正文。'
      );
    }
    recordModelUsage(inputText, content, streamUsage);
    return content.trim();
  }
  const payload = (await response.json()) as unknown;
  const choice = (
    payload as { choices?: Array<{ finish_reason?: string }> }
  ).choices?.[0];
  onMeta?.({ finishReason: choice?.finish_reason });
  const content = responseText(payload);
  recordModelUsage(inputText, content, usageFromPayload(payload));
  return content;
}

async function synthesize(
  store: Store,
  config: ReadingChatConfig,
  question: string,
  selection: string,
  documentId: string,
  findings: ReadingFinding[],
  bank: EvidenceBankRecord[],
  signal?: AbortSignal,
  full = false,
  allowKnowledge = false,
  onDelta?: (delta: string) => void,
  visualMaterial = '',
  history?: unknown,
  /** 用户笔记/批注补充材料（不是文献原文证据）：只进入最终回答，不进入证据链/审计。 */
  memoryMaterial = '',
  /** 会话早期摘要（模型生成，只是上下文，不是文献原文/证据）。 */
  historySummary = ''
): Promise<{
  answer: string;
  sources: ChatSource[];
  droppedRecords: number;
  historyDropped: number;
  /** 本轮综合**实际送入模型**的材料原文（多批/续读用于 coverage.final_context）。 */
  finalContext: string;
}> {
  const baseInstruction = answerInstruction(full, allowKnowledge);
  // 笔记/批注是补充材料：容量不足时先丢派生分析、再丢它，不能让它挤掉逐字证据，
  // 也不能因为附了笔记把原本能回答的请求顶成"超出上下文容量"。
  let instruction = baseInstruction + (memoryMaterial ? `\n\n${MEMORY_RULES}` : '') + historyContextRules(history, historySummary);
  let memoryBlock = memoryMaterial ? `\n\n${memoryMaterial}` : '';
  const buildMaterial = (rows: ReadingFinding[], memory = memoryBlock): string => {
    const readingRecords = rows
      .map((finding, index) => `批次 ${index + 1} 分析：${finding.analysis}`)
      .join('\n');
    const verified = bank
      .map(
        (item, index) =>
          `[${index + 1}] ${item.documentId ?? documentId} 第 ${item.page ?? '?'} 页\n${item.quote}`
      )
      .join('\n\n');
    return (
      `问题：${question}${selection ? `\n选文：${selection}` : ''}\n\n` +
      `分批阅读记录（派生资料，不是原文；引号内摘引才是逐字核验内容）：\n${readingRecords}\n\n` +
      `verified_quotes：\n${verified}` +
      (visualMaterial ? `\n\n${visualMaterial}` : '') +
      memory
    );
  };
  // 材料 room 跟随会话模型的「手动容量」；auto/未配置模型时 chatInputLimit 与
  // inputBudget(readCapacity(...)) 完全相等，行为不变（fitContext 的丢批顺序也不变）。
  const room = synthesisRoomFor(store, instruction);
  let usable = findings;
  let material = buildMaterial(usable);
  // 容量不足时**先丢派生分析**（从最后一批开始），
  // 逐字证据银行一条都不动；连银行都放不下时如实报错，不截断证据伪装完成。
  while (usable.length > 0 && cost(material) > room) {
    usable = usable.slice(0, -1);
    material = buildMaterial(usable);
  }
  // 派生分析已丢完仍放不下：先丢笔记/批注补充材料（并撤掉对应提示词规则），再按原口径报错。
  if (cost(material) > room && memoryBlock) {
    memoryBlock = '';
    instruction = baseInstruction + historyContextRules(history, historySummary);
    material = buildMaterial(usable, '');
  }
  if (cost(material) > room) {
    throw new Error(
      '本轮证据材料超出模型上下文容量；逐字证据不能截断。请提高「上下文窗口」或缩小阅读范围。'
    );
  }
  // 历史作为 prior 进入最终综合；超容量时从最旧丢（丢了几轮如实带回给 notice）。
  const inputLimit = chatInputLimit(store);
  const preparedHistory = prepareHistory(
    history,
    historyRoomFor(inputLimit, instruction, material)
  );
  const answer = await callChatModel(
    config,
    instruction,
    material,
    1200,
    signal,
    onDelta,
    undefined,
    inputLimit,
    '形成文献分析',
    preparedHistory.prior
  );
  const sources: ChatSource[] = bank.map((item) => {
    const document = store.getDocument(item.documentId ?? documentId);
    return {
      documentId: item.documentId ?? documentId,
      documentName: document?.name ?? '',
      page: item.page ?? 1,
      snippet: item.quote.slice(0, 240),
      quotes: [item.quote]
    };
  });
  return {
    answer,
    sources,
    droppedRecords: findings.length - usable.length,
    historyDropped: preparedHistory.dropped,
    // 多批/续读总是保存**实际送入**的完整材料
    // （无长度门限、不截断成假内容）；单遍仍由调用方不写 coverage.final_context（值为空串）。
    finalContext: material
  };
}

function withCitationSupport(
  answer: string,
  sources: ChatSource[],
  claims: Array<{ claim: number; evidence?: Array<{ source: number; quote: string }> }> = []
): Pick<ChatResponse, 'citation_support'> & {
  invalid_citations: number[];
  citation_bindings: Array<{ index: number; line: number; quote: string }>;
} {
  return {
    citation_support: citationSupport(answer, sources),
    invalid_citations: invalidCitations(answer, sources.length),
    citation_bindings: citationBindings(answer, claims, sources)
  };
}

function sanitizeAnswer(
  answer: string,
  sources: ChatSource[]
): { answer: string; removed: string[] } {
  const allowed = new Set(sources.map((source) => source.page).filter((page) => Number.isInteger(page)));
  const stripped = stripUnsupportedPages(answer, allowed);
  return { answer: stripped.text, removed: stripped.removed };
}

/**
 * 分批阅读阶段逐字核验过的摘引：
 * 只认 `findings[].evidence` 里已经通过原文成员校验的记录——来源编号必须是
 * 1..originalsCount 的整数，同一来源去重、每来源最多 `perSource` 条、每条截到 `size` 字。
 * **不做额外匹配，也不信未核验来源**；没有可用记录时返回空对象。
 */
export function findingQuotes(
  findings: ReadingFinding[],
  originalsCount: number,
  perSource = 2,
  size = 200
): Record<number, string[]> {
  const found: Record<number, string[]> = {};
  for (const finding of findings ?? []) {
    for (const evidence of finding.evidence ?? []) {
      const number = evidence.source;
      const quote = (evidence.quote ?? '').trim();
      if (!Number.isInteger(number) || number < 1 || number > originalsCount || !quote) continue;
      const bucket = (found[number] ??= []);
      if (!bucket.includes(quote) && bucket.length < perSource) bucket.push(quote.slice(0, size));
    }
  }
  return found;
}

/**
 * 把「批次摘引 + 审计摘引」合并到返回来源。
 *
 * TS 的最终 sources 在分批/续读路径里来自证据银行（按 bank 顺序重排，编号与批次原文的
 * 全局来源编号不再一致），因此批次摘引按「文献 + 页」对齐（只信证据记录里已核验的页，
 * 不按编号乱猜）；审计摘引仍按来源编号追加。合并顺序：已有摘引（证据银行里那条逐字原文）
 * 在最前，批次摘引补到每来源 2 条，再用审计摘引补到最多 3 条、每条 200 字、去重。
 */
function attachSourceQuotes(
  sources: ChatSource[],
  findings: ReadingFinding[] | undefined,
  claims: Array<{ evidence?: Array<{ source: number; quote: string }> }>
): void {
  const merged = new Map<number, string[]>();
  // 已有 quotes（分批路径里来自证据银行的那条逐字原文）不能被覆盖：保留在最前，
  // 同样截到 200 字，保证返回给界面的每条摘引口径一致。
  sources.forEach((source, index) => {
    if (source.quotes && source.quotes.length > 0) {
      merged.set(
        index + 1,
        source.quotes.map((quote) => quote.slice(0, 200))
      );
    }
  });
  const indexesByPage = new Map<string, number[]>();
  sources.forEach((source, index) => {
    const key = `${source.documentId}\u001f${source.page}`;
    const list = indexesByPage.get(key) ?? [];
    list.push(index + 1);
    indexesByPage.set(key, list);
  });
  const perSource = 2;
  for (const finding of findings ?? []) {
    for (const evidence of finding.evidence ?? []) {
      const quote = (evidence.quote ?? '').trim();
      const page = evidence.page;
      const documentId = evidence.documentId;
      if (!quote || !Number.isInteger(page) || !documentId) continue;
      for (const number of indexesByPage.get(`${documentId}\u001f${page}`) ?? []) {
        const list = merged.get(number) ?? [];
        if (!list.includes(quote) && list.length < perSource) list.push(quote.slice(0, 200));
        merged.set(number, list);
      }
    }
  }
  for (const claim of claims) {
    for (const evidence of claim.evidence ?? []) {
      const number = evidence.source;
      const quote = (evidence.quote ?? '').trim();
      if (!Number.isInteger(number) || number < 1 || number > sources.length || !quote) {
        continue;
      }
      const list = merged.get(number) ?? [];
      // 按原文去重，追加后再整体 `quotes[:3]`。
      if (!list.includes(quote) && list.length < 3) list.push(quote.slice(0, 200));
      merged.set(number, list);
    }
  }
  for (const [number, quotes] of merged) {
    const source = sources[number - 1];
    if (!source) continue;
    source.quotes = quotes.slice(0, 3);
    if (source.quotes.length > 0) source.snippet = source.quotes[0]!.slice(0, 240);
  }
}

/** 没有逐字摘引的引用：用正文与原文的逐字重合片段补定位锚点（不是证据）。 */
function attachAnswerAnchors(
  answer: string,
  sources: ChatSource[],
  originals: AuditOriginal[]
): void {
  const anchors = answerAnchors(
    answer,
    originals.map((original) => ({
      page: original.page,
      text: original.text,
      quotes: sources[original.source - 1]?.quotes
    }))
  );
  for (const [number, anchor] of Object.entries(anchors)) {
    const source = sources[Number(number) - 1];
    if (source && !(source.quotes && source.quotes.length > 0)) {
      source.anchor = anchor;
    }
  }
}


function userContext(question: string, selection: string): string {
  const head = `用户问题（用户自己提的问题，不是文献原文，不要把它当作选文或引用）：${question}`;
  if (!selection) {
    return `${head}\n（本轮没有选文——用户没有从文献里选任何文字。）`;
  }
  return `${head}\n选文（用户在文献里选中的原文，逐字）：${selection}`;
}

/** 单篇/跨文献路径：把已读页原文交给审计，摘引按来源编号逐字核验。 */
function auditInputsForSources(
  store: Store,
  sources: ChatSource[]
): { evidenceIndex: AuditEvidence[]; originals: AuditOriginal[] } {
  const originals: AuditOriginal[] = sources.map((source, index) => {
    const text = store.getPageText(source.documentId, source.page) || source.snippet;
    return {
      source: index + 1,
      document_id: source.documentId,
      page: source.page,
      text,
      source_type: 'document'
    };
  });
  // 证据材料只带必要片段，避免把整篇原文再次外发；核验仍以 originals 全文为准。
  let room = 12000;
  const evidenceIndex: AuditEvidence[] = [];
  for (const original of originals) {
    if (room <= 0) break;
    const quote = original.text.slice(0, Math.min(4000, room));
    if (!quote.trim()) continue;
    evidenceIndex.push({
      source: original.source,
      page: original.page,
      quote
    });
    room -= quote.length;
  }
  return { evidenceIndex, originals };
}

/** 多批路径：证据银行里每条摘引都有 evidence_key，审计可只指认而不重抄。 */
function auditInputsForBank(
  store: Store,
  sources: ChatSource[],
  bank: EvidenceBankRecord[]
): { evidenceIndex: AuditEvidence[]; originals: AuditOriginal[] } {
  const originals: AuditOriginal[] = sources.map((source, index) => {
    const text = store.getPageText(source.documentId, source.page) || source.snippet;
    return {
      source: index + 1,
      document_id: source.documentId,
      page: source.page,
      text,
      source_type: 'document'
    };
  });
  const evidenceIndex: AuditEvidence[] = bank.map((item, index) => ({
    source: index + 1,
    quote: item.quote,
    evidence_key: item.evidence_key,
    ...(item.page !== undefined ? { page: item.page } : {})
  }));
  return { evidenceIndex, originals };
}

/** foreign 引文按页找回：只读已保存文本，不触发 OCR。 */
function findQuotePage(
  store: Store,
  documentId: string,
  quote: string,
  total: number
): number | null {
  const needle = quote.replace(/\s+/g, '');
  if (!needle) return null;
  for (let page = 1; page <= total; page += 1) {
    const text = store.getPageText(documentId, page).replace(/\s+/g, '');
    if (text.includes(needle)) return page;
  }
  return null;
}

/** 内容寻址检查点：只认 stage 摘要，恢复时阅读执行器会重新逐字核验。 */
function readingCheckpointFor(
  store: Store,
  taskId: string,
  documentIds: string | string[]
): {
  load: (stage: string) => unknown | null;
  save: (stage: string, value: unknown) => void;
} {
  const documents = Array.isArray(documentIds) ? documentIds : [documentIds];
  return {
    load: (stage) => store.loadCheckpoint<unknown>(taskId, stage)?.value ?? null,
    save: (stage, value) => store.saveCheckpoint(taskId, stage, value, documents)
  };
}

/** 检查点身份：问题/选文/模型/容量/来源任一变化都不复用旧批次。 */
function readingCheckpointIdentity(
  question: string,
  selection: string,
  config: ReadingChatConfig,
  budget: number,
  sources: ReadingSource[]
): string {
  return JSON.stringify({
    version: 5,
    question,
    selection,
    model: config.model,
    baseUrl: config.baseUrl,
    budget,
    sources: sources.map((source) => [source.document_id, source.page])
  });
}

/** 视觉读页材料：派生解读，不能作为逐字原文证据。 */
function visualMaterialOf(visual: VisualReadingSupplement): string {
  if (!visual.enabled || visual.pages.length === 0) return '';
  return (
    '页面视觉解读（派生资料，不是逐字原文；不能作为逐字证据引用，提到时请明确说明是视觉解读）：\n' +
    visual.pages
      .map(
        (page) =>
          `第 ${page.page} 页：${JSON.stringify({
            transcription: page.transcription,
            elements: page.elements,
            uncertainties: page.uncertainties
          })}`
      )
      .join('\n\n')
  );
}

function visualChatSources(visual: VisualReadingSupplement): ChatSource[] {
  if (!visual.enabled) return [];
  return visual.sources.map((source) => ({
    documentId: source.documentId,
    documentName: source.documentName,
    page: source.page,
    snippet: source.snippet,
    quotes: [],
    sourceType: 'visual_model'
  }));
}


function applyAuditRewrite(
  config: ReadingChatConfig,
  answer: string,
  report: AuditReport,
  originals: AuditOriginal[]
): string {
  // 合规 P2-19：默认按证据确定性改写；只有用户显式选择“只标注”才保持模型正文。
  if (config.auditRewrite === 'annotate') {
    report.page_mentions_removed = [];
    return answer;
  }
  const rewritten = rewriteAuditedAnswer(answer, report, originals);
  report.page_mentions_removed = rewritten.pageMentionsRemoved;
  return rewritten.answer;
}


/** 并发调度：用户设置优先，本机模型自动降为 1。 */
function readingWorkers(config: ReadingChatConfig, maxParallel: number): number {
  return gotoWorkers(config.baseUrl, maxParallel);
}

function withQuestionContext(
  question: string,
  selection: string,
  config: ReadingChatConfig,
  signal?: AbortSignal
): (instruction: string, material: string) => Promise<string> {
  return (instruction, material) =>
    callChatModel(
      config,
      instruction,
      `${userContext(question, selection)}\n${material}`,
      3000,
      signal,
      undefined,
      undefined,
      undefined,
      '',
      [],
      true
    );
}


/** 只用已逐字核验证据的 role 判断“文献答到什么程度”。 */
function answerabilityFor(
  bank: EvidenceBankRecord[],
  searched: boolean
): ReturnType<typeof documentAnswerability> {
  return documentAnswerability(
    bank
      .map((item) => item.role)
      .filter((role): role is string => typeof role === 'string' && role.length > 0),
    searched
  );
}


/** 审计/回答内部使用；导出以便测试覆盖历史丢弃计数与 notice 合并口径。 */
export async function auditGeneratedAnswer(
  config: ReadingChatConfig,
  answer: string,
  inputs: { evidenceIndex: AuditEvidence[]; originals: AuditOriginal[] },
  signal?: AbortSignal,
  allowBackground = false,
  contextPrefix = '',
  answerability?: string,
  externalAllowed: readonly SourceKind[] = [],
  /** 本轮的输入容量上限；不传时按 activeAuditStore 的设置现算（跨文献路径没有 active store）。 */
  requestInputLimit?: number,
  /** 多轮历史：作为 prior 进入审计请求。 */
  history?: unknown
): Promise<AuditReport> {
  try {
    // 审计包预算与最终回答同一口径（手动模型容量生效）；无 active store 时退回 12000。
    const packetBudget = auditPacketBudgetFor(activeAuditStore);
    const auditInputLimit =
      requestInputLimit ?? (activeAuditStore ? chatInputLimit(activeAuditStore) : undefined);
    // 审计阶段因容量省略的历史轮数：同一份历史会在多次审计请求里被丢，取**最大**轮数而不是相加，
    // 否则同一批历史会被重复计数成两倍。写进 AuditReport.history_dropped 供 notice 合并展示。
    let historyDropped = 0;
    // 审计请求也可能带历史：按每条消息的 system/材料现算剩余容量，从最旧丢（不静默、但不截断证据）。
    const auditAsk = (instruction: string, material: string): Promise<string> => {
      const prepared = prepareHistory(
        history,
        auditInputLimit === undefined
          ? Number.POSITIVE_INFINITY
          : historyRoomFor(auditInputLimit, instruction, material)
      );
      historyDropped = Math.max(historyDropped, prepared.dropped);
      return callChatModel(
        config,
        instruction,
        material,
        3000,
        signal,
        undefined,
        undefined,
        auditInputLimit,
        '核对论断与原文',
        prepared.prior,
        true
      );
    };
    const lines = auditClaimsList(answer);
    // 回答较长时拆成多个审计包并行核对。
    // 逐包进度统一走这条说明（不覆盖原有的「正在核对论断与原文」阶段语义，只是补上 done/total）。
    const reportPacketProgress = (done: number, total: number): void => {
      activeStageCallback?.(`正在核对论断与原文（${done}/${total}）`);
    };
    if (lines.length <= 6) {
      activeStageCallback?.('正在逐段核对论断');
      const report = await auditAnswer(
        answer,
        auditAsk,
        {
          evidenceIndex: inputs.evidenceIndex,
          originals: inputs.originals,
          store: activeAuditStore,
          allowBackground,
          contextPrefix,
          answerability,
          externalAllowed,
          packetBudget,
          onPacket: reportPacketProgress
        }
      );
      activeAuditCallback?.(report.claims);
      return historyDropped > 0 ? { ...report, history_dropped: historyDropped } : report;
    }
    const packetCount = Math.min(3, Math.ceil(lines.length / 6));
    const packetSize = Math.ceil(lines.length / packetCount);
    const packets: Array<{ offset: number; lines: string[] }> = [];
    for (let index = 0; index < lines.length; index += packetSize) {
      packets.push({
        offset: index,
        lines: lines.slice(index, index + packetSize).map((item) => item.text)
      });
    }
    const completedClaims: AuditClaim[] = [];
    let completedPackets = 0;
    const reports = await Promise.all(
      packets.map(async (packet, packetIndex) => {
        reportPacketProgress(completedPackets, packets.length);
        activeStageCallback?.(
          `正在核对审计包 ${packetIndex + 1}/${packets.length}`
        );
        const report = await auditAnswer(
          packet.lines.join('\n'),
          auditAsk,
          {
            evidenceIndex: inputs.evidenceIndex,
            originals: inputs.originals,
            store: activeAuditStore,
            allowBackground,
            contextPrefix,
            answerability,
            externalAllowed,
            packetBudget
          }
        );
        // 一个审计包核对完成：done 单调 +1（多包并行时顺序不保证，界面只显示进度）。
        completedPackets += 1;
        reportPacketProgress(completedPackets, packets.length);
        const supported = report.claims.filter((claim) => claim.verdict === 'supported').length;
        const unsupported = report.claims.filter(
          (claim) => claim.verdict === 'unsupported'
        ).length;
        const mappedClaims = report.claims.map(
          (claim): AuditClaim => ({
            ...claim,
            claim: claim.claim + packet.offset,
            text: lines[claim.claim - 1 + packet.offset]?.text ?? claim.text
          })
        );
        completedClaims.push(...mappedClaims);
        activeAuditCallback?.(
          [...completedClaims].sort((left, right) => left.claim - right.claim)
        );
        const preview = report.claims
          .slice(0, 3)
          .map(
            (claim) =>
              `第${claim.claim}段 ${claim.verdict}${
                claim.text ? `：${claim.text.slice(0, 24)}` : ''
              }`
          )
          .join('；');
        activeStageCallback?.(
          `已核对审计包 ${packetIndex + 1}/${packets.length} · 支持 ${supported} · 缺证 ${unsupported}` +
            (preview ? ` · ${preview}` : '')
        );
        return {
          report,
          claims: report.claims.map(
            (claim): AuditClaim => ({
              ...claim,
              claim: claim.claim + packet.offset,
              text: lines[claim.claim - 1 + packet.offset]?.text ?? claim.text
            })
          )
        };
      })
    );
    const claims = reports.flatMap((item) => item.claims);
    const issues = reports.flatMap((item) =>
      item.report.issues.map((issue) => `审计包：${issue}`)
    );
    const complete =
      claims.length === lines.length &&
      reports.every((item) => item.report.status === '已进行模型证据支持复核');
    return {
      status: complete ? '已进行模型证据支持复核' : '部分段落未完成复核',
      issues,
      claims,
      ...(historyDropped > 0 ? { history_dropped: historyDropped } : {})
    };
  } catch (error) {
    return {
      status: '未完成',
      issues: [error instanceof Error ? error.message : '审计失败'],
      claims: []
    };
  }
}

/**
 * 阅读路径：plan -> 批次 -> 逐字证据 -> 最终回答。
 * taskId 存在时只补读上次未读页，并把新证据与上次证据合并后重新综合。
 */
function rereadRounds(
  rigor: 'auto' | 'fast' | 'standard' | 'exhaustive',
  multiPass: boolean,
  unsupported: number
): number {
  if (rigor === 'fast') return 0;
  if (rigor === 'exhaustive') return 3;
  if (rigor === 'standard') return 2;
  if (!multiPass) return 1;
  return unsupported >= 3 ? 3 : 2;
}

function gapReadingPages(
  store: Store,
  documentId: string,
  issues: string[],
  readPages: Set<number>,
  limit = 4
): Array<{ page: number; text: string }> {
  const terms = [
    ...new Set(
      issues
        .join('\n')
        .match(/[\u3400-\u9fff]{2,6}|[A-Za-z]{3,}/g)
        ?.map((term) => term.trim())
        .filter((term) => term.length >= 2) ?? []
    )
  ].slice(0, 30);
  if (terms.length === 0) return [];
  const document = store.getDocument(documentId);
  if (!document) return [];
  const candidates: Array<{ page: number; score: number; text: string }> = [];
  for (let page = 1; page <= document.pages; page += 1) {
    if (readPages.has(page)) continue;
    const text = store.getPageText(documentId, page);
    if (!text.trim()) continue;
    const normalized = text.toLowerCase();
    const score = terms.reduce(
      (total, term) => total + (normalized.includes(term.toLowerCase()) ? 1 : 0),
      0
    );
    if (score > 0) candidates.push({ page, score, text });
    if (candidates.length > 60) break;
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.page - right.page)
    .slice(0, limit)
    .map(({ page, text }) => ({ page, text }));
}

/** 启用且就绪的本地目录 → 请求页所在章的页集合；未启用/过期时返回空（回退旧行为）。 */
function navigationPlanPages(
  store: Store,
  documentId: string,
  pages: number[],
  totalPages: number
): number[] {
  try {
    const status = store.navigationStatus(documentId);
    if (!status || status.state !== 'ready' || !status.enabled) return [];
    return navigationSectionPages(store.planningNavigation(documentId), pages, totalPages);
  } catch {
    return [];
  }
}

async function expandRequestedPages(
  store: Store,
  documentId: string,
  requested: number[],
  readPages: Set<number>
): Promise<number[]> {
  const document = store.getDocument(documentId);
  if (!document) return [];
  let tree: Awaited<ReturnType<Store['getStructure']>> = [];
  try {
    tree = await store.getStructure(documentId);
  } catch {
    tree = [];
  }
  // 并集：结构树章节扩展 ∪ 启用的本地目录章节扩展（只会多读，不会少读）。
  const expanded = new Set(expandSections(requested, tree, document.pages));
  for (const page of navigationPlanPages(store, documentId, requested, document.pages)) {
    expanded.add(page);
  }
  return [...expanded]
    .filter((page) => !readPages.has(page))
    .sort((left, right) => left - right)
    .slice(0, 12);
}

async function requestRereadPages(
  store: Store,
  config: ReadingChatConfig,
  documentId: string,
  question: string,
  issues: string[],
  material: string,
  readPages: Set<number>,
  signal?: AbortSignal
): Promise<Array<{ page: number; text: string }>> {
  const instruction =
    'READING_REREAD：检查现有阅读材料是否遗漏了回答问题所需的定义、反例、条件或跨页联系。' +
    '只返回 JSON：{"read":[{"pages":[页码],"section":"章节标题","query":"要核对的定义或事实"}],"reason":"原因"}。' +
    'read 最多 3 项；页码可空，section 可以是目录里的章节标题，query 用于按含义定位；' +
    '页码必须是这篇文献中尚未读过的页；证据足够时返回空数组。';
  try {
    const payload = await callChatModel(
      config,
      instruction,
      JSON.stringify({
        question,
        issues: issues.slice(0, 8),
        already_read_pages: [...readPages].sort((a, b) => a - b).slice(0, 200),
        reading_material: material.slice(0, 6000)
      }),
      800,
      signal,
      undefined,
      undefined,
      chatInputLimit(store),
      '检查遗漏并回读',
      [],
      true
    );
    const start = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(payload.slice(start, end + 1)) as {
      read?: Array<{ pages?: unknown; query?: unknown; section?: unknown }>;
    };
    const requests = Array.isArray(parsed.read) ? parsed.read : [];
    const requestedPages = [
      ...new Set(
        requests
          .flatMap((item) => (Array.isArray(item.pages) ? item.pages : []))
          .filter(
            (page): page is number =>
              Number.isInteger(page) && page >= 1 && page <= 3000
          )
      )
    ].filter((page) => !readPages.has(page));
    const queryPages = requests
      .map((item) => (typeof item.query === 'string' ? item.query.trim() : ''))
      .filter(Boolean)
      .flatMap((query) =>
        gapReadingPages(store, documentId, [query], readPages, 2).map(
          (gap) => gap.page
        )
      );
    const navigation = store.planningNavigation(documentId);
    const sectionPages = requests
      .map((item) => (typeof item.section === 'string' ? item.section.trim() : ''))
      .filter(Boolean)
      .flatMap((section) => {
        const matched = navigation.find(
          (entry) =>
            entry.label.toLowerCase().includes(section.toLowerCase()) ||
            section.toLowerCase().includes(entry.label.toLowerCase())
        );
        if (!matched) return [];
        const next = navigation.find((entry) => entry.page > matched.page);
        const start = matched.page;
        const end = Math.min(next ? next.page - 1 : start + 5, start + 7);
        return Array.from({ length: Math.max(1, end - start + 1) }, (_, i) => start + i);
      });
    const pages = [...new Set([...requestedPages, ...queryPages, ...sectionPages])];
    // 章节级补读：按目录标题扩展到该页所在章节，而不是只取请求的那一页；
    // 同时限制总字符，避免一次回读把上下文预算打满。
    const expanded = await expandRequestedPages(
      store,
      documentId,
      pages.slice(0, 3),
      readPages
    );
    const result: Array<{ page: number; text: string }> = [];
    let budget = 12000;
    for (const page of expanded) {
      const text = store.getPageText(documentId, page);
      if (!text.trim()) continue;
      const clipped = text.slice(0, budget);
      if (!clipped.trim()) break;
      result.push({ page, text: clipped });
      budget -= clipped.length;
      if (budget <= 0) break;
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 综合前回读的合并：
 * 把模型指出的未读页读成一批，与主阅读的 findings/证据银行/已读页合并后再综合。
 */
function mergeSingleDocumentRuns(
  base: ReadInBatchesResult,
  extra: ReadInBatchesResult,
  dimensions: Array<{ code: string; label: string }>
): ReadInBatchesResult {
  const sourceFindings = [...base.sourceFindings, ...extra.sourceFindings];
  const bankByKey = new Map<string, EvidenceBankRecord>();
  for (const item of [...base.bank, ...extra.bank]) {
    if (!bankByKey.has(item.evidence_key)) bankByKey.set(item.evidence_key, item);
  }
  const bank = [...bankByKey.values()];
  const readPages = [...new Set([...base.readPages, ...extra.readPages])].sort(
    (left, right) => left - right
  );
  const deferredPages = [...new Set([...base.deferredPages, ...extra.deferredPages])]
    .filter((pageNumber) => !readPages.includes(pageNumber))
    .sort((left, right) => left - right);
  const deferredDocuments: Record<string, number[]> = {};
  for (const [documentId, pages] of Object.entries(base.deferredDocuments)) {
    const remain = pages.filter((pageNumber) => !readPages.includes(pageNumber));
    if (remain.length > 0) deferredDocuments[documentId] = remain;
  }
  const evidence = evidenceBank(sourceFindings);
  return {
    findings: [...base.findings, ...extra.findings],
    sourceFindings,
    bank,
    coverage:
      dimensions.length > 0 ? readingCoverage(sourceFindings, dimensions) : {},
    readPages,
    deferredBatches: 0,
    resumed_reduces: base.resumed_reduces + extra.resumed_reduces,
    deferredPages,
    deferredDocuments,
    report: {
      ...base.report,
      batches: base.report.batches + extra.report.batches,
      multiPass: true,
      findings: sourceFindings.length,
      resumed_batches: base.report.resumed_batches + extra.report.resumed_batches,
      resumed_reduces: base.report.resumed_reduces + extra.report.resumed_reduces,
      evidence: evidence.report,
      evidence_bank: {
        available: evidence.report.available,
        kept: evidence.report.kept,
        dropped: evidence.report.dropped,
        deduped: evidence.report.deduped,
        dropped_keys: extra.report.evidence_bank?.dropped_keys ?? []
      },
      evidence_accounting:
        extra.report.evidence_accounting ?? base.report.evidence_accounting
    }
  };
}

async function sweepDocument(
  store: Store,
  secrets: SecretStore,
  documentId: string,
  query: string,
  /** 规划给出的同义/英文查询词（`query_terms` + `plan.queries` 口径）。 */
  planQueries: string[],
  scope: number[],
  limit = 8
): Promise<{ report: SweepReport; matches: Array<{ page: number; text: string }> }> {
  const document = store.getDocument(documentId);
  if (!document) {
    return { report: sweepReport([], [], scope, limit), matches: [] };
  }
  const rows: Array<[number, string]> = [];
  for (let page = 1; page <= document.pages; page += 1) {
    const text = store.getPageText(documentId, page);
    if (text.trim()) rows.push([page, text]);
  }
  // 术语按 `query_terms` 口径（去脚手架词），并并入规划查询词；
  // 不再只用正则切问题里的词。
  const terms = [
    ...new Set([
      ...extractKeywords(query)
        .split(/\s+/)
        .filter((term) => term.length >= 2),
      ...planQueries.filter((term) => typeof term === 'string' && term.trim().length >= 2)
    ])
  ].slice(0, 24);
  // 有 embedding 时补一路语义召回，与词面命中取并集，但两路分别留痕。
  let semanticHits: number[] = [];
  if (rows.length > 0 && rows.length <= 300) {
    const vectors = await vectorsFor(store, secrets, [
      query,
      ...rows.map(([, text]) => text.slice(0, 1200))
    ]);
    if (vectors?.[0]) {
      const scores = new Map<number, number>();
      rows.forEach(([page], index) => {
        scores.set(page, vectors[index + 1] ? cosine(vectors[0]!, vectors[index + 1]!) : 0);
      });
      // 语义选页：绝对 0.30 + 相对最优 0.80，不取固定 Top-K。
      semanticHits = pickPages(scores, 6);
    }
  }
  const report = sweepReport(rows, terms, scope, limit, 2, semanticHits);
  return {
    report,
    matches: report.added_pages.map((page) => ({
      page,
      text: store.getPageText(documentId, page)
    }))
  };
}

/**
 * 跨文献（语料级）阅读：discovery 排序 → 逐篇逐页取本机原文 → 逐批模型阅读 → 读后缺口补读 → 综合 → 审计。
 *
 * 全部候选文献都参与阅读（排序只影响先读哪几篇，不减少集合），不用"章节摘录"
 * 近似整篇阅读；预算用尽时只读前 N 批，其余页作为延期页如实上报，可继续阅读。
 */
export async function answerWithCorpus(
  store: Store,
  secrets: SecretStore,
  config: ReadingChatConfig,
  question: string,
  selection: string,
  documentIds: string[],
  budget: number,
  signal?: AbortSignal,
  onDraft?: (text: string) => void,
  allowKnowledge = false,
  history?: unknown,
  onProgress?: (done: number, total: number) => void,
  /** 继续阅读：上次跨文献回答返回的任务编号；只补读未读页，不重读已读部分。 */
  taskId?: string,
  /** 问题规划：沿用规划给出的覆盖维度与查询词（缺省退回 DEFAULT_DIMENSIONS / 空）。 */
  planInput?: ReadingPlanRecord,
  /** 用户笔记/批注补充材料：只进入最终回答，不进入证据银行/审计/引用编号。 */
  memoryMaterial = ''
): Promise<ChatResponse | null> {
  const capacity = readCapacity(store.getSettings());
  const requestInputLimit = chatInputLimit(store);
  const currentId = documentIds[0] ?? '';
  const documents = documentIds
    .map((id) => store.getDocument(id))
    .filter((document): document is NonNullable<ReturnType<Store['getDocument']>> => Boolean(document));
  if (documents.length === 0) return null;

  const activeTaskId = taskId ?? randomUUID();
  const checkpointDocuments = documents.map((document) => document.id);
  const resume = taskId ? store.loadReadingTask<CorpusTaskPayload>(taskId) : null;
  const prior =
    resume?.payload && (resume.payload as CorpusTaskPayload).kind === 'corpus'
      ? (resume.payload as CorpusTaskPayload)
      : null;
  const priorReadByDocument = prior?.readByDocument ?? {};
  // 续读沿用任务里记下的预算：预算不同会让内容寻址的批次键对不上，中断恢复就会重读。
  const activeBudget = prior?.budget && prior.budget > 0 ? prior.budget : budget;
  if (!prior) {
    // 新任务先落一条进行中的任务：进程中断后界面仍能看到并继续（批次检查点按同一 taskId 保存）。
    store.saveReadingTask(
      activeTaskId,
      {
        kind: 'corpus',
        question,
        selection,
        documentIds: checkpointDocuments,
        budget: activeBudget,
        pagesRead: [],
        unread_pages: documents
          .flatMap((document) =>
            Array.from({ length: document.pages }, (_, index) => index + 1)
          )
          .sort((left, right) => left - right),
        readByDocument: {},
        readSegments: [],
        deferredByDocument: {},
        findings: [],
        sourceFindings: [],
        answer: '',
        sources: []
      } satisfies CorpusTaskPayload,
      checkpointDocuments
    );
  }

  // 0) 自动 OCR 是增强项：只处理没有原生文本的页；失败不阻断本轮阅读，缺页由报告如实记录。
  for (const document of documents) {
    try {
      await ensureAutoOcr(store, secrets, document.id);
    } catch {
      // 识别服务不可用时按"该页无文字"继续。
    }
  }

  // 1) discovery：当前文献优先 → 词面命中数降序 → 名称 → id；**集合不减少**。
  const terms = termsOf(question);
  const texts: Record<string, string> = {};
  for (const document of documents) {
    texts[document.id] = store.documentTextState(document.id);
  }
  const scores = documentScores(terms, texts);
  const ordered = orderDocuments(documents, scores, currentId);
  const discovery: DiscoveryReportRecord = discoveryReport(ordered, scores, currentId, terms);

  // 2) 逐篇逐页取本机已索引原文；空页如实记为缺页，不伪造。
  //    继续阅读时只把**还没读过**的页交给阅读器：已读批次的派生记录与逐字证据
  //    由任务原样带上（批次检查点也会复用），不重新调用模型、不重读整篇。
  const sources: ReadingSource[] = [];
  const reports: CorpusDocumentReport[] = [];
  let indexedPages = 0;
  let totalPages = 0;
  for (const document of ordered) {
    const readable: number[] = [];
    const missing: number[] = [];
    const ocrPages: number[] = [];
    const qualityPages: number[] = [];
    for (let pageNumber = 1; pageNumber <= document.pages; pageNumber += 1) {
      totalPages += 1;
      const text = store.getPageText(document.id, pageNumber);
      if (!text.trim()) {
        missing.push(pageNumber);
        continue;
      }
      readable.push(pageNumber);
      indexedPages += 1;
      if (store.getPageEdit(document.id, pageNumber)?.origin === 'ocr') {
        ocrPages.push(pageNumber);
      }
      // 有字但疑似乱码的页不能当作"读到全篇"：如实标出，由全篇判定与提示使用。
      if (textQuality(text).suspect) qualityPages.push(pageNumber);
      if (priorReadByDocument[document.id]?.includes(pageNumber)) continue;
      sources.push({
        document_id: document.id,
        page: pageNumber,
        name: document.name,
        text
      });
    }
    reports.push({
      document_id: document.id,
      name: document.name,
      total_pages: document.pages,
      readable_pages: readable.length,
      read_pages: [],
      missing_pages: missing,
      ocr_pages: ocrPages,
      quality_pages: qualityPages,
      whole_document: missing.length === 0 && qualityPages.length === 0
    });
  }
  if (sources.length === 0) {
    if (prior) {
      // 任务里记录的页已经全部读完（或都已缺页）：按已保存的回答收尾，并销掉任务。
      store.deleteReadingTask(activeTaskId);
      // 只挑回答字段返回：任务内部字段（kind/budget/逐篇页数）不属于 API 契约。
      return {
        answer: prior.answer,
        sources: prior.sources,
        taskId: activeTaskId,
        reused_answer: true,
        notice: '这些文献已没有需要补读的页；下面是上一轮已保存的回答，本轮没有重新调用模型。'
      };
    }
    throw new Error(
      '这些文献还没有可检索的文字（可能是扫描件且尚未识别）；请先识别，或改选有文字的文献。'
    );
  }

  // 规划维度/查询词（chat.ts 的 corpus 调用会传 plan）：维度非法/为空时退回通用 D1–D6；
  // 查询词并入读后缺口检索，避免只用问题里的字面词。
  const dimensions =
    planInput && Array.isArray(planInput.dimensions) && planInput.dimensions.length > 0
      ? planInput.dimensions
      : DEFAULT_DIMENSIONS;
  const planQueries = (planInput?.queries ?? []).filter(
    (query) => typeof query === 'string' && query.trim().length >= 2
  );
  const ask = (instruction: string, material: string): Promise<string> =>
    callChatModel(
      config,
      instruction,
      `${userContext(question, selection)}\n${material}`,
      3000,
      signal,
      undefined,
      undefined,
      requestInputLimit,
      '分批阅读原文',
      [],
      true
    );
  const readOptions = {
    dimensions,
    maxBatches: turnReadBatches(capacity.maxReadBatches),
    allowPartial: true,
    signal,
    onProgress,
    workers: readingWorkers(config, capacity.maxParallel),
    // 批次检查点与单篇阅读同口径：按 taskId 保存，内容寻址；恢复时执行器仍会逐字重新核验。
    checkpoint: readingCheckpointFor(store, activeTaskId, checkpointDocuments),
    identity: JSON.stringify({
      version: 6,
      question,
      selection,
      model: config.model,
      baseUrl: config.baseUrl,
      budget: activeBudget,
      documents: checkpointDocuments
    })
  };
  // 单页原文可能就超过一轮预算（大页/长页）：先按预算切段再分批，否则 batches() 会直接抛
  // 「单段原文超过上下文预算」而整轮退回检索（真实 E2E 踩到）。按来源拆分。
  // 续读时按**已读分段**（而不是整页）跳过：大页一轮读不完时，只按页记已读会让每轮都从
  // 同一页开头重来、永远不前进（真实 E2E 踩到）。
  const segmentStart = (segment: ReadingSource): number =>
    typeof segment.offset_start === 'number' ? segment.offset_start : 0;
  const segmentEnd = (segment: ReadingSource): number =>
    typeof segment.offset_end === 'number' ? segment.offset_end : segment.text.length;
  const segmentKeyOf = (segment: ReadingSource): string =>
    `${segment.document_id}\u001f${segment.page}\u001f${segmentStart(segment)}\u001f${segmentEnd(segment)}`;
  const segmentRecordOf = (segment: ReadingSource) => ({
    documentId: segment.document_id,
    page: segment.page,
    start: segmentStart(segment),
    end: segmentEnd(segment)
  });
  const doneSegmentKeys = new Set(
    (prior?.readSegments ?? []).map(
      (row) => `${row.documentId}\u001f${row.page}\u001f${row.start}\u001f${row.end}`
    )
  );
  const segments = splitSources(sources, activeBudget).filter(
    (segment) => !doneSegmentKeys.has(segmentKeyOf(segment))
  );
  if (segments.length === 0) {
    store.deleteReadingTask(activeTaskId);
    return {
      answer: prior?.answer ?? '',
      sources: prior?.sources ?? [],
      taskId: activeTaskId,
      reused_answer: true,
      notice: '这些文献已没有需要补读的分段；下面是上一轮已保存的回答，本轮没有重新调用模型。'
    };
  }
  const maxTurnBatches = readOptions.maxBatches;
  const turnGroups = batches(segments, activeBudget);
  const readSegmentsDone = [
    ...(prior?.readSegments ?? []),
    ...turnGroups
      .slice(0, maxTurnBatches)
      .flatMap((group) => group.map(([, segment]) => segmentRecordOf(segment)))
  ];
  const execution = await readInBatches(segments, activeBudget, ask, readOptions);

  // 主阅读的 findings（不含综合前回读/读后缺口补读的批次）：coverage 台账只按主批次记账，
  // 回读/缺口补读属于 additional_reading，不改变主批次统计。
  const mainFindings = [...(prior?.sourceFindings ?? []), ...execution.sourceFindings];
  let findingsAll = [...mainFindings];
  let synthesisFindings = [...(prior?.findings ?? []), ...execution.findings];
  let bank = prior ? fitBank(evidenceBank(findingsAll).bank, activeBudget).bank : execution.bank;
  let batchesRead = execution.report.batches;
  let gapDeferredBatches = 0;
  let deferredByDocument: Record<string, number[]> = { ...execution.deferredDocuments };
  const mergeBank = (extra: EvidenceBankRecord[]): void => {
    const bankByKey = new Map<string, EvidenceBankRecord>();
    for (const item of [...bank, ...extra]) {
      if (!bankByKey.has(item.evidence_key)) bankByKey.set(item.evidence_key, item);
    }
    bank = [...bankByKey.values()];
  };

  // 3) 综合前回读：最多 2 轮；每轮让模型指出缺口页 →
  //    本地补读一批 → 并入证据后进入下一轮；失败不阻断。回读批次不计入 coverage.batches。
  let rereadRounds = 0;
  for (let rereadRound = 0; rereadRound < 2; rereadRound += 1) {
    let requestedReread = false;
    try {
    const manifest = ordered.map((document) => ({
      document_id: document.id,
      name: document.name,
      pages: document.pages
    }));
    const readMaterial =
      synthesisFindings
        .slice(0, 6)
        .map((finding) => finding.analysis)
        .join('\n')
        .slice(0, 4000) || question;
    const payload = await callChatModel(
      config,
      'READING_REREAD：检查当前阅读材料是否遗漏回答问题所需的定义、反例、条件或跨页联系。' +
        '只返回 JSON：{"read":[{"document_id":"目录中的ID","pages":[页码],"query":"要核对的定义或事实"}],"reason":"原因"}；' +
        'read 最多 3 项，页码必须是尚未读过的页；证据足够返回空数组。',
      JSON.stringify({ question, documents: manifest, reading_records: readMaterial }),
      800,
      signal,
      undefined,
      undefined,
      chatInputLimit(store),
      '检查遗漏并回读',
      [],
      true
    );
    const start = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    const parsed =
      start >= 0 && end > start
        ? (JSON.parse(payload.slice(start, end + 1)) as {
            read?: Array<{ document_id?: unknown; pages?: unknown }>;
          })
        : {};
    const requests = Array.isArray(parsed.read) ? parsed.read : [];
    const rereadSources: ReadingSource[] = [];
    for (const request of requests.slice(0, 3)) {
      if (!request || typeof request.document_id !== 'string') continue;
      const document = ordered.find((item) => item.id === request.document_id);
      if (!document) continue;
      const deferred = new Set(deferredByDocument[document.id] ?? []);
      const pages = (Array.isArray(request.pages) ? request.pages : [])
        .filter(
          (page): page is number =>
            Number.isInteger(page) && page >= 1 && page <= document.pages && !deferred.has(page)
        )
        .slice(0, 3);
      for (const page of pages) {
        const text = store.getPageText(document.id, page);
        if (text.trim()) {
          rereadSources.push({ document_id: document.id, page, name: document.name, text });
        }
      }
    }
    if (rereadSources.length > 0) {
      requestedReread = true;
      const rereadRun = await readInBatches(rereadSources, activeBudget, ask, {
        dimensions,
        maxBatches: Math.max(1, Math.min(3, turnReadBatches(capacity.maxReadBatches))),
        allowPartial: true,
        signal,
        workers: readingWorkers(config, capacity.maxParallel)
      });
      findingsAll = [...findingsAll, ...rereadRun.sourceFindings];
      synthesisFindings = [...synthesisFindings, ...rereadRun.findings];
      mergeBank(rereadRun.bank);
      for (const source of rereadSources) {
        const remain = (deferredByDocument[source.document_id] ?? []).filter(
          (page) => page !== source.page
        );
        if (remain.length > 0) deferredByDocument[source.document_id] = remain;
        else delete deferredByDocument[source.document_id];
      }
    }
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    // 回读规划失败不阻断综合：保留已有证据，由审计与本机缺口检索兜底。
  }
    if (requestedReread) rereadRounds += 1;
    if (!requestedReread) break;
  }

  // 4) 读后缺口补读：
  //    延期页里问题术语/规划查询词命中的页补读一批——只增不减，读完再出账。
  const gapTerms = [...new Set([...terms, ...planQueries])].filter(
    (term) => typeof term === 'string' && term.trim().length >= 2
  );
  const gapCandidates: Array<{ score: number; source: ReadingSource }> = [];
  for (const document of ordered) {
    const deferred = deferredByDocument[document.id] ?? [];
    for (const pageNumber of deferred) {
      const text = store.getPageText(document.id, pageNumber).trim();
      if (!text) continue;
      const lowered = text.toLowerCase();
      const score = gapTerms.reduce(
        (total, term) => total + (lowered.includes(term.toLowerCase()) ? 1 : 0),
        0
      );
      if (score > 0) {
        gapCandidates.push({
          score,
          source: { document_id: document.id, page: pageNumber, name: document.name, text }
        });
      }
    }
  }
  gapCandidates.sort((left, right) => right.score - left.score);
  const gapSources = gapCandidates.slice(0, 6).map((item) => item.source);
  const gapSearched = gapTerms.length > 0;
  if (gapSources.length > 0) {
    const gapMaxBatches = Math.max(1, Math.min(2, turnReadBatches(capacity.maxReadBatches)));
    const gapSegments = splitSources(gapSources, activeBudget);
    const gapGroups = batches(gapSegments, activeBudget);
    // 缺口补读同样按分段记录已读：否则同一页会在后续继续阅读里反复从开头补。
    readSegmentsDone.push(
      ...gapGroups
        .slice(0, gapMaxBatches)
        .flatMap((group) => group.map(([, segment]) => segmentRecordOf(segment)))
    );
    const gapRun = await readInBatches(gapSegments, activeBudget, ask, {
      ...readOptions,
      maxBatches: gapMaxBatches,
      onBatch: undefined,
      onBatchStart: undefined
    });
    findingsAll = [...findingsAll, ...gapRun.sourceFindings];
    synthesisFindings = [...synthesisFindings, ...gapRun.findings];
    batchesRead += gapRun.report.batches;
    gapDeferredBatches = gapRun.deferredBatches;
    mergeBank(gapRun.bank);
    const readGapKeys = new Set(gapSources.map((source) => `${source.document_id}\u001f${source.page}`));
    for (const [documentId, pages] of Object.entries(gapRun.deferredDocuments)) {
      for (const page of pages) readGapKeys.delete(`${documentId}\u001f${page}`);
    }
    const mergedDeferred: Record<string, number[]> = {};
    for (const [documentId, pages] of Object.entries(deferredByDocument)) {
      const remain = pages.filter((page) => !readGapKeys.has(`${documentId}\u001f${page}`));
      if (remain.length > 0) mergedDeferred[documentId] = remain;
    }
    for (const [documentId, pages] of Object.entries(gapRun.deferredDocuments)) {
      const list = mergedDeferred[documentId] ?? [];
      for (const page of pages) if (!list.includes(page)) list.push(page);
      if (list.length > 0) mergedDeferred[documentId] = list.sort((a, b) => a - b);
    }
    deferredByDocument = mergedDeferred;
  }
  // 缺口检索是否查全：术语非空且补读后没有剩余未读的命中页。
  const gapRemaining = gapCandidates.filter(
    (candidate) =>
      !gapSources.some(
        (source) =>
          source.document_id === candidate.source.document_id &&
          source.page === candidate.source.page
      )
  );
  const gapRan = gapSearched && gapRemaining.length === 0;
  const coverageData = readingCoverage(mainFindings, dimensions) as ReadingCoverage;
  const coverageEntries = Object.entries(deferredByDocument);
  const deferredTotal = coverageEntries.reduce((total, [, pages]) => total + pages.length, 0);
  for (const report of reports) {
    const deferred = new Set(deferredByDocument[report.document_id] ?? []);
    report.read_pages = Array.from({ length: report.total_pages }, (_, index) => index + 1).filter(
      (page) => !deferred.has(page) && !report.missing_pages.includes(page)
    );
    // 延期后必须重算"是否读到全篇"：否则报告会同时出现「已读全篇」与 read_pages < total_pages。
    report.partial = deferred.size > 0;
    report.unread_pages = [...deferred].sort((left, right) => left - right);
    report.whole_document = report.read_pages.length === report.total_pages;
  }
  const missingTotal = reports.reduce((total, report) => total + report.missing_pages.length, 0);
  const qualityTotal = reports.reduce(
    (total, report) => total + (report.quality_pages?.length ?? 0),
    0
  );
  const fullExtractedText = deferredTotal === 0 && missingTotal === 0 && qualityTotal === 0;

  // 跨文献视觉读页补充（派生资料，不进入逐字证据）：只对实际读过的页做图表/公式解读。
  const visualSupplements: VisualReadingSupplement[] = [];
  const visualWarnings: string[] = [];
  for (const document of ordered) {
    const report = reports.find((item) => item.document_id === document.id);
    const pages = (report?.read_pages ?? []).slice(0, 60);
    if (pages.length === 0) continue;
    try {
      const supplement = await visualReadingSupplement(
        store,
        secrets,
        document.id,
        pages,
        signal
      );
      if (supplement.pages.length > 0) visualSupplements.push(supplement);
      visualWarnings.push(...supplement.warnings);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
      visualWarnings.push(
        `「${document.name}」视觉读页失败：${error instanceof Error ? error.message : '未知错误'}，已跳过。`
      );
    }
  }
  const visualText = visualSupplements
    .map((supplement) => visualMaterialOf(supplement))
    .filter(Boolean)
    .join('\n\n');

  const synthesized = await synthesize(
    store,
    config,
    question,
    selection,
    ordered[0]!.id,
    synthesisFindings,
    bank,
    signal,
    fullExtractedText,
    allowKnowledge,
    onDraft,
    visualText,
    history,
    memoryMaterial
  );
  const sanitized = sanitizeAnswer(synthesized.answer, synthesized.sources);
  synthesized.answer = sanitized.answer;

  const auditInputs = auditInputsForBank(store, synthesized.sources, bank);
  const audit = await auditGeneratedAnswer(
    config,
    synthesized.answer,
    auditInputs,
    signal,
    allowKnowledge,
    userContext(question, selection),
    answerabilityFor(bank, gapRan),
    [],
    requestInputLimit,
    history
  );
  const auditedAnswer = applyAuditRewrite(config, synthesized.answer, audit, auditInputs.originals);
  attachSourceQuotes(synthesized.sources, findingsAll, audit.claims);
  attachAnswerAnchors(auditedAnswer, synthesized.sources, auditInputs.originals);
  const plan: ReadingPlanRecord = {
    breadth: 'discovery',
    reason: '用户选择跨文献范围：按语料级 discovery 顺序逐篇阅读',
    origin: '规则',
    pages: [],
    queries: [],
    dimensions
  };
  const notices: string[] = [];
  if (deferredTotal > 0) {
    notices.push(
      `本轮读到容量上限（${batchesRead} 批）：以下结论只基于已读部分，未读的还有 ${deferredTotal} 页。` +
        '已保存继续阅读任务；点「继续阅读」接着读，已读部分不会重读。'
    );
  }
  if (gapSources.length > 0) {
    notices.push(`本机核对发现 ${gapSources.length} 页问题相关原文未读，已补读。`);
  }
  if (rereadRounds > 0) {
    notices.push(`综合前按模型指出的缺口回读了 ${rereadRounds} 轮（只补读未读页，已并入证据）。`);
  }
  if (missingTotal > 0) {
    notices.push(`有 ${missingTotal} 页没有可读文字（可能是扫描页），未计入阅读范围。`);
  }
  if (qualityTotal > 0) {
    notices.push(
      `有 ${qualityTotal} 页文本疑似乱码/字体异常（替换字符占比过高），已视为解析可疑、未宣称读到全篇。`
    );
  }
  if (synthesized.droppedRecords > 0) {
    notices.push(
      `按上下文容量省略了 ${synthesized.droppedRecords} 条批次派生分析；逐字核验摘引未删。`
    );
  }
  const historyNote = historyDropNotice(synthesized.historyDropped, audit.history_dropped);
  if (historyNote) notices.push(historyNote);
  if (sanitized.removed.length > 0) {
    notices.push(`已删除无来源支持的页码表述：${sanitized.removed.join('、')}`);
  }
  notices.push(...visualWarnings);
  const allSources = [
    ...synthesized.sources,
    ...visualSupplements.flatMap((supplement) => visualChatSources(supplement))
  ];
  const readByDocument: Record<string, number[]> = {};
  for (const report of reports) readByDocument[report.document_id] = report.read_pages;
  const deferredPages = [...new Set(coverageEntries.flatMap(([, pages]) => pages))].sort(
    (left, right) => left - right
  );
  const pagesRead = [...new Set(Object.values(readByDocument).flat())].sort(
    (left, right) => left - right
  );
  if (deferredTotal > 0) {
    // 只有确实存下任务，下面的提示才成立：部分阅读时保留任务，用户点继续能接着读。
    store.saveReadingTask(
      activeTaskId,
      {
        kind: 'corpus',
        question,
        selection,
        documentIds: checkpointDocuments,
        budget: activeBudget,
        pagesRead,
        unread_pages: deferredPages,
        readByDocument,
        readSegments: readSegmentsDone,
        deferredByDocument,
        findings: synthesisFindings,
        sourceFindings: findingsAll,
        answer: auditedAnswer,
        sources: allSources
      } satisfies CorpusTaskPayload,
      checkpointDocuments
    );
  } else {
    store.deleteReadingTask(activeTaskId);
  }
  // 覆盖台账/摘要与如实说明：
  // 只有每一批都回报了覆盖维度，“范围内都检查过”才成立；没做全文缺口核对时也要写清。
  const coverageRows = coverageLedger(dimensions, coverageData.batch_reports ?? [], {
    evidenceByDimension: coverageData.evidence,
    evidencePages: coverageData.evidence_pages,
    searchedFullDocument: fullExtractedText,
    examinedScopeComplete: deferredTotal === 0,
    gapSearchRan: gapRan,
    gapSearchSearched: gapSearched,
    gapSearchPages: gapSources.map((source) => source.page)
  });
  const unrecordedBatches =
    (coverageData.batches ?? 0) - (coverageData.recorded_batches ?? 0);
  const coverageNote =
    unrecordedBatches > 0
      ? `本次有 ${unrecordedBatches}/${coverageData.batches ?? 0} 批没有回报覆盖维度，因此台账只记录“各批读到了什么”，不据此判断“文献里有没有”。`
      : !gapRan && reports.some((report) => (report.read_pages?.length ?? 0) > 0)
        ? '本轮没有做全文缺口核对，因此“未见到”只覆盖实际读到的页，不代表全篇。'
        : '';
  const readableCharacters = sources.reduce((total, source) => total + source.text.length, 0);
  return {
    answer: auditedAnswer,
    sources: allSources,
    plan,
    reading_scope: 'corpus',
    // 继续阅读所需信息：任务编号 + 剩余页；全部读完时任务已销掉，不再显示继续入口。
    taskId: activeTaskId,
    unread_pages: deferredTotal > 0 ? deferredPages : undefined,
    deferred_batches: execution.deferredBatches + gapDeferredBatches,
    deferred_documents: deferredTotal > 0 ? deferredByDocument : undefined,
    // 顶层缺口检索记录。
    gap_search: {
      searched: gapSearched,
      ran: gapRan,
      matched_pages: gapCandidates.map((candidate) => candidate.source.page),
      added_pages: gapSources.map((source) => source.page),
      read_pages: pagesRead,
      searched_pages: deferredPages,
      terms: gapTerms,
      pages: [...new Set([...pagesRead, ...deferredPages])]
        .sort((left, right) => left - right)
        .map((pageNumber) => ({
          page: pageNumber,
          hit: gapCandidates.some((candidate) => candidate.source.page === pageNumber),
          read: pagesRead.includes(pageNumber)
        }))
    },
    coverage: {
      dimensions: coverageData.dimensions ?? dimensions.map((dimension) => dimension.code),
      batches: coverageData.batches ?? 0,
      recorded_batches: coverageData.recorded_batches ?? 0,
      hits: coverageData.hits ?? [],
      states: coverageData.states ?? {},
      evidence: coverageData.evidence ?? {},
      evidence_pages: coverageData.evidence_pages ?? {},
      documents: reports,
      full_extracted_text: fullExtractedText,
      indexed_pages: indexedPages,
      total_pages: totalPages,
      candidate_documents: ordered.length,
      selected_documents: ordered.length,
      discovery,
      quality_pages: reports.flatMap((report) => report.quality_pages ?? []),
      strategy: '逐批阅读（语料级 discovery 排序）',
      // 多批综合实际送入的材料（synthesize 在材料过大时留空，不伪造截断内容）。
      final_context: synthesized.finalContext,
      // 以下为报告字段；不伪造未测得的值。
      coverage_summary: ledgerSummary(coverageRows),
      coverage_note: coverageNote || undefined,
      characters: readableCharacters,
      context_window: capacity.contextWindow,
      input_budget: activeBudget,
      estimator: '未知 tokenizer：按字符类别估算，另预留消息包装与输出空间',
      reading_reuse:
        '页面文字与本机 OCR/视觉解读直接复用本机已保存的结果（未重新识别）；模型阅读按本轮问题重新进行。',
      gap_search: {
        terms: gapTerms,
        scanned_pages: sources.length,
        hit_pages: gapCandidates.map((candidate) => candidate.source.page),
        added_pages: gapSources.map((source) => source.page),
        read_now: gapSources.map((source) => source.page),
        searched: gapSearched,
        ran: gapRan
      }
    },
    coverage_ledger: coverageRows,
    answerability: answerabilityFor(bank, gapRan),
    ...withCitationSupport(auditedAnswer, synthesized.sources, audit.claims),
    audit,
    notice: notices.length > 0 ? notices.join('；') : undefined
  };
}

export async function answerWithReading(
  store: Store,
  secrets: SecretStore,
  config: ReadingChatConfig,
  question: string,
  selection: string,
  documentId: string,
  page: number,
  plan: ReadingPlanRecord,
  budget: number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  taskId?: string,
  allowKnowledge = false,
  onDraft?: (text: string) => void,
  rigor: 'auto' | 'fast' | 'standard' | 'exhaustive' = 'auto',
  onDraftReset?: () => void,
  onStage?: (text: string) => void,
  onAudit?: (claims: AuditClaim[]) => void,
  externalAllowed: readonly SourceKind[] = [],
  /** 多轮历史（ChatRequest.history）：作为 prior 进入最终回答与审计，超容量先丢最旧。 */
  history?: unknown,
  /** 用户笔记/批注补充材料：只进入最终回答，不进入证据链/审计/引用编号。 */
  memoryMaterial = '',
  /** 会话早期摘要（模型生成，只是上下文，不是文献原文/证据）。 */
  historySummary = ''
): Promise<ChatResponse | null> {
  const document = store.getDocument(documentId);
  if (!document) return null;
  const capacity = readCapacity(store.getSettings());
  // 本轮的输入容量上限：最终回答/审计/修订/回读调用都带上它，超限就如实报错（不截断冒充成功）。
  const requestInputLimit = chatInputLimit(store);
  activeStageCallback = onStage;
  activeAuditCallback = onAudit;
  activeAuditStore = store;
  const allPages = Array.from({ length: document.pages }, (_, index) => index + 1);
  const readablePageSet = new Set(
    allPages.filter((pageNumber) => store.getPageText(documentId, pageNumber).trim())
  );
  const unreadablePages = allPages.filter((pageNumber) => !readablePageSet.has(pageNumber));
  const notSearchable = readablePageSet.size === 0;
  const activeTaskId = taskId ?? randomUUID();
  if (!taskId) {
    // 新任务先落一条进行中的任务，进程中断后界面仍能看到并继续。
    store.saveReadingTask(
      activeTaskId,
      {
        question,
        selection,
        documentId,
        plan,
        pagesRead: [],
        findings: [],
        answer: '',
        sources: [],
        unread_pages: allPages
      },
      [documentId]
    );
  }
  // 默认关闭；用户开启后，只对没有原生文本的页做本机 OCR，结果会缓存。
  await ensureAutoOcr(
    store,
    secrets,
    documentId,
    plan.breadth === 'document' ? allPages : plan.pages.length > 0 ? plan.pages : [page]
  );
  onStage?.('正在准备阅读范围');

  if (taskId) {
    const saved = store.loadReadingTask<ReadingTaskPayload>(taskId);
    if (saved && saved.payload.documentId === documentId) {
      const prior = saved.payload;
      const checkpoint = store.loadCheckpoint<{ findings?: ReadingFinding[] }>(
        taskId,
        'read'
      );
      const inflight = store.loadCheckpoint<{
        findings?: ReadingFinding[];
        batchIndex?: number;
        done?: number;
      }>(taskId, 'inflight');
      const bestCheckpoint =
        (inflight?.value.findings?.length ?? 0) > (checkpoint?.value.findings?.length ?? 0)
          ? inflight
          : checkpoint;
      const priorFindings =
        bestCheckpoint?.value.findings && bestCheckpoint.value.findings.length > 0
          ? bestCheckpoint.value.findings
          : prior.findings;
      const readPages = new Set(prior.pagesRead);
      // checkpoint 里的已完成批次带逐条证据页码；恢复时把这些页视为已读，
      // 避免从第一页重跑整篇。
      for (const finding of priorFindings) {
        for (const item of finding.evidence ?? []) {
          if (Number.isInteger(item.page)) readPages.add(item.page!);
        }
      }
      const unreadPages = allPages.filter((pageNumber) => !readPages.has(pageNumber));
      if (unreadPages.length === 0) {
        const streamDraft = store.loadCheckpoint<{ draft?: string }>(taskId, 'stream');
        const recoveredDraft = prior.answer.trim() ? '' : streamDraft?.value.draft ?? '';
        return {
          ...prior,
          taskId,
          answer: prior.answer.trim() ? prior.answer : recoveredDraft,
          reused_answer: true,
          citation_support: citationSupport(
            prior.answer.trim() ? prior.answer : recoveredDraft,
            prior.sources
          ),
          notice: recoveredDraft
            ? '已恢复中断时保存的生成草稿；它尚未经过完整核查，请确认后再使用。'
            : '本轮已经读完当前文献，没有需要补读的页。'
        };
      }
      const continuePlan: ReadingPlanRecord = {
        ...prior.plan,
        breadth: 'local',
        pages: unreadPages,
        reason: '继续阅读未读页'
      };
      // 著作按章继续：只读下一章（章界对齐）；非著作/无目录时保留原来的"继续未读页"。
      let continueChapter: { chapter: ChapterRange; total: number } | null = null;
      const nextChapter = await nextChapterContinuePlan(
        store,
        documentId,
        prior.plan,
        unreadPages
      );
      if (nextChapter) {
        continuePlan.pages = nextChapter.pages;
        continuePlan.reason = nextChapter.plan.reason;
        continueChapter = { chapter: nextChapter.chapter, total: nextChapter.total };
      }
      const continueFields = continueChapter
        ? {
            chapter: chapterRecord(continueChapter.chapter),
            chapter_total: continueChapter.total
          }
        : {};
      await ensureAutoOcr(store, secrets, documentId, continuePlan.pages);
      const planned = planReading(store, documentId, continuePlan, page, budget, 1);
      if (planned.batchCount <= 0 || planned.sources.length === 0) {
        return { ...prior, taskId, unread_pages: unreadPages, ...continueFields };
      }
      onStage?.('正在分批阅读未读页');
      const checkpointFindings = [...priorFindings];
      const execution = await readInBatches(
        planned.sources,
        budget,
        (instruction, material) =>
          callChatModel(
            config,
            instruction,
            `${userContext(question, selection)}\n${material}`,
            3000,
            signal,
            undefined,
            undefined,
            requestInputLimit,
            '分批阅读原文',
            [],
            true
          ),
        {
          dimensions: prior.plan.dimensions,
          maxBatches: turnReadBatches(capacity.maxReadBatches),
          allowPartial: true,
          checkpoint: readingCheckpointFor(store, activeTaskId, documentId),
          identity: readingCheckpointIdentity(
            question,
            selection,
            config,
            budget,
            planned.sources
          ),
          locate: (quote) => findQuotePage(store, documentId, quote, document.pages),
          loadPage: (pageNumber) => {
            const text = store.getPageText(documentId, pageNumber);
            return text.trim()
              ? {
                  document_id: documentId,
                  page: pageNumber,
                  name: document.name,
                  text
                }
              : null;
          },
          signal,
          onProgress,
          workers: readingWorkers(config, capacity.maxParallel),
          onBatchStart: (batchIndex, done, total) => {
            store.saveCheckpoint(
              activeTaskId,
              'inflight',
              { batchIndex, done, total, findings: checkpointFindings },
              [documentId]
            );
          },
          onBatch: (_index, finding) => {
            checkpointFindings.push(finding);
            store.saveCheckpoint(
              activeTaskId,
              'read',
              { findings: checkpointFindings, pagesRead: planned.pages },
              [documentId]
            );
          }
        }
      );
      const findings = [...priorFindings, ...execution.sourceFindings];
      const combined = evidenceBank(findings);
      if (combined.bank.length === 0) {
        return { ...prior, taskId, unread_pages: unreadPages, ...continueFields };
      }
      const willBeFull =
        new Set([...prior.pagesRead, ...execution.readPages]).size >= allPages.length &&
        allPages.every((pageNumber) => !textQuality(store.getPageText(documentId, pageNumber)).suspect);
      // 缺口检索是否查全：术语非空、本机可搜、补读后无剩余命中页。
      const resumeGapTerms = [
        ...new Set([
          ...(question.match(/[\u3400-\u9fff]{2,6}|[A-Za-z]{3,}/g) ?? []),
          ...(continuePlan.queries ?? [])
        ])
      ].filter((term) => term.length >= 2);
      const resumeGapRan =
        !notSearchable &&
        resumeGapTerms.length > 0 &&
        !allPages.some(
          (pageNumber) =>
            !execution.readPages.includes(pageNumber) &&
            readablePageSet.has(pageNumber) &&
            resumeGapTerms.some((term) => store.getPageText(documentId, pageNumber).includes(term))
        );
      onStage?.('正在综合回答');
  const synthesized = await synthesize(
        store,
        config,
        question,
        selection,
        documentId,
        findings,
        combined.bank,
        signal,
        willBeFull,
        allowKnowledge,
        onDraft,
        '',
        history,
        memoryMaterial,
        historySummary
      );
      const sanitized = sanitizeAnswer(synthesized.answer, synthesized.sources);
      synthesized.answer = sanitized.answer;
      onStage?.('正在核对论断与原文');
      const auditInputs = auditInputsForBank(store, synthesized.sources, combined.bank);
      const audit = await auditGeneratedAnswer(
        config,
        synthesized.answer,
        auditInputs,
        signal,
        allowKnowledge,
        userContext(question, selection),
        answerabilityFor(combined.bank, unreadPages.length === 0),
        externalAllowed,
        requestInputLimit,
        history
      );
      const auditedAnswer = applyAuditRewrite(config, synthesized.answer,
        audit,
        auditInputs.originals
      );
      synthesized.answer = auditedAnswer;
      const pagesRead = [...new Set([...prior.pagesRead, ...execution.readPages])].sort(
        (left, right) => left - right
      );
      const remaining = allPages.filter((pageNumber) => !pagesRead.includes(pageNumber));
      attachSourceQuotes(synthesized.sources, findings, audit.claims);
      attachAnswerAnchors(synthesized.answer, synthesized.sources, auditInputs.originals);
      const next: ReadingTaskPayload = {
        ...prior,
        pagesRead,
        findings,
        answer: synthesized.answer,
        sources: synthesized.sources,
        unread_pages: remaining
      };
      store.saveReadingTask(taskId, next, [documentId]);
      if (remaining.length === 0) store.deleteReadingTask(taskId);
      const notices: string[] = [];
      if (sanitized.removed.length > 0) {
        notices.push(`已删除无来源支持的页码表述：${sanitized.removed.join('、')}`);
      }
      if ((audit.page_mentions_removed?.length ?? 0) > 0) {
        notices.push(
          `已按逐段证据删除无依据页码：${audit.page_mentions_removed!
            .map((item) => item.text)
            .join('、')}`
        );
      }
      if (execution.deferredBatches > 0) {
        notices.push(
          `本轮先读完前 ${execution.report.batches} 批；还有 ${execution.deferredPages.length} 页未读，已保存，可继续阅读。`
        );
      }
      if (synthesized.droppedRecords > 0) {
        notices.push(
          `按上下文容量省略了 ${synthesized.droppedRecords} 条批次派生分析；逐字核验摘引未删。`
        );
      }
      const historyNote = historyDropNotice(synthesized.historyDropped, audit.history_dropped);
      if (historyNote) notices.push(historyNote);
      return {
        answer: synthesized.answer,
        sources: synthesized.sources,
        plan: continuePlan,
        ...continueFields,
        unread_pages: remaining,
        deferred_batches: execution.deferredBatches,
        deferred_documents: execution.deferredDocuments,
        evidence_bank: execution.report.evidence_bank,
        evidence_accounting: execution.report.evidence_accounting,
        answerability: answerabilityFor(combined.bank, resumeGapRan),
        taskId,
        // 续读是多批综合：记录本轮真实送入的综合材料（过大时 synthesize 会留空）。
        coverage: {
          dimensions: prior.plan.dimensions.map((dimension) => dimension.code),
          batches: execution.report.batches,
          recorded_batches:
            'dimensions' in execution.coverage
              ? execution.coverage.recorded_batches
              : 0,
          hits: [],
          states: {},
          evidence: {},
          evidence_pages: {},
          final_context: synthesized.finalContext
        } as ChatResponse['coverage'],
        ...withCitationSupport(synthesized.answer, synthesized.sources, audit.claims),
        audit,
        notice: notices.length > 0 ? notices.join('；') : undefined
      };
    }
  }

  const pageRows = allPages.map(
    (pageNumber) => [pageNumber, store.getPageText(documentId, pageNumber)] as [number, string]
  );
  // 有字但疑似乱码/字体异常的页：不能当作"读到全篇"，也不该静默当逐字证据。
  const qualityPages = pageRows
    .filter(([, text]) => textQuality(text).suspect)
    .map(([pageNumber]) => pageNumber);
  const qualityNotice =
    qualityPages.length > 0
      ? `有 ${qualityPages.length} 页文本疑似乱码/字体异常（第 ${qualityPages
          .slice(0, 8)
          .join('、')}${qualityPages.length > 8 ? ' 等' : ''} 页），已视为解析可疑、未宣称读到全篇。`
      : '';
  const contrast = contrastPages(pageRows);
  let effectivePlan = plan;
  let lexicalExtra: number[] = [];
  let semanticResult: SemanticReverseResult = {
    enabled: false,
    pages: [],
    queries: []
  };
  if (plan.breadth === 'local') {
    const selected = new Set(plan.pages);
    lexicalExtra = Object.keys(contrast)
      .map(Number)
      .filter((pageNumber) => !selected.has(pageNumber))
      .sort((left, right) => left - right)
      .slice(0, 8);
    semanticResult = await semanticReversePages(
      store,
      secrets,
      documentId,
      question,
      selected,
      page
    );
    const extra = [...new Set([...lexicalExtra, ...semanticResult.pages])]
      .sort((left, right) => left - right)
      .slice(0, 8);
    if (extra.length > 0) {
      effectivePlan = {
        ...plan,
        pages: [...new Set([...plan.pages, ...extra])].sort((a, b) => a - b),
        reason: `${plan.reason}；补读反面迹象页`
      };
    }
  }
  // 单篇问题不做文献库发现。
  if (effectivePlan.breadth === 'discovery') {
    effectivePlan = {
      ...effectivePlan,
      breadth: 'document',
      reason: '单篇问题不做文献库发现，按整篇阅读'
    };
  } else if (effectivePlan.breadth === 'local' && effectivePlan.pages.length === 0) {
    // 选文解释/当前页规则给的是空页码（只说了“这一页”）：先补当前页，再按结构树扩章，
    // 否则只会读到孤零零的当前页。
    effectivePlan = {
      ...effectivePlan,
      pages: [page],
      reason: `${effectivePlan.reason}；先补读当前页再扩章`
    };
  }
  if (effectivePlan.breadth !== 'document' && effectivePlan.pages.length > 0) {
    // 命中页扩到所在章节/父节：
    // 「读第 3 页」应是读第 3 页所在的那一节，而不是孤零零一页。
    // 启用的本地目录作为并集参与：结构树章节 ∪ 本地目录章节，只会多读、不会少读。
    try {
      const structurePages = new Set<number>();
      try {
        const tree = await store.getStructure(documentId);
        if (tree.length > 0) {
          for (const pageNumber of expandSections(effectivePlan.pages, tree, document.pages)) {
            structurePages.add(pageNumber);
          }
        }
      } catch {
        // 结构树不可用：仍允许本地目录扩展。
      }
      const navigationPages = navigationPlanPages(
        store,
        documentId,
        effectivePlan.pages,
        document.pages
      );
      const fromNavigation = navigationPages.filter((pageNumber) => !structurePages.has(pageNumber));
      for (const pageNumber of navigationPages) structurePages.add(pageNumber);
      const extraSectionPages = [...structurePages].filter(
        (pageNumber) => !effectivePlan.pages.includes(pageNumber)
      );
      if (extraSectionPages.length > 0) {
        effectivePlan = {
          ...effectivePlan,
          pages: [...new Set([...effectivePlan.pages, ...structurePages])].sort(
            (left, right) => left - right
          ),
          reason: `${effectivePlan.reason}；按所在章节扩展阅读范围${
            fromNavigation.length > 0 ? '（含本地目录章节）' : ''
          }`
        };
      }
    } catch {
      // 结构树/目录不可用时保持原范围，不阻断阅读。
    }
  }
  const falsifyReport = falsificationReport(
    pageRows,
    plan.breadth === 'document' ? allPages : plan.pages,
    semanticResult.pages,
    8,
    semanticResult.queries,
    ''
  );
  const falsify =
    Object.keys(contrast).length > 0 || semanticResult.pages.length > 0
      ? {
          scanned_pages: falsifyReport.scanned_pages,
          contrast_pages: falsifyReport.contrast_pages,
          semantic_pages: falsifyReport.semantic_pages,
          marked_pages: falsifyReport.marked_pages,
          added_pages: falsifyReport.added_pages,
          evidence: falsifyReport.evidence,
          truncated: falsifyReport.truncated
        }
      : undefined;

  let planned = planReading(store, documentId, effectivePlan, page, budget, 1);
  if (planned.batchCount <= 0) return null;
  let readPages = new Set(planned.pages);
  // 本地缺口安全网只在**局部范围**跑：
  // 整篇阅读本来就会读到所有页，再扫一遍只会白花一次 embedding 调用。
  const sweep =
    plan.breadth === 'local'
      ? await sweepDocument(
          store,
          secrets,
          documentId,
          question,
          Array.isArray(plan.queries) ? plan.queries : [],
          planned.pages,
          8
        )
      : { report: sweepReport([], [], planned.pages, 8), matches: [] };
  const gapSearchMatches = sweep.matches;
  // 读前 sweep 补进来的页（region 合并后的）也要在 notice 里如实说明，否则用户看不到
  // “本轮范围比计划更宽”的原因。
  const sweepAddedPages = gapSearchMatches.length > 0 ? sweep.report.added_pages : [];
  if (gapSearchMatches.length > 0) {
    // 用 `added_pages`（region 合并后的区间页），而不是只补命中的孤立页：
    // 相邻的过渡页往往正是“结论所在的那一段”。
    planned = planReading(
      store,
      documentId,
      {
        ...effectivePlan,
        breadth: 'local',
        pages: [
          ...new Set([...planned.pages, ...sweep.report.added_pages])
        ].sort((left, right) => left - right)
      },
      page,
      budget,
      1
    );
    readPages = new Set(planned.pages);
  }
  let unreadPages = allPages.filter((pageNumber) => !readPages.has(pageNumber));
  // 综合前回读：局部/部分阅读时，先让模型指出
  // 回答所需的定义、反例、条件或跨页联系缺在哪几页，再补读后再综合。
  if (rigor !== 'fast' && unreadPages.length > 0 && planned.batchCount === 1) {
    try {
      const extras = await requestRereadPages(
        store,
        config,
        documentId,
        question,
        [],
        planned.sources
          .slice(0, 4)
          .map((source) => source.text)
          .join('\n\n')
          .slice(0, 6000) || `${question}\n${selection}`.trim(),
        readPages,
        signal
      );
      for (const extra of extras) {
        planned.sources.push({
          document_id: documentId,
          page: extra.page,
          name: document.name,
          text: extra.text
        });
        readPages.add(extra.page);
      }
      if (extras.length > 0) {
        unreadPages = allPages.filter((pageNumber) => !readPages.has(pageNumber));
      }
    } catch {
      // 回读规划失败不阻断回答：保留已有证据，由审计与本机缺口检索兜底。
    }
  }
  // 读后缺口检索的公共口径：问题术语 + 规划查询词。
  const gapTerms = [
    ...new Set([
      ...(question.match(/[\u3400-\u9fff]{2,6}|[A-Za-z]{3,}/g) ?? []).map((term) =>
        term.trim()
      ),
      ...(Array.isArray(plan.queries) ? plan.queries : [])
    ])
  ].filter((term) => term.length >= 2);
  let lexicalGapPages: number[] = [];
  // 单遍阅读：未读但问题术语命中的页也补进来再生成（只增不减）。
  if (planned.batchCount === 1 && gapTerms.length > 0) {
    for (const pageNumber of allPages) {
      if (readPages.has(pageNumber) || !readablePageSet.has(pageNumber)) continue;
      const text = store.getPageText(documentId, pageNumber);
      if (gapTerms.some((term) => text.includes(term))) lexicalGapPages.push(pageNumber);
      if (lexicalGapPages.length >= 6) break;
    }
    for (const pageNumber of lexicalGapPages) {
      planned.sources.push({
        document_id: documentId,
        page: pageNumber,
        name: document.name,
        text: store.getPageText(documentId, pageNumber)
      });
      readPages.add(pageNumber);
    }
    if (lexicalGapPages.length > 0) {
      unreadPages = allPages.filter((pageNumber) => !readPages.has(pageNumber));
    }
  }
  const visual = await visualReadingSupplement(
    store,
    secrets,
    documentId,
    planned.pages,
    signal
  );
  const visualText = visualMaterialOf(visual);
  // 「缺口检索是否真的查全」：术语非空、本机有可搜文字、
  // 且补读后没有剩余未读的命中页。answerability 的 searched 只能用这个，不能用 full_extracted_text。
  const gapSearched = !notSearchable && gapTerms.length > 0;
  const remainingGapHits = gapSearched
    ? allPages.filter(
        (pageNumber) =>
          !readPages.has(pageNumber) &&
          readablePageSet.has(pageNumber) &&
          gapTerms.some((term) => store.getPageText(documentId, pageNumber).includes(term))
      )
    : [];
  const gapRan = gapSearched && remainingGapHits.length === 0;

  if (planned.batchCount === 1) {
    onProgress?.(1, 1);
    let material = planned.sources
      .map((source, index) => sourceText(source, index + 1))
      .join('\n\n');
    let streamedAnswer = '';
    const streamDraft = onDraft
      ? (delta: string): void => {
          streamedAnswer += delta;
          onDraft(delta);
          if (streamedAnswer.length % 240 < delta.length) {
            store.saveCheckpoint(
              activeTaskId,
              'stream',
              { draft: streamedAnswer, pagesRead: planned.pages },
              [documentId]
            );
          }
        }
      : undefined;
    const baseSingleInstruction = answerInstruction(
      plan.breadth === 'document' && unreadPages.length === 0 && qualityPages.length === 0,
      allowKnowledge
    );
    let singleMemory = memoryMaterial ? `\n\n${memoryMaterial}` : '';
    let singleInstruction =
      baseSingleInstruction +
      (singleMemory ? `\n\n${MEMORY_RULES}` : '') +
      historyContextRules(history, historySummary);
    const buildSingleMaterial = (memory = singleMemory): string =>
      `问题：${question}${selection ? `\n选文：${selection}` : ''}\n当前页：第 ${page} 页\n\n文献原文参考：\n${material}${
        visualText ? `\n\n${visualText}` : ''
      }${memory}`;
    let singleMaterial = buildSingleMaterial();
    // 笔记/批注是补充材料：若因为附了它而超出输入上限，先丢补充材料再按原口径处理，
    // 不能把原本能回答的问题顶成「预计输入超出上限」。
    if (
      singleMemory &&
      inputCost(messages(singleInstruction, singleMaterial)) > requestInputLimit
    ) {
      singleMemory = '';
      singleInstruction = baseSingleInstruction + historyContextRules(history, historySummary);
      singleMaterial = buildSingleMaterial();
    }
    // 多轮历史进入最终回答：超容量时先丢最旧，丢了几轮如实写进 notice。
    const singleHistory = prepareHistory(
      history,
      historyRoomFor(requestInputLimit, singleInstruction, singleMaterial)
    );
    let historyDropped = singleHistory.dropped;
    const answer = await callChatModel(
      config,
      singleInstruction,
      singleMaterial,
      1200,
      signal,
      streamDraft,
      undefined,
      requestInputLimit,
      '形成文献分析',
      singleHistory.prior
    );
    let sources: ChatSource[] = planned.sources.map((source) => ({
      documentId: source.document_id,
      documentName: source.name,
      page: source.page,
      snippet: source.text.slice(0, 600),
      // 不使用“第一句”伪装精确摘引；只有复核阶段绑定的逐字摘引才进入 quotes。
      quotes: []
    }));
    const sanitized = sanitizeAnswer(answer, sources);
    onStage?.('正在核对论断与原文');
    const auditInputs = auditInputsForSources(store, sources);
    let audit = await auditGeneratedAnswer(
      config,
      sanitized.answer,
      auditInputs,
      signal,
      allowKnowledge,
      userContext(question, selection),
      answerabilityFor([], gapRan),
      externalAllowed,
      requestInputLimit,
      history
    );
    let finalAnswer = applyAuditRewrite(config, sanitized.answer, audit, auditInputs.originals);
    // 深度档位的缺口回读：按档位决定的轮数上限，
    // 用核对意见回读原文并修订，再重新核对；fast 为 0 轮。
    const unsupported = audit.claims.filter((claim) => claim.verdict === 'unsupported').length;
    const rounds = rereadRounds(rigor, false, unsupported);
    const rereadPages = new Set(planned.pages);
    // 回读门槛：只有「材料不够」类问题才回读/重写；
    // 「摘引与论断不匹配」这类再读一遍原文也不会变，重写整篇只是让用户多等一次生成。
    let rereadSkipped = '';
    for (let round = 0; round < rounds; round += 1) {
      if (audit.status !== '已进行模型证据支持复核' || audit.issues.length === 0) break;
      if (!worthRereading(audit.issues)) {
        rereadSkipped = REREAD_SKIPPED_NOTE;
        break;
      }
      // 补齐缺口：让模型从目录请求需要补读的页，再由本地读取。
      const requested = await requestRereadPages(
        store,
        config,
        documentId,
        question,
        audit.issues,
        finalAnswer,
        rereadPages,
        signal
      );
      const gapPages =
        requested.length > 0
          ? requested
          : gapReadingPages(store, documentId, audit.issues, rereadPages);
      if (gapPages.length > 0) {
        const documentName = store.getDocument(documentId)?.name ?? '';
        const gapSources: ChatSource[] = gapPages.map((gap) => ({
          documentId,
          documentName,
          page: gap.page,
          snippet: gap.text.slice(0, 240),
          quotes: []
        }));
        const start = sources.length + 1;
        sources = [...sources, ...gapSources];
        for (const gap of gapPages) rereadPages.add(gap.page);
        material +=
          '\n\n以下是本轮为核对缺口补读的真实原文（已追加为正式来源）：\n' +
          gapSources
            .map(
              (source, index) =>
                `[${start + index}] ${source.documentName} 第 ${source.page} 页\n${gapPages[index]!.text.slice(0, 4000)}`
            )
            .join('\n\n');
      }
      onDraftReset?.();
      const revisedInstruction =
        '依据下面的核对问题，回读同一批原文并修订回答。只保留有原文支持的结论；无法解决的明确说明，不要补造引文。' +
        historyContextRules(history, historySummary);
      const revisedMaterial = `问题：${question}\n\n原回答：\n${finalAnswer}\n\n需要核对的问题：\n${audit.issues.join('\n')}\n\n原文：\n${material}`;
      const revisedHistory = prepareHistory(
        history,
        historyRoomFor(requestInputLimit, revisedInstruction, revisedMaterial)
      );
      historyDropped = Math.max(historyDropped, revisedHistory.dropped);
      const revised = await callChatModel(
        config,
        revisedInstruction,
        revisedMaterial,
        1200,
        signal,
        onDraft,
        undefined,
        requestInputLimit,
        '依据回读证据修订回答',
        revisedHistory.prior,
        true
      );
      const revisedSanitized = sanitizeAnswer(revised, sources);
      const revisedInputs = auditInputsForSources(store, sources);
      audit = await auditGeneratedAnswer(
        config,
        revisedSanitized.answer,
        revisedInputs,
        signal,
        allowKnowledge,
        userContext(question, selection),
        answerabilityFor([], gapRan),
        externalAllowed,
        requestInputLimit,
        history
      );
      finalAnswer = applyAuditRewrite(config, revisedSanitized.answer,
        audit,
        revisedInputs.originals
      );
    }
    const nextTaskId = activeTaskId;
    // 单遍直读没有批次 findings（原文整体在上下文里），只合并审计摘引。
    attachSourceQuotes(sources, [], audit.claims);
    attachAnswerAnchors(finalAnswer, sources, auditInputs.originals);
    // 视觉读页是派生来源：只用于展示与回原页核对，不进入逐字证据/引用核验。
    const allSources = [...sources, ...visualChatSources(visual)];
    const task: ReadingTaskPayload = {
      question,
      selection,
      documentId,
      plan,
      pagesRead: planned.pages,
      findings: [],
      answer: finalAnswer,
      sources: allSources,
      unread_pages: unreadPages
    };
    store.saveReadingTask(nextTaskId, task, [documentId]);
    if (unreadPages.length === 0) store.deleteReadingTask(nextTaskId);
    if (taskId && taskId !== nextTaskId) store.deleteReadingTask(taskId);
    // 单遍路径的覆盖元数据：单遍不做逐批记账，但容量/材料口径仍如实写清；
    // final_context 单遍**不写**（单遍时为空串，原文整体在上下文里，不重复存一份）。
    const singleLedger = unrecordedLedger(effectivePlan.dimensions, '单遍完整读取，未逐批记账');
    return {
      answer: finalAnswer,
      sources: allSources,
      plan: effectivePlan,
      falsify,
      gap_search: {
        searched: gapSearched,
        ran: gapRan,
        matched_pages: sweep.report.hit_pages,
        added_pages: sweep.report.added_pages,
        read_pages: planned.pages,
        searched_pages: allPages.filter((pageNumber) => !readPages.has(pageNumber)),
        terms: gapTerms.slice(0, 12),
        pages: allPages.map((pageNumber) => ({
          page: pageNumber,
          hit: sweep.report.hit_pages.includes(pageNumber),
          read: planned.pages.includes(pageNumber)
        })),
        sweep: sweep.report
      },
      coverage_ledger: singleLedger,
      coverage: {
        dimensions: effectivePlan.dimensions.map((dimension) => dimension.code),
        batches: planned.batchCount,
        recorded_batches: 0,
        hits: [],
        states: {},
        evidence: {},
        evidence_pages: {},
        quality_pages: qualityPages,
        coverage_summary: ledgerSummary(singleLedger),
        coverage_note:
          qualityPages.length > 0
            ? qualityNotice
            : '本轮为单遍完整读取，原文整体在上下文中，未逐批记账。',
        characters: planned.sources.reduce((total, source) => total + source.text.length, 0),
        context_window: capacity.contextWindow,
        input_budget: requestInputLimit,
        estimator: hasActiveTokenizer()
          ? '本机 tokenizer 实测文本 token，另预留消息包装与输出空间'
          : '未知 tokenizer：按字符类别估算，另预留消息包装与输出空间',
        reading_reuse:
          '页面文字与本机 OCR/视觉解读直接复用本机已保存的结果（未重新识别）；模型阅读按本轮问题重新进行。'
      } as ChatResponse['coverage'],
      unread_pages: unreadPages,
      answerability: answerabilityFor([], gapRan),
      taskId: nextTaskId,
      ...withCitationSupport(finalAnswer, sources, audit.claims),
      audit,
        notice: (() => {
        const notices: string[] = [];
        if (sanitized.removed.length > 0) {
          notices.push(`已删除无来源支持的页码表述：${sanitized.removed.join('、')}`);
        }
        if ((audit.page_mentions_removed?.length ?? 0) > 0) {
          notices.push(
            `已按逐段证据删除无依据页码：${audit.page_mentions_removed!
              .map((item) => item.text)
              .join('、')}`
          );
        }
        if (rereadSkipped) notices.push(rereadSkipped);
        const historyNote = historyDropNotice(historyDropped, audit.history_dropped);
        if (historyNote) notices.push(historyNote);
        if (visual.warnings.length > 0) notices.push(...visual.warnings);
        if (lexicalGapPages.length > 0) {
          notices.push(`本机核对发现 ${lexicalGapPages.length} 页问题相关原文未读，已补读。`);
        }
        if (sweepAddedPages.length > 0) {
          notices.push(`本机核对发现 ${sweepAddedPages.length} 页问题相关原文未读，已补读。`);
        }
        if (qualityNotice) notices.push(qualityNotice);
        return notices.length > 0 ? notices.join('；') : undefined;
      })()
    };
  }

  onStage?.('正在分批阅读原文');
  const checkpointFindings: ReadingFinding[] = [];
  const batchAsk = (instruction: string, material: string): Promise<string> =>
    callChatModel(
      config,
      instruction,
      `${userContext(question, selection)}\n${material}`,
      3000,
      signal,
      undefined,
      undefined,
      requestInputLimit,
      '分批阅读原文',
      [],
      true
    );
  let execution = await readInBatches(
    planned.sources,
    budget,
    batchAsk,
    {
      dimensions: plan.dimensions,
      maxBatches: turnReadBatches(capacity.maxReadBatches),
      allowPartial: true,
      checkpoint: readingCheckpointFor(store, activeTaskId, documentId),
      identity: readingCheckpointIdentity(
        question,
        selection,
        config,
        budget,
        planned.sources
      ),
      locate: (quote) => findQuotePage(store, documentId, quote, document.pages),
      loadPage: (pageNumber) => {
        const text = store.getPageText(documentId, pageNumber);
        return text.trim()
          ? { document_id: documentId, page: pageNumber, name: document.name, text }
          : null;
      },
      signal,
      onProgress,
      workers: readingWorkers(config, capacity.maxParallel),
      onBatchStart: (batchIndex, done, total) => {
        store.saveCheckpoint(
          activeTaskId,
          'inflight',
          { batchIndex, done, total, findings: checkpointFindings },
          [documentId]
        );
      },
      onBatch: (_index, finding) => {
        checkpointFindings.push(finding);
        store.saveCheckpoint(
          activeTaskId,
          'read',
          { findings: checkpointFindings, pagesRead: planned.pages },
          [documentId]
        );
      }
    }
  );
  // 综合前回读：多批或未读全时，按模型指出的
  // 定义/反例/条件类缺口先补读一批，合并进证据后再综合，而不是等审计发现问题再补。
  if (rigor !== 'fast' && (execution.report.multiPass || unreadPages.length > 0)) {
    try {
      const extras = await requestRereadPages(
        store,
        config,
        documentId,
        question,
        [],
        planned.sources
          .slice(0, 4)
          .map((source) => source.text)
          .join('\n\n')
          .slice(0, 6000) || `${question}\n${selection}`.trim(),
        new Set(execution.readPages),
        signal
      );
      if (extras.length > 0) {
        const extraRun = await readInBatches(
          extras.map((extra) => ({
            document_id: documentId,
            page: extra.page,
            name: document.name,
            text: extra.text
          })),
          budget,
          batchAsk,
          {
            dimensions: plan.dimensions,
            maxBatches: Math.max(1, Math.min(2, turnReadBatches(capacity.maxReadBatches))),
            allowPartial: true,
            signal,
            onProgress,
            workers: readingWorkers(config, capacity.maxParallel)
          }
        );
        execution = mergeSingleDocumentRuns(execution, extraRun, plan.dimensions);
      }
    } catch {
      // 回读规划失败不阻断回答：保留已有证据，由审计与本机缺口检索兜底。
    }
  }
  // 读后缺口补读：
  // 延期/未读页里问题术语命中的页补读一批；只增不减，读完再出账。
  lexicalGapPages = [];
  if (gapTerms.length > 0) {
    for (const pageNumber of allPages) {
      if (execution.readPages.includes(pageNumber)) continue;
      if (!readablePageSet.has(pageNumber)) continue;
      const text = store.getPageText(documentId, pageNumber);
      if (gapTerms.some((term) => text.includes(term))) lexicalGapPages.push(pageNumber);
      if (lexicalGapPages.length >= 6) break;
    }
  }
  if (lexicalGapPages.length > 0) {
    const gapRun = await readInBatches(
      lexicalGapPages.map((pageNumber) => ({
        document_id: documentId,
        page: pageNumber,
        name: document.name,
        text: store.getPageText(documentId, pageNumber)
      })),
      budget,
      batchAsk,
      {
        dimensions: plan.dimensions,
        maxBatches: Math.max(1, Math.min(2, turnReadBatches(capacity.maxReadBatches))),
        allowPartial: true,
        signal,
        onProgress,
        workers: readingWorkers(config, capacity.maxParallel)
      }
    );
    execution = mergeSingleDocumentRuns(execution, gapRun, plan.dimensions);
  }
  if (execution.bank.length === 0) return null;
  // 部分阅读：只有真正读完的批次的页算已读；延期批次留给“继续阅读”。
  unreadPages = allPages.filter((pageNumber) => !execution.readPages.includes(pageNumber));
  // 缺口检索是否查全（同单遍路径口径）：answerability 的 searched 必须用这个，
  // 不能用 full_extracted_text。
  const gapSearchedMulti = !notSearchable && gapTerms.length > 0;
  const remainingGapHitsMulti = gapSearchedMulti
    ? allPages.filter(
        (pageNumber) =>
          !execution.readPages.includes(pageNumber) &&
          readablePageSet.has(pageNumber) &&
          gapTerms.some((term) => store.getPageText(documentId, pageNumber).includes(term))
      )
    : [];
  const gapRanMulti = gapSearchedMulti && remainingGapHitsMulti.length === 0;
  onStage?.('正在综合回答');
  const synthesized = await synthesize(
    store,
    config,
    question,
    selection,
    documentId,
    execution.findings,
    execution.bank,
    signal,
    effectivePlan.breadth === 'document' &&
      unreadPages.length === 0 &&
      qualityPages.length === 0,
    allowKnowledge,
    onDraft,
    visualText,
    history,
    memoryMaterial,
    historySummary
  );
  const sanitized = sanitizeAnswer(synthesized.answer, synthesized.sources);
  synthesized.answer = sanitized.answer;
  onStage?.('正在核对论断与原文');
  let auditInputs = auditInputsForBank(store, synthesized.sources, execution.bank);
  let audit = await auditGeneratedAnswer(
    config,
    synthesized.answer,
    auditInputs,
    signal,
    allowKnowledge,
    userContext(question, selection),
    answerabilityFor(execution.bank, gapRanMulti),
    externalAllowed,
    requestInputLimit,
    history
  );
  let finalAnswer = applyAuditRewrite(config, synthesized.answer,
    audit,
    auditInputs.originals
  );
  let multiPassMaterial = planned.sources
    .filter((source) => execution.readPages.includes(source.page))
    .map((source, index) => sourceText(source, index + 1))
    .join('\n\n');
  const unsupported = audit.claims.filter((claim) => claim.verdict === 'unsupported').length;
  const rounds = rereadRounds(rigor, true, unsupported);
  const rereadPages = new Set(planned.pages);
  // 同上：核对问题属于「匹配类」时不回读、不重写，并在 notice 里如实说明（不把未回读说成已回读）。
  let rereadSkipped = '';
  for (let round = 0; round < rounds; round += 1) {
    if (audit.status !== '已进行模型证据支持复核' || audit.issues.length === 0) break;
    if (!worthRereading(audit.issues)) {
      rereadSkipped = REREAD_SKIPPED_NOTE;
      break;
    }
    const requested = await requestRereadPages(
      store,
      config,
      documentId,
      question,
      audit.issues,
      finalAnswer,
      rereadPages,
      signal
    );
    const gapPages =
      requested.length > 0
        ? requested
        : gapReadingPages(store, documentId, audit.issues, rereadPages);
    if (gapPages.length > 0) {
      const documentName = store.getDocument(documentId)?.name ?? '';
      const gapSources: ChatSource[] = gapPages.map((gap) => ({
        documentId,
        documentName,
        page: gap.page,
        snippet: gap.text.slice(0, 240),
        quotes: []
      }));
      const start = synthesized.sources.length + 1;
      synthesized.sources = [...synthesized.sources, ...gapSources];
      for (const gap of gapPages) rereadPages.add(gap.page);
      multiPassMaterial +=
        '\n\n以下是本轮为核对缺口补读的真实原文（已追加为正式来源）：\n' +
        gapSources
          .map(
            (source, index) =>
              `[${start + index}] ${source.documentName} 第 ${source.page} 页\n${gapPages[index]!.text.slice(0, 4000)}`
          )
          .join('\n\n');
    }
    onDraftReset?.();
    const revisedInstruction =
      '依据下面的核对问题，回读本轮原文并修订回答。只保留有原文支持的结论；无法解决的明确说明，不要补造引文。' +
      historyContextRules(history, historySummary);
    const revisedMaterial = `问题：${question}\n\n原回答：\n${finalAnswer}\n\n需要核对的问题：\n${audit.issues.join('\n')}\n\n本轮原文：\n${multiPassMaterial}`;
    const revisedHistory = prepareHistory(
      history,
      historyRoomFor(requestInputLimit, revisedInstruction, revisedMaterial)
    );
    const revised = await callChatModel(
      config,
      revisedInstruction,
      revisedMaterial,
      1200,
      signal,
      onDraft,
      undefined,
      requestInputLimit,
      '依据回读证据修订回答',
      revisedHistory.prior,
      true
    );
    const revisedSanitized = sanitizeAnswer(revised, synthesized.sources);
    const revisedInputs = auditInputsForBank(
      store,
      synthesized.sources,
      execution.bank
    );
    // 缺口回读页不在证据银行里：把它们作为无 key 的逐字材料补进审计输入。
    synthesized.sources.slice(execution.bank.length).forEach((source, index) => {
      const text = store.getPageText(source.documentId, source.page) || source.snippet;
      if (text.trim()) {
        revisedInputs.evidenceIndex.push({
          source: execution.bank.length + index + 1,
          page: source.page,
          quote: text.slice(0, 4000)
        });
      }
    });
    audit = await auditGeneratedAnswer(
      config,
      revisedSanitized.answer,
      revisedInputs,
      signal,
      allowKnowledge,
      userContext(question, selection),
      answerabilityFor(execution.bank, gapRanMulti),
      externalAllowed,
      requestInputLimit,
      history
    );
    finalAnswer = applyAuditRewrite(config, revisedSanitized.answer,
      audit,
      revisedInputs.originals
    );
  }
  const nextTaskId = activeTaskId;
  attachSourceQuotes(synthesized.sources, execution.sourceFindings, audit.claims);
  attachAnswerAnchors(finalAnswer, synthesized.sources, auditInputs.originals);
  const allSources = [...synthesized.sources, ...visualChatSources(visual)];
  const task: ReadingTaskPayload = {
    question,
    selection,
    documentId,
    plan: effectivePlan,
    pagesRead: execution.readPages,
    findings: execution.sourceFindings,
    answer: finalAnswer,
    sources: allSources,
    unread_pages: unreadPages
  };
  store.saveReadingTask(nextTaskId, task, [documentId]);
  if (unreadPages.length === 0) store.deleteReadingTask(nextTaskId);
  if (taskId && taskId !== nextTaskId) store.deleteReadingTask(taskId);

  const sweepHitPages = sweep.report.added_pages;
  const gapSearchHitTexts = sweepHitPages.map((page) => ({
    page,
    text: store.getPageText(documentId, page).slice(0, 1200)
  }));
  const gapSearchPageTexts = gapSearchHitTexts.map((match) => match.text);
  const dimensionLabels = effectivePlan.dimensions.map((dimension) => dimension.label);
  const dimensionVectors = await vectorsFor(store, secrets, [
    ...dimensionLabels,
    ...gapSearchPageTexts
  ]);
  const gapSearchPagesByDimension: Record<string, number[]> = {};
  for (
    let dimensionIndex = 0;
    dimensionIndex < effectivePlan.dimensions.length;
    dimensionIndex += 1
  ) {
    const dimension = effectivePlan.dimensions[dimensionIndex]!;
    const matched: number[] = [];
    if (dimensionVectors) {
      const dimensionVector = dimensionVectors[dimensionIndex];
      const scores = new Map<number, number>();
      for (let pageIndex = 0; pageIndex < gapSearchHitTexts.length; pageIndex += 1) {
        const pageVector = dimensionVectors[dimensionLabels.length + pageIndex];
        if (!dimensionVector || !pageVector) continue;
        scores.set(
          gapSearchHitTexts[pageIndex]!.page,
          cosine(dimensionVector, pageVector)
        );
      }
      matched.push(...pickPages(scores, 8));
    } else {
      const tokens = [
        ...(dimension.label.match(/[\u3400-\u9fff]{2,}|[A-Za-z]{3,}/g) ?? []),
        dimension.code
      ];
      for (const match of gapSearchHitTexts) {
        if (tokens.some((token) => match.text.includes(token))) matched.push(match.page);
      }
    }
    gapSearchPagesByDimension[dimension.code] = [...new Set(matched)].sort(
      (left, right) => left - right
    );
  }

  // 覆盖台账/摘要与如实说明。
  const multiLedger =
    'dimensions' in execution.coverage
      ? coverageLedger(effectivePlan.dimensions, [execution.coverage.states], {
          evidenceByDimension: execution.coverage.evidence,
          evidencePages: execution.coverage.evidence_pages,
          readablePages: [...readablePageSet],
          unreadablePages,
          notSearchable,
          searchedFullDocument:
            effectivePlan.breadth === 'document' &&
            unreadPages.length === 0 &&
            qualityPages.length === 0,
          gapSearchRan: gapRanMulti,
          gapSearchSearched: gapSearchedMulti,
          gapSearchPages: sweep.report.added_pages,
          gapSearchPagesByDimension,
          examinedScopeComplete:
            execution.coverage.recorded_batches === execution.coverage.batches
        })
      : unrecordedLedger(plan.dimensions, '多批阅读没有逐批记账');
  const multiBatches = 'dimensions' in execution.coverage ? execution.coverage.batches : 0;
  const multiRecorded =
    'dimensions' in execution.coverage ? execution.coverage.recorded_batches : 0;
  const multiCoverageNote =
    multiRecorded !== multiBatches
      ? `本次有 ${multiBatches - multiRecorded}/${multiBatches} 批没有回报覆盖维度，因此台账只记录“各批读到了什么”，不据此判断“文献里有没有”。`
      : !gapRanMulti && readablePageSet.size > 0
        ? '本轮没有做全文缺口核对，因此“未见到”只覆盖实际读到的页，不代表全篇。'
        : '';

  return {
    answer: finalAnswer,
    sources: allSources,
    plan: effectivePlan,
    falsify,
    gap_search: {
      searched: gapSearchedMulti,
      ran: gapRanMulti,
      matched_pages: sweep.report.hit_pages,
      added_pages: sweep.report.added_pages,
      read_pages: planned.pages,
      searched_pages: allPages.filter((pageNumber) => !readPages.has(pageNumber)),
      terms: gapTerms.slice(0, 12),
      pages: allPages.map((pageNumber) => ({
        page: pageNumber,
        hit: sweep.report.hit_pages.includes(pageNumber),
        read: planned.pages.includes(pageNumber)
      })),
      sweep: sweep.report
    },
    coverage:
      'dimensions' in execution.coverage
        ? {
            dimensions: execution.coverage.dimensions,
            batches: execution.coverage.batches,
            recorded_batches: execution.coverage.recorded_batches,
            hits: execution.coverage.hits,
            states: execution.coverage.states,
            evidence: execution.coverage.evidence,
            evidence_pages: execution.coverage.evidence_pages,
            quality_pages: qualityPages,
            // 多批综合实际送入的材料（过大时 synthesize 会留空，不伪造）。
            final_context: synthesized.finalContext,
            // 以下为报告字段；final_context 不伪造。
            coverage_summary: ledgerSummary(multiLedger),
            coverage_note: multiCoverageNote || undefined,
            characters: planned.sources.reduce((total, source) => total + source.text.length, 0),
            context_window: capacity.contextWindow,
            input_budget: budget,
            estimator: '未知 tokenizer：按字符类别估算，另预留消息包装与输出空间',
            reading_reuse:
              '页面文字与本机 OCR/视觉解读直接复用本机已保存的结果（未重新识别）；模型阅读按本轮问题重新进行。',
            gap_search: {
              terms: gapTerms,
              scanned_pages: readablePageSet.size,
              hit_pages: sweep.report.hit_pages,
              added_pages: sweep.report.added_pages,
              read_now: lexicalGapPages,
              searched: gapSearchedMulti,
              ran: gapRanMulti
            }
          }
        : qualityPages.length > 0
          ? ({ quality_pages: qualityPages } as ChatResponse['coverage'])
          : undefined,
    coverage_ledger: multiLedger,
    unread_pages: unreadPages,
    deferred_batches: execution.deferredBatches,
    deferred_documents: execution.deferredDocuments,
    evidence_bank: execution.report.evidence_bank,
    evidence_accounting: execution.report.evidence_accounting,
    answerability: answerabilityFor(execution.bank, gapRanMulti),
    taskId: nextTaskId,
    ...withCitationSupport(finalAnswer, synthesized.sources, audit.claims),
    audit,
    notice: (() => {
      const notices: string[] = [];
      if (sanitized.removed.length > 0) {
        notices.push(`已删除无来源支持的页码表述：${sanitized.removed.join('、')}`);
      }
      if ((audit.page_mentions_removed?.length ?? 0) > 0) {
        notices.push(
          `已按逐段证据删除无依据页码：${audit.page_mentions_removed!
            .map((item) => item.text)
            .join('、')}`
        );
      }
      if (execution.deferredBatches > 0) {
        notices.push(
          `本轮先读完前 ${execution.report.batches} 批；还有 ${execution.deferredPages.length} 页未读，已保存，可继续阅读。`
        );
      }
      if (synthesized.droppedRecords > 0) {
        notices.push(
          `按上下文容量省略了 ${synthesized.droppedRecords} 条批次派生分析；逐字核验摘引未删。`
        );
      }
      const historyNote = historyDropNotice(synthesized.historyDropped, audit.history_dropped);
      if (historyNote) notices.push(historyNote);
      if (execution.report.evidence_bank?.dropped) {
        notices.push(
          `按完整请求容量省略了 ${execution.report.evidence_bank.dropped} 条证据；逐字核验摘引完整保留。`
        );
      }
      if (execution.report.reduce_warning) {
        notices.push(execution.report.reduce_warning);
      }
      if (lexicalGapPages.length > 0) {
        notices.push(`本机核对发现 ${lexicalGapPages.length} 页问题相关原文未读，已补读。`);
      }
      if (rereadSkipped) notices.push(rereadSkipped);
      if (visual.warnings.length > 0) notices.push(...visual.warnings);
      if (qualityNotice) notices.push(qualityNotice);
      return notices.length > 0 ? notices.join('；') : undefined;
    })()
  };
}




