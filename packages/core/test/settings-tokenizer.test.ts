import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cost } from '../src/reading.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { hasActiveTokenizer } from '../src/tokenizer.js';

const token = 'settings-tokenizer-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-settings-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

const TOKENIZER = JSON.stringify({
  model: { type: 'BPE', vocab: { a: 0, b: 1, ab: 2 }, merges: ['a b'] },
  pre_tokenizer: { type: 'Whitespace' }
});

describe('本地 tokenizer 导入与精确计数', () => {
  it('导入后 cost 使用 BPE 精确计数', async () => {
    expect(cost('ab')).toBe(3); // 保守估算：2 字符 + 1
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/settings/tokenizer',
      headers: headers(),
      payload: { text: TOKENIZER }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tokenizer_id: string };
    expect(body.tokenizer_id).toMatch(/^[0-9a-f]{64}$/);
    expect(hasActiveTokenizer()).toBe(true);
    // "ab" 走一次 BPE 合并 → 1 个 token；"aab" → a + ab → 2。
    expect(cost('ab')).toBe(1);
    expect(cost('aab')).toBe(2);
    const status = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/tokenizer',
      headers: headers()
    });
    expect((status.json() as { configured: boolean }).configured).toBe(true);
  });

  it('非 BPE tokenizer 明确拒绝', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/settings/tokenizer',
      headers: headers(),
      payload: { text: JSON.stringify({ model: { type: 'WordPiece' } }) }
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('BPE');
  });
});
