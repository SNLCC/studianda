import { describe, expect, it } from 'vitest';
import { DocumentRequestRegistry } from '../src/server/document-request-registry.js';

describe('DocumentRequestRegistry', () => {
  it('track 登记到多个文献，untrack 幂等且不重复计数', () => {
    const registry = new DocumentRequestRegistry();
    const controller = new AbortController();
    const untrack = registry.track(['doc-a', 'doc-b', undefined], controller);
    expect(registry.pending('doc-a')).toBe(1);
    expect(registry.pending('doc-b')).toBe(1);
    expect(registry.pending()).toBe(2);

    untrack();
    untrack();
    expect(registry.pending()).toBe(0);
  });

  it('abort 只中止指定文献并先摘表；重复 abort 幂等', () => {
    const registry = new DocumentRequestRegistry();
    const target = new AbortController();
    const other = new AbortController();
    registry.track(['doc-a'], target);
    registry.track(['doc-b'], other);

    registry.abort('doc-a');
    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(registry.pending('doc-a')).toBe(0);
    expect(registry.pending('doc-b')).toBe(1);

    expect(() => registry.abort('doc-a')).not.toThrow();
    expect(registry.pending('doc-b')).toBe(1);
    other.abort();
  });

  it('abortAll：跨文献登记只 abort 一次，pending 归零', () => {
    const registry = new DocumentRequestRegistry();
    const shared = new AbortController();
    let abortCount = 0;
    shared.signal.addEventListener('abort', () => (abortCount += 1));
    registry.track(['doc-a', 'doc-b'], shared);

    registry.abortAll();
    expect(shared.signal.aborted).toBe(true);
    expect(abortCount).toBe(1);
    expect(registry.pending()).toBe(0);
    expect(() => registry.abortAll()).not.toThrow();
  });

  it('abort 回调里新登记的请求不会被本次 abortAll 波及', () => {
    const registry = new DocumentRequestRegistry();
    const oldController = new AbortController();
    const newController = new AbortController();
    oldController.signal.addEventListener('abort', () => {
      registry.track(['doc-late'], newController);
    });
    registry.track(['doc-a'], oldController);

    registry.abortAll();
    expect(oldController.signal.aborted).toBe(true);
    expect(newController.signal.aborted).toBe(false);
    expect(registry.pending('doc-late')).toBe(1);
    newController.abort();
  });

  it('close()：abortAll 并标记关闭；之后 track 立即 abort 且不再登记', () => {
    const registry = new DocumentRequestRegistry();
    const inFlight = new AbortController();
    registry.track(['doc-a'], inFlight);

    registry.close();
    expect(inFlight.signal.aborted).toBe(true);
    expect(registry.pending()).toBe(0);

    const late = new AbortController();
    const untrack = registry.track(['doc-b'], late);
    expect(late.signal.aborted).toBe(true);
    expect(registry.pending('doc-b')).toBe(0);
    expect(() => untrack()).not.toThrow();
  });
});
