import type { Store } from './store.js';
import { callChatModel, type ReadingChatConfig } from './reading-chat.js';
import { readDocumentChatSessions } from './document-chat-sessions.js';

/**
 * 阅读伙伴的会话上下文预算与摘要压缩。
 *
 * 目标与独立问答的 agent harness 策略一致：模型看到的是「会话早期摘要 + 尚未压缩的最近轮次」，
 * 而不是只截取最近 N 轮。摘要存在会话记录（settings JSON）里，不新增数据库表。
 *
 * 几条硬规则：
 * 1. 摘要由会话模型生成，**不是文献原文/证据**；不参与引用编号、sources、逐字证据；
 * 2. 只有超过预算才压缩，且从最旧轮次开始、按轮次边界切（不会切半轮）；
 * 3. 压缩失败如实提示并退回「最近轮次 + 旧摘要」，不清空旧摘要、不伪造成功；
 * 4. 失败后 5 分钟内不重复调用（避免每轮都超时）。
 */

/** 超过这个规模才触发压缩（约等于 10 轮 / 3600 字符）。 */
export const READING_CONTEXT_MAX_PAIRS = 10;
export const READING_CONTEXT_MAX_CHARS = 3600;
/** 压缩后保留的最近轮次预算（给最终回答/审计留出输入空间）。 */
export const READING_CONTEXT_KEEP_PAIRS = 6;
export const READING_CONTEXT_KEEP_CHARS = 2400;
/** 摘要本身的上限，避免摘要反过来挤占材料。 */
export const READING_CONTEXT_SUMMARY_MAX_CHARS = 4000;
const COMPACTION_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

export interface ReadingHistoryPair {
  question: string;
  answer?: string;
}

export interface PreparedReadingContext {
  /** 要作为 prior 传给阅读链路的最近轮次。 */
  history: ReadingHistoryPair[];
  /** 会话早期摘要（空串 = 无摘要）。 */
  summary: string;
  /** 本轮新压缩的轮次数（0 = 没压缩）。 */
  compactedTurns: number;
  /** 给用户看的说明（压缩成功/失败/回退）；没有则不设。 */
  notice?: string;
}

interface PendingPair {
  userId: number;
  question: string;
  answer: string;
}

const compactionFailureUntil = new Map<string, number>();

/** 测试/手动重试用：清掉压缩失败退避。 */
export function resetReadingCompactionBackoff(): void {
  compactionFailureUntil.clear();
}

function pairChars(pair: ReadingHistoryPair | PendingPair): number {
  const question = 'question' in pair ? pair.question : '';
  const answer = 'answer' in pair ? (pair.answer ?? '') : '';
  return question.length + answer.length;
}

function pairsChars(pairs: readonly ReadingHistoryPair[]): number {
  return pairs.reduce((sum, pair) => sum + pairChars(pair), 0);
}

function fallbackPairsOf(history: unknown): ReadingHistoryPair[] {
  if (!Array.isArray(history)) return [];
  const pairs: ReadingHistoryPair[] = [];
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { question?: unknown; answer?: unknown };
    const question = typeof row.question === 'string' ? row.question.trim() : '';
    if (!question) continue;
    pairs.push({
      question,
      ...(typeof row.answer === 'string' && row.answer.trim()
        ? { answer: row.answer.trim() }
        : {})
    });
  }
  return pairs;
}

/** 把消息行按「user 后紧跟 assistant」配对；失败的助手占位也算一轮（保留其内容）。 */
function pairsFromMessages(
  rows: ReturnType<Store['listMessages']>
): PendingPair[] {
  const pairs: PendingPair[] = [];
  let current: PendingPair | null = null;
  for (const row of rows) {
    if (row.role === 'user') {
      if (current) pairs.push(current);
      current = { userId: row.id, question: row.content, answer: '' };
    } else if (current) {
      // 同一轮出现多个 assistant 消息（失败占位/重答残留）时合并，避免丢上下文。
      current.answer = current.answer ? `${current.answer}\n${row.content}` : row.content;
    }
  }
  if (current) pairs.push(current);
  return pairs;
}

