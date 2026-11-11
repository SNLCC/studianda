import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractPdfLayout, type PdfLayout } from '../src/pdf-layout.js';
import { navigationNodes, type PageMask } from '../src/structure.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-navigation-gate-'));
const store = new Store(dataDir);
let documentId = '';
let fixturePath = '';

/** 3 页 PDF：第 1、3 页有编号标题，第 2 页只有正文。 */
async function makeThreePagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('navigation-gate-fixture');
  pdf.setAuthor('Studianda test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [
    ['1 Introduction', 'Body text of the first page.'],
    ['Plain body text without any numbered heading.'],
    ['2 Methods', 'Body text of the third page.']
  ];
  for (const lines of pages) {
    const page = pdf.addPage([400, 600]);
    let y = 540;
    for (const line of lines) {
      page.drawText(line, { x: 40, y, size: 12, font });
      y -= 20;
    }
  }
  return pdf.save();
}

beforeAll(async () => {
  fixturePath = path.join(dataDir, 'fixture.pdf');
  writeFileSync(fixturePath, await makeThreePagePdf());
  documentId = (await store.importDocument(fixturePath)).id;
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('navigation node generation', () => {
  it('adds section nodes and a page node for pages without headings', async () => {
    const layout = await extractPdfLayout(new Uint8Array(readFileSync(fixturePath)));
    const nodes = navigationNodes(layout, []);
    const sections = nodes.filter((node) => node.kind === 'section');
    expect(sections.map((node) => node.label)).toEqual(['1 Introduction', '2 Methods']);
    expect(sections.map((node) => node.page)).toEqual([1, 3]);

    const pageNode = nodes.find((node) => node.page === 2);
    expect(pageNode).toMatchObject({ page: 2, kind: 'page' });
    expect(pageNode?.label).toContain('Plain body text');

    // 按页码排序；有章节标题的页不再生成 page 节点。
    expect(nodes.map((node) => node.page)).toEqual([1, 2, 3]);
    expect(nodes.some((node) => node.kind === 'page' && node.page === 1)).toBe(false);
    expect(nodes.some((node) => node.kind === 'page' && node.page === 3)).toBe(false);
    expect(nodes.some((node) => node.kind === 'title')).toBe(false);
  });

  it('keeps only the highest-level section when one page has several headings', () => {
    const layout: PdfLayout = {
      author: '',
      outline: [],
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          lines: [{ text: 'Intro body text.', bbox: [0.1, 0.3, 0.8, 0.33], size: 10 }]
        },
        {
          page: 2,
          width: 600,
          height: 800,
          lines: [
            { text: '2 Methods', bbox: [0.1, 0.1, 0.5, 0.13], size: 14 },
            { text: '2.1 Data collection', bbox: [0.1, 0.2, 0.6, 0.23], size: 12 },
            { text: 'Body text here.', bbox: [0.1, 0.3, 0.8, 0.33], size: 10 }
          ]
        }
      ]
    };
    const nodes = navigationNodes(layout, []);
    const sections = nodes.filter((node) => node.kind === 'section');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ page: 2, label: '2 Methods' });
    // 已有 section 的页不再生成 page 节点（避免同页重复条目）；无标题页仍生成 page 节点。
    expect(nodes.some((node) => node.kind === 'page' && node.page === 2)).toBe(false);
    expect(nodes.find((node) => node.page === 1)).toMatchObject({ kind: 'page' });
  });

  it('skips pages without any text and uses the masked first line as page label', () => {
    const emptyFirst: PdfLayout = {
      author: '',
      outline: [],
      pages: [
        { page: 1, width: 600, height: 800, lines: [] },
        {
          page: 2,
          width: 600,
          height: 800,
          lines: [
            { text: 'Header noise line', bbox: [0, 0, 1, 0.05] },
            { text: 'Real body line.', bbox: [0, 0.3, 1, 0.35] }
          ]
        }
      ]
    };
    const nodes = navigationNodes(emptyFirst, []);
    expect(nodes.map((node) => node.page)).toEqual([2]);
    expect(nodes[0]?.kind).toBe('page');

    const masks: PageMask[] = [
      { id: 'm1', documentId: 'doc', page: 2, scope: 'page', x0: 0, y0: 0, x1: 1, y1: 0.1 }
    ];
    const masked = navigationNodes(emptyFirst, masks);
    expect(masked.find((node) => node.page === 2)).toMatchObject({
      kind: 'page',
      label: 'Real body line.'
    });
  });
});

