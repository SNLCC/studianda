import { resolveConfirm, type ConfirmAction } from './dialog-utils.js';
import { Fragment, useEffect, useRef, useState, type FormEvent, type CSSProperties } from 'react';
import type React from 'react';
import { AI_ANSWER_COPY_SUFFIX } from '@studianda/shared';
import type {
  BudgetEstimate,
  ChatResponse,
  ChatSource,
  CoverageLedgerRowRecord,
  DocumentChapter,
  ReadingTaskSummary,
  SearchPlan
} from '@studianda/shared';
import { ChatMarkdown } from './ChatMarkdown.js';
import {
  PROJECT_SCOPE_EMPTY_NOTICE,
  PROJECT_SCOPE_MISSING_NOTICE,
  ProjectScopePane,
  projectScopeAskPayload,
  resolveProjectScope,
  type ProjectScopeOption
} from './project-scope.js';
import { onHostKeyDown } from './host-scope.js';

/** 秒 → "25 秒" / "2 分 10 秒"；闸门里只说人话，不显示毫秒。 */
function formatDuration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

const COVERAGE_LABELS: Record<string, string> = {
  FOUND: '已找到支持',
  NOT_FOUND_IN_BATCH: '本批未见到',
  NOT_FOUND_IN_READ_SCOPE: '阅读范围内未见',
  NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH: '全文索引检索后未见',
  NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW: '全文检查后未见',
  UNCERTAIN: '不确定（有页读不了）',
  UNREADABLE: '页面不可读',
  NOT_SEARCHABLE: '没有可检索文字',
  NOT_RECORDED: '未逐批记账'
};

const CLAIM_TYPE_LABELS: Record<string, string> = {
  DOCUMENT_INTERPRETATION: '本文解读',
  CONCEPT_DEFINITION: '概念定义',
  SCHOLARLY_POSITION: '学术立场',
  HISTORICAL_FACT: '史实',
  BIBLIOGRAPHIC_FACT: '文献事实',
  CONTESTED_INTERPRETATION: '争议解读',
  CURRENT_INFORMATION: '时效信息',
  BACKGROUND_EXPLANATION: '背景解释'
};

const EVIDENCE_STANDARD_LABELS: Record<string, string> = {
  LIGHT: '只需解释',
  GROUNDED: '需要可核验依据',
  SCHOLARLY: '需学术级依据'
};

/** 回答方式（与 ChatResponse.answer_mode 一一对应，独立会话页也会用到）。 */
const ANSWER_MODE_LABELS: Record<string, string> = {
  library: '库内检索会话',
  reading: '文献精读',
  web: '联网结果',
  direct: '直接回复'
};

/**
 * 本轮 token 用量：有输入/输出就分别列，否则列总数；供应商没返回 usage 时明确标“估算”。
 * 有缓存命中时挂在输入后面（它是输入的一部分，不单列成一项，避免看起来像额外开销）；
 * 思考 token 同理挂在输出后面（它已包含在输出里），让"思考花了多少"可见。
 */
function formatUsage(usage: NonNullable<ChatResponse['usage']>): string | null {
  const count = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value)).toLocaleString('zh-CN')
      : '';
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const total = count(usage.total_tokens);
  const cached = count(usage.cached_tokens);
  const reasoning = count(usage.reasoning_tokens);
  const parts: string[] = [];
  if (input) parts.push(cached ? `输入 ${input}（缓存命中 ${cached}）` : `输入 ${input}`);
  if (output) parts.push(reasoning ? `输出 ${output}（其中思考 ${reasoning}）` : `输出 ${output}`);
  const body = parts.length > 0 ? parts.join(' · ') : total ? `合计 ${total}` : '';
  if (!body) return null;
  return (
    `本轮 tokens：${body}` +
    (usage.calls && usage.calls > 1 ? `（${usage.calls} 次模型调用）` : '') +
    (usage.estimated ? '（估算）' : '')
  );
}

/** 折叠摘要里的紧凑用量：只保留输入/输出，避免把 tokens 明细整行顶在回答下面。 */
function formatUsageCompact(usage: NonNullable<ChatResponse['usage']>): string {
  const count = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value)).toLocaleString('zh-CN')
      : '';
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input && output) return `输入 ${input} / 输出 ${output}`;
  const total = count(usage.total_tokens);
  return total ? `共 ${total} tokens` : '';
}

/** shared 的 `audit.claims` 是内联结构：这里取同一份字段类型，避免手写重复定义。 */
type AuditClaim = NonNullable<ChatResponse['audit']>['claims'][number];

/**
 * 缺证归因：`source_changed` = 提问时冻结的选区文字在当前页已找不到（OCR 重跑/页校订
 * 改写所致），这类“缺证”只是原文变了，**不是模型编造**。
 */
function isSourceChangedClaim(claim: AuditClaim): boolean {
  return claim.verdict === 'unsupported' && claim.evidence_status === 'source_changed';
}

/** 把核验不过的论断按归因拆开：普通缺证 / 原文已变更（两者要分别计数展示）。 */
function splitUnsupportedClaims(response: ChatResponse | undefined): {
  plain: AuditClaim[];
  sourceChanged: AuditClaim[];
} {
  const unsupported = (response?.audit?.claims ?? []).filter(
    (claim) => claim.verdict === 'unsupported'
  );
  return {
    plain: unsupported.filter((claim) => !isSourceChangedClaim(claim)),
    sourceChanged: unsupported.filter(isSourceChangedClaim)
  };
}

/**
 * 缺证计数（展示口径）：优先用 `audit.claims` 逐段明细；历史消息只有落库摘要
 * （`audit_summary`，没有逐段明细）时退回摘要计数，保证「缺证 N 段 · 原文已变更 N 段」
 * 在重开历史后仍能恢复。`source_changed` 包含在 `unsupported` 里，先扣掉再单列。
 */
function unsupportedCounts(response: ChatResponse | undefined): {
  plain: number;
  sourceChanged: number;
} {
  const summary = response?.audit_summary;
  const claims = response?.audit?.claims ?? [];
  const sourceChanged = splitUnsupportedClaims(response).sourceChanged.length;
  const sourceChangedCount =
    typeof summary?.source_changed === 'number' ? summary.source_changed : sourceChanged;
  const unsupportedCount =
    claims.length > 0
      ? claims.filter((claim) => claim.verdict === 'unsupported').length
      : (summary?.unsupported ?? 0);
  return {
    plain: Math.max(0, unsupportedCount - sourceChangedCount),
    sourceChanged: sourceChangedCount
  };
}

/** 审计摘要的计数行（活跃响应与「只有摘要」的历史消息共用同一套文案）。 */
function auditSummaryLine(response: ChatResponse | undefined): string {
  const summary = response?.audit_summary;
  if (!summary) return '';
  const { plain, sourceChanged } = unsupportedCounts(response);
  return (
    `支持 ${summary.supported} · 推断 ${summary.inference} · 缺证 ${plain}` +
    (sourceChanged > 0 ? ` · 原文已变更 ${sourceChanged}` : '') +
    ` · 标题 ${summary.heading}`
  );
}

/**
 * 选区快照的「原文已变更」提示：只有当前页确实找不到提问时的选区时才需要提示，
 * 状态为 current/unknown 时不额外占一行。
 */
function changedSelectionSnapshot(
  response: ChatResponse | undefined
): NonNullable<ChatResponse['selection_snapshot']> | null {
  const snapshot = response?.selection_snapshot;
  if (!snapshot) return null;
  if (snapshot.status === 'source_changed') return snapshot;
  if ((snapshot.source_changed_claims ?? []).length > 0) return snapshot;
  return null;
}

/**
 * 「本轮记录」折叠时的摘要：回答方式、tokens、依据/引用/审计条数。
 *
 * 回答下方的诊断项很多（回答方式、用量、可答性、路由、覆盖、审计……），全部展开时
 * 会把回答挤出屏幕。默认折叠，摘要里保留最常用的事实，展开后才是逐项明细。
 */
function turnRecordSummary(response: ChatResponse | undefined): string {
  if (!response) return '';
  const parts: string[] = [];
  if (response.answer_mode) {
    parts.push(ANSWER_MODE_LABELS[response.answer_mode] ?? response.answer_mode);
  }
  if (response.usage) {
    const usage = formatUsageCompact(response.usage);
    if (usage) parts.push(usage);
  }
  if (response.sources && response.sources.length > 0) {
    parts.push(`依据 ${response.sources.length} 条`);
  }
  if (response.citation_support && response.citation_support.citations > 0) {
    parts.push(`引用 ${response.citation_support.citations} 条`);
  }
  // 缺证按归因分开计数：原文已变更造成的缺证不能混进「缺证」当成模型编造。
  const claims = response.audit?.claims ?? [];
  const { plain: plainCount, sourceChanged: sourceChangedCount } = unsupportedCounts(response);
  if (plainCount > 0 && sourceChangedCount > 0) {
    parts.push(`缺证 ${plainCount} 段 · 原文已变更 ${sourceChangedCount} 段`);
  } else if (sourceChangedCount > 0) {
    parts.push(`原文已变更 ${sourceChangedCount} 段`);
  } else if (plainCount > 0) {
    parts.push(`缺证 ${plainCount} 段`);
  } else if (claims.length > 0 || response.audit_summary) {
    parts.push(`审计 ${response.audit_summary?.claims ?? claims.length} 段`);
  }
  if (response.audit?.status === '部分段落未完成复核') parts.push('审计部分未完成');
  else if (response.audit && response.audit.status !== '已进行模型证据支持复核') {
    parts.push('审计未完成');
  }
  return parts.join(' · ');
}

/** 审计异常或普通缺证时让折叠摘要变红，避免默认收起把风险提示一起藏掉。 */
function turnRecordHasAlert(response: ChatResponse | undefined): boolean {
  if (!response) return false;
  // 「原文已变更」的缺证不是模型编造，不按错误级别标红；只有普通缺证/审计异常才标红。
  return Boolean(
    unsupportedCounts(response).plain > 0 ||
      (response.audit && response.audit.status !== '已进行模型证据支持复核')
  );
}

/** 是否有需要收进「本轮记录」的诊断字段（没有就不渲染空折叠项）。 */
function hasTurnRecord(response: ChatResponse | undefined): boolean {
  if (!response) return false;
  return Boolean(
    response.answer_mode ||
      response.usage ||
      response.route_note ||
      response.answerability ||
      response.evidence_accounting ||
      response.source_routing ||
      response.routing ||
      response.chapter ||
      response.plan ||
      response.sources?.length ||
      response.memory_sources?.length ||
      response.memory_notice ||
      response.coverage ||
      response.coverage_ledger?.length ||
      response.gap_search ||
      response.citation_support ||
      response.audit ||
      response.audit_summary ||
      response.falsify ||
      response.unread_pages?.length
  );
}

export interface ChatAskOptions {
  confirmSearch?: boolean;
  readingScope?: 'auto' | 'corpus';
  /** 闸门里用户选的阅读策略（只读相关部分 / 读完整篇）。 */
  readingForce?: 'prune' | 'full';
  sourcePolicy?: 'auto' | 'document_only';
  /** 本轮是否把本机笔记与批注作为补充材料纳入（不算文献原文证据，不参与引用编号）。 */
  includeMemory?: boolean;
  scopeDocuments?: string[];
  /** 按标签圈跨文献范围（与 scopeDocuments 二选一；显式文献优先）。 */
  scopeTags?: string[];
  /**
   * 逻辑项目 id：按项目**当前**文献集合圈跨文献范围（与 scopeDocuments/scopeTags 互斥）。
   *
   * 由「按项目」范围选择器给出；空项目、已失效项目不会出现在这里（前端先拦住）。
   */
  projectId?: string;
  /** 用户改写过的联网查询词（只影响实际发出的搜索词，不改变已生成的搜索计划）。 */
  webQuery?: string;
  /** 本轮是否允许“审计发现缺口后补查”（review 档的回答后确认，仅本次生效）。 */
  confirmGapSearch?: boolean;
  /** 用户显式指定读第几章（1 起）；仅著作且有目录时生效。 */
  readingChapterIndex?: number;
  /** 已批准的搜索计划 token：有值时只按计划里的脱敏查询词搜索。 */
  search_token?: string;
}

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quote?: string;
  quotePage?: number;
  quoteName?: string;
  response?: ChatResponse;
}

const ANSWER_FONT_MIN = 13;
const ANSWER_FONT_MAX = 22;

/** 初始字号：优先读「设置 → 会话字号」写下的 CSS 变量，其次上次在对话里调整的值，最后 16。 */
function readAnswerFontSize(): number {
  try {
    const raw = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue('--kr-user-answer-size')
      .trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= ANSWER_FONT_MIN && parsed <= ANSWER_FONT_MAX) {
      return parsed;
    }
  } catch {
    // 读取失败时回退到本地存储
  }
  try {
    const stored = Number(window.localStorage.getItem('studianda.chat.fontSize'));
    if (Number.isFinite(stored) && stored >= ANSWER_FONT_MIN && stored <= ANSWER_FONT_MAX) {
      return stored;
    }
  } catch {
    // 本地存储不可用时使用默认字号
  }
  return 16;
}

