import type { Store } from './store.js';

/**
 * 问题术语核对。
 *
 * 要防的失败方式：模型把「明明在文献里」的问题判成与文献无关的一般知识，于是回答变成
 * 「请开启知识补充」，而答案本来就在这本书里。这里做的是**确定性核对**：只用本机已有的
 * 文字（索引片段 `chunks` 与整页 OCR/用户校订 `page_edits`），不调模型、不联网、不猜。
 */

/** 只起提问作用、不能拿去找文献命中的词。 */
const QUESTION_STOPWORDS = new Set([
  '什么', '什么是', '是什么', '怎么', '怎么样', '怎样', '为什么', '为何', '如何', '哪些',
  '哪个', '哪种', '是否', '请问', '解释', '介绍', '讲讲', '说说', '一下', '这个', '那个',
  '这些', '那些', '能否', '可以', '能不能', '吗', '呢', '的', '了', '和', '与', '关于'
]);

/** 问题里常见的“脚手架”前缀：剥掉之后剩下的才是可以在文献里核对的术语。 */
const SCAFFOLD_PREFIXES = [
  '什么是', '请问', '解释一下', '介绍一下', '解释', '介绍', '讲讲', '说说', '如何', '为什么',
  '怎么', '怎样', '哪些', '哪个', '哪种', '是否', '请', '一下', '关于', '本文的', '这篇文章的',
  '该文的', '文章的', '文献的', '本文', '这篇', '该文', '文章', '文献', '论文'
];

const SCAFFOLD_SUFFIXES = ['如何', '怎么样', '是什么', '的意思', '是什么意思', '吗', '呢'];

/** 术语匹配：连续中文 run，或 ≥3 字符的英文/数字 run。 */
const TERM_PATTERN = /[\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9_-]{2,}/g;

/** 反复剥掉脚手架前后缀（剩余长度必须 >1 才继续剥）。 */
function stripScaffold(run: string): string {
  let current = run;
  let changed = true;
  while (changed && current.length > 2) {
    changed = false;
    for (const prefix of SCAFFOLD_PREFIXES) {
      if (current.startsWith(prefix) && current.length > prefix.length + 1) {
        current = current.slice(prefix.length);
        changed = true;
      }
    }
    for (const suffix of SCAFFOLD_SUFFIXES) {
      if (current.endsWith(suffix) && current.length > suffix.length + 1) {
        current = current.slice(0, current.length - suffix.length);
        changed = true;
      }
    }
  }
  let start = 0;
  let end = current.length;
  while (start < end && '的的是'.includes(current[start]!)) start += 1;
  while (end > start && '的的是'.includes(current[end - 1]!)) end -= 1;
  return current.slice(start, end);
}

/**
 * 从问题里取出「可以在文献里核对」的候选术语。
 *
 * 顺序固定：先剥脚手架后的**整段**（"什么是信念伦理" → "信念伦理"），
 * 再按「像不像一个词」排（中文实词多在 2–4 字，因此 4 字优先）。纯脚手架（如只问"什么"）
 * 不会产生任何术语，因此不会误命中每一页。
 */
