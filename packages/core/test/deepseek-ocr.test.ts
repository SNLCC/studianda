import { describe, expect, it } from 'vitest';
import { deepSeekOcrPageText, parseDeepSeekOcrPage } from '../src/ocr.js';

/**
 * DeepSeek OCR 输出解析与「截断不落库」约束。
 *
 * 官方在 `rich_layout_recognition` 下会返回带 `<｜ref｜>`/`<｜box｜>` 的文本，
 * 坐标按页宽高归一化到 0–1000；逐页 `finish_reason` 为 `length` 表示该页不完整。
 */
describe('DeepSeek OCR 输出解析', () => {
  it('剥离 ref/box 标记并把归一化坐标换算成像素', () => {
    const parsed = parseDeepSeekOcrPage(
      '<｜ref｜>标题<｜/ref｜><｜box｜>[[100, 100, 500, 200]]<｜/box｜>',
      { width: 1000, height: 2000 }
    );
    expect(parsed.text).toBe('标题');
    expect(parsed.text).not.toContain('<｜');
    expect(parsed.lines[0]).toMatchObject({ text: '标题', bbox: [100, 200, 500, 400] });
  });

  it('没有标记时按纯文本返回，不产生行框', () => {
    const parsed = parseDeepSeekOcrPage('第一行\n第二行', { width: 100, height: 100 });
    expect(parsed.text).toBe('第一行\n第二行');
    expect(parsed.lines).toEqual([]);
  });

  it('多段文字按行切分并保留顺序，只有带坐标的段才有行框', () => {
    const parsed = parseDeepSeekOcrPage(
      '<｜ref｜>甲<｜/ref｜><｜box｜>[[0,0,100,100]]<｜/box｜><｜ref｜>乙<｜/ref｜>',
      { width: 100, height: 100 }
    );
    expect(parsed.text).toBe('甲\n乙');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.text).toBe('甲');
  });
});

describe('DeepSeek OCR 页面结果', () => {
  it('finish_reason=length 的页不当完整原文写入', () => {
    expect(() =>
      deepSeekOcrPageText(
        { pages: [{ text: '半页', finish_reason: 'length' }] },
        3,
        { width: 100, height: 100 }
      )
    ).toThrow('未写入');
  });

  it('错误对象、空结果与空文本都如实报错', () => {
    expect(() =>
      deepSeekOcrPageText(
        { error: { message: 'The OCR service is temporarily unavailable.' } },
        1,
        { width: 1, height: 1 }
      )
    ).toThrow('识别失败');
    expect(() => deepSeekOcrPageText({ pages: [] }, 1, { width: 1, height: 1 })).toThrow(
      '没有返回页面结果'
    );
    expect(() => deepSeekOcrPageText({ pages: [{ text: '   ' }] }, 1, { width: 1, height: 1 })).toThrow(
      '文本为空'
    );
  });
});
