import { markdownPlainText } from '@studianda/shared';
import type { AnnotationRecord, ChatSource, NoteRecord } from '@studianda/shared';
import { tokens } from './retrieval.js';
import type { Store } from './store.js';

/**
 * 笔记/批注纳入问答时的召回与材料生成。
 *
 * 设计前提（与产品口径一致）：笔记与批注是**用户自己的记录**，不是文献原文。
 * 因此本模块单独成链：命中的东西只用于"理解用户已关注什么 / 帮助定位原文"，
 * 绝不写进 `sources`、不参与引用编号，也不与原文证据混在一起排序。
 */

/** 每类（笔记 / 批注）默认召回上限。 */
const DEFAULT_LIMIT = 8;
/** 材料默认字符预算：问答提示里笔记/批注只作补充，不能挤占原文与问题的空间。 */
const DEFAULT_MATERIAL_BUDGET = 6000;
/**
 * 「最近记录」兜底的固定分数：低于任何正常词面命中（coverage 最小也 > 0），
 * 让下游一眼能看出它不是匹配结果；材料据此如实标注。
 */
const RECENT_SCORE = 0.05;

/** 材料首行（字段固定，下游提示词与界面说明都按它理解材料性质）。 */
const MATERIAL_HEADER =
  '用户笔记与批注（用户自己的记录，不是文献原文；不能作为逐字证据或引用编号）：';

const RECENT_NOTICE =
  '（问题提到笔记或批注，但范围内没有词面命中的记录；以下按时间倒序为最近记录，仅用于了解你已关注什么）';

/** 有笔记/批注材料时追加到回答指令后的规则文本。 */
export const MEMORY_RULES =
  '本轮另附「用户笔记与批注」：那是用户自己的记录，不是文献原文，不能当作文献原文证据、逐字引用或引用编号；引用编号只能指向文献原文。可以用它理解用户已经关注什么、帮助定位原文；与原文冲突时以原文为准并明确说明口径。';

export interface MemorySearchOptions {
  question: string;
  selection?: string;
  /** 范围文献 id；undefined 表示全库（并纳入独立笔记）。 */
  documentIds?: string[];
  includeNotes: boolean;
  includeAnnotations: boolean;
  /** 每类上限，默认 8。 */
  limit?: number;
}

export interface MemoryHit {
  kind: 'note' | 'annotation';
  id: string;
  documentId: string; // 独立笔记为 ''
  documentName: string; // 独立笔记为 '独立笔记'
  page: number; // 独立笔记为 0
  title: string; // '笔记 · 第 3 页' / '批注 · 第 5 页' / '独立笔记'
  text: string; // Markdown 已转纯文本；批注为「摘引 + 批注正文」
  quote?: string; // 摘引原文（可空）
  created: string;
  score: number;
  /** 笔记标签（只用于让模型理解归类；不是原文证据）。 */
  tags?: string[];
  /** 笔记所在虚拟文件夹（独立笔记用；空串表示根目录）。 */
  folder?: string;
}

/**
 * 问题里是否显式提到笔记/批注（泛化词：笔记、批注、注释、摘录、记录、
 * highlight、annotation、note）。
 *
 * 只有显式提到时才允许"没命中就给最近记录"的兜底：否则用户问文献内容，
 * 我们却把无关的个人记录塞进提示，等于制造噪音。
 */
export function wantsMemory(question: string): boolean {
  const text = (question ?? '').toLowerCase();
  if (!text.trim()) return false;
  // 不收单字"记录"：「把这篇文献记录的论点总结一下」这类句子里的"记录"是动词/定语，
  // 不是"在说我的记录"；只认明确指向个人记录的说法（我的记录/个人记录/记录本）。
  if (/笔记|批注|注释|摘录|我的记录|个人记录|记录本/.test(text)) return true;
  // 英文按词边界匹配（允许复数/过去式），避免 "notebook" 这类词误触发。
  return /\b(?:notes?|annotations?|highlights?|highlighted)\b/i.test(text);
}

interface ScopeDocument {
  id: string;
  name: string;
}

