import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  hitPagesFor,
  MIN_SIMILARITY,
  pickPages,
  RELATIVE_CUTOFF
} from '../src/semantic.js';

describe('semantic wide recall', () => {
  it('keeps the relative-best pages, not a fixed top-K', () => {
    expect(pickPages({ 1: 0.62, 2: 0.5, 3: 0.49, 4: 0.31, 5: 0.2 })).toEqual([1, 2]);
    expect(pickPages({ 1: 0.29, 2: 0.28 })).toEqual([]);
    expect(pickPages({ 1: 0.9, 2: 0.89, 3: 0.88 })).toEqual([1, 2, 3]);
    expect(RELATIVE_CUTOFF).toBe(0.8);
    expect(MIN_SIMILARITY).toBe(0.3);
  });

  it('sorts pages ascending and respects the limit', () => {
    expect(pickPages({ 5: 0.9, 2: 0.85, 9: 0.84 }, 2)).toEqual([2, 5]);
  });

  it('takes the best score per page for multi-chunk pages', () => {
    const vectors = [
      [1, 0],
      [0, 1],
      [0.9, 0.1]
    ];
    expect(
      hitPagesFor(
        [
          [1, 'a'],
          [2, 'b'],
          [1, 'c']
        ],
        [1, 0],
        vectors
      )
    ).toEqual([1]);
  });

  it('returns zero for zero/ mismatched vectors instead of throwing', () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});
