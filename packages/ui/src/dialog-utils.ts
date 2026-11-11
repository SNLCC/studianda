/**
 * UI 组件里的确认对话框兜底。
 *
 * ui 是纯组件包，不认识 app 的 dialogs 模块，所以通过可选 prop 注入；
 * 未注入时用 `globalThis.confirm`（浏览器/Electron 都有）。
 * 这样 ui 包内不再直接出现 `window.confirm`，宿主/测试也可以替换。
 */
export type ConfirmAction = (message: string) => boolean;

export function fallbackConfirm(message: string): boolean {
  return typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false;
}

/** 解析确认实现：优先宿主注入，其次浏览器原生。 */
export function resolveConfirm(confirmAction?: ConfirmAction): ConfirmAction {
  return confirmAction ?? fallbackConfirm;
}