/** 解析范围：给定 documentIds 时只取这些文献；undefined 才是"全库 + 独立笔记"。 */
function scopedDocuments(
  store: Store,
  documentIds: string[] | undefined
): { documents: ScopeDocument[]; allLibrary: boolean } {
  if (documentIds === undefined) {
    return {
      documents: store.listDocuments(false).map((document) => ({
        id: document.id,
        name: document.name
      })),
      allLibrary: true
    };
  }
  const documents: ScopeDocument[] = [];
  const seen = new Set<string>();
  for (const raw of documentIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // getDocument 只返回未删除的文献：范围里混进已删除/不存在的 id 时直接跳过。
    const document = store.getDocument(id);
    if (document) documents.push({ id: document.id, name: document.name });
  }
  return { documents, allLibrary: false };
}

interface MemoryCandidate {
  hit: Omit<MemoryHit, 'score'>;
  /** 参与词面打分的文本（摘引 + 正文），不含"批注："这类我们自己加的标签，避免标签词刷命中。 */
  haystack: string;
}

function noteCandidate(note: NoteRecord, documentName: string): MemoryCandidate | null {
  const text = markdownPlainText(note.content).trim();
  // 只有原文摘录、用户自己没写正文的笔记没有可作补充材料的内容，不纳入。
  if (!text) return null;
  const quote = (note.quote ?? '').trim();
  const standalone = !note.documentId;
  return {
    hit: {
      kind: 'note',
      id: note.id,
      documentId: standalone ? '' : note.documentId,
      documentName: standalone ? '独立笔记' : documentName,
      page: standalone ? 0 : note.page,
      title: standalone ? '独立笔记' : `笔记 · 第 ${note.page} 页`,
      text,
      ...(quote ? { quote } : {}),
      created: note.created,
      ...(note.tags?.length ? { tags: [...note.tags] } : {}),
      ...(note.folderPath ? { folder: note.folderPath } : {})
    },
    haystack: `${quote}\n${text}`
  };
}

function annotationCandidate(
  annotation: AnnotationRecord,
  documentName: string
): MemoryCandidate | null {
  const quote = (annotation.quote ?? '').trim();
  const comment = markdownPlainText(annotation.content).trim();
  // 摘引与批注正文都空的批注没有信息量。
  if (!quote && !comment) return null;
  const text = quote ? (comment ? `${quote}\n批注：${comment}` : quote) : comment;
  return {
    hit: {
      kind: 'annotation',
      id: annotation.id,
      documentId: annotation.documentId,
      documentName,
      page: annotation.page,
      title: `批注 · 第 ${annotation.page} 页`,
      text,
      ...(quote ? { quote } : {}),
      created: annotation.created
    },
    // 打分只看摘引与批注正文：若把 text 里拼的"批注："也算进来，问句里的"批注"
    // 会让每条批注都命中，词面召回就失去意义。
    haystack: `${quote}\n${comment}`
  };
}

function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/**
 * 把 'YYYY-MM-DD HH:MM:SS'（SQLite CURRENT_TIMESTAMP，UTC）与 'YYYY-MM-DDTHH:MM:SS.sssZ'
 * （JS ISO）归一成可比较的固定 ISO 形式。
 *
 * 两种格式直接按字符串排序时：空格(0x20) 比 'T'(0x54) 小，同一天的笔记会整体排在
 * 批注前面，与真实时间无关；这里补齐小数位与时区，保证"按时间倒序"名副其实。
 */
function comparableCreated(created: string): string {
  const value = (created ?? '').trim();
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z?$/.exec(value);
  if (!match) return value;
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0')}Z`;
}

/** 排序口径：score desc → created desc → id（固定 id 兜底，保证同分同秒时输出确定）。 */
function compareHits(left: MemoryHit, right: MemoryHit): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftCreated = comparableCreated(left.created);
  const rightCreated = comparableCreated(right.created);
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 「原句」候选：完整 query（问题 + 选文）、单独问题、单独选文；太短的当原句会误伤。 */
function phraseNeedles(question: string, selection: string, queryText: string): string[] {
  const needles = new Set<string>();
  for (const value of [queryText, question, selection]) {
    const needle = value.trim().toLowerCase();
    if (needle.length >= 2) needles.add(needle);
  }
  return [...needles];
}

