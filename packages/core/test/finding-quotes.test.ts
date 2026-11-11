import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@studianda/shared';
import type { ReadingFinding } from '../src/reading-executor.js';
import { findingQuotes } from '../src/reading-chat.js';
import { answerWithReading } from '../src/reading-chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

// 每页首行短（作为批次摘引，token 成本小、能被证据银行保留），后面多行填充让整页
// 成本超过批次预算、从而强制多批阅读。
const PAGE1 = `第一页原文：模型对情感主义给出了界定与解释。\n${'补充第一页细节。'.repeat(40)}`;
const PAGE2 = `第二页原文：继续补充历史背景与学术立场的差异。\n${'补充第二页细节。'.repeat(40)}`;
const PAGE3 = `第三页原文：结论部分总结争议解读与仍需核实的时效信息。\n${'补充第三页细节。'.repeat(40)}`;

function finding(
  evidence: Array<{ source: number; quote: string; page?: number; documentId?: string }>,
  documents: Array<{ id: string; name: string }> = []
): ReadingFinding {
  return {
    analysis: '本批要点',
    evidence,
    no_relevant_evidence: false,
    documents
  } as unknown as ReadingFinding;
}

describe('findingQuotes', () => {
  it('每来源最多 2 条，按原文去重且每条截断 200 字', () => {
    const long = '甲'.repeat(260);
    const result = findingQuotes(
      [
        finding([
          { source: 1, quote: '  第一段逐字摘引  ' },
          { source: 1, quote: '第一段逐字摘引' },
          { source: 1, quote: long },
          { source: 2, quote: '第二来源摘引' }
        ])
      ],
      2
    );
    expect(result[1]).toHaveLength(2);
    expect(result[1]![0]).toBe('第一段逐字摘引');
    expect(result[1]![1]!.length).toBe(200);
    expect(result[2]).toEqual(['第二来源摘引']);
  });

  it('来源编号越界/非整数、空 quote 一律忽略（不信未核验来源）', () => {
    const result = findingQuotes(
      [
        finding([
          { source: 0, quote: '越界0' },
          { source: 3, quote: '越界3' },
          { source: 1.5, quote: '非整数' },
          { source: 1, quote: '   ' },
          { source: 1, quote: '' },
          { source: 2, quote: '合法摘引' }
        ])
      ],
      2
    );
    expect(result).toEqual({ 2: ['合法摘引'] });
  });

  it('多个批次按批内顺序累计；perSource/size 可配置', () => {
    const result = findingQuotes(
      [
        finding([{ source: 1, quote: '批次一摘引' }]),
        finding([{ source: 1, quote: '批次二摘引' }, { source: 1, quote: '批次三摘引' }])
      ],
      1,
      3,
      4
    );
    expect(result[1]).toEqual(['批次一摘', '批次二摘', '批次三摘']);
  });

  it('没有 findings 时返回空对象', () => {
    expect(findingQuotes([], 3)).toEqual({});
  });
});

/** 从批次材料里取第一个 [n] 块的来源编号与首行原文（保证能通过逐字核验）。 */
function firstBlock(user: string): { source: number; quote: string } | null {
  const match = /\[(\d+)\][^\n]*\n([^\n]+)/.exec(user);
  if (!match) return null;
  return { source: Number(match[1]), quote: match[2]!.trim() };
}

