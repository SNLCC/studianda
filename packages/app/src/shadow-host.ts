import { setAppPortalRoot } from '@studianda/ui';

/**
 * Shadow DOM 宿主挂载器（方案 B：宿主 CSS 隔离）。
 *
 * 目标：DSH/网页宿主把整个 Studianda 挂进一个 shadow root，宿主页面样式进不来、
 * 应用样式出不去；桌面壳继续用普通挂载，外观零改动。
 *
 * 使用方只需：
 * 1. 准备一个确定高度的宿主容器（Shadow DOM 不会自动撑高）；
 * 2. 把样式注入进来：`stylesheetHref`（推荐，字体相对 URL 由 CSS 自身解析）或
 *    `stylesText`（Vite `?inline` 后可传入，构建时字体 URL 也会被改写）；
 * 3. 在 `mountElement` 上 ReactDOM.createRoot(...).render(<StudiandaApp adapter={...} />)；
 * 4. 卸载时调用 `cleanup()`。
 *
 * 注意：弹层（目录生成、设置 toast）通过 `setAppPortalRoot` 挂到 shadow root 内，
 * 不会跑到宿主 document.body。
 */

export interface ShadowHostOptions {
  /** 宿主容器；默认 document.body（容器必须有确定高度）。 */
  container?: HTMLElement;
  /** 构建产物 CSS 的 URL；与宿主同源/受 CSP 允许。 */
  stylesheetHref?: string;
  /** 已内联好的 CSS 文本（与 stylesheetHref 二选一；两个都给会依次注入）。 */
  stylesText?: string;
  /** 额外基础样式，可覆盖默认。 */
  baseStyles?: string;
}

export interface ShadowHostHandle {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  mountElement: HTMLElement;
  portalElement: HTMLElement;
  cleanup(): void;
}

const DEFAULT_BASE_STYLES = `
:host {
  display: block;
  height: 100%;
  color: var(--kr-ink);
  background: var(--kr-paper);
  font-family: var(--kr-font-ui);
}
:host * { box-sizing: border-box; }
:host .kr-desktop { width: 100% !important; height: 100% !important; }
:host .kr-desktop__body { min-height: 0; }
.kr-shadow-mount, .kr-shadow-mount > .kr-root { height: 100%; }
/* 弹层容器铺满 shadow root，但默认不拦截鼠标；具体弹层自己恢复 pointer-events。 */
.kr-shadow-portal {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 100002;
}
.kr-shadow-portal > * { pointer-events: auto; }
`;

export function createShadowHost(options: ShadowHostOptions = {}): ShadowHostHandle {
  const container = options.container ?? document.body;
  const host = document.createElement('div');
  host.className = 'kr-shadow-host';
  host.style.cssText = 'display:block;height:100%;min-height:240px;';
  const shadowRoot = host.attachShadow({ mode: 'open' });

  const baseStyle = document.createElement('style');
  baseStyle.textContent = options.baseStyles ?? DEFAULT_BASE_STYLES;
  shadowRoot.append(baseStyle);

  if (options.stylesheetHref) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = options.stylesheetHref;
    shadowRoot.append(link);
  }
  if (options.stylesText) {
    const style = document.createElement('style');
    style.textContent = options.stylesText;
    shadowRoot.append(style);
  }

  // 复用桌面壳的 DOM 结构（.kr-root > .kr-desktop > .kr-desktop__body），
  // 让现有样式与高度/滚动约定直接生效；区别只是不渲染窗口标题栏。
  const root = document.createElement('div');
  root.className = 'kr-root';
  const desktop = document.createElement('div');
  desktop.className = 'kr-desktop';
  const body = document.createElement('div');
  body.className = 'kr-desktop__body';
  const mountElement = document.createElement('div');
  mountElement.className = 'kr-shadow-mount';
  body.append(mountElement);
  desktop.append(body);
  root.append(desktop);
  shadowRoot.append(root);

  const portalElement = document.createElement('div');
  portalElement.className = 'kr-shadow-portal';
  shadowRoot.append(portalElement);
  setAppPortalRoot(portalElement);

  container.append(host);

  return {
    host,
    shadowRoot,
    mountElement,
    portalElement,
    cleanup() {
      setAppPortalRoot(null);
      host.remove();
    }
  };
}
