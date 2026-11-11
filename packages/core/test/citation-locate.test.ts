import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerAnchors,
  lineAnchor,
  searchOrder
} from '../src/citation.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-citation-locate-'));
const store = new Store(dataDir);
let documentId = '';

const PAGE_TEXTS = [
  'Opening page alpha content only.',
  'Second page beta content only.',
  'Third page gamma content only.',
  'Cross page recovery evidence sentence appears here.',
  'Fifth page delta content only.',
  'Sixth page epsilon content only.'
];

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('citation-locate-fixture');
  pdf.setAuthor('Studianda test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of PAGE_TEXTS) {
    const page = pdf.addPage([400, 600]);
    page.drawText(text, { x: 30, y: 540, size: 11, font });
  }
  const file = path.join(dataDir, 'fixture.pdf');
  writeFileSync(file, await pdf.save());
  documentId = (await store.importDocument(file)).id;
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cross-page quote recovery', () => {
  it('keeps the recorded page when the quote is really on it', async () => {
    const result = await store.locateCitationEx(documentId, 4, 'Cross page recovery');
    expect(result.page).toBe(4);
    expect(result.corrected).toBe(false);
    expect(result.method).toBe('text_layer');
    expect(result.boxes.length).toBeGreaterThan(0);
    expect(result.boxes[0]?.bbox).toHaveLength(4);
    expect(result.message).toContain('文本层');
  });

  it('finds the quote on another page and reports the corrected page', async () => {
    const result = await store.locateCitationEx(documentId, 1, 'Cross page recovery evidence');
    expect(result.corrected).toBe(true);
    expect(result.page).toBe(4);
    expect(result.boxes.length).toBeGreaterThan(0);
    expect(result.message).toContain('第 4 页');
    expect(result.message).toContain('第 1 页');
    // 跨页找回只读已有文本层/OCR 缓存：不得写新的识别结果。
    expect(store.getPageEdit(documentId, 2)).toBeNull();
    expect(store.getPageEdit(documentId, 4)).toBeNull();
  });

  it('reports none honestly when the whole document lacks the quote', async () => {
    const result = await store.locateCitationEx(documentId, 2, 'zzz nothing matches anywhere');
    expect(result.boxes).toEqual([]);
    expect(result.method).toBe('none');
    expect(result.corrected).toBe(false);
    expect(result.page).toBe(2);
    expect(result.message).toContain('没有找到');
  });

  it('keeps the legacy array API for callers that only need boxes', async () => {
    const boxes = await store.locateCitation(documentId, 4, 'Cross page recovery');
    expect(Array.isArray(boxes)).toBe(true);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes[0]?.bbox.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('orders candidate pages nearest first, excluding the recorded page', () => {
    expect(searchOrder(5, 8).slice(0, 4)).toEqual([4, 6, 3, 7]);
    expect(searchOrder(1, 90)).toHaveLength(60);
    expect(searchOrder(1, 3)).toEqual([2, 3]);
    expect(searchOrder(1, 1)).toEqual([]);
  });
});

describe('citation line anchors', () => {
  it('returns the verbatim overlap for a paraphrased claim', () => {
    const text = '研究结果表明该结论需要谨慎对待。';
    expect(lineAnchor('研究结果表明该结论还需验证。', text)).toBe('研究结果表明该结论');
  });

  it('returns empty when the wording never overlaps', () => {
    expect(lineAnchor('完全不同的另一句话。', '无关内容。')).toBe('');
    expect(lineAnchor('', 'anything')).toBe('');
    expect(lineAnchor('some claim', '')).toBe('');
  });

  it('only fills sources without verified quotes', () => {
    const answer =
      'Evidence based reading requires verified quotes [1].\n' +
      'Another line cites the verified source [2].';
    const sources = [
      { page: 1, text: 'Prefix verified quotes appear in the page.' },
      {
        page: 2,
        text: 'Another line cites the verified source here.',
        quotes: ['已有摘引']
      },
      { page: 3, text: 'Evidence based reading placeholder.', quotes: [] }
    ];
    expect(answerAnchors(answer, sources)).toEqual({ 1: 'verified' });
  });

  it('ignores citation numbers outside the source list and never invents anchors', () => {
    const answer = 'Out of range citation [3] must be ignored.';
    expect(answerAnchors(answer, [{ text: 'Out of range citation appears here.' }])).toEqual({});
    expect(
      answerAnchors('A claim with no overlap [1].', [{ text: '完全无关的原文内容。' }])
    ).toEqual({});
  });
});
