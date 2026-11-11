import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { readRecentErrors } from '../src/error-log.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-mask-job-state-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`mask-job-${name}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([400, 600]);
    page.drawText(`MASK-JOB-PAGE-${index + 1} body text`, {
      x: 30,
      y: 540,
      size: 11,
      font
    });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  return file;
}

function corruptDocument(documentId: string): void {
  const documentPath = store.getDocumentPath(documentId);
  if (!documentPath) throw new Error('missing document copy');
  writeFileSync(documentPath, 'this is not a pdf');
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6000,
  intervalMs = 25
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

describe('page mask rebuild state machine', () => {
  it('marks the sync rebuild failed (not stuck rebuilding) when the PDF is broken', async () => {
    const document = await store.importDocument(await makePdf('mask-broken-sync.pdf', 2));
    corruptDocument(document.id);
    await expect(
      store.addPageMask(document.id, { page: 1, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 })
    ).rejects.toThrow();
    const status = store.maskIndexStatus(document.id);
    expect(status.state).toBe('failed');
    expect(status.state).not.toBe('rebuilding');
    expect(status.error).toMatch(/PDF|pdf|parse|Parse|Invalid|invalid/);
  });

  it('marks the background rebuild failed and records the error log', async () => {
    const document = await store.importDocument(await makePdf('mask-broken-bg.pdf', 45));
    corruptDocument(document.id);
    await store.addPageMask(document.id, {
      page: 1,
      scope: 'all',
      x0: 0.1,
      y0: 0.1,
      x1: 0.9,
      y1: 0.2
    });
    await waitFor(() => store.maskIndexStatus(document.id).state !== 'rebuilding');
    const status = store.maskIndexStatus(document.id);
    expect(status.state).toBe('failed');
    expect(status.error).not.toBe('');
    // 后台失败不能静默：错误日志里应有 mask:rebuild 记录。
    const logged = readRecentErrors(dataDir, 50).some((entry) =>
      entry.context.includes('mask:rebuild')
    );
    expect(logged).toBe(true);
  });

  it('merges concurrent rule changes into one pending second round', async () => {
    const document = await store.importDocument(await makePdf('mask-pending.pdf', 45));
    const target = store as unknown as {
      rebuildMaskedChunks: (documentId: string, pages: number[]) => Promise<void>;
    };
    const raw = target.rebuildMaskedChunks;
    const original = raw.bind(store);
    const calls: number[][] = [];
    target.rebuildMaskedChunks = async (documentId, pages) => {
      calls.push([...pages]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return original(documentId, pages);
    };
    try {
      await store.addPageMask(document.id, {
        page: 1,
        scope: 'all',
        x0: 0.1,
        y0: 0.1,
        x1: 0.9,
        y1: 0.2
      });
      expect(store.maskIndexStatus(document.id).state).toBe('rebuilding');
      await store.addPageMask(document.id, {
        page: 2,
        scope: 'all',
        x0: 0.1,
        y0: 0.3,
        x1: 0.9,
        y1: 0.4
      });
      await waitFor(() => store.maskIndexStatus(document.id).state === 'ready');
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain(1);
      expect(calls[1]).toContain(2);
      expect(calls[1]).toHaveLength(45);
      expect(store.maskIndexStatus(document.id).state).toBe('ready');
    } finally {
      target.rebuildMaskedChunks = raw;
    }
  });
});
