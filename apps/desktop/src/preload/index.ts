import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeInfo, UpdateState } from '@studianda/shared';

contextBridge.exposeInMainWorld('studianda', {
  getRuntime: (): Promise<RuntimeInfo | null> => ipcRenderer.invoke('studianda:get-runtime'),
  pickPdf: (): Promise<string | null> => ipcRenderer.invoke('studianda:pick-pdf'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('studianda:pick-directory'),
  pickMarkdownVault: (): Promise<string | null> =>
    ipcRenderer.invoke('studianda:pick-markdown-vault'),
  openNoteAsset: (url: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('studianda:open-note-asset', url),
  getSecretStatus: () => ipcRenderer.invoke('studianda:secret-status'),
  setSecret: (name: string, value: string) => ipcRenderer.invoke('studianda:secret-set', name, value),
  clearSecret: (name: string) => ipcRenderer.invoke('studianda:secret-clear', name),
  getDataLocation: (): Promise<string> => ipcRenderer.invoke('studianda:get-data-location'),
  openDataLocation: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('studianda:open-data-dir'),
  getDataSetup: (): Promise<{ configured: boolean; current: string }> =>
    ipcRenderer.invoke('studianda:get-data-setup'),
  setupDataLocation: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('studianda:setup-data-location'),
  openLegalNotice: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('studianda:open-legal-notice'),
  changeDataLocation: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('studianda:change-data-location'),
  /** 清空用户数据时顺带删除 userData 下的渲染/更新日志。 */
  clearUserDataLogs: (): Promise<{ ok: boolean; removed: string[] }> =>
    ipcRenderer.invoke('studianda:clear-user-logs'),
  /** 打开外部链接：主进程只放行 http/https/mailto，交给系统浏览器。 */
  openExternal: (url: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('studianda:open-external', url),
  /** 保存导出文件：主进程弹保存对话框并写盘；不把任意路径写权限暴露给 renderer。 */
  saveBlob: (data: Uint8Array, filename: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('studianda:save-blob', data, filename),
  openTranslationWindow: (input: {
    documentId: string;
    page: number;
  }): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('studianda:open-translation-window', input),
  /**
   * 应用内更新：只暴露"查状态 / 检查 / 下载 / 安装"四个动作。
   * 安装要重启应用，所以由主进程负责备份资料与停止 Core，渲染层不碰这些。
   */
  update: {
    getState: (): Promise<UpdateState | null> => ipcRenderer.invoke('studianda:update-state'),
    getAutoCheck: (): Promise<boolean | null> =>
      ipcRenderer.invoke('studianda:update-auto-check-get'),
    setAutoCheck: (enabled: boolean): Promise<boolean | null> =>
      ipcRenderer.invoke('studianda:update-auto-check-set', enabled),
    check: (manual: boolean): Promise<UpdateState | null> =>
      ipcRenderer.invoke('studianda:update-check', manual),
    download: (): Promise<UpdateState | null> => ipcRenderer.invoke('studianda:update-download'),
    install: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('studianda:update-install'),
    onStatus: (callback: (state: UpdateState) => void): (() => void) => {
      const listener = (_event: unknown, state: UpdateState) => callback(state);
      ipcRenderer.on('studianda:update-status', listener);
      return () => ipcRenderer.removeListener('studianda:update-status', listener);
    }
  },
  windowControls: {
    minimize: () => ipcRenderer.send('studianda:window-minimize'),
    toggleMaximize: () => ipcRenderer.send('studianda:window-toggle-maximize'),
    close: () => ipcRenderer.send('studianda:window-close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('studianda:window-is-maximized'),
    onMaximized: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on('studianda:window-maximized', listener);
      return () => ipcRenderer.removeListener('studianda:window-maximized', listener);
    }
  }
});
