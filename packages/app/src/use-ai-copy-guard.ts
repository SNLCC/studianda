import { useEffect } from 'react';
import {
  AI_ANSWER_COPY_SUFFIX,
  AI_OCR_COPY_SUFFIX,
  AI_TRANSLATION_COPY_SUFFIX
} from '@studianda/shared';

/**
 * 全局复制守卫：用户用 Ctrl+C / 右键“复制”/系统菜单复制 AI 内容时，
 * 也强制在剪贴板文本末尾附带 AI 标识；同时保留选区的 HTML 格式。
 *
 * 专用「复制回答 / 复制译文 / 复制整理后文本」按钮仍走各自的 clipboard API；
 * 这里只处理浏览器/Electron 默认复制事件，避免两套逻辑重复追加。
 */

const AI_COPY_MARKER = '不得删除、篡改或隐匿本标识';

interface SelectionCopy {
  hosts: HTMLElement[];
  text: string;
  html: string;
}

function suffixFor(hosts: HTMLElement[]): string {
  const kinds = new Set(hosts.map((host) => host.dataset.aiCopy));
  if (kinds.size === 1 && kinds.has('translation')) return AI_TRANSLATION_COPY_SUFFIX;
  if (kinds.size === 1 && kinds.has('ocr')) return AI_OCR_COPY_SUFFIX;
  return AI_ANSWER_COPY_SUFFIX;
}

function labelHtml(suffix: string): string {
  const label = document.createElement('p');
  label.textContent = suffix.trim();
  label.setAttribute('style', 'margin:8px 0 0;color:#6b6457;font-size:0.85em;');
  return label.outerHTML;
}

function writeMarkedText(
  event: ClipboardEvent,
  text: string,
  suffix: string,
  html?: string
): void {
  if (!event.clipboardData || !text.trim()) return;
  event.preventDefault();
  const alreadyMarked = text.includes(AI_COPY_MARKER);
  event.clipboardData.setData('text/plain', alreadyMarked ? text : `${text}${suffix}`);
  if (html) {
    event.clipboardData.setData(
      'text/html',
      alreadyMarked ? html : `${html}${labelHtml(suffix)}`
    );
  }
}

function asField(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return target;
  }
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
    ? active
    : null;
}

function fieldHosts(field: HTMLInputElement | HTMLTextAreaElement): HTMLElement[] {
  const host = field.closest<HTMLElement>('[data-ai-copy]');
  return host ? [host] : [];
}

function selectionCopy(): SelectionCopy | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const hosts = Array.from(document.querySelectorAll<HTMLElement>('[data-ai-copy]')).filter(
    (host) => {
      try {
        return range.intersectsNode(host);
      } catch {
        return false;
      }
    }
  );
  if (hosts.length === 0) return null;

  const fragment = document.createElement('div');
  fragment.appendChild(range.cloneContents());
  return { hosts, text, html: fragment.innerHTML };
}

function onCopy(event: ClipboardEvent): void {
  const field = asField(event.target);
  if (field) {
    const hosts = fieldHosts(field);
    if (hosts.length > 0) {
      const selected = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
      writeMarkedText(event, selected, suffixFor(hosts));
      return;
    }
  }

  const selected = selectionCopy();
  if (!selected) return;
  writeMarkedText(event, selected.text, suffixFor(selected.hosts), selected.html);
}

/** 安装全局复制守卫；返回清理函数。 */
export function installAiCopyGuard(): () => void {
  document.addEventListener('copy', onCopy);
  return () => document.removeEventListener('copy', onCopy);
}

/** 在应用根组件调用一次；StrictMode 下由清理函数正确解绑。 */
export function useAiCopyGuard(): void {
  useEffect(() => installAiCopyGuard(), []);
}
