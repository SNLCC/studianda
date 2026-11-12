import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-note-folder-implicit-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function dbOf(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

/** 模拟「隐式文件夹」旧数据：笔记已有 folder_path，但 note_folders 里没有对应行。 */
function dropNoteFolderRows(store: Store): void {
  dbOf(store).exec('DELETE FROM note_folders');
}

function folderPaths(store: Store): string[] {
  return store.listNoteFolders().map((folder) => folder.path);
}

describe('隐式文件夹（Markdown 导入直接写入 folder_path 的目录）', () => {
  it('listNoteFolders 包含 notes.folder_path 的路径及祖先；noteCount 只统计未删除', () => {
    const store = storeAt('implicit-list');
    try {
      store.createNote({ documentId: '', page: 0, content: '深层', folderPath: 'imp/deep/leaf' });
      const trashed = store.createNote({
        documentId: '',
        page: 0,
        content: '回收站',
        folderPath: 'imp/other'
      });
      store.deleteNote(trashed.id);
      dropNoteFolderRows(store);

      const folders = store.listNoteFolders();
      expect(folders.map((folder) => folder.path)).toEqual([
        'imp',
        'imp/deep',
        'imp/deep/leaf',
        'imp/other'
      ]);
      const countOf = (folder: string): number =>
        folders.find((item) => item.path === folder)?.noteCount ?? -1;
      expect(countOf('imp/deep/leaf')).toBe(1);
      // 回收站里的笔记路径仍作为文件夹出现，但不计入 noteCount。
      expect(countOf('imp/other')).toBe(0);
      expect(countOf('imp')).toBe(0);
      expect(countOf('imp/deep')).toBe(0);
    } finally {
      store.close();
    }
  });

  it('隐式文件夹可重命名（rename 允许 from 不存在于 note_folders）', () => {
    const store = storeAt('implicit-rename');
    try {
      const a = store.createNote({ documentId: '', page: 0, content: 'A', folderPath: 'implicit/a' });
      const b = store.createNote({ documentId: '', page: 0, content: 'B', folderPath: 'implicit/b' });
      dropNoteFolderRows(store);

      const result = store.renameNoteFolder('implicit', 'renamed');
      expect(result).toMatchObject({ ok: true, movedNotes: 2 });
      expect(store.getNote(a.id)?.folderPath).toBe('renamed/a');
      expect(store.getNote(b.id)?.folderPath).toBe('renamed/b');
      expect(folderPaths(store)).toEqual(['renamed', 'renamed/a', 'renamed/b']);
    } finally {
      store.close();
    }
  });

  it('隐式文件夹可作为 batchMove 目标（含祖先隐式路径）', () => {
    const store = storeAt('implicit-batch-target');
    try {
      const anchor = store.createNote({
        documentId: '',
        page: 0,
        content: '锚点',
        folderPath: 'implicitTarget/inside'
      });
      const moving = store.createNote({ documentId: '', page: 0, content: '待移动' });
      dropNoteFolderRows(store);

      // 'implicitTarget' 只是更深路径的祖先，也是隐式存在的。
      const result = store.batchMoveStandaloneNotes([moving.id, 'missing-note'], 'implicitTarget');
      expect(result.ok).toBe(true);
      expect(result.moved).toBe(1);
      expect(store.getNote(moving.id)?.folderPath).toBe('implicitTarget');
      expect(store.getNote(anchor.id)?.folderPath).toBe('implicitTarget/inside');
    } finally {
      store.close();
    }
  });

  it('deleteNoteFolder 删除隐式子树：直接笔记移到父级、子文件夹上移一级、回收站笔记也移动', () => {
    const store = storeAt('implicit-delete');
    try {
      const direct = store.createNote({ documentId: '', page: 0, content: '直接', folderPath: 'p/a' });
      const child = store.createNote({
        documentId: '',
        page: 0,
        content: '子级',
        folderPath: 'p/a/sub'
      });
      const deep = store.createNote({
        documentId: '',
        page: 0,
        content: '深层',
        folderPath: 'p/a/sub/deep'
      });
      const trashed = store.createNote({
        documentId: '',
        page: 0,
        content: '回收站',
        folderPath: 'p/a'
      });
      store.deleteNote(trashed.id);
      dropNoteFolderRows(store);

      const result = store.deleteNoteFolder('p/a');
      expect(result).toMatchObject({ ok: true, movedNotes: 3, movedDeletedNotes: 1 });
      expect(store.getNote(direct.id)?.folderPath).toBe('p');
      expect(store.getNote(child.id)?.folderPath).toBe('p/sub');
      expect(store.getNote(deep.id)?.folderPath).toBe('p/sub/deep');
      expect(
        store.listStandaloneNotes(true).find((note) => note.id === trashed.id)?.folderPath
      ).toBe('p');
      const paths = folderPaths(store);
      expect(paths).not.toContain('p/a');
      expect(paths).toContain('p');
      expect(paths).toContain('p/sub');
      expect(paths).toContain('p/sub/deep');
    } finally {
      store.close();
    }
  });

  it('删除仅作为祖先存在的隐式文件夹：更深路径整体上移一级', () => {
    const store = storeAt('implicit-ancestor-delete');
    try {
      const note = store.createNote({ documentId: '', page: 0, content: '深层', folderPath: 'anc/b/c' });
      dropNoteFolderRows(store);
      // 'anc' 只出现在 note 的 folder_path 前缀里。
      const result = store.deleteNoteFolder('anc');
      expect(result).toMatchObject({ ok: true, movedNotes: 1 });
      expect(store.getNote(note.id)?.folderPath).toBe('b/c');
      expect(folderPaths(store)).toEqual(['b', 'b/c']);
    } finally {
      store.close();
    }
  });

  it('不存在的文件夹删除报错；不存在的目标不能批量移动', () => {
    const store = storeAt('implicit-errors');
    try {
      expect(() => store.deleteNoteFolder('missing/folder')).toThrow('文件夹不存在');
      const note = store.createNote({ documentId: '', page: 0, content: 'N' });
      expect(() => store.batchMoveStandaloneNotes([note.id], 'missing/folder')).toThrow(
        '目标文件夹不存在'
      );
    } finally {
      store.close();
    }
  });
});

describe('独立笔记批量操作', () => {
  it('batchDeleteStandaloneNotes 计数、幂等，只影响独立笔记', () => {
    const store = storeAt('batch-delete');
    try {
      const first = store.createNote({ documentId: '', page: 0, content: '一' });
      const second = store.createNote({ documentId: '', page: 0, content: '二' });
      const kept = store.createNote({ documentId: '', page: 0, content: '三' });

      const result = store.batchDeleteStandaloneNotes([first.id, second.id, first.id, 'missing']);
      expect(result).toEqual({ ok: true, deleted: 2 });
      expect(store.listStandaloneNotes().map((note) => note.id)).toEqual([kept.id]);
      expect(store.listStandaloneNotes(true).map((note) => note.id).sort()).toEqual(
        [first.id, second.id].sort()
      );

      // 幂等：已经删除的不再计数。
      expect(store.batchDeleteStandaloneNotes([first.id, second.id])).toEqual({
        ok: true,
        deleted: 0
      });
      expect(store.listStandaloneNotes(true)).toHaveLength(2);

      // 参数校验。
      expect(() => store.batchDeleteStandaloneNotes('not-array' as unknown as string[])).toThrow(
        '需要笔记 id 字符串数组'
      );
    } finally {
      store.close();
    }
  });

  it('batchMoveStandaloneNotes 移动计数并把笔记放入目标文件夹', () => {
    const store = storeAt('batch-move');
    try {
      store.createNoteFolder('target/nested');
      const first = store.createNote({ documentId: '', page: 0, content: '一' });
      const second = store.createNote({ documentId: '', page: 0, content: '二' });
      const trashed = store.createNote({ documentId: '', page: 0, content: '回收站' });
      store.deleteNote(trashed.id);

      const moved = store.batchMoveStandaloneNotes(
        [first.id, second.id, trashed.id, 'missing'],
        'target/nested'
      );
      expect(moved.ok).toBe(true);
      // 回收站笔记不算移动（只统计未删除）。
      expect(moved.moved).toBe(2);
      expect(moved.notes).toEqual([
        { id: first.id, folderPath: 'target/nested' },
        { id: second.id, folderPath: 'target/nested' }
      ]);
      expect(store.getNote(first.id)?.folderPath).toBe('target/nested');
      expect(store.listNoteFolders().find((folder) => folder.path === 'target/nested')?.noteCount).toBe(
        2
      );

      // 移到根目录。
      expect(store.batchMoveStandaloneNotes([first.id], '')).toMatchObject({
        ok: true,
        moved: 1
      });
      expect(store.getNote(first.id)?.folderPath).toBe('');
    } finally {
      store.close();
    }
  });
});
