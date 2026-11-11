/**
 * 官方模型元数据快照。
 *
 * 平台自己的 `/models` 往往不返回上下文容量，也不列语音模型（例如 MiniMax 只列对话模型）。
 * 这里只登记**官方文档可核对**的条目，并如实标注来源日期；不做名称猜测。
 */

const SPEECH_SNAPSHOT = '2026-09-18';
const DEEPSEEK_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
const MIMO_ASR_SOURCE = 'https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition';
const MIMO_TTS_SOURCE = 'https://mimo.mi.com/docs/zh-CN/api/audio/tts';
const MINIMAX_ASR_SOURCE = 'https://platform.minimax.io/docs/api-reference/speech-to-text';
const MINIMAX_TTS_SOURCE = 'https://platform.minimax.io/docs/api-reference/speech-t2a-http';

export interface SpeechModelPreset {
  id: string;
  capabilities: Array<'asr' | 'tts'>;
  source: string;
  metadata_url: string;
}

function speechRow(
  id: string,
  capabilities: Array<'asr' | 'tts'>,
  metadataUrl: string
): SpeechModelPreset {
  return {
    id,
    capabilities,
    source: `官方文档（${SPEECH_SNAPSHOT}）`,
    metadata_url: metadataUrl
  };
}

const SPEECH_MODELS: Record<string, SpeechModelPreset[]> = {
  'api.xiaomimimo.com': [
    speechRow('mimo-v2.5-asr', ['asr'], MIMO_ASR_SOURCE),
    speechRow('mimo-v2.5-tts', ['tts'], MIMO_TTS_SOURCE),
    speechRow('mimo-v2.5-tts-voicedesign', ['tts'], MIMO_TTS_SOURCE),
    speechRow('mimo-v2.5-tts-voiceclone', ['tts'], MIMO_TTS_SOURCE)
  ],
  // 国内与国际站是两套域名、同一套接口与模型 id。
  'api.minimax.io': [
    speechRow('asr-1.0', ['asr'], MINIMAX_ASR_SOURCE),
    ...[
      'speech-2.8-hd',
      'speech-2.8-turbo',
      'speech-2.6-hd',
      'speech-2.6-turbo',
      'speech-02-hd',
      'speech-02-turbo',
      'speech-01-hd',
      'speech-01-turbo'
    ].map((model) => speechRow(model, ['tts'], MINIMAX_TTS_SOURCE))
  ]
};
SPEECH_MODELS['api.minimaxi.com'] = SPEECH_MODELS['api.minimax.io']!;

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 该服务地址上有官方文档可核对的语音模型（按主机名，不按平台 id）。 */
export function speechModels(baseUrl: string): SpeechModelPreset[] {
  return (SPEECH_MODELS[hostnameOf(baseUrl)] ?? []).map((row) => ({
    ...row,
    capabilities: [...row.capabilities]
  }));
}

export interface OfficialModelMetadata {
  contextWindow?: number;
  maxOutput?: number;
  capabilities?: string[];
  source: string;
  metadataUrl: string;
}

/**
 * 官方登记的模型元数据；没有登记返回 null（不猜）。
 *
 * DeepSeek 官方模型：上下文 1,000,000、最大输出 393,216；flash/vision 支持图像输入。
 */
export function officialModelMetadata(baseUrl: string, model: string): OfficialModelMetadata | null {
  const host = hostnameOf(baseUrl);
  if (host === 'api.deepseek.com') {
    const known = [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro'
    ];
    if (known.includes(model)) {
      return {
        contextWindow: 1_000_000,
        maxOutput: 393_216,
        capabilities: model === 'deepseek-v4-pro' ? ['chat'] : ['chat', 'image_input'],
        source: '官方文档（2026-09-16）',
        metadataUrl: DEEPSEEK_SOURCE
      };
    }
  }
  const preset = (SPEECH_MODELS[host] ?? []).find((row) => row.id === model);
  if (preset) {
    return {
      capabilities: [...preset.capabilities],
      source: preset.source,
      metadataUrl: preset.metadata_url
    };
  }
  return null;
}
