import { describe, expect, it } from 'vitest';
import {
  REREAD_SKIPPED_NOTE,
  issueSuggestsCoverageGap,
  worthRereading
} from '../src/reread.js';

/**
 * 回读门槛。
 *
 * 盯两件事：①「证据在没读到的页里」才值得再读原文；②摘引与论断不匹配这类
 * 再读也不会变的问题不得触发整篇重写（否则用户白等两次完整生成）。
 */

describe('issueSuggestsCoverageGap', () => {
  it('只认“明确说了没读到”的说法', () => {
    expect(issueSuggestsCoverageGap('第 3 段：证据不在本轮材料里')).toBe(true);
    expect(issueSuggestsCoverageGap('第 5 页未读，仍有缺口')).toBe(true);
    expect(issueSuggestsCoverageGap('原文未纳入本轮阅读范围')).toBe(true);
    expect(issueSuggestsCoverageGap('unread pages remain')).toBe(true);
    expect(issueSuggestsCoverageGap('this page was not read')).toBe(true);
  });

  it('刻意保守：缺证、页码、编号都不算“没读到”', () => {
    expect(issueSuggestsCoverageGap('第 2 段缺少本轮证据支持')).toBe(false);
    expect(issueSuggestsCoverageGap('摘引其实逐字出现在 [3]')).toBe(false);
    expect(issueSuggestsCoverageGap('第 5 页有相关论述')).toBe(false);
    expect(issueSuggestsCoverageGap('这条摘引与论断不匹配')).toBe(false);
    expect(issueSuggestsCoverageGap('')).toBe(false);
  });
});

describe('worthRereading', () => {
  it('任一覆盖类问题就值得回读（一次也值得：回读真有东西可补）', () => {
    expect(
      worthRereading(['第 2 段缺少本轮证据支持', '第 4 段的原文未纳入本轮材料'])
    ).toBe(true);
    expect(worthRereading(['unread 第 9 页'])).toBe(true);
  });

  it('匹配类问题要够 minimumMissing 段缺证才回读', () => {
    expect(worthRereading(['第 1 段：摘引不支持第二个分句'])).toBe(false);
    expect(worthRereading(['第 1 段缺少本轮证据支持'])).toBe(false);
    expect(
      worthRereading(['第 1 段缺少本轮证据支持', '第 2 段缺少本轮证据支持'])
    ).toBe(true);
    expect(worthRereading(['第 1 段缺少本轮证据支持'], 1)).toBe(true);
    expect(worthRereading([])).toBe(false);
  });

  it('非字符串项忽略，不影响判断', () => {
    expect(
      worthRereading([null, 42, undefined, { issue: 'x' }, '第 1 段缺少本轮证据支持'])
    ).toBe(false);
    expect(worthRereading([null, 'unread 第 9 页'])).toBe(true);
  });

  it('不回读的说明如实写“没有重写”，不把未回读说成已回读', () => {
    expect(REREAD_SKIPPED_NOTE).toContain('不需要再读原文');
    expect(REREAD_SKIPPED_NOTE).toContain('本轮没有重写整篇回答');
  });
});
