import { activeTokenizerCount } from './tokenizer.js';

export interface ReadingSource {
  document_id: string;
  page: number;
  name: string;
  text: string;
  [key: string]: unknown;
}

const FALLBACK_CJK = 1.5;

/** CJK 1.5 token/字，其余 1 token/字符，+1。 */
export function fallbackCost(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  const chars = [...text];
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    }
  }
  return Math.floor(cjk * FALLBACK_CJK) + (chars.length - cjk) + 1;
}

export function cost(text: string): number {
  // 导入了匹配的 tokenizer 时按精确 token 计数；否则退回保守估算。
  return activeTokenizerCount(text) ?? fallbackCost(text);
}

export function sourceText(source: ReadingSource, index: number): string {
  return `[${index}] ${source.name} 第${source.page}页\n${source.text}`;
}

const ANALYSIS_LIMIT = 400;
export const SUPPORT_ROLES = [
  'DEFINITION',
  'EXPLANATION',
  'CHARACTERIZATION',
  'EXAMPLE',
  'CONTRAST',
  'MENTION',
  'CRITIQUE',
  'QUALIFICATION'
] as const;

export interface EvidenceRecord {
  source: number;
  quote: string;
  evidence_key?: string;
  documentId?: string;
  page?: number;
  dimension?: string;
  role?: string;
}

export interface VerifiedFindings {
  analysis: string;
  evidence: EvidenceRecord[];
  no_relevant_evidence: boolean;
  dimension_hits?: string[];
  dimension_reported?: boolean;
  quotes_rejected?: Array<{ reason: string; quote: string }>;
}

export interface ReadingFault {
  reason: string;
  hint: string;
  quote: string;
}

export class ReadingError extends Error {
  readonly repair: string;
  readonly quote: string;
  readonly faults: ReadingFault[];
  readonly fingerprint: string;
  readonly foreign: [number, string] | null;

  constructor(
    message: string,
    options: {
      repair?: string;
      quote?: string;
      faults?: ReadingFault[];
      fingerprint?: string;
      foreign?: [number, string] | null;
    } = {}
  ) {
    super(message);
    this.name = 'ReadingError';
    this.repair = options.repair ?? '';
    this.quote = options.quote ?? '';
    this.faults = options.faults ?? [];
    this.fingerprint = options.fingerprint ?? '';
    this.foreign = options.foreign ?? null;
  }

  diagnosis(limit = 3): string {
    if (this.foreign) {
      return `模型引的是第 ${this.foreign[0]} 页的原文，而那一页本轮没有被读到：“${this.foreign[1].slice(0, 60)}”`;
    }
    if (!this.quote && this.faults.length === 0) return '';
    if (this.faults.length === 0) return `模型写的那句摘引：“${this.quote.slice(0, 80)}”`;
    const text = this.faults
      .slice(0, limit)
      .map((fault) => `“${fault.quote.slice(0, 80)}”（${fault.reason}）`)
      .join('；');
    return text ? `模型自己写的那句摘引：${text}` : '';
  }
}

function normalizeWhitespace(text: string): { chars: string; positions: number[] } {
  const chars: string[] = [];
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) continue;
    chars.push(char);
    positions.push(index);
  }
  return { chars: chars.join(''), positions };
}

/** 只忽略排版空白，返回原文里的精确片段。 */
export function originalQuote(quote: string, text: string): string | null {
  if (text.includes(quote)) return quote;
  const needle = normalizeWhitespace(quote).chars;
  if (!needle) return null;
  const haystack = normalizeWhitespace(text);
  const index = haystack.chars.indexOf(needle);
  if (index < 0) return null;
  const start = haystack.positions[index]!;
  const end = haystack.positions[index + needle.length - 1]! + 1;
  return text.slice(start, end);
}

function jsonObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
  return value as Record<string, unknown>;
}

/** 只在重试时使用的保守 JSON 抢救；不做内容猜测。 */
export function salvageObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  let body = text.trim().replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 继续尝试截取最外层对象
  }
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return null;
  const candidate = body.slice(start, end + 1);
  for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 继续下一个修复候选
    }
  }
  return null;
}

function quoteLocation(quote: string, sources: ReadingSource[]): number | null {
  for (let index = 0; index < sources.length; index += 1) {
    if (originalQuote(quote, sources[index]!.text) !== null) return index + 1;
  }
  return null;
}

