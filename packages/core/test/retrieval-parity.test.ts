import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localRerank, localVectors, rank, tokens } from '../src/retrieval.js';

interface Fixture {
  query: string;
  chunks: Array<{
    id: string;
    document_id: string;
    page: number;
    name: string;
    text: string;
  }>;
  rank: Array<{ id: string; score: number }>;
  local_vectors: Array<{ id: string; score: number }>;
  local_rerank: Array<{ id: string; score: number }>;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/retrieval-parity.json'), 'utf8')
) as Fixture;

const chunks = fixture.chunks.map((chunk) => ({
  id: chunk.id,
  documentId: chunk.document_id,
  page: chunk.page,
  name: chunk.name,
  text: chunk.text
}));

function closeTo(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.0002);
}

describe('parity with Python retrieval', () => {
  it('tokenizes English words and Chinese bigrams the same way', () => {
    expect(tokens('Local retrieval 本地优先 文献')).toEqual([
      'local',
      'retrieval',
      '本地',
      '地优',
      '优先',
      '文献'
    ]);
  });

  it('matches Python rank() scores and order', () => {
    const actual = rank(fixture.query, chunks, 'doc-a', 1, 'close', 4);
    expect(actual.map((row) => row.id)).toEqual(fixture.rank.map((row) => row.id));
    actual.forEach((row, index) => {
      closeTo(row.score, fixture.rank[index]?.score ?? 0);
    });
  });

  it('matches Python local_vectors() cosine scores', () => {
    const vectors = localVectors([fixture.query, ...chunks.map((chunk) => chunk.text)]);
    const queryVector = vectors[0] ?? new Map<string, number>();
    const actual = chunks
      .map((chunk, index) => {
        const vector = vectors[index + 1] ?? new Map<string, number>();
        let score = 0;
        for (const [token, value] of queryVector) score += value * (vector.get(token) ?? 0);
        return { id: chunk.id, score: Math.round(score * 10000) / 10000 };
      })
      .sort((left, right) => right.score - left.score);
    expect(actual.map((row) => row.id)).toEqual(fixture.local_vectors.map((row) => row.id));
    actual.forEach((row, index) => {
      closeTo(row.score, fixture.local_vectors[index]?.score ?? 0);
    });
  });

  it('matches Python local_rerank() as a reorder-only operation', () => {
    const ranked = rank(fixture.query, chunks, 'doc-a', 1, 'close', 4);
    const actual = localRerank(fixture.query, ranked, 4);
    expect(actual.map((row) => row.id)).toEqual(fixture.local_rerank.map((row) => row.id));
    actual.forEach((row, index) => {
      closeTo(row.score, fixture.local_rerank[index]?.score ?? 0);
    });
  });

  it('预计算词频复用与逐次分词的结果一致（性能优化不改变排序）', () => {
    const counts = [...chunks, ...[]].map((chunk) => {
      const map = new Map<string, number>();
      for (const token of tokens(chunk.text)) map.set(token, (map.get(token) ?? 0) + 1);
      return map;
    });
    const queryCount = new Map<string, number>();
    for (const token of tokens(fixture.query)) {
      queryCount.set(token, (queryCount.get(token) ?? 0) + 1);
    }
    expect(rank(fixture.query, chunks, 'doc-a', 1, 'close', 4, counts)).toEqual(
      rank(fixture.query, chunks, 'doc-a', 1, 'close', 4)
    );
    const reused = localVectors(
      [fixture.query, ...chunks.map((chunk) => chunk.text)],
      [queryCount, ...counts]
    );
    const fresh = localVectors([fixture.query, ...chunks.map((chunk) => chunk.text)]);
    expect(reused).toEqual(fresh);
  });
});
