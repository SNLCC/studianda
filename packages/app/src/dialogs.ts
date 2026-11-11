/**
 * 应用级确认/提示/输入对话框。
 *
 * 目标：界面层不再直接出现 `window.confirm/alert/prompt`，由宿主决定对话框实现。
 * 保持**同步**语义（原生对话框本身就是同步的），因此宿主替换实现时也必须是同步函数；
 * 如果将来要做"应用内自绘对话框"，需要把调用方改成 async（单独一步，不影响现在的行为）。
 *
 * - 默认实现：浏览器/Electron 原生对话框；
 * - 宿主（DSH 插件等）可在启动时调用 `setAppDialogs({...})` 覆盖；
 * - 未实现/非浏览器环境返回保守值（confirm=false、prompt=null、alert 忽略）。
 */
export interface ConfirmDialogOptions {
  title?: string;
  danger?: boolean;
}

export interface AppDialogs {
  confirm(message: string, options?: ConfirmDialogOptions): boolean;
  alert(message: string, options?: { title?: string }): void;
  prompt(
    message: string,
    defaultValue?: string,
    options?: { title?: string }
  ): string | null;
}

type ConfirmFn = (message: string, options?: ConfirmDialogOptions) => boolean;
type AlertFn = (message: string, options?: { title?: string }) => void;
type PromptFn = (
  message: string,
  defaultValue?: string,
  options?: { title?: string }
) => string | null;

const nativeDialogs: AppDialogs = {
  confirm: (message, options) =>
    typeof globalThis.confirm === 'function' ? globalThis.confirm(formatMessage(message, options)) : false,
  alert: (message, options) => {
    if (typeof globalThis.alert === 'function') globalThis.alert(formatMessage(message, options));
  },
  prompt: (message, defaultValue, options) =>
    typeof globalThis.prompt === 'function'
      ? globalThis.prompt(formatMessage(message, options), defaultValue)
      : null
};

function formatMessage(message: string, options?: { title?: string }): string {
  return options?.title ? `${options.title}\n\n${message}` : message;
}

let current: AppDialogs = nativeDialogs;

/** 覆盖对话框实现；传 null 恢复原生实现。 */
export function setAppDialogs(next: Partial<AppDialogs> | null): void {
  current = next ? { ...nativeDialogs, ...next } : nativeDialogs;
}

function confirm(message: string, options?: ConfirmDialogOptions): boolean {
  return current.confirm(message, options);
}

function alert(message: string, options?: { title?: string }): void {
  current.alert(message, options);
}

function prompt(
  message: string,
  defaultValue?: string,
  options?: { title?: string }
): string | null {
  return current.prompt(message, defaultValue, options);
}

/** 调用方使用这个对象：`appDialogs.confirm('...')`。 */
export const appDialogs = {
  confirm: confirm as ConfirmFn,
  alert: alert as AlertFn,
  prompt: prompt as PromptFn
} satisfies AppDialogs;
