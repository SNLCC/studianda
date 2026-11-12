import { describe, expect, it } from 'vitest';
import { markdownJobFingerprint } from '@studianda/shared';

/**
 * 任务指纹用于「用户关闭终态任务卡后不再自动弹回」：
 * 同一任务每次读取必须得到相同指纹；新任务/不同失败原因必须得到不同指纹。
 *
 * 指纹不包含 input/scan/report：lite 快照（SSE/摘要接口）会裁掉这些字段，
 * 引用它们会让同一任务在完整状态与 lite 状态之间算出不同指纹。
 */
describe('markdownJobFingerprint', () => {
  const baseImport = {
    status: 'done',
    resultCompletedAt: '2026-01-02T03:04:05.000Z',
    lastAttemptStatus: 'done',
    error: ''
  };

  it('同一任务多次读取指纹稳定', () => {
    expect(markdownJobFingerprint(baseImport)).toBe(markdownJobFingerprint({ ...baseImport }));
  });

  it('缺少可选字段时也能稳定生成指纹', () => {
    const minimal = { status: 'cancelled' };
    expect(markdownJobFingerprint(minimal)).toBe(markdownJobFingerprint({ ...minimal }));
  });

  it('lite 快照裁掉 input/report 后指纹不变（UI 关闭卡片后的轮询不会弹回）', () => {
    // lite 快照与完整状态只差 scan/report/input 等体积字段；指纹只读取稳定字段。
    const lite = { ...baseImport };
    const full = {
      ...baseImport,
      input: { vaultPath: '/notes/vault', files: ['a.md', 'b.md'] },
      report: { requested: 2, imported: 2 }
    };
    expect(markdownJobFingerprint(lite)).toBe(markdownJobFingerprint(full));
  });

  it('不同终态/完成时间/失败原因得到不同指纹', () => {
    const reference = markdownJobFingerprint(baseImport);
    expect(markdownJobFingerprint({ ...baseImport, status: 'cancelled' })).not.toBe(reference);
    expect(
      markdownJobFingerprint({ ...baseImport, resultCompletedAt: '2026-01-02T03:04:06.000Z' })
    ).not.toBe(reference);
    expect(
      markdownJobFingerprint({ ...baseImport, lastAttemptStatus: 'error' })
    ).not.toBe(reference);
    expect(markdownJobFingerprint({ ...baseImport, error: '扫描笔记库失败：权限不足' })).not.toBe(
      reference
    );
  });

  it('重新开始后完成的同一批文件（新完成时间）不会被旧「已关闭」标记命中', () => {
    const earlier = markdownJobFingerprint({
      ...baseImport,
      resultCompletedAt: '2026-01-01T00:00:00.000Z'
    });
    const later = markdownJobFingerprint({
      ...baseImport,
      resultCompletedAt: '2026-02-01T00:00:00.000Z'
    });
    expect(later).not.toBe(earlier);
  });
});
