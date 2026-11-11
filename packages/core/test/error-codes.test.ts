import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-error-codes-'));
const store = new Store(dataDir);
const server = buildServer({
  token: 'error-code-token',
  version: 'test',
  store,
  secrets: new SecretStore()
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': 'error-code-token' };
}

describe('HTTP error codes', () => {
  it('uses shared unauthorized code without a token', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/documents' });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: string }).error).toBe('unauthorized');
  });

  it('uses shared not_found code with a human-readable message', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/documents/does-not-exist',
      headers: headers()
    });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('keeps health check out of the error path', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
  });
});
