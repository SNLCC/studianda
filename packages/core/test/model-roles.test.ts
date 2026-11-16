import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { resolveReadingChatConfig } from '../src/chat.js';
import { callChatModel } from '../src/reading-chat.js';
import {
  modelServicesImpact,
  resolveModelService,
  saveModelServices
} from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { MINIMAX_THINKING_RESERVE } from '../src/model-protocol.js';

/**
 * 分析模型 / 写作模型（Phase 1：思考与回答分模型）：
 *
 * - 分析模型承接 task=true 的调用（批次阅读/审计/回读/会话压缩）；
 * - 写作模型只负责最终回答，并且不再思考（DeepSeek 发 disabled；MiniMax 压到 low）；
 * - 任一用途未配置就回退会话模型，老配置的请求体与行为完全不变。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-roles-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.updateSettings({ 'model.services': '[]', 'model.routing': '{}' });
});

interface Seed {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

const CHAT: Seed = {
  id: 'c-chat',
  name: '会话平台',
  baseUrl: 'https://chat.example.com/v1',
  model: 'chat-model'
};
const ANALYSIS: Seed = {
  id: 'c-analysis',
  name: '分析平台',
  baseUrl: 'https://analysis.example.com/v1',
  model: 'analysis-model'
};
const WRITING: Seed = {
  id: 'c-writing',
  name: '写作平台',
  baseUrl: 'https://writing.example.com/v1',
  model: 'writing-model'
};

function connectionOf(seed: Seed) {
  return {
    id: seed.id,
    name: seed.name,
    platform: 'custom',
    baseUrl: seed.baseUrl,
    models: [
      {
        id: `${seed.id}-model`,
        name: seed.model,
        capabilities: ['chat'],
        source: 'user' as const,
        enabled: true
      }
    ]
  };
}

function seed(
  routing: Record<string, { connectionId: string; model: string }>,
  seeds: Seed[] = [CHAT, ANALYSIS, WRITING]
): void {
  saveModelServices(
    store,
    { connections: seeds.map(connectionOf), routing },
    secrets
  );
}

/** 记录请求的 URL 与请求体。 */
function records(): { url: string; body: Record<string, unknown> }[] {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '回答' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return calls;
}

describe('角色解析与路由', () => {
  it('未配置分析/写作模型时逐项回退会话模型（老配置不变）', () => {
    seed({ chat: { connectionId: CHAT.id, model: CHAT.model } });
    const config = resolveReadingChatConfig(store, secrets);
    expect(config).toMatchObject({ baseUrl: CHAT.baseUrl, model: CHAT.model });
    expect(config!.taskConfig).toBeUndefined();
    expect(config!.answerNoThinking).toBeUndefined();
  });

  it('只配置分析模型：任务型调用切到分析模型，最终回答仍用会话模型', async () => {
    seed({
      chat: { connectionId: CHAT.id, model: CHAT.model },
      analysis: { connectionId: ANALYSIS.id, model: ANALYSIS.model }
    });
    const config = resolveReadingChatConfig(store, secrets)!;
    expect(config.model).toBe(CHAT.model);
    expect(config.taskConfig?.model).toBe(ANALYSIS.model);
    expect(config.answerNoThinking).toBeUndefined();

    const calls = records();
    await callChatModel(config, '系统', '材料', 600, undefined, undefined, undefined, undefined, '批次', [], true);
    await callChatModel(config, '系统', '材料', 1200);
    expect(calls[0]!.url).toContain('analysis.example.com');
    expect(calls[0]!.body.model).toBe(ANALYSIS.model);
    expect(calls[1]!.url).toContain('chat.example.com');
    expect(calls[1]!.body.model).toBe(CHAT.model);
  });

  it('配置写作模型：最终回答用写作模型且不思考；任务型用分析模型', async () => {
    seed({
      chat: { connectionId: CHAT.id, model: CHAT.model },
      analysis: { connectionId: ANALYSIS.id, model: ANALYSIS.model },
      writing: { connectionId: WRITING.id, model: WRITING.model }
    });
    expect(resolveModelService(store, secrets, 'writing')?.model).toBe(WRITING.model);
    const config = resolveReadingChatConfig(store, secrets)!;
    expect(config.model).toBe(WRITING.model);
    expect(config.answerNoThinking).toBe(true);
    expect(config.taskConfig?.model).toBe(ANALYSIS.model);

    const calls = records();
    await callChatModel(config, '系统', '材料', 1200);
    expect(calls[0]!.url).toContain('writing.example.com');
    expect(calls[0]!.body.model).toBe(WRITING.model);
  });

  it('写作模型在 DeepSeek 官方地址上关闭思考：没有思维链预留，max_tokens 全给正文', async () => {
    const calls = records();
    await callChatModel(
      { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash', answerNoThinking: true },
      '系统',
      '材料',
      1200
    );
    expect(calls[0]!.body.thinking).toEqual({ type: 'disabled' });
    expect(calls[0]!.body.max_tokens).toBe(1200);
  });

  it('写作模型在 MiniMax 上压到 low 思考深度（不能关闭，但不再按默认 max）', async () => {
    const calls = records();
    await callChatModel(
      { baseUrl: 'https://api.minimax.cn/v1', apiKey: 'k', model: 'MiniMax-M3.1-Flash', answerNoThinking: true },
      '系统',
      '材料',
      1200
    );
    expect(calls[0]!.body.reasoning_effort).toBe('low');
    expect(calls[0]!.body.max_completion_tokens).toBe(1200 + MINIMAX_THINKING_RESERVE);
    // M3.1-Flash 不能关闭思考：绝不能发 disabled（会 400）。
    expect(calls[0]!.body).not.toHaveProperty('thinking');
  });

  it('写作模型是 MiniMax-M3 时真正关闭思考（该模型支持 disabled，思维链 0 token）', async () => {
    const calls = records();
    await callChatModel(
      { baseUrl: 'https://api.minimax.cn/v1', apiKey: 'k', model: 'MiniMax-M3', answerNoThinking: true },
      '系统',
      '材料',
      1200
    );
    expect(calls[0]!.body.thinking).toEqual({ type: 'disabled' });
  });
});

describe('删除平台时的用途解绑提示', () => {
  it('影响预览列出分析/写作模型；删除后如实提示回退会话模型', () => {
    seed({
      chat: { connectionId: CHAT.id, model: CHAT.model },
      analysis: { connectionId: ANALYSIS.id, model: ANALYSIS.model },
      writing: { connectionId: WRITING.id, model: WRITING.model }
    });
    expect(modelServicesImpact(store, WRITING.id).kinds).toContain('writing');
    expect(modelServicesImpact(store, ANALYSIS.id).kinds).toContain('analysis');

    // 删除写作平台（UI 会同时删掉 routing 里的 writing 键）。
    const saved = saveModelServices(
      store,
      {
        connections: [connectionOf(CHAT), connectionOf(ANALYSIS)],
        routing: {
          chat: { connectionId: CHAT.id, model: CHAT.model },
          analysis: { connectionId: ANALYSIS.id, model: ANALYSIS.model }
        }
      },
      secrets
    );
    const writing = saved.unbound.find((item) => item.kind === 'writing');
    expect(writing).toBeDefined();
    expect(writing!.result).toContain('会话模型');
    expect(resolveModelService(store, secrets, 'writing')).toBeNull();
  });
});
