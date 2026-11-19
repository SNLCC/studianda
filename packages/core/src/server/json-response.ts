import type { FastifyReply } from 'fastify';
import {
  gzipJsonForResponse,
  recordStreamAbort,
  shouldStreamGzip,
  streamGzipJsonForResponse
} from '../json-gzip.js';

/**
 * 客户端 Accept-Encoding 含 gzip 时压缩 JSON 响应：
 * - 大 payload 走 worker 流式分块（chunked，不设 content-length）；
 * - 小 payload / worker 未开始输出即失败时回退完整 buffer（content-length）；
 * - 不需要 gzip 时直接返回普通 JSON。
 */
/** 流式响应写出响应头前缓存的 chunk 数；1 = 最低首字节延迟（失败不可回退），默认 2。 */
function streamPrebufferChunks(): number {
  const value = Number(process.env.STUDIANDA_STREAM_PREBUFFER_CHUNKS);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(4, Math.floor(value)));
}

async function sendJsonMaybeGzip(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: FastifyReply,
  data: unknown
): Promise<unknown> {
  const rawAccept = request.headers['accept-encoding'];
  const accept = Array.isArray(rawAccept) ? rawAccept.join(',') : String(rawAccept ?? '');
  if (!/\bgzip\b/i.test(accept)) return data;

  const sendBuffer = async (): Promise<unknown> => {
    const buffer = (await gzipJsonForResponse(data)).buffer;
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'Accept-Encoding');
    reply.header('cache-control', 'no-store');
    reply.header('content-length', String(buffer.length));
    return reply.send(buffer);
  };

  // `STUDIANDA_STREAM_RELIABILITY=buffer`：大 payload 也先完整压缩再发送。
  // 代价是内存/首字节，但可在 worker 失败时回退，不会出现“已写 chunk 后断连”。
  const forceBuffer = process.env.STUDIANDA_STREAM_RELIABILITY === 'buffer';
  if (forceBuffer || !shouldStreamGzip(data)) {
    try {
      return await sendBuffer();
    } catch {
      return data;
    }
  }

  // 大 payload：流式。先缓存前几个 chunk，直到确认有多个 chunk 或流结束再写响应头；
  // 这样 worker 在真正写出前失败仍可回退完整 buffer。
  const raw = reply.raw;
  let hijacked = false;
  let writtenBytes = 0;
  const pendingChunks: Buffer[] = [];
  const writeHeadOnce = (): void => {
    if (hijacked) return;
    reply.hijack();
    hijacked = true;
    raw.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      vary: 'Accept-Encoding',
      'cache-control': 'no-store'
      // 流式：不设 content-length（chunked）
    });
  };
  const flushPending = (): void => {
    if (pendingChunks.length === 0) return;
    writeHeadOnce();
    for (const chunk of pendingChunks) {
      writtenBytes += chunk.length;
      raw.write(chunk);
    }
    pendingChunks.length = 0;
  };
  try {
    await streamGzipJsonForResponse(data, (chunk) => {
      if (!hijacked && pendingChunks.length < streamPrebufferChunks()) {
        pendingChunks.push(chunk);
        return;
      }
      flushPending();
      writtenBytes += chunk.length;
      raw.write(chunk);
    });
    // 流成功结束：若还从未写出，则把缓存的首块们写出（单 chunk 的小 gzip 流）。
    flushPending();
    if (!hijacked) {
      // 理论上不会发生（stream 至少产生一个 chunk）；保守回退 buffer。
      return await sendBuffer();
    }
    raw.end();
    return reply;
  } catch {
    if (!hijacked) {
      // 尚未写出任何内容：丢弃缓存 chunks，回退完整 buffer。
      pendingChunks.length = 0;
      try {
        return await sendBuffer();
      } catch {
        return data;
      }
    }
    // 已经写出 chunk：无法回退；记录统计并中断连接（worker 由池内 failTask 清理）。
    recordStreamAbort(writtenBytes);
    pendingChunks.length = 0;
    try {
      raw.destroy();
    } catch {
      // 忽略
    }
    return reply;
  }
}

export { sendJsonMaybeGzip };
