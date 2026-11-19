import { describe, expect, it } from 'vitest';
import { ChatTurnRegistry, chatTurnKeyOf } from '../src/server/chat-turn-registry.js';

describe('chatTurnKeyOf', () => {
  it('按文献 id 生成 doc: key；空 id 不参与互斥', () => {
    expect(chatTurnKeyOf('abc')).toBe('doc:abc');
    expect(chatTurnKeyOf('')).toBeNull();
    expect(chatTurnKeyOf(undefined)).toBeNull();
    expect(chatTurnKeyOf(null)).toBeNull();
  });
});

describe('ChatTurnRegistry', () => {
  it('同步 CAS：同 key 二次 begin 返回 false', () => {
    const registry = new ChatTurnRegistry();
    expect(registry.begin(chatTurnKeyOf('doc-a'))).toBe(true);
    expect(registry.begin(chatTurnKeyOf('doc-a'))).toBe(false);
    expect(registry.activeKeys()).toEqual(['doc:doc-a']);
    // 不同文献互不影响。
    expect(registry.begin(chatTurnKeyOf('doc-b'))).toBe(true);
    expect(registry.activeKeys()).toHaveLength(2);
  });

  it('end 幂等：未占用 / null / 重复 end 都不抛', () => {
    const registry = new ChatTurnRegistry();
    expect(() => registry.end('doc:never-begun')).not.toThrow();
    expect(() => registry.end(null)).not.toThrow();

    const key = chatTurnKeyOf('doc-a');
    expect(registry.begin(key)).toBe(true);
    registry.end(key);
    expect(() => registry.end(key)).not.toThrow();
    expect(registry.activeKeys()).toEqual([]);
  });

  it('异常路径：try/finally 里 handler 抛错后 end 仍执行，可重新 begin', () => {
    const registry = new ChatTurnRegistry();
    const key = chatTurnKeyOf('doc-a');
    // 模拟危险写 handler：begin 成功后内部抛错，finally 必须释放。
    const handler = (): void => {
      if (!registry.begin(key)) throw new Error('busy');
      try {
        throw new Error('handler boom');
      } finally {
        registry.end(key);
      }
    };
    expect(() => handler()).toThrow('handler boom');
    expect(registry.activeKeys()).toEqual([]);
    // 锁已释放：同一文献可以再次进入。
    expect(registry.begin(key)).toBe(true);
    registry.end(key);
  });

  it('close() 后 begin 一律 false，activeKeys() 为空', () => {
    const registry = new ChatTurnRegistry();
    expect(registry.begin(chatTurnKeyOf('doc-a'))).toBe(true);
    registry.close();
    expect(registry.activeKeys()).toEqual([]);
    expect(registry.begin(chatTurnKeyOf('doc-a'))).toBe(false);
    expect(registry.begin(chatTurnKeyOf('doc-b'))).toBe(false);
    // 关闭后连「不参与互斥」的 null key 也必须拒绝，避免关停期间再起一轮。
    expect(registry.begin(null)).toBe(false);
  });

  it('并发：两个交错 begin 只有一个成功', () => {
    const registry = new ChatTurnRegistry();
    const first = registry.begin(chatTurnKeyOf('doc-a'));
    const second = registry.begin(chatTurnKeyOf('doc-a'));
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(registry.activeKeys()).toEqual(['doc:doc-a']);
  });
});
