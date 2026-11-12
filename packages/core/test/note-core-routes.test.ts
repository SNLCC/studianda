import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MarkdownImportDuplicatePreview, MarkdownImportReport } from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-core-routes-'));
const token = 'test-token';
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const vault = path.join(root, 'vault');
mkdirSync(vault, { recursive: true });

const store = new Store(dataDir);
const server = buildServer({
  token,
  version: 'test-version',
  store,
  secrets: new SecretStore()
});

const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('HTTP：独立笔记批量操作', () => {
  it('POST /notes/reorder：200 返回规范快照；非法参数 400', async () => {
    const first = store.createNote({ documentId: '', page: 0, content: '一' });
    const second = store.createNote({ documentId: '', page: 0, content: '二' });
    const reorder = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/reorder',
      headers: headers(),
      payload: { folderPath: '', ids: [second.id, first.id] }
    });
    expect(reorder.statusCode).toBe(200);
    const body = reorder.json() as {
      ok: boolean;
      folders: Array<{ path: string }>;
      notes: Array<{ id: string; folderPath: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.notes).toEqual([
      { id: second.id, folderPath: '' },
      { id: first.id, folderPath: '' }
    ]);
    expect(Array.isArray(body.folders)).toBe(true);
    expect(store.listStandaloneNotes().map((note) => note.id)).toEqual([second.id, first.id]);

    const missingFolder = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/reorder',
      headers: headers(),
      payload: { ids: [] }
    });
    expect(missingFolder.statusCode).toBe(400);
    expect((missingFolder.json() as { message: string }).message).toContain('文件夹路径');

    const badIds = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/reorder',
      headers: headers(),
      payload: { folderPath: '', ids: 'not-array' }
    });
    expect(badIds.statusCode).toBe(400);
    expect((badIds.json() as { message: string }).message).toContain('ids');
  });

  it('POST /notes/batch-delete：200 返回实际删除数；非法参数 400', async () => {
    const first = store.createNote({ documentId: '', page: 0, content: '删一' });
    const second = store.createNote({ documentId: '', page: 0, content: '删二' });
    const deleted = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/batch-delete',
      headers: headers(),
      payload: { ids: [first.id, second.id] }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, deleted: 2 });

    const badIds = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/batch-delete',
      headers: headers(),
      payload: { ids: [1, 2] }
    });
    expect(badIds.statusCode).toBe(400);
  });

  it('POST /notes/batch-move：200 返回 moved；目标不存在/非法参数 400', async () => {
    store.createNoteFolder('moved/target');
    const note = store.createNote({ documentId: '', page: 0, content: '待移动' });
    const moved = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/batch-move',
      headers: headers(),
      payload: { ids: [note.id], folderPath: 'moved/target' }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ ok: true, moved: 1 });
    expect(store.getNote(note.id)?.folderPath).toBe('moved/target');

    const missingTarget = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/batch-move',
      headers: headers(),
      payload: { ids: [note.id], folderPath: 'missing/folder' }
    });
    expect(missingTarget.statusCode).toBe(400);
    expect((missingTarget.json() as { message: string }).message).toContain('目标文件夹不存在');

    const badFolder = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/batch-move',
      headers: headers(),
      payload: { ids: [note.id] }
    });
    expect(badFolder.statusCode).toBe(400);
  });
});

describe('HTTP：Markdown 导入重复预览与策略', () => {
  beforeAll(() => {
    writeFileSync(path.join(vault, 'note.md'), '原始内容\n');
  });

  it('POST /markdown/import/preview：200 返回重复项；非法参数 400', async () => {
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import',
      headers: headers(),
      payload: { vaultPath: vault, files: ['note.md'] }
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as MarkdownImportReport).imported).toBe(1);

    const preview = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/preview',
      headers: headers(),
      payload: { vaultPath: vault, files: ['note.md'] }
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as MarkdownImportDuplicatePreview;
    expect(body.total).toBe(1);
    expect(body.alreadyImported).toBe(1);
    expect(body.newCount).toBe(0);
    expect(body.items[0]).toMatchObject({ relativePath: 'note.md', title: 'note' });

    const missingVault = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/preview',
      headers: headers(),
      payload: { files: ['note.md'] }
    });
    expect(missingVault.statusCode).toBe(400);

    const badFiles = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/preview',
      headers: headers(),
      payload: { vaultPath: vault, files: 'not-array' }
    });
    expect(badFiles.statusCode).toBe(400);

    const missingDir = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/preview',
      headers: headers(),
      payload: { vaultPath: path.join(vault, 'not-exist'), files: ['note.md'] }
    });
    expect(missingDir.statusCode).toBe(400);
  });

  it('POST /markdown/import 支持 duplicatePolicy=skip；非法策略 400', async () => {
    writeFileSync(path.join(vault, 'note.md'), '修改后的内容\n');
    const skipped = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import',
      headers: headers(),
      payload: { vaultPath: vault, files: ['note.md'], duplicatePolicy: 'skip' }
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json()).toMatchObject({
      imported: 0,
      updated: 0,
      skipped: 1,
      skippedExisting: 1
    });

    const badPolicy = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import',
      headers: headers(),
      payload: { vaultPath: vault, files: ['note.md'], duplicatePolicy: 'replace' }
    });
    expect(badPolicy.statusCode).toBe(400);
    expect((badPolicy.json() as { message: string }).message).toContain('duplicatePolicy');

    const badStartPolicy = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/start',
      headers: headers(),
      payload: { vaultPath: vault, files: ['note.md'], duplicatePolicy: 'merge' }
    });
    expect(badStartPolicy.statusCode).toBe(400);
  });
});
