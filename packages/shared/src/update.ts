/**
 * 应用更新：桌面壳与界面层共用的状态契约。
 *
 * 更新能力只在桌面壳（Electron 主进程）里实现；界面层通过 RuntimeAdapter 的可选
 * `update` 能力访问，未实现时界面必须降级（不显示更新分区），不能假定存在。
 *
 * 说明：这里不包含任何"下载地址/渠道"逻辑。渠道由 electron-builder 的 publish
 * 配置在打包时写进 app-update.yml，主进程不读这里的东西。
 */

/** 更新流程所处的阶段。 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  /** 当前环境不支持应用内更新（开发模式、非桌面壳、缺少更新配置）。 */
  | 'unsupported';

/** 下载进度（字节与速度都是实际值，用于界面如实显示）。 */
export interface UpdateProgress {
  /** 0–100。 */
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/** 主进程单向推送给界面（`studianda:update-status`）和界面主动查询（invoke）共用同一结构。 */
export interface UpdateState {
  /** 当前运行的版本号（app.getVersion()）。 */
  currentVersion: string;
  phase: UpdatePhase;
  /** 有新版本/正在更新时的目标版本号。 */
  version?: string;
  /** 更新说明（GitHub Release 正文；可能是 Markdown 文本，界面按纯文本显示）。 */
  releaseNotes?: string;
  /** 发布时间（ISO 字符串，来自更新元数据）。 */
  releaseDate?: string;
  /** 新版本安装包大小（字节，来自 latest.yml；未知时缺省）。 */
  size?: number;
  progress?: UpdateProgress;
  /** 给用户看的中文说明：错误原因、已是最新、不支持更新的原因等。 */
  message?: string;
  /** 本次状态是否由用户手动"检查更新"触发（自动检查失败时不打扰用户）。 */
  manual?: boolean;
}

/** 发布页地址：更新失败或用户想手动下载时的兜底入口。 */
export const UPDATE_PAGE_URL = 'https://github.com/SNLCC/studianda/releases/latest';
