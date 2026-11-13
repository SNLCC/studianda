import { describe, expect, it } from 'vitest';
import { listProviders } from '../src/providers.js';
import { officialModelMetadata, speechModels } from '../src/model-metadata.js';
import {
  chatOutputOptions,
  isMiniMaxHost,
  taskThinkingOptions,
  MINIMAX_THINKING_RESERVE
} from '../src/model-protocol.js';

const CN_BASE = 'https://api.minimax.cn/v1';

describe('MiniMax provider presets', () => {
  it('offers both pay-as-you-go API and M Plan subscription entries', () => {
    const providers = listProviders();
    const api = providers.find((provider) => provider.id === 'minimax');
    const plan = providers.find((provider) => provider.id === 'minimax-mplan');
    expect(api).toBeDefined();
    expect(plan).toBeDefined();
    expect(api!.baseUrl).toBe(CN_BASE);
    expect(plan!.baseUrl).toBe(CN_BASE);
    // 不在本地预置模型：用户保存平台后从官方 /models 拉取。
    expect(api!.models).toEqual([]);
    expect(plan!.models).toEqual([]);
    expect(api!.requiresKey).toBe(true);
    expect(plan!.requiresKey).toBe(true);
    // M Plan 与按量计费的 Key 不通用：界面必须给出可区分的说明。
    expect(plan!.keyHint).toContain('sk-cp-');
    expect(plan!.docsUrl).toContain('m-plan');
    expect(api!.docsUrl).toContain('api-reference');
    expect(api!.description).toContain('获取模型');
    expect(plan!.description).toContain('获取模型');
  });
});

describe('MiniMax official metadata', () => {
  it('registers 1M context and image input for M3.1 Flash / M3', () => {
    for (const model of ['MiniMax-M3.1-Flash', 'MiniMax-M3']) {
      const metadata = officialModelMetadata(CN_BASE, model);
      expect(metadata).not.toBeNull();
      expect(metadata!.contextWindow).toBe(1_000_000);
      expect(metadata!.capabilities).toContain('chat');
      expect(metadata!.capabilities).toContain('vision');
      expect(metadata!.metadataUrl).toContain('platform.minimax.cn');
    }
    expect(officialModelMetadata(CN_BASE, 'MiniMax-M3.1-Flash')!.maxOutput).toBe(131_072);
  });

  it('does not invent metadata for unknown models', () => {
    expect(officialModelMetadata(CN_BASE, 'MiniMax-made-up')).toBeNull();
  });

  it('keeps the official speech model snapshot on the CN domain', () => {
    const ids = speechModels(CN_BASE).map((model) => model.id);
    expect(ids).toContain('speech-2.8-hd');
    expect(ids).toContain('asr-1.0');
  });
});

describe('MiniMax request compatibility', () => {
  it('recognizes MiniMax hosts only', () => {
    expect(isMiniMaxHost(CN_BASE)).toBe(true);
    expect(isMiniMaxHost('https://api.minimaxi.com/v1')).toBe(true);
    expect(isMiniMaxHost('https://api.deepseek.com/v1')).toBe(false);
  });

  it('adds a thinking reserve and splits reasoning for MiniMax', () => {
    const options = chatOutputOptions(CN_BASE, 1200);
    expect(options.max_tokens).toBe(1200 + MINIMAX_THINKING_RESERVE);
    expect(options.reasoning_split).toBe(true);
  });

  it('keeps the platform output limit unchanged for other hosts', () => {
    expect(chatOutputOptions('https://api.deepseek.com/v1', 1200)).toEqual({
      max_tokens: 1200
    });
  });

  it('never sends thinking.disabled to MiniMax', () => {
    // M3.1 Flash 强制开启思考，disabled 会返回 400；任务型调用也不能发。
    expect(taskThinkingOptions(CN_BASE, true, true)).toEqual({});
    expect(taskThinkingOptions(CN_BASE, false, true)).toEqual({});
    expect(taskThinkingOptions('https://api.deepseek.com/v1', true, false)).toEqual({
      thinking: { type: 'disabled' }
    });
  });
});
