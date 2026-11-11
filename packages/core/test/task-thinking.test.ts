import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditGeneratedAnswer,
  callChatModel,
  type ReadingChatConfig
} from '../src/reading-chat.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseConfig(extra: Partial<ReadingChatConfig> = {}): ReadingChatConfig {
  return {
    baseUrl: 'https://model.test/v1',
    apiKey: 'k-1',
    model: 'chat-model',
    ...extra
  };
}

/** 替身模型：记录每次请求体，按 content 返回；返回体形如 chat/completions。 */
function mockModel(content = '回答'): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return bodies;
}

describe('callChatModel task thinking', () => {
  it('does not add thinking by default (old calls unchanged)', async () => {
    const bodies = mockModel();
    await callChatModel(baseConfig(), 'system', 'user');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('thinking');
  });

  it('does not add thinking when taskThinking is missing even for task calls', async () => {
    const bodies = mockModel();
    await callChatModel(baseConfig(), 'system', 'user', 1200, undefined, undefined, undefined, undefined, '', [], true);
    expect(bodies[0]).not.toHaveProperty('thinking');
  });

  it('does not add thinking for the final answer even when taskThinking is enabled', async () => {
    const bodies = mockModel();
    await callChatModel(baseConfig({ taskThinking: true }), 'system', 'user');
    expect(bodies[0]).not.toHaveProperty('thinking');
    // 显式 task=false 也不加。
    await callChatModel(
      baseConfig({ taskThinking: true }),
      'system',
      'user',
      1200,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      [],
      false
    );
    expect(bodies[1]).not.toHaveProperty('thinking');
  });

  it('adds {type:"disabled"} only when taskThinking=true and task=true', async () => {
    const bodies = mockModel();
    await callChatModel(
      baseConfig({ taskThinking: true }),
      'system',
      'user',
      1200,
      undefined,
      undefined,
      undefined,
      undefined,
      '核对论断与原文',
      [],
      true
    );
    expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' } });
    // 其它字段保持原样。
    expect(bodies[0]).toMatchObject({ model: 'chat-model', temperature: 0.2 });
  });

  it('keeps taskThinking=false from ever disabling thinking', async () => {
    const bodies = mockModel();
    await callChatModel(
      baseConfig({ taskThinking: false }),
      'system',
      'user',
      1200,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      [],
      true
    );
    expect(bodies[0]).not.toHaveProperty('thinking');
  });
});

describe('audit task flag', () => {
  it('marks audit calls as task calls so thinking is disabled', async () => {
    const bodies = mockModel('{"claims": []}');
    await auditGeneratedAnswer(
      baseConfig({ taskThinking: true }),
      '1. 这是一个待核对的论断 [1]。',
      { evidenceIndex: [], originals: [] }
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toMatchObject({ thinking: { type: 'disabled' } });
    }
  });

  it('leaves audit request bodies untouched when taskThinking is not configured', async () => {
    const bodies = mockModel('{"claims": []}');
    await auditGeneratedAnswer(baseConfig(), '1. 待核对论断 [1]。', {
      evidenceIndex: [],
      originals: []
    });
    for (const body of bodies) {
      expect(body).not.toHaveProperty('thinking');
    }
  });
});
