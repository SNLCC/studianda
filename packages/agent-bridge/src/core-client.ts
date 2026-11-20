import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentScope, CoreApi } from '@studianda/agent-core';

/** 只做 MCP ↔ Core HTTP 的协议翻译；不复制业务、不直接开数据库。 */

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export class CoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreUnavailableError';
  }
}

/** Core HTTP 非 2xx：保留状态码，bridge 可据此映射 MCP 错误码。 */
export class CoreHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'CoreHttpError';
  }
}

export function resolveDataDir(argv: readonly string[] = process.argv, env = process.env): string {
  const index = argv.indexOf('--data-dir');
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) throw new Error('--data-dir 缺少参数');
    return path.resolve(value);
  }
  const fromEnv = env.STUDIANDA_DATA_DIR?.trim();
  return path.resolve(fromEnv || path.join(homedir(), '.studianda'));
}

export function readRuntime(dataDir: string): RuntimeInfo | null {
  try {
    const raw = readFileSync(path.join(dataDir, 'runtime.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeInfo>;
    if (!parsed.port || !parsed.token) return null;
    return parsed as RuntimeInfo;
  } catch {
    return null;
  }
}

/** Core HTTP 适配器：agent-core 只依赖 `request` 这一层，宿主模式可换进程内实现。 */
export class CoreHttpApi implements CoreApi {
  constructor(private readonly dataDir: string) {}

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    pathname: string,
    body?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    const runtime = readRuntime(this.dataDir);
    if (!runtime) {
      throw new CoreUnavailableError(
        `未找到 ${path.join(this.dataDir, 'runtime.json')}：请先打开勘读（本地 Core 未运行）。`
      );
    }
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/v1${pathname}`, {
      method,
      headers: {
        'x-studianda-token': runtime.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 60_000)
    }).catch((cause: unknown) => {
      // runtime.json 可能是上次进程留下的陈旧文件：连接失败统一归为「Core 未运行」，
      // 让 MCP 客户端看到可执行的 core_unavailable，而不是笼统的 fetch failed。
      throw new CoreUnavailableError(
        `无法连接本地 Core（${pathname}）：请先打开勘读。${cause instanceof Error ? ` ${cause.message}` : ''}`
      );
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CoreHttpError(
        response.status,
        `Core ${response.status}: ${text.slice(0, 300)}`
      );
    }
    // 204（软删除等）没有 JSON 体，不能调用 response.json()。
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * 转写本机音频文件：只接受 Core 所在机器可读的本地路径（MCP 没有二进制入参），
   * 大小上限 200MB，避免把任意大文件读进内存。
   */
  async uploadAudio<T>(
    filePath: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    const runtime = readRuntime(this.dataDir);
    if (!runtime) {
      throw new CoreUnavailableError(
        `未找到 ${path.join(this.dataDir, 'runtime.json')}：请先打开勘读（本地 Core 未运行）。`
      );
    }
    const info = statSync(filePath);
    if (!info.isFile()) throw new Error('audio_path 不是文件');
    if (info.size > 200 * 1024 * 1024) throw new Error('音频文件超过 200MB 上限');
    const bytes = readFileSync(filePath);
    const filename = path.basename(filePath);
    const extension = path.extname(filename).toLowerCase();
    const mimeType =
      extension === '.wav'
        ? 'audio/wav'
        : extension === '.mp3'
          ? 'audio/mpeg'
          : extension === '.m4a'
            ? 'audio/mp4'
            : extension === '.ogg'
              ? 'audio/ogg'
              : extension === '.webm'
                ? 'audio/webm'
                : 'application/octet-stream';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/api/v1/speech/transcribe`,
      {
        method: 'POST',
        headers: { 'x-studianda-token': runtime.token },
        body: form,
        signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 10 * 60 * 1000)
      }
    ).catch((cause: unknown) => {
      throw new CoreUnavailableError(
        `无法连接本地 Core（/speech/transcribe）：请先打开勘读。${cause instanceof Error ? ` ${cause.message}` : ''}`
      );
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CoreHttpError(
        response.status,
        `Core ${response.status}: ${text.slice(0, 300)}`
      );
    }
    return (await response.json()) as T;
  }

  /** 读取指定 MCP client 的共享范围；该 client 没有 grant 时回退默认 grant。 */
  async getScope(agentName = ''): Promise<AgentScope> {    try {
      const suffix = agentName ? `?agent=${encodeURIComponent(agentName)}` : '';
      const row = await this.request<{
        kind?: string;
        documentIds?: unknown;
        caps?: unknown;
      }>('GET', `/agent/scope${suffix}`);
      const caps = Array.isArray(row.caps)
        ? row.caps.filter((cap): cap is string => typeof cap === 'string')
        : [];
      if (row.kind === 'library') return { kind: 'library', caps };
      if (row.kind === 'documents') {
        const ids = Array.isArray(row.documentIds)
          ? row.documentIds.filter((id): id is string => typeof id === 'string')
          : [];
        return ids.length > 0 ? { kind: 'documents', documentIds: ids, caps } : { kind: 'none' };
      }
      return { kind: 'none' };
    } catch {
      return { kind: 'none' };
    }
  }
}
