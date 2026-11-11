import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { searchLibrary, searchLibraryDocuments } from '../src/library-search.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 库检索的 DTO 必须把"命中行/译文/派生"标记透传给界面：
 * 只有 snippet 时，命中词无法标出，译文命中也会被当成原文。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-library-search-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function importPdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 400]);
  page.drawText(name, { x: 20, y: 20, size: 8, font });
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return document.id;
}

describe('库检索命中字段', () => {
  it('chunk 命中透传 match（命中行），不只剩 snippet', async () => {
    const documentId = await importPdf('search-fields.pdf');
    // 先完成一次解析（导入是懒解析）：否则解析在 savePageTextEdit 之后落库，会把校订块盖掉。
    await store.getPageLayout(documentId);
    await store.savePageTextEdit(
      documentId,
      1,
      '第一行：无关内容。\n第二行：这里讨论网络分层与协议。\n第三行：结尾。'
    );
    const hits = searchLibrary(store, secrets, '网络分层', ['chunk']);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    expect(hit.kind).toBe('chunk');
    expect(hit.match ?? '').toContain('网络分层');
    // 命中行必须来自原文，而不是凭空生成。
    expect(store.getPageText(documentId, hit.page ?? 1)).toContain(hit.match ?? '');
  });

  it('没有命中行时不伪造 match 字段', async () => {
    const hits = searchLibrary(store, secrets, '完全不存在的词', ['chunk']);
    expect(hits).toEqual([]);
  });
});

/**
 * 文献工作台的搜索是"过滤下方文献列表"：命中判定的粒度是文献（不是命中段落），
 * 且不受命中条数上限影响。
 */
describe('文献列表的检索过滤', () => {
  it('标题命中只返回该文献，不返回无关文献', async () => {
    const target = await importPdf('doc-match-title.pdf');
    // 导入时画在页面上的文件名是 ASCII；这里换成中文标题，验证的是标题字段命中。
    store.updateDocument(target, { name: '标题命中专用' });
    // 正文改写成与标题无关的内容，避免正文也命中、掩盖标题字段的判定。
    await store.getPageLayout(target);
    await store.savePageTextEdit(target, 1, '这一页只讨论别的内容。');
    const other = await importPdf('doc-match-unrelated.pdf');

    const ids = searchLibraryDocuments(store, secrets, '标题命中专用', ['document']);
    expect(ids).toContain(target);
    expect(ids).not.toContain(other);
  });

  it('只选正文时，标题命中不算命中', async () => {
    const ids = searchLibraryDocuments(store, secrets, '标题命中专用', ['chunk']);
    expect(ids).toEqual([]);
  });

  it('正文命中按文献返回，不返回正文不命中的文献', async () => {
    const matched = await importPdf('doc-match-body-a.pdf');
    await store.getPageLayout(matched);
    await store.savePageTextEdit(matched, 1, '第一行：甲文献讨论网络分层。\n第二行：仍在讨论网络分层。');
    const unmatched = await importPdf('doc-match-body-b.pdf');
    await store.getPageLayout(unmatched);
    await store.savePageTextEdit(unmatched, 1, '这一页没有那个词。');

    const ids = searchLibraryDocuments(store, secrets, '网络分层', ['chunk']);
    expect(ids).toContain(matched);
    expect(ids).not.toContain(unmatched);
  });

  it('没有命中时返回空数组', async () => {
    expect(
      searchLibraryDocuments(store, secrets, '完全不存在的词', ['document', 'tag', 'chunk'])
    ).toEqual([]);
  });
});
