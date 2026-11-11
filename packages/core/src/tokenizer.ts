/**
 * 本地 tokenizer.json（BPE）导入与精确 token 计数。
 *
 * 不下载模型、不执行代码：只解析用户导入的 tokenizer.json，在主进程内做 BPE 合并计数。
 * 支持包含 ByteLevel 与 Split 预分词的 BPE tokenizer；不支持的模型类型
 * （WordPiece/Unigram）会明确返回错误，由调用方决定是否退回保守估算。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';

interface TokenizerModel {
  type?: unknown;
  vocab?: unknown;
  merges?: unknown;
}

interface TokenizerJson {
  model?: TokenizerModel;
  pre_tokenizer?: unknown;
  added_tokens?: unknown;
}

/** ByteLevel BPE 的字节到 Unicode 映射（字节级 BPE 词表使用）。 */
function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let code = 0x21; code <= 0x7e; code += 1) bs.push(code);
  for (let code = 0xa1; code <= 0xac; code += 1) bs.push(code);
  for (let code = 0xae; code <= 0xff; code += 1) bs.push(code);
  const cs = [...bs];
  let n = 0;
  for (let code = 0; code < 256; code += 1) {
    if (!bs.includes(code)) {
      bs.push(code);
      cs.push(256 + n);
      n += 1;
    }
  }
  return new Map(bs.map((byte, index) => [byte, String.fromCharCode(cs[index]!)]));
}

const BYTE_ENCODER = bytesToUnicode();
const BYTE_KEYS = [...BYTE_ENCODER.entries()].sort((left, right) => right[0] - left[0]);

function byteEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (const byte of bytes) {
    out += BYTE_ENCODER.get(byte) ?? String.fromCharCode(byte);
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 tokenizer.json 的 pre_tokenizer 配置里取出预分词正则 / 是否 ByteLevel。 */
function readPreTokenizer(config: unknown): { pattern: RegExp; byteLevel: boolean } {
  let byteLevel = false;
  const patterns: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    const type = typeof value.type === 'string' ? value.type : '';
    if (type === 'ByteLevel') byteLevel = true;
    if (type === 'Split' && value.pattern && typeof value.pattern === 'object') {
      const pattern = (value.pattern as Record<string, unknown>).Regex;
      if (typeof pattern === 'string') patterns.push(pattern);
    }
    for (const key of ['pretokenizers', 'pre_tokenizers']) {
      if (Array.isArray(value[key])) for (const child of value[key] as unknown[]) visit(child);
    }
    if (value.pre_tokenizer) visit(value.pre_tokenizer);
  };
  visit(config);
  const raw =
    patterns[0] ??
    "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";
  let source = raw;
  // JS 不支持内联 (?i:...)；拆掉它并把整条正则设为大小写不敏感（影响极小）。
  const caseInsensitive = source.includes('(?i:');
  if (caseInsensitive) source = source.replace(/\(\?i:/g, '(?:');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, caseInsensitive ? 'giu' : 'gu');
  } catch {
    pattern = new RegExp(
      "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+",
      'gu'
    );
  }
  return { pattern, byteLevel };
}

export class BpeTokenizer {
  private readonly ranks = new Map<string, number>();
  private readonly cache = new Map<string, number>();
  private readonly pattern: RegExp;
  private readonly byteLevel: boolean;

  constructor(
    merges: Array<[string, string]>,
    pattern: RegExp,
    byteLevel: boolean
  ) {
    merges.forEach(([left, right], index) => {
      this.ranks.set(`${left}\u0000${right}`, index);
    });
    this.pattern = pattern;
    this.byteLevel = byteLevel;
  }

  /** 解析并校验 tokenizer.json；不支持的结构抛中文错误。 */
  static fromJson(raw: string): BpeTokenizer {
    let parsed: TokenizerJson;
    try {
      parsed = JSON.parse(raw) as TokenizerJson;
    } catch {
      throw new Error('tokenizer.json 不是有效的 JSON');
    }
    const model = parsed?.model;
    if (!model || typeof model !== 'object') {
      throw new Error('tokenizer.json 缺少 model 字段');
    }
    if (model.type !== 'BPE') {
      throw new Error(
        `目前只支持 BPE 类型的 tokenizer.json（这个文件是 ${String(model.type ?? '未知')}）`
      );
    }
    if (!Array.isArray(model.merges)) {
      throw new Error('tokenizer.json 缺少 merges 数组');
    }
    const merges: Array<[string, string]> = [];
    for (const row of model.merges) {
      if (Array.isArray(row) && row.length >= 2) {
        merges.push([String(row[0]), String(row[1])]);
      } else if (typeof row === 'string') {
        const [left, right] = row.split(' ');
        if (left && right) merges.push([left, right]);
      }
    }
    if (merges.length === 0) throw new Error('tokenizer.json 的 merges 为空');
    const { pattern, byteLevel } = readPreTokenizer(parsed.pre_tokenizer);
    return new BpeTokenizer(merges, pattern, byteLevel);
  }

  private symbolsFor(token: string): string[] {
    const encoded = this.byteLevel ? byteEncode(token) : token;
    return [...encoded];
  }

