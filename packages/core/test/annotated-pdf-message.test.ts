import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnnotationRecord } from '@studianda/shared';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAnnotatedPdf } from '../src/annotated-pdf.js';
import { Store } from '../src/store.js';

/**
 * 批注 PDF 文件级失败话术：server 的 409 映射靠中文正则
 * `/未改动|写入|打开|占用|加密|锁定/`；pdf-lib 的英文原文会漏判成 400。
 */
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-annotated-msg-'));
const store = new Store(dataDir);
let validBytes: Uint8Array;
let documentId = '';

function annotation(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    id: 'a1',
    documentId,
    page: 1,
    quote: '原文',
    content: '批注',
    rects: '[ [0.1, 0.1, 0.5, 0.2] ]',
    color: 'yellow',
    style: 'highlight',
    created: new Date().toISOString(),
    ...overrides
  };
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  validBytes = await pdf.save();
  const file = path.join(dataDir, 'valid.pdf');
  writeFileSync(file, validBytes);
  documentId = (await store.importDocument(file)).id;
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('annotated PDF file-level errors', () => {
  it('损坏 PDF 抛中文「原文件未改动」', async () => {
    await expect(buildAnnotatedPdf(new Uint8Array([1, 2, 3, 4]), [])).rejects.toThrow(
      /导出批注 PDF 失败：原文件未改动/
    );
  });

  it('空/缺失原文件内容同样算文件级失败', async () => {
    await expect(buildAnnotatedPdf(null, [])).rejects.toThrow(/原文件未改动/);
    await expect(buildAnnotatedPdf(new Uint8Array(0), [])).rejects.toThrow(/原文件未改动/);
  });

  it('通过 Store 导出损坏附件时也包装成中文', async () => {
    const filePath = store.getDocumentPath(documentId);
    if (!filePath) throw new Error('测试附件路径不存在');
    const backup = readFileSync(filePath);
    writeFileSync(filePath, Buffer.from('not a valid pdf'));
    try {
      await expect(store.exportAnnotatedPdf(documentId)).rejects.toThrow(/原文件未改动/);
    } finally {
      writeFileSync(filePath, backup);
    }
  });

  it('批注级/参数级错误不误判为文件级失败', async () => {
    // 页码超出范围：按 unplaced 如实统计，不抛“原文件未改动”。
    const result = await buildAnnotatedPdf(validBytes, [
      annotation({ page: 99 }),
      annotation({ id: 'a2', rects: 'not-json' })
    ]);
    expect(result.unplaced).toBe(2);
    expect(result.placed).toBe(0);
    expect(result.message ?? '').toMatch(/原文件未改动/); // 成功副本的说明，不是抛错
  });
});
