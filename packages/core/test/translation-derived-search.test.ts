import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TranslationSegmentRecord } from '@studianda/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { retrieve } from '../src/retrieval.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-translation-derived-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const documentId = 'derived-search-doc';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function segment(
  overrides: Partial<TranslationSegmentRecord> & { id: string; text: string }
): TranslationSegmentRecord {
  return {
    documentId,
    page: 1,
    segment: 1,
    source: 'Machine learning improves the baseline.',
    sourceHash: 'source-hash',
    engine: 'remote-model',
    service: 'mock',
    terms: '[]',
    unknownTerms: '[]',
    coverage: null,
    edited: false,
    origin: 'machine',
    previousText: '',
    previousOrigin: '',
    ...overrides
  };
}

describe('translation derived search metadata', () => {
  it('carries segment/edited/translation_id/engine and drops suspicious translations', async () => {
    store.saveTranslationSegments([
      segment({
        id: 'seg-normal',
        segment: 2,
        text: '机器学习 能显著提升基线表现。',
        edited: true,
        origin: 'user'
      }),
      segment({
        id: 'seg-suspicious',
        segment: 3,
        // 替换字符占比远高于 2%：textQuality 判可疑，不应进入派生检索。
        text: `${'\uFFFD'.repeat(20)} 机器学习`,
        edited: false
      })
    ]);

    const hits = await retrieve(store, secrets, '机器学习', documentId, 1, 'close', 20);
    const translationHits = hits.filter((hit) => hit.translation);
    expect(translationHits).toHaveLength(1);
    const hit = translationHits[0]!;
    expect(hit).toMatchObject({
      chunkId: 'T:seg-normal',
      translation: true,
      derived: true,
      segment: 2,
      edited: true,
      translation_id: 'seg-normal',
      engine: 'remote-model',
      sourceText: 'Machine learning improves the baseline.'
    });
    expect(hits.some((row) => row.chunkId === 'T:seg-suspicious')).toBe(false);

    // 与 store.listDerivedChunks 的元数据一致。
    const stored = store
      .listDerivedChunks([documentId])
      .find((row) => row.id === 'T:seg-normal');
    expect(stored).toMatchObject({
      segment: 2,
      edited: true,
      translation_id: 'seg-normal',
      engine: 'remote-model'
    });
  });
});
