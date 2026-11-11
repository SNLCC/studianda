import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-folder-'));
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
  pdf.addPage([300, 400]).drawText(`Folder fixture ${label}`, { x: 40, y: 350, size: 16 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

function schemaVersion(store: Store): string {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return String(row?.value ?? '');
}

describe('notes.folder_path（schema 11）', () => {
  it('迁移 v10 → 11 增加 folder_path 且幂等；新库直接为 11', () => {
    const dir = path.join(root, 'migrate-v10');
    mkdirSync(dir, { recursive: true });
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    raw.exec('CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT)');
    raw.exec("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '10')");
    raw.exec(
      `CREATE TABLE notes(
         id TEXT PRIMARY KEY,
         document_id TEXT,
         page INTEGER,
         quote TEXT,
         content TEXT,
         external_key TEXT DEFAULT '',
         created TEXT DEFAULT CURRENT_TIMESTAMP,
         deleted INTEGER DEFAULT 0
       )`
    );
    raw.exec("INSERT INTO notes(id, document_id, page, quote, content, external_key) VALUES ('legacy-note', '', 0, '', '旧内容', '')");
    raw.close();

    const store = new Store(dir);
    try {
      expect(schemaVersion(store)).toBe('18');
      const db = (store as unknown as { db: DatabaseSync }).db;
      const columns = (db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).toContain('folder_path');
      const note = store.listStandaloneNotes().find((item) => item.id === 'legacy-note')!;
      expect(note.folderPath).toBe('');
      // 迁移后的笔记也能写 folderPath。
      store.updateNote('legacy-note', { folderPath: 'old/imported' });
      expect(store.getNote('legacy-note')?.folderPath).toBe('old/imported');
    } finally {
      store.close();
    }
    // 幂等：再打开版本仍是 11，folder_path 数据保留。
    const reopened = new Store(dir);
    try {
      expect(schemaVersion(reopened)).toBe('18');
      expect(reopened.getNote('legacy-note')?.folderPath).toBe('old/imported');
    } finally {
      reopened.close();
    }
  });

  it('createNote/updateNote/list 支持并校验 folderPath', async () => {
    const store = storeAt('folder-crud');
    try {
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '根目录笔记',
        folderPath: 'projects/阅读'
      });
      expect(note.folderPath).toBe('projects/阅读');
      expect(note.documentId).toBe('');

      // 规范化：反斜杠/首尾斜杠/重复斜杠；空 → ''。
      const normalized = store.createNote({
        documentId: '',
        page: 0,
        content: '规范化',
        folderPath: '\\a\\\\b\\'
      });
      expect(normalized.folderPath).toBe('a/b');
      const rootNote = store.createNote({ documentId: '', page: 0, content: '根' });
      expect(rootNote.folderPath).toBe('');

      const listed = store.listStandaloneNotes();
      expect(listed.find((item) => item.id === note.id)?.folderPath).toBe('projects/阅读');
      expect(listed.find((item) => item.id === rootNote.id)?.folderPath).toBe('');

      // updateNote：显式改 folderPath；不传时保留原值。
      const updated = store.updateNote(note.id, { folderPath: 'moved/sub' });
      expect(updated.folderPath).toBe('moved/sub');
      const contentOnly = store.updateNote(note.id, { content: '只改内容' });
      expect(contentOnly.folderPath).toBe('moved/sub');

      // 非法路径。
      expect(() => store.createNote({ documentId: '', page: 0, content: 'x', folderPath: '..' })).toThrow(
        '文件夹路径无效'
      );
      expect(() =>
        store.createNote({ documentId: '', page: 0, content: 'x', folderPath: 'a/../b' })
      ).toThrow('文件夹路径无效');
      expect(() => store.updateNote(note.id, { folderPath: 'a/../../b' })).toThrow(
        '文件夹路径无效'
      );
      expect(() => store.createNote({ documentId: '', page: 0, content: 'x', folderPath: 'a\u0000b' })).toThrow(
        '文件夹路径无效'
      );
      expect(() =>
        store.createNote({
          documentId: '',
          page: 0,
          content: 'x',
          folderPath: 'a'.repeat(241)
        })
      ).toThrow('文件夹路径过长');

      // 文献笔记默认 ''，也可设置（Zotero/普通笔记默认空）。
      const document = await importPdf(store, 'folder-doc');
      const documentNote = store.createNote({
        documentId: document.id,
        page: 0,
        content: '文献笔记'
      });
      expect(documentNote.folderPath).toBe('');
      expect(store.listNotes(document.id)[0]?.folderPath).toBe('');
    } finally {
      store.close();
    }
  });
});

describe('HTTP PATCH /notes/:id folderPath', () => {
  const dataDir = path.join(root, 'http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });
  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  it('PATCH 设置/更新文件夹；非法 400', async () => {
    const note = store.createNote({ documentId: '', page: 0, content: 'HTTP 笔记' });
    const patched = await server.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${encodeURIComponent(note.id)}`,
      headers: headers(),
      payload: { folderPath: 'inbox/2026' }
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { folderPath: string }).folderPath).toBe('inbox/2026');

    const bad = await server.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${encodeURIComponent(note.id)}`,
      headers: headers(),
      payload: { folderPath: '../escape' }
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { message: string }).message).toContain('文件夹路径无效');
  });
});
