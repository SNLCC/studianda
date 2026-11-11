import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@studianda/shared';
import { answerWithReading } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-round3-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let documentId = '';

const PAGE1 = '第一页：模型对情感主义给出了界定与解释。';
const PAGE2 = '第二页：继续补充历史背景与学术立场的差异。';

function mockModel(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      let content = '文献回答 [1]';
      if (system.includes('READING_BATCH')) {
        const match = /\[(\d+)\][^\n]*\n([^\n]+)/.exec(user);
        content = JSON.stringify({
          analysis: '本批要点：文献给出了界定。',
          evidence: match ? [{ source: Number(match[1]), quote: match[2]!.trim() }] : [],
          no_relevant_evidence: !match
        });
      } else if (system.includes('READING_AUDIT')) {
        content = JSON.stringify({
          claims: [
            {
              claim: 1,
              verdict: 'supported',
              reason: '原文支持',
              claim_type: 'DOCUMENT_INTERPRETATION',
              evidence_standard: 'GROUNDED'
            }
          ]
        });
      } else if (system.includes('READING_REREAD')) {
        content = JSON.stringify({ read: [], reason: '证据足够' });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    })
  );
}

function plan(breadth: 'document' | 'local', pages: number[] = []) {
  return {
    breadth,
    reason: '测试',
    origin: '规则' as const,
    pages,
    queries: [],
    dimensions: [{ code: 'D1', label: '概念界定' }]
  };
}

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`p${index + 1}`, { x: 20, y: 20, size: 8, font });
  }
  const file = path.join(dataDir, 'round3.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file, undefined, true);
  documentId = imported.id;
  store.savePageTextEdit(documentId, 1, PAGE1);
  store.savePageTextEdit(documentId, 2, PAGE2);
}, 120_000);

const config = {
  baseUrl: 'https://model.example.com/v1',
  apiKey: 'k-1',
  model: 'chat-model'
};