function lexicalHits(
  candidates: MemoryCandidate[],
  queryText: string,
  needles: string[]
): MemoryHit[] {
  const queryTokens = [...new Set(tokens(queryText))];
  if (queryTokens.length === 0) return [];
  const hits: MemoryHit[] = [];
  for (const candidate of candidates) {
    const candidateTokens = new Set(tokens(candidate.haystack));
    let matched = 0;
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) matched += 1;
    }
    // coverage > 0 即入选：笔记是补充材料，只要沾到一个查询词就值得给模型看一眼。
    if (matched === 0) continue;
    let score = matched / queryTokens.length;
    const haystack = candidate.haystack.toLowerCase();
    if (needles.some((needle) => haystack.includes(needle))) score += 0.5;
    hits.push({ ...candidate.hit, score: roundScore(score) });
  }
  return hits;
}

/** 每类各取前 limit 条，再按统一口径排序：既满足"每类上限"，输出顺序也确定。 */
function limitPerKind(hits: MemoryHit[], limit: number): MemoryHit[] {
  const notes = hits
    .filter((hit) => hit.kind === 'note')
    .sort(compareHits)
    .slice(0, limit);
  const annotations = hits
    .filter((hit) => hit.kind === 'annotation')
    .sort(compareHits)
    .slice(0, limit);
  return [...notes, ...annotations].sort(compareHits);
}

/**
 * 显式提到笔记/批注却没有任何词面命中时的兜底：按 created 倒序给最近记录。
 *
 * 这时分数统一记 0.05，让上游/材料都清楚它只是"最近记录"，不是匹配到的内容。
 */
function recentHits(candidates: MemoryCandidate[], limit: number): MemoryHit[] {
  const notes: MemoryHit[] = [];
  const annotations: MemoryHit[] = [];
  for (const candidate of candidates) {
    const hit: MemoryHit = { ...candidate.hit, score: RECENT_SCORE };
    if (hit.kind === 'note') notes.push(hit);
    else annotations.push(hit);
  }
  return [
    ...notes.sort(compareHits).slice(0, limit),
    ...annotations.sort(compareHits).slice(0, limit)
  ].sort(compareHits);
}

/**
 * 词面打分召回：query = question + selection；每类最多 limit 条；
 * 排序 score desc → created desc。
 *
 * 诚实原则：没有词面命中且用户没有显式提到笔记/批注时返回空数组，不拿无关记录凑数。
 */
