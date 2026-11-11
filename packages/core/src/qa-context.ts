import type { QaMessageRecord, QaSessionRecord } from '@studianda/shared';
import { cost } from './reading.js';
import { inputCost, PER_MESSAGE_COST, prefix } from './request-budget.js';
import {
  callChatModel,
  type HistoryMessage,
  type ReadingChatConfig
} from './reading-chat.js';
import type { Store } from './store.js';

/**
 * 独立问答的会话上下文（agent-harness 式）：
 *
 * 1. **完整历史**：会话里的每一轮都由服务端持久化，不再像阅读页那样只取「最近 N 轮」；
 * 2. **容量兜底**：每轮按模型输入预算（`chatInputLimit`）计算「系统提示 + 本轮问题/证据」
 *    之外还能装多少历史；装不下时把**最旧的若干轮压缩成摘要**（存回会话，后续轮次复用），
 *    而不是直接丢弃；摘要调用失败才退回「从最旧丢弃」并在 `notice` 里如实说明；
 * 3. **角色还原**：失败/占位消息（`answered=false`）不进上下文，避免把「回答未完成」当成
 *    有效回答喂给模型。
 *
 * 这是本仓库自己的实现：只依赖仓库内既有模块（token 估算、模型调用、会话存储），
 * 没有引入或抄录任何外部项目的代码。
 */

/** 压缩摘要调用的输出上限（token）：摘要必须短，否则压缩没有意义。 */
const COMPACTION_MAX_TOKENS = 900;
/** 摘要正文字符上限（防御模型超长输出）。 */
const COMPACTION_MAX_CHARS = 4000;
/** 单条旧消息进入摘要提示时的字符上限：防止一条超长回答吃掉整个摘要调用。 */
const COMPACTION_MESSAGE_CHARS = 1200;
/** 摘要调用里给提示框架/输出预留的 token（压缩请求本身也是模型调用）。 */
const COMPACTION_FRAME_RESERVE = 700;
/** 一轮问答最多连续压缩几次（每次压缩最旧的一段，直到装得下）。 */
const MAX_COMPACTION_ROUNDS = 4;
/** 少于这么多条消息时不压缩：直接按容量丢弃更省一次模型调用。 */
const MIN_COMPACT_MESSAGES = 4;
/**
 * 压缩失败后的冷却时间：避免「模型不可用」时每一轮都先发一次注定失败的摘要调用，
 * 白白增加等待与调用次数。冷却期过后才会再次尝试。
 */
const COMPACTION_RETRY_MS = 5 * 60_000;
/**
 * 容量计算的安全余量：最终回答走 `callChatModel` 时会在 system 前再拼一段固定的
 * 不可信资料提示，比这里的估算多几十个 token；留一点余量避免贴边超限。
 */
const REQUEST_FRAMING_SLACK = 300;

/** 会话级的压缩失败冷却（进程内；不落库、不改表结构）。 */
const compactionRetryAfter = new Map<string, number>();

const COMPACTION_SYSTEM =
  '你是会话历史压缩器。把更早的对话压缩成一份要点摘要，供后续问答继续使用。'
  + '必须保留：用户问过什么、已经得出的结论、结论依据（出现过的文献名/页码/章节；'
  + '用文字描述依据，不要保留 [数字] 引用编号）、尚未解决的问题、用户明确表达的偏好或要求。'
  + '只根据给定内容压缩，不编造、不添加新结论；输出中文纯文本，不要 Markdown 标题。';

/** 追问的指代/延续线索：命中时把会话上文拼进检索查询（只用于检索定位，不当证据）。 */
const FOLLOW_UP_CUES =
  /(它|他|她|其|该|这|那|此|上述|前述|前面|刚才|刚刚|上一轮|上文|那么|所以|然后|继续|还有呢|再说)/;

/** 本轮送入模型的上下文结果（供库内检索路径拼消息与界面如实说明）。 */
export interface QaConversation {
  /** 以原文形式保留的最近历史（从旧到新）。 */
  prior: HistoryMessage[];
  /** 需要追加到 system 提示的压缩摘要段；空串表示本轮没有摘要。 */
  summaryBlock: string;
  /**
   * 需要追加到 system 提示的「容量省略」说明段；空串表示没有省略。
   *
   * 这段是**给模型看的**：模型必须知道有轮次没进入上下文，不能假装看到过。
   */
  omittedBlock: string;
  /** 界面/接口用的统计。 */
  stats: {
    messages: number;
    summary_used: boolean;
    compacted: number;
    dropped: number;
  };
}

function summaryBlockOf(summary: string): string {
  const text = summary.trim();
  if (!text) return '';
  return `\n\n本会话更早轮次的压缩摘要（系统生成，不是用户原话；只是上下文，不是文献证据；`
    + '摘要里提到的依据仍需用本轮原文片段核对）：\n' + text;
}

