import type { RuntimeAdapter as BaseRuntimeAdapter } from './runtime.js';

export { StudiandaApp, configurePdfWorker } from './StudiandaApp.js';
export { appDialogs, setAppDialogs } from './dialogs.js';
export type { AppDialogs, ConfirmDialogOptions } from './dialogs.js';
export { TranslationWindow, TRANSLATION_CHANNEL } from './TranslationWindow.js';
export { BootstrapGate, DataSetupView, ShellTitleBar } from './ShellChrome.js';
export {
  createShadowHost,
  type ShadowHostHandle,
  type ShadowHostOptions
} from './shadow-host.js';
export { BrandMark } from '@studianda/ui';
export type { DataSetupState, WindowControlsAdapter } from './runtime.js';
export { useAppStore, type AppState } from './store.js';
export { SettingsView } from './SettingsView.js';
export {
  UsageNoticeDialog,
  USAGE_NOTICE_APPLICABLE_VERSION,
  USAGE_NOTICE_EFFECTIVE_DATE,
  USAGE_NOTICE_SECTIONS,
  USAGE_NOTICE_STORAGE_KEY,
  USAGE_NOTICE_VERSION,
  AGE_CONFIRM_STORAGE_KEY,
  hasReadCurrentUsageNotice,
  markAgeConfirmed,
  markUsageNoticeRead,
  readAgeConfirmed,
  readUsageNoticeVersion,
  type UsageNoticeSection
} from './usage-notice.js';
export { USAGE_NOTICE_DOC_URL, openExternalLink } from './external-links.js';
export {
  QaView,
  QA_HISTORY_STORAGE_KEY,
  type QaViewProps
} from './QaView.js';

/**
 * 壳适配器（在基础接口上追加独立译文窗口）。
 *
 * `openTranslationWindow` 是可选能力：Electron 壳实现，其它壳（如将来的 DSH 插件）
 * 不实现时，阅读器面板的「独立译文窗口」按钮保持禁用并提示原因。
 */
export type RuntimeAdapter = BaseRuntimeAdapter & {
  openTranslationWindow?(input: {
    documentId: string;
    page: number;
  }): Promise<{ ok: boolean; message?: string }>;
};
