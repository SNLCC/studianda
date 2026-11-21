/**
 * 阅读页浮层定位的回归网（纯函数，node 环境，无需 DOM）。
 *
 * 盯住的核心口径：浮层坐标必须用页面元素当前的窗口矩形换算，缩放后页面矩形
 * 已经变化，不能再乘一次缩放系数；否则快捷菜单/批注弹窗会在放大后越偏越远。
 */
import { describe, expect, it } from 'vitest';
import { clampFixedBox, pageAnchorToViewport } from '../src/reader-overlay.js';

describe('pageAnchorToViewport', () => {
  it('按页面在窗口中的实际矩形换算归一化锚点', () => {
    expect(
      pageAnchorToViewport(
        { left: 100, top: 50, width: 800, height: 1000 },
        { x: 0.5, y: 0.25 },
        { x: 0, y: 8 }
      )
    ).toEqual({ x: 500, y: 308 });
  });

  it('缩放后的页面矩形直接使用，不做二次缩放', () => {
    // 200% 缩放：页面在窗口中的矩形是 1600×2000，可能滚到视口左侧外。
    expect(
      pageAnchorToViewport({ left: -300, top: 120, width: 1600, height: 2000 }, { x: 0.125, y: 0.5 })
    ).toEqual({ x: -100, y: 1120 });
  });

  it('页面滚动（矩形 top 变负）时锚点跟着上移', () => {
    expect(
      pageAnchorToViewport({ left: 0, top: -640, width: 800, height: 1000 }, { x: 0, y: 0.9 })
    ).toEqual({ x: 0, y: 260 });
  });
});

describe('clampFixedBox', () => {
  const viewport = { width: 1200, height: 800 };

  it('视口内保持原位', () => {
    expect(clampFixedBox(120, 80, 360, 44, viewport)).toEqual({ x: 120, y: 80 });
  });

  it('右侧/底部越界时夹回视口内', () => {
    expect(clampFixedBox(1100, 790, 360, 300, viewport)).toEqual({ x: 832, y: 492 });
  });

  it('负坐标夹到边距', () => {
    expect(clampFixedBox(-40, -10, 360, 300, viewport)).toEqual({ x: 8, y: 8 });
  });

  it('浮窗比视口大时优先保证左上角可见', () => {
    expect(clampFixedBox(500, 500, 2000, 2000, viewport)).toEqual({ x: 8, y: 8 });
  });

  it('自定义边距生效', () => {
    expect(clampFixedBox(1180, 780, 360, 300, viewport, 16)).toEqual({ x: 824, y: 484 });
  });
});
