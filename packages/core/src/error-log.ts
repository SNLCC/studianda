import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs';
import path from 'node:path';

// 日志文件名 application.log；轮转保留 1 个旧文件（application.log.1）。
const LOG_NAME = 'application.log';
const MAX_BYTES = 5 * 1024 * 1024;

export interface ErrorLogEntry {
  timestamp: string;
  context: string;
  message: string;
}

/**
 * 日志/诊断脱敏：日志会被诊断包原样导出，必须确保 URL 查询串、请求头、密钥不以明文出现。
 *
 * 覆盖：
 * - query/body 里的 token/api_key/key/secret/password；
 * - `x-studianda-token:` / `Authorization: Bearer …` 文本；
 * - OpenAI 风格 `sk-…` 密钥；
 * - JSON 形式的 `"token": "…"`。
 */
export function redactSensitive(text: string): string {
  return (
    text
      // ?token=... / &api_key=... / "token":"..." 等
      .replace(
        /([?&](?:token|api_key|key|secret|password)=)[^&\s"'<>]+/gi,
        '$1[redacted]'
      )
      .replace(/("(?:token|api_key|secret|password)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
      .replace(/(x-studianda-token\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
  );
}

function redact(text: string): string {
  return redactSensitive(text);
}

/**
 * 追加一条错误日志；写前检查大小，超过 5MB 轮转为 `application.log.1`，
 * 只保留 1 个旧文件。轮转任何一步失败都退回直接追加：
 * 日志本身出问题不能影响请求的错误返回，也不能把已有日志弄丢。
 */
export function appendErrorLog(
  dataDir: string,
  context: string,
  error: unknown
): void {
  const target = path.join(dataDir, LOG_NAME);
  try {
    if (existsSync(target) && statSync(target).size > MAX_BYTES) {
      const backup = `${target}.1`;
      try {
        if (existsSync(backup)) unlinkSync(backup);
        renameSync(target, backup);
      } catch {
        // 轮转失败（并发/占用）就继续写当前文件，绝不丢原日志。
      }
    }
  } catch {
    // stat 失败（文件刚好被删）不阻塞追加。
  }
  try {
    const message = redact(error instanceof Error ? error.message : String(error));
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      // 调用方可能直接把 request.url 作为 context；这里再脱敏一次，避免历史调用方漏改。
      context: redact(context),
      message
    } satisfies ErrorLogEntry);
    appendFileSync(target, `${line}\n`, 'utf8');
  } catch {
    // 日志写失败不能影响请求本身的错误返回。
  }
}

/** 当前日志文件路径（供诊断包等需要只读引用的地方）。 */
export function errorLogPath(dataDir: string): string {
  return path.join(dataDir, LOG_NAME);
}

export function readRecentErrors(dataDir: string, limit = 20): ErrorLogEntry[] {
  const target = path.join(dataDir, LOG_NAME);
  if (!existsSync(target)) return [];
  try {
    const lines = readFileSync(target, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, Math.min(limit, 100)))
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<ErrorLogEntry>;
          return {
            timestamp: String(parsed.timestamp ?? ''),
            context: redactSensitive(String(parsed.context ?? '')),
            message: redactSensitive(String(parsed.message ?? ''))
          };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is ErrorLogEntry => entry !== null)
      .reverse();
  } catch {
    return [];
  }
}
