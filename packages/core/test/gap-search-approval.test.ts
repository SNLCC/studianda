import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatResponse } from '@studianda/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../src/chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 联网补查：review 档“回答后确认再补查”、followup 两轮、联网补充审计与 merge。
 *
 * 全部网络请求走 mock：模型请求按 system 标记返回不同 JSON；搜索请求按 URL 区分。
 * 断言重点不是文案细节，而是“未获准绝不发请求 / 获准后两轮并如实记账 / 审计失败不丢回答”。
 */
let dataDir = '';
let store: Store;
let secrets: SecretStore;
let documentId = '';

function lastUser(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

/** 从审计材料 JSON 里取一条原文摘引，作为 supported 的逐字证据。 */
function firstEvidence(material: string): { source: number; quote: string } | null {
  const start = material.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(material.slice(start)) as {
      evidence_index?: unknown;
      verified_quotes?: unknown;
    };
    const list = Array.isArray(parsed.evidence_index)
      ? parsed.evidence_index
      : Array.isArray(parsed.verified_quotes)
        ? parsed.verified_quotes
        : [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const item = row as { source?: unknown; quote?: unknown };
      if (typeof item.quote === 'string' && item.quote.trim().length >= 4) {
        return {
          source: typeof item.source === 'number' ? item.source : 1,
          quote: item.quote.trim().slice(0, 120)
        };
      }
    }
  } catch {
    // 材料不是 JSON：按无证据处理。
  }
  return null;
}

function parseAnswerLines(material: string): number[] {
  const start = material.indexOf('{');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(material.slice(start)) as {
      answer_lines?: Array<{ claim?: unknown }>;
    };
    return (parsed.answer_lines ?? [])
      .map((row) => Number(row.claim))
      .filter((claim) => Number.isInteger(claim) && claim > 0);
  } catch {
    return [];
  }
}

interface Counts {
  search: number;
  audit: number;
  revise: number;
}

