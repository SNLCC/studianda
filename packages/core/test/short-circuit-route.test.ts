import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@studianda/shared';
import { shortCircuitRoute } from '../src/chat.js';
import type { Store } from '../src/store.js';
import type { SecretStore } from '../src/secrets.js';

/**
 * 小文本短路：只在"整篇读得完 + 联网本来就不可用 + 问题指向这篇文献"时才跳过路由器。
 * 这组测试钉的是**不该短路**的那一侧——省一次往返不值得替用户猜错意图。
 */
interface FakeOptions {
  pages?: number;
  charsPerPage?: number;
  settings?: Record<string, string>;
}

function fakeStore(options: FakeOptions = {}): Store {
  const pages = options.pages ?? 2;
  const charsPerPage = options.charsPerPage ?? 400;
  const text = '灾异 记录 地方 记忆 '.repeat(Math.ceil(charsPerPage / 10)).slice(0, charsPerPage);
  return {
    getDocument: () => ({ id: 'doc-1', name: 'demo', pages }),
    getPageText: (_id: string, page: number) =>
      page >= 1 && page <= pages ? `${text}${page}` : '',
    getSettings: () => options.settings ?? {},
    // 关键词兜底：没有 chunk 就当没命中（不影响"指向文献"的那条信号）。
    listChunks: () => [],
    getPageEdit: () => null
  } as unknown as Store;
}

const secrets = { get: () => undefined } as unknown as SecretStore;
const baseInput: ChatRequest = {
  question: '本文的结论是什么？',
  documentId: 'doc-1',
  page: 1,
  // 默认关门：联网不可用，短路才有意义。
  source_policy: 'document_only'
};

function run(input: ChatRequest = baseInput, store = fakeStore()): ReturnType<typeof shortCircuitRoute> {
  return shortCircuitRoute(store, secrets, input, input.question ?? '', input.selection ?? '');
}

describe('小文本短路 router', () => {
  it('短文献 + 指向本文的问题：不问路由，直接整篇读', () => {
    const route = run();
    expect(route).not.toBeNull();
    expect(route?.document).toBe(true);
    expect(route?.search).toBe(false);
    expect(route?.modelPlan).toBe(false);
    expect(route?.reason).toContain('跳过意图判断');
  });

  it('问题与本文献无关（无指向词、术语不重合）：仍问路由', () => {
    expect(run({ ...baseInput, question: '你好，今天天气怎么样' })).toBeNull();
  });

  it('允许联网时不短路（那会跳过一次真实的能力判断）', () => {
    // permission=auto：联网可用 → 不短路。
    expect(
      run(
        { ...baseInput, source_policy: 'auto' },
        fakeStore({ settings: { 'search.permission': 'auto' } })
      )
    ).toBeNull();
    // 默认 review 也要能发起"是否联网"的询问 → 不短路。
    expect(run({ ...baseInput, source_policy: 'auto' }, fakeStore())).toBeNull();
    // 搜索权限关闭时，本轮无论如何都不会联网 → 仍然可以短路。
    expect(
      run(
        { ...baseInput, source_policy: 'auto' },
        fakeStore({ settings: { 'search.permission': 'off' } })
      )
    ).not.toBeNull();
  });

  it('跨文献范围、续读任务不短路', () => {
    expect(run({ ...baseInput, reading_scope: 'corpus' })).toBeNull();
    expect(run({ ...baseInput, scope_documents: ['doc-2'] })).toBeNull();
    expect(run({ ...baseInput, taskId: 'task-1' })).toBeNull();
  });

  it('文献太大（页数超上限或整篇装不下）不短路', () => {
    expect(run(baseInput, fakeStore({ pages: 60 }))).toBeNull();
    // 2 页但每页 30 万字：整篇装不进一次装配预算，读它要分批，值得先判断。
    expect(run(baseInput, fakeStore({ pages: 2, charsPerPage: 300_000 }))).toBeNull();
  });

  it('选文解释即使没有指向词也短路', () => {
    const route = run({ ...baseInput, question: '这句话什么意思', selection: '大水损禾稼' });
    expect(route).not.toBeNull();
    expect(route?.document).toBe(true);
  });

  it('显式页码问题由本机规则定范围，不需要路由', () => {
    const route = run({ ...baseInput, question: '第 2 页讲了什么' });
    expect(route).not.toBeNull();
  });
});
