/**
 * 选区「复制」的回退链回归网：Clipboard API 被拒绝时必须退回 execCommand，
 * 两条路径都失败时返回 false（由界面给出“复制失败”反馈），不能静默吞掉。
 */
import { describe, expect, it, vi } from 'vitest';
import { copyPlainText } from '../src/clipboard.js';

describe('copyPlainText', () => {
  it('Clipboard API 成功时不再走旧接口', async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined);
    const writeLegacy = vi.fn().mockReturnValue(true);

    await expect(copyPlainText('选区原文', { writeClipboard, writeLegacy })).resolves.toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith('选区原文');
    expect(writeLegacy).not.toHaveBeenCalled();
  });

  it('Clipboard API 被拒绝时退回 execCommand', async () => {
    const writeClipboard = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const writeLegacy = vi.fn().mockReturnValue(true);

    await expect(copyPlainText('选区原文', { writeClipboard, writeLegacy })).resolves.toBe(true);
    expect(writeLegacy).toHaveBeenCalledWith('选区原文');
  });

  it('Clipboard API 同步抛错（未实现/无安全上下文）同样能回退', async () => {
    const writeClipboard = vi.fn(() => {
      throw new Error('clipboard-api-unavailable');
    });
    const writeLegacy = vi.fn().mockReturnValue(true);

    await expect(copyPlainText('选区原文', { writeClipboard, writeLegacy })).resolves.toBe(true);
    expect(writeLegacy).toHaveBeenCalledOnce();
  });

  it('两条路径都失败时返回 false 而不是抛错', async () => {
    const writeClipboard = vi.fn().mockRejectedValue(new Error('denied'));
    const writeLegacy = vi.fn().mockReturnValue(false);

    await expect(copyPlainText('选区原文', { writeClipboard, writeLegacy })).resolves.toBe(false);
  });

  it('空白文本不碰剪贴板', async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined);
    const writeLegacy = vi.fn().mockReturnValue(true);

    await expect(copyPlainText('   ', { writeClipboard, writeLegacy })).resolves.toBe(false);
    await expect(copyPlainText('', { writeClipboard, writeLegacy })).resolves.toBe(false);
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(writeLegacy).not.toHaveBeenCalled();
  });
});
