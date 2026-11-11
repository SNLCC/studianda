import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ContentBlock,
  DocumentBlocks,
  DocumentReferences,
  DocumentSection
} from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import {
  applyReferenceEdits,
  looksLikeFootnoteReference,
  parseReferenceFields,
  recognizeReferences
} from '../src/references.js';

/**
 * 参考文献识别的行为契约：
 *
 * 1. 文末列表：REFERENCES 小节里的条目按编号拆开，标签/年份/标题/出处尽力解析；
 * 2. 页下注：有书目特征（年份 + 出版信息/书名号/文献类型）的脚注才算条目，
 *    普通说明注不误收；
 * 3. 引用标记：`[1]`、`[1–3]`、`(Smith, 2020)`、（张三，2020）能解析到条目；
 *    解析不到时 entryIds 为空（不猜）；
 * 4. Store/HTTP 契约：条目 + 按页分组的引用，缺文档 404。
 */

function block(
  id: string,
  page: number,
  kind: ContentBlock['kind'],
  text: string,
  section: number,
  bbox: [number, number, number, number] = [0.05, 0.1, 0.95, 0.2]
): ContentBlock {
  return { id, page, kind, section, text, bbox, lines: 1 };
}

function section(
  index: number,
  title: string,
  kind: DocumentSection['kind'],
  blockStart: number,
  blockEnd: number
): DocumentSection {
  return {
    index,
    title,
    level: 1,
    kind,
    origin: 'heading',
    pageStart: 1,
    pageEnd: 2,
    blockStart,
    blockEnd,
    parent: null
  };
}

function fixture(): DocumentBlocks {
  const blocks: ContentBlock[] = [
    block('b0', 1, 'heading', '1 INTRODUCTION', 0),
    block(
      'b1',
      1,
      'paragraph',
      'As shown in [1] and [2], the method works. See also [1–3].'
    , 0),
    block(
      'b2',
      1,
      'paragraph',
      'Smith (Smith, 2020) agreed, and 张三（张三，2020）也指出该问题。'
    , 0),
    block('b3', 1, 'paragraph', 'A citation to a missing entry [9] is left unresolved.', 0),
    block('b4', 2, 'heading', 'REFERENCES', 1),
    block(
      'b5',
      2,
      'reference',
      '[1] Smith, J. (2020). Alpha study. Journal A, 12(3), 45-67.'
    , 1),
    block('b6', 2, 'reference', '[2] Doe, A. (2021). Beta study. Journal B, 3, 1-10.', 1),
    block('b7', 2, 'reference', '[3] Roe, B. (2022). Gamma study. Journal C.', 1),
    block('b8', 2, 'reference', '[4] A. (2020). Merged one. [5] B. (2021). Merged two.', 1),
    block(
      'b9',
      1,
      'footnote',
      '① 张三：《研究方法》，北京：某出版社，2020年，第12页。'
    , 0),
    block('b10', 1, 'footnote', '① 这是一个普通说明注，不是文献引用。', 0)
  ];
  return {
    documentId: 'doc-1',
    sections: [
      section(0, '1 INTRODUCTION', 'body', 0, 4),
      section(1, 'REFERENCES', 'references', 5, 8)
    ],
    blocks,
    stats: {
      pages: 2,
      blocks: blocks.length,
      headings: 2,
      paragraphs: 3,
      lists: 0,
      tables: 0,
      captions: 0,
      formulas: 0,
      footnotes: 2,
      references: 4,
      sections: 2,
      basis: 'heading'
    }
  };
}