/** 给模型的「有轮次被容量省略」说明；没有省略返回空串。 */
function omittedBlockOf(dropped: number): string {
  if (dropped <= 0) return '';
  return `\n\n注意：本会话更早的 ${dropped} 轮问答因容量限制没有进入本轮上下文`
    + '（也不在摘要里）。不要假装看到过这些内容；必要时让用户重述。';
}

/** 历史里可能含旧引用编号：明确告诉模型旧编号不属于本轮证据。 */
export function staleCitationBlock(hasPrior: boolean, hasSummary: boolean): string {
  if (!hasPrior && !hasSummary) return '';
  return '\n\n历史轮次的回答里可能出现 [1][2] 这类编号，那些编号只属于当时那一轮，'
    + '不能当作本轮引用，也不要据此回忆原文；本轮只能引用本轮给出的原文片段。';
}

/** 追问是否需要把会话上文拼进检索查询（短问题或含指代/延续线索）。 */
export function needsConversationContext(question: string): boolean {
  const text = question.trim();
  if (!text) return false;
  if ([...text].length <= 20) return true;
  return FOLLOW_UP_CUES.test(text);
}

/**
 * 追问的检索查询：当前问题 + 最近两轮问答（截断、只用于检索定位）。
 *
 * 检索发生在调用模型之前，没有这步的话「那它的测量口径呢？」这类问题会拿不到指代对象，
 * 命中位置就容易错。拼进去的上文只影响检索，不是本轮证据（提示词与 sources 都不含它）。
 */
export function retrievalQueryForConversation(
  question: string,
  history: Array<{ question: string; answer?: string }>
): string {
  if (history.length === 0 || !needsConversationContext(question)) return question;
  const recent: string[] = [];
  for (const pair of history.slice(-2)) {
    const asked = pair.question.trim();
    if (asked) recent.push(`问：${asked}`);
    const answer = pair.answer?.trim();
    if (answer) recent.push(`答：${answer}`);
  }
  if (recent.length === 0) return question;
  const context = recent.join('\n').slice(-1200);
  return `${question}\n\n会话上文（只用于检索定位，不是本轮证据）：\n${context}`;
}

/** 测试用：清空压缩失败冷却（避免用例之间互相影响）。 */
export function resetQaCompactionBackoff(): void {
  compactionRetryAfter.clear();
}

/** 把一条会话消息折成模型可见的历史消息；失败/占位回答不进入上下文。 */
function messageToHistory(message: QaMessageRecord): HistoryMessage | null {
  const content = message.content.trim();
  if (!content) return null;
  if (message.role === 'user') return { role: 'user', content };
  if (!message.answered) return null;
  return { role: 'assistant', content };
}

function historyOf(messages: readonly QaMessageRecord[]): HistoryMessage[] {
  const prior: HistoryMessage[] = [];
  for (const message of messages) {
    const row = messageToHistory(message);
    if (row) prior.push(row);
  }
  return prior;
}

/** 历史消息的 token 成本（与 request_budget 口径一致：正文 + 每条固定开销）。 */
function historyCost(prior: readonly HistoryMessage[]): number {
  return prior.reduce((total, row) => total + cost(row.content) + PER_MESSAGE_COST, 0);
}

/** 本条请求的「系统提示 + 本轮用户材料」成本。 */
function turnCost(system: string, user: string): number {
  return inputCost([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]);
}

/**
 * 去掉「本轮刚追加的用户消息」：服务端先落库再回答问题，同一条问题不应在历史里出现两次。
 *
 * 只处理最后一条是 user 且内容与本轮问题一致（或语音占位）的情况；续读/补查重发时最后一条
 * 是助手回答，不会被误删。
 */
function withoutCurrentTurn(messages: QaMessageRecord[], question: string): QaMessageRecord[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;
  const content = last.content.trim();
  const asked = question.trim();
  if (!content) return messages;
  if (content === '（语音提问）') return messages.slice(0, -1);
  if (!asked) return messages;
  if (content === asked) return messages.slice(0, -1);
  return messages;
}

/** 从最旧开始按整轮丢弃，直到历史能装进 room；返回丢弃的轮数。 */
function trimHistory(prior: HistoryMessage[], room: number): {
  kept: HistoryMessage[];
  dropped: number;
} {
  let kept = [...prior];
  let dropped = 0;
  while (kept.length > 0 && historyCost(kept) > Math.max(0, room)) {
    // 按整轮丢：user 连同紧随其后的 assistant 一起丢，避免留下没有提问的回答。
    if (kept[0]?.role === 'user') {
      kept = kept.slice(1);
      if (kept[0]?.role === 'assistant') kept = kept.slice(1);
    } else {
      kept = kept.slice(1);
    }
    dropped += 1;
  }
  return { kept, dropped };
}

