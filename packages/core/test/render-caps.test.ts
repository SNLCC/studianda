import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPdfPage } from '../src/ocr.js';
import { Store } from '../src/store.js';

/**
 * 渲染上限回归：
 * - page：min(3.0, 3600/长边)
 * - ocr：min(2, 2400/长边)
 * - region：min(2, 2600/长边)
 * 超大页必须允许 scale<1；普通页保持原有 scale 行为。
 */
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-render-caps-'));
const store = new Store(dataDir);
let hugeId = '';
let normalId = '';

beforeAll(async () => {
  const huge = await PDFDocument.create();
  huge.addPage([6000, 6000]);
  const hugePath = path.join(dataDir, 'huge-6000.pdf');
  writeFileSync(hugePath, await huge.save());
  hugeId = (await store.importDocument(hugePath)).id;

  const normal = await PDFDocument.create();
  normal.addPage([400, 600]);
  const normalPath = path.join(dataDir, 'normal-400x600.pdf');
  writeFileSync(normalPath, await normal.save());
  normalId = (await store.importDocument(normalPath)).id;
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('render caps', () => {
  it('把 6000×6000pt 超大页按用途限制在长边像素上限内（允许 scale<1）', async () => {
    // page：3600/6000 = 0.6 倍 → 3600px，而不是按 1 倍渲染成 6000px。
    const page = await renderPdfPage(hugeId, 1, store, 2, 'page');
    expect(page.width).toBeLessThanOrEqual(3600);
    expect(page.height).toBeLessThanOrEqual(3600);

    // OCR：2400/6000 = 0.4 倍 → 2400px。
    const ocr = await renderPdfPage(hugeId, 1, store, 2, 'ocr');
    expect(ocr.width).toBeLessThanOrEqual(2400);
    expect(ocr.height).toBeLessThanOrEqual(2400);

    // 区域：2600/6000 ≈ 0.433 倍 → 不超过 2600px。
    const region = await renderPdfPage(hugeId, 1, store, 2, 'region');
    expect(region.width).toBeLessThanOrEqual(2600);
    expect(region.height).toBeLessThanOrEqual(2600);

    // 三种用途都实际缩小了页面（证明 scale 已小于 1，而不是被 Math.max(1,…) 卡住）。
    expect(page.width).toBeLessThan(6000);
    expect(ocr.width).toBeLessThan(page.width);
    expect(region.width).toBeLessThanOrEqual(2600);
  });

  it('普通页保持原有 scale 行为（2 倍/1.5 倍原样生效）', async () => {
    const two = await renderPdfPage(normalId, 1, store, 2, 'ocr');
    expect(two.width).toBe(800);
    expect(two.height).toBe(1200);

    const oneAndHalf = await renderPdfPage(normalId, 1, store, 1.5, 'ocr');
    expect(oneAndHalf.width).toBe(600);
    expect(oneAndHalf.height).toBe(900);
  });
});
