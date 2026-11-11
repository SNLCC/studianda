/**
 * 应用内统一的外部链接（使用须知完整版）与打开方式。
 *
 * 只走壳已有的 `RuntimeAdapter.openExternal`（桌面端由主进程校验 http/https/mailto），
 * 不为这些入口新增 IPC；宿主未提供该能力或打开失败时退回浏览器新窗口。
 */
import type { RuntimeAdapter } from './runtime.js';

/** 仓库里的完整版《使用须知与隐私说明》（应用内只展示精简版，完整版随仓库更新）。 */
export const USAGE_NOTICE_DOC_URL =
  'https://github.com/SNLCC/studianda/blob/main/docs/USAGE-NOTICE.md';

export type ExternalLinkAdapter = Pick<RuntimeAdapter, 'openExternal'>;

export interface OpenExternalResult {
  ok: boolean;
  message?: string;
}

/** 只允许 http/https/mailto，避免把任意协议交给系统处理。 */
export function isSafeExternalUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

/**
 * 用系统默认浏览器打开链接：优先壳的 openExternal；未实现或打开失败时退回浏览器新窗口。
 *
 * 不抛错：返回失败原因交给界面提示，避免一个打不开的链接打断整段设置操作。
 */
export async function openExternalLink(
  adapter: ExternalLinkAdapter | undefined,
  url: string
): Promise<OpenExternalResult> {
  const target = url.trim();
  if (!isSafeExternalUrl(target)) {
    return { ok: false, message: '只能打开 http/https/mailto 链接。' };
  }
  if (adapter?.openExternal) {
    try {
      const result = await adapter.openExternal(target);
      if (result.ok) return { ok: true };
    } catch {
      // 壳打开失败时继续尝试浏览器兜底。
    }
  }
  try {
    const opened = globalThis.open?.(target, '_blank', 'noopener,noreferrer');
    if (opened) return { ok: true };
    return { ok: false, message: '无法打开系统浏览器，请复制链接在浏览器中打开。' };
  } catch {
    return { ok: false, message: '无法打开系统浏览器，请复制链接在浏览器中打开。' };
  }
}
