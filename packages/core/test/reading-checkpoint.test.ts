import { describe, expect, it } from 'vitest';
import { batchFingerprint, reduceFingerprint } from '../src/reading-checkpoint.js';
import type { ReadingSource } from '../src/reading.js';

/**
 * 内容寻址批次键。
 *
 * 这些用例盯的是「键什么时候必须变」：用户校订了一页、换了问题/模型、分批方式变了，
 * 旧存档就不能再被当成「这一批已读完」——否则继续阅读会跳过本该重读的原文。
 */

function source(page: number, text: string, documentId = 'doc-1'): ReadingSource {
  return { document_id: documentId, page, name: 'paper.pdf', text };
}

function groupOf(sources: ReadingSource[]): Array<[number, ReadingSource]> {
  return sources.map((row, index) => [index + 1, row]);
}

describe('batchFingerprint', () => {
  const sources = [source(1, '第一页原文'), source(2, '第二页原文')];
  const group = groupOf(sources);

  it('同一输入总是同一个键（确定性）', () => {
    const first = batchFingerprint(group, sources, 'q1');
    const second = batchFingerprint(groupOf(sources), sources, 'q1');
    expect(second).toEqual(first);
    expect(first.stage).toBe(`batch:${first.digest.slice(0, 32)}`);
    expect(first.stage.startsWith('batch:')).toBe(true);
    expect(first.stage).toHaveLength('batch:'.length + 32);
    expect(first.digest).toHaveLength(64);
  });

  it('页文本变了，键就变（校订/换版本后必须重读）', () => {
    const edited = [source(1, '第一页原文（已校订）'), source(2, '第二页原文')];
    expect(batchFingerprint(groupOf(edited), edited, 'q1').stage).not.toBe(
      batchFingerprint(group, sources, 'q1').stage
    );
  });

  it('identity 变了，键就变（换问题/模型/容量后不复用）', () => {
    expect(batchFingerprint(group, sources, 'q2').stage).not.toBe(
      batchFingerprint(group, sources, 'q1').stage
    );
    expect(batchFingerprint(group, sources, 'q1').digest).not.toBe(
      batchFingerprint(group, sources, 'q2').digest
    );
  });

  it('来源顺序变了，键就变（不同的一批不能混用存档）', () => {
    const reversed = [...group].reverse();
    expect(batchFingerprint(reversed, sources, 'q1').stage).not.toBe(
      batchFingerprint(group, sources, 'q1').stage
    );
  });

  it('键里只放摘要：stage/digest 都是十六进制，不含原文', () => {
    const key = batchFingerprint(group, sources, 'q1');
    expect(key.stage).toMatch(/^batch:[0-9a-f]{32}$/);
    expect(key.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(key)).not.toContain('第一页原文');
  });

  it('同一页内容但不同文献：键不同（文献身份参与摘要）', () => {
    const other = [source(1, '第一页原文', 'doc-2'), source(2, '第二页原文', 'doc-2')];
    expect(batchFingerprint(groupOf(other), other, 'q1').stage).not.toBe(
      batchFingerprint(group, sources, 'q1').stage
    );
  });
});

describe('reduceFingerprint', () => {
  const pack = [{ analysis: '第一包要点' }, { analysis: '第二包要点' }];

  it('确定性、reduce: 前缀、32 位摘要', () => {
    const first = reduceFingerprint(pack, 'q1');
    expect(reduceFingerprint([...pack], 'q1')).toEqual(first);
    expect(first.stage).toBe(`reduce:${first.digest.slice(0, 32)}`);
    expect(first.stage).toMatch(/^reduce:[0-9a-f]{32}$/);
  });

  it('内容或 identity 改变都会换键', () => {
    expect(reduceFingerprint([{ analysis: '改过的要点' }], 'q1').stage).not.toBe(
      reduceFingerprint(pack, 'q1').stage
    );
    expect(reduceFingerprint(pack, 'q2').stage).not.toBe(reduceFingerprint(pack, 'q1').stage);
  });
});
