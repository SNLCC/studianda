import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '@studianda/shared';
import { guardEmptyAnswer } from '../src/chat.js';

/**
 * 空回答兜底：模型偶尔返回空正文（实测一次 3.7 秒、无内容）。
 * 空字符串不能让用户以为"文献里没有答案"，至少给可执行提示并说清原因。
 */
describe('空回答兜底', () => {
  it('空字符串 → 可执行提示 + 如实说明原因', () => {
    const result = guardEmptyAnswer({
      answer: '   ',
      sources: [],
      answer_mode: 'reading'
    } as ChatResponse);
    expect(result.answer).toContain('没有生成可用回答');
    expect(result.answer).toContain('重试');
    expect(result.notice).toContain('空正文');
    expect(result.notice).toContain('不代表文献里没有相关内容');
  });

  it('已有 notice 时保留原说明并追加', () => {
    const result = guardEmptyAnswer({
      answer: '',
      sources: [],
      notice: '已排除 3 个与问题无关的单元'
    } as ChatResponse);
    expect(result.notice).toContain('已排除 3 个与问题无关的单元');
    expect(result.notice).toContain('空正文');
  });

  it('正常回答原样返回（同一个对象，不复制）', () => {
    const response = { answer: '有内容的回答', sources: [] } as ChatResponse;
    expect(guardEmptyAnswer(response)).toBe(response);
  });

  it('answer 为 null（继续阅读任务等）不当作空回答', () => {
    const response = { answer: null, sources: [] } as unknown as ChatResponse;
    expect(guardEmptyAnswer(response)).toBe(response);
  });
});
