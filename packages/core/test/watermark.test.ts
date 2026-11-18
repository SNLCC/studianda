import { createCanvas } from '@napi-rs/canvas';
import {
  imageWatermarkAsciiText,
  imageWatermarkMetadata,
  imageWatermarkText,
  isAiWatermarkKind
} from '@studianda/shared';
import { describe, expect, it } from 'vitest';
import { burnImageWatermark, insertPngTextChunk, WatermarkError } from '../src/watermark.js';

/** 造一张合法 PNG（纯色），用于水印与元数据测试。 */
function samplePng(width = 240, height = 120): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#204060';
  context.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function textChunks(png: Uint8Array): Array<{ keyword: string; value: string }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Array<{ keyword: string; value: string }> = [];
  let offset = 8;
  const decoder = new TextDecoder();
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(png.subarray(offset + 4, offset + 8));
    if (type === 'tEXt') {
      const body = png.subarray(offset + 8, offset + 8 + length);
      const zero = body.indexOf(0);
      out.push({
        keyword: decoder.decode(body.subarray(0, zero)),
        value: decoder.decode(body.subarray(zero + 1))
      });
    }
    offset += 12 + length;
  }
  return out;
}

describe('水印：PNG 元数据块', () => {
  it('在 IHDR 之后插入 tEXt，且不破坏 PNG 结构', () => {
    const source = samplePng();
    const marked = insertPngTextChunk(source, 'AIGC', 'AI 生成 · 勘读 Studianda');
    expect([...marked.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(marked.length).toBeGreaterThan(source.length);
    // 第一块仍是 IHDR，第二块是 tEXt
    const view = new DataView(marked.buffer, marked.byteOffset, marked.byteLength);
    const decoder = new TextDecoder();
    expect(decoder.decode(marked.subarray(12, 16))).toBe('IHDR');
    expect(decoder.decode(marked.subarray(37, 41))).toBe('tEXt');
    expect(view.getUint32(33)).toBeGreaterThan(0);
    expect(textChunks(marked)).toEqual([
      { keyword: 'AIGC', value: 'AI 生成 · 勘读 Studianda' }
    ]);
  });

  it('非 PNG 直接抛错（fail-closed，不允许静默放过未标识的图）', () => {
    expect(() => insertPngTextChunk(new Uint8Array([1, 2, 3]), 'AIGC', 'x')).toThrow(
      WatermarkError
    );
  });
});

describe('水印：烧录', () => {
  it('AI 内容会烧上可见水印并写入 AIGC 元数据', async () => {
    const source = samplePng();
    const result = await burnImageWatermark(source, { kind: 'generated' });
    expect(result.changed).toBe(true);
    expect(result.text).toBeTruthy();
    expect([...result.bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const chunks = textChunks(result.bytes);
    // 两块都插在 IHDR 之后：后插的 Software 在最前，先插的 AIGC 紧随其后。
    expect(chunks.map((chunk) => chunk.keyword)).toEqual(['Software', 'AIGC']);
    const aigc = chunks.find((chunk) => chunk.keyword === 'AIGC');
    expect(aigc?.value).toBe(result.text);
    expect(chunks.find((chunk) => chunk.keyword === 'Software')?.value).toBe('Studianda');
    // 烧录后的图必须与原因不同（水印是真的画上去的）
    expect(result.bytes.length).toBeGreaterThan(source.length);
  });

  it('本机 OCR 烧的是 OCR 来源水印，元数据不写 AIGC', async () => {
    const source = samplePng(320, 120);
    const result = await burnImageWatermark(source, { kind: 'local_ocr' });
    expect(result.changed).toBe(true);
    expect(result.text).toBeTruthy();
    expect(result.bytes.length).toBeGreaterThan(source.length);
    // 文案必须说明"OCR + 本机 + 请核对"，且不能出现 AI 生成/机器翻译字样。
    expect(result.text).not.toMatch(/AI 生成|机器翻译/);
    if (result.asciiFallback) {
      expect(result.text).toBe('OCR · local engine · verify against original');
    } else {
      expect(result.text).toContain('OCR');
      expect(result.text).toContain('本机');
      expect(result.text).toContain('核对');
    }
    const chunks = textChunks(result.bytes);
    const keywords = chunks.map((chunk) => chunk.keyword);
    // 不写 AIGC：本机 OCR 不是生成式 AI；改写来源标记 + Software。
    expect(keywords).toEqual(['Software', 'Source']);
    expect(chunks.find((chunk) => chunk.keyword === 'AIGC')).toBeUndefined();
    expect(chunks.find((chunk) => chunk.keyword === 'Source')?.value).toBe(
      'Studianda OCR (local engine)'
    );
    expect(chunks.find((chunk) => chunk.keyword === 'Software')?.value).toBe('Studianda');
  });

  it('AI 类与 OCR 类的元数据关键字不同：只有 AI 类带 AIGC', async () => {
    for (const kind of ['generated', 'translation', 'vision'] as const) {
      const chunks = textChunks((await burnImageWatermark(samplePng(320, 120), { kind })).bytes);
      const keywords = chunks.map((chunk) => chunk.keyword);
      expect(keywords).toContain('AIGC');
      expect(keywords).not.toContain('Source');
      expect(keywords).toContain('Software');
    }
    const ocr = await burnImageWatermark(samplePng(320, 120), { kind: 'local_ocr' });
    const ocrKeywords = textChunks(ocr.bytes).map((chunk) => chunk.keyword);
    expect(ocrKeywords).toContain('Source');
    expect(ocrKeywords).not.toContain('AIGC');
  });

  it('译文与视觉识别各有独立文案；无中文字形时退回 ASCII', async () => {
    const translation = await burnImageWatermark(samplePng(200, 100), {
      kind: 'translation'
    });
    const vision = await burnImageWatermark(samplePng(200, 100), { kind: 'vision' });
    expect(translation.text).not.toBe(vision.text);
    if (translation.asciiFallback) {
      expect(translation.text).toBe('Machine translation · AI');
      expect(vision.text).toBe('AI vision transcription · Studianda');
    } else {
      expect(translation.text).toContain('机器翻译');
      expect(vision.text).toContain('AI 模型识别');
    }
  });
});

describe('水印：shared 标识契约', () => {
  it('本机 OCR 文案写明 OCR/本机/核对，元数据是 Source 而不是 AIGC', () => {
    const zh = imageWatermarkText('local_ocr');
    expect(zh).toContain('OCR');
    expect(zh).toContain('本机');
    expect(zh).toContain('核对');
    expect(zh).not.toMatch(/AI 生成|机器翻译/);
    expect(imageWatermarkAsciiText('local_ocr')).toMatch(/OCR · local engine/);
    expect(isAiWatermarkKind('local_ocr')).toBe(false);
    for (const kind of ['generated', 'translation', 'vision'] as const) {
      expect(isAiWatermarkKind(kind)).toBe(true);
      const keywords = imageWatermarkMetadata(kind).map((item) => item.keyword);
      expect(keywords).toContain('AIGC');
      expect(keywords).not.toContain('Source');
    }
    expect(imageWatermarkMetadata('local_ocr').map((item) => item.keyword)).toEqual([
      'Source',
      'Software'
    ]);
  });
});