function evidenceFault(
  item: unknown,
  allowed: Set<number>,
  sources: ReadingSource[]
): ReadingFault | [string, string, string] | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return [
      '证据不是对象',
      'evidence 的每一项都要是 {"source":编号,"quote":"逐字原文"}',
      ''
    ];
  }
  const value = item as { source?: unknown; quote?: unknown };
  const sourceNumber = value.source;
  const quote = typeof value.quote === 'string' ? value.quote : '';
  const raw = typeof value.quote === 'string' ? value.quote.slice(0, 200) : '';
  if (
    typeof sourceNumber !== 'number' ||
    !Number.isInteger(sourceNumber) ||
    !allowed.has(sourceNumber)
  ) {
    return [
      `证据编号 ${String(sourceNumber)} 不在本批编号内`,
      `只能使用本批编号 ${[...allowed].sort((a, b) => a - b).join(', ')}；请照抄 material 里 [编号] 的方括号数字`,
      raw
    ];
  }
  if (!quote.trim()) return ['摘引为空', 'quote 必须是原文里逐字存在的一句话', ''];
  if (quote.length > 1500) {
    return ['摘引超过 1500 字', '只摘最能支持分析的连续原文，不要整段复述', raw];
  }
  const source = sources[sourceNumber - 1];
  if (source && originalQuote(quote, source.text) !== null) return null;
  const found = quoteLocation(quote, sources);
  if (found !== null) {
    return [
      `摘引不属于 [${sourceNumber}]（它逐字出现在 [${found}]）`,
      `把 source 改成 ${found}，或改引 [${sourceNumber}] 里真实存在的句子`,
      ''
    ];
  }
  return [
    '摘引在原文里找不到（可能是改写或翻译）',
    '只复制 material 里出现过的连续原文，一字不改、不翻译、不补全',
    raw
  ];
}

export interface VerifiedFindingsOptions {
  repair?: boolean;
  salvage?: boolean;
  dimensions?: Array<{ code: string; label: string }>;
  locate?: (quote: string) => number | null;
}

/** 只做逐字成员核验，不做语义核验。 */
export function verifiedFindings(
  text: string,
  allowed: Set<number>,
  sources: ReadingSource[],
  options: VerifiedFindingsOptions = {}
): VerifiedFindings {
  let obj: Record<string, unknown>;
  try {
    obj = jsonObject(text);
  } catch {
    const salvaged = options.repair ? salvageObject(text) : null;
    if (!salvaged) {
      throw new ReadingError('返回的不是一个 JSON 对象', {
        repair:
          `必须只返回一个 JSON 对象：{"analysis":"不超过 ${ANALYSIS_LIMIT} 字","evidence":[{"source":本批编号,"quote":"逐字原文"}],"no_relevant_evidence":false}。` +
          '不要加解释文字、不要用代码围栏、不要多包一层',
        fingerprint: (text ?? '').trim().slice(0, 400)
      });
    }
    obj = salvaged;
  }
  const analysis = obj.analysis;
  const evidence = obj.evidence;
  if (
    typeof analysis !== 'string' ||
    analysis.length > ANALYSIS_LIMIT * 2 ||
    !Array.isArray(evidence) ||
    evidence.length > 12
  ) {
    throw new ReadingError('分批阅读结果格式不兼容', {
      repair:
        `必须返回 {"analysis":"不超过 ${ANALYSIS_LIMIT} 字","evidence":[{"source":本批编号,"quote":"逐字原文"}],"no_relevant_evidence":false}；` +
        `字段名与类型照写，不要多包一层；analysis 请压到 ${ANALYSIS_LIMIT} 字以内（只写要点，不要展开分析）`
    });
  }

  const codes = new Set((options.dimensions ?? []).map((dimension) => dimension.code));
  const checked: EvidenceRecord[] = [];
  const faults: Array<[string, string, string]> = [];
  for (const item of evidence) {
    const fault = evidenceFault(item, allowed, sources);
    if (fault) {
      faults.push(Array.isArray(fault) ? fault : [fault.reason, fault.hint, fault.quote]);
      continue;
    }
    const value = item as { source: number; quote: string; dimension?: unknown; role?: unknown };
    const source = sources[value.source - 1]!;
    const quote = originalQuote(value.quote, source.text) ?? value.quote;
    const record: EvidenceRecord = { source: value.source, quote };
    if (source.document_id != null) record.documentId = source.document_id;
    if (source.document_id != null && source.page != null) {
      record.evidence_key = `${source.document_id}:${source.page}:${normalizeWhitespace(quote).chars}`;
      if (Number.isInteger(source.page)) record.page = source.page;
    }
    if (typeof value.dimension === 'string' && codes.has(value.dimension)) {
      record.dimension = value.dimension;
    }
    if (typeof value.role === 'string' && SUPPORT_ROLES.includes(value.role as (typeof SUPPORT_ROLES)[number])) {
      record.role = value.role;
    }
    checked.push(record);
  }

  if (faults.length > 0) {
    let foreign: [number, string] | null = null;
    if (options.locate) {
      for (const [reason, hint, raw] of faults) {
        if (!raw) continue;
        const page = options.locate(raw);
        if (page != null) {
          foreign = [page, raw];
          void reason;
          void hint;
          break;
        }
      }
    }
    const faultRows: ReadingFault[] = faults.map(([reason, hint, raw]) => ({
      reason:
        foreign && raw === foreign[1] ? `${reason}（这一句写在第 ${foreign[0]} 页）` : reason,
      hint,
      quote: raw
    }));
    if (options.salvage && !foreign) {
      return {
        analysis,
        evidence: checked,
        no_relevant_evidence: checked.length === 0,
        quotes_rejected: faultRows.map((fault) => ({ reason: fault.reason, quote: fault.quote }))
      };
    }
    throw new ReadingError('证据无法在原文中核验', {
      repair:
        `上一次返回里有 ${faultRows.length} 条摘引没有通过核对，逐条修正后**重新返回完整的 JSON**：\n` +
        faultRows
          .map(
            (fault, index) =>
              `${index + 1}. 你写的摘引：“${fault.quote}”\n   原因：${fault.reason}\n   怎么改：${fault.hint}`
          )
          .join('\n'),
      quote: faults[0]?.[2] ?? '',
      faults: faultRows,
      fingerprint: text.trim().slice(0, 400),
      foreign
    });
  }

  if (checked.length === 0 && obj.no_relevant_evidence !== true) {
    throw new ReadingError('阅读记录缺少证据或明确的无相关证据说明', {
      repair:
        '本批确实与问题无关时必须显式返回 "no_relevant_evidence": true；否则请给出本批的逐字摘引'
    });
  }

  const result: VerifiedFindings = {
    analysis,
    evidence: checked,
    no_relevant_evidence: checked.length === 0
  };
  if (codes.size > 0) {
    const reported = obj.dimension_hits;
    result.dimension_hits = Array.isArray(reported)
      ? reported.filter((code): code is string => typeof code === 'string' && codes.has(code))
      : [];
    result.dimension_reported = Array.isArray(reported);
  }
  return result;
}