function turnCount(rows: readonly QaMessageRecord[]): number {
  return rows.filter((row) => row.role === 'user').length || rows.length;
}

/** 把待压缩消息拼成摘要调用的材料（每条按字符上限截断，避免单条吃掉整个调用）。 */
function chunkMaterialOf(header: string, rows: readonly QaMessageRecord[]): string {
  const body = rows
    .map(
      (row) =>
        `${row.role === 'user' ? '用户' : '助手'}：` +
        `${row.content.trim().slice(0, COMPACTION_MESSAGE_CHARS)}`
    )
    .join('\n\n');
  return `${header}${body}`;
}

/**
 * 取「最旧、且能装进一次压缩调用」的一段消息作为待压缩块。
 *
 * 只接受整条消息：单条消息本身超过压缩调用的容量时才按成本截断文字（失去的是该条消息
 * 尾部，而不是整条丢失），并在摘要里说明是压缩而非原文。
 * 压缩块尽量在**整轮边界**结束（不把 user 与它的 assistant 答拆到摘要/原文两边），
 * 否则下一轮历史会以一个没有提问的 assistant 回答开头。
 */
function pickOldestChunk(
  rows: readonly QaMessageRecord[],
  input: { summary: string; inputLimit: number }
): { rows: QaMessageRecord[]; material: string } | null {
  if (rows.length === 0) return null;
  const frame = turnCost(COMPACTION_SYSTEM, '');
  const room = Math.max(0, input.inputLimit - frame - COMPACTION_FRAME_RESERVE);
  if (room <= 0) return null;
  const header = input.summary.trim()
    ? `更早已有的摘要：\n${input.summary.trim()}\n\n待压缩的对话：\n`
    : '待压缩的对话：\n';
  const picked: QaMessageRecord[] = [];
  for (const row of rows) {
    const candidate = [...picked, row];
    const material = chunkMaterialOf(header, candidate);
    if (picked.length > 0 && cost(material) > room) break;
    picked.push(row);
    if (cost(material) > room) break;
  }
  if (picked.length === 0) return null;
  // 收尾对齐到整轮边界：如果只截到一条 user，把它的助手回答也带上（材料超容量时下面会按成本
  // 截断这条回答的尾部）；如果结尾多余地挂了没有回答的 user，则去掉它，让回答留在原文侧。
  if (picked.length === 1 && picked[0]!.role === 'user' && rows[1]?.role === 'assistant') {
    picked.push(rows[1]);
  }
  while (picked.length > 1 && picked[picked.length - 1]!.role === 'user') {
    picked.pop();
  }
  const full = chunkMaterialOf(header, picked);
  const available = room - cost(header);
  // 连「已有摘要」本身都快占满压缩调用了：本轮不做压缩，交给调用方如实丢弃 + 说明。
  if (available <= 0) return null;
  const material =
    cost(full) > room
      ? `${header}${prefix(
          full.slice(header.length),
          Math.max(0, available)
        )}`
      : full;
  if (!material.trim()) return null;
  return { rows: picked, material };
}

async function summarizeChunk(
  config: ReadingChatConfig,
  material: string,
  inputLimit: number,
  signal?: AbortSignal
): Promise<string> {
  const text = await callChatModel(
    config,
    COMPACTION_SYSTEM,
    material,
    COMPACTION_MAX_TOKENS,
    signal,
    undefined,
    undefined,
    inputLimit,
    '会话历史压缩',
    [],
    true
  );
  return text.trim().slice(0, COMPACTION_MAX_CHARS);
}

/**
 * 为库内检索问答准备「完整会话历史 + 容量压缩」。
 *
 * 返回的 `summaryBlock` 必须由调用方追加进 system 提示；`prior` 里只是还能装下的最近原文。
 * 全程不抛出容量类异常：装不下就压缩，压缩失败就从最旧丢弃并如实返回丢弃轮数。
 */
