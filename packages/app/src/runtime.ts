import type { RuntimeInfo, UpdateState } from '@studianda/shared';

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
 * 只有桌面壳实现；宿主（如将来的 DSH 插件）没有更新概念时不实现，
 * 设置页的「关于与更新」分区会降级显示"当前环境不支持应用内更新"。
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

/** 壳适配器：Electron 或将来的 DSH 插件各自实现；UI 不直接依赖壳 API。 */
export interface RuntimeAdapter {
  getRuntime(): Promise<RuntimeInfo | null>;
  /** 让用户选择本地 PDF；返回 null 表示取消。DSH 插件以后用自己的文件选择器实现。 */
  pickPdf(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  /** 让用户选择 Markdown 库文件夹；返回 null 表示取消。 */
  pickMarkdownVault?(): Promise<string | null>;
  /** 用系统默认程序打开笔记附件（studianda-asset URL）。 */
  openNoteAsset?(url: string): Promise<{ ok: boolean; message: string }>;
  getSecretStatus(): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
  setSecret(
    name: string,
    value: string
  ): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
  clearSecret(
    name: string
  ): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
  getDataLocation?(): Promise<string>;
  openLegalNotice?(): Promise<{ ok: boolean }>;
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

/* ------------------------------------------------------------------------- *
 * 语音输入：录音约束与浏览器能力探测（纯函数，界面与设置页共用）
 * ------------------------------------------------------------------------- */

/** 误触忽略阈值：按住不足 300ms 不送到识别服务。 */
export const SPEECH_MIN_RECORDING_MS = 300;
/** 单次录音上限：到 60 秒自动停止。 */
export const SPEECH_MAX_RECORDING_MS = 60_000;

/** 当前运行环境是否支持"浏览器录音"；不支持时给出可展示的中文原因。 */
export function mediaRecordingSupport(): { supported: boolean; message: string } {
  if (typeof navigator === 'undefined') {
    return { supported: false, message: '当前环境没有浏览器录音接口' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      supported: false,
      message:
        '当前环境没有可用的麦克风接口（navigator.mediaDevices 不可用）：可能不是安全上下文，或该环境未提供录音权限'
    };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, message: '当前环境不支持 MediaRecorder，无法录制音频' };
  }
  return { supported: true, message: '当前环境支持录音' };
}

/** 优先 webm/opus，其次 webm，再退回浏览器默认；返回空串表示交给浏览器决定。 */
export function preferredRecordingMimeType(): string {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return '';
  }
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/** 录音太短（误触）时忽略，不发送给转写。 */
export function recordingTooShort(durationMs: number): boolean {
  return !Number.isFinite(durationMs) || durationMs < SPEECH_MIN_RECORDING_MS;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

/**
 * 把浏览器录音（通常是 webm/opus）转成 16kHz 单声道 16bit PCM WAV。
 *
 * 系统语音识别（Windows）只接受 WAV，而 MediaRecorder 一般只能录 webm/ogg；
 * 这里用 Web Audio 解码后重采样并写 WAV 头，整个转换在渲染进程完成，不上传原始录音之外的任何东西。
 */
export async function blobToWav(input: Blob): Promise<Blob> {
  const scope = window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextCtor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('当前环境不支持音频解码，无法转换成 WAV');
  const targetRate = 16000;
  const context = new AudioContextCtor();
  try {
    const buffer = await context.decodeAudioData(await input.arrayBuffer());
    const channels = Math.max(1, buffer.numberOfChannels);
    const channelData: Float32Array[] = [];
    for (let index = 0; index < channels; index += 1) {
      channelData.push(buffer.getChannelData(index));
    }
    const frames = Math.max(1, Math.ceil(buffer.duration * targetRate));
    const samples = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const position = (frame / targetRate) * buffer.sampleRate;
      const left = Math.min(buffer.length - 1, Math.floor(position));
      const right = Math.min(buffer.length - 1, left + 1);
      const fraction = position - left;
      let value = 0;
      for (const data of channelData) {
        value += data[left]! * (1 - fraction) + data[right]! * fraction;
      }
      samples[frame] = value / channels;
    }
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    writeAscii(bytes, 0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    writeAscii(bytes, 8, 'WAVE');
    writeAscii(bytes, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(bytes, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
    return new Blob([bytes], { type: 'audio/wav' });
  } finally {
    void context.close?.();
  }
}
