import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { translationJobState } from '../src/translation-service.js';
import type { TranslationPageRecord, TranslationSegmentRecord } from '@studianda/shared';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-translation-store-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const page: TranslationPageRecord = {
  documentId: 'doc-1',
  page: 2,
  sourceHash: 'hash',
  engine: 'remote',
  status: 'done',
  error: '',
  done: 1,
  total: 1,
  updated: '2026-10-27T00:00:00Z'
};

const segment: TranslationSegmentRecord = {
  id: 'seg-1',
  documentId: 'doc-1',
  page: 2,
  segment: 1,
  source: 'Source text.',
  sourceHash: 'source-hash',
  text: '译文。',
  engine: 'remote',
  service: 'mock',
  terms: '[]',
  unknownTerms: '[]',
  coverage: null,
  edited: false,
  origin: 'machine',
  previousText: '',
  previousOrigin: ''
};

describe('translation page/segment storage', () => {
  it('saves and reads translated pages and segments', () => {
    store.saveTranslationPage(page);
    store.saveTranslationSegments([segment]);

    expect(store.getTranslationPage('doc-1', 2)).toEqual(page);
    expect(store.listTranslationPages('doc-1')).toEqual([page]);
    expect(store.getTranslationSegments('doc-1', 2)).toEqual([segment]);
  });

  it('returns null/empty for unknown pages', () => {
    expect(store.getTranslationPage('doc-1', 99)).toBeNull();
    expect(store.getTranslationSegments('doc-1', 99)).toEqual([]);
  });

  it('marks a persisted running job as interrupted after restart', () => {
    store.saveTranslationJob({
      documentId: 'doc-restart',
      status: 'running',
      total: 3,
      done: 1,
      currentPage: 2,
      error: ''
    });
    expect(translationJobState(store, 'doc-restart')).toMatchObject({
      status: 'stopped',
      done: 1,
      currentPage: null
    });
    expect(translationJobState(store, 'doc-restart')?.error).toContain('中断');
  });

  it('edits and restores a machine translation segment', () => {
    store.saveTranslationSegments([segment]);
    store.editTranslationSegment('doc-1', segment.id, '人工译文。');
    expect(store.getTranslationSegments('doc-1', 2)[0]).toMatchObject({
      text: '人工译文。',
      edited: true,
      origin: 'user',
      previousText: segment.text,
      previousOrigin: 'machine'
    });

    expect(store.restoreTranslationSegment('doc-1', segment.id)).toMatchObject({
      ok: true,
      restored: true
    });
    expect(store.getTranslationSegments('doc-1', 2)[0]).toMatchObject({
      text: segment.text,
      edited: false,
      origin: 'machine'
    });
  });

  it('summarizes old services and legacy translations', () => {
    store.saveTranslationSegments([
      { ...segment, id: 'seg-old', segment: 2, service: 'old-model' },
      { ...segment, id: 'seg-legacy', segment: 3, service: '' }
    ]);
    const summary = store.translationServiceSummary('doc-1');
    expect(summary.total).toBeGreaterThanOrEqual(2);
    expect(summary.legacy).toBeGreaterThanOrEqual(1);
    expect(summary.services.some((row) => row.service === 'old-model')).toBe(true);
  });
});
