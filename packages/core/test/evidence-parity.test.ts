import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ReadingError,
  verifiedFindings,
  type ReadingSource
} from '../src/reading.js';

interface EvidenceCase {
  name: string;
  json: string;
  sources: ReadingSource[];
  salvage?: boolean;
  foreign_page?: number;
  expected:
    | {
        ok: true;
        result: {
          analysis: string;
          evidence: Array<{ source: number; quote: string }>;
          no_relevant_evidence: boolean;
          quotes_rejected?: Array<{ reason: string; quote: string }>;
        };
      }
    | {
        ok: false;
        message: string;
        foreign: [number, string] | null;
        faults: Array<[string, string, string]>;
      };
}

const cases = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'evidence-parity.json'),
    'utf8'
  )
) as EvidenceCase[];

describe('verified_findings parity with Python reading.py', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const options = {
        salvage: testCase.salvage,
        locate: testCase.foreign_page
          ? () => testCase.foreign_page ?? null
          : undefined
      };
      if (testCase.expected.ok) {
        const result = verifiedFindings(
          testCase.json,
          new Set([1, 2]),
          testCase.sources,
          options
        );
        expect(result.analysis).toBe(testCase.expected.result.analysis);
        expect(
          result.evidence.map((item) => ({ source: item.source, quote: item.quote }))
        ).toEqual(
          testCase.expected.result.evidence.map((item) => ({
            source: item.source,
            quote: item.quote
          }))
        );
        expect(result.no_relevant_evidence).toBe(
          testCase.expected.result.no_relevant_evidence
        );
        expect(result.quotes_rejected?.map((item) => item.quote)).toEqual(
          testCase.expected.result.quotes_rejected?.map((item) => item.quote)
        );
      } else {
        try {
          verifiedFindings(testCase.json, new Set([1, 2]), testCase.sources, options);
          throw new Error('expected ReadingError');
        } catch (error) {
          expect(error).toBeInstanceOf(ReadingError);
          const readingError = error as ReadingError;
          expect(readingError.message).toBe(testCase.expected.message);
          expect(readingError.foreign).toEqual(testCase.expected.foreign);
          expect(readingError.faults.length).toBe(testCase.expected.faults.length);
        }
      }
    });
  }
});