describe('阅读链路口径残余（单遍 coverage 元数据 / 多批 final_context / 顶层 gap_search）', () => {
  it('单遍：coverage 元数据齐全，final_context 不写；顶层 gap_search 有 ran/added_pages', async () => {
    mockModel();
    const result = (await answerWithReading(
      store,
      secrets,
      config,
      '情感主义',
      '',
      documentId,
      1,
      plan('document'),
      100_000
    )) as ChatResponse;
    expect(result).not.toBeNull();
    const coverage = result.coverage;
    expect(coverage).toBeTruthy();
    // 单遍不写 final_context（单遍为空串，不重复存上下文）。
    expect(coverage?.final_context).toBeUndefined();
    expect(coverage?.coverage_summary?.total).toBeGreaterThan(0);
    expect(coverage?.coverage_note).toContain('单遍完整读取');
    expect(coverage?.characters).toBeGreaterThan(0);
    expect(coverage?.context_window).toBeGreaterThan(0);
    expect(coverage?.input_budget).toBeGreaterThan(0);
    expect(typeof coverage?.estimator).toBe('string');
    expect(coverage?.reading_reuse).toContain('复用');
    // 顶层 gap_search：字段齐全且不编造 matched。整篇读完 + 有问题术语时 ran/searched 为真
    // （本机有可搜文字、补读后没有剩余命中页）；sweep 只在 local 跑，因此 hit/added 为空。
    expect(result.gap_search?.searched).toBe(true);
    expect(result.gap_search?.ran).toBe(true);
    expect(result.gap_search?.matched_pages).toEqual([]);
    expect(Array.isArray(result.gap_search?.added_pages)).toBe(true);
    expect(Array.isArray(result.gap_search?.read_pages)).toBe(true);
  }, 120_000);

  it('多批：coverage.final_context 记录实际送入的综合材料', async () => {
    mockModel();
    // 首行短（作为批次摘引，token 成本小、能留在证据银行里），后面多行填充让整页成本超预算。
    const filler = '补充材料。'.repeat(80);
    store.savePageTextEdit(documentId, 1, `第一页：模型界定。\n${filler}`);
    store.savePageTextEdit(documentId, 2, `第二页：继续补充。\n${filler}`);
    try {
      // 预算 700：两页合计远超预算→多批；证据银行只装短摘引，能走到综合并写入 final_context。
      const result = (await answerWithReading(
        store,
        secrets,
        config,
        '情感主义',
        '',
        documentId,
        1,
        plan('document'),
        700
      )) as ChatResponse;
      expect(result).not.toBeNull();
      expect(result.coverage?.final_context).toBeTruthy();
      expect(result.coverage?.final_context).toContain('分批阅读记录');
      expect(result.coverage?.final_context).toContain('verified_quotes');
    } finally {
      store.savePageTextEdit(documentId, 1, PAGE1);
      store.savePageTextEdit(documentId, 2, PAGE2);
    }
  }, 120_000);

  it('超长材料（>20k 字符）：final_context 完整保存，不再留空', async () => {
    // 自造 mock：12 页、每页首行是一整行 ~1400 字符的原文（核验后进入证据银行），
    // 后面长填充让每页占满一批；12 批分析 + 12 条摘引使实际送入材料超过 20,000 字符。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as {
              messages?: Array<{ role: string; content: string }>;
            })
          : {};
        const messages = body.messages ?? [];
        const system = messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
        const user = messages.find((message) => message.role === 'user')?.content ?? '';
        let content = '文献回答 [1]';
        if (system.includes('READING_BATCH')) {
          const match = /\[(\d+)\][^\n]*\n([^\n]+)/.exec(user);
          content = JSON.stringify({
            // analysis 受 ANALYSIS_LIMIT 约束，保持 ~390 字；材料体积主要来自逐字摘引。
            analysis: '要点。'.repeat(130),
            evidence: match ? [{ source: Number(match[1]), quote: match[2]!.trim() }] : [],
            no_relevant_evidence: !match
          });
        } else if (system.includes('READING_REREAD')) {
          content = JSON.stringify({ read: [], reason: '证据足够' });
        } else if (system.includes('READING_AUDIT')) {
          content = JSON.stringify({
            claims: [
              {
                claim: 1,
                verdict: 'supported',
                reason: '原文支持',
                claim_type: 'DOCUMENT_INTERPRETATION',
                evidence_standard: 'GROUNDED'
              }
            ]
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );
    const bigPdf = await PDFDocument.create();
    const bigFont = await bigPdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 12; index += 1) {
      const page = bigPdf.addPage([300, 400]);
      page.drawText(`b${index + 1}`, { x: 20, y: 20, size: 8, font: bigFont });
    }
    const bigFile = path.join(dataDir, 'final-context-big.pdf');
    writeFileSync(bigFile, await bigPdf.save());
    const bigDocument = await store.importDocument(bigFile, undefined, true);
    // 每页 ~50.4k token（1400 首行 + 49000 填充）：预算 60000 下每页单独一批（12 批）。
    for (let page = 1; page <= 12; page += 1) {
      const firstLine = `FINALCTX_LONG_MARKER_${page}_${'y'.repeat(1380)}`;
      store.savePageTextEdit(bigDocument.id, page, `${firstLine}\n${'x'.repeat(49_000)}`);
    }
    try {
      const result = (await answerWithReading(
        store,
        secrets,
        config,
        '情感主义',
        '',
        bigDocument.id,
        1,
        plan('document'),
        60_000
      )) as ChatResponse;
      expect(result).not.toBeNull();
      const finalContext = result.coverage?.final_context;
      expect(finalContext).toBeTruthy();
      // 多批 final_context 始终是实际送入的材料，没有 20k 留空规则。
      expect(finalContext!.length).toBeGreaterThan(20_000);
      expect(finalContext!).toContain('FINALCTX_LONG_MARKER');
    } finally {
      store.savePageTextEdit(documentId, 1, PAGE1);
      store.savePageTextEdit(documentId, 2, PAGE2);
    }
  }, 180_000);
});