describe('parseReferenceFields', () => {
  it('解析英文条目（作者/年份/标题/期刊）', () => {
    const fields = parseReferenceFields(
      'Smith, J. (2020). Alpha study. Journal A, 12(3), 45-67.'
    );
    expect(fields.year).toBe('2020');
    expect(fields.authors).toContain('Smith');
    expect(fields.title).toBe('Alpha study');
    expect(fields.venue).toBe('Journal A');
  });

  it('解析中文条目（作者/书名/出版社/年份）', () => {
    const fields = parseReferenceFields('张三：《研究方法》，北京：某出版社，2020年，第12页。');
    expect(fields.year).toBe('2020');
    expect(fields.authors).toBe('张三');
    expect(fields.title).toBe('研究方法');
    expect(fields.venue).toContain('某出版社');
  });

  it('解析 GB/T 7714 条目', () => {
    const fields = parseReferenceFields(
      '李四. 社会研究的逻辑[J]. 社会学研究, 2019, 34(2): 1-20.'
    );
    expect(fields.year).toBe('2019');
    expect(fields.authors).toBe('李四');
    expect(fields.title).toBe('社会研究的逻辑');
    expect(fields.venue).toBe('社会学研究');
  });

  it('解析不出时留空，不猜', () => {
    const fields = parseReferenceFields('这是一条没有年份也没有书名号的说明。');
    expect(fields.year).toBe('');
    expect(fields.title).toBe('');
  });
});

describe('looksLikeFootnoteReference', () => {
  it('有书目特征的脚注算引用条目', () => {
    expect(looksLikeFootnoteReference('① 张三：《研究方法》，北京：某出版社，2020年。')).toBe(true);
    expect(looksLikeFootnoteReference('1. Smith, J. Journal A, Vol. 3, 2020, pp. 1-10.')).toBe(true);
  });

  it('普通说明注不算引用条目', () => {
    expect(looksLikeFootnoteReference('① 这是一个普通说明注，不是文献引用。')).toBe(false);
    expect(looksLikeFootnoteReference('* 本文写作得到某某基金支持。')).toBe(false);
  });
});

