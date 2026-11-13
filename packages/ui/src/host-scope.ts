/**
 * 宿主作用域。
 *
 * 应用在 Electron 里独占整窗，`window`/`document` 上的键盘监听没有歧义；
 * 嵌进 DSH 面板后，同一个 `window` 还承载 DSH 自己的输入框，全局 keydown
 * 会把阅读快捷键和 Esc 语义带到面板外。这里把“当前应用挂载的根节点”集中声明，
 * 未设置时保持 Electron 的原有行为。
 */
let hostRoot: HTMLElement | null = null;

/**
 * 设置应用挂载根。传 null 恢复“整窗”语义。
 * Shadow DOM 宿主应传 shadow host 元素本身：事件重定向后 target 是它，
 * composedPath 里仍能看到内部节点。
 */
export function setHostRoot(root: HTMLElement | null): void {
  hostRoot = root;
}

export function getHostRoot(): HTMLElement | null {
  return hostRoot;
}

/** 事件是否发生在应用挂载根内；未设置根时一律视为在范围内（Electron 原行为）。 */
export function isEventInHostScope(event: Event): boolean {
  if (!hostRoot) return true;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node === hostRoot) return true;
    if (node instanceof Node && hostRoot.contains(node)) return true;
  }
  const target = event.target;
  return target instanceof Node && (target === hostRoot || hostRoot.contains(target));
}

/**
 * 绑定只在宿主范围内生效的 keydown。用法与 `addEventListener` 一致，
 * 返回取消函数；`options` 支持 capture/passive/once。
 */
export function onHostKeyDown(
  listener: (event: KeyboardEvent) => void,
  options?: boolean | AddEventListenerOptions
): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (!isEventInHostScope(event)) return;
    listener(event);
  };
  window.addEventListener('keydown', handler, options);
  return () => window.removeEventListener('keydown', handler, options);
}
