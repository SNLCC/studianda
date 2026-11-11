/**
 * Portal 根节点：桌面/普通宿主默认挂到 `document.body`；Shadow DOM 宿主必须把弹层挂到
 * shadow root 内的容器，否则弹层会跑到 shadow 外部、拿不到作用域样式。
 *
 * 宿主在挂载时调用 `setAppPortalRoot()`，卸载时传 null 还原。组件每次渲染时读取，
 * 因此支持同一页面多个宿主实例（后挂载者生效）。
 */
let currentRoot: HTMLElement | null = null;

export function setAppPortalRoot(root: HTMLElement | null): void {
  currentRoot = root;
}

export function getAppPortalRoot(): HTMLElement {
  if (currentRoot?.isConnected) return currentRoot;
  return document.body;
}
