import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it, vi } from 'vitest';

// pdf-layout 的解析是重操作；这里 mock 掉真实 PDF 解析，只验证缓存命中/失效行为。
const extractPageSpans = vi.fn(async () => ({
  spans: [{ text: 'cached', bbox: [0, 0, 10, 10] as [number, number, number, number] }],
  rotationMatrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number]
}));
vi.mock('../src/pdf-layout.js', () => ({ extractPageSpans }));

const { getPageSpans } = await import('../src/page-spans-cache.js');

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-page-spans-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('page spans cache', () => {
  it('reuses parsed spans for the same file/page and invalidates on file change', async () => {
    const file = path.join(dataDir, 'cached.pdf');
    const pdf = await PDFDocument.create();
    pdf.addPage();
    writeFileSync(file, await pdf.save());

    const first = await getPageSpans(file, 1);
    expect(first.spans[0]?.text).toBe('cached');
    expect(extractPageSpans).toHaveBeenCalledTimes(1);

    const second = await getPageSpans(file, 1);
    expect(second).toBe(first);
    expect(extractPageSpans).toHaveBeenCalledTimes(1);

    // 文件内容变化 → key 失效，重新解析。
    const changed = await PDFDocument.create();
    changed.addPage();
    writeFileSync(file, await changed.save());
    await getPageSpans(file, 1);
    expect(extractPageSpans).toHaveBeenCalledTimes(2);
  });
});