function toPublicPairs(pairs: readonly PendingPair[]): ReadingHistoryPair[] {
  return pairs.map((pair) => ({
    question: pair.question,
    ...(pair.answer.trim() ? { answer: pair.answer } : {})
  }));
}

function tailWithinBudget(pairs: readonly PendingPair[], maxPairs: number, maxChars: number): PendingPair[] {
  const kept: PendingPair[] = [];
  let chars = 0;
  for (let index = pairs.length - 1; index >= 0 && kept.length < maxPairs; index -= 1) {
    const pair = pairs[index]!;
    const next = chars + pairChars(pair);
    if (kept.length > 0 && next > maxChars) break;
    kept.unshift(pair);
    chars = next;
  }
  return kept;
}

function summaryPrompt(summary: string, compacted: readonly PendingPair[]): string {
  return (
    `已有摘要（可能为空）：\n${summary || '（无）'}\n\n` +
    `需要并入摘要的早期阅读问答轮次：\n${compacted
      .map(
        (pair, index) =>
          `第 ${index + 1} 轮\n问：${pair.question.slice(0, 1200)}\n答：${pair.answer.slice(0, 1600)}`
      )
      .join('\n\n')}\n\n` +
    '请输出更新后的摘要，控制在 2000 字以内。'
  );
}

const COMPACTION_SYSTEM =
  '你在压缩一段「文献阅读对话」的早期上下文。只保留：用户关注的问题与意图、已经确认的结论、'
  + '尚未解决的疑问、对话中提到的页码/章节方向。不要编造、不要输出或保留 [1][2] 这类引用编号、'
  + '不要把摘要写成文献原文或证据；摘要只是会话上下文。用简洁的 Markdown 条目输出。';

export interface PrepareReadingSessionContextOptions {
  store: Store;
  config: ReadingChatConfig;
  documentId: string;
  sessionId?: string;
  /** 客户端仍会带最近 N 轮（兼容旧客户端/无会话时）。 */
  fallbackHistory?: unknown;
  signal?: AbortSignal;
}

/**
 * 计算本轮阅读伙伴要送入模型的会话上下文：
 * - 有 sessionId：从数据库读该会话完整消息，按摘要 + 最近轮次收敛；
 * - 无 sessionId：退回客户端带来的最近 N 轮（旧行为）。
 */
