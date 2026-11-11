import { describe, expect, it } from 'vitest';
import type { LayoutLine } from '../src/pdf-layout.js';
import { orderTwoColumnLines } from '../src/pdf-layout.js';

function line(
  text: string,
  bbox: [number, number, number, number]
): LayoutLine {
  return { text, bbox };
}

function twoColumnLines(titleAtTop = false): LayoutLine[] {
  const lines = [
    line('L1', [0.05, 0.2, 0.4, 0.22]),
    line('L2', [0.05, 0.25, 0.4, 0.27]),
    line('L3', [0.05, 0.3, 0.4, 0.32]),
    line('L4', [0.05, 0.35, 0.4, 0.37]),
    line('R1', [0.55, 0.2, 0.95, 0.22]),
    line('R2', [0.55, 0.25, 0.95, 0.27]),
    line('R3', [0.55, 0.3, 0.95, 0.32]),
    line('R4', [0.55, 0.35, 0.95, 0.37])
  ];
  if (titleAtTop) return [line('Cross column title', [0.1, 0.02, 0.9, 0.06]), ...lines];
  return lines;
}

describe('pdf-layout orderTwoColumnLines delegates to structure.orderPageLines', () => {
  it('orders a two-column page: whole left column, then whole right column', () => {
    expect(orderTwoColumnLines(twoColumnLines(), 600).map((item) => item.text)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'R1',
      'R2',
      'R3',
      'R4'
    ]);
  });

  it('emits a full-width cross-column title before both columns', () => {
    expect(
      orderTwoColumnLines(twoColumnLines(true), 600).map((item) => item.text)
    ).toEqual(['Cross column title', 'L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4']);
  });

  it('falls back to y,x for single-column input and invalid page width', () => {
    const lines = [line('later', [0.1, 0.4, 0.9, 0.42]), line('first', [0.1, 0.1, 0.9, 0.12])];
    expect(orderTwoColumnLines(lines, 600).map((item) => item.text)).toEqual([
      'first',
      'later'
    ]);
    // bbox 是归一化坐标：pageWidth 只保留旧签名，不参与阈值。
    expect(orderTwoColumnLines(lines, 0).map((item) => item.text)).toEqual(['first', 'later']);
    expect(orderTwoColumnLines(lines, Number.NaN).map((item) => item.text)).toEqual([
      'first',
      'later'
    ]);
  });

  it('preserves line objects and handles empty input', () => {
    const lines = twoColumnLines(true);
    const ordered = orderTwoColumnLines(lines, 600);
    expect(ordered).toHaveLength(lines.length);
    for (const item of ordered) expect(lines).toContain(item);
    expect(orderTwoColumnLines([], 600)).toEqual([]);
  });
});
