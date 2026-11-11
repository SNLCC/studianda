import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendErrorLog, readRecentErrors } from '../src/error-log.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-error-log-'));
const secret = 'SECRET_TOKEN_1234567890';

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('error log redaction', () => {
  it('redacts tokens/keys from context and message', () => {
    appendErrorLog(
      dataDir,
      `GET /api/v1/markdown/events?token=${secret}&x=1`,
      new Error(
        `Authorization: Bearer abcdefghijklmnop x-studianda-token: ${secret} sk-abcdefgh12345678 "token":"${secret}"`
      )
    );

    const raw = readFileSync(path.join(dataDir, 'application.log'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).not.toContain('sk-abcdefgh12345678');
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