/** 回答耗时：<1 秒显示「<1 秒」，其余一位小数；无效值返回 null（界面不显示）。 */
function formatAnswerDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return '<1 秒';
  return `${(durationMs / 1000).toFixed(1)} 秒`;
}

/**
 * 明显不需要联网的寒暄/确认：跳过搜索计划，直接按不联网提问。
 *
 * 只匹配「整句就是一个客套词」的极短输入（「你好」「谢谢」「好的」等），
 * 避免把「你好，帮我查一下……」「好的，那这篇文献……」这类有内容的句子误判成寒暄。
 */
const SMALL_TALK_ONLY =
  /^(?:你好|您好|嗨|哈喽|哈啰|在吗|早上好|上午好|中午好|下午好|晚上好|谢谢|多谢|感谢|好的|好|ok|okay|hi|hello|hey|再见|拜拜)[\s!！。,.，?？~～…]*$/i;

function isSmallTalkOnly(value: string): boolean {
  return SMALL_TALK_ONLY.test(value.trim());
}

/** 输入区 textarea 可拖拽高度：范围 96–360px，双击把手恢复默认。 */
const COMPOSER_HEIGHT_STORAGE_KEY = 'studianda.chat.composerHeight';
const COMPOSER_HEIGHT_MIN = 72;
const COMPOSER_HEIGHT_MAX = 360;
const COMPOSER_HEIGHT_DEFAULT = 72;
const COMPOSER_HEIGHT_STEP = 8;

/** 视口很矮时收窄上限，避免输入区把消息区挤没；阅读页窄侧栏同理。 */
function composerHeightLimit(): number {
  if (typeof window === 'undefined') return COMPOSER_HEIGHT_MAX;
  const byViewport = Math.floor(window.innerHeight * 0.42);
  return Math.max(COMPOSER_HEIGHT_MIN, Math.min(COMPOSER_HEIGHT_MAX, byViewport));
}

function clampComposerHeight(value: number): number {
  if (!Number.isFinite(value)) return COMPOSER_HEIGHT_DEFAULT;
  return Math.min(composerHeightLimit(), Math.max(COMPOSER_HEIGHT_MIN, Math.round(value)));
}

/** 读取记住的输入区高度（越界/损坏回退默认，避免旧值把输入区撑爆）。 */
function readComposerHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY));
    if (Number.isFinite(stored)) return clampComposerHeight(stored);
  } catch {
    // 本地存储不可用时用默认高度
  }
  return COMPOSER_HEIGHT_DEFAULT;
}

export interface ChatPanelProps {
  messages: ChatMessageView[];
  stage?: string;
  auditDraft?: Array<{ claim: number; verdict: string; text?: string }>;
  /** 消息流顶部「加载更早的消息」：独立会话分页用；不传就不显示。 */
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?(): void;
  pendingTasks?: ReadingTaskSummary[];
  onResumeTask?(task: ReadingTaskSummary): void;
  availableDocuments?: Array<{ id: string; name: string; tags?: string[] }>;
  /**
   * 可按项目圈定范围的项目清单（宿主复用 `listProjects`，只传**未归档**项目）。
   *
   * 不传（undefined）时隐藏「按项目」方式——独立会话等不消费项目范围的场景保持原样。
   */
  availableProjects?: ProjectScopeOption[];
  /** 独立会话模式：不依附某篇文献（范围只有库内检索/跨文献精读，隐藏章节与本页/整篇选项）。 */
  standalone?: boolean;
  /**
   * 上下文策略：
   * - rounds（默认）：客户端只带最近 N 轮，阅读页沿用这个策略；
   * - full：服务端按会话完整历史拼上下文，超预算时自动压缩早期轮次（独立会话）。
   *
   * full 时不显示「最近 N 轮」选择与上下文起点分隔条，改为静态说明。
   */
  contextStrategy?: 'rounds' | 'full';
  /**
   * 紧凑工具栏（阅读伙伴窄侧栏等）：工具栏强制单行；字号折叠为「Aa」弹出菜单；
   * 完整会话的长说明收成短标签 + tooltip。默认 false，外观与原来完全一致。
   */
  compactToolbar?: boolean;
  /** 工具栏左侧的额外内容（会话页把「删除会话 / 新对话」放这里，省掉一行标题）。 */
  toolbarExtra?: React.ReactNode;
  currentPage?: number;
  contextRounds?: number;
  onContextRoundsChange?(rounds: number): void;
  /** 「笔记/批注」勾选项的初始值（默认 false；阅读内与独立会话都传 true）。 */
  includeMemoryDefault?: boolean;
  /** 本轮回答耗时（毫秒）：只在最后一条 assistant 消息的操作区显示「用时 X.X 秒」；阅读页不传就不显示。 */
  lastAnswerDurationMs?: number;
  asking: boolean;
  progress?: { done: number; total: number } | null;
  answer: string | null;
  sources: ChatSource[];
  notice?: string;
  error?: string | null;
  draftQuestion?: string;
  selectionQuote?: string;
  coverageLedger?: CoverageLedgerRowRecord[];
  unreadPages?: number[];
  taskId?: string;
  citationSupport?: {
    citations: number;
    verified: number;
    anchor_only: number;
    page_only: number[];
  };
  invalidCitations?: number[];
  audit?: {
    status: string;
    issues: string[];
    claims: Array<{
      claim: number;
      text?: string;
      verdict: string;
      reason?: string;
      claim_type?: string;
      evidence_standard?: string;
    }>;
    routing?: Array<{
      claim: number;
      claim_type: string;
      evidence_standard: string;
      suggested: string;
      execution?: string;
      reason: string;
    }>;
  };
  falsify?: {
    scanned_pages: number;
    contrast_pages: number[];
    semantic_pages: number[];
    marked_pages: number[];
    added_pages: number[];
    evidence: Record<string, string[]>;
    truncated: number;
  };
  onClearQuote?(): void;
  onAsk(question: string, options?: ChatAskOptions): void;
  /** 著作章节列表：有目录（≥2 章）时显示"读哪一章"的选择。 */
  chapters?: DocumentChapter[];
  /** 回答下方"读下一章"：用同一问题读下一章。 */
  onNextChapter?(chapterIndex: number): void;
  onCancel?(): void;
  onContinue?(): void;
  /** 重新生成上一轮回答（独立会话；不传就不显示按钮）。 */
  onRegenerate?(): void;
  /**
   * 把一条助手回答存为笔记（阅读页存到当前文献，独立会话存到引用文献/独立笔记）。
   *
   * 不传就不显示「存为笔记」按钮；返回 reject 时按钮显示「保存失败，重试」。
   */
  onSaveAsNote?(message: ChatMessageView): Promise<void>;
  /** 编辑一条用户消息并重问（独立会话）；不传就不显示「编辑并重问」。 */
  onEditUserMessage?(message: ChatMessageView, content: string): Promise<void>;
  /** 从这条用户消息起删除该轮及之后的消息（独立会话）；不传就不显示删除动作。 */
  onDeleteFromMessage?(message: ChatMessageView): Promise<void>;
  onOpenSource(source: ChatSource): void;
  onSpeak?(): void;
  onSpeakText?(text: string): void;
  speaking?: boolean;
  onTranscribe?(audio: Blob): Promise<string>;
  /**
   * 直接语音提问（全模态）：把录音直接交给模型，由模型自己转写（不在客户端先跑 ASR）。
   *
   * 转写随 ChatResponse.audio_transcript 返回，宿主据此更新会话里的用户消息正文。
   */
  onAskAudio?(audio: Blob): void | Promise<void>;
  directAudio?: boolean;
  /** 语音转写完成后直接提问（关闭时只填入输入框）。 */
  speechAutoSend?: boolean;
  /** 语音输入触发方式：hold=按住说话，click=点一下开始再点一下结束。 */
  speechTriggerMode?: 'hold' | 'click';
  /** 语音输入不可用时的中文原因（按钮禁用并提示）。 */
  speechDisabledReason?: string | null;
  budget?: BudgetEstimate | null;
  /** 确认继续读取；`force` 是用户在闸门里选的阅读策略（只读相关部分 / 读完整篇）。 */
  onConfirmBudget?(force?: 'prune' | 'full'): void;
  /** 关闭预算确认提示（不读取、不追问）；缺省时只显示"继续读取"。 */
  onCancelBudget?(): void;
  /** 本文献在本次应用会话里已关闭预算提示。 */
  budgetSkipActive?: boolean;
  /** 勾选/恢复"本次会话对这篇文献不再提示"。 */
  onBudgetSkipChange?(skip: boolean): void;
  sendShortcut?: string;
  newlineShortcut?: string;
  searchPermission?: 'off' | 'review' | 'auto';
  /** 生成搜索计划（返回脱敏关键词与审批信息）；review 时由界面确认后再发送 token。 */
  onCreateSearchPlan?(input: {
    question: string;
    selection?: string;
  }): Promise<SearchPlan>;
  /** 上一轮联网搜索的非致命提示（如部分网页正文未能抓取）。 */
  searchWarning?: string;
  /** 输入框获得/失去焦点：阅读页据此显示“当前页判断锚点”。 */
  onComposerFocusChange?(focused: boolean): void;
  /** 确认框实现（宿主注入；默认浏览器原生 confirm）。 */
  confirmAction?: ConfirmAction;
}

