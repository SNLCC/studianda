import { createHash } from 'node:crypto';

export const COVERAGE_STATES = {
  FOUND: 'FOUND',
  NOT_FOUND_IN_BATCH: 'NOT_FOUND_IN_BATCH',
  NOT_FOUND_IN_READ_SCOPE: 'NOT_FOUND_IN_READ_SCOPE',
  NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH: 'NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH',
  NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW: 'NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW',
  UNCERTAIN: 'UNCERTAIN',
  UNREADABLE: 'UNREADABLE',
  NOT_SEARCHABLE: 'NOT_SEARCHABLE',
  NOT_RECORDED: 'NOT_RECORDED'
} as const;

export type CoverageState = (typeof COVERAGE_STATES)[keyof typeof COVERAGE_STATES];

export const DEFAULT_DIMENSIONS: Array<{ code: string; label: string }> = [
  { code: 'D1', label: '概念界定' },
  { code: 'D2', label: '理论依据' },
  { code: 'D3', label: '限定条件' },
  { code: 'D4', label: '反例或异议' },
  { code: 'D5', label: '作者最终立场' },
  { code: 'D6', label: '后文修正' }
];

const STRENGTH: Partial<Record<CoverageState, number>> = {
  NOT_FOUND_IN_BATCH: 0,
  UNCERTAIN: 1,
  NOT_FOUND_IN_READ_SCOPE: 1,
  NOT_SEARCHABLE: 2,
  UNREADABLE: 2,
  NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH: 3,
  NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW: 4
};

export function canonicalQuote(quote: string): string {
  return (quote ?? '').replace(/\s+/g, '');
}

export function evidenceKey(documentId: string, page: number, quote: string): string {
  return createHash('sha256')
    .update(`${documentId}\u001f${page}\u001f${canonicalQuote(quote)}`)
    .digest('hex')
    .slice(0, 16);
}

export function dimensionCodes(dimensions: Array<{ code: string; label: string }>): string[] {
  return dimensions.map((dimension) => dimension.code);
}

export interface CoverageEvidence {
  evidence_key?: string;
  quote?: string;
  dimension?: string;
  page?: number;
}

export function batchHits(
  codes: string[],
  evidence: CoverageEvidence[] = [],
  reported: string[] = []
): { states: Record<string, CoverageState>; hits: Record<string, string[]> } {
  const hits: Record<string, string[]> = {};
  for (const code of codes) hits[code] = [];
  for (const item of evidence) {
    const code = item.dimension;
    if (code && hits[code]) {
      hits[code]!.push(item.evidence_key ?? item.quote ?? '');
    }
  }
  let attributed = false;
  for (const code of reported) {
    if (!hits[code] || hits[code]!.length > 0) continue;
    if (!attributed) {
      const keys = evidence.map((item) => item.evidence_key ?? item.quote ?? '');
      if (keys.length === 0) break;
      attributed = true;
    }
    hits[code] = evidence.map((item) => item.evidence_key ?? item.quote ?? '');
  }
  const states: Record<string, CoverageState> = {};
  for (const code of codes) {
    states[code] = hits[code]!.length > 0
      ? COVERAGE_STATES.FOUND
      : COVERAGE_STATES.NOT_FOUND_IN_BATCH;
  }
  return { states, hits };
}

export function mergeBatchCoverage(
  reports: Array<Record<string, CoverageState>>
): Record<string, CoverageState> {
  const merged: Record<string, CoverageState> = {};
  for (const report of reports) {
    for (const [code, state] of Object.entries(report)) {
      const current = merged[code];
      if (current === COVERAGE_STATES.FOUND || state === COVERAGE_STATES.FOUND) {
        merged[code] = COVERAGE_STATES.FOUND;
        continue;
      }
      if (current === undefined || (STRENGTH[state] ?? 0) > (STRENGTH[current] ?? 0)) {
        merged[code] = state;
      }
    }
  }
  return merged;
}

export interface ReadingCoverage {
  dimensions: string[];
  batch_reports: Array<Record<string, CoverageState>>;
  batches: number;
  recorded_batches: number;
  hits: string[];
  states: Record<string, CoverageState>;
  evidence: Record<string, string[]>;
  evidence_pages: Record<string, number>;
}

export interface CoverageLedgerRow {
  dimension: string;
  label: string;
  status: CoverageState;
  evidence: string[];
  unreadable_pages?: number[];
  reason?: string;
  reviewed_pages?: number;
  gap_search_pages?: number[];
}