describe('navigation planning gate', () => {
  it('feeds planning only when the index is ready and enabled', async () => {
    expect(store.navigationStatus(documentId).state).toBe('missing');
    expect(store.planningNavigation(documentId)).toEqual([]);
    const missingView = store.navigationPlanningView(documentId);
    expect(missingView).toMatchObject({ enabled: false, state: 'missing', nodes: [] });
    expect(missingView.reason).toContain('未生成');

    await store.buildNavigation(documentId);
    expect(store.navigationStatus(documentId).state).toBe('ready');
    expect(store.navigationStatus(documentId).enabled).toBe(false);
    expect(store.planningNavigation(documentId)).toEqual([]);
    const disabledView = store.navigationPlanningView(documentId);
    expect(disabledView).toMatchObject({ enabled: false, state: 'ready', nodes: [] });
    expect(disabledView.reason).toContain('未启用');

    expect(store.setNavigationEnabled(documentId, true)).toMatchObject({
      enabled: true,
      state: 'ready'
    });
    const nodes = store.planningNavigation(documentId);
    expect(nodes.map((node) => node.page)).toEqual([1, 2, 3]);
    const enabledView = store.navigationPlanningView(documentId);
    expect(enabledView.enabled).toBe(true);
    expect(enabledView.nodes).toEqual(nodes);
    expect(enabledView.reason).toBeUndefined();

    store.setNavigationEnabled(documentId, false);
    expect(store.planningNavigation(documentId)).toEqual([]);
    expect(store.navigationPlanningView(documentId).enabled).toBe(false);
  });

  it('goes stale after a mask change and stops feeding planning with a reason', async () => {
    store.setNavigationEnabled(documentId, true);
    await store.addPageMask(documentId, {
      page: 1,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 0.08
    });
    expect(store.navigationStatus(documentId).state).toBe('stale');
    expect(store.planningNavigation(documentId)).toEqual([]);
    const view = store.navigationPlanningView(documentId);
    expect(view.enabled).toBe(false);
    expect(view.state).toBe('stale');
    expect(view.reason).toContain('过期');
  });
});

describe('navigation failure state', () => {
  async function importFreshDocument(name: string): Promise<string> {
    const pdf = await PDFDocument.create();
    pdf.setTitle(`navigation-failure-${name}`);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 1; index <= 3; index += 1) {
      const page = pdf.addPage([400, 600]);
      page.drawText(`${index} Failure Fixture ${name} page ${index}`, {
        x: 40,
        y: 540,
        size: 12,
        font
      });
      page.drawText(`Body text for ${name} page ${index}.`, { x: 40, y: 510, size: 11, font });
    }
    const file = path.join(dataDir, name);
    writeFileSync(file, await pdf.save());
    return (await store.importDocument(file)).id;
  }

  it('reports missing (not stale) when navigation is enabled before the first build', async () => {
    const id = await importFreshDocument('nav-enabled-unbuilt.pdf');
    const status = store.setNavigationEnabled(id, true);
    expect(status).toMatchObject({ state: 'missing', enabled: true });
    expect(store.navigationStatus(id).state).toBe('missing');
    expect(store.navigationPlanningView(id).reason).toContain('已启用，但还没有生成');
  });

  it('keeps enabled=1 when a navigation build fails', async () => {
    const id = await importFreshDocument('nav-build-failure.pdf');
    store.setNavigationEnabled(id, true);
    const documentPath = store.getDocumentPath(id);
    expect(documentPath).toBeTruthy();
    writeFileSync(documentPath!, 'not a pdf at all');
    await expect(store.buildNavigation(id, true)).rejects.toThrow();
    const status = store.navigationStatus(id);
    expect(status.state).toBe('failed');
    expect(status.enabled).toBe(true);
    expect(status.error).not.toBe('');
  });
});
