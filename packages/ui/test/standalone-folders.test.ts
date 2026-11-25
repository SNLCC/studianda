/**
 * 独立笔记侧栏「文件夹导航 + 标签导航」的纯函数口径。
 *
 * 钉住两件事：
 * 1. 文件夹计数含子文件夹（点父文件夹能看到子文件夹里的笔记）；
 * 2. 标签计数按当前文件夹范围统计，选中标签后不改变其他标签的计数（不做自吞）。
 */
import { describe, expect, it } from 'vitest';
import type { NoteRecord } from '@studianda/shared';
import {
  buildStandaloneFolderTree,
  countStandaloneNotesByFolder,
  countStandaloneTags,
  filterStandaloneNotesByTags,
  findStandaloneFolder,
  standaloneNoteInFolder
} from '../src/standalone-folders';

function note(
  id: string,
  folderPath: string,
  tags: string[] = []
): NoteRecord {
  return {
    id,
    documentId: '',
    page: 0,
    quote: '',
    content: id,
    tags,
    folderPath,
    created: '2026-11-01T00:00:00.000Z'
  } as NoteRecord;
}

describe('standaloneNoteInFolder', () => {
  const notes = [note('root', ''), note('a', 'a'), note('a-b', 'a/b'), note('ab', 'ab')];

  it('空路径只匹配根目录的直接笔记', () => {
    expect(notes.filter((item) => standaloneNoteInFolder(item, '')).map((item) => item.id)).toEqual([
      'root'
    ]);
  });

  it('父文件夹包含子文件夹，但不误匹配同名前缀（ab）', () => {
    expect(notes.filter((item) => standaloneNoteInFolder(item, 'a')).map((item) => item.id)).toEqual([
      'a',
      'a-b'
    ]);
    expect(notes.filter((item) => standaloneNoteInFolder(item, 'a/b')).map((item) => item.id)).toEqual([
      'a-b'
    ]);
  });

  it('反斜杠与首尾斜杠按同一路径处理', () => {
    expect(standaloneNoteInFolder({ folderPath: 'a\\b\\' }, 'a/b')).toBe(true);
  });
});

describe('countStandaloneNotesByFolder', () => {
  it('子文件夹的笔记同时计入祖先；根目录不计入', () => {
    const counts = countStandaloneNotesByFolder([
      note('root', ''),
      note('a', 'a'),
      note('a-b', 'a/b'),
      note('a-b-c', 'a/b/c'),
      note('other', 'other')
    ]);
    expect([...counts.entries()].sort()).toEqual([
      ['a', 3],
      ['a/b', 2],
      ['a/b/c', 1],
      ['other', 1]
    ]);
  });
});

describe('countStandaloneTags', () => {
  it('按笔记去重计数，忽略空白标签', () => {
    const counts = countStandaloneTags([
      note('one', '', ['方法', ' 方法 ', '']),
      note('two', 'a', ['方法', '写作'])
    ]);
    expect([...counts.entries()].sort()).toEqual([
      ['写作', 1],
      ['方法', 2]
    ]);
  });

  it('配合文件夹范围使用时只统计范围内的笔记', () => {
    const inFolder = [note('a', 'a', ['方法']), note('a-b', 'a/b', ['写作'])].filter((item) =>
      standaloneNoteInFolder(item, 'a')
    );
    expect([...countStandaloneTags(inFolder).entries()].sort()).toEqual([
      ['写作', 1],
      ['方法', 1]
    ]);
  });
});

describe('findStandaloneFolder', () => {
  it('按路径找到节点（含空文件夹），找不到返回 null', () => {
    const tree = buildStandaloneFolderTree([note('a-b', 'a/b')], ['empty/x']);
    expect(findStandaloneFolder(tree, '')?.path).toBe('');
    expect(findStandaloneFolder(tree, 'a/b')?.name).toBe('b');
    expect(findStandaloneFolder(tree, 'empty/x')?.totalCount).toBe(0);
    expect(findStandaloneFolder(tree, 'missing')).toBeNull();
  });
});

describe('filterStandaloneNotesByTags', () => {
  it('空筛选返回全部；否则命中任一标签', () => {
    const notes = [note('a', '', ['方法']), note('b', '', ['写作']), note('c', '', [])];
    expect(filterStandaloneNotesByTags(notes, new Set())).toBe(notes);
    expect(
      filterStandaloneNotesByTags(notes, new Set(['方法', '写作'])).map((item) => item.id)
    ).toEqual(['a', 'b']);
  });
});
