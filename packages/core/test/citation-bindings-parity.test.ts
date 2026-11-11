import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { citationBindings, type CitationSource } from '../src/citations.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'citation-bindings-parity.json'
    ),
    'utf8'
  )
) as {
  answer: string;
  report: { claims: Array<{ claim: number; evidence: Array<{ source: number; quote: string }> }> };
  sources: CitationSource[];
  expected: Array<{ index: number; line: number; quote: string }>;
};

describe('citation bindings parity with Python', () => {
  it('binds citations by answer line and audit evidence', () => {
    expect(
      citationBindings(fixture.answer, fixture.report.claims, fixture.sources)
    ).toEqual(fixture.expected);
  });
});