export function coverageLedger(
  dimensions: Array<{ code: string; label: string }>,
  batchStates: Array<Record<string, CoverageState>>,
  options: {
    evidenceByDimension?: Record<string, string[]>;
    readablePages?: number[];
    unreadablePages?: number[];
    notSearchable?: boolean;
    searchedFullDocument?: boolean;
    gapSearchRan?: boolean;
    examinedScopeComplete?: boolean;
    evidencePages?: Record<string, number>;
    gapSearchSearched?: boolean;
    gapSearchPages?: number[];
    gapSearchPagesByDimension?: Record<string, number[]>;
  } = {}
): CoverageLedgerRow[] {
  const evidenceByDimension = options.evidenceByDimension ?? {};
  const evidencePages = options.evidencePages ?? {};
  const searched =
    options.gapSearchSearched === undefined
      ? Boolean(options.gapSearchRan)
      : Boolean(options.gapSearchSearched);
  const states = mergeBatchCoverage(batchStates);
  const examinedComplete = options.examinedScopeComplete ?? true;
  const unreadable = [...new Set(options.unreadablePages ?? [])].sort((a, b) => a - b);
  const unreadableSet = new Set(unreadable);
  return dimensions.map(({ code, label }) => {
    const dimensionGapPages =
      options.gapSearchPagesByDimension?.[code] ?? options.gapSearchPages ?? [];
    let state = states[code] ?? COVERAGE_STATES.NOT_FOUND_IN_BATCH;
    const keys = [...new Set(evidenceByDimension[code] ?? [])];
    // 覆盖账本只看**已知页码**的证据；不知道页码的
    // key 不参与 all()，因此全都没有页码时会被视为“无法确认是否落在可读页”。
    const knownEvidencePages = keys
      .map((key) => evidencePages[key])
      .filter((page): page is number => page !== undefined);
    const evidenceOnlyOnUnreadable =
      keys.length > 0 &&
      knownEvidencePages.every((page) => unreadableSet.has(page));
    if ((state === COVERAGE_STATES.FOUND || keys.length > 0) && !evidenceOnlyOnUnreadable) {
      state = COVERAGE_STATES.FOUND;
    } else if (evidenceOnlyOnUnreadable) {
      state = COVERAGE_STATES.UNCERTAIN;
    } else if (!examinedComplete) {
      state = COVERAGE_STATES.NOT_FOUND_IN_BATCH;
    } else if (options.notSearchable) {
      state = COVERAGE_STATES.NOT_SEARCHABLE;
    } else if (options.searchedFullDocument && unreadable.length > 0) {
      state = COVERAGE_STATES.UNCERTAIN;
    } else if (options.searchedFullDocument && options.gapSearchRan) {
      state = COVERAGE_STATES.NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW;
    } else if (searched) {
      state = COVERAGE_STATES.NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH;
    } else if (options.searchedFullDocument && examinedComplete) {
      state = COVERAGE_STATES.NOT_FOUND_IN_READ_SCOPE;
    }
    // 缺口检索在其他页命中，但没有形成可核验证据：不能直接判“未讨论”。
    if (
      (dimensionGapPages.length > 0) &&
      !options.searchedFullDocument &&
      keys.length === 0 &&
      (state === COVERAGE_STATES.NOT_FOUND_IN_BATCH ||
        state === COVERAGE_STATES.NOT_FOUND_IN_READ_SCOPE ||
        state === COVERAGE_STATES.NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH)
    ) {
      state = COVERAGE_STATES.UNCERTAIN;
    }
    const row: CoverageLedgerRow = { dimension: code, label, status: state, evidence: keys };
    if ((dimensionGapPages.length > 0)) {
      row.gap_search_pages = dimensionGapPages;
      if (row.status === COVERAGE_STATES.UNCERTAIN && !row.reason) {
        row.reason = '缺口检索命中相关页，但尚未形成可核验的逐字证据。';
      }
    }
    const unreadableStates: CoverageState[] = [
      COVERAGE_STATES.UNCERTAIN,
      COVERAGE_STATES.NOT_FOUND_IN_READ_SCOPE,
      COVERAGE_STATES.NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH,
      COVERAGE_STATES.NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW,
      COVERAGE_STATES.NOT_SEARCHABLE
    ];
    if (unreadable.length > 0 && unreadableStates.includes(state)) {
      row.unreadable_pages = unreadable;
    }
    if (keys.length > 0 && evidenceOnlyOnUnreadable) {
      row.reason = '支撑这一项的原文所在页读不了，因此不能确认这一项是否被讨论过。';
    }
    if (options.readablePages !== undefined) {
      row.reviewed_pages = options.readablePages.length;
    }
    return row;
  });
}