export function queryTerms(query: string, maxTerms = 10): string[] {
  const primary: string[] = [];
  const secondary: string[] = [];
  const runs = (query ?? '').match(TERM_PATTERN) ?? [];
  for (const run of runs) {
    if (/^[\x00-\x7f]/.test(run)) {
      primary.push(run.toLowerCase());
      continue;
    }
    const core = stripScaffold(run);
    if (core.length >= 2 && !QUESTION_STOPWORDS.has(core)) primary.push(core);
    const maxSize = Math.min(8, core.length);
    for (let size = maxSize; size > 1; size -= 1) {
      for (let start = 0; start + size <= core.length; start += 1) {
        const piece = core.slice(start, start + size);
        if (!QUESTION_STOPWORDS.has(piece)) secondary.push(piece);
      }
    }
  }
  const orderedSecondary = [...new Set(secondary)].sort((left, right) => {
    const distance = Math.abs(left.length - 4) - Math.abs(right.length - 4);
    if (distance !== 0) return distance;
    if (left.length !== right.length) return right.length - left.length;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const ordered: string[] = [];
  for (const term of [...primary, ...orderedSecondary]) {
    if (term.length < 2 || QUESTION_STOPWORDS.has(term) || ordered.includes(term)) continue;
    ordered.push(term);
  }
  return ordered.slice(0, maxTerms);
}

/**
 * SQL `LIKE` 的转义口径：`%`、`_`、`\` 都当普通字符。
 *
 * 本模块在 JS 里做子串比对，因此这里转义只是把术语还原成「字面量」的显式记录；
 * 它保证含 `%`/`_` 的术语（例如 "50%"）不会被当成通配符而命中每一页。
 */
export function escapeLike(term: string): string {
  return (term ?? '').replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * 逐字子串匹配，等价于 SQL `LIKE '%term%' ESCAPE '\'`：
 * 只做字面量包含，`%` 与 `_` 没有通配含义；对齐 SQLite LIKE 的 ASCII 大小写不敏感。
 */
export function likeContains(text: string, term: string): boolean {
  if (!text || !term) return false;
  return text.toLowerCase().includes(term.toLowerCase());
}

export interface SearchableTextState {
  /** 已索引的正文片段（chunks）数量。 */
  chunks: number;
  /** 整页 OCR 与用户校订（page_edits）里非空文本的页数。 */
  pageEdits: number;
  /** 本机到底有没有可检索的文字：两个来源都为空才算「没有」。 */
  hasText: boolean;
}

/**
 * 这篇文献现在有多少可检索的文字。
 *
 * 扫描件的文字来自整页 OCR 与用户校订，它们保存在 `page_edits` 而不是 `chunks` 里；
 * 只查 chunks 会让扫描文献「看起来没有内容」，于是文献里确实有的概念被判成与文献无关。
 */
export function searchableTextState(store: Store, documentId: string): SearchableTextState {
  const chunks = store.listChunks(documentId).length;
  const edits = pageEditTexts(store, documentId);
  return { chunks, pageEdits: edits.length, hasText: chunks > 0 || edits.length > 0 };
}

/** 逐页读整页文本（OCR/校订）。`page_edits` 没有批量读接口，因此按页点查。 */
function pageEditTexts(store: Store, documentId: string): string[] {
  const document = store.getDocument(documentId);
  const pages = document?.pages ?? 0;
  const texts: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const text = store.getPageEdit(documentId, page)?.text?.trim();
    if (text) texts.push(text);
  }
  return texts;
}

export interface DocumentMentionGuard extends SearchableTextState {
  /** 本轮用于核对的问题术语（顺序与 `queryTerms` 一致）。 */
  terms: string[];
  /** 真的在本文献里出现的术语。 */
  matched: string[];
  /** 是否至少有一个术语出现在本文献里。 */
  hit: boolean;
}

/**
 * 问题里的术语是否真的出现在这篇文献里。
 *
 * 只要命中一个术语，这一轮就必须读文献——宁可多读一次，也不能把文献里的内容说成与文献无关。
 * 命中索引片段时不再扫描整页文本（`pageEdits` 记为 0，`hasText` 已因 chunks 为真）；
 * 未命中时才扫 `page_edits`，这样扫描件的文字也能参与核对。
 */
export function documentMentions(
  store: Store,
  documentId: string,
  query: string
): DocumentMentionGuard {
  const terms = queryTerms(query);
  const chunks = store.listChunks(documentId);
  const matched: string[] = [];
  if (terms.length > 0) {
    for (const term of terms) {
      if (chunks.some((chunk) => likeContains(chunk.text, term))) matched.push(term);
    }
  }
  if (matched.length > 0) {
    return {
      terms,
      matched,
      hit: true,
      chunks: chunks.length,
      pageEdits: 0,
      hasText: true
    };
  }
  const edits = pageEditTexts(store, documentId);
  for (const term of terms) {
    if (edits.some((text) => likeContains(text, term))) matched.push(term);
  }
  return {
    terms,
    matched,
    hit: matched.length > 0,
    chunks: chunks.length,
    pageEdits: edits.length,
    hasText: chunks.length > 0 || edits.length > 0
  };
}
