import { resolveConfirm, type ConfirmAction } from './dialog-utils.js';

/** 笔记彻底删除的统一确认文案：NotesPanel 与 StandaloneNotesView 共用。 */
export const PURGE_NOTE_CONFIRM_TEXT =
  '彻底删除这条笔记？不可恢复，会同时清理只被它引用的图片资源。';

/** 批注彻底删除的确认文案。 */
export const PURGE_ANNOTATION_CONFIRM_TEXT =
  '彻底删除这条批注？不可恢复，会同时清理只被它引用的图片资源。';

/**
 * 笔记彻底删除确认。
 *
 * `confirmAction` 由宿主注入（app 传自己的 dialogs；未注入时用浏览器原生 confirm）；
 * 非浏览器环境返回 false，不触发删除。
 */
export function confirmPurgeNote(confirmAction?: ConfirmAction): boolean {
  return resolveConfirm(confirmAction)(PURGE_NOTE_CONFIRM_TEXT);
}

/** 批注彻底删除确认；语义同 `confirmPurgeNote`。 */
export function confirmPurgeAnnotation(confirmAction?: ConfirmAction): boolean {
  return resolveConfirm(confirmAction)(PURGE_ANNOTATION_CONFIRM_TEXT);
}
