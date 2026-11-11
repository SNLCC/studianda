import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelServiceConnection } from '@studianda/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  officialModelMaxOutput,
  requestMaxTokens,
  requestMaxTokensFor,
  TASK_MAX_TOKENS
} from '../src/output-limit.js';
import {
  publicModelServices,
  readModelServices,
  saveModelServices
} from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-output-limit-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('请求输出上限（官方最大输出 → 任务上限兜底）', () => {
  it('官方没登记最大输出时保持原有任务上限，行为与改动前一致', () => {
    expect(officialModelMaxOutput('https://api.example.com/v1', 'unknown-model')).toBeUndefined();
    expect(requestMaxTokens(TASK_MAX_TOKENS.translation, undefined)).toBe(4096);
    expect(requestMaxTokens(TASK_MAX_TOKENS.visualReading, undefined)).toBe(2048);
    expect(
      requestMaxTokensFor(TASK_MAX_TOKENS.ocrVision, 'https://api.example.com/v1', 'unknown')
    ).toBe(8192);
    expect(
      requestMaxTokensFor(TASK_MAX_TOKENS.speechCorrection, 'https://api.example.com/v1', 'x')
    ).toBe(4096);
  });

  it('官方登记值大于任务上限时仍取任务上限（不无故放大请求）', () => {
    expect(
      officialModelMaxOutput('https://api.deepseek.com/v1', 'deepseek-v4-pro')
    ).toBe(393_216);
    expect(
      requestMaxTokensFor(TASK_MAX_TOKENS.translation, 'https://api.deepseek.com/v1', 'deepseek-v4-pro')
    ).toBe(4096);
  });

  it('官方登记值更小时以官方值为准，避免超过模型上限导致平台报错', () => {
    expect(requestMaxTokens(8192, 2048)).toBe(2048);
    expect(requestMaxTokens(4096, 3000)).toBe(3000);
  });

  it('官方值非法/越界时退回任务上限，不把坏值发出去', () => {
    for (const value of [0, -1, 1.5, 63, 8_000_001, Number.NaN]) {
      expect(requestMaxTokens(4096, value)).toBe(4096);
    }
  });

  it('任务上限本身非法时也总是返回正整数', () => {
    expect(requestMaxTokens(0)).toBe(4096);
    expect(requestMaxTokens(-1)).toBe(4096);
    expect(requestMaxTokens(1.5)).toBe(4096);
  });

  it('语音模型没有 token 容量概念，官方快照不提供最大输出', () => {
    expect(officialModelMaxOutput('https://api.minimax.io/v1', 'speech-2.8-hd')).toBeUndefined();
  });
});

describe('模型服务公开配置里的官方最大输出', () => {
  it('读取时按官方快照补上，保存时不落库', () => {
    const connections: ModelServiceConnection[] = [
      {
        id: 'ds',
        name: 'DeepSeek',
        platform: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: [
          {
            id: 'deepseek-v4-pro',
            name: 'deepseek-v4-pro',
            capabilities: ['chat'],
            source: 'preset',
            enabled: true
          },
          {
            id: 'my-custom',
            name: 'my-custom',
            capabilities: ['chat'],
            source: 'user',
            enabled: true
          }
        ]
      }
    ];
    saveModelServices(store, { connections, routing: {} });

    const publicConfig = publicModelServices(store, secrets);
    const models = publicConfig.connections[0]!.models;
    expect(models.find((item) => item.name === 'deepseek-v4-pro')).toMatchObject({
      max_output: 393_216,
      max_output_source: expect.stringContaining('官方文档')
    });
    expect(models.find((item) => item.name === 'my-custom')?.max_output).toBeUndefined();

    // 只读字段不落库：即使用界面回传带 max_output 的配置保存，存储里也不该留下它。
    saveModelServices(store, { connections: publicConfig.connections, routing: {} });
    const stored = readModelServices(store);
    expect(
      stored.connections[0]!.models.every(
        (model) => model.max_output === undefined && model.max_output_source === undefined
      )
    ).toBe(true);
    expect(
      publicModelServices(store, secrets).connections[0]!.models.find(
        (item) => item.name === 'deepseek-v4-pro'
      )?.max_output
    ).toBe(393_216);
  });
});