export function searchMemory(store: Store, options: MemorySearchOptions): MemoryHit[] {
  const includeNotes = options.includeNotes === true;
  const includeAnnotations = options.includeAnnotations === true;
  if (!includeNotes && !includeAnnotations) return [];
  const limit = normalizeLimit(options.limit);
  if (limit === 0) return [];

  const question = (options.question ?? '').trim();
  const selection = (options.selection ?? '').trim();
  const queryText = selection ? `${question}\n${selection}` : question;

  const { documents, allLibrary } = scopedDocuments(store, options.documentIds);
  const candidates: MemoryCandidate[] = [];
  for (const document of documents) {
    if (includeNotes) {
      for (const note of store.listNotes(document.id)) {
        const candidate = noteCandidate(note, document.name);
        if (candidate) candidates.push(candidate);
      }
    }
    if (includeAnnotations) {
      for (const annotation of store.listAnnotations(document.id)) {
        const candidate = annotationCandidate(annotation, document.name);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  // 独立笔记不属于任何文献：只有"全库"范围才纳入。
  if (allLibrary && includeNotes) {
    for (const note of store.listStandaloneNotes(false)) {
      const candidate = noteCandidate(note, '独立笔记');
      if (candidate) candidates.push(candidate);
    }
  }

  const lexical = lexicalHits(
    candidates,
    queryText,
    phraseNeedles(question, selection, queryText)
  );
  if (lexical.length > 0) return limitPerKind(lexical, limit);
  if (!wantsMemory(question)) return [];
  return recentHits(candidates, limit);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(0, Math.trunc(value));
}

/** 材料里的日期只到天：清单是给模型看的摘要，精确到秒没有意义且更费 token。 */
function materialDate(created: string): string {
  const value = (created ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : '时间未知';
}

/** 单行化：材料是"一条记录一行"的清单，多段正文压成一行，避免把结构撑散。 */
function oneLine(value: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 从批注的 text 里还原出批注正文。
 *
 * MemoryHit 没有单独的"批注正文"字段（契约固定），而 text 的拼法是本模块定的
 * （`摘引 + "\n批注：" + 正文`），因此可以确定地拆回来；拆不出来时按整段正文处理。
 */
function annotationComment(hit: MemoryHit): string {
  const quote = (hit.quote ?? '').trim();
  const text = hit.text ?? '';
  if (!quote) return text;
  const prefix = `${quote}\n批注：`;
  if (text.startsWith(prefix)) return text.slice(prefix.length);
  if (text.trim() === quote) return '';
  return text;
}

function memoryNoteMeta(hit: MemoryHit): string {
  const parts: string[] = [];
  if (hit.folder) parts.push(`文件夹：${hit.folder}`);
  if (hit.tags && hit.tags.length > 0) parts.push(`标签：${hit.tags.join('、')}`);
  return parts.length > 0 ? `；${parts.join('；')}` : '';
}

function memoryRecordLine(hit: MemoryHit): string {
  const date = materialDate(hit.created);
  if (hit.kind === 'annotation') {
    const quote = oneLine(hit.quote ?? '');
    const comment = oneLine(annotationComment(hit));
    const body = quote
      ? comment
        ? `摘引「${quote}」；批注：${comment}`
        : `摘引「${quote}」`
      : `批注：${comment}`;
    return `[批注] 《${hit.documentName}》第 ${hit.page} 页（${date}）：${body}`;
  }
  const meta = memoryNoteMeta(hit);
  if (!hit.documentId) {
    return `[独立笔记]《${hit.documentName}》（无页码${meta}）：${oneLine(hit.text)}`;
  }
  return `[笔记] 《${hit.documentName}》第 ${hit.page} 页（${date}${meta}）：${oneLine(hit.text)}`;
}

/**
 * 生成最终回答用的补充材料；空数组返回 ''。含字符预算（默认 6000），超出截断并说明。
 *
 * 材料自带"不是文献原文"的抬头；规则文本由 `MEMORY_RULES` 单独给出，二者都进入提示，
 * 让模型在任何拼装路径下都不会把笔记/批注当成可引用证据。
 */
export function memoryMaterial(
  hits: readonly MemoryHit[],
  budget: number = DEFAULT_MATERIAL_BUDGET
): string {
  if (hits.length === 0) return '';
  const limit =
    Number.isFinite(budget) && budget > 0 ? Math.trunc(budget) : DEFAULT_MATERIAL_BUDGET;
  const lines = hits.map(memoryRecordLine);
  const output: string[] = [MATERIAL_HEADER];
  let used = MATERIAL_HEADER.length;

  // 全部命中都是「最近记录」时（兜底路径），先如实说明它不是词面匹配结果。
  if (hits.every((hit) => hit.score === RECENT_SCORE)) {
    output.push(RECENT_NOTICE);
    used += 1 + RECENT_NOTICE.length;
  }

  let kept = 0;
  let truncated = false;
  for (const line of lines) {
    const cost = 1 + line.length;
    if (used + cost <= limit) {
      output.push(line);
      used += cost;
      kept += 1;
      continue;
    }
    // 最后一条还能放下一小段时截断保留，比整条丢掉更接近预算本意。
    const room = limit - used - 1;
    if (room > 20) {
      output.push(`${line.slice(0, room - 1)}…`);
      kept += 1;
    }
    truncated = true;
    break;
  }
  if (truncated) {
    output.push(
      `（笔记与批注材料超出 ${limit} 字符预算，已截断：共 ${lines.length} 条，纳入前 ${kept} 条）`
    );
  }
  return output.join('\n');
}

/** 转 ChatSource：这些来源只进「参考的笔记与批注」区块，绝不进 sources/引用编号。 */
export function memoryChatSources(hits: readonly MemoryHit[]): ChatSource[] {
  return hits.map((hit) => ({
    documentId: hit.documentId,
    documentName: hit.documentName,
    page: hit.page,
    snippet: hit.text.slice(0, 240),
    kind: hit.kind,
    sourceType: hit.kind,
    memoryId: hit.id,
    // 摘引来自用户当初在原文里的选中，是逐字重合片段：只作定位锚点（界面据此跳页高亮），
    // 不是证据、不进引用编号。没有摘引（如独立笔记）就不给锚点。
    ...(hit.quote ? { anchor: hit.quote } : {})
  }));
}
