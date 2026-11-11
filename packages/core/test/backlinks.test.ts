import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-backlinks-'));
const token = 'test-token';

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
  pdf.addPage([300, 400]).drawText(`Backlink fixture ${label}`, { x: 40, y: 350, size: 16 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

describe('Store.listBacklinks', () => {
  it('note/annotation/document 三种反向链接，snippet 去 Markdown，边界不误命中', async () => {
    const store = storeAt('backlink-kinds');
    try {
      const target = await importPdf(store, 'target');
      const source = await importPdf(store, 'source');
      const targetNote = store.createNote({
        documentId: target.id,
        page: 0,
        content: '目标笔记正文'
      });
      const targetAnnotation = store.createAnnotation({
        documentId: target.id,
        page: 3,
        content: '目标批注正文',
        style: 'page'
      });
      const noteRef = store.createNote({
        documentId: source.id,
        page: 1,
        content: `看 [[note:${target.id}/${targetNote.id}|目标笔记]] 里的 **加粗**`
      });
      const noteRefNoLabel = store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[note:${target.id}/${targetNote.id}]]`
      });
      const noteRefUpper = store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[NOTE:${target.id}/${targetNote.id}|大写引用]]`
      });
      const annotationRef = store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[ann:${target.id}/${targetAnnotation.id}|目标批注]] 与 <c:#b23b2e>红字</c>`
      });
      const docRef = store.createNote({
        documentId: source.id,
        page: 1,
        content: `参见 [[doc:${target.id}|目标文献]] 全文`
      });
      store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[note:${target.id}/${targetNote.id}X]] 前缀不算引用`
      });
      store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[doc:${target.id}X|前缀不算]]`
      });
      const annotationAlias = store.createAnnotation({
        documentId: source.id,
        page: 8,
        content: `[[annotation:${target.id}/${targetAnnotation.id}]]`,
        style: 'page'
      });
      const docAnnotationRef = store.createAnnotation({
        documentId: source.id,
        page: 9,
        content: `[[document:${target.id}]]`,
        style: 'page'
      });
      const targetDocSelfNote = store.createNote({
        documentId: target.id,
        page: 1,
        content: `[[doc:${target.id}]]`
      });
      // 目标自身引用自己：必须被排除。
      store.updateNote(targetNote.id, {
        content: `[[note:${target.id}/${targetNote.id}]] 自引用`
      });
      store.updateAnnotation(targetAnnotation.id, {
        content: `[[ann:${target.id}/${targetAnnotation.id}]] 自引用`
      });

      const noteBacklinks = store.listBacklinks({
        kind: 'note',
        documentId: target.id,
        id: targetNote.id
      });
      const noteIds = noteBacklinks.map((record) => record.id);
      expect(noteIds).toEqual(
        expect.arrayContaining([noteRef.id, noteRefNoLabel.id, noteRefUpper.id])
      );
      // 目标笔记自身引用自己 → 排除；id 前缀 `...X]]` → 不算引用。
      expect(noteIds).not.toContain(targetNote.id);
      expect(noteIds).toHaveLength(3);
      for (const record of noteBacklinks) {
        expect(record.kind).toBe('note');
        expect(record.documentId).toBe(source.id);
        expect(record.documentName).toBe('source.pdf');
        expect(record.snippet).not.toContain('[[');
      }
      const labelSnippet = noteBacklinks.find((record) => record.id === noteRef.id);
      expect(labelSnippet?.snippet).toContain('目标笔记');
      expect(labelSnippet?.snippet).not.toContain('**');
      expect(labelSnippet?.page).toBe(1);

      const annotationBacklinks = store.listBacklinks({
        kind: 'annotation',
        documentId: target.id,
        id: targetAnnotation.id
      });
      expect(annotationBacklinks.map((record) => record.id).sort()).toEqual(
        [annotationRef.id, annotationAlias.id].sort()
      );
      expect(annotationBacklinks.map((record) => record.kind).sort()).toEqual([
        'annotation',
        'note'
      ]);
      const annotationSnippet = annotationBacklinks.find((record) => record.id === annotationRef.id);
      expect(annotationSnippet?.snippet).toContain('目标批注');
      expect(annotationSnippet?.snippet).not.toContain('<c:');
      expect(annotationSnippet?.snippet).toContain('红字');

      const documentBacklinks = store.listBacklinks({
        kind: 'document',
        documentId: target.id
      });
      const documentIds = documentBacklinks.map((record) => record.id);
      expect(documentIds).toEqual(
        expect.arrayContaining([docRef.id, docAnnotationRef.id, targetDocSelfNote.id])
      );
      expect(documentIds).not.toContain(noteRef.id);
      // 前缀 id 不算；任何来源的 snippet 都不应该包含「前缀不算」。
      expect(
        documentBacklinks.some((record) => record.snippet.includes('前缀不算'))
      ).toBe(false);
      expect(documentBacklinks.some((record) => record.id === docRef.id)).toBe(true);
      const trashedName = documentBacklinks.find((record) => record.id === targetDocSelfNote.id);
      expect(trashedName?.documentName).toBe('target.pdf');
    } finally {
      store.close();
    }
  });

  it('排除自身、删除的笔记不计入、回收站来源文献仍可读', async () => {
    const store = storeAt('backlink-trash');
    try {
      const target = await importPdf(store, 'trash-target');
      const source = await importPdf(store, 'trash-source');
      const targetNote = store.createNote({
        documentId: target.id,
        page: 1,
        content: '目标'
      });
      const trashedSourceNote = store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[note:${target.id}/${targetNote.id}|来自回收站]]`
      });
      const deletedNote = store.createNote({
        documentId: source.id,
        page: 1,
        content: `[[note:${target.id}/${targetNote.id}|已删除]]`
      });
      store.deleteNote(deletedNote.id);
      store.deleteDocument(source.id);

      const backlinks = store.listBacklinks({
        kind: 'note',
        documentId: target.id,
        id: targetNote.id
      });
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0]).toMatchObject({
        id: trashedSourceNote.id,
        documentId: source.id,
        documentName: 'trash-source.pdf',
        kind: 'note'
      });
      expect(backlinks[0]?.snippet).toContain('来自回收站');
    } finally {
      store.close();
    }
  });

  it('文档或目标 id 不存在时返回空数组', async () => {
    const store = storeAt('backlink-missing');
    try {
      const document = await importPdf(store, 'missing-doc');
      expect(store.listBacklinks({ kind: 'document', documentId: 'missing-document' })).toEqual([]);
      expect(
        store.listBacklinks({ kind: 'note', documentId: document.id, id: 'missing-note' })
      ).toEqual([]);
      // 没有 id 的 note/annotation 目标：没有可匹配目标，返回空。
      expect(store.listBacklinks({ kind: 'note', documentId: document.id })).toEqual([]);
      expect(store.listBacklinks({ kind: 'annotation', documentId: document.id })).toEqual([]);
      // 文档存在但没有任何引用。
      expect(store.listBacklinks({ kind: 'document', documentId: document.id })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('按 created 倒序，最多返回 100 条', async () => {
    const store = storeAt('backlink-limit');
    try {
      const target = await importPdf(store, 'limit-target');
      const source = await importPdf(store, 'limit-source');
      const older = store.createNote({
        documentId: source.id,
        page: 1,
        content: `较早 [[doc:${target.id}]]`
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newer = store.createNote({
        documentId: source.id,
        page: 1,
        content: `较新 [[doc:${target.id}]]`
      });
      const ordered = store.listBacklinks({ kind: 'document', documentId: target.id });
      expect(ordered.map((record) => record.id).slice(0, 2)).toEqual([newer.id, older.id]);

      for (let index = 0; index < 105; index += 1) {
        store.createNote({
          documentId: source.id,
          page: 1,
          content: `批量引用 ${index} [[doc:${target.id}]]`
        });
      }
      const limited = store.listBacklinks({ kind: 'document', documentId: target.id });
      expect(limited).toHaveLength(100);
    } finally {
      store.close();
    }
  });
});

describe('GET /api/v1/backlinks', () => {
  const dataDir = path.join(root, 'backlink-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('200 返回数组；kind=document 不需要 id', async () => {
    const target = await importPdf(store, 'http-target');
    const source = await importPdf(store, 'http-source');
    const note = store.createNote({ documentId: target.id, page: 1, content: '目标笔记' });
    store.createNote({
      documentId: source.id,
      page: 1,
      content: `[[note:${target.id}/${note.id}|引用]]`
    });
    store.createNote({
      documentId: source.id,
      page: 1,
      content: `[[doc:${target.id}|文献]]`
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/backlinks?kind=note&documentId=${encodeURIComponent(target.id)}&id=${encodeURIComponent(note.id)}`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const records = response.json() as Array<{
      kind: string;
      id: string;
      documentId: string;
      documentName: string;
      page: number;
      snippet: string;
    }>;
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]).toMatchObject({ kind: 'note', documentId: source.id, documentName: 'http-source.pdf' });

    const documentResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/backlinks?kind=document&documentId=${encodeURIComponent(target.id)}`,
      headers: headers()
    });
    expect(documentResponse.statusCode).toBe(200);
    expect((documentResponse.json() as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('kind 非法 / 缺 documentId / note 缺 id → 400，文档不存在 → 404', async () => {
    const target = await importPdf(store, 'http-missing-target');

    const invalidKind = await server.inject({
      method: 'GET',
      url: `/api/v1/backlinks?kind=chunk&documentId=${encodeURIComponent(target.id)}`,
      headers: headers()
    });
    expect(invalidKind.statusCode).toBe(400);
    expect((invalidKind.json() as { message: string }).message).toContain('kind');

    const missingDocument = await server.inject({
      method: 'GET',
      url: '/api/v1/backlinks?kind=document',
      headers: headers()
    });
    expect(missingDocument.statusCode).toBe(400);

    const missingId = await server.inject({
      method: 'GET',
      url: `/api/v1/backlinks?kind=note&documentId=${encodeURIComponent(target.id)}`,
      headers: headers()
    });
    expect(missingId.statusCode).toBe(400);
    expect((missingId.json() as { message: string }).message).toContain('id');

    const missingTarget = await server.inject({
      method: 'GET',
      url: '/api/v1/backlinks?kind=document&documentId=missing-document',
      headers: headers()
    });
    expect(missingTarget.statusCode).toBe(404);
  });
});
