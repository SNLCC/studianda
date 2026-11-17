import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DocumentSection } from '@studianda/shared';
import { detectTocPages, tocPageSearchLimit } from '../src/toc-pages.js';
import { Store } from '../src/store.js';

/**
 * 目录页识别与"目录页不产生正文章节"的回归。
 *
 * 背景：目录页上的行也会被识别成标题块。若拿它们当章节边界，一本 306 页的书会在目录页上
 * 凭空长出十几节，`decompose` 于是把目录条目当正文单元去读——既浪费又让真节的层级错位。
 *
 * 样本：`dev-notes/.../demo-paper-01.pdf`（6 页，第 2 页是印刷目录）。文缺失时跳过，
 * 不让这个测试因为资源不在而红。
 */

const DEMO = path.resolve(
  import.meta.dirname,
  '../../../dev-notes/readme-capture/demo-pdf/out/demo-paper-01.pdf'
);
const PAPER = path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const hasDemo = existsSync(DEMO);

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-toc-suppress-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function bodySections(sections: readonly DocumentSection[]): DocumentSection[] {
  return sections.filter((section) => section.kind === 'body');
}

describe('detectTocPages', () => {
  it('把前部带"标题+页码"的页认成目录页，正文页不误判', async () => {
    if (!hasDemo) return;
    const doc = await store.importDocument(DEMO, 'demo', true);
    const layout = await (
      store as unknown as { readLayout: (id: string) => Promise<{ pages: unknown[] }> }
    ).readLayout(doc.id);
    const masks = (
      store as unknown as { listPageMasks: (id: string) => never[] }
    ).listPageMasks(doc.id);
    const detected = detectTocPages(layout as never, masks, layout.pages.length);
    expect(detected).toEqual([2]);
  });

  it('没有目录页的论文不产生任何标记', async () => {
    const doc = await store.importDocument(PAPER, 'paper', true);
    const layout = await (
      store as unknown as { readLayout: (id: string) => Promise<{ pages: unknown[] }> }
    ).readLayout(doc.id);
    const masks = (
      store as unknown as { listPageMasks: (id: string) => never[] }
    ).listPageMasks(doc.id);
    expect(detectTocPages(layout as never, masks, layout.pages.length)).toEqual([]);
  });

  it('只在文献前部搜索，避免正文表格页被误判', () => {
    expect(tocPageSearchLimit(6)).toBe(3);
    expect(tocPageSearchLimit(300)).toBe(45);
    expect(tocPageSearchLimit(2)).toBe(3);
  });
});

describe('目录页不产生正文章节', () => {
  it('demo 的正文节从第 3 页开始，且目录页上没有节', async () => {
    if (!hasDemo) return;
    const doc = await store.importDocument(DEMO, 'demo-suppress', true);
    const blocks = await store.getDocumentBlocks(doc.id);
    const body = bodySections(blocks.sections);
    // 修复前这里是 23 个（目录页贡献 12 个假节 + 1 个跨行标题残片）。
    expect(body.length).toBe(10);
    expect(body.some((section) => section.pageStart === 2)).toBe(false);
    for (const section of body) {
      expect(section.pageStart).toBeGreaterThanOrEqual(3);
    }
    // 正文节之间必须连续（无空洞、无重叠）。
    for (let index = 1; index < body.length; index += 1) {
      expect(body[index]!.blockStart).toBe(body[index - 1]!.blockEnd + 1);
    }
  });

  it('论文样本的节数不受影响', async () => {
    const doc = await store.importDocument(PAPER, 'paper-suppress', true);
    const blocks = await store.getDocumentBlocks(doc.id);
    expect(bodySections(blocks.sections)).toHaveLength(4);
  });
});
