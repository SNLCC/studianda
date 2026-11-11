import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { citationSupport, invalidCitations, type CitationSource } from '../src/citations.js';

const cases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'citation-support-parity.json'
    ),
    'utf8'
  )
) as Array<{ name: string; answer: string; sources: CitationSource[]; expected: unknown }>;

describe('citation support parity with Python', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(citationSupport(testCase.answer, testCase.sources)).toEqual(
        testCase.expected
      );
    });
  }

  it('reports out-of-range citation numbers', () => {
    expect(invalidCitations('见 [1]、[0]、[3]、[3]。', 2)).toEqual([0, 3]);
  });
});
