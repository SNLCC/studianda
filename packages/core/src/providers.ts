import type { ProviderPreset } from '@studianda/shared';

/**
 * 只收录 OpenAI 兼容、地址稳定的服务；模型名是提示，不是能力承诺。
 * 缺省密钥要求仅用于界面提示，实际鉴权仍由服务端决定。
 */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI 兼容',
    baseUrl: '',
    models: [],
    requiresKey: false
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requiresKey: true
  },
  {
    id: 'mimo',
    name: 'MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: [],
    requiresKey: true
  },
  {
    id: 'minimax',
    name: 'MiniMax（API 按量计费）',
    baseUrl: 'https://api.minimax.cn/v1',
    // 模型清单不预置：保存平台后点「获取模型」，从官方 /models 拉取。
    models: [],
    requiresKey: true,
    description:
      'MiniMax 开放平台按量计费 API Key。保存平台后点「获取模型」，从官方 OpenAI 兼容 /v1 接口拉取可用模型。',
    docsUrl: 'https://platform.minimax.cn/docs/api-reference/api-overview',
    keyHint: '在「接口密钥」创建，使用 Bearer 鉴权'
  },
  {
    id: 'minimax-mplan',
    name: 'MiniMax（M Plan 订阅）',
    baseUrl: 'https://api.minimax.cn/v1',
    // 与按量计费同一套接口；模型同样由「获取模型」从官方拉取，不在本地写死。
    models: [],
    requiresKey: true,
    description:
      'M Plan 订阅 Key（通常以 sk-cp- 开头），与按量计费 API Key 不通用。保存后点「获取模型」从官方 /v1 拉取模型清单。',
    docsUrl: 'https://platform.minimax.cn/docs/m-plan/other-tools',
    keyHint: '在「订阅管理 → M Plan」查看订阅 Key（sk-cp-…）'
  },
  {
    id: 'local',
    name: '本地部署',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [],
    requiresKey: false
  }
];

export function listProviders(): ProviderPreset[] {
  return PROVIDERS.map((provider) => ({
    ...provider,
    models: [...provider.models]
  }));
}