describe('recognizeReferences', () => {
  const result = recognizeReferences('doc-1', fixture());

  it('识别文末条目并按编号拆分（含挤在同一块里的多条）', () => {
    const end = result.entries.filter((entry) => entry.kind === 'end');
    expect(end.map((entry) => entry.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.stats.endEntries).toBe(5);
    expect(end[0]?.raw).toContain('Alpha study');
    expect(end[0]?.year).toBe('2020');
    expect(end[0]?.title).toBe('Alpha study');
    // 挤在同一块里的两条按 [4]/[5] 拆开。
    expect(end[3]?.raw).toContain('Merged one');
    expect(end[4]?.raw).toContain('Merged two');
  });

  it('页下注只收书目条目，普通脚注不收', () => {
    const footnotes = result.entries.filter((entry) => entry.kind === 'footnote');
    expect(footnotes).toHaveLength(1);
    expect(footnotes[0]?.raw).toContain('研究方法');
    expect(footnotes[0]?.kind).toBe('footnote');
    expect(result.stats.footnoteEntries).toBe(1);
  });

  it('解析页面内引用：编号、区间、作者-年份，并回填条目', () => {
    const page1 = result.citations['1'] ?? [];
    const labels = page1.map((citation) => citation.label).sort();
    expect(labels).toContain('1');
    expect(labels).toContain('2');
    expect(labels).toContain('3');
    expect(labels).toContain('Smith 2020');
    expect(labels).toContain('张三 2020');
    expect(result.stats.citations).toBeGreaterThanOrEqual(6);
    // [1] 解析到文末第 1 条；[1–3] 展开成 3 条引用。
    const one = page1.find((citation) => citation.label === '1');
    expect(one?.entryIds.length).toBe(1);
    expect(one?.entryIds[0]).toMatch(/^r\d+$/);
    // 作者-年份解析到对应条目。
    const smith = page1.find((citation) => citation.label === 'Smith 2020');
    expect(smith?.entryIds.length).toBe(1);
    // 解析不到的 [9] 留空，不猜。
    const nine = page1.find((citation) => citation.label === '9');
    expect(nine?.entryIds).toEqual([]);
    expect(result.stats.unresolvedCitations).toBe(1);
  });

  it('引用带页码与块信息，便于跳转高亮', () => {
    const page1 = result.citations['1'] ?? [];
    for (const citation of page1) {
      expect(citation.page).toBe(1);
      expect(citation.blockId).toMatch(/^b\d+$/);
      expect(citation.bbox).toHaveLength(4);
      expect(citation.text.length).toBeGreaterThan(0);
    }
  });

  it('用户编辑覆盖层：改字段/删除/新增/版本失效', () => {
    const base = recognizeReferences('doc-1', fixture(), 'v1');
    const target = base.entries[0]!;
    const overridden = applyReferenceEdits(
      base,
      [{ entryId: target.id, kind: 'override', stamp: 'v1', patch: { title: '改过的标题' } }],
      'v1'
    );
    expect(overridden.entries.find((entry) => entry.id === target.id)?.title).toBe('改过的标题');
    expect(overridden.entries.find((entry) => entry.id === target.id)?.edited).toBe(true);
    expect(overridden.stats.editedEntries).toBe(1);

    const deleted = applyReferenceEdits(
      base,
      [{ entryId: target.id, kind: 'delete', stamp: 'v1' }],
      'v1'
    );
    expect(deleted.entries.some((entry) => entry.id === target.id)).toBe(false);

    const added = applyReferenceEdits(
      base,
      [
        {
          entryId: 'u1',
          kind: 'add',
          stamp: 'v1',
          entry: { label: '9', raw: 'Nine, J. (2019). Nine study. Journal N.', page: 2 }
        }
      ],
      'v1'
    );
    const manual = added.entries.find((entry) => entry.id === 'u1')!;
    expect(manual.source).toBe('manual');
    expect(manual.kind).toBe('end');
    expect(added.stats.manualEntries).toBe(1);
    // 原先解析不到的 [9] 现在指向手动条目。
    expect((added.citations['1'] ?? []).find((citation) => citation.label === '9')?.entryIds).toEqual([
      'u1'
    ]);
    expect(added.stats.unresolvedCitations).toBe(base.stats.unresolvedCitations - 1);

    // 识别版本变化：旧编辑失效并计数，不静默套用。
    const stale = applyReferenceEdits(
      base,
      [{ entryId: target.id, kind: 'override', stamp: 'v0', patch: { title: '旧版本编辑' } }],
      'v1'
    );
    expect(stale.stats.staleEdits).toBe(1);
    expect(stale.entries.find((entry) => entry.id === target.id)?.title).toBe(target.title);
  });
});

describe('Store 与 HTTP 端点', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-references-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  const token = 'references-token';
  const server = buildServer({ token, version: 'test-version', store, secrets });
  let documentId = '';

  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const first = pdf.addPage([400, 600]);
    first.drawText('1 INTRODUCTION', { x: 30, y: 560, size: 16, font });
    first.drawText('As shown in [1], the value belief is central.', {
      x: 30,
      y: 520,
      size: 11,
      font
    });
    first.drawText('See also (Smith, 2020) for the original claim.', {
      x: 30,
      y: 500,
      size: 11,
      font
    });
    first.drawText('A missing entry [9] is cited here.', {
      x: 30,
      y: 480,
      size: 11,
      font
    });
    // 页下注：小字号、贴页底、书目内容。
    first.drawText('1. Smith, J. Journal A, 2020, pp. 1-10.', {
      x: 30,
      y: 30,
      size: 8,
      font
    });
    const second = pdf.addPage([400, 600]);
    second.drawText('REFERENCES', { x: 30, y: 560, size: 16, font });
    second.drawText('[1] Smith, J. (2020). Alpha study. Journal A, 12(3), 45-67.', {
      x: 30,
      y: 520,
      size: 10,
      font
    });
    second.drawText('[2] Doe, A. (2021). Beta study. Journal B, 3, 1-10.', {
      x: 30,
      y: 500,
      size: 10,
      font
    });
    const file = path.join(dataDir, 'references.pdf');
    writeFileSync(file, await pdf.save());
    const imported = await store.importDocument(file);
    documentId = imported.id;
    await store.getPageLayout(documentId);
  }, 120_000);

  afterAll(async () => {
    await server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('getDocumentReferences 返回文末条目、页下注条目与页面引用', async () => {
    const result = await store.getDocumentReferences(documentId);
    expect(result.documentId).toBe(documentId);
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const end = result.entries.filter((entry) => entry.kind === 'end');
    expect(end.some((entry) => entry.raw.includes('Alpha study'))).toBe(true);
    const footnotes = result.entries.filter((entry) => entry.kind === 'footnote');
    expect(footnotes.length).toBeGreaterThanOrEqual(1);
    expect(result.citations['1']?.some((citation) => citation.label === '1')).toBe(true);
    expect(result.stats.resolvedCitations).toBeGreaterThan(0);
  });

  it('用户可修改/删除/新增参考文献条目，重置后恢复识别', async () => {
    const base = await store.getDocumentReferences(documentId);
    const target = base.entries.find((entry) => entry.kind === 'end' && entry.label === '1')!;
    const edited = await store.updateReferenceEntry(documentId, target.id, {
      title: 'Edited title',
      year: '1999'
    });
    const afterEdit = edited.entries.find((entry) => entry.id === target.id)!;
    expect(afterEdit.title).toBe('Edited title');
    expect(afterEdit.year).toBe('1999');
    expect(afterEdit.edited).toBe(true);
    expect(edited.stats.editedEntries).toBe(1);

    const added = await store.addReferenceEntry(documentId, {
      label: '9',
      raw: 'Nine, J. (2019). Nine study. Journal N.'
    });
    const manual = added.entries.find((entry) => entry.source === 'manual')!;
    expect(manual.kind).toBe('end');
    expect(
      (added.citations['1'] ?? []).find((citation) => citation.label === '9')?.entryIds
    ).toContain(manual.id);
    expect(added.stats.unresolvedCitations).toBe(0);

    const deleted = await store.deleteReferenceEntry(documentId, target.id);
    expect(deleted.entries.some((entry) => entry.id === target.id)).toBe(false);

    const reset = await store.resetReferenceEdits(documentId);
    expect(reset.entries.some((entry) => entry.source === 'manual')).toBe(false);
    expect(reset.stats.editedEntries).toBe(0);
    expect(reset.entries.some((entry) => entry.id === target.id)).toBe(true);
  });

  it('HTTP: 修改/新增/删除/重置参考文献条目，非法条目 400', async () => {
    const headers = { 'x-studianda-token': token };
    const get = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/references`,
      headers
    });
    const body = get.json() as DocumentReferences;
    const entry = body.entries.find((item) => item.kind === 'end')!;

    const put = await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${documentId}/references/entries/${encodeURIComponent(entry.id)}`,
      headers,
      payload: { title: 'HTTP 改过' }
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json() as DocumentReferences;
    expect(putBody.entries.find((item) => item.id === entry.id)?.title).toBe('HTTP 改过');

    const post = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/references/entries`,
      headers,
      payload: { label: '7', raw: 'Seven, A. (2018). Seven study.' }
    });
    expect(post.statusCode).toBe(200);
    const postBody = post.json() as DocumentReferences;
    expect(postBody.entries.some((item) => item.source === 'manual')).toBe(true);

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${documentId}/references/entries/${encodeURIComponent(entry.id)}`,
      headers
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as DocumentReferences).entries.some((item) => item.id === entry.id)).toBe(
      false
    );

    const reset = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/references/reset`,
      headers
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as DocumentReferences).entries.some((item) => item.source === 'manual')).toBe(
      false
    );

    const invalid = await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${documentId}/references/entries/not-exist`,
      headers,
      payload: { title: 'x' }
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('HTTP: GET /documents/:id/references 返回识别结果，缺文档 404', async () => {
    const headers = { 'x-studianda-token': token };
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/references`,
      headers
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as DocumentReferences;
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    expect(body.citations['1']?.[0]?.blockId).toMatch(/^b\d+$/);
    const missing = await server.inject({
      method: 'GET',
      url: '/api/v1/documents/not-a-document/references',
      headers
    });
    expect(missing.statusCode).toBe(404);
  });
});