export async function prepareQaConversation(input: {
  store: Store;
  session: QaSessionRecord;
  config: ReadingChatConfig | null;
  baseSystem: string;
  user: string;
  question: string;
  inputLimit: number;
  signal?: AbortSignal;
  onStage?: (text: string) => void;
}): Promise<QaConversation> {
  const allMessages = input.store.listQaMessages(input.session.id);
  const currentTurnRemoved = withoutCurrentTurn(allMessages, input.question);
  let summary = input.session.contextSummary.trim();
  let summaryUpto = Math.max(0, input.session.summaryUpto);
  let compacted = 0;

  for (let round = 0; round < MAX_COMPACTION_ROUNDS; round += 1) {
    const remaining = currentTurnRemoved.filter((message) => message.id > summaryUpto);
    const prior = historyOf(remaining);
    const system = input.baseSystem + summaryBlockOf(summary);
    const room = input.inputLimit - turnCost(system, input.user) - REQUEST_FRAMING_SLACK;
    if (historyCost(prior) <= Math.max(0, room)) {
      return {
        prior,
        summaryBlock: summaryBlockOf(summary),
        omittedBlock: '',
        stats: {
          messages: allMessages.length,
          summary_used: Boolean(summary),
          compacted,
          dropped: 0
        }
      };
    }
    // 没有模型、消息太少或没有可压缩的旧消息：不做摘要，走兜底丢弃。
    if (!input.config || remaining.length < MIN_COMPACT_MESSAGES) break;
    // 压缩失败后冷却期内不再重试（模型不可用时避免每轮都多一次失败调用）。
    if ((compactionRetryAfter.get(input.session.id) ?? 0) > Date.now()) break;
    const chunk = pickOldestChunk(remaining, { summary, inputLimit: input.inputLimit });
    if (!chunk) break;
    input.onStage?.('正在压缩会话历史');
    let next: string;
    try {
      next = await summarizeChunk(input.config, chunk.material, input.inputLimit, input.signal);
    } catch {
      // 压缩失败不阻断本轮：记冷却，退回「按容量丢最旧」，由调用方在 notice 里如实说明。
      compactionRetryAfter.set(input.session.id, Date.now() + COMPACTION_RETRY_MS);
      break;
    }
    if (!next) {
      compactionRetryAfter.set(input.session.id, Date.now() + COMPACTION_RETRY_MS);
      break;
    }
    compactionRetryAfter.delete(input.session.id);
    summary = next;
    summaryUpto = chunk.rows[chunk.rows.length - 1]!.id;
    compacted += turnCount(chunk.rows);
    try {
      input.store.saveQaCompaction({
        sessionId: input.session.id,
        summary,
        upto: summaryUpto
      });
    } catch {
      // 摘要已算出来；落库失败时仍可用于本轮，下一轮会再尝试压缩。
    }
  }

  const remaining = currentTurnRemoved.filter((message) => message.id > summaryUpto);
  const system = input.baseSystem + summaryBlockOf(summary);
  const room = input.inputLimit - turnCost(system, input.user) - REQUEST_FRAMING_SLACK;
  const trimmed = trimHistory(historyOf(remaining), Math.max(0, room));
  return {
    prior: trimmed.kept,
    summaryBlock: summaryBlockOf(summary),
    omittedBlock: omittedBlockOf(trimmed.dropped),
    stats: {
      messages: allMessages.length,
      summary_used: Boolean(summary),
      compacted,
      dropped: trimmed.dropped
    }
  };
}

/**
 * 独立问答的完整历史转成 `ChatRequest.history` 形状。
 *
 * 库内检索路径会再做容量压缩（`prepareQaConversation`）；其它回答方式（联网/跨文献精读/
 * 直接回复）由各自的既有容量规则使用这份历史，避免在阅读页之外把客户端传来的「最近 N 轮」
 * 当成完整会话。
 */
export function qaHistoryPairsFromSession(
  store: Store,
  session: QaSessionRecord,
  question: string
): Array<{ question: string; answer?: string }> {
  const messages = withoutCurrentTurn(store.listQaMessages(session.id), question);
  const pairs: Array<{ question: string; answer?: string }> = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const content = message.content.trim();
      if (content) pairs.push({ question: content });
      continue;
    }
    if (!message.answered) continue;
    const answer = message.content.trim();
    if (!answer) continue;
    const last = pairs[pairs.length - 1];
    if (last && last.answer === undefined) last.answer = answer;
    else pairs.push({ question: '', answer });
  }
  return pairs;
}

/** 供测试/调试：按容量裁剪历史（不调用模型）。 */
export function trimQaHistory(
  prior: readonly HistoryMessage[],
  room: number
): { kept: HistoryMessage[]; dropped: number } {
  return trimHistory([...prior], room);
}

/** 供测试/调试：压缩调用的输入块选择。 */
export function pickQaCompactionChunk(
  rows: readonly QaMessageRecord[],
  summary: string,
  inputLimit: number
): { rows: QaMessageRecord[]; material: string } | null {
  return pickOldestChunk(rows, { summary, inputLimit });
}

/** 供测试/调试：把历史消息转成模型可见的历史（过滤失败/占位回答）。 */
export function qaHistoryMessages(messages: readonly QaMessageRecord[]): HistoryMessage[] {
  return historyOf(messages);
}
