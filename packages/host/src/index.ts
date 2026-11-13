import type { RuntimeInfo, UpdateState } from '@studianda/shared';

/**
 * 宿主契约。
 *
 * 这是 Electron 桌面壳、DSH 插件、Web 宿主共同实现的唯一接口。业务与阅读界面
 * （`@studianda/app` / `@studianda/ui`）只依赖这里，不直接接触 Electron、DSH
 * 或节点能力。新增宿主时，新增一个实现包依赖本包即可。
 */

/** 无边框窗口控制：只有桌面壳实现；宿主没有原生窗口时可不实现。 */
export interface WindowControlsAdapter {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** 订阅最大化状态；返回取消订阅函数。 */
  onMaximized(callback: (maximized: boolean) => void): () => void;
}

/**
 * 应用内更新能力（可选壳能力）。
 *
 * 只有桌面壳实现；宿主（如 DSH 插件）没有更新概念时不实现，
 * 设置页的「关于与更新」分区会降级显示“当前环境不支持应用内更新”。
 * 状态更新走 `onStatus` 推送，`getState` 用于界面挂载时补一次当前状态。
 */
export interface UpdateAdapter {
  getState(): Promise<UpdateState | null>;
  /** 自动检查更新偏好（默认关；仅影响启动后的自动检查，手动检查仍可用）。 */
  getAutoCheck?(): Promise<boolean | null>;
  setAutoCheck?(enabled: boolean): Promise<boolean | null>;
  /** manual=true 表示用户主动点「检查更新」，失败时界面要给出提示。 */
  check(manual: boolean): Promise<UpdateState | null>;
  /** 用户确认后开始下载（不自动下载）。 */
  download(): Promise<UpdateState | null>;
  /** 安装已下载的更新：主进程会先备份资料、停止 Core，再静默安装。 */
  install(): Promise<{ ok: boolean; message?: string }>;
  onStatus(callback: (state: UpdateState) => void): () => void;
}

/** 首次启动资料位置检查结果。 */
export interface DataSetupState {
  configured: boolean;
  current: string;
}

/** 宿主类型。只用于诊断和少数必须分支的地方，不鼓励在业务组件里判断。 */
export type HostKind = 'electron' | 'web' | 'dsh' | 'unknown';

/**
 * 宿主能力矩阵。
 *
 * UI 的默认路径是“可选能力不存在就降级”，这个矩阵只是把当前宿主能做什么
 * 集中声明出来，避免各组件各自猜 `window.studianda` 或协议是否存在。
 */
export interface HostCapabilities {
  kind: HostKind;
  /** path：返回本机路径；file：返回浏览器 File（需上传）；none：不支持选择。 */
  filePicker: 'path' | 'file' | 'none';
  /** 笔记图片等资产地址的承载方式。 */
  assetUrls: 'custom-protocol' | 'http' | 'none';
  windowControls: boolean;
  updates: boolean;
  translationWindow: boolean;
  dataSetup: boolean;
  openNoteAsset: boolean;
  saveBlob: boolean;
}

/** 壳适配器：Electron 或 DSH 插件各自实现；UI 不直接依赖壳 API。 */
export interface RuntimeAdapter {
  getRuntime(): Promise<RuntimeInfo | null>;
  /** 宿主能力矩阵；未提供时按“只具备基础能力”保守处理。 */
  capabilities?: Partial<HostCapabilities>;
  /** 让用户选择本地 PDF；返回 null 表示取消。仅 path 型宿主使用。 */
  pickPdf(): Promise<string | null>;
  /** 文件型宿主（DSH/Web）选择 PDF；返回 File，避免把本机路径交给浏览器。 */
  pickPdfFile?(): Promise<File | null>;
  pickDirectory(): Promise<string | null>;
  /** 让用户选择 Markdown 库文件夹；返回 null 表示取消。 */
  pickMarkdownVault?(): Promise<string | null>;
  /** 用系统默认程序打开笔记附件（studianda-asset URL）。 */
  openNoteAsset?(url: string): Promise<{ ok: boolean; message: string }>;
  /** 把 studianda-asset: 地址解析成当前宿主可加载的 URL；默认原样返回。 */
  resolveAssetUrl?(url: string): string;
  /** 密钥状态；宿主不支持保存密钥时可不实现。 */
  getSecretStatus?(): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
  setSecret?(
    name: string,
    value: string
  ): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
  clearSecret?(
    name: string
  ): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
  getDataLocation?(): Promise<string>;
  openLegalNotice?(): Promise<{ ok: boolean }>;
  /** 打开安装包内完整版《使用须知与隐私说明》；未实现时调用方回退到仓库文档链接。 */
  openUsageNotice?(): Promise<{ ok: boolean; message?: string }>;
  /** 在本机文件管理器打开数据目录；失败时 message 里带路径供用户手动打开。 */
  openDataLocation?(): Promise<{ ok: boolean; message: string }>;
  changeDataLocation?(): Promise<{ ok: boolean; message: string }>;

  /* ---- 以下为可选壳能力：未实现时调用方必须降级，不能假定存在 ---- */

  /** 无边框窗口按钮；未实现时由宿主提供自己的窗口装饰。 */
  windowControls?: WindowControlsAdapter;
  /** 首次启动资料位置检查；未实现时视为已配置（宿主自己管理数据目录）。 */
  getDataSetup?(): Promise<DataSetupState>;
  /** 选择并初始化资料位置（桌面壳首次启动页）。 */
  setupDataLocation?(): Promise<{ ok: boolean; message: string }>;
  /** 打开外部链接（仅 http/https/mailto）；未实现时调用方可用浏览器打开。 */
  openExternal?(url: string): Promise<{ ok: boolean; message?: string }>;
  /** 清空用户数据时顺带删除 userData 下的渲染/更新日志；宿主未实现时跳过。 */
  clearUserDataLogs?(): Promise<{ ok: boolean; removed: string[] }>;
  /** 保存字节到用户选择的文件（导出）；未实现时调用方可用浏览器下载。 */
  saveBlob?(data: Uint8Array, filename: string): Promise<{ ok: boolean; message?: string }>;
  /** 应用内更新；未实现时设置页不显示更新操作（只显示当前版本）。 */
  update?: UpdateAdapter;
}