export async function prepareReadingSessionContext(
  options: PrepareReadingSessionContextOptions
): Promise<PreparedReadingContext> {
  const fallback = fallbackPairsOf(options.fallbackHistory);
  const sessionId = options.sessionId?.trim() ?? '';
  if (!sessionId) {
    return { history: fallback, summary: '', compactedTurns: 0 };
  }
  const sessions = readDocumentChatSessions(options.store, options.documentId);
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    return {
      history: fallback,
      summary: '',
      compactedTurns: 0,
      notice: '没有找到该阅读会话，本轮只使用最近轮次作为上下文。'
    };
  }
  const rows = options.store.listMessages(options.documentId, { sessionId });
  const pairs = pairsFromMessages(rows);
  if (pairs.length === 0) {
    return { history: fallback, summary: session.contextSummary ?? '', compactedTurns: 0 };
  }
  const summary = session.contextSummary ?? '';
  const summaryUpto = session.summaryUpto ?? 0;
  // 摘要写回用消息版本做条件更新：压缩期间任何消息增删改都会让版本变化。
  const expectedVersion = session.transcriptVersion ?? 0;
  const pending = pairs.filter((pair) => pair.userId > summaryUpto);
  if (pending.length === 0) {
    return { history: fallback, summary, compactedTurns: 0 };
  }
  const pendingPublic = toPublicPairs(pending);
  // 未超预算：完整带上（已经是「完整会话历史」的最近部分）。
  if (
    pending.length <= READING_CONTEXT_MAX_PAIRS &&
    pairsChars(pendingPublic) <= READING_CONTEXT_MAX_CHARS
  ) {
    return { history: pendingPublic, summary, compactedTurns: 0 };
  }
  // 从最旧开始压缩，直到剩余轮次落入保留预算；至少保留最后一轮。
  let cut = 0;
  while (cut < pending.length - 1) {
    const remaining = pending.slice(cut);
    if (
      remaining.length <= READING_CONTEXT_KEEP_PAIRS &&
      pairsChars(toPublicPairs(remaining)) <= READING_CONTEXT_KEEP_CHARS
    ) {
      break;
    }
    cut += 1;
  }
  if (cut === 0) {
    // 只有一轮但已经超预算：不压缩（没有更早的轮次可压），交给阅读链路按容量如实处理。
    return { history: pendingPublic, summary, compactedTurns: 0 };
  }
  const compacted = pending.slice(0, cut);
  const remaining = pending.slice(cut);
  const failureKey = `${options.documentId}:${sessionId}`;
  const failedUntil = compactionFailureUntil.get(failureKey) ?? 0;
  if (failedUntil > Date.now()) {
    const kept = tailWithinBudget(
      pending,
      READING_CONTEXT_KEEP_PAIRS,
      READING_CONTEXT_KEEP_CHARS
    );
    return {
      history: toPublicPairs(kept),
      summary,
      compactedTurns: 0,
      notice: '早期历史压缩刚失败过，本轮只带最近几轮；稍后会自动重试。'
    };
  }
  try {
    const nextSummary = await callChatModel(
      options.config,
      COMPACTION_SYSTEM,
      summaryPrompt(summary, compacted),
      600,
      options.signal,
      undefined,
      undefined,
      undefined,
      '压缩阅读会话早期上下文',
      [],
      true
    );
    const trimmed = nextSummary.trim().slice(0, READING_CONTEXT_SUMMARY_MAX_CHARS);
    if (!trimmed) throw new Error('模型返回空摘要');
    // 压缩期间会话可能被另一个窗口/进程编辑、删除或摘要已被改写：
    // 先在 SQL 里用 transcript_version 做条件更新（CAS），版本不匹配就丢弃这次摘要。
    const latestSession = readDocumentChatSessions(options.store, options.documentId).find(
      (item) => item.id === sessionId
    );
    if (!latestSession || (latestSession.contextSummary ?? '') !== summary) {
      return {
        history: fallback,
        summary: '',
        compactedTurns: 0,
        notice: '压缩期间会话历史被修改，本轮丢弃这次压缩结果、只使用最近轮次。'
      };
    }
    const summaryUptoNext = compacted[compacted.length - 1]!.userId;
    const written = options.store.compareAndSetDocumentChatSessionSummary(
      options.documentId,
      sessionId,
      expectedVersion,
      trimmed,
      summaryUptoNext
    );
    if (!written) {
      return {
        history: fallback,
        summary: '',
        compactedTurns: 0,
        notice: '压缩期间会话历史被修改，本轮丢弃这次压缩结果、只使用最近轮次。'
      };
    }
    compactionFailureUntil.delete(failureKey);
    return {
      history: toPublicPairs(remaining),
      summary: trimmed,
      compactedTurns: compacted.length,
      notice:
        `已把本会话较早的 ${compacted.length} 轮压缩成摘要（摘要由会话模型生成，` +
        '不是文献原文/证据）；本轮上下文 = 摘要 + 最近轮次。'
    };
  } catch (error) {
    compactionFailureUntil.set(failureKey, Date.now() + COMPACTION_FAILURE_BACKOFF_MS);
    const kept = tailWithinBudget(
      pending,
      READING_CONTEXT_KEEP_PAIRS,
      READING_CONTEXT_KEEP_CHARS
    );
    return {
      history: toPublicPairs(kept),
      summary,
      compactedTurns: 0,
      notice: `早期历史压缩失败，本轮只带最近几轮：${
        error instanceof Error ? error.message : '未知错误'
      }`
    };
  }
}
