import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contrastPages,
  counterSentences,
  falsificationReport,
  markersIn,
  oppositeQueries
} from '../src/falsify.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'falsify-parity.json'
    ),
    'utf8'
  )
) as {
  rows: Array<[number, string]>;
  scope: number[];
  extra_pages: number[];
  limit: number;
  queries: string[];
  note: string;
  markersStrong: string[];
  markersWeakPage: string[];
  contrast: Record<string, string[]>;
  counter: string[];
  report: unknown;
  opposite: string[];
};

describe('falsify parity with Python', () => {
  it('detects strong contrast markers', () => {
    expect(markersIn(fixture.rows[1]![1], true)).toEqual(fixture.markersStrong);
    expect(markersIn(fixture.rows[2]![1], true)).toEqual(fixture.markersWeakPage);
  });

  it('finds contrast pages and counter sentences', () => {
    expect(contrastPages(fixture.rows)).toEqual(fixture.contrast);
    expect(counterSentences('然而，这一结论只在样本足够大时成立。作者再次强调。')).toEqual(
      fixture.counter
    );
  });

  it('builds the falsification report', () => {
    expect(
      falsificationReport(
        fixture.rows,
        fixture.scope,
        fixture.extra_pages,
        fixture.limit,
        fixture.queries,
        fixture.note
      )
    ).toEqual(fixture.report);
  });

  it('builds deterministic opposite queries', () => {
    expect(oppositeQueries(['X', 'X', '理论与政策'], 'X 的概念', 3)).toEqual(
      fixture.opposite
    );
  });
});
