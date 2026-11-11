/**
 * 快捷键默认值（单一来源）：设置页与标题栏帮助弹层共用，避免两处列表漂移。
 *
 * key 是设置项（`shortcut.*`），fallback 是未配置时的默认键位。
 */
export interface ShortcutField {
  key: string;
  label: string;
  fallback: string;
}

export const SHORTCUT_FIELDS: ShortcutField[] = [
  { key: 'shortcut.prevPage', label: '上一页', fallback: 'PageUp' },
  { key: 'shortcut.nextPage', label: '下一页', fallback: 'PageDown' },
  { key: 'shortcut.zoomIn', label: '放大文献', fallback: 'Ctrl+=' },
  { key: 'shortcut.zoomOut', label: '缩小文献', fallback: 'Ctrl+-' },
  { key: 'shortcut.fitWidth', label: '适合宽度', fallback: 'Ctrl+0' },
  { key: 'shortcut.askSelection', label: '对选文提问（阅读区）', fallback: 'Ctrl+Enter' },
  { key: 'shortcut.ocrBox', label: '区域框选（提问对象）', fallback: 'Ctrl+Shift+O' },
  { key: 'shortcut.send', label: '发送问题（输入框）', fallback: 'Enter' },
  { key: 'shortcut.newline', label: '换行（输入框）', fallback: 'Shift+Enter' },
  { key: 'shortcut.stop', label: '停止回答 / 录音 / 朗读', fallback: 'Escape' },
  { key: 'shortcut.toggleSidebar', label: '显示或隐藏阅读伙伴面板', fallback: 'Ctrl+Shift+L' },
  { key: 'shortcut.readAnswer', label: '朗读最近回答', fallback: 'Ctrl+Shift+R' }
];
