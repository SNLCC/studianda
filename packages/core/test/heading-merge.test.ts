import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * 跨行标题合并的回归。
 *
 * 版面把一条长标题折成两三行时，每行都会被识别成独立 heading 块：
 * `「…第一行」` + `「第二行」` 会变成两个章节。合并只认版面/文本形状，不做语义猜测，
 * 所以既要有"合并成功"的断言，也要有"不该合并的没被合并"的断言。
 */

// 样张都提交在 test/fixtures/ 下（见 fixtures/README.md），干净 clone 与 CI 里同样存在。
const DEMO = path.resolve(import.meta.dirname, 'fixtures/demo-paper/demo-paper-01.pdf');
const TWO_COLUMN = path.resolve(import.meta.dirname, 'fixtures/two-column-paper.pdf');
const PAPER = path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-heading-merge-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function sectionsOf(pdf: string, name: string) {
  const doc = await store.importDocument(pdf, name, true);
  return (await store.getDocumentBlocks(doc.id)).sections;
}

describe('跨行标题合并', () => {
  it('把折成两行的中文标题接回一条（「…第一行」+「第二行」）', async () => {
    const sections = await sectionsOf(DEMO, 'merge-demo');
    const title = sections[0]!;
    expect(title.title).toContain('样张标题第一行');
    expect(title.title.endsWith('第二行')).toBe(true);
    // 合并之后标题页只应剩一个前置节（原来两行标题各成一节）。
    expect(sections.filter((section) => section.kind === 'front')).toHaveLength(1);
  });

  it('不把带编号的相邻标题并进上一条', async () => {
    const sections = await sectionsOf(PAPER, 'merge-paper');
    const titles = sections.map((section) => section.title);
    expect(titles).toContain('A Sample Two-Column Academic Paper');
    expect(titles).toContain('I. INTRODUCTION');
    expect(titles).toContain('II. RELATED WORK AND METHODOLOGY');
    // 论文正文节数不变（合并只动"折断的标题"，不动正常结构）。
    expect(sections.filter((section) => section.kind === 'body')).toHaveLength(4);
  });

  it('双栏论文的标题不被并进后面的章节', async () => {
    const sections = await sectionsOf(TWO_COLUMN, 'merge-two-col');
    expect(sections[0]!.title).toBe('A Sample Two-Column Academic Paper');
    expect(sections[1]!.title).toBe('I. INTRODUCTION');
    expect(sections.filter((section) => section.kind === 'body')).toHaveLength(9);
  });
});
