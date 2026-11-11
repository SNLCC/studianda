import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { retrieve } from '../src/retrieval.js';
import { resolveScopeIds } from '../src/scope.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

interface RetrievalCase {
  name: string;
  query: string;
  documents: Array<{ id: string; tags: string[] }>;
  chunks: Array<{ id: string; document_id: string; page: number; text: string }>;
  crossBook: boolean;
  scope: 'all' | 'tags' | 'documents';
  scopeTags: string[];
  scopeDocuments: string[];
  expected: Array<{ id: string; document_id: string; page: number }>;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'scope-retrieval-parity.json'), 'utf8')
) as RetrievalCase[];
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-scope-retrieval-'));
const store = new Store(dataDir);
const db = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
for (const document of fixture[0]!.documents) {
  db.prepare(
    `INSERT INTO documents(id, name, pages, current_page, created, deleted, storage_kind, author)
     VALUES (?, ?, ?, 1, ?, 0, 'copy', '')`
  ).run(document.id, document.id, 2, '2026-01-01T00:00:00Z');
}
for (const chunk of fixture[0]!.chunks) {
  db.prepare(
    'INSERT INTO chunks(id, document_id, page, text, bbox, bbox_space) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(chunk.id, chunk.document_id, chunk.page, chunk.text, '', 'visual');
}
db.close();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('scoped retrieval order matches Python main.retrieve', () => {
  for (const testCase of fixture) {
    it(testCase.name, async () => {
      const scopeDocumentIds = resolveScopeIds(testCase.documents, {
        documentId: 'd1',
        crossBook: testCase.crossBook,
        scope: testCase.scope,
        scopeTags: testCase.scopeTags,
        scopeDocuments: testCase.scopeDocuments
      });
      const hits = await retrieve(
        store,
        new SecretStore(),
        testCase.query,
        'd1',
        1,
        'close',
        10,
        { scopeDocumentIds, includeDerived: true }
      );
      expect(hits.map((hit) => hit.chunkId)).toEqual(testCase.expected.map((hit) => hit.id));
      expect(hits.map((hit) => hit.page)).toEqual(testCase.expected.map((hit) => hit.page));
      expect(hits.map((hit) => hit.documentId)).toEqual(
        testCase.expected.map((hit) => hit.document_id)
      );
    });
  }
});
