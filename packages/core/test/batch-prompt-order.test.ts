import { describe, expect, it } from 'vitest';
import { batchReadingPrompt } from '../src/reading-chat.js';

/**
 * 批量阅读的用户消息顺序：**原文在前、问题/选文在后**。
 *
 * 这是跨轮上下文缓存能命中的前提：同一页集换成另一个问题时，问题之前的整段原文
 * 逐字相同，才可能被当作缓存前缀复用；问题放在前面会让原文块整段作废。
 * 这里的断言只锁顺序与前缀稳定性，不锁具体措辞。
 */
describe('批量阅读消息顺序', () => {
  it('原文在问题与选文之前', () => {
    const prompt = batchReadingPrompt('第 3 页原文块', '问题甲', '选文乙');
    expect(prompt.indexOf('第 3 页原文块')).toBeLessThan(prompt.indexOf('问题甲'));
    expect(prompt.indexOf('问题甲')).toBeLessThan(prompt.indexOf('选文乙'));
  });

  it('同一批原文 + 不同问题：问题之前的前缀逐字相同（缓存可复用）', () => {
    const material = '批次 1/3\n第 3 页原文……';
    const first = batchReadingPrompt(material, '问题甲', '');
    const second = batchReadingPrompt(material, '问题乙', '');
    const prefix = (text: string): string => text.slice(0, text.indexOf('用户问题'));
    expect(prefix(first)).toBe(prefix(second));
    expect(prefix(first)).toContain(material);
  });

  it('没有选文时保持同样顺序', () => {
    const prompt = batchReadingPrompt('原文', '问题', '');
    expect(prompt.startsWith('原文')).toBe(true);
    expect(prompt.endsWith('\n（本轮没有选文——用户没有从文献里选任何文字。）')).toBe(true);
  });
});