export function ChatPanel({
  messages,
  stage = '',
  auditDraft = [],
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  pendingTasks = [],
  onResumeTask,
  availableDocuments = [],
  availableProjects,
  standalone = false,
  contextStrategy = 'rounds',
  compactToolbar = false,
  toolbarExtra,
  currentPage,
  contextRounds = 3,
  onContextRoundsChange,
  includeMemoryDefault = false,
  lastAnswerDurationMs,
  asking,
  progress,
  answer: _answer,
  sources: _sources,
  notice: _notice,
  error,
  draftQuestion,
  selectionQuote,
  coverageLedger: _coverageLedger,
  unreadPages: _unreadPages,
  taskId: _taskId,
  citationSupport: _citationSupport,
  invalidCitations: _invalidCitations,
  audit: _audit,
  falsify: _falsify,
  onClearQuote,
  onAsk,
  chapters,
  onNextChapter,
  onCancel,
  onContinue,
  onRegenerate,
  onSaveAsNote,
  onEditUserMessage,
  onDeleteFromMessage,
  onOpenSource,
  onSpeak,
  speaking,
  onSpeakText,
  onTranscribe,
  onAskAudio,
  directAudio,
  speechAutoSend = false,
  speechTriggerMode = 'hold',
  speechDisabledReason,
  budget,
  onConfirmBudget,
  onCancelBudget,
  budgetSkipActive = false,
  onBudgetSkipChange,
  sendShortcut = 'Enter',
  newlineShortcut = 'Shift+Enter',
  searchPermission = 'off',
  onCreateSearchPlan,
  searchWarning,
  onComposerFocusChange,
  confirmAction
}: ChatPanelProps): React.JSX.Element {
  const [question, setQuestion] = useState('');
  const [budgetSkipChecked, setBudgetSkipChecked] = useState(false);
  // 预算面板关闭/换文献后清掉勾选，避免下次误把"不再提示"带过去。
  useEffect(() => {
    if (!budget) setBudgetSkipChecked(false);
  }, [budget]);
  const [readingScope, setReadingScope] = useState<'auto' | 'corpus'>('auto');
  // 著作章节选择：'' = 自动（按问题/当前页选章）；数字 = 用户指定第几章。
  const [readingChapter, setReadingChapter] = useState('');
  // 换文献/目录变了以后，旧章号可能不存在：提交时只在列表里仍存在才生效。
  useEffect(() => {
    if (readingChapter === '') return;
    if (!chapters?.some((chapter) => String(chapter.index) === readingChapter)) {
      setReadingChapter('');
    }
  }, [chapters, readingChapter]);
  const [sourcePolicy, setSourcePolicy] = useState<'auto' | 'document_only'>('auto');
  // 笔记/批注纳入会话：默认值由父级给（阅读内与独立会话默认勾选），用户可逐轮切换。
  const [includeMemory, setIncludeMemory] = useState(includeMemoryDefault);
  const [scopeDocuments, setScopeDocuments] = useState<string[]>([]);
  // 跨文献范围有三种圈法：按文献（scopeDocuments）、按标签（scopeTags）或按项目（scopeProjectId）。
  // 三者互斥：选了项目就清空手选文献/标签，做了手选也清掉项目，提交口径见 projectScopeAskPayload。
  const [scopeMode, setScopeMode] = useState<'documents' | 'tags' | 'project'>('documents');
  const [scopeTags, setScopeTags] = useState<string[]>([]);
  const [scopeProjectId, setScopeProjectId] = useState('');
  // 已选项目失效后降级回手选范围的提示（不是每轮都出现，选中/切换后清掉）。
  const [scopeNotice, setScopeNotice] = useState('');
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [scopeQuery, setScopeQuery] = useState('');
  const [fontSize, setFontSize] = useState(() => readAnswerFontSize());
  // 设置页改「会话字号」时，通过自定义事件同步到当前对话（无需重新打开面板）。
  useEffect(() => {
    const sync = (): void => setFontSize(readAnswerFontSize());
    window.addEventListener('studianda:type-settings', sync);
    return () => window.removeEventListener('studianda:type-settings', sync);
  }, []);

  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState('');
  // 搜索计划审批：review 权限下先展示脱敏关键词，用户确认后才把 token 一起发送。
  const [pendingPlan, setPendingPlan] = useState<SearchPlan | null>(null);
  // 用户改写的联网查询词：只影响实际搜索词；已生成的计划词/指纹不变。
  const [webQuery, setWebQuery] = useState('');
  const [planError, setPlanError] = useState('');
  const [planning, setPlanning] = useState(false);
  // 「存为笔记」按 message.id 记状态：saving/saved/error（成功禁用，失败可重试）。
  const [noteSaveStates, setNoteSaveStates] = useState<
    Record<string, { status: 'saving' | 'saved' | 'error'; error?: string }>
  >({});
  // 「复制回答」按 message.id 短暂显示“已复制”；复制内容自动附带 AI 标识。
  const [copiedAnswerId, setCopiedAnswerId] = useState<string | null>(null);
  // 用户消息内联编辑：「编辑并重问」只同时开一个，失败信息按 message.id 显示在气泡内。
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [messageActionError, setMessageActionError] = useState<{
    messageId: string;
    text: string;
  } | null>(null);
  // 输入区高度：拖拽把手/方向键调整，localStorage 记忆；默认 96px（约三行）。
  const [composerHeight, setComposerHeight] = useState(() => readComposerHeight());
  const composerHeightRef = useRef(composerHeight);
  const composerDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedRef = useRef(0);
  const discardRecordingRef = useRef(false);
  const recordingTimerRef = useRef<number | null>(null);
  const autoStopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  // 加载更早消息前记下滚动位置：插入在顶部时按高度差补偿，用户仍看着原来那条消息。
  const earlierAnchorRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
    length: number;
    lastId: string;
  } | null>(null);
  const readingHelpRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const closeHelp = (event: PointerEvent): void => {
      const details = readingHelpRef.current;
      if (details?.open && !details.contains(event.target as Node)) {
        details.open = false;
      }
    };
    document.addEventListener('pointerdown', closeHelp);
    return () => document.removeEventListener('pointerdown', closeHelp);
  }, []);
  let contextBoundaryId: string | null = null;
  // 完整会话策略下没有「最近 N 轮」的概念，也不画上下文起点分隔条。
  if (contextStrategy !== 'full') {
    let userRounds = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== 'user') continue;
      userRounds += 1;
      if (userRounds > contextRounds) {
        contextBoundaryId = messages[index + 1]?.id ?? null;
        break;
      }
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem('studianda.chat.fontSize', String(fontSize));
    } catch {
      // 本地存储不可用时只保留当前会话
    }
  }, [fontSize]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    // 顶部插入了更早的消息：按插入高度补偿滚动位置，避免把用户甩到对话末尾。
    const anchor = earlierAnchorRef.current;
    if (anchor) {
      const lastId = messages[messages.length - 1]?.id ?? '';
      const isPrepend = messages.length > anchor.length && lastId === anchor.lastId;
      earlierAnchorRef.current = null;
      if (isPrepend) {
        container.scrollTop = anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
        return;
      }
    }
    // 空态（没有消息）时保持顶部：否则引导语会被"滚动到底"切掉上半行。
    if (messages.length === 0 && !asking) {
      container.scrollTop = 0;
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages.length, asking]);

  /** 更新输入区高度：拖拽中只改布局，松开/键盘操作时才写 localStorage。 */
  const updateComposerHeight = (value: number, persist = false): void => {
    const next = clampComposerHeight(value);
    composerHeightRef.current = next;
    setComposerHeight(next);
    if (!persist) return;
    try {
      window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(next));
    } catch {
      // 本地存储不可用时只保留当前会话
    }
  };

  const handleComposerResizePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // 只拖布局：阻止选中文本/触发输入框聚焦，避免拖动时提交或滚动跳。
    event.preventDefault();
    composerDragRef.current = {
      startY: event.clientY,
      startHeight: composerHeightRef.current
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleComposerResizePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = composerDragRef.current;
    if (!drag) return;
    // 往上拖变高：开始高度减去鼠标上移的距离。
    updateComposerHeight(drag.startHeight - (event.clientY - drag.startY));
  };

  const handleComposerResizePointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!composerDragRef.current) return;
    composerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateComposerHeight(composerHeightRef.current, true);
  };

  const handleComposerResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Home 恢复默认；上/下方向键按 8px 步进（键盘也能调）。
    if (event.key === 'Home') {
      event.preventDefault();
      updateComposerHeight(COMPOSER_HEIGHT_DEFAULT, true);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? COMPOSER_HEIGHT_STEP : -COMPOSER_HEIGHT_STEP;
    updateComposerHeight(composerHeightRef.current + delta, true);
  };

  // 窗口变矮时把记住的高度收回到可用范围，避免输入区把消息区挤没。
  useEffect(() => {
    const handleWindowResize = (): void => {
      const clamped = clampComposerHeight(composerHeightRef.current);
      if (clamped !== composerHeightRef.current) updateComposerHeight(clamped);
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
    // updateComposerHeight 只依赖 setState/localStorage，不需要重新订阅。
  }, []);

  const releaseStream = (): void => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  };

  const clearRecordingTimers = (): void => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  };

  /** 结束录音；discard=true 表示作废这次录音（过短、卸载、Esc 取消等不送识别）。 */
  const finishRecording = (discard = false): void => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      clearRecordingTimers();
      releaseStream();
      setRecording(false);
      setRecordingSeconds(0);
      return;
    }
    discardRecordingRef.current = discard;
    recorder.stop();
  };

  const microphoneErrorMessage = (error: unknown): string => {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝：请在系统或浏览器设置里允许录音后重试';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return '没有找到可用的麦克风设备';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return '麦克风被其它程序占用或不可用，无法录音';
    }
    return error instanceof Error ? error.message : '无法打开麦克风';
  };

  /**
   * 能否录音：普通语音输入需要 ASR；直接语音（全模态）只需要 onAskAudio，
   * ASR 只是用来把转写显示到会话里的增强，不可用时仍可占位发送。
   */
  const canRecord = Boolean(onTranscribe) || Boolean(directAudio && onAskAudio);

  const startRecording = async (): Promise<void> => {
    if (!canRecord || recording || transcribing || speechDisabledReason) return;
    setSpeechError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // 优先 webm/opus；浏览器不支持指定类型时交给它自己决定（仍按实际 mimeType 发送）。
      const mimeType =
        typeof MediaRecorder.isTypeSupported === 'function'
          ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) =>
              MediaRecorder.isTypeSupported(type)
            ) ?? ''
          : '';
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        clearRecordingTimers();
        releaseStream();
        setRecording(false);
        setRecordingSeconds(0);
        const durationMs = Date.now() - recordingStartedRef.current;
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          return;
        }
        // 误触（按住不足 300ms）不送识别，避免把半截录音发给模型。
        if (durationMs < 300 || chunks.length === 0) {
          setSpeechError('录音太短，请按住麦克风说完再松开');
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        if (blob.size === 0) {
          setSpeechError('没有录到音频');
          return;
        }
        setTranscribing(true);
        if (directAudio && onAskAudio) {
          // 直接语音（全模态）：录音直接发给模型，由全模态模型自己完成转写——不再先跑
          // 一次 ASR（那会多一次模型往返，且 ASR 不可用时语音提问就发不出去）。
          void (async () => {
            try {
              await onAskAudio(blob);
            } catch (error) {
              // 发送失败（例如本地转码/编码失败）时给出可读错误，不静默丢录音。
              if (mountedRef.current) {
                setSpeechError(
                  error instanceof Error ? error.message : '语音发送失败，请重试'
                );
              }
            } finally {
              if (mountedRef.current) setTranscribing(false);
            }
          })();
          return;
        }
        const transcribe = onTranscribe;
        if (!transcribe) {
          setTranscribing(false);
          setSpeechError('语音识别不可用，无法转写这段录音');
          return;
        }
        // 转写 + 纠错后的文本默认只填进输入框，等用户核对；开启“自动发送”后直接提问。
        void transcribe(blob)
          .then((text) => {
            if (!mountedRef.current) return;
            const cleaned = text.trim();
            if (!cleaned) return;
            if (speechAutoSend) {
              void askWithPlan(cleaned);
              return;
            }
            setQuestion((current) =>
              current.trim() ? `${current} ${cleaned}` : cleaned
            );
          })
          .catch((error: unknown) => {
            if (!mountedRef.current) return;
            setSpeechError(error instanceof Error ? error.message : '语音识别失败');
          })
          .finally(() => {
            if (mountedRef.current) setTranscribing(false);
          });
      };
      recordingStartedRef.current = Date.now();
      discardRecordingRef.current = false;
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartedRef.current) / 1000);
        setRecordingSeconds(Math.min(60, elapsed));
      }, 250);
      // 最长 60 秒：到点自动停止并正常送识别（不是作废）。
      autoStopTimerRef.current = window.setTimeout(() => {
        const current = recorderRef.current;
        if (current && current.state === 'recording') current.stop();
      }, 60_000);
    } catch (error) {
      clearRecordingTimers();
      releaseStream();
      setRecording(false);
      setRecordingSeconds(0);
      setSpeechError(microphoneErrorMessage(error));
    }
  };

  // Esc 停止录音（作废这次录音，不送识别）；只在应用宿主范围内生效。
  useEffect(() => {
    if (!recording) return;
    return onHostKeyDown((event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finishRecording(true);
    });
  }, [recording]);

  // 卸载/切换文档：标记未挂载、释放 MediaStream 并停止录音（不再送识别）。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRecordingTimers();
      discardRecordingRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // 停止失败时直接释放轨道即可
        }
      }
      releaseStream();
    };
  }, []);

  useEffect(() => {
    if (!draftQuestion) return;
    setQuestion((previous) => (previous.trim() ? previous : draftQuestion));
  }, [draftQuestion]);

  const scopeTagOptions = Array.from(
    new Set(availableDocuments.flatMap((item) => item.tags ?? []))
  ).sort((left, right) => left.localeCompare(right, 'zh'));
  const scopeTagKey = scopeTagOptions.join('\u0000');
  const scopeDocumentKey = availableDocuments.map((item) => item.id).join('\u0000');
  // 文献/笔记被删除后，它们最后占用的标签和文献 id 也应从已选范围里消失，
  // 否则下一次提问会圈到一个空范围（看起来像「标签还在，但什么都没检索到」）。
  useEffect(() => {
    const knownTags = new Set(scopeTagOptions);
    setScopeTags((current) => {
      if (current.length === 0) return current;
      const next = current.filter((tag) => knownTags.has(tag));
      return next.length === current.length ? current : next;
    });
    const knownDocuments = new Set(availableDocuments.map((item) => item.id));
    setScopeDocuments((current) => {
      if (current.length === 0) return current;
      const next = current.filter((id) => knownDocuments.has(id));
      return next.length === current.length ? current : next;
    });
  }, [scopeTagKey, scopeDocumentKey]);
  const projectScope = resolveProjectScope(availableProjects, scopeProjectId);
  // 已选项目被删除或归档（不再出现在未归档清单里）：降级回手选范围，绝不静默带一个会 404 的 id。
  useEffect(() => {
    if (scopeMode !== 'project' || projectScope.state !== 'missing') return;
    setScopeProjectId('');
    setScopeMode('documents');
    setScopeNotice(PROJECT_SCOPE_MISSING_NOTICE);
  }, [scopeMode, projectScope.state]);
  // 只有解析成功（项目存在且非空）才把 projectId 带进本轮请求。
  const usableProjectId =
    scopeMode === 'project' && projectScope.state === 'ok' ? scopeProjectId : '';
  // 空项目/失效项目时拦下提问：界面上已有提示，输入保留但不发请求。
  const scopeAskBlocked = scopeMode === 'project' && projectScope.blocked;
  // 工具栏「已选…」按钮的简短文案：按项目时显示项目名，让范围一眼可见。
  const scopeSummaryLabel =
    scopeMode === 'project'
      ? projectScope.state === 'ok' && projectScope.project
        ? `项目「${projectScope.project.name}」`
        : scopeProjectId
          ? '项目（读取中…）'
          : '项目（未选）'
      : scopeMode === 'tags'
        ? `${scopeTags.length || '全部'} 个标签`
        : `${scopeDocuments.length || '全部'} 篇`;
  // 工具栏下方的范围提示：空项目（「该项目暂无文献」）与失效降级提示都显示在这里。
  const scopeInlineNotice =
    scopeNotice || (scopeMode === 'project' ? projectScope.notice : '');

  /** 切换圈范围方式：项目与手选文献/标签互斥，切换时清掉另一侧的选择。 */
  const switchScopeMode = (next: 'documents' | 'tags' | 'project'): void => {
    setScopeMode(next);
    setScopeNotice('');
    if (next === 'project') {
      setScopeDocuments([]);
      setScopeTags([]);
      return;
    }
    setScopeProjectId('');
  };

  /** 选中/清空项目：选了项目就清空手选文献与标签，并把范围切到跨文献（项目范围本身就是跨文献）。 */
  const selectScopeProject = (projectId: string): void => {
    setScopeProjectId(projectId);
    setScopeNotice('');
    if (!projectId) return;
    setScopeDocuments([]);
    setScopeTags([]);
    setReadingScope('corpus');
  };

  const scopeFilter = scopeQuery.trim().toLowerCase();
  const readingOptions = {
    readingScope,
    readingChapterIndex:
      readingChapter !== '' &&
      chapters?.some((chapter) => String(chapter.index) === readingChapter)
        ? Number(readingChapter)
        : undefined,
    sourcePolicy,
    // 笔记/批注作为补充材料纳入本轮（不算文献原文证据）。
    includeMemory,
    // 提交时按当前圈法取：项目 / 文献 / 标签三选一（互斥由 projectScopeAskPayload 保证）。
    // 两种手选圈法都始终提交（不只跨文献）：独立会话的「库内检索」也要用所选范围圈范围，
    // 阅读内模式 core 只在跨文献时使用它们，无副作用；项目范围只带 projectId。
    ...projectScopeAskPayload({
      mode: scopeMode,
      scopeDocuments,
      scopeTags,
      usableProjectId
    }),
    // 用户改写的联网查询词：只影响实际搜索词，不进已生成的搜索计划。
    webQuery: webQuery.trim() || undefined
  };
  /**
   * 统一提问出口：范围被拦住（空项目/失效项目）时不发请求，只给提示。
   *
   * 发送、空态建议问法、审计建议补证等所有内部入口都走这里，避免绕过项目范围校验。
   */
  const ask = (value: string, options: ChatAskOptions): void => {
    if (scopeAskBlocked) {
      setScopeNotice(projectScope.notice || PROJECT_SCOPE_EMPTY_NOTICE);
      return;
    }
    onAsk(value, options);
  };
  // 回答后的“允许联网补查”确认条：只在最后一条回答返回 gap_search_approval 且本轮未在跑时出现。
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  // 「重新生成」只挂最后一条助手回答上；提问中最后一条可能是乐观用户消息，所以按 role 找索引。
  const lastAssistantIndex = messages.reduce(
    (lastIndex, message, index) => (message.role === 'assistant' ? index : lastIndex),
    -1
  );
  const gapApproval = lastAssistantMessage?.response?.gap_search_approval;
  const lastUserQuestion =
    [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  /**
   * 存为笔记：按 message.id 防重复（成功即禁用），失败保留可重试状态。
   *
   * 实际保存由父级（阅读页/独立会话）决定存到哪；这里只负责按钮状态，不弹窗打断。
   */
  /** 复制回答：正文后强制附带显式 AI 标识，避免用户无感知地传播无标识内容。 */
  const copyAnswer = (message: ChatMessageView): void => {
    const text = `${message.content}${AI_ANSWER_COPY_SUFFIX}`;
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopiedAnswerId(message.id);
        window.setTimeout(() => setCopiedAnswerId(null), 1600);
      },
      () => {
        setCopiedAnswerId(null);
      }
    );
  };

  const saveAsNote = (message: ChatMessageView): void => {
    if (!onSaveAsNote) return;
    const status = noteSaveStates[message.id]?.status;
    if (status === 'saving' || status === 'saved') return;
    setNoteSaveStates((previous) => ({ ...previous, [message.id]: { status: 'saving' } }));
    void onSaveAsNote(message)
      .then(() => {
        setNoteSaveStates((previous) => ({ ...previous, [message.id]: { status: 'saved' } }));
      })
      .catch((error: unknown) => {
        setNoteSaveStates((previous) => ({
          ...previous,
          [message.id]: {
            status: 'error',
            error: error instanceof Error ? error.message : '未知错误'
          }
        }));
      });
  };

  /** 进入用户消息的内联编辑（一次只开一个；失败信息按 message.id 显示）。 */
  const beginEditMessage = (message: ChatMessageView): void => {
    if (asking) return;
    setEditingMessageId(message.id);
    setEditDraft(message.content);
    setMessageActionError(null);
  };

  /** 退出内联编辑（Esc / 取消 / 提交成功）。blur 不自动提交。 */
  const cancelEditMessage = (): void => {
    setEditingMessageId(null);
    setEditDraft('');
    setMessageActionError(null);
    setEditSaving(false);
  };

  /** 提交编辑：Enter / Ctrl+Enter / 保存按钮；失败保留编辑内容并可重试。 */
  const submitEditMessage = (message: ChatMessageView): void => {
    if (!onEditUserMessage || editSaving || asking) return;
    const content = editDraft.trim();
    if (!content) {
      setMessageActionError({ messageId: message.id, text: '内容不能为空' });
      return;
    }
    if (content === message.content.trim()) {
      cancelEditMessage();
      return;
    }
    setEditSaving(true);
    setMessageActionError(null);
    void onEditUserMessage(message, content)
      .then(() => {
        setEditSaving(false);
        setEditingMessageId(null);
        setEditDraft('');
      })
      .catch((error: unknown) => {
        setEditSaving(false);
        setMessageActionError({
          messageId: message.id,
          text: error instanceof Error ? error.message : '未知错误'
        });
      });
  };

  /** 删除这条用户消息及之后的所有消息（需确认；不自动重新提问）。 */
  const deleteFromMessage = (message: ChatMessageView): void => {
    if (!onDeleteFromMessage || deletingMessageId || asking) return;
    if (
      !resolveConfirm(confirmAction)(
        '删除这条提问以及它之后的全部回答？删除后不能恢复，也不会自动重新提问。'
      )
    ) {
      return;
    }
    setDeletingMessageId(message.id);
    setMessageActionError(null);
    void onDeleteFromMessage(message)
      .then(() => {
        setDeletingMessageId(null);
        if (editingMessageId === message.id) cancelEditMessage();
      })
      .catch((error: unknown) => {
        setDeletingMessageId(null);
        setMessageActionError({
          messageId: message.id,
          text: error instanceof Error ? error.message : '未知错误'
        });
      });
  };

  /**
   * 发送提问。允许联网时先生成"搜索计划"（脱敏关键词）：
   * - review：先展示关键词/平台/warning，用户确认后才带 token + confirmSearch 发送；
   * - auto：直接带 token 发送，不弹确认；
   * - off 或未接线：沿用原行为（review 时用 window.confirm 兜底）。
   */
  const askWithPlan = async (value: string): Promise<void> => {
    setPlanError('');
    if (searchPermission === 'off' || !onCreateSearchPlan) {
      const confirmSearch =
        searchPermission === 'review'
          ? resolveConfirm(confirmAction)(
              '本次提问可能需要联网搜索。是否允许把当前问题/必要搜索词发送到已配置的搜索服务？'
            )
          : true;
      ask(value, { confirmSearch, ...readingOptions });
      setQuestion('');
      return;
    }
    // 明显寒暄/确认（「你好」等）：不生成搜索计划、也不联网，直接按普通提问回答。
    // 否则「你好」会走一次规划模型（返回空列表）甚至被拿去联网搜索，体验很怪。
    if (isSmallTalkOnly(value)) {
      ask(value, { confirmSearch: false, ...readingOptions });
      setQuestion('');
      return;
    }
    setPlanning(true);
    try {
      const plan = await onCreateSearchPlan({
        question: value,
        ...(selectionQuote ? { selection: selectionQuote } : {})
      });
      if (plan.queries.length === 0) {
        // 本轮没有可公开搜索的主体词（寒暄/无需检索/规划模型判断无需联网）：
        // 这不是错误——直接按不联网提问，不显示 planError。
        ask(value, { confirmSearch: false, ...readingOptions });
        setQuestion('');
        return;
      }
      if (plan.review) {
        setPendingPlan(plan);
        return;
      }
      ask(value, { confirmSearch: true, search_token: plan.token, ...readingOptions });
      setQuestion('');
    } catch (error) {
      setPlanError(
        `搜索计划生成失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    } finally {
      setPlanning(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = question.trim();
    if (!value || asking || planning) return;
    void askWithPlan(value);
  };

  const confirmPlan = (): void => {
    if (!pendingPlan) return;
    const value = question.trim();
    if (!value) {
      setPendingPlan(null);
      return;
    }
    ask(value, { confirmSearch: true, search_token: pendingPlan.token, ...readingOptions });
    setPendingPlan(null);
    setWebQuery('');
    setQuestion('');
  };

  const cancelPlan = (): void => {
    // 取消只关闭审批面板，不发送、也不清空输入，用户可以改词后再发。
    setPendingPlan(null);
  };

  const matches = (event: React.KeyboardEvent, spec: string): boolean => {
    const parts = spec
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const key = parts[parts.length - 1] ?? '';
    const ctrl = parts.includes('ctrl') || parts.includes('control');
    const shift = parts.includes('shift');
    const alt = parts.includes('alt') || parts.includes('option');
    const meta = parts.includes('meta') || parts.includes('cmd') || parts.includes('command');
    if (
      event.ctrlKey !== ctrl ||
      event.shiftKey !== shift ||
      event.altKey !== alt ||
      event.metaKey !== meta
    ) {
      return false;
    }
    return event.key.toLowerCase() === key;
  };

  // 字号控件：非紧凑模式平铺在工具栏，紧凑模式折叠进「Aa」弹出菜单（按钮/aria 完全一致）。
  const fontSizeButtons = (
    <>
      <button
        type="button"
        onClick={() => setFontSize((value) => Math.max(13, value - 1))}
        disabled={fontSize <= 13}
        aria-label="减小会话字号"
      >
        A−
      </button>
      <output aria-live="polite">{fontSize}</output>
      <button
        type="button"
        onClick={() => setFontSize((value) => Math.min(22, value + 1))}
        disabled={fontSize >= 22}
        aria-label="增大会话字号"
      >
        A＋
      </button>
      <button type="button" onClick={() => setFontSize(16)}>
        重置
      </button>
    </>
  );
  // 完整会话的上下文说明：紧凑模式只显示短标签，长说明放 tooltip。
  const contextNoteShort =
    readingScope === 'corpus' ? '跨文献精读 · 历史按容量截断' : '完整会话 · 超预算自动压缩';
  const contextNoteDetail =
    readingScope === 'corpus'
      ? '跨文献精读会把更多原文放进上下文：会话历史按模型输入容量截断，更早轮次可能不进本轮。'
      : '独立会话按服务端保存的完整会话历史回答；超出模型输入预算时，更早轮次会自动压缩成摘要。';
  return (
    <div
      className="kr-chat"
      style={{ '--kr-chat-font-size': `${fontSize}px` } as CSSProperties}
    >
      <div
        className={`kr-chat__toolbar${compactToolbar ? ' kr-chat__toolbar--compact' : ''}`}
        aria-label="会话字号"
      >
        {toolbarExtra ? <div className="kr-chat__toolbar-extra">{toolbarExtra}</div> : null}
        {compactToolbar ? (
          <details className="kr-chat__font-menu">
            <summary aria-label={`会话字号：${fontSize}（展开调整）`} title="会话字号">
              Aa
            </summary>
            <div className="kr-chat__font-menu-body">
              <span className="kr-chat__font-menu-label">字号</span>
              {fontSizeButtons}
            </div>
          </details>
        ) : (
          <>
            <span>字号</span>
            {fontSizeButtons}
          </>
        )}
        {onContextRoundsChange && contextStrategy !== 'full' ? (
          <label className="kr-chat__context-control">
            上下文
            <select
              value={contextRounds}
              onChange={(event) => onContextRoundsChange(Number(event.target.value))}
              aria-label="发送给模型的上下文轮数"
            >
              {[1, 2, 3, 5, 10].map((rounds) => (
                <option key={rounds} value={rounds}>
                  最近 {rounds} 轮
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {contextStrategy === 'full' ? (
          <span
            className={`kr-chat__context-note${
              compactToolbar ? ' kr-chat__context-note--compact' : ''
            }`}
            title={contextNoteDetail}
            aria-label={contextNoteShort}
          >
            {compactToolbar ? '完整历史' : contextNoteShort}
          </span>
        ) : null}
      </div>

      <div
        className={`kr-chat__messages${messages.length > 80 ? ' is-long' : ''}`}
        ref={messagesRef}
      >
        {hasEarlier && onLoadEarlier ? (
          <button
            type="button"
            className="kr-chat__load-earlier"
            onClick={() => {
              const container = messagesRef.current;
              earlierAnchorRef.current = container
                ? {
                    scrollTop: container.scrollTop,
                    scrollHeight: container.scrollHeight,
                    length: messages.length,
                    lastId: messages[messages.length - 1]?.id ?? ''
                  }
                : null;
              onLoadEarlier();
            }}
            disabled={loadingEarlier || asking}
          >
            {loadingEarlier ? '正在加载更早的消息…' : '加载更早的消息'}
          </button>
        ) : null}
        {pendingTasks.length > 0 ? (
          <div className="kr-chat__pending-tasks">
            {pendingTasks.map((task) => (
              <div className="kr-chat__pending-task" key={task.taskId}>
                <div>
                  <strong>未完成的阅读</strong>
                  <p>{task.question || '继续上一次阅读'}</p>
                  {task.unreadPages.length > 0 ? (
                    <small>
                      已读 {task.pagesRead.length} 页 · 还有 {task.unreadPages.length} 页未读
                    </small>
                  ) : null}
                </div>
                {onResumeTask ? (
                  <button type="button" onClick={() => onResumeTask(task)}>
                    继续阅读
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {messages.length === 0 && !asking ? (
          <div className="kr-chat__intro">
            <span className="kr-chat__intro-mark">◇</span>
            {standalone ? (
              <>
                <h3>在整个文献库提问。</h3>
                <p>不依附某一篇文献：我会检索库内原文、笔记与批注，再给出有依据的回答。</p>
              </>
            ) : (
              <>
                <h3>一起，把这一页读懂。</h3>
                <p>我会结合当前页面和相关原文，陪你梳理论点与细节。</p>
              </>
            )}
          </div>
        ) : null}

        {messages.map((message, messageIndex) => {
          const response = message.response;
          // 缺证归因拆开渲染：普通缺证 vs 提问时原文已变更（不是模型编造）。
          const auditClaims = splitUnsupportedClaims(response);
          const changedSnapshot = changedSelectionSnapshot(response);
          // 越界引用：活跃响应有完整编号；新落库摘要也带编号（超上限已截断）；
          // 迁移前的旧摘要只有计数（没有编号数组），退回「N 处」展示。
          const responseInvalidCitationNumbers = response?.invalid_citations ?? [];
          const summaryInvalidCitationIds = response?.audit_summary?.invalid_citation_ids ?? [];
          const invalidCitationNumbers =
            responseInvalidCitationNumbers.length > 0
              ? responseInvalidCitationNumbers
              : summaryInvalidCitationIds;
          const invalidCitationCount =
            responseInvalidCitationNumbers.length > 0
              ? responseInvalidCitationNumbers.length
              : (response?.audit_summary?.invalid_citations ?? 0);
          const invalidCitationsTruncated =
            responseInvalidCitationNumbers.length === 0 &&
            response?.audit_summary?.invalid_citations_truncated === true;
          const isLast = messageIndex === messages.length - 1;
          const noteSaveState = noteSaveStates[message.id];
          const canSaveNote =
            message.role === 'assistant' &&
            message.content.trim() !== '' &&
            Boolean(onSaveAsNote);
          // 只给最后一条 assistant 显示本轮耗时（本轮回答刚产生；历史消息没有本轮计时）。
          const durationLabel =
            messageIndex === lastAssistantIndex && lastAnswerDurationMs != null
              ? formatAnswerDuration(lastAnswerDurationMs)
              : null;
          if (message.role === 'user') {
            const isEditing = editingMessageId === message.id;
            const actionError =
              messageActionError?.messageId === message.id ? messageActionError.text : '';
            return (
              <Fragment key={message.id}>
                {message.id === contextBoundaryId ? (
                  <div className="kr-chat__context-boundary" role="separator">
                    <span>上下文起点 · 最近 {contextRounds} 轮</span>
                  </div>
                ) : null}
                <div className="kr-chat__message kr-chat__message--user">
                  <div className="kr-chat__bubble">
                    <span className="kr-chat__role">你</span>
                    {message.quote ? (
                      <blockquote className="kr-chat__message-quote">
                        <small>
                          {message.quoteName ?? '当前文献'}
                          {message.quotePage ? ` · 第 ${message.quotePage} 页` : ''}
                        </small>
                        <p>{message.quote}</p>
                      </blockquote>
                    ) : null}
                    {isEditing ? (
                      <div className="kr-chat__edit">
                        <textarea
                          className="kr-chat__edit-input"
                          value={editDraft}
                          autoFocus
                          rows={Math.min(8, Math.max(2, editDraft.split('\n').length))}
                          disabled={editSaving || asking}
                          aria-label="编辑提问内容"
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            // 中文输入法组词中的 Enter/Esc 是选词/取消候选，不当作提交/取消编辑。
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelEditMessage();
                              return;
                            }
                            // Enter / Ctrl+Enter 保存并重问；Shift+Enter 换行。
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              submitEditMessage(message);
                            }
                          }}
                        />
                        <div className="kr-chat__edit-actions">
                          <button
                            type="button"
                            onClick={() => submitEditMessage(message)}
                            disabled={editSaving || asking || editDraft.trim() === ''}
                          >
                            {editSaving ? '保存中…' : '保存并重问'}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditMessage}
                            disabled={editSaving}
                          >
                            取消
                          </button>
                          <span className="kr-chat__edit-hint">
                            Enter 保存并重问 · Shift+Enter 换行 · Esc 取消
                          </span>
                        </div>
                        {actionError ? (
                          <p className="kr-chat__edit-error" role="alert">
                            失败：{actionError}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="kr-chat__text">{message.content}</p>
                    )}
                    {!isEditing && (onEditUserMessage || onDeleteFromMessage) ? (
                      <div className="kr-chat__message-actions">
                        {onEditUserMessage ? (
                          <button
                            type="button"
                            disabled={asking}
                            onClick={() => beginEditMessage(message)}
                          >
                            编辑并重问
                          </button>
                        ) : null}
                        {onDeleteFromMessage ? (
                          <button
                            type="button"
                            className="is-danger"
                            disabled={asking || deletingMessageId !== null}
                            onClick={() => deleteFromMessage(message)}
                          >
                            {deletingMessageId === message.id ? '删除中…' : '删除此轮及之后'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {!isEditing && actionError ? (
                      <p className="kr-chat__edit-error" role="alert">
                        失败：{actionError}
                      </p>
                    ) : null}
                  </div>
                </div>
              </Fragment>
            );
          }
          return (
            <Fragment key={message.id}>
              {message.id === contextBoundaryId ? (
                <div className="kr-chat__context-boundary" role="separator">
                  <span>上下文起点 · 最近 {contextRounds} 轮</span>
                </div>
              ) : null}
              <div className="kr-chat__message kr-chat__message--assistant">
                <span className="kr-chat__avatar" aria-hidden="true">
                  ◇
                </span>
                <div className="kr-chat__bubble">
                  <span className="kr-chat__role">阅读伙伴</span>
                  {/*
                    合规口径（生成式人工智能服务管理暂行办法第十条/十二条 + 标识办法）：
                    回答区常驻「AI 生成」标识，不随滚动或折叠消失；并引导用户回到原文核对。
                    不能用"流式逐字"替代这一步——标识必须在生成开始前就可见。
                  */}
                  <p className="kr-chat__ai-note">
                    AI 生成 · 可能出错，请以文献原文为准（引用编号可点击回溯）
                  </p>
                  <ChatMarkdown
                    text={message.content}
                    sources={response?.sources ?? []}
                    onOpenSource={onOpenSource}
                  />
                  {/* 说明/越界引用是回答可信度的一部分：常驻可见，不随折叠隐藏。 */}
                  {response?.notice ? <p className="kr-chat__meta">{response.notice}</p> : null}
                  {/*
                    原文已变更的归因提示：提问时的选区快照文字在当前页已找不到，
                    所以部分段落核验不过可能只是原文改写，不是模型编造。
                    默认收起，只占一行；样式复用现有提示条（kr-chat__notice）。
                  */}
                  {changedSnapshot ? (
                    <details className="kr-chat__record">
                      <summary>
                        原文已变更：提问时的选区在当前页已找不到
                        {(changedSnapshot.source_changed_claims ?? []).length > 0
                          ? ` · ${changedSnapshot.source_changed_claims!.length} 段缺证可能不是模型编造`
                          : ''}
                      </summary>
                      <p className="kr-chat__notice">
                        {`本轮提问时冻结了第 ${changedSnapshot.page} 页的选区（快照 ${changedSnapshot.id.slice(0, 8)}…，revision ${changedSnapshot.revision.slice(0, 12)}…）。` +
                          '当前页文本里已找不到这段选区文字，因此标为「原文已变更」的段落核验不过，' +
                          '可能只是 OCR 重跑/页校订改写了原文，不代表模型编造；请对照当前原文核对。'}
                      </p>
                      {(changedSnapshot.source_changed_claims ?? []).length > 0 ? (
                        <p className="kr-chat__meta">
                          涉及段落：第{' '}
                          {changedSnapshot.source_changed_claims!.join('、')} 段
                        </p>
                      ) : null}
                    </details>
                  ) : !response?.audit &&
                    response?.audit_summary?.selection_snapshot_status === 'source_changed' ? (
                    /*
                      历史消息只恢复了摘要（没有快照明细）：仍如实提示「原文已变更」的归因，
                      避免缺证被误当成模型编造。文案与上面的完整提示同一口径。
                    */
                    <p className="kr-chat__notice">
                      原文已变更：本轮提问时的选区在当前页已找不到，标为「原文已变更」的缺证段落
                      可能只是 OCR 重跑/页校订改写了原文，不代表模型编造；请对照当前原文核对。
                    </p>
                  ) : null}
                  {invalidCitationNumbers.length > 0 ? (
                    <p className="kr-page-error">
                      回答里有越界引用：
                      {invalidCitationNumbers.map((number) => `[${number}]`).join('、')}
                      {invalidCitationsTruncated
                        ? `（共 ${invalidCitationCount} 处，编号只保留前 ${invalidCitationNumbers.length} 个）`
                        : ''}
                      ，这些编号没有对应来源，不能当作依据。
                    </p>
                  ) : invalidCitationCount > 0 ? (
                    <p className="kr-page-error">
                      回答里有越界引用 {invalidCitationCount} 处（历史记录只保留数量，原始编号未保存）；
                      这些引用没有对应来源，不能当作依据。
                    </p>
                  ) : null}
                  {/*
                    本轮记录：回答方式、用量、可答性、路由、依据、覆盖、审计等诊断项。
                    默认折叠成一段摘要，避免十几行元信息把回答本身挤出屏幕；展开后逐项仍在。
                  */}
                  {hasTurnRecord(response) ? (
                    <details
                      className={`kr-chat__record${
                        turnRecordHasAlert(response) ? ' kr-chat__record--alert' : ''
                      }`}
                    >
                      <summary>
                        本轮记录
                        {turnRecordSummary(response) ? ` · ${turnRecordSummary(response)}` : ''}
                      </summary>
                      <div className="kr-chat__record-body">
                  {response?.answer_mode ? (
                    <p className="kr-chat__meta kr-chat__answer-mode">
                      本轮回答方式：
                      {ANSWER_MODE_LABELS[response.answer_mode] ?? response.answer_mode}
                    </p>
                  ) : null}
                  {response?.usage && formatUsage(response.usage) ? (
                    <p
                      className="kr-chat__meta kr-chat__usage"
                      title="本轮模型调用累计的 token 用量；供应商未返回 usage 时按字符估算（仅作参考，费用以你的模型平台账单为准）"
                    >
                      {formatUsage(response.usage)}
                    </p>
                  ) : null}
                  {response?.route_note ? (
                    <p className="kr-chat__meta">{response.route_note}</p>
                  ) : null}
                  {response?.answerability ? (
                    <p className="kr-chat__meta">
                      文献可答性：
                      {response.answerability === 'SUFFICIENT'
                        ? '已给出界定或解释'
                        : response.answerability === 'PARTIAL'
                          ? '只有部分依据'
                          : response.answerability === 'MENTION_ONLY'
                            ? '只是提到，没有解释'
                            : response.answerability === 'ABSENT'
                              ? '本轮已核验证据未涉及'
                              : '未能确认'}
                    </p>
                  ) : null}
                  {response?.evidence_accounting ? (
                    <p className="kr-chat__meta">
                      证据对账：本批 {response.evidence_accounting.batch_items} 条，
                      去重 {response.evidence_accounting.deduped} 条，
                      保留 {response.evidence_accounting.kept} 条
                      {response.evidence_accounting.unaccounted.length > 0
                        ? ` · 未对账 ${response.evidence_accounting.unaccounted.length} 条`
                        : ' · 全部有下落'}
                    </p>
                  ) : null}
                  {response?.source_routing ? (
                    <details className="kr-chat__route">
                      <summary>
                        来源路由 · {response.source_routing.claims} 段
                        {response.source_routing.needs_external > 0
                          ? ` · 需外部 ${response.source_routing.needs_external} 段`
                          : ''}
                      </summary>
                      <p className="kr-chat__meta">
                        文献原文 {response.source_routing.document_only} 段
                        {Object.entries(response.source_routing.by_suggestion)
                          .map(([kind, count]) => ` · ${kind} ${count} 段`)
                          .join('')}
                      </p>
                      {response.source_routing.blocked_kinds.length > 0 ? (
                        <p className="kr-chat__meta">
                          已阻止：{response.source_routing.blocked_kinds.join('、')}
                        </p>
                      ) : null}
                    </details>
                  ) : null}
                  {response?.routing ? (
                    <details className="kr-chat__route">
                      <summary>本轮自动判断</summary>
                      <p>
                        阅读文献：{response.routing.document ? '是' : '否'} · 联网搜索：
                        {response.routing.search ? '是' : '否'}
                      </p>
                      <p>{response.routing.reason}</p>
                    </details>
                  ) : null}
                  {response?.chapter ? (
                    <p className="kr-chat__meta">
                      本轮读：第 {response.chapter.index}
                      {response.chapter_total ? `/${response.chapter_total}` : ''} 章{' '}
                      {response.chapter.title}（第 {response.chapter.page}–{response.chapter.end_page}{' '}
                      页）
                      {onNextChapter &&
                      response.chapter_total &&
                      response.chapter_total > response.chapter.index ? (
                        <button
                          type="button"
                          onClick={() => onNextChapter(response.chapter!.index + 1)}
                          disabled={asking}
                          style={{ marginLeft: 8 }}
                        >
                          读下一章
                        </button>
                      ) : null}
                    </p>
                  ) : null}
                  {response?.plan ? (
                    <details className="kr-chat__route">
                      <summary>阅读范围与深度</summary>
                      <p>
                        范围：
                        {response.plan.breadth === 'document'
                          ? '整篇文献'
                          : response.plan.breadth === 'local'
                            ? '局部页面'
                            : '相关文献'}
                        {response.plan.pages.length > 0
                          ? ` · 第 ${response.plan.pages.join('、')} 页`
                          : ''}
                      </p>
                      {response.plan.reason ? <p>{response.plan.reason}</p> : null}
                      <p>
                        来源：{response.model_knowledge ? '文献 + 模型知识' : '仅文献'}
                      </p>
                      <p>
                        模型知识：{response.model_knowledge ? '开启' : '关闭'} · 联网搜索：
                        {response.web_search ? '开启' : '关闭'}
                      </p>
                      {response.plan.dimensions.length > 0 ? (
                        <p>
                          核对维度：
                          {response.plan.dimensions.map((item) => item.label).join('、')}
                        </p>
                      ) : null}
                    </details>
                  ) : null}

                {response?.sources && response.sources.length > 0 ? (
                  <details className="kr-chat__sources">
                    <summary>依据 · {response.sources.length} 条</summary>
                    {response.sources.some((source) => source.kind === 'web') ? (
                      <p className="kr-chat__meta">
                        联网结果来自第三方网页，未经本应用核验；引用请以原文为准。
                      </p>
                    ) : null}
                    <ul>
                      {response.sources.map((source, index) => {
                        if (source.kind === 'web' && source.url) {
                          return (
                            <li key={`${source.documentId}-${index}`} className="kr-chat__web-source">
                              <a href={source.url} target="_blank" rel="noreferrer">
                                [W{index + 1}] {source.documentName}
                              </a>
                              {/* 域名分层：只说明这个域名属于哪类机构，不是质量评级。 */}
                              {source.tierLabel ? (
                                <span className="kr-chat__web-tier"> · {source.tierLabel}</span>
                              ) : null}
                              <p>
                                {(source.snippet ?? '').slice(0, 280)}
                                {(source.snippet ?? '').length > 280 ? '…' : ''}
                              </p>
                            </li>
                          );
                        }
                        return (
                        <li key={`${source.documentId}-${source.page}-${index}`}>
                          <details className="kr-chat__source">
                            <summary>
                              [{index + 1}] {source.documentName} · 第 {source.page} 页
                              {source.pageEnd && source.pageEnd > source.page
                                ? `–${source.pageEnd}`
                                : ''}
                              {source.sectionTitle ? ` · ${source.sectionTitle}` : ''}
                              {source.sourceType === 'visual_model'
                                ? ' · 视觉解读（派生资料）'
                                : ''}
                            </summary>
                            {source.quotes?.[0] ? (
                              <>
                                <p className="kr-chat__source-label">逐字摘引</p>
                                <p>{source.quotes[0]}</p>
                              </>
                            ) : source.anchor ? (
                              <>
                                <p className="kr-chat__source-label">
                                  定位锚点（逐字重合片段，不是证据）
                                </p>
                                <p>{source.anchor}</p>
                              </>
                            ) : (
                              <>
                                <p className="kr-chat__source-label">
                                  {source.sectionTitle
                                    ? '命中片段（未逐字绑定）'
                                    : `第 ${source.page} 页原文范围（未逐字绑定）`}
                                </p>
                                <p className="kr-chat__source-range">
                                  {(source.snippet ?? '').slice(0, 600)}
                                  {(source.snippet ?? '').length > 600 ? '…' : ''}
                                </p>
                              </>
                            )}
                            <button type="button" onClick={() => onOpenSource(source)}>
                              跳到原文并标出引用
                            </button>
                          </details>
                        </li>
                        );
                      })}
                    </ul>
                  </details>
                ) : null}

                {response?.memory_sources && response.memory_sources.length > 0 ? (
                  <details className="kr-chat__memory-sources">
                    <summary>
                      参考的笔记与批注 · {response.memory_sources.length} 条（你的记录，非文献原文）
                    </summary>
                    <ul>
                      {response.memory_sources.map((source, index) => (
                        <li key={source.memoryId ?? `${source.documentId}-${source.page}-${index}`}>
                          <button type="button" onClick={() => onOpenSource(source)}>
                            {source.documentName}
                            {source.page > 0 ? ` · 第 ${source.page} 页` : ''}
                          </button>
                          <p>{source.snippet}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {response?.memory_notice ? (
                  <p className="kr-chat__meta">{response.memory_notice}</p>
                ) : null}

                {response?.coverage_ledger && response.coverage_ledger.length > 0 ? (
                  <details className="kr-chat__coverage">
                    <summary>阅读覆盖与证据状态</summary>
                    {response.coverage ? (
                      <p className="kr-chat__meta">
                        维度 {response.coverage.dimensions.length} 项 · 批次{' '}
                        {response.coverage.recorded_batches}/{response.coverage.batches} 已记账
                        {response.coverage.hits.length > 0
                          ? ` · 命中 ${response.coverage.hits.length} 项`
                          : ''}
                      </p>
                    ) : null}
                    {response.gap_search ? (
                      <p className="kr-chat__meta">
                        缺口检索：
                        {response.gap_search.searched ? '已扫描本机索引' : '未执行'}
                        {response.gap_search.matched_pages.length > 0
                          ? ` · 命中页 ${response.gap_search.matched_pages.join('、')}`
                          : ''}
                        {response.gap_search.read_pages.length > 0
                          ? ` · 本轮已读 ${response.gap_search.read_pages.length} 页`
                          : ''}
                        {response.gap_search.terms?.length
                          ? ` · 术语：${response.gap_search.terms.join('、')}`
                          : ''}
                      </p>
                    ) : null}
                    {response.gap_search?.sweep ? (
                      <p className="kr-chat__meta">
                        安全网扫描 {response.gap_search.sweep.scanned_pages} 页
                        {response.gap_search.sweep.regions.length > 0
                          ? ` · 命中区域 ${response.gap_search.sweep.regions
                              .map(([start, end]) =>
                                start === end ? `${start}` : `${start}–${end}`
                              )
                              .join('、')}`
                          : ''}
                        {response.gap_search.sweep.missing_terms.length > 0
                          ? ` · 未命中术语：${response.gap_search.sweep.missing_terms.join('、')}`
                          : ''}
                        {response.gap_search.sweep.truncated > 0
                          ? ` · 因上限截断 ${response.gap_search.sweep.truncated} 页`
                          : ''}
                        {response.gap_search.sweep.semantic_hit_pages?.length
                          ? ` · 语义召回页 ${response.gap_search.sweep.semantic_hit_pages.join('、')}`
                          : ''}
                      </p>
                    ) : null}
                    {response.gap_search?.pages?.length ? (
                      <details className="kr-chat__gap-pages">
                        <summary>逐页检索状态</summary>
                        <p>
                          {response.gap_search.pages
                            .map(
                              (item) =>
                                `${item.page}${item.hit ? '命中' : ''}${
                                  item.read ? '已读' : ''
                                }`
                            )
                            .join(' · ')}
                        </p>
                      </details>
                    ) : null}
                    <ul>
                      {response.coverage_ledger.map((row) => (
                        <li key={row.dimension}>
                          <strong>{row.label}</strong>：
                          {COVERAGE_LABELS[row.status] ?? row.status}
                          {row.unreadable_pages?.length
                            ? `（未读到第 ${row.unreadable_pages.join('、')} 页）`
                            : ''}
                          {row.evidence.length > 0
                            ? ` · ${row.evidence.length} 条已核验摘引`
                            : ''}
                          {row.reason ? <span>；{row.reason}</span> : null}
                          {row.gap_search_pages?.length
                            ? `；缺口检索命中第 ${row.gap_search_pages.join('、')} 页`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {response?.citation_support && response.citation_support.citations > 0 ? (
                  <p className="kr-chat__meta">
                    引用 {response.citation_support.citations} 条：逐字核验{' '}
                    {response.citation_support.verified} 条，仅锚点{' '}
                    {response.citation_support.anchor_only} 条，仅页码{' '}
                    {response.citation_support.page_only.length} 条。
                  </p>
                ) : null}
                {!response?.audit && response?.audit_summary ? (
                  /*
                    重开历史：消息只带审计摘要（schema_version 24 的 messages.audit_summary），
                    没有逐段明细。仍按同一套计数文案展示，避免审计信息在历史里整段消失。
                  */
                  <div className="kr-chat__details">
                    <p className="kr-chat__meta">{auditSummaryLine(response)}</p>
                    <p className="kr-chat__meta">
                      历史记录只保存审计计数（缺证/原文已变更/越界引用），逐段明细未落库。
                    </p>
                  </div>
                ) : null}
                {response?.audit ? (
                  <div className="kr-chat__details">
                    <p
                      className={
                        response.audit.status === '已进行模型证据支持复核'
                          ? 'kr-chat__meta'
                          : 'kr-page-error'
                      }
                    >
                      审计：{response.audit.status}
                      {(response.audit.issues ?? []).length > 0
                        ? `；${(response.audit.issues ?? []).slice(0, 3).join('；')}`
                        : ''}
                    </p>
                    {response.audit_summary ? (
                      <p className="kr-chat__meta">{auditSummaryLine(response)}</p>
                    ) : null}
                    {auditClaims.plain.length > 0 ? (
                      <details className="kr-chat__audit">
                        <summary>未支持段落 {auditClaims.plain.length} 条</summary>
                        <ul>
                          {auditClaims.plain.slice(0, 8).map((claim) => (
                            <li key={claim.claim}>
                              第 {claim.claim} 段：{claim.text?.slice(0, 120)}
                              {claim.reason ? `（${claim.reason}）` : ''}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {/* 原文已变更：单独列，明确不是模型编造，也不按错误级别标红。 */}
                    {auditClaims.sourceChanged.length > 0 ? (
                      <details className="kr-chat__audit">
                        <summary>
                          原文已变更 · {auditClaims.sourceChanged.length}{' '}
                          段（可能因原文改写而缺证，非模型编造）
                        </summary>
                        <ul>
                          {auditClaims.sourceChanged.slice(0, 8).map((claim) => (
                            <li key={claim.claim}>
                              第 {claim.claim} 段：{claim.text?.slice(0, 120)}
                              {claim.reason ? `（${claim.reason}）` : ''}
                              ；提问时的选区文字已不在当前页，不按模型编造处理
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <details className="kr-chat__audit">
                      <summary>逐段支持依据 · {response.audit.claims.length} 段</summary>
                      <ul>
                        {response.audit.claims.map((claim) => {
                          const route = response.audit?.routing?.find(
                            (item) => item.claim === claim.claim
                          );
                          return (
                          <li key={claim.claim}>
                            第 {claim.claim} 段：{claim.verdict}
                            {claim.evidence_status === 'source_changed'
                              ? ' · 原文已变更（非模型编造）'
                              : ''}
                            {claim.claim_type
                              ? ` · ${CLAIM_TYPE_LABELS[claim.claim_type] ?? claim.claim_type}`
                              : ''}
                            {claim.evidence_standard
                              ? ` · ${
                                  EVIDENCE_STANDARD_LABELS[claim.evidence_standard] ??
                                  claim.evidence_standard
                                }`
                              : ''}
                            {route ? ` · 建议来源：${route.suggested}` : ''}
                            {route?.execution
                              ? ` · 执行：${
                                  route.execution === 'searched'
                                    ? '已补查'
                                    : route.execution === 'blocked'
                                      ? '已阻止'
                                      : route.execution === 'needs_confirmation'
                                        ? '待确认'
                                        : '无需执行'
                                }`
                              : ''}
                            {claim.reason ? `（${claim.reason}）` : ''}
                            {route &&
                            route.suggested !== '文献原文' &&
                            response.model_knowledge !== false ? (
                              <button
                                type="button"
                                className="kr-chat__route-action"
                                onClick={() =>
                                  ask(
                                    `请针对第 ${claim.claim} 段「${claim.text?.slice(0, 120) ?? ''}」补查${route.suggested}依据，并说明哪些结论有外部支持。`,
                                    { ...readingOptions }
                                  )
                                }
                              >
                                按建议补证
                              </button>
                            ) : null}
                          </li>
                          );
                        })}
                      </ul>
                    </details>
                  </div>
                ) : null}

                {response?.falsify && (response.falsify.marked_pages ?? []).length > 0 ? (
                  <div className="kr-chat__details">
                    <p className="kr-chat__meta">
                      反面迹象页：第 {(response.falsify.marked_pages ?? []).slice(0, 12).join('、')} 页
                      {(response.falsify.added_pages ?? []).length > 0
                        ? `；本轮补读第 ${(response.falsify.added_pages ?? []).join('、')} 页`
                        : ''}
                    </p>
                    {Object.keys(response.falsify.evidence).length > 0 ? (
                      <details className="kr-chat__falsify">
                        <summary>反面依据</summary>
                        <ul>
                          {Object.entries(response.falsify.evidence)
                            .slice(0, 6)
                            .map(([page, sentences]) => (
                              <li key={page}>
                                第 {page} 页：{sentences[0]?.slice(0, 160)}
                              </li>
                            ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                ) : null}

                {response?.unread_pages && response.unread_pages.length > 0 ? (
                  <p className="kr-chat__meta">
                    本轮未读页码：{response.unread_pages.slice(0, 20).join('、')}
                    {response.unread_pages.length > 20 ? '…' : ''}
                  </p>
                ) : null}
                      </div>
                    </details>
                  ) : null}

                <div className="kr-chat__message-actions">
                  {message.content ? (
                    <button
                      type="button"
                      onClick={() => copyAnswer(message)}
                      title="复制回答（自动附带 AI 生成标识）"
                    >
                      {copiedAnswerId === message.id ? '已复制' : '复制回答'}
                    </button>
                  ) : null}
                  {(onSpeakText || onSpeak) && message.content ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSpeakText ? onSpeakText(message.content) : onSpeak?.()
                      }
                      disabled={speaking}
                    >
                      {speaking ? '生成语音中…' : '朗读'}
                    </button>
                  ) : null}
                  {canSaveNote ? (
                    <button
                      type="button"
                      className={`kr-chat__save-note${
                        noteSaveState?.status === 'saved'
                          ? ' is-saved'
                          : noteSaveState?.status === 'error'
                            ? ' is-error'
                            : ''
                      }`}
                      disabled={
                        noteSaveState?.status === 'saving' ||
                        noteSaveState?.status === 'saved'
                      }
                      onClick={() => saveAsNote(message)}
                      title={
                        noteSaveState?.status === 'error'
                          ? `保存失败：${noteSaveState.error ?? '未知错误'}（点击重试）`
                          : noteSaveState?.status === 'saved'
                            ? '这条回答已经存为笔记'
                            : '把这条回答存为笔记（正文 + 依据；文件头含 AI 生成提示）'
                      }
                    >
                      {noteSaveState?.status === 'saving'
                        ? '保存中…'
                        : noteSaveState?.status === 'saved'
                          ? '已存为笔记'
                          : noteSaveState?.status === 'error'
                            ? '保存失败，重试'
                            : '存为笔记'}
                    </button>
                  ) : null}
                  {messageIndex === lastAssistantIndex && onRegenerate ? (
                    <button
                      type="button"
                      className="kr-chat__regenerate"
                      disabled={asking}
                      onClick={onRegenerate}
                      title="用最后一条问题重新回答（会替换这条回答）"
                    >
                      重新生成
                    </button>
                  ) : null}
                  {isLast &&
                  response?.taskId &&
                  response.unread_pages &&
                  response.unread_pages.length > 0 &&
                  onContinue ? (
                    <button type="button" disabled={asking} onClick={onContinue}>
                      继续阅读未读页
                    </button>
                  ) : null}
                  {durationLabel ? (
                    <span className="kr-chat__duration">用时 {durationLabel}</span>
                  ) : null}
                </div>
              </div>
            </div>
            </Fragment>
          );
        })}

        {!asking && gapApproval ? (
          <div className="kr-chat__gap-approval" role="alert">
            <p>
              这一轮有 {gapApproval.claims.length || gapApproval.queries.length}{' '}
              处结论按性质需要外部依据，允许联网补查吗？
            </p>
            {gapApproval.reason ? (
              <p className="kr-chat__meta">{gapApproval.reason}</p>
            ) : null}
            {(gapApproval.queries ?? []).length > 0 ? (
              <p className="kr-chat__meta">
                补查关键词：{(gapApproval.queries ?? []).slice(0, 3).join('、')}（确认后仅本次生效）
              </p>
            ) : null}
            <button
              type="button"
              disabled={asking || !lastUserQuestion}
              onClick={() =>
                ask(lastUserQuestion, { ...readingOptions, confirmGapSearch: true })
              }
            >
              允许并补查
            </button>
          </div>
        ) : null}

        {asking ? (
          <div className="kr-chat__message kr-chat__message--assistant">
            <span className="kr-chat__avatar" aria-hidden="true">
              ◇
            </span>
            <div className="kr-chat__bubble kr-chat__bubble--pending">
              <span className="kr-chat__role">阅读伙伴</span>
              {/* 标识在生成**开始前**就可见：不能在回答落地后才补。 */}
              <p className="kr-chat__ai-note">AI 生成 · 正在生成，内容需核实</p>
              {auditDraft.length > 0 ? (
                <div className="kr-chat__audit-draft">
                  <p className="kr-chat__meta">审计草稿</p>
                  <ul>
                    {auditDraft.slice(0, 6).map((claim) => (
                      <li key={claim.claim}>
                        第 {claim.claim} 段：{claim.verdict}
                        {claim.text ? ` · ${claim.text.slice(0, 60)}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="kr-chat__typing">
                  {stage || '正在理解问题'}
                  <span />
                  <span />
                  <span />
                </p>
              )}
              {progress ? (
                <p className="kr-chat__meta">
                  已读 {progress.done} / {progress.total} 批
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {messages.length === 0 && !asking ? (
          <div className="kr-chat__suggestions">
            {standalone ? (
              <>
                <button
                  type="button"
                  onClick={() => ask('概括我最近的笔记', { ...readingOptions })}
                >
                  概括我最近的笔记
                </button>
                <button
                  type="button"
                  onClick={() => ask('我的批注里有哪些主题', { ...readingOptions })}
                >
                  我的批注里有哪些主题
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() =>
                    ask(
                      currentPage
                        ? `请概括第 ${currentPage} 页的核心论点`
                        : '请概括当前页的核心论点',
                      { ...readingOptions }
                    )
                  }
                >
                  概括这一页
                </button>
                <button
                  type="button"
                  onClick={() =>
                    ask(
                      currentPage
                        ? `请解释第 ${currentPage} 页的重要概念`
                        : '请解释当前页的重要概念',
                      { ...readingOptions }
                    )
                  }
                >
                  解释重要概念
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="kr-chat__composer">
        <div
          className="kr-chat__composer-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整输入区高度"
          aria-valuemin={COMPOSER_HEIGHT_MIN}
          aria-valuemax={composerHeightLimit()}
          aria-valuenow={composerHeight}
          tabIndex={0}
          title="上下拖动调整输入区高度 · 双击或 Home 恢复默认"
          onPointerDown={handleComposerResizePointerDown}
          onPointerMove={handleComposerResizePointerMove}
          onPointerUp={handleComposerResizePointerEnd}
          onPointerCancel={handleComposerResizePointerEnd}
          onKeyDown={handleComposerResizeKeyDown}
          onDoubleClick={() => updateComposerHeight(COMPOSER_HEIGHT_DEFAULT, true)}
        />
        {selectionQuote ? (
          <div className="kr-chat__quote">
            <div className="kr-chat__quote-head">
              <span>引用原文</span>
              {onClearQuote ? (
                <button type="button" onClick={onClearQuote}>
                  清除引用
                </button>
              ) : null}
            </div>
            <blockquote>{selectionQuote}</blockquote>
          </div>
        ) : null}

        {budget ? (
          <div className="kr-chat__budget" role="alert">
            <p>
              {budget.summary ?? `本轮预计读取 ${budget.pages} 页`}
              {budget.eta_seconds ? ` · 约 ${formatDuration(budget.eta_seconds)}` : ''}
            </p>
            <p>
              超过确认阈值（{budget.thresholds.pages} 页 /{' '}
              {budget.thresholds.tokens} token），要现在读吗？
            </p>
            <p className="kr-muted">{budget.note}</p>
            {onBudgetSkipChange ? (
              <label style={{ display: 'block', marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={budgetSkipChecked}
                  disabled={asking}
                  onChange={(event) => setBudgetSkipChecked(event.target.checked)}
                />{' '}
                {standalone ? '本次会话不再提示' : '本次会话对这篇文献不再提示'}
              </label>
            ) : null}
            {onConfirmBudget ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => {
                    if (budgetSkipChecked) onBudgetSkipChange?.(true);
                    // 默认推荐"只读相关部分"：先把无关章节筛掉，答不上来再读全篇。
                    onConfirmBudget('prune');
                  }}
                  disabled={asking}
                >
                  只读相关部分
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (budgetSkipChecked) onBudgetSkipChange?.(true);
                    onConfirmBudget('full');
                  }}
                  disabled={asking}
                >
                  读完{standalone ? '这些文献' : '这篇'}
                </button>
              </div>
            ) : null}
            {onCancelBudget ? (
              <button
                type="button"
                onClick={onCancelBudget}
                disabled={asking}
                style={{ marginLeft: 8 }}
              >
                取消
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="kr-page-error">{error}</p> : null}
        {speechError ? <p className="kr-page-error">{speechError}</p> : null}
        {planning ? <p className="kr-muted">正在生成搜索计划…</p> : null}
        {planError ? <p className="kr-page-error">{planError}</p> : null}
        {searchWarning ? (
          <p className="kr-chat__meta">联网搜索提示：{searchWarning}</p>
        ) : null}
        {pendingPlan ? (
          <div className="kr-chat__search-plan" role="alert">
            <p>
              <strong>这次需要联网搜索，确认要发送下面这些关键词吗？</strong>
            </p>
            <ul>
              {pendingPlan.queries.map((query) => (
                <li key={query}>{query}</li>
              ))}
            </ul>
            <p className="kr-muted">
              搜索平台：{pendingPlan.provider} · 规划方式：{pendingPlan.method} · 规划请求发送到：
              {pendingPlan.planner_destination}
            </p>
            <label>
              <span>联网查询词（可选，留空用问题本身）</span>
              <input
                value={webQuery}
                onChange={(event) => setWebQuery(event.target.value)}
                placeholder="只改写实际发送的搜索词（可选）"
                aria-label="联网查询词"
                style={{ width: '100%', marginTop: 4 }}
              />
            </label>
            <p className="kr-muted">
              只影响实际发出的搜索词；已生成的计划词不会被改写，确认后仍按计划搜索。
            </p>
            <p className="kr-muted">{pendingPlan.warning}</p>
            <div className="kr-chat__plan-actions">
              <button type="button" onClick={confirmPlan} disabled={asking}>
                允许联网并发送
              </button>
              <button type="button" onClick={cancelPlan} disabled={asking}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        <form onSubmit={submit}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (matches(event, sendShortcut)) {
                event.preventDefault();
                const value = question.trim();
                if (value && !asking && !planning) {
                  void askWithPlan(value);
                }
              }
            }}
            placeholder={standalone ? '在整个文献库提问…' : '就这篇文献提问…'}
            rows={3}
            style={{ height: `${composerHeight}px` }}
            onFocus={() => onComposerFocusChange?.(true)}
            onBlur={() => onComposerFocusChange?.(false)}
          />
          <div className="kr-chat__reading-options">
            {/* 范围和「已选 N 篇」是一个不可拆分的组：窄侧栏下整组换行，不能拆成两行。 */}
            <div className="kr-chat__reading-group">
              <label className="kr-chat__reading-field">
                <span>范围</span>
                <select
                  value={readingScope}
                  onChange={(event) => {
                    const value = event.target.value as typeof readingScope;
                    setReadingScope(value);
                    if (value === 'corpus') {
                      setScopeDialogOpen(true);
                    } else if (scopeMode === 'project') {
                      // 范围切回「自动/库内检索」就不该再带项目范围：回到手选口径，避免范围显示与实际不一致。
                      switchScopeMode('documents');
                    }
                  }}
                  aria-label="阅读范围"
                  title="阅读范围"
                >
                  <option value="auto">{standalone ? '库内检索' : '自动'}</option>
                  <option value="corpus">
                    {standalone ? '跨文献精读' : '跨文献'}
                  </option>
                </select>
              </label>
              {readingScope === 'corpus' ? (
                <button
                  type="button"
                  className="kr-chat__scope-button"
                  onClick={() => setScopeDialogOpen(true)}
                >
                  已选 {scopeSummaryLabel}
                </button>
              ) : null}
            </div>
            {!standalone && chapters && chapters.length >= 2 ? (
              <label className="kr-chat__reading-field">
                <span>章</span>
                <select
                  value={readingChapter}
                  onChange={(event) => setReadingChapter(event.target.value)}
                  aria-label="阅读章节"
                  title="著作按章阅读：自动选章，或指定读第几章"
                >
                  <option value="">自动</option>
                  {chapters.map((chapter) => (
                    <option key={chapter.index} value={String(chapter.index)}>
                      第 {chapter.index} 章 {chapter.title.length > 14 ? `${chapter.title.slice(0, 14)}…` : chapter.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="kr-chat__reading-field">
              <span>来源</span>
              <select
                value={sourcePolicy}
                onChange={(event) =>
                  setSourcePolicy(event.target.value as typeof sourcePolicy)
                }
                aria-label="智能来源"
                title="智能来源"
              >
                <option value="auto">自动</option>
                <option value="document_only">仅文献</option>
              </select>
            </label>
            {budgetSkipActive ? (
              <button
                type="button"
                className="kr-chat__scope-button"
                onClick={() => onBudgetSkipChange?.(false)}
                title={standalone ? '恢复预算确认提示' : '恢复这篇文献的预算确认提示'}
              >
                预算提示已关 · 恢复
              </button>
            ) : null}
            <details className="kr-chat__reading-help" ref={readingHelpRef}>
              <summary aria-label="选项说明">?</summary>
              <div className="kr-chat__reading-help-body">
                {standalone ? (
                  <p>
                    范围：库内检索只检索库内原文页与笔记/批注，适合大多数问题；跨文献精读按所选文献读全文，成本较高。
                    独立会话会自动按需多步检索（只读），不需要额外开关；阅读伙伴不启用这套检索。
                  </p>
                ) : (
                  <p>范围：自动由问题判断；本页及附近只读当前页附近；整篇读全文；跨文献按所选文献读。</p>
                )}
                <p>深度：快速不回读缺口；标准需要时回读一轮；全面核查最多三轮回读。</p>
                <p>来源：仅文献时本轮不联网，也不补充模型知识。</p>
              </div>
            </details>
            <label
              className="kr-chat__memory-toggle"
              title="把本机的笔记与批注作为补充材料纳入本轮会话（不算文献原文证据）"
            >
              <input
                type="checkbox"
                checked={includeMemory}
                disabled={asking}
                onChange={(event) => setIncludeMemory(event.target.checked)}
              />{' '}
              笔记/批注
            </label>
          </div>
          {scopeInlineNotice ? (
            <p className="kr-chat__meta" role="status">
              {scopeInlineNotice}
            </p>
          ) : null}
          <div className="kr-chat__compose-actions">
            {canRecord || speechDisabledReason ? (
              <button
                type="button"
                className={`kr-chat__tool${recording ? ' is-recording' : ''}`}
                aria-pressed={recording}
                onPointerDown={(event) => {
                  if (speechTriggerMode !== 'hold') return;
                  event.preventDefault();
                  void startRecording();
                }}
                onPointerUp={() => {
                  if (speechTriggerMode === 'hold') finishRecording();
                }}
                onPointerLeave={() => {
                  if (speechTriggerMode === 'hold' && recording) finishRecording();
                }}
                onPointerCancel={() => {
                  if (speechTriggerMode === 'hold') finishRecording();
                }}
                onContextMenu={(event) => event.preventDefault()}
                onClick={() => {
                  if (speechTriggerMode !== 'click') return;
                  if (recording) finishRecording();
                  else void startRecording();
                }}
                disabled={
                  asking || transcribing || Boolean(speechDisabledReason) || !canRecord
                }
                title={
                  speechDisabledReason ??
                  (recording
                    ? speechTriggerMode === 'hold'
                      ? `松开结束（已录 ${recordingSeconds} 秒，最长 60 秒）`
                      : `点击结束（已录 ${recordingSeconds} 秒，最长 60 秒）`
                    : speechTriggerMode === 'hold'
                      ? '按住说话，松开后识别'
                      : '点击开始录音，再次点击结束')
                }
              >
                {transcribing
                  ? '识别中…'
                  : recording
                    ? speechTriggerMode === 'hold'
                      ? `松开发送 ${recordingSeconds}s`
                      : `停止 ${recordingSeconds}s`
                    : '语音输入'}
              </button>
            ) : null}
            {transcribing ? (
              <span className="kr-chat__shortcut">识别中…</span>
            ) : null}
            {speechDisabledReason ? (
              <span className="kr-chat__shortcut" title={speechDisabledReason}>
                语音未配置
              </span>
            ) : null}
            <span className="kr-chat__shortcut">
              {sendShortcut} 发送
              {newlineShortcut ? ` · ${newlineShortcut} 换行` : ''}
            </span>
            {asking && onCancel ? (
              <button type="button" className="kr-chat__tool" onClick={onCancel}>
                停止
              </button>
            ) : null}
            <button
              type="submit"
              className="kr-chat__send"
              disabled={asking || !question.trim() || scopeAskBlocked}
              aria-label="发送提问"
              title={
                scopeAskBlocked
                  ? projectScope.notice || '当前范围暂不可用，请重新选择'
                  : '发送'
              }
            >
              ↑
            </button>
          </div>
        </form>
        <p className="kr-chat__privacy">
          本地检索优先；启用模型服务后，问题与相关原文会发送到对应服务。回复内容仍需人工核对。
        </p>
      </div>

      {scopeDialogOpen ? (
        <div
          className="kr-chat__scope-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setScopeDialogOpen(false);
          }}
        >
          <div className="kr-chat__scope-dialog" role="dialog" aria-label="跨文献范围">
            <h3>跨文献范围</h3>
            <p>
              {standalone
                ? '选择这次会话的范围（文献、标签或项目）。不选表示使用全部文献。'
                : '选择这次一起阅读的文献、标签或项目。不选表示使用全部文献。'}
            </p>
            <div className="kr-chat__scope-search" role="group" aria-label="圈范围方式">
              <button
                type="button"
                style={scopeMode === 'documents' ? { fontWeight: 600 } : undefined}
                onClick={() => switchScopeMode('documents')}
              >
                按文献
              </button>
              <button
                type="button"
                style={scopeMode === 'tags' ? { fontWeight: 600 } : undefined}
                onClick={() => switchScopeMode('tags')}
              >
                按标签
              </button>
              {availableProjects !== undefined ? (
                <button
                  type="button"
                  style={scopeMode === 'project' ? { fontWeight: 600 } : undefined}
                  onClick={() => switchScopeMode('project')}
                >
                  按项目
                </button>
              ) : null}
            </div>
            {scopeMode === 'project' ? (
              <ProjectScopePane
                projects={availableProjects ?? []}
                selectedId={scopeProjectId}
                query={scopeQuery}
                notice={projectScope.notice || scopeNotice}
                onQueryChange={setScopeQuery}
                onSelect={selectScopeProject}
              />
            ) : (
              <>
                <div className="kr-chat__scope-search">
                  <input
                    value={scopeQuery}
                    onChange={(event) => setScopeQuery(event.target.value)}
                    placeholder={scopeMode === 'documents' ? '搜索文献名或标签…' : '搜索标签…'}
                    aria-label="搜索跨文献范围"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (scopeMode === 'documents') {
                        const visibleIds = availableDocuments
                          .filter(
                            (item) =>
                              !scopeFilter ||
                              item.name.toLowerCase().includes(scopeFilter) ||
                              (item.tags ?? []).some((tag) =>
                                tag.toLowerCase().includes(scopeFilter)
                              )
                          )
                          .map((item) => item.id);
                        setScopeDocuments((current) => [
                          ...new Set([...current, ...visibleIds])
                        ]);
                        // 手选文献与项目范围互斥：做了手选就清掉项目，避免两个来源同时生效。
                        setScopeProjectId('');
                        return;
                      }
                      const visibleTags = scopeTagOptions.filter(
                        (tag) => !scopeFilter || tag.toLowerCase().includes(scopeFilter)
                      );
                      setScopeTags((current) => [...new Set([...current, ...visibleTags])]);
                      setScopeProjectId('');
                    }}
                  >
                    全选当前结果
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (scopeMode === 'documents') setScopeDocuments([]);
                      else setScopeTags([]);
                    }}
                  >
                    清空
                  </button>
                </div>
                <label className="kr-chat__scope-option kr-chat__scope-all">
                  <input
                    type="checkbox"
                    checked={
                      scopeMode === 'documents'
                        ? scopeDocuments.length === 0
                        : scopeTags.length === 0
                    }
                    onChange={() => {
                      if (scopeMode === 'documents') setScopeDocuments([]);
                      else setScopeTags([]);
                    }}
                  />
                  {scopeMode === 'documents' ? '全部文献' : '全部标签（不按标签限制）'}
                </label>
                {scopeMode === 'tags' ? (
                  <p className="kr-muted">
                    {standalone
                      ? '按标签在库内检索与跨文献精读时都会用来圈范围；标签来自文献库已有标签，可多选。切换回「按文献」后按文献提交。'
                      : '按标签只在「范围：跨文献」时生效；标签来自文献库已有标签，可多选。切换回「按文献」后按文献提交。'}
                  </p>
                ) : null}
                <div className="kr-chat__scope-list">
                  {scopeMode === 'documents'
                    ? availableDocuments
                        .filter(
                          (item) =>
                            !scopeFilter ||
                            item.name.toLowerCase().includes(scopeFilter) ||
                            (item.tags ?? []).some((tag) =>
                              tag.toLowerCase().includes(scopeFilter)
                            )
                        )
                        .map((item) => (
                          <label className="kr-chat__scope-option" key={item.id}>
                            <input
                              type="checkbox"
                              checked={scopeDocuments.includes(item.id)}
                              onChange={(event) => {
                                // 手选文献与项目范围互斥：选了文献就清掉项目，反之选项目时清文献。
                                if (event.target.checked) {
                                  setScopeProjectId('');
                                  setScopeNotice('');
                                }
                                setScopeDocuments((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, item.id])]
                                    : current.filter((id) => id !== item.id)
                                );
                              }}
                            />
                            <span>
                              {item.name}
                              {item.tags?.length ? (
                                <small> · {item.tags.slice(0, 3).join(' / ')}</small>
                              ) : null}
                            </span>
                          </label>
                        ))
                    : scopeTagOptions
                        .filter(
                          (tag) => !scopeFilter || tag.toLowerCase().includes(scopeFilter)
                        )
                        .map((tag) => (
                          <label className="kr-chat__scope-option" key={tag}>
                            <input
                              type="checkbox"
                              checked={scopeTags.includes(tag)}
                              onChange={(event) => {
                                if (event.target.checked) {
                                  setScopeProjectId('');
                                  setScopeNotice('');
                                }
                                setScopeTags((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, tag])]
                                    : current.filter((item) => item !== tag)
                                );
                              }}
                            />
                            <span>{tag}</span>
                          </label>
                        ))}
                </div>
                <p className="kr-chat__scope-count">
                  {scopeMode === 'documents'
                    ? `已选 ${scopeDocuments.length === 0 ? '全部文献' : `${scopeDocuments.length} 篇`}`
                    : `已选 ${scopeTags.length === 0 ? '全部标签' : `${scopeTags.length} 个标签`}`}
                </p>
              </>
            )}
            <div className="kr-chat__scope-actions">
              <button type="button" onClick={() => setScopeDialogOpen(false)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => setScopeDialogOpen(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
