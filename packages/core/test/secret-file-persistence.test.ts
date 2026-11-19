import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SECRET_ENCRYPTION_UNAVAILABLE_MESSAGE,
  SecretFileStore,
  parseSecretsFile,
  type SecretsFileCipher,
  type SecretsFileStorage
} from '@studianda/shared';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 非模型密钥（语音/搜索/Zotero/在线解析）持久化回归网。
 *
 * 口径与桌面主进程一致：明文只存在于内存；磁盘上只有 `secrets.json` 里的
 * 系统安全存储密文。这里用可逆的假 cipher 模拟 Electron `safeStorage`，
 * 验证“保存 → 同进程读回 → 重启（重建 Core 实例 + 重新注入）→ 仍可用”、
 * 磁盘无明文、加密不可用时拒绝保存、clear 后条目消失。
 */

/** 6 个非模型密钥 + 1 个模型密钥（证明两类密钥走同一份文件）。 */
const PLAINTEXT_SECRETS: Record<string, string> = {
  'zotero.api_key': 'plain-zotero-key-0123456789',
  'zotero.webdav_password': 'plain-webdav-password-0123456789',
  'speech.asr_key': 'plain-asr-key-0123456789',
  'speech.tts_key': 'plain-tts-key-0123456789',
  'search.api_key': 'plain-search-key-0123456789',
  'parsing.service_key': 'plain-parsing-key-0123456789',
  'platform.deepseek.api_key': 'plain-model-key-0123456789'
};

/** 假 cipher：可逆，但磁盘上的字节不等于明文（也不是明文的 base64）。 */
function fakeCipher(available = true): SecretsFileCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptToBase64: (plainText) =>
      Buffer.from(plainText, 'utf8').toString('base64').split('').reverse().join(''),
    decryptFromBase64: (encoded) =>
      Buffer.from(encoded.split('').reverse().join(''), 'base64').toString('utf8')
  };
}

function fileStorage(file: string): SecretsFileStorage {
  return {
    read: () => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    write: (text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, { mode: 0o600 });
    }
  };
}

