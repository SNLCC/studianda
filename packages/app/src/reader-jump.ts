/**
 * 阅读页「跳页」登记：文献信息弹窗里的全书摘要章节需要跳到原文页。
 *
 * 页面状态在阅读组件内部（`ReaderView`），弹窗在其外层；这里用一个模块级处理器
 * 做单向登记，避免把整棵组件树都接一遍 props。同一时间只保留当前打开的那篇文献。
 */

type ReaderJumpHandler = (page: number) => boolean;

let current: ReaderJumpHandler | null = null;

/** 阅读页挂载时登记跳页处理器；卸载/切换文献时清空。 */
export function registerReaderJump(handler: ReaderJumpHandler | null): void {
  current = handler;
}

/** 从其它界面请求跳到某页；当前没有打开的阅读页时返回 false。 */
export function requestReaderJump(page: number): boolean {
  if (!current) return false;
  return current(page);
}