  /** 对一个预分词片段做 BPE 合并，返回 token 数。 */
  private countToken(token: string): number {
    const cached = this.cache.get(token);
    if (cached !== undefined) return cached;
    let symbols = this.symbolsFor(token);
    if (symbols.length === 0) return 0;
    for (;;) {
      let bestRank = Number.POSITIVE_INFINITY;
      let bestIndex = -1;
      for (let index = 0; index < symbols.length - 1; index += 1) {
        const rank = this.ranks.get(`${symbols[index]}\u0000${symbols[index + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) break;
      const merged = symbols[bestIndex]! + symbols[bestIndex + 1]!;
      symbols = [
        ...symbols.slice(0, bestIndex),
        merged,
        ...symbols.slice(bestIndex + 2)
      ];
    }
    const count = symbols.length;
    if (this.cache.size < 50_000) this.cache.set(token, count);
    return count;
  }

  count(text: string): number {
    const source = text ?? '';
    if (!source) return 0;
    let total = 0;
    this.pattern.lastIndex = 0;
    for (const match of source.matchAll(this.pattern)) {
      total += this.countToken(match[0]);
    }
    return total;
  }
}

let activeTokenizer: BpeTokenizer | null = null;

/** 当前生效的 tokenizer（导入/启动加载后生效）。 */
export function activeTokenizerCount(text: string): number | null {
  return activeTokenizer ? activeTokenizer.count(text) : null;
}

export function setActiveTokenizer(tokenizer: BpeTokenizer | null): void {
  activeTokenizer = tokenizer;
}

export function hasActiveTokenizer(): boolean {
  return activeTokenizer !== null;
}

/** 导入校验：只解析，不落盘（调用方负责保存文件与更新设置）。 */
export function parseTokenizer(raw: string): BpeTokenizer {
  const tokenizer = BpeTokenizer.fromJson(raw);
  // 用一段中英混排做冒烟编码，确认 merges 与预分词能配合工作。
  const sample = 'Tokenizer 测试 sample text 123';
  if (tokenizer.count(sample) <= 0) {
    throw new Error('tokenizer.json 解析成功但无法编码，文件可能不完整');
  }
  return tokenizer;
}

/** 供测试/调试：导出合并规则数量。 */
export function tokenizerMergeCount(tokenizer: BpeTokenizer): number {
  return (tokenizer as unknown as { ranks: Map<string, number> }).ranks.size;
}

/* ------------------------------------------------------------------------- *
 * 本地持久化：数据目录/tokenizers/<sha256>.json，设置里只存 id
 * ------------------------------------------------------------------------- */

const TOKENIZER_KEY = 'model.tokenizer_id';
const MAX_TOKENIZER_BYTES = 32 * 1024 * 1024;

function tokenizerDir(dataDir: string): string {
  return path.join(dataDir, 'tokenizers');
}

function tokenizerPath(dataDir: string, id: string): string {
  return path.join(tokenizerDir(dataDir), `${id}.json`);
}

export function tokenizerStatus(store: Store): {
  configured: boolean;
  tokenizer_id: string;
  message: string;
} {
  const id = store.getSettings()[TOKENIZER_KEY]?.trim() ?? '';
  if (!id) {
    return {
      configured: false,
      tokenizer_id: '',
      message: '未导入 tokenizer，预算按保守估算（字符/词混合）。'
    };
  }
  const exists = existsSync(tokenizerPath(store.dataDir, id));
  return {
    configured: exists,
    tokenizer_id: id,
    message: exists
      ? '已导入本地 tokenizer，预算按精确 token 计数。'
      : '设置里的 tokenizer 文件不存在；预算已退回保守估算。'
  };
}

/** 导入 tokenizer.json（base64 或原始文本），校验后落盘并立即生效。 */
export function importTokenizer(
  store: Store,
  input: { data?: string; text?: string }
): { tokenizer_id: string; message: string } {
  let raw: Buffer;
  if (typeof input.text === 'string' && input.text.trim()) {
    raw = Buffer.from(input.text, 'utf8');
  } else if (typeof input.data === 'string' && input.data.trim()) {
    raw = Buffer.from(input.data, 'base64');
  } else {
    throw new Error('需要 tokenizer.json 内容');
  }
  if (raw.byteLength === 0) throw new Error('tokenizer.json 为空');
  if (raw.byteLength > MAX_TOKENIZER_BYTES) {
    throw new Error('tokenizer 文件不能超过 32 MB');
  }
  const text = raw.toString('utf8');
  const tokenizer = parseTokenizer(text);
  const id = createHash('sha256').update(raw).digest('hex');
  mkdirSync(tokenizerDir(store.dataDir), { recursive: true });
  writeFileSync(tokenizerPath(store.dataDir, id), raw);
  store.updateSettings({ [TOKENIZER_KEY]: id });
  setActiveTokenizer(tokenizer);
  return {
    tokenizer_id: id,
    message: '已导入本地 tokenizer 并保存；请确认它与当前模型匹配。'
  };
}

/** 启动时加载已导入的 tokenizer；失败只退回估算，不影响应用启动。 */
export function loadActiveTokenizer(store: Store): void {
  const id = store.getSettings()[TOKENIZER_KEY]?.trim() ?? '';
  if (!id) {
    setActiveTokenizer(null);
    return;
  }
  try {
    const raw = readFileSync(tokenizerPath(store.dataDir, id), 'utf8');
    setActiveTokenizer(parseTokenizer(raw));
  } catch {
    setActiveTokenizer(null);
  }
}