const roots: string[] = [];
function tempRoot(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `studianda-${label}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function saveAll(file: string, cipher: SecretsFileCipher): SecretFileStore {
  const store = new SecretFileStore(fileStorage(file), cipher);
  for (const [name, value] of Object.entries(PLAINTEXT_SECRETS)) store.save(name, value);
  return store;
}

interface CoreInstance {
  server: ReturnType<typeof buildServer>;
  store: Store;
  secrets: SecretStore;
}

/** 模拟桌面主进程启动：新的 Core 进程 + 新的内存 SecretStore（密钥随后由 HTTP 注入）。 */
function startCoreInstance(dataDir: string): CoreInstance {
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  const server = buildServer({ token: 'secret-persistence-token', version: 'test', store, secrets });
  return { server, store, secrets };
}

async function inject(instance: CoreInstance, decrypted: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(decrypted)) {
    const response = await instance.server.inject({
      method: 'POST',
      url: '/api/v1/secrets',
      headers: { 'x-studianda-token': 'secret-persistence-token' },
      payload: { name, value }
    });
    expect(response.statusCode).toBe(200);
  }
}

async function readConfigs(instance: CoreInstance): Promise<Record<string, unknown>> {
  const headers = { 'x-studianda-token': 'secret-persistence-token' };
  const get = async (url: string): Promise<Record<string, unknown>> => {
    const response = await instance.server.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  };
  return {
    zotero: await get('/api/v1/zotero/config'),
    speech: await get('/api/v1/speech/config'),
    search: await get('/api/v1/web-search/config'),
    parsing: await get('/api/v1/parsing/config')
  };
}

async function close(instance: CoreInstance): Promise<void> {
  await instance.server.close();
  instance.store.close();
}

describe('secrets.json 加密落盘（非模型密钥与模型密钥同一链路）', () => {
  it('保存 → 同一进程读回 → 磁盘字节里没有明文', () => {
    const root = tempRoot('secret-file');
    const file = path.join(root, 'userData', 'secrets.json');
    const store = saveAll(file, fakeCipher());

    // 同一进程读回：状态与解密值都对得上。
    expect(store.status()).toEqual({
      encryptionAvailable: true,
      configured: Object.keys(PLAINTEXT_SECRETS)
    });
    expect(store.decrypted()).toEqual(PLAINTEXT_SECRETS);

    // 磁盘内容：合法 JSON、只含白名单名字，且不含任何明文/明文 base64。
    const raw = readFileSync(file, 'utf8');
    const parsed = parseSecretsFile(raw);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.values).sort()).toEqual(Object.keys(PLAINTEXT_SECRETS).sort());
    for (const value of Object.values(PLAINTEXT_SECRETS)) {
      expect(raw).not.toContain(value);
      expect(raw).not.toContain(Buffer.from(value, 'utf8').toString('base64'));
    }
  });

  it('保存 → 重启（重建 Core 实例 + 重新注入）→ 仍可用；不注入则内存为空', async () => {
    const root = tempRoot('secret-restart');
    const file = path.join(root, 'userData', 'secrets.json');
    const dataDir = path.join(root, 'data');

    // “第一次运行”：保存后注入 Core。
    saveAll(file, fakeCipher());
    const first = startCoreInstance(dataDir);
    expect(first.secrets.configured()).toEqual([]);
    await inject(first, new SecretFileStore(fileStorage(file), fakeCipher()).decrypted());
    const firstConfigs = await readConfigs(first);
    expect(firstConfigs.zotero).toMatchObject({ has_key: true, has_password: true });
    expect(firstConfigs.speech).toMatchObject({ has_asr_key: true, has_tts_key: true });
    expect(firstConfigs.search).toMatchObject({ has_key: true });
    expect(firstConfigs.parsing).toMatchObject({ has_key: true });
    expect(first.secrets.get('zotero.api_key')).toBe(PLAINTEXT_SECRETS['zotero.api_key']);
    await close(first);

    // “重启”：同一磁盘文件、全新 Core 实例 + 全新内存 SecretStore，重新解密注入后仍可用。
    const second = startCoreInstance(dataDir);
    expect(second.secrets.configured()).toEqual([]);
    const decrypted = new SecretFileStore(fileStorage(file), fakeCipher()).decrypted();
    expect(decrypted).toEqual(PLAINTEXT_SECRETS);
    await inject(second, decrypted);
    const secondConfigs = await readConfigs(second);
    expect(secondConfigs.zotero).toMatchObject({ has_key: true, has_password: true });
    expect(secondConfigs.speech).toMatchObject({ has_asr_key: true, has_tts_key: true });
    expect(secondConfigs.search).toMatchObject({ has_key: true });
    expect(secondConfigs.parsing).toMatchObject({ has_key: true });
    expect(second.secrets.get('speech.asr_key')).toBe(PLAINTEXT_SECRETS['speech.asr_key']);
    await close(second);
  });

  it('系统凭据加密不可用时拒绝保存并给中文提示，且不写盘', () => {
    const root = tempRoot('secret-unavailable');
    const file = path.join(root, 'userData', 'secrets.json');
    const store = new SecretFileStore(fileStorage(file), fakeCipher(false));

    expect(() => store.save('zotero.api_key', 'should-not-be-written')).toThrow(
      SECRET_ENCRYPTION_UNAVAILABLE_MESSAGE
    );
    expect(SECRET_ENCRYPTION_UNAVAILABLE_MESSAGE).toContain('safeStorage');
    expect(SECRET_ENCRYPTION_UNAVAILABLE_MESSAGE).toContain('请不要在此环境保存密钥');
    expect(store.read().values).toEqual({});
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('clear 后 secrets.json 里对应条目消失，其它密钥保留', () => {
    const root = tempRoot('secret-clear');
    const file = path.join(root, 'userData', 'secrets.json');
    const store = saveAll(file, fakeCipher());

    const status = store.clear('zotero.api_key');
    expect(status.configured).not.toContain('zotero.api_key');
    expect(status.configured).toContain('search.api_key');
    expect(parseSecretsFile(readFileSync(file, 'utf8')).values).not.toHaveProperty(
      'zotero.api_key'
    );
    expect(store.decrypted()).toMatchObject({
      'search.api_key': PLAINTEXT_SECRETS['search.api_key'],
      'speech.asr_key': PLAINTEXT_SECRETS['speech.asr_key']
    });
    // 删除只删除目标条目（文件里不再有该名称，也没有该明文的任何形式）。
    expect(readFileSync(file, 'utf8')).not.toContain('zotero.api_key');
    expect(readFileSync(file, 'utf8')).not.toContain(PLAINTEXT_SECRETS['zotero.api_key']);
  });
});
