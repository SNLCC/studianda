/** 确定性的缺口安全网。 */
export interface SweepReport {
  terms: string[];
  scanned_pages: number;
  hit_pages: number[];
  lexical_hit_pages: number[];
  semantic_hit_pages: number[];
  regions: Array<[number, number]>;
  missing_terms: string[];
  added_pages: number[];
  truncated: number;
  hits: Record<string, string[]>;
}

const normalize = (text: string): string => (text ?? '').replace(/\s+/g, '').toLowerCase();

export function pageHits(
  rows: Array<[number, string]>,
  terms: string[]
): Record<number, string[]> {
  const wanted = [...new Set(terms)].filter((term) => term.trim().length >= 2);
  const hits: Record<number, string[]> = {};
  for (const [page, text] of rows) {
    if (!Number.isInteger(page) || page < 1 || !text) continue;
    const body = normalize(text);
    const matched = wanted.filter((term) => body.includes(normalize(term)));
    if (matched.length > 0) hits[page] = [...new Set(matched)];
  }
  return Object.fromEntries(
    Object.entries(hits)
      .map(([page, terms]) => [Number(page), terms] as const)
      .sort((left, right) => left[0] - right[0])
  );
}

export function mergeRegions(hitPages: number[], gap = 2): Array<[number, number]> {
  const pages = [...new Set(hitPages)].filter((page) => Number.isInteger(page)).sort((a, b) => a - b);
  const blocks: Array<[number, number]> = [];
  for (const page of pages) {
    const last = blocks[blocks.length - 1];
    if (last && page - last[1] - 1 <= gap) last[1] = page;
    else blocks.push([page, page]);
  }
  return blocks;
}

export function regionPages(blocks: Array<[number, number]>): number[] {
  const pages = new Set<number>();
  for (const [start, end] of blocks) {
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function sweepReport(
  rows: Array<[number, string]>,
  terms: string[],
  scope: number[],
  limit = 8,
  gap = 2,
  semanticHits: number[] = []
): SweepReport {
  const wanted = [...new Set(terms)].filter((term) => term.trim().length >= 2);
  const lexical = pageHits(rows, wanted);
  const hitPages = [...new Set([...Object.keys(lexical).map(Number), ...semanticHits])].sort(
    (a, b) => a - b
  );
  const regions = mergeRegions(hitPages, gap);
  const read = new Set(scope);
  const added = regionPages(regions).filter((page) => !read.has(page)).slice(0, limit);
  const allRegionPages = regionPages(regions).filter((page) => !read.has(page));
  const foundTerms = new Set(Object.values(lexical).flat());
  return {
    terms: wanted,
    scanned_pages: new Set(rows.map(([page]) => page)).size,
    hit_pages: hitPages,
    lexical_hit_pages: Object.keys(lexical).map(Number).sort((a, b) => a - b),
    semantic_hit_pages: [...new Set(semanticHits)].sort((a, b) => a - b),
    regions,
    missing_terms: wanted.filter((term) => !foundTerms.has(term)),
    added_pages: added,
    truncated: Math.max(0, allRegionPages.length - added.length),
    hits: Object.fromEntries(
      Object.entries(lexical).map(([page, values]) => [page, values])
    )
  };
}