export function unrecordedLedger(
  dimensions: Array<{ code: string; label: string }>,
  reason = ''
): CoverageLedgerRow[] {
  return dimensions.map(({ code, label }) => ({
    dimension: code,
    label,
    status: COVERAGE_STATES.NOT_RECORDED,
    evidence: [],
    reason
  }));
}

/** 给报告一行摘要（总数/各状态计数/读不了的页）。 */
export function ledgerSummary(
  ledger: CoverageLedgerRow[]
): { total: number; by_status: Record<string, number>; unreadable_pages: number[] } {
  const byStatus: Record<string, number> = {};
  const unreadable = new Set<number>();
  for (const row of ledger ?? []) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    for (const page of row.unreadable_pages ?? []) unreadable.add(page);
  }
  return {
    total: ledger?.length ?? 0,
    by_status: byStatus,
    unreadable_pages: [...unreadable].sort((left, right) => left - right)
  };
}


export function readingCoverage(
  findings: Array<{
    evidence?: CoverageEvidence[];
    dimension_hits?: string[];
    dimension_reported?: boolean;
  }>,
  dimensions: Array<{ code: string; label: string }>
): ReadingCoverage | Record<string, never> {
  const codes = dimensionCodes(dimensions);
  if (codes.length === 0 || findings.length === 0) return {};
  const reports: Array<Record<string, CoverageState>> = [];
  const evidence: Record<string, string[]> = {};
  for (const code of codes) evidence[code] = [];
  let recorded = 0;
  const hitsUnion: string[] = [];
  const evidencePages: Record<string, number> = {};
  for (const finding of findings) {
    const { states, hits } = batchHits(codes, finding.evidence ?? [], finding.dimension_hits ?? []);
    reports.push(states);
    if (finding.dimension_reported) recorded += 1;
    for (const code of finding.dimension_hits ?? []) {
      if (codes.includes(code) && !hitsUnion.includes(code)) hitsUnion.push(code);
    }
    for (const code of codes) evidence[code]!.push(...(hits[code] ?? []));
    for (const item of finding.evidence ?? []) {
      if (item.evidence_key && Number.isInteger(item.page)) {
        evidencePages[item.evidence_key] = item.page!;
      }
    }
  }
  return {
    dimensions: codes,
    batch_reports: reports,
    batches: findings.length,
    recorded_batches: recorded,
    hits: hitsUnion,
    states: mergeBatchCoverage(reports),
    evidence: Object.fromEntries(
      Object.entries(evidence).map(([code, keys]) => [code, [...new Set(keys)]])
    ),
    evidence_pages: evidencePages
  };
}

export type Answerability =
  | 'SUFFICIENT'
  | 'PARTIAL'
  | 'MENTION_ONLY'
  | 'ABSENT'
  | 'UNCERTAIN';

/** 从证据里取出角色列表（顺序即证据顺序）。 */
export function evidenceRoles(
  evidence: Array<{ role?: string }> | undefined
): string[] {
  return (evidence ?? [])
    .map((item) => item.role)
    .filter((role): role is string => typeof role === 'string' && role.length > 0);
}

/**
 * **只根据已核验证据的角色**判断
 * “这篇文献对这个问题答到什么程度”，不猜作者意图，也不让外部资料改判。
 *
 * - 没有任何证据 → ABSENT；本轮没有查全（searched=false）时退到 UNCERTAIN；
 * - 只有 MENTION → MENTION_ONLY；
 * - 有 DEFINITION / EXPLANATION → SUFFICIENT；
 * - 其余（CHARACTERIZATION/EXAMPLE/CONTRAST/CRITIQUE/QUALIFICATION）→ PARTIAL。
 *
 * CONFLICTING 需要跨证据语义比较，本轮刻意不猜。
 */
export function documentAnswerability(
  roles: string[] | undefined,
  searched = true
): Answerability {
  const counts = new Map<string, number>();
  for (const role of roles ?? []) {
    if (typeof role !== 'string' || !role) continue;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  if (counts.size === 0) return searched ? 'ABSENT' : 'UNCERTAIN';
  if (counts.size === 1 && counts.has('MENTION')) return 'MENTION_ONLY';
  if ((counts.get('DEFINITION') ?? 0) > 0 || (counts.get('EXPLANATION') ?? 0) > 0) {
    return 'SUFFICIENT';
  }
  return 'PARTIAL';
}


