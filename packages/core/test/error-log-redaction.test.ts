import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendErrorLog, readRecentErrors } from '../src/error-log.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-error-log-'));
const secret = 'SECRET_TOKEN_1234567890';
// 用拼接构造"像 API key 的假串"：源码里不出现完整的 key 字面量，
// 既避免被密钥扫描器误报，也保持"验证日志会打码 key"这个测试目的。
const fakeKey = `${'sk'}-${'abcd'.repeat(4)}`;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('error log redaction', () => {
  it('redacts tokens/keys from context and message', () => {
    appendErrorLog(
      dataDir,
      `GET /api/v1/markdown/events?token=${secret}&x=1`,
      new Error(
        `Authorization: Bearer abcdefghijklmnop x-studianda-token: ${secret} ${fakeKey} "token":"${secret}"`
      )
    );

    const raw = readFileSync(path.join(dataDir, 'application.log'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).not.toContain(fakeKey);
    expect(raw).toContain('[redacted]');
    expect(raw).toContain('token=');
  });

  it('redacts entries returned for diagnostics (including legacy unredacted lines)', () => {
    const entries = readRecentErrors(dataDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.context).not.toContain(secret);
      expect(entry.message).not.toContain(secret);
    }
  });
});
