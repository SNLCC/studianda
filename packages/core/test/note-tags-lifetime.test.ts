import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-tags-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

async function importPdf(store: Store, label: string) {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(`${label} page 1`, { x: 30, y: 360, size: 12 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

describe('note tag lifetime', () => {
  it('drops document-note tags when the parent document is deleted and restores them with it', async () => {
    const store = storeAt('document-notes');
    try {
      const document = await importPdf(store, 'tagged-doc');
      store.createNote({
        documentId: document.id,
        page: 1,
        content: '带标签的文献笔记',
        tags: ['方法', '待读']
      });
      expect(store.listNoteTags()).toEqual(expect.arrayContaining(['方法', '待读']));

      store.deleteDocument(document.id);
      // 文献进入回收站后，其文献笔记不再属于活跃资料库；最后一次占用这些标签的笔记消失，
      // 标签也应从列表里自动消失，而不是等重启。
      expect(store.listNoteTags()).toEqual([]);
      expect(store.listAllNotes()).toHaveLength(0);

      store.restoreDocument(document.id);
      expect(store.listNoteTags()).toEqual(expect.arrayContaining(['方法', '待读']));
      expect(store.listAllNotes()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('keeps standalone-note tags independent from document deletion', async () => {
    const store = storeAt('standalone-notes');
    try {
      const document = await importPdf(store, 'unrelated-doc');
      store.createNote({ documentId: '', page: 0, content: '独立笔记', tags: ['独立'] });
      store.deleteDocument(document.id);
      expect(store.listNoteTags()).toEqual(['独立']);
      expect(store.listAllNotes()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
