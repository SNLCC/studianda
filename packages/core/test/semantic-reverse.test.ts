import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { SecretStore } from '../src/secrets.js';
import { semanticReversePages } from '../src/semantic-reverse.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-semantic-reverse-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('semantic reverse recall', () => {
  it('does not call external embeddings when disabled', async () => {
    const result = await semanticReversePages(
      store,
      new SecretStore(),
      'missing-document',
      'X 的概念',
      new Set([1])
    );
    expect(result.enabled).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.warning).toContain('未启用 embedding');
  });
});