function mockNetwork(): Counts {
  const counts: Counts = { search: 0, audit: 0, revise: 0 };
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('search.example')) {
      counts.search += 1;
      return new Response(
        JSON.stringify({
          results: [
            {
              title: `网页结果 ${counts.search}`,
              url: `https://web.example.com/${counts.search}`,
              snippet: `网页正文 ${counts.search}：关于该论断的外部依据。`
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const material = lastUser(messages);
    let content = '文献回答第一段 [1]\n第二段讨论。\n第三段补充。\n第四段结论。';
    if (system.includes('QUESTION_ROUTE')) {
      content = JSON.stringify({
        document: true,
        search: false,
        reason: '读文献',
        reply: '',
        reading: 'local',
        confidence: 0.95,
        pages: [1],
        queries: [],
        dimensions: [{ code: 'D1', label: '概念界定' }]
      });
    } else if (system.includes('READING_BATCH')) {
      content = JSON.stringify({
        analysis: '本批要点：文献给出了一条需要外部依据的论断。',
        evidence: [
          {
            source: 1,
            quote: '原始页面文字',
            dimension: 'D1'
          }
        ],
        no_relevant_evidence: false
      });
    } else if (system.includes('READING_AUDIT')) {
      counts.audit += 1;
      const claims = parseAnswerLines(material);
      const evidence = firstEvidence(material);
      const claimTypes = [
        'CONCEPT_DEFINITION',
        'SCHOLARLY_POSITION',
        'HISTORICAL_FACT',
        'BIBLIOGRAPHIC_FACT'
      ];
      content = JSON.stringify({
        claims: claims.map((claim, index) => ({
          claim,
          verdict: evidence ? 'supported' : 'unsupported',
          reason: evidence ? '原文/网页支持' : '缺少证据',
          claim_type: claimTypes[index % claimTypes.length],
          evidence_standard: evidence ? 'EXTERNAL' : 'LIGHT',
          evidence: evidence ? [evidence] : []
        }))
      });
    } else if (system.includes('逐段修订回答')) {
      counts.revise += 1;
      content = `网页补充回答（第 ${counts.revise} 轮）[W1]\n第二段补充说明。`;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return counts;
}

function configureSearch(permission: 'review' | 'auto' | 'off'): void {
  secrets.set('search.api_key', 'search-key');
  store.updateSettings({
    'search.provider': 'deepseek',
    'search.base_url': 'https://search.example',
    'search.permission': permission,
  });
}

const baseInput = (): Parameters<typeof answerQuestion>[2] => ({
  question: '这个概念的历史事实依据是什么？',
  documentId,
  page: 1
});

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-gap-search-'));
  store = new Store(dataDir);
  secrets = new SecretStore();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`Page ${index + 1}`, { x: 20, y: 20, size: 12, font });
  }
  const file = path.join(dataDir, 'fixture.pdf');
  writeFileSync(file, await pdf.save());
  documentId = (await store.importDocument(file)).id;
  store.savePageTextEdit(documentId, 1, '原始页面文字：这个概念在文献里有界定。');
  store.updateSettings({ 'reading.max_read_batches': '1' });
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example/v1';
  process.env.STUDIANDA_MODEL_NAME = 'mock-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'mock-key';
  process.env.STUDIANDA_READING_BUDGET = '700';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
  delete process.env.STUDIANDA_READING_BUDGET;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('review 档回答后确认补查', () => {
  it('未获准时一个外部请求都不发，只返回 gap_search_approval', async () => {
    configureSearch('review');
    const counts = mockNetwork();
    const response = (await answerQuestion(store, secrets, baseInput())) as ChatResponse;
    expect(counts.search).toBe(0);
    expect(response.gap_search_approval).toBeTruthy();
    expect(response.gap_search_approval?.queries.length).toBeGreaterThan(0);
    expect(response.notice ?? '').toContain('需要你允许后补查');
    expect(response.coverage?.auto_source_search?.status ?? '').toContain('未发起');
    expect(response.search_followup).toBeUndefined();
  });

  it('confirm_gap_search=true 视为本轮获准：搜索、修订并返回 followup 记账', async () => {
    configureSearch('review');
    const counts = mockNetwork();
    const response = (await answerQuestion(store, secrets, {
      ...baseInput(),
      confirm_gap_search: true
    })) as ChatResponse;
    expect(counts.search).toBeGreaterThan(0);
    expect(counts.revise).toBeGreaterThan(0);
    expect(response.answer ?? '').toContain('网页补充回答');
    expect(response.gap_search_approval).toBeUndefined();
    expect(response.search_followup?.rounds).toBeGreaterThanOrEqual(1);
    expect(response.search_followup?.queries.length).toBeGreaterThan(0);
    expect(response.coverage?.web_support_review).toBeTruthy();
  });

  it('auto 权限下剩余外部论断会追加第 2 轮（新查询词不重复）', async () => {
    configureSearch('auto');
    const counts = mockNetwork();
    const response = (await answerQuestion(store, secrets, baseInput())) as ChatResponse;
    expect(counts.search).toBeGreaterThanOrEqual(2);
    expect(response.search_followup?.rounds).toBe(2);
    expect(response.search_followup?.queries.length).toBeGreaterThanOrEqual(2);
    // 两轮报告用 mergeWebReviews 合并后保留编号偏移与两轮 claims。
    const review = response.coverage?.web_support_review as
      | { claims?: unknown[]; web_source_offset?: number }
      | undefined;
    expect(review?.claims?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(review?.web_source_offset).toBeTypeOf('number');
  });

  it('联网补充复核失败时保留修订回答并如实 notice', async () => {
    configureSearch('review');
    let searchCalls = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('search.example')) {
        searchCalls += 1;
        return new Response(
          JSON.stringify({
            results: [
              {
                title: '网页结果',
                url: 'https://web.example.com/1',
                content: '网页正文：关于该论断的外部依据。'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const material = lastUser(messages);
      let content = '文献回答第一段 [1]\n第二段讨论。';
      if (system.includes('QUESTION_ROUTE')) {
        content = JSON.stringify({
          document: true,
          search: false,
          reason: '读文献',
          reply: '',
          reading: 'local',
          confidence: 0.95,
          pages: [1],
          queries: [],
          dimensions: [{ code: 'D1', label: '概念界定' }]
        });
      } else if (system.includes('READING_BATCH')) {
        content = JSON.stringify({
          analysis: '要点',
          evidence: [{ source: 1, quote: '原始页面文字', dimension: 'D1' }],
          no_relevant_evidence: false
        });
      } else if (system.includes('READING_AUDIT')) {
        // 网页复核审计（材料里含修订后的回答）故意返回坏 JSON，模拟复核失败。
        content = material.includes('网页补充回答')
          ? '这不是 JSON'
          : JSON.stringify({
              claims: parseAnswerLines(material).map((claim, index) => ({
                claim,
                verdict: 'unsupported',
                reason: '缺少证据',
                claim_type: index === 0 ? 'CONCEPT_DEFINITION' : 'HISTORICAL_FACT',
                evidence_standard: 'LIGHT',
                evidence: []
              }))
            });
      } else if (system.includes('逐段修订回答')) {
        content = '网页补充回答 [W1]';
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const response = (await answerQuestion(store, secrets, {
      ...baseInput(),
      confirm_gap_search: true
    })) as ChatResponse;
    expect(searchCalls).toBeGreaterThan(0);
    expect(response.answer ?? '').toContain('网页补充回答');
    expect(response.notice ?? '').toContain('联网补充未完成复核');
  });
});
