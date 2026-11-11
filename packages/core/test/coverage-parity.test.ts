import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readingCoverage } from '../src/coverage.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'coverage-parity.json'),
    'utf8'
  )
) as {
  findings: Parameters<typeof readingCoverage>[0];
  dimensions: Array<{ code: string; label: string }>;
  expected: ReturnType<typeof readingCoverage>;
};

describe('reading coverage parity with Python reading_coverage', () => {
  it('merges batch dimension hits and evidence keys deterministically', () => {
    expect(readingCoverage(fixture.findings, fixture.dimensions)).toEqual(fixture.expected);
  });

  it('returns an empty record when dimensions or findings are absent', () => {
    expect(readingCoverage([], fixture.dimensions)).toEqual({});
    expect(readingCoverage(fixture.findings, [])).toEqual({});
  });
});
