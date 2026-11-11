import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverageLedger, type CoverageLedgerRow } from '../src/coverage.js';

const dimensions = [
  { code: 'D1', label: '概念界定' },
  { code: 'D2', label: '理论依据' }
];
const batchStates = [{ D1: 'FOUND' as const, D2: 'NOT_FOUND_IN_BATCH' as const }];
const evidenceByDimension = { D1: ['k1'], D2: [] };

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'coverage-ledger-parity.json'
    ),
    'utf8'
  )
) as Array<{
  name: string;
  options: Record<string, unknown>;
  expected: CoverageLedgerRow[];
}>;

describe('coverage ledger parity with Python', () => {
  for (const testCase of fixture) {
    it(testCase.name, () => {
      const raw = testCase.options;
      const ledger = coverageLedger(dimensions, batchStates, {
        evidenceByDimension,
        readablePages: raw.readable_pages as number[] | undefined,
        unreadablePages: raw.unreadable_pages as number[] | undefined,
        notSearchable: raw.not_searchable as boolean | undefined,
        searchedFullDocument: raw.searched_full_document as boolean | undefined,
        gapSearchRan: raw.gap_search_ran as boolean | undefined,
        examinedScopeComplete: raw.examined_scope_complete as boolean | undefined,
        evidencePages: raw.evidence_pages as Record<string, number> | undefined,
        gapSearchSearched: raw.gap_search_searched as boolean | undefined
      });
      expect(ledger).toEqual(testCase.expected);
    });
  }
});
