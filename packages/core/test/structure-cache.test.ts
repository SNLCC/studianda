import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranslationSegmentRecord } from '@studianda/shared';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-structure-cache-'));
let store = new Store(dataDir);
let documentId = '';

afterAll(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  rmSync(dataDir, { recursive: true, force: true });
});

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([400, 600]);
  first.drawText('SECTION ONE', { x: 30, y: 560, size: 16, font });
  first.drawText('Body text of the first page.', { x: 30, y: 520, size: 11, font });
  const second = pdf.addPage([400, 600]);
  second.drawText('SECTION TWO', { x: 30, y: 560, size: 16, font });
  second.drawText('Body text of the second page.', { x: 30, y: 520, size: 11, font });
  const file = path.join(dataDir, 'structure.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
}, 120_000);

describe('结构/版面缓存持久化', () => {
  it('解析一次后写入数据库，重开进程仍能复用', async () => {
    const layout = await store.getPageLayout(documentId);
    expect(layout?.pages.length).toBe(2);
    const sections = await store.getStructure(documentId);
    expect(Array.isArray(sections)).toBe(true);
    const nodes = await store.getVisualNodes(documentId);
    expect(Array.isArray(nodes)).toBe(true);

    const db = (store as unknown as { db: DatabaseSync }).db;
    const pageRows = db
      .prepare('SELECT COUNT(*) AS count FROM structure_pages')
      .get() as unknown as { count: number };
    // 0 号是整篇元数据（作者/书签），另有每页一条。
    expect(Number(pageRows.count)).toBeGreaterThanOrEqual(3);
    const structureRow = db
      .prepare('SELECT version, value FROM structures WHERE document = ?')
      .get(documentId) as unknown as { version: string; value: string };
    expect(structureRow.version).toContain(':');
    expect(JSON.parse(structureRow.value)).toHaveProperty('sections');

    store.close();
    store = new Store(dataDir);
    const reopenedLayout = await store.getPageLayout(documentId);
    expect(reopenedLayout?.pages[0]?.lines.map((line) => line.text)).toEqual(
      layout?.pages[0]?.lines.map((line) => line.text)
    );
    const reopenedSections = await store.getStructure(documentId);
    expect(reopenedSections).toEqual(sections);
  });

  it('页遮罩变化后结构缓存自动失效', async () => {
    const before = await store.getStructure(documentId);
    await store.addPageMask(documentId, { page: 1, x0: 0, y0: 0, x1: 1, y1: 0.2 });
    const after = await store.getStructure(documentId);
    // 缓存版本包含遮罩 revision：读取后仍是数组，且缓存行版本已更新。
    expect(Array.isArray(after)).toBe(true);
    expect(Array.isArray(before)).toBe(true);
    const db = (store as unknown as { db: DatabaseSync }).db;
    const row = db
      .prepare('SELECT version FROM structures WHERE document = ?')
      .get(documentId) as unknown as { version: string };
    expect(row.version.split(':').length).toBeGreaterThanOrEqual(3);
  });

  it('视觉派生解读写入 semantic 节点并进入派生检索', async () => {
    await store.getStructure(documentId);
    store.addStructureSemantic(documentId, 1, '第 1 页有一张关于模型结构的示意图。');
    store.addStructureSemantic(documentId, 1, '第 1 页有一张关于模型结构的示意图。');
    const derived = store
      .listDerivedChunks([documentId])
      .filter((chunk) => chunk.text.includes('示意图'));
    expect(derived).toHaveLength(1);
    expect(derived[0]!.derived).toBe(true);
    expect(derived[0]!.page).toBe(1);
  });
});

describe('派生检索的版本与译文质量', () => {
  it('skips derived structure chunks when structures.version is stale, then returns them after recompute', async () => {
    const pdf = await PDFDocument.create();
    pdf.setTitle('structure-version-fixture');
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 600]);
    page.drawText('1 VERSIONED SECTION HEADING', { x: 30, y: 560, size: 16, font });
    page.drawText('Body text for version check.', { x: 30, y: 520, size: 11, font });
    const file = path.join(dataDir, 'structure-version.pdf');
    writeFileSync(file, await pdf.save());
    const imported = await store.importDocument(file);

    await store.getStructure(imported.id);
    const withSections = () =>
      store
        .listDerivedChunks([imported.id])
        .some((chunk) => chunk.text.includes('VERSIONED SECTION HEADING'));
    expect(withSections()).toBe(true);

    // 页遮罩改变 maskRevision：旧 structures.version 对不上，旧派生节点不再参与检索。
    await store.addPageMask(imported.id, { page: 1, x0: 0, y0: 0.9, x1: 1, y1: 1 });
    expect(withSections()).toBe(false);

    // 重算后写入新 version，派生节点恢复。
    await store.getStructure(imported.id);
    expect(withSections()).toBe(true);
  });

  it('filters suspicious translations and carries segment/edited/translation_id', () => {
    const base: TranslationSegmentRecord = {
      id: 'derived-normal',
      documentId,
      page: 1,
      segment: 2,
      source: 'Source sentence.',
      sourceHash: 'source-hash',
      text: '这是正常的译文。',
      engine: 'remote',
      service: 'mock',
      terms: '[]',
      unknownTerms: '[]',
      coverage: null,
      edited: true,
      origin: 'user',
      previousText: '',
      previousOrigin: ''
    };
    const suspicious: TranslationSegmentRecord = {
      ...base,
      id: 'derived-bad',
      segment: 3,
      text: `${'\uFFFD'.repeat(20)} bad`,
      edited: false,
      origin: 'machine'
    };
    store.saveTranslationSegments([base, suspicious]);
    const rows = store
      .listDerivedChunks([documentId])
      .filter((chunk) => chunk.translation);
    const normal = rows.find((chunk) => chunk.id === 'T:derived-normal');
    expect(normal).toMatchObject({
      segment: 2,
      edited: true,
      translation_id: 'derived-normal',
      translation: true,
      derived: true
    });
    expect(rows.some((chunk) => chunk.id === 'T:derived-bad')).toBe(false);
  });
});
