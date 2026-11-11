export interface CitationSupport {
  citations: number;
  verified: number;
  anchor_only: number;
  page_only: number[];
}

export interface CitationSource {
  quotes?: string[];
  anchor?: unknown;
}

export function invalidCitations(answer: string | null, sourceCount: number): number[] {
  const cited = [...(answer ?? '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  return [...new Set(cited.filter((number) => number < 1 || number > sourceCount))].sort(
    (left, right) => left - right
  );
}

export interface CitationBinding {
  index: number;
  line: number;
  quote: string;
}

/** 按段号绑定审计证据，缺证据时退回来源级摘引。 */
export function citationBindings(
  answer: string | null,
  claims: Array<{ claim: number; evidence?: Array<{ source: number; quote: string }> }>,
  sources: CitationSource[],
  limit = 200
): CitationBinding[] {
  const perLine: Record<number, Record<number, string>> = {};
  for (const claim of claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      const sourceNumber = evidence.source;
      const quote = (evidence.quote ?? '').trim();
      if (
        !Number.isInteger(sourceNumber) ||
        sourceNumber < 1 ||
        sourceNumber > sources.length ||
        !quote
      ) {
        continue;
      }
      perLine[claim.claim] ??= {};
      perLine[claim.claim]![sourceNumber] = quote.slice(0, 300);
    }
  }
  const bindings: CitationBinding[] = [];
  let lineNumber = 0;
  for (const line of (answer ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    lineNumber += 1;
    for (const match of line.matchAll(/\[(\d+)\]/g)) {
      if (bindings.length >= limit) return bindings;
      const index = Number(match[1]);
      const lineQuotes = perLine[lineNumber] ?? {};
      const quote = lineQuotes[index] ?? Object.values(lineQuotes)[0] ?? '';
      bindings.push({ index, line: lineNumber, quote });
    }
  }
  return bindings;
}

/** 逐句核对答案里的 `[n]` 引用：统计可用编号，并区分已逐字核验 / 只有锚点 / 只有页码。 */
export function citationSupport(answer: string | null, sources: CitationSource[]): CitationSupport {
  const cited = [...(answer ?? '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  const usable = new Set(
    cited.filter((number) => number >= 1 && number <= sources.length)
  );
  const verified = new Set(
    [...usable].filter((number) => Boolean(sources[number - 1]?.quotes?.length))
  );
  const anchored = new Set(
    [...usable].filter((number) => Boolean(sources[number - 1]?.anchor))
  );
  return {
    citations: cited.length,
    verified: verified.size,
    anchor_only: [...anchored].filter((number) => !verified.has(number)).length,
    page_only: [...usable]
      .filter((number) => !verified.has(number) && !anchored.has(number))
      .sort((left, right) => left - right)
  };
}
