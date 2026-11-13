import { useEffect } from 'react';
import { onHostKeyDown } from '@studianda/ui';

/**
 * 全局弹窗焦点陷阱（兜底）：所有 `aria-modal="true"` 的弹窗自动获得
 * - Tab / Shift+Tab 在弹窗内循环；
 * - 打开时聚焦首个可交互元素，关闭后把焦点还给打开前的元素；
 * - 焦点被鼠标/脚本移到弹窗外部时拉回。
 *
 * 设置页自己有一套更严格的处理（背景 inert + Esc），这里跳过 `.kr-settings`，避免双重管理。
 * Shadow DOM 宿主接入时，activeElement 在 shadow 内会返回 host，需要宿主侧另行处理。
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

function topModal(): HTMLElement | null {
  const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(
    (element) => !element.classList.contains('kr-settings') && isVisible(element)
  );
  return modals.length > 0 ? modals[modals.length - 1]! : null;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hasAttribute('disabled') && isVisible(element)
  );
}

export function useDialogFocusTrap(): void {
  useEffect(() => {
    let activeModal: HTMLElement | null = null;
    let previousFocus: HTMLElement | null = null;

    const restoreFocus = (target: HTMLElement | null): void => {
      if (target?.isConnected) target.focus();
    };

    const syncModal = (): void => {
      const modal = topModal();
      if (modal === activeModal) return;
      if (!modal) {
        activeModal = null;
        restoreFocus(previousFocus);
        previousFocus = null;
        return;
      }
      activeModal = modal;
      previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // 等 React 完成本次渲染再聚焦，避免聚焦到即将被替换的节点。
      requestAnimationFrame(() => {
        if (activeModal !== modal) return;
        const list = focusables(modal);
        (list[0] ?? modal).focus();
      });
    };

    const onFocusIn = (event: FocusEvent): void => {
      const modal = topModal();
      if (!modal) return;
      const target = event.target;
      if (target instanceof Node && modal.contains(target)) return;
      const list = focusables(modal);
      (list[0] ?? modal).focus();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const modal = topModal();
      if (!modal) return;
      const list = focusables(modal);
      if (list.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !(active instanceof Node) || !modal.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !(active instanceof Node) || !modal.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    const observer = new MutationObserver(() => syncModal());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'hidden']
    });
    syncModal();
    document.addEventListener('focusin', onFocusIn, true);
    const removeKeyDown = onHostKeyDown(onKeyDown, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn, true);
      removeKeyDown();
    };
  }, []);
}
