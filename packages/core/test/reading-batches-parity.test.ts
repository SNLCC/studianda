import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { batches, cost, splitSources, type ReadingSource } from '../src/reading.js';

interface Fixture {
  costs: Record<string, number>;
  splitBudget: number;
  split: Array<{ id: string; text: string; offset_start: number; offset_end: number }>;
  sources: ReadingSource[];
  batches: Record<string, Array<Array<{ index: number; id: string; page: number }>>>;
  overlapSources: ReadingSource[];
  overlapBatches: Record<string, Array<Array<{ index: number; id: string; page: number }>>>;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'reading-batches-parity.json'), 'utf8')
) as Fixture;

const groupShape = (groups: Array<Array<[number, ReadingSource]>>) =>
  groups.map((group) => group.map(([index, row]) => ({ index, id: row.id, page: row.page })));

describe('reading split/batches parity with Python reading.py', () => {
  it('matches fallback cost', () => {
    for (const source of fixture.sources) {
      expect(cost(source.text)).toBe(fixture.costs[String(source.id)]);
    }
  });

  it('splits oversized pages without dropping text or order', () => {
    const split = splitSources(fixture.sources, fixture.splitBudget);
    expect(
      split.map((row) => ({
        id: row.id,
        text: row.text,
        offset_start: row.offset_start,
        offset_end: row.offset_end
      }))
    ).toEqual(fixture.split);
    const original = fixture.sources
      .map((source) => source.text)
      .join('\u0000');
    const rebuilt = split
      .map((row) => row.text)
      .join('')
      .replace(/\u0000/g, '');
    expect(rebuilt.length).toBe(original.replace(/\u0000/g, '').length);
  });

  it('matches continuous batches and overlap', () => {
    for (const [key, expected] of Object.entries(fixture.batches)) {
      const [budgetText, overlapText] = key.split('-');
      const groups = batches(fixture.sources, Number(budgetText), Number(overlapText));
      expect(groupShape(groups)).toEqual(expected);
    }
    for (const [key, expected] of Object.entries(fixture.overlapBatches)) {
      const [budgetText, overlapText] = key.split('-');
      const groups = batches(
        fixture.overlapSources,
        Number(budgetText),
        Number(overlapText)
      );
      expect(groupShape(groups)).toEqual(expected);
    }
  });
});
