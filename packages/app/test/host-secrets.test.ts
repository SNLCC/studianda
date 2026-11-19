import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_ONLY_SECRET_NOTICE,
  canPersistHostSecrets,
  clearPersistedHostSecrets,
  persistHostSecretChanges,
  syncPersistedHostSecrets,
  withSecretPersistenceNotice
} from '../src/host-secrets.js';
import type { RuntimeAdapter } from '../src/runtime.js';

/**
 * 宿主密钥能力判断的回归网。
 *
 * 复用既有的可选能力 `setSecret`/`clearSecret`：
 * - 有该能力：密钥经加密落盘；
 * - 没有该能力（未来 DSH/Web 宿主）：不报错，降级为“仅内存”，并在成功回执后如实提示
 *   重启后需要重新填写，不能假装已持久保存。
 */

function fakeAdapter(overrides: Partial<RuntimeAdapter> = {}): RuntimeAdapter {
  return {
    getRuntime: async () => null,
    pickPdf: async () => null,
    pickDirectory: async () => null,
    ...overrides
  };
}

function recordingAdapter(overrides: Partial<RuntimeAdapter> = {}): {
  adapter: RuntimeAdapter;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = fakeAdapter({
    getSecretStatus: async () => ({ encryptionAvailable: true, configured: [] }),
    setSecret: async (name, value) => {
      calls.push({ method: 'setSecret', args: [name, value] });
      return { encryptionAvailable: true, configured: [name] };
    },
    clearSecret: async (name) => {
      calls.push({ method: 'clearSecret', args: [name] });
      return { encryptionAvailable: true, configured: [] };
    },
    ...overrides
  });
  return { adapter, calls };
}

describe('宿主密钥能力判断与降级', () => {
  it('宿主没有 setSecret 能力时降级为仅内存：不报错、不写宿主、提示重启后重填', async () => {
    const adapter = fakeAdapter();
    expect(canPersistHostSecrets(adapter)).toBe(false);

    const persisted = await persistHostSecretChanges(adapter, [
      { name: 'zotero.api_key', value: 'plain-host-key' }
    ]);
    expect(persisted).toBe(false);
    await expect(
      clearPersistedHostSecrets(adapter, ['zotero.api_key', 'speech.asr_key'])
    ).resolves.toBeUndefined();
    await expect(
      syncPersistedHostSecrets(adapter, [{ name: 'search.api_key', present: false }])
    ).resolves.toBeUndefined();

    const notice = withSecretPersistenceNotice(adapter, '设置已保存。');
    expect(notice).toContain('设置已保存。');
    expect(notice).toContain(MEMORY_ONLY_SECRET_NOTICE);
    expect(MEMORY_ONLY_SECRET_NOTICE).toContain('只保存在内存中');
    expect(MEMORY_ONLY_SECRET_NOTICE).toContain('重启后需要重新填写');
  });

  it('宿主有 setSecret 时把非模型密钥写进加密存储，成功回执不追加“仅内存”提示', async () => {
    const { adapter, calls } = recordingAdapter();
    expect(canPersistHostSecrets(adapter)).toBe(true);

    const persisted = await persistHostSecretChanges(adapter, [
      { name: 'zotero.api_key', value: 'plain-zotero' },
      { name: 'speech.asr_key', value: 'plain-asr' }
    ]);
    expect(persisted).toBe(true);
    expect(calls).toEqual([
      { method: 'setSecret', args: ['zotero.api_key', 'plain-zotero'] },
      { method: 'setSecret', args: ['speech.asr_key', 'plain-asr'] }
    ]);
    expect(withSecretPersistenceNotice(adapter, '设置已保存。')).toBe('设置已保存。');
  });

  it('clear 优先用 clearSecret；宿主只实现 setSecret 时用空值删除', async () => {
    const { adapter, calls } = recordingAdapter();
    await clearPersistedHostSecrets(adapter, ['parsing.service_key']);
    expect(calls).toEqual([{ method: 'clearSecret', args: ['parsing.service_key'] }]);

    const { adapter: onlySet, calls: setCalls } = recordingAdapter({ clearSecret: undefined });
    await clearPersistedHostSecrets(onlySet, ['search.api_key']);
    expect(setCalls).toEqual([{ method: 'setSecret', args: ['search.api_key', ''] }]);
  });

  it('保存后按 Core 的 has_* 校准文件：只删 Core 已不再持有的条目', async () => {
    const { adapter, calls } = recordingAdapter();
    await syncPersistedHostSecrets(adapter, [
      { name: 'zotero.api_key', present: true },
      { name: 'zotero.webdav_password', present: false },
      { name: 'speech.asr_key', present: true },
      { name: 'speech.tts_key', present: false }
    ]);
    expect(calls).toEqual([
      { method: 'clearSecret', args: ['zotero.webdav_password'] },
      { method: 'clearSecret', args: ['speech.tts_key'] }
    ]);
  });

  it('加密不可用时主进程的拒绝错误会原样上抛（不静默降级为内存）', async () => {
    const failure = new Error(
      '当前系统没有可用的凭据加密（safeStorage），请不要在此环境保存密钥。'
    );
    const adapter = fakeAdapter({
      setSecret: vi.fn(async () => {
        throw failure;
      })
    });
    await expect(
      persistHostSecretChanges(adapter, [{ name: 'search.api_key', value: 'plain' }])
    ).rejects.toThrow(failure);
  });
});
