import { describe, expect, it } from 'vitest';
import { isAbortError, isProgrammingError } from '../src/chat.js';

/**
 * 阅读链路的 catch 语义：
 * - 故意抛出的 `new Error('可执行中文提示')` → 降级成 notice，继续走检索回答；
 * - 代码缺陷（TypeError/ReferenceError/…）→ 必须冒泡，不能伪装成"完整阅读未完成"；
 * - 取消 → 冒泡；
 * - fetch 网络失败（也是 TypeError）→ 仍按阅读失败降级。
 */
describe('isProgrammingError', () => {
  it('代码缺陷要冒泡', () => {
    expect(isProgrammingError(new TypeError('readingBatchBudget is not a function'))).toBe(true);
    expect(isProgrammingError(new ReferenceError('foo is not defined'))).toBe(true);
    expect(isProgrammingError(new RangeError('Invalid array length'))).toBe(true);
    expect(isProgrammingError(new SyntaxError('Unexpected token'))).toBe(true);
    expect(isProgrammingError('not an error object')).toBe(true);
    expect(isProgrammingError(undefined)).toBe(true);
  });

  it('阅读链路故意的可降级错误不冒泡', () => {
    expect(isProgrammingError(new Error('第 1/3 批证据仍无法核验：引文不在本批材料里'))).toBe(false);
    expect(isProgrammingError(new Error('本轮证据材料超出模型上下文容量'))).toBe(false);
    expect(isProgrammingError(new Error('模型服务返回 HTTP 429，请稍后重试'))).toBe(false);
  });

  it('fetch 网络失败是环境问题，仍按阅读失败降级', () => {
    expect(isProgrammingError(new TypeError('fetch failed'))).toBe(false);
    expect(isProgrammingError(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isAbortError', () => {
  it('只认 AbortError', () => {
    const abort = new Error('阅读已取消');
    abort.name = 'AbortError';
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(new Error('阅读已取消'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
