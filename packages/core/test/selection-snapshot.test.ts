import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attributeUnsupportedClaims,
  pageTextRevision,
  selectionSnapshotStatus,
  snapshotTextHash
} from '../src/selection-snapshot.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-selection-snapshot-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(name: string, pages: string[]): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`selection-snapshot-${name}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([400, 600]);
    if (text) page.drawText(text, { x: 40, y: 540, size: 12, font });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  return file;
}

describe('选区冻结快照：持久化', () => {
  it('带选区提问时把 {text, text_hash, page, revision} 落成不可变快照', async () => {
    const document = await store.importDocument(
      await makePdf('snapshot-hit.pdf', ['The original evidence sentence on page one'])
    );
    const pageText = store.getPageText(document.id, 1);
    const selectionText = 'original evidence sentence';

    const snapshot = store.saveSelectionSnapshot({
      documentId: document.id,
      page: 1,
      text: selectionText,
      question: '这句怎么理解？'
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.page).toBe(1);
    expect(snapshot!.text).toBe(selectionText);
    expect(snapshot!.textHash).toBe(snapshotTextHash(selectionText));
    // revision 是提问时页文本的内容版本。
    expect(snapshot!.revision).toBe(pageTextRevision(pageText));

    // 同选区同 revision 幂等：重复提问不重复落行。
    const again = store.saveSelectionSnapshot({ documentId: document.id, page: 1, text: selectionText });
    expect(again!.id).toBe(snapshot!.id);
    expect(store.listSelectionSnapshots(document.id)).toHaveLength(1);

    // 快照命中：选区文字还在当前页文本里。
    const evidence = store.selectionSnapshotEvidence(snapshot!);
    expect(evidence.status).toBe('current');
    expect(evidence.currentPageText).toContain('original evidence sentence');
  });

  it('OCR 重跑/页校订改写后旧快照不变，状态变为原文已变更', async () => {
    const document = await store.importDocument(
      await makePdf('snapshot-changed.pdf', ['Original claim about the ritual'])
    );
    const selectionText = 'Original claim about the ritual';
    const first = store.saveSelectionSnapshot({
      documentId: document.id,
      page: 1,
      text: selectionText
    })!;
    expect(store.selectionSnapshotEvidence(first).status).toBe('current');

    // 模拟 OCR 重跑（写入新的页文本）：旧快照必须原样保留。
    store.cacheOcrPage(document.id, 1, 'Rewritten OCR text about a different ritual', []);
    expect(store.getPageText(document.id, 1)).toContain('Rewritten OCR text');

    const listed = store.listSelectionSnapshots(document.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.text).toBe(selectionText);
    const evidence = store.selectionSnapshotEvidence(first);
    expect(evidence.status).toBe('source_changed');

    // 同一选区再问一次：页文本变了 → revision 变了 → 落成新快照，旧快照不更新。
    const second = store.saveSelectionSnapshot({
      documentId: document.id,
      page: 1,
      text: selectionText
    })!;
    expect(second.id).not.toBe(first.id);
    expect(second.revision).not.toBe(first.revision);
    expect(store.listSelectionSnapshots(document.id)).toHaveLength(2);
  });

  it('文献不存在或选区为空时返回 null，不写脏快照', () => {
    expect(
      store.saveSelectionSnapshot({ documentId: 'missing-document', page: 1, text: '选区' })
    ).toBeNull();
    expect(store.saveSelectionSnapshot({ documentId: 'missing-document', page: 1, text: '' }))
      .toBeNull();
  });
});

describe('选区快照：缺证归因', () => {
  const unsupported = { claim: 1, verdict: 'unsupported', reason: '证据不足' };
  const supported = { claim: 2, verdict: 'supported' };
  const snapshotText = '提问时选中的原文';

  it('快照命中时缺证仍是普通缺证，不改 verdict', () => {
    const result = attributeUnsupportedClaims(
      [unsupported, supported],
      snapshotText,
      `页首文字 ${snapshotText} 页尾文字`
    );
    expect(result.sourceChangedClaims).toEqual([]);
    expect(result.claims).toEqual([unsupported, supported]);
    expect(result.claims[0]).not.toHaveProperty('evidence_status');
    expect(result.claims[0]!.verdict).toBe('unsupported');
  });

  it('快照文字已不在当前页文本中时标 source_changed', () => {
    const result = attributeUnsupportedClaims(
      [unsupported, supported],
      snapshotText,
      '当前页已经改成完全不同的文字'
    );
    expect(result.sourceChangedClaims).toEqual([1]);
    expect(result.claims[0]).toMatchObject({
      claim: 1,
      verdict: 'unsupported',
      evidence_status: 'source_changed'
    });
    // 非缺证论断不加归因。
    expect(result.claims[1]).toEqual(supported);
  });

  it('没有快照/没有当前页文本时，普通缺证仍为缺证', () => {
    const noSnapshot = attributeUnsupportedClaims([unsupported], null, '任意页文本');
    expect(noSnapshot.sourceChangedClaims).toEqual([]);
    expect(noSnapshot.claims[0]).not.toHaveProperty('evidence_status');

    const noPageText = attributeUnsupportedClaims([unsupported], snapshotText, null);
    expect(noPageText.sourceChangedClaims).toEqual([]);
    expect(noPageText.claims[0]).not.toHaveProperty('evidence_status');
  });

  it('页文本变空也算原文已变更', () => {
    const result = attributeUnsupportedClaims([unsupported], snapshotText, '');
    expect(result.sourceChangedClaims).toEqual([1]);
  });

  it('证据明确来自其它页的缺证不误标为原文已变更', () => {
    const otherPage = {
      claim: 3,
      verdict: 'unsupported',
      evidence: [{ page: 5 }]
    };
    const samePage = {
      claim: 4,
      verdict: 'unsupported',
      evidence: [{ page: 1 }]
    };
    const result = attributeUnsupportedClaims(
      [unsupported, otherPage, samePage],
      snapshotText,
      '当前页已经改成完全不同的文字',
      { page: 1 }
    );
    // 只有无证据/证据落在选区页的缺证才归因为原文变更。
    expect(result.sourceChangedClaims).toEqual([1, 4]);
    expect(result.claims[1]).toEqual(otherPage);
  });

  it('selectionSnapshotStatus 对没有页号的快照返回 unknown', () => {
    expect(selectionSnapshotStatus({ text: snapshotText, page: 0 }, 'anything')).toBe('unknown');
  });
});

describe('选区快照：schema 迁移', () => {
  it('新库带有 selection_snapshots 表且 schema_version 已递增', () => {
    const db = (store as unknown as { db: DatabaseSync }).db;
    const columns = db
      .prepare('PRAGMA table_info(selection_snapshots)')
      .all() as unknown as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    for (const expected of ['id', 'document_id', 'page', 'text', 'text_hash', 'revision']) {
      expect(names).toContain(expected);
    }
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    expect(version?.value).toBe('24');
  });
});
