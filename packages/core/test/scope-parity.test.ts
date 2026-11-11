import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveScopeIds, type ScopeRequest } from '../src/scope.js';

interface FixtureCase {
  name: string;
  documents: Array<{ id: string; tags: string[] }>;
  ids?: string[];
  error?: string;
}

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'scope-parity.json'
);

describe('scope parity with Python main.scope_ids', () => {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureCase[];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const requests: Record<string, ScopeRequest> = {
        single: { documentId: 'd1' },
        all: { documentId: 'd1', crossBook: true, scope: 'all' },
        'tags-common': {
          documentId: 'd1',
          crossBook: true,
          scope: 'tags',
          scopeTags: ['common']
        },
        'tags-none': {
          documentId: 'd1',
          crossBook: true,
          scope: 'tags',
          scopeTags: ['missing']
        },
        'documents-without-current': {
          documentId: 'd1',
          crossBook: true,
          scope: 'documents',
          scopeDocuments: ['d2']
        },
        'documents-subset': {
          documentId: 'd1',
          crossBook: true,
          scope: 'documents',
          scopeDocuments: ['d1', 'd3']
        }
      };
      const request = requests[testCase.name];
      expect(request).toBeTruthy();
      if (testCase.error) {
        expect(() => resolveScopeIds(testCase.documents, request!)).toThrow(testCase.error);
      } else {
        expect([...resolveScopeIds(testCase.documents, request!)].sort()).toEqual(testCase.ids);
      }
    });
  }
});
