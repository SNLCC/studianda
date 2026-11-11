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
