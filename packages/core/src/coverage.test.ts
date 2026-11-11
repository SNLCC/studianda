import { describe, expect, it } from 'vitest';
import {
  COVERAGE_STATES,
  coverageLedger,
  documentAnswerability,
  evidenceRoles,
  unrecordedLedger
} from './coverage.js';

const dimensions = [{ code: 'D1', label: '概念界定' }];

describe('coverage ledger states', () => {
  it('found when an evidence key is present', () => {
    const rows = coverageLedger(dimensions, [{ D1: COVERAGE_STATES.FOUND }], {
      evidenceByDimension: { D1: ['key-1'] },
      evidencePages: { 'key-1': 2 }
    });
    expect(rows[0]?.status).toBe(COVERAGE_STATES.FOUND);
    expect(rows[0]?.evidence).toEqual(['key-1']);
  });

  it('not found in batch when no evidence and scope is incomplete', () => {
    const rows = coverageLedger(dimensions, [{}], {
      examinedScopeComplete: false
    });
    expect(rows[0]?.status).toBe(COVERAGE_STATES.NOT_FOUND_IN_BATCH);
  });

  it('not searchable when the document has no readable text', () => {
    const rows = coverageLedger(dimensions, [{}], {
      notSearchable: true,
      readablePages: [],
      unreadablePages: [1, 2]
    });
    expect(rows[0]?.status).toBe(COVERAGE_STATES.NOT_SEARCHABLE);
    expect(rows[0]?.unreadable_pages).toEqual([1, 2]);
  });

  it('uncertain when full review left unreadable pages', () => {
    const rows = coverageLedger(dimensions, [{}], {
      searchedFullDocument: true,
      unreadablePages: [4]
    });
    expect(rows[0]?.status).toBe(COVERAGE_STATES.UNCERTAIN);
    expect(rows[0]?.unreadable_pages).toEqual([4]);
  });

  it('not found after full document review when gap search also ran', () => {
    const rows = coverageLedger(dimensions, [{}], {
      searchedFullDocument: true,
      gapSearchRan: true
    });
    expect(rows[0]?.status).toBe(
      COVERAGE_STATES.NOT_FOUND_AFTER_FULL_DOCUMENT_REVIEW
    );
  });

  it('not found after indexed text search when gap search ran without full review', () => {
    const rows = coverageLedger(dimensions, [{}], {
      searchedFullDocument: false,
      gapSearchSearched: true
    });
    expect(rows[0]?.status).toBe(
      COVERAGE_STATES.NOT_FOUND_AFTER_INDEXED_TEXT_SEARCH
    );
  });

  it('not found in read scope when full review had no readable gap pages', () => {
    const rows = coverageLedger(dimensions, [{}], {
      searchedFullDocument: true,
      gapSearchRan: false
    });
    expect(rows[0]?.status).toBe(COVERAGE_STATES.NOT_FOUND_IN_READ_SCOPE);
  });

  it('marks all dimensions as not recorded without batch reports', () => {
    const rows = unrecordedLedger(dimensions, '没有逐批记账');
    expect(rows[0]?.status).toBe(COVERAGE_STATES.NOT_RECORDED);
    expect(rows[0]?.reason).toBe('没有逐批记账');
  });

  it('derives document answerability from verified evidence roles', () => {
    expect(documentAnswerability([], true)).toBe('ABSENT');
    expect(documentAnswerability([], false)).toBe('UNCERTAIN');
    expect(documentAnswerability(['MENTION'])).toBe('MENTION_ONLY');
    expect(documentAnswerability(['CHARACTERIZATION', 'EXAMPLE'])).toBe('PARTIAL');
    expect(documentAnswerability(['DEFINITION', 'MENTION'])).toBe('SUFFICIENT');
    expect(documentAnswerability(['EXPLANATION'])).toBe('SUFFICIENT');
    expect(evidenceRoles([{ role: 'DEFINITION' }, {}, { role: '' }])).toEqual([
      'DEFINITION'
    ]);
  });
});
