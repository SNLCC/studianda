/**
 * 复制纯文本：优先 Clipboard API，被拒绝时退回 `document.execCommand('copy')`。
 *
 * 阅读页的「复制」按钮复制的是 PDF 选区原文。Electron 桌面壳（`file://`）、
 * 内嵌宿主（iframe/shadow，剪贴板权限不一定授予）里 `navigator.clipboard.writeText`
 * 都可能抛错；只写一句 `void navigator.clipboard.writeText(...)` 会让按钮看起来
 * “点了没反应”。这里显式返回成功/失败，让调用方给出可见反馈。
 */
export interface CopyDependencies {
  /** 测试注入：优先路径。 */
  writeClipboard?: (text: string) => Promise<void>;
  /** 测试注入：回退路径。 */
  writeLegacy?: (text: string) => boolean;
}

/** 复制文本；成功返回 true，两条路径都失败返回 false（不抛错）。 */
export async function copyPlainText(
  text: string,
  dependencies: CopyDependencies = {}
): Promise<boolean> {
  // 只有空白等于没选中内容：不写剪贴板，也不报告成功。
  if (!text.trim()) return false;
  const writeClipboard = dependencies.writeClipboard ?? clipboardWrite;
  const writeLegacy = dependencies.writeLegacy ?? legacyCopy;
  try {
    await writeClipboard(text);
    return true;
  } catch {
    return writeLegacy(text);
  }
}

function clipboardWrite(text: string): Promise<void> {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    return Promise.reject(new Error('clipboard-api-unavailable'));
  }
  return navigator.clipboard.writeText(text);
}

/**
 * 旧接口回退：用一个临时 textarea 承载文本并选中，再执行 copy 命令。
 * 结束后移除 textarea 并恢复原来的选区，避免复制打断用户正在看的选中文字。
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText =
    'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(area);
  const selection = document.getSelection();
  const saved =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  let copied = false;
  try {
    area.select();
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    if (saved && selection) {
      try {
        selection.removeAllRanges();
        selection.addRange(saved);
      } catch {
        // 选区所在的文本层可能刚好被重绘替换；恢复失败不影响已经写入的剪贴板内容。
      }
    }
  }
  return copied;
}