export function splitSources(sources: ReadingSource[], budget: number): ReadingSource[] {
  if (budget < 512) throw new Error('上下文预算不足，请增加模型容量或减少历史对话');
  const result: ReadingSource[] = [];
  for (const row of sources) {
    const text = row.text;
    let offset = 0;
    const available = budget - cost(row.name) - 200;
    if (available < 128) throw new Error('文献标题超出阅读预算');
    while (offset < text.length) {
      let end = Math.min(text.length, offset + available);
      while (cost(text.slice(offset, end)) > available) {
        end = offset + Math.max(1, Math.floor((end - offset) / 2));
      }
      if (end < text.length) {
        const newline = text.lastIndexOf('\n', end - 1);
        if (newline > offset + Math.floor((end - offset) / 2)) end = newline + 1;
      }
      result.push({
        ...row,
        text: text.slice(offset, end),
        offset_start: offset,
        offset_end: end
      });
      offset = end;
    }
  }
  return result;
}

export function batches(
  sources: ReadingSource[],
  budget: number,
  overlap = 0
): Array<Array<[number, ReadingSource]>> {
  if (sources.length === 0) return [];
  if (
    sources.reduce((total, row, index) => total + cost(sourceText(row, index + 1)) + 2, 0) <=
    budget
  ) {
    return [sources.map((row, index) => [index + 1, row] as [number, ReadingSource])];
  }
  const out: Array<Array<[number, ReadingSource]>> = [];
  let current: Array<[number, ReadingSource]> = [];
  let used = 0;
  sources.forEach((row, offset) => {
    const index = offset + 1;
    const size = cost(sourceText(row, index)) + 2;
    if (size > budget) throw new Error('单段原文超过上下文预算');
    const sameDocument = current.length > 0 && current[current.length - 1]![1].document_id === row.document_id;
    if (current.length > 0 && (used + size > budget || !sameDocument)) {
      const carried: Array<[number, ReadingSource]> = [];
      let room = budget - size;
      if (overlap > 0 && sameDocument) {
        const carry = overlap <= current.length ? current.slice(-overlap) : [...current];
        for (const previous of [...carry].reverse()) {
          const carriedSize = cost(sourceText(previous[1], previous[0])) + 2;
          if (carriedSize > room) break;
          carried.unshift(previous);
          room -= carriedSize;
        }
      }
      out.push(current);
      current = carried;
      used = carried.reduce(
        (total, [number, previous]) => total + cost(sourceText(previous, number)) + 2,
        0
      );
    }
    current.push([index, row]);
    used += size;
  });
  if (current.length > 0) out.push(current);
  return out;
}
