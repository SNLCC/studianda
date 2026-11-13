/**
 * 资产 URL 解析器（宿主注入）。
 *
 * 笔记/批注的存储格式始终是 `studianda-asset://note-assets/<file>`，不随宿主变化：
 * - Electron：保持原样，由主进程的自定义协议读取；
 * - DSH/Web：宿主注入解析函数，把同一个 URL 映射到它自己的 HTTP 地址。
 *
 * 这样 Markdown 数据不需要迁移，渲染层也不需要知道当前是什么宿主。
 */
export type AssetUrlResolver = (url: string) => string;

/** 编辑态把原始资产地址挂在图片上的属性名；序列化时优先读它。 */
export const ASSET_SOURCE_ATTRIBUTE = 'data-studianda-asset-src';

const identity: AssetUrlResolver = (url) => url;

let current: AssetUrlResolver = identity;

/**
 * 设置当前宿主的解析器。传 null 恢复默认（原样返回）。
 * 必须在页面首次渲染前设置，避免首屏把 studianda-asset: 直接交给浏览器。
 */
export function setAssetUrlResolver(next: AssetUrlResolver | null): void {
  current = next ?? identity;
}

/** 只解析 studianda-asset: 地址；其它 URL（http/data 等）原样返回。 */
export function resolveAssetUrl(url: string): string {
  if (!url || !/^studianda-asset:/i.test(url)) return url;
  try {
    return current(url);
  } catch {
    return identity(url);
  }
}
