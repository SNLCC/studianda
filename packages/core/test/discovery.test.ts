import { describe, expect, it } from 'vitest';
import {
  discoveryReport,
  documentScores,
  orderDocuments,
  termsOf
} from '../src/discovery.js';

const docs = [
  { id: 'b', name: '乙文献' },
  { id: 'a', name: '甲文献' },
  { id: 'c', name: '丙文献' }
];

describe('discovery', () => {
  it('术语提取：中文连续段与英文单词，去重、保序、有上限', () => {
    expect(termsOf('深度学习与 Transformer-based 模型 深度学习')).toEqual([
      '深度学习与',
      'transformer-based',
      '模型',
      '深度学习'
    ]);
    expect(termsOf('a b c d e f g h i j k l m n')).toEqual([]);
    expect(termsOf('模型 模型 模型', 1)).toEqual(['模型']);
  });

  it('命中数只统计文本里出现的术语', () => {
    const scores = documentScores(['模型', 'transformer'], {
      a: '这篇讲模型训练。',
      b: '这篇讲 Transformer 结构。',
      c: '',
      d: '无关内容'
    });
    expect(scores).toEqual({ a: 1, b: 1, c: 0, d: 0 });
  });

  it('排序：当前文献第一 → 命中数降序 → 名称 → id，且返回全部文献', () => {
    const scores = { a: 2, b: 1, c: 0 };
    expect(orderDocuments(docs, scores, 'c').map((doc) => doc.id)).toEqual([
      'c',
      'a',
      'b'
    ]);
    // 集合不减少：三篇都在。
    expect(orderDocuments(docs, scores, 'c')).toHaveLength(3);
    // 零命中的文献不会被剔除，只是排在后面。
    const ordered = orderDocuments(docs, { a: 5, b: 5, c: 0 }, '').map((doc) => doc.id);
    expect(ordered[2]).toBe('c');
    expect([...ordered].sort()).toEqual(['a', 'b', 'c']);
  });

  it('报告说清排序≠筛选', () => {
    const report = discoveryReport(docs, { a: 2, b: 0, c: 0 }, 'b', ['模型']);
    expect(report.ordered_ids[0]).toBe('b');
    expect(report.candidates).toBe(3);
    expect(report.hit_documents).toBe(1);
    expect(report.note).toContain('不决定读不读');
    expect(report.terms).toEqual(['模型']);
  });
});
