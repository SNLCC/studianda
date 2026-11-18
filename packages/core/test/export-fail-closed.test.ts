import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { AI_ANSWER_COPY_SUFFIX } from '@studianda/shared';
import { assertAiMetadataWritten, buildAnnotatedPdf } from '../src/annotated-pdf.js';
import {
  AI_EXPORT_REFUSED_MESSAGE,
  buildMarkedMarkdownExport,
  isAiExportRefused,
  markdownHasAiExportHeader
} from '../src/export-marker.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-export-fail-closed-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(name: string, pageText = 'Original page text'): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`export-fail-closed-${name}`);
  const page = pdf.addPage([400, 600]);
  page.drawText(pageText, { x: 40, y: 540, size: 12 });
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  return file;
}

function annotation(content: string): Parameters<typeof buildAnnotatedPdf>[1][number] {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    page: 1,
    quote: '原文一句',
    content,
    rects: '[]',
    color: 'yellow',
    style: 'page',
    created: ''
  };
}

describe('导出 fail-closed（Markdown）', () => {
  it('含 AI 内容的导出必须带 aigc YAML 文件头', async () => {
    const document = await store.importDocument(await makePdf('ai-note.pdf'));
    store.createNote({
      documentId: document.id,
      page: 1,
      quote: '原文一句',
      content: `## 回答\n\n模型生成的回答正文。${AI_ANSWER_COPY_SUFFIX}`
    });

    const exported = store.exportMarkdown(document.id);
    expect(exported.markdown.startsWith('---\naigc: true\n')).toBe(true);
    expect(markdownHasAiExportHeader(exported.markdown)).toBe(true);
    expect(exported.markdown).toContain('> **AI 生成内容声明**');
  });

  it('纯用户内容导出不带 aigc，也不加文件头', async () => {
    const document = await store.importDocument(await makePdf('user-note.pdf'));
    store.createNote({
      documentId: document.id,
      page: 1,
      quote: '原文一句',
      content: '自己写的笔记，没有 AI 标识。'
    });

    const exported = store.exportMarkdown(document.id);
    expect(exported.markdown).not.toContain('aigc');
    expect(exported.markdown.startsWith('---')).toBe(false);
    expect(exported.markdown).toContain('自己写的笔记');
  });

  it('含 AI 内容但标识头写不进去时抛错，不产出文件', () => {
    const body = '# 笔记\n\n内容\n';
    expect(() =>
      buildMarkedMarkdownExport(body, true, { writeHeader: (markdown) => markdown })
    ).toThrow(AI_EXPORT_REFUSED_MESSAGE);
    expect(() =>
      buildMarkedMarkdownExport(body, true, { writeHeader: () => '# 无标识头\n' })
    ).toThrow(/拒绝导出未标识的 AI 内容/);

    // 纯用户内容即使写头函数异常丢失也不受影响（本来就不该写 AI 元数据）。
    expect(buildMarkedMarkdownExport(body, false, { writeHeader: (markdown) => markdown })).toBe(
      body
    );
    // 正常写头通过守卫。
    expect(markdownHasAiExportHeader(buildMarkedMarkdownExport(body, true))).toBe(true);
  });

  it('路由把 fail-closed 拒绝映射为 4xx 明确错误', async () => {
    // 只为验证错误映射：让 exportMarkdown 抛拒绝错误（真实写头失败路径由上面的守卫单测覆盖）。
    const failing = Object.create(store) as Store;
    (failing as unknown as { exportMarkdown: () => never }).exportMarkdown = () => {
      throw new Error(AI_EXPORT_REFUSED_MESSAGE);
    };
    const server = buildServer({
      token: 'export-fail-closed-token',
      version: 'test',
      store: failing,
      secrets: new SecretStore()
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/documents/whatever/export',
        headers: { 'x-studianda-token': 'export-fail-closed-token' }
      });
      expect(response.statusCode).toBe(422);
      const payload = response.json() as { error: string; message: string };
      expect(payload.error).toBe('export_failed');
      expect(payload.message).toContain('拒绝导出未标识的 AI 内容');
      expect(isAiExportRefused(new Error(payload.message))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('导出 fail-closed（带批注 PDF）', () => {
  it('含 AI 批注时会写入并核验 AI 元数据', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]);
    const original = await pdf.save();
    const result = await buildAnnotatedPdf(original, [
      annotation(`模型回答正文。${AI_ANSWER_COPY_SUFFIX}`)
    ]);
    const output = await PDFDocument.load(result.bytes);
    // 写入后核验通过：不抛错。
    expect(() => assertAiMetadataWritten(output)).not.toThrow();
  });

  it('核验 AI 元数据缺失时拒绝产出（fail-closed）', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]);
    // 没有 AI 元数据的普通 PDF：核验必须失败，导出流程据此拒绝产出副本。
    expect(() => assertAiMetadataWritten(pdf)).toThrow(/拒绝导出未标识的 AI 内容/);

    const original = await pdf.save();
    const plain = await buildAnnotatedPdf(original, [annotation('自己写的批注')]);
    const plainOutput = await PDFDocument.load(plain.bytes);
    // 纯用户批注不写 AI 元数据，也不会被核验误杀（核验只在含 AI 内容时调用）。
    expect(() => assertAiMetadataWritten(plainOutput)).toThrow();
  });
});
