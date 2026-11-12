import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-standalone-notes-'));
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
  pdf.addPage([300, 400]).drawText(`Standalone note fixture ${label}`, { x: 40, y: 350, size: 16 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

describe('Store 独立笔记（document_id=""）', () => {
  it('createNote(documentId="") 创建独立笔记：page 固定 0、quote 清空、不需要文献存在', () => {
    const store = storeAt('standalone-create');
    try {
      const note = store.createNote({
        documentId: '',
        page: 0,
        quote: '不应保留的原文',
        content: '  ## 独立笔记标题  '
      });
      expect(note).toMatchObject({
        documentId: '',
        page: 0,
        quote: '',
        content: '## 独立笔记标题'
      });
      expect(note.id).not.toBe('');
      expect(typeof note.created).toBe('string');
      expect(store.getNote(note.id)).toMatchObject({ id: note.id, documentId: '' });

      // 传入非法页码也不影响独立笔记：不校验文献页数，page 永远保存 0。
      const noPage = store.createNote({ documentId: '', page: 999, content: '页码被忽略' });
      expect(noPage.page).toBe(0);
    } finally {
      store.close();
    }
  });

  it('listStandaloneNotes 只返回独立笔记（不混入文献笔记），手动排序位置升序', async () => {
    const store = storeAt('standalone-list');
    try {
      const document = await importPdf(store, 'list-doc');
      const documentNote = store.createNote({
        documentId: document.id,
        page: 1,
        content: '文献笔记'
      });
      const older = store.createNote({ documentId: '', page: 0, content: '较早的独立笔记' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newer = store.createNote({ documentId: '', page: 0, content: '较新的独立笔记' });

      const list = store.listStandaloneNotes();
      // schema 19：新建笔记追加到文件夹末尾（MAX(manual_order)+1），默认按创建先后排列。
      expect(list.map((note) => note.id)).toEqual([older.id, newer.id]);
      expect(list.map((note) => note.documentId)).toEqual(['', '']);
      expect(list.map((note) => note.id)).not.toContain(documentNote.id);
      // 文献笔记列表也不混入独立笔记。
      expect(store.listNotes(document.id).map((note) => note.id)).toEqual([documentNote.id]);
      expect(store.getNote(documentNote.id)?.documentId).toBe(document.id);
    } finally {
      store.close();
    }
  });

  it('updateNote 对独立笔记跳过 getDocument 校验：page 忽略、quote/content 可改', () => {
    const store = storeAt('standalone-update');
    try {
      const note = store.createNote({ documentId: '', page: 0, content: '旧内容' });
      const updated = store.updateNote(note.id, {
        page: 7,
        quote: '摘录',
        content: '  **新内容**  '
      });
      expect(updated).toMatchObject({
        id: note.id,
        documentId: '',
        page: 0,
        quote: '摘录',
        content: '**新内容**'
      });
      expect(() => store.updateNote('missing-note', { content: 'x' })).toThrow('笔记不存在');

      // 删除后 getNote 为 null、列表里也没有；恢复后回来。
      store.deleteNote(note.id);
      expect(store.getNote(note.id)).toBeNull();
      expect(store.listStandaloneNotes()).toEqual([]);
      store.restoreNote(note.id);
      expect(store.getNote(note.id)?.content).toBe('**新内容**');
    } finally {
      store.close();
    }
  });
});

describe('独立笔记的内部引用与反向链接', () => {
  it('[[note:<noteId>]]（无斜杠）反链：独立→独立、文献笔记→独立、独立→文献笔记', async () => {
    const store = storeAt('standalone-backlinks');
    try {
      const document = await importPdf(store, 'backlink-doc');
      const documentNote = store.createNote({
        documentId: document.id,
        page: 1,
        content: '文献笔记正文'
      });
      const target = store.createNote({ documentId: '', page: 0, content: '独立笔记目标' });

      const fromStandaloneLabel = store.createNote({
        documentId: '',
        page: 0,
        content: `参见 [[note:${target.id}|独立引用]] 与 **加粗**`
      });
      const fromStandaloneNoLabel = store.createNote({
        documentId: '',
        page: 0,
        content: `[[note:${target.id}]]`
      });
      const fromStandaloneUpper = store.createNote({
        documentId: '',
        page: 0,
        content: `[[NOTE:${target.id}|大写引用]]`
      });
      store.createNote({
        documentId: '',
        page: 0,
        content: `[[note:${target.id}X]] 前缀不算引用`
      });
      const fromDocumentNote = store.createNote({
        documentId: document.id,
        page: 1,
        content: `文献侧引用 [[note:${target.id}|从文献笔记引用]]`
      });
      // 目标自身引用自己 → 排除。
      store.updateNote(target.id, { content: `[[note:${target.id}]] 自引用` });

      const backlinks = store.listBacklinks({
        kind: 'note',
        documentId: '',
        id: target.id
      });
      const ids = backlinks.map((record) => record.id);
      expect(ids).toEqual(
        expect.arrayContaining([fromStandaloneLabel.id, fromStandaloneNoLabel.id, fromStandaloneUpper.id, fromDocumentNote.id])
      );
      expect(ids).not.toContain(target.id);
      expect(backlinks).toHaveLength(4);

      const standaloneRecords = backlinks.filter((record) => record.documentId === '');
      expect(standaloneRecords.length).toBe(3);
      for (const record of standaloneRecords) {
        expect(record.kind).toBe('note');
        expect(record.documentName).toBe('独立笔记');
        expect(record.page).toBe(0);
      }
      const documentRecord = backlinks.find((record) => record.id === fromDocumentNote.id);
      expect(documentRecord).toMatchObject({
        documentId: document.id,
        documentName: 'backlink-doc.pdf',
        page: 1
      });
      const labelled = backlinks.find((record) => record.id === fromStandaloneLabel.id);
      expect(labelled?.snippet).toContain('独立引用');
      expect(labelled?.snippet).not.toContain('**');
      expect(labelled?.snippet).not.toContain('[[');

      // 独立笔记 → 文献笔记：来源是独立笔记时 documentName='独立笔记'。
      const fromStandaloneToDocumentNote = store.createNote({
        documentId: '',
        page: 0,
        content: `[[note:${document.id}/${documentNote.id}|引用文献笔记]]`
      });
      const documentNoteBacklinks = store.listBacklinks({
        kind: 'note',
        documentId: document.id,
        id: documentNote.id
      });
      expect(documentNoteBacklinks.map((record) => record.id)).toContain(
        fromStandaloneToDocumentNote.id
      );
      const source = documentNoteBacklinks.find(
        (record) => record.id === fromStandaloneToDocumentNote.id
      );
      expect(source).toMatchObject({ kind: 'note', documentId: '', documentName: '独立笔记' });

      // 独立笔记引用文献（[[doc:…]]）的反链同样可读。
      const standaloneDocRef = store.createNote({
        documentId: '',
        page: 0,
        content: `[[doc:${document.id}|独立笔记引用文献]]`
      });
      const documentBacklinks = store.listBacklinks({ kind: 'document', documentId: document.id });
      const docSource = documentBacklinks.find((record) => record.id === standaloneDocRef.id);
      expect(docSource).toMatchObject({ documentId: '', documentName: '独立笔记', kind: 'note' });
    } finally {
      store.close();
    }
  });

  it('独立笔记目标缺 id 或不存在时返回空；不会误报 404 所需的存在性检查', () => {
    const store = storeAt('standalone-backlink-missing');
    try {
      expect(store.listBacklinks({ kind: 'note', documentId: '', id: '' })).toEqual([]);
      expect(store.listBacklinks({ kind: 'note', documentId: '', id: 'missing-note' })).toEqual(
        []
      );
      // 独立笔记目标不会因为 documents 表没有 '' 记录而提前返回空：有引用就能返回。
      const target = store.createNote({ documentId: '', page: 0, content: '目标' });
      store.createNote({ documentId: '', page: 0, content: `[[note:${target.id}]]` });
      expect(store.listBacklinks({ kind: 'note', documentId: '', id: target.id })).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe('独立笔记 HTTP 路由', () => {
  const dataDir = path.join(root, 'standalone-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('GET /notes/standalone + POST /notes 允许空 documentId 与缺省 page', async () => {
    const empty = await server.inject({
      method: 'GET',
      url: '/api/v1/notes/standalone',
      headers: headers()
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId: '', page: 0, content: 'API 独立笔记' }
    });
    expect(created.statusCode).toBe(200);
    const note = created.json() as {
      id: string;
      documentId: string;
      page: number;
      quote: string;
      content: string;
    };
    expect(note).toMatchObject({ documentId: '', page: 0, quote: '', content: 'API 独立笔记' });

    // 不给 documentId/page 也能创建独立笔记（page 缺省 0）。
    const defaults = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { content: '缺省参数独立笔记' }
    });
    expect(defaults.statusCode).toBe(200);
    expect((defaults.json() as { documentId: string; page: number }).documentId).toBe('');
    expect((defaults.json() as { documentId: string; page: number }).page).toBe(0);

    const listed = await server.inject({
      method: 'GET',
      url: '/api/v1/notes/standalone',
      headers: headers()
    });
    expect(listed.statusCode).toBe(200);
    const notes = listed.json() as Array<{ id: string; documentId: string }>;
    expect(notes.map((item) => item.id)).toEqual(
      expect.arrayContaining([note.id, (defaults.json() as { id: string }).id])
    );
    expect(notes.every((item) => item.documentId === '')).toBe(true);

    // PATCH / DELETE 对独立笔记可用。
    const updated = await server.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${note.id}`,
      headers: headers(),
      payload: { page: 5, content: '改过的独立笔记' }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      documentId: '',
      page: 0,
      content: '改过的独立笔记'
    });

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/notes/${note.id}`,
      headers: headers()
    });
    expect(removed.statusCode).toBe(204);
    const afterDelete = await server.inject({
      method: 'GET',
      url: '/api/v1/notes/standalone',
      headers: headers()
    });
    expect((afterDelete.json() as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      note.id
    );
  });

  it('POST /notes 非法参数 400；独立笔记反链路由不 404', async () => {
    const badDocument = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId: 123, page: 0, content: 'x' }
    });
    expect(badDocument.statusCode).toBe(400);

    const badPage = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId: '', page: 2, content: 'x' }
    });
    expect(badPage.statusCode).toBe(400);

    const nonIntegerPage = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId: '', page: 1.5, content: 'x' }
    });
    expect(nonIntegerPage.statusCode).toBe(400);

    // 独立笔记反链：documentId 为空串不应触发「文献不存在」404。
    const target = store.createNote({ documentId: '', page: 0, content: '路由反链目标' });
    const source = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId: '', content: `[[note:${target.id}|路由引用]]` }
    });
    expect(source.statusCode).toBe(200);

    const backlinks = await server.inject({
      method: 'GET',
      url: `/api/v1/backlinks?kind=note&documentId=&id=${encodeURIComponent(target.id)}`,
      headers: headers()
    });
    expect(backlinks.statusCode).toBe(200);
    const records = backlinks.json() as Array<{
      id: string;
      documentId: string;
      documentName: string;
      kind: string;
    }>;
    expect(records.map((record) => record.id)).toContain(
      (source.json() as { id: string }).id
    );
    expect(records[0]).toMatchObject({ kind: 'note', documentId: '', documentName: '独立笔记' });

    // 仍缺 id 的独立笔记/文献笔记请求保持 400。
    const missingId = await server.inject({
      method: 'GET',
      url: '/api/v1/backlinks?kind=note&documentId=',
      headers: headers()
    });
    expect(missingId.statusCode).toBe(400);
  });
});
