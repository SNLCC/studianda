import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  estimateJsonBytes,
  getJsonGzipStats,
  gzipJsonForResponse,
  resetJsonGzipStats,
  shouldStreamGzip,
  streamGzipJsonForResponse
} from '../src/json-gzip.js';

function decode(buffer: Buffer): unknown {
  return JSON.parse(gunzipSync(buffer).toString('utf8')) as unknown;
}

afterAll(() => {
  delete process.env.STUDIANDA_DISABLE_JSON_WORKER;
});

describe('json-gzip worker', () => {
  it('大 payload 由 worker 压缩，结果可解压且内容一致', async () => {
    resetJsonGzipStats();
    const big = { payload: 'x'.repeat(2 * 1024 * 1024), nested: { value: 42 } };
    const { buffer, via } = await gzipJsonForResponse(big);
    expect(via).toBe('worker');
    expect(decode(buffer)).toEqual(big);
    expect(getJsonGzipStats().worker).toBe(1);
    expect(buffer.length).toBeLessThan(JSON.stringify(big).length);
  });

  it('worker 失败（不可结构化克隆的数据）回退同步压缩', async () => {
    resetJsonGzipStats();
    const data = { fn: () => 1, value: 7 };
    const { buffer, via } = await gzipJsonForResponse(data);
    expect(via).toBe('fallback');
    expect(decode(buffer)).toEqual({ value: 7 });
    expect(getJsonGzipStats().fallback).toBe(1);
  });

  it('worker 池复用：连续任务只创建固定线程；并发任务全部成功', async () => {
    process.env.STUDIANDA_JSON_WORKER_POOL = '2';
    resetJsonGzipStats();
    try {
      const first = await gzipJsonForResponse({ n: 1 });
      const second = await gzipJsonForResponse({ n: 2 });
      expect(first.via).toBe('worker');
      expect(second.via).toBe('worker');
      const sequential = getJsonGzipStats();
      expect(sequential.workersSpawned).toBe(1);
      expect(sequential.poolReuses).toBeGreaterThanOrEqual(1);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) => gzipJsonForResponse({ index }))
      );
      expect(results.every((result) => result.via === 'worker')).toBe(true);
      for (let index = 0; index < results.length; index += 1) {
        expect(decode(results[index]!.buffer)).toEqual({ index });
      }
      const concurrent = getJsonGzipStats();
      // 池上限 2：并发 6 个任务也只创建 1-2 个线程，其它复用。
      expect(concurrent.workersSpawned).toBeLessThanOrEqual(2);
      expect(concurrent.worker).toBeGreaterThanOrEqual(8); // 2 顺序 + 6 并发
    } finally {
      delete process.env.STUDIANDA_JSON_WORKER_POOL;
      resetJsonGzipStats();
    }
  });

  it('大 payload 流式压缩：worker 分块回调，拼接后可解压', async () => {
    resetJsonGzipStats();
    const data = {
      notes: Array.from({ length: 3000 }, (_, index) => ({
        path: `notes/n-${index}.md`,
        sizeBytes: index,
        modified: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        content: `${index}`.repeat(50)
      }))
    };
    expect(shouldStreamGzip(data)).toBe(true);
    const chunks: Buffer[] = [];
    const result = await streamGzipJsonForResponse(data, (chunk) => chunks.push(chunk));
    expect(result.via).toBe('worker');
    expect(result.started).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    expect(decode(Buffer.concat(chunks))).toEqual(data);
  }, 20000);

  it('流式 worker 失败且尚未写 chunk 时回退完整 buffer（started=false）', async () => {
    resetJsonGzipStats();
    // 大数组触发流式，但内含函数使结构无法克隆到 worker。
    const data = {
      notes: Array.from({ length: 600 }, (_, index) => ({ index, fn: () => index }))
    };
    expect(shouldStreamGzip(data)).toBe(true);
    const chunks: Buffer[] = [];
    const result = await streamGzipJsonForResponse(data, (chunk) => chunks.push(chunk));
    expect(result.via).toBe('fallback');
    expect(result.started).toBe(false);
    expect(chunks).toHaveLength(0);
    expect(getJsonGzipStats().fallback).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('shouldStreamGzip：数组数量或估算字节超阈值都走流式', () => {
    expect(shouldStreamGzip({ notes: Array.from({ length: 10 }, () => ({})) })).toBe(false);
    expect(shouldStreamGzip({ notes: Array.from({ length: 600 }, () => ({})) })).toBe(true);
    // 少量条目但总字符串 > 2MB 估算阈值：也应走流式。
    const longString = { notes: [{ content: 'x'.repeat(3 * 1024 * 1024) }] };
    expect(estimateJsonBytes(longString)).toBeGreaterThan(2 * 1024 * 1024);
    expect(shouldStreamGzip(longString)).toBe(true);
    // 小对象不走流式。
    expect(shouldStreamGzip({ notes: [{ content: 'small' }] })).toBe(false);
  });

  it('chunk 传输统计：流式压缩产生多个 chunk 且字节数正确', async () => {
    resetJsonGzipStats();
    const data = {
      notes: Array.from({ length: 2000 }, (_, index) => ({
        path: `n/${index}.md`,
        blob: `${index}`.repeat(80)
      }))
    };
    const chunks: Buffer[] = [];
    await streamGzipJsonForResponse(data, (chunk) => chunks.push(chunk));
    const stats = getJsonGzipStats();
    expect(chunks.length).toBeGreaterThan(1);
    expect(stats.streamChunks).toBeGreaterThanOrEqual(chunks.length);
    expect(stats.streamBytes).toBeGreaterThan(0);
    expect(getJsonGzipStats().streamAborts).toBe(0);
    expect(decode(Buffer.concat(chunks))).toEqual(data);
  }, 20000);

  it('环境变量可强制同步压缩（小 payload 路径）', async () => {
    resetJsonGzipStats();
    process.env.STUDIANDA_DISABLE_JSON_WORKER = '1';
    try {
      const { buffer, via } = await gzipJsonForResponse({ small: true });
      expect(via).toBe('sync');
      expect(decode(buffer)).toEqual({ small: true });
      expect(getJsonGzipStats().sync).toBe(1);
    } finally {
      delete process.env.STUDIANDA_DISABLE_JSON_WORKER;
    }
  });
});
