import { readFileSync } from 'node:fs';
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

  async request<T>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
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
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Core ${response.status}: ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  /** 读取应用写入的共享范围；Core 未运行或读取失败时退回 none。 */
  async getScope(): Promise<AgentScope> {
    try {
      const row = await this.request<{
        kind?: string;
        documentIds?: unknown;
        caps?: unknown;
      }>('GET', '/agent/scope');
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
