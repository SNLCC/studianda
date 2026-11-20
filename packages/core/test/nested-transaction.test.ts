import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-nested-tx-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('可嵌套事务（SAVEPOINT）', () => {
  it('外层事务里调用自带事务的 createNote：成功时一起提交', () => {
    const created = store.withTransaction(() =>
      store.createNote({ documentId: '', page: 0, content: '嵌套提交' })
    );
    expect(created.id).toBeTruthy();
    expect(store.listStandaloneNotes().some((note) => note.id === created.id)).toBe(true);
  });

  it('外层事务抛错：内层 createNote 一起回滚', () => {
    const before = store.listStandaloneNotes().length;
    expect(() =>
      store.withTransaction(() => {
        store.createNote({ documentId: '', page: 0, content: '应当回滚' });
        throw new Error('外层失败');
      })
    ).toThrow('外层失败');
    expect(store.listStandaloneNotes().length).toBe(before);
  });

  it('内层领域写失败只回滚自己，外层仍可继续提交', () => {
    const before = store.listStandaloneNotes().length;
    const created = store.withTransaction(() => {
      try {
        store.createNote({ documentId: 'missing-doc', page: 1, content: '文档不存在' });
      } catch {
        // 内层回滚后继续写独立笔记
      }
      return store.createNote({ documentId: '', page: 0, content: '外层继续' });
    });
    expect(store.listStandaloneNotes().length).toBe(before + 1);
    expect(store.listStandaloneNotes().some((note) => note.id === created.id)).toBe(true);
  });
});
