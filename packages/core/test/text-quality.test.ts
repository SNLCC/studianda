import { describe, expect, it } from 'vitest';
import { textQuality } from '../src/structure.js';

describe('textQuality', () => {
  it('正常中英文文本不判可疑', () => {
    const quality = textQuality('这是正常的论文正文，包含 English words 和数字 2026。');
    expect(quality.suspect).toBe(false);
    expect(quality.bad_ratio).toBe(0);
    expect(quality.characters).toBeGreaterThan(0);
  });

  it('替换字符超过 2% 判可疑', () => {
    const text = '正常文字'.repeat(10) + '\uFFFD'.repeat(3);
    expect(textQuality(text).suspect).toBe(true);
    expect(textQuality(text).bad_ratio).toBeGreaterThan(0.02);
  });

  it('私用区/控制字符同样计入坏字符', () => {
    const privateUse = 'abc\uE000\uE001\uE002def';
    expect(textQuality(privateUse).suspect).toBe(true);
    const controls = 'abc\u0001\u0002\u0003def';
    expect(textQuality(controls).suspect).toBe(true);
  });

  it('空文本不算可疑（缺页由 missing_pages 处理）', () => {
    expect(textQuality('')).toEqual({ suspect: false, bad_ratio: 0, characters: 0 });
    expect(textQuality('   \n\t')).toEqual({ suspect: false, bad_ratio: 0, characters: 0 });
  });
});
