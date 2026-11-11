/**
 * 勘读品牌标记。
 *
 * 与应用图标同一张「开卷 + S 形朱红书签」图（由 scripts/generate-icon.py 生成，
 * 以 256 px data URI 内嵌），因此界面内标记和运行期窗口图标完全一致。
 * 未启动时 exe/快捷方式图标则是「叠书」版。
 */
import { BRAND_MARK_DATA_URI } from './brand-mark-data.js';

export function BrandMark({
  size = 30,
  className
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={BRAND_MARK_DATA_URI}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      style={{ display: 'block' }}
    />
  );
}
