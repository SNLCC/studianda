import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testModelConnection } from '../src/model-test.js';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-test-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('model connection test', () => {
  it('reports missing configuration without making a request', async () => {
    const result = await testModelConnection(store, secrets);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('尚未配置');
  });

  it('tests the configured endpoint with a very short prompt', async () => {
    let body = '';
    const mock = createServer((request, response) => {
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    saveModelServices(store, {
      connections: [
        {
          id: 'conn-chat',
          name: '测试平台',
          platform: 'custom',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              id: 'chat-1',
              name: 'mock-model',
              capabilities: ['chat'],
              source: 'user',
              enabled: true
            }
          ]
        }
      ],
      routing: { chat: { connectionId: 'conn-chat', model: 'mock-model' } }
    });
    secrets.set('platform.conn-chat.api_key', 'secret');
    try {
      const result = await testModelConnection(store, secrets);
      expect(result.ok).toBe(true);
      expect(result.model).toBe('mock-model');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toBe('OK');
      expect(body).toContain('只回复 OK');
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      saveModelServices(store, { connections: [], routing: {} }, secrets);
      secrets.clear('platform.conn-chat.api_key');
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
