export const CONTRAST_MARKERS = [
  '然而',
  '但是',
  '但',
  '不过',
  '相反',
  '反之',
  '另一方面',
  '尽管如此',
  '话虽如此',
  '未必',
  '并不',
  '并非',
  '例外',
  '反例',
  '反证',
  '质疑',
  '批评',
  '批判',
  '反驳',
  '修正',
  '更正',
  '更正为',
  '修正为',
  '有待商榷',
  '值得商榷',
  '局限',
  '限定',
  '前提是',
  '仅在',
  '只能',
  'however',
  'although',
  'though',
  'nevertheless',
  'nonetheless',
  'on the contrary',
  'conversely',
  'in contrast',
  'exception',
  'counterexample',
  'counter-example',
  'qualification',
  'qualifies',
  'criticism',
  'critique',
  'objection',
  'rebuttal',
  'revise',
  'revised',
  'correction',
  'erratum',
  'does not',
  'cannot',
  'fails to',
  'only when',
  'only if'
] as const;

const WEAK_MARKERS = new Set(['但', '不过', 'does not', 'cannot']);
const DEFAULT_LIMIT = 8;

function normalize(text: string): string {
  return (text ?? '').replace(/\s+/g, '').toLowerCase();
}

export function markersIn(text: string, strongOnly = false): string[] {
  const body = normalize(text);
  if (!body) return [];
  return CONTRAST_MARKERS.filter(
    (marker) =>
      (!strongOnly || !WEAK_MARKERS.has(marker)) && body.includes(normalize(marker))
  );
}

export function contrastPages(
  rows: Array<[number, string]>,
  limit = DEFAULT_LIMIT
): Record<number, string[]> {
  const hits: Record<number, string[]> = {};
  for (const [page, text] of rows ?? []) {
    if (!Number.isInteger(page) || page < 1 || !text) continue;
    const strong = markersIn(text, true);
    if (strong.length > 0) hits[page] = strong;
  }
  const ordered = Object.fromEntries(
    Object.entries(hits).sort(([left], [right]) => Number(left) - Number(right))
  ) as Record<number, string[]>;
  if (limit > 0 && Object.keys(ordered).length > limit) {
    return Object.fromEntries(Object.entries(ordered).slice(0, limit)) as Record<number, string[]>;
  }
  return ordered;
}

export function counterSentences(text: string, limit = 3, size = 200): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const sentence of text.split(/[。！？；\n]|(?<=[.!?;])\s+/)) {
    const cleaned = (sentence ?? '').trim();
    if (cleaned.length < 8) continue;
    if (markersIn(cleaned, true).length > 0) out.push(cleaned.slice(0, size));
    if (out.length >= limit) break;
  }
  return out;
}

export interface FalsificationReport {
  source: string;
  queries: string[];
  scanned_pages: number;
  contrast_pages: number[];
  semantic_pages: number[];
  marked_pages: number[];
  added_pages: number[];
  evidence: Record<string, string[]>;
  truncated: number;
  note: string;
}

export function oppositeQueries(
  terms: string[],
  original: string,
  limit = 3
): string[] {
  const base: string[] = [];
  for (const term of [...(terms ?? []), original]) {
    if (typeof term === 'string' && term.trim().length >= 2 && !base.includes(term.trim())) {
      base.push(term.trim());
    }
  }
  const out: string[] = [];
  for (const term of base.slice(0, limit)) {
    for (const suffix of ['的反面与反例', '的限定条件', '受到的质疑与批评']) {
      const query = term + suffix;
      if (!out.includes(query)) out.push(query);
    }
  }
  return out.slice(0, limit);
}

export function falsificationReport(
  rows: Array<[number, string]>,
  scope: number[],
  extraPages: number[] = [],
  limit = DEFAULT_LIMIT,
  queries: string[] = [],
  note = ''
): FalsificationReport {
  const read = new Set(scope.filter((page) => Number.isInteger(page)));
  const lexical = Object.keys(contrastPages(rows, 0)).map(Number);
  const semantic = [...new Set(extraPages.filter((page) => Number.isInteger(page) && page >= 1))].sort(
    (left, right) => left - right
  );
  const marked = new Set([...lexical, ...semantic]);
  const outside = [...marked].sort((a, b) => a - b).filter((page) => !read.has(page));
  const added = limit ? outside.slice(0, limit) : outside;
  const texts = new Map(rows.filter(([page]) => Number.isInteger(page)));
  const evidence: Record<string, string[]> = {};
  for (const page of [...marked].sort((a, b) => a - b)) {
    const sentences = counterSentences(texts.get(page) ?? '');
    if (sentences.length > 0) evidence[String(page)] = sentences;
  }
  return {
    source: '转折标记 + 反向语义',
    queries: [...new Set(queries.filter((query) => typeof query === 'string' && query.trim()))],
    scanned_pages: texts.size,
    contrast_pages: lexical,
    semantic_pages: semantic,
    marked_pages: [...marked].sort((a, b) => a - b),
    added_pages: added,
    evidence,
    truncated: Math.max(0, outside.length - added.length),
    note
  };
}
