export type {
  DataSetupState,
  HostCapabilities,
  HostKind,
  RuntimeAdapter,
  UpdateAdapter,
  WindowControlsAdapter
} from '@studianda/host';

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
