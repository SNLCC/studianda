import { describe, expect, it } from 'vitest';
import { listProviders } from '../src/providers.js';

describe('provider catalog', () => {
  it('returns stable, unique OpenAI-compatible presets', () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);
    const ids = providers.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of providers) {
      expect(provider.name.length).toBeGreaterThan(0);
      // OpenAI 兼容是“自定义地址”入口，故意留空；其余平台必须有固定地址。
      if (provider.id !== 'openai') {
        expect(provider.baseUrl).toMatch(/^https?:\/\//);
        expect(provider.baseUrl.endsWith('/')).toBe(false);
      }
      expect(typeof provider.requiresKey).toBe('boolean');
    }
  });

  it('DeepSeek 预设使用官方现役模型名', () => {
    // 官方 Chat Completions 的 model 枚举只认这两个；写成已下线的
    // deepseek-chat / deepseek-reasoner 会让新用户选中后直接 404。
    const deepseek = listProviders().find((provider) => provider.id === 'deepseek');
    expect(deepseek?.models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('returns a copy so callers cannot mutate the catalog', () => {
    const first = listProviders();
    first[0]!.models.push('mutated');
    first[0]!.name = 'mutated';
    const second = listProviders();
    expect(second[0]!.models).not.toContain('mutated');
    expect(second[0]!.name).not.toBe('mutated');
  });
});