describe('阅读级：批次摘引与审计摘引合并', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-finding-quotes-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  let documentId = '';

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
    for (let index = 0; index < 3; index += 1) {
      const page = pdf.addPage([300, 400]);
      page.drawText(`p${index + 1}`, { x: 20, y: 20, size: 8, font });
    }
    const file = path.join(dataDir, 'finding.pdf');
    writeFileSync(file, await pdf.save());
    const imported = await store.importDocument(file, undefined, true);
    documentId = imported.id;
    store.savePageTextEdit(documentId, 1, PAGE1);
    store.savePageTextEdit(documentId, 2, PAGE2);
    store.savePageTextEdit(documentId, 3, PAGE3);
  }, 120_000);

  it('未被审计引用的来源也带批次逐字摘引；被审计来源保留批次摘引在前、审计摘引在后', async () => {
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
        let content = '按批次阅读记录综合。';
        if (system.includes('READING_BATCH')) {
          const block = firstBlock(user);
          content = JSON.stringify({
            analysis: '本批要点：文献给出了界定与解释。',
            evidence: block ? [{ source: block.source, quote: block.quote }] : [],
            no_relevant_evidence: !block
          });
        } else if (system.includes('READING_REREAD')) {
          content = JSON.stringify({ read: [], reason: '证据足够' });
        } else if (system.includes('READING_AUDIT')) {
          // 审计只引用第 2 页来源：从材料里的 verified_quotes 找到真实 bank 编号，
          // 摘引取该页中段一小句（与批次摘引不同但逐字来自原文），
          // 用来验证“批次摘引在前、审计摘引追加”。
          let source = 1;
          let quote = PAGE2.slice(20, 50);
          const start = user.indexOf('{');
          if (start >= 0) {
            try {
              const parsed = JSON.parse(user.slice(start)) as { verified_quotes?: unknown };
              const rows = Array.isArray(parsed.verified_quotes) ? parsed.verified_quotes : [];
              const row = rows.find(
                (item): item is { source: number; quote: string } =>
                  Boolean(item) &&
                  typeof item === 'object' &&
                  typeof (item as { source?: unknown }).source === 'number' &&
                  typeof (item as { quote?: unknown }).quote === 'string' &&
                  (item as { quote: string }).quote.startsWith('第二页原文')
              );
              if (row) {
                source = row.source;
                quote = row.quote.slice(20, 50);
              }
            } catch {
              // 材料不是 JSON：仍用默认来源。
            }
          }
          content = JSON.stringify({
            claims: [
              {
                claim: 1,
                verdict: 'supported',
                reason: '原文支持',
                claim_type: 'DOCUMENT_INTERPRETATION',
                evidence_standard: 'GROUNDED',
                evidence: [{ source, quote }]
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

    const result = (await answerWithReading(
      store,
      secrets,
      { baseUrl: 'https://model.example.com/v1', apiKey: 'k-1', model: 'chat-model' },
      '无关提问词',
      '',
      documentId,
      1,
      {
        breadth: 'document',
        reason: '测试：整篇阅读',
        origin: '规则',
        pages: [],
        queries: [],
        dimensions: []
      },
      900 // 小预算强制多批（每页约 590 token，两页超预算）；证据银行 token room=540 仍装得下三条短摘引
    )) as ChatResponse;

    const sources = result.sources.filter((source) => source.kind !== 'web');
    expect(sources.length).toBeGreaterThanOrEqual(2);
    // 所有来源都有逐字摘引，且每条都是该页原文的子串（逐字来自原文）。
    for (const source of sources) {
      const pageText = store.getPageText(source.documentId, source.page);
      expect(source.quotes?.length ?? 0).toBeGreaterThan(0);
      expect(source.quotes!.length).toBeLessThanOrEqual(3);
      for (const quote of source.quotes!) {
        expect(quote.length).toBeLessThanOrEqual(200);
        expect(pageText).toContain(quote);
      }
    }
    // 第 1 页来源没有被审计引用：它的摘引来自批次核验，仍能定位原文。
    const unaudited = sources.find((source) => source.page === 1);
    expect(unaudited).toBeTruthy();
    expect(unaudited!.quotes!.some((quote) => PAGE1.includes(quote))).toBe(true);
    // 第 2 页来源被审计引用：批次摘引保留在前（从页首开始），审计摘引追加在后。
    const audited = sources.find((source) => source.page === 2);
    expect(audited).toBeTruthy();
    expect(audited!.quotes![0]!.startsWith('第二页原文')).toBe(true);
    expect(audited!.quotes).toContain(PAGE2.slice(20, 50));
  }, 120_000);
});
