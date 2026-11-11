import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { retrievalRevisionForScope, warmRetrievalIndex } from '../src/retrieval.js';

/**
 * 按文献检索版本：编辑一篇文献只让该文献的索引缓存失效，不拖累其它文献。
 */
describe('按文献检索版本', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-doc-revision-'));
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function importPdf(store: Store, name: string): Promise<string> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 300]);
    page.drawText(`revision test ${name}`, { x: 20, y: 20, size: 8 });
    const file = path.join(dataDir, name);
    writeFileSync(file, await pdf.save());
    return (await store.importDocument(file, undefined, true)).id;
  }

  it('编辑文献 A 只递增 A 的版本，B 不变；全局版本递增', async () => {
    const store = new Store(dataDir);
    try {
      const a = await importPdf(store, 'a.pdf');
      const b = await importPdf(store, 'b.pdf');
      const globalBefore = store.getRetrievalRevision();
      const aBefore = store.getDocumentRetrievalRevision(a);
      const bBefore = store.getDocumentRetrievalRevision(b);

      await store.savePageTextEdit(a, 1, '文献 A 的新正文 local retrieval value belief');

      expect(store.getDocumentRetrievalRevision(a)).toBeGreaterThan(aBefore);
      expect(store.getDocumentRetrievalRevision(b)).toBe(bBefore);
      expect(store.getRetrievalRevision()).toBeGreaterThan(globalBefore);
    } finally {
      store.close();
    }
  });

  it('多文献 scope 的缓存版本只组合所选文献；编辑未选文献不失效', async () => {
    const store = new Store(dataDir);
    try {
      const a = await importPdf(store, 'scope-a.pdf');
      const b = await importPdf(store, 'scope-b.pdf');
      const scopeA = retrievalRevisionForScope(store, undefined, [a]);
      const scopeAB = retrievalRevisionForScope(store, undefined, [a, b]);
      const global = retrievalRevisionForScope(store);

      await store.savePageTextEdit(b, 1, '文献 B 的新正文（只改 B）');

      expect(retrievalRevisionForScope(store, undefined, [a])).toBe(scopeA);
      expect(retrievalRevisionForScope(store, undefined, [a, b])).not.toBe(scopeAB);
      expect(retrievalRevisionForScope(store)).not.toBe(global);
    } finally {
      store.close();
    }
  });

  it('预热单篇索引：有内容时返回条目数且可重复命中；不存在的文献返回 0', async () => {
    const store = new Store(dataDir);
    try {
      const a = await importPdf(store, 'warm-a.pdf');
      const first = warmRetrievalIndex(store, a);
      expect(first).toBeGreaterThan(0);
      expect(warmRetrievalIndex(store, a)).toBe(first);
      expect(warmRetrievalIndex(store, 'no-such-document')).toBe(0);
    } finally {
      store.close();
    }
  });
});
