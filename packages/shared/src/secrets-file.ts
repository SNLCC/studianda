/**
 * `userData/secrets.json` 的共享格式与编解码逻辑。
 *
 * 背景：密钥落盘只允许这一条链路——宿主用系统安全存储（Electron 的 `safeStorage`）
 * 加密成 base64 后写 JSON 文件；Core 只持有解密后的内存副本。模型密钥与其它服务
 * 密钥（语音/搜索/Zotero/在线解析）共用同一份文件、同一套白名单。
 *
 * 这里刻意不 import `node:fs` / `electron`：文件读写与加解密由宿主注入，这样
 * Electron 主进程、未来其它宿主（如 DSH 插件）以及测试可以复用同一份格式校验，
 * 不会出现“一处接受、另一处静默丢弃”或各写一套文件格式的漂移。
 */

export const SECRETS_FILE_VERSION = 1 as const;

/**
 * 系统凭据加密不可用时的统一文案（桌面主进程与界面提示共用）。
 *
 * 语义：拒绝保存并把原因如实告诉用户，不回退到明文写盘、也不假装已保存。
 */
export const SECRET_ENCRYPTION_UNAVAILABLE_MESSAGE =
  '当前系统没有可用的凭据加密（safeStorage），请不要在此环境保存密钥。';

/**
 * 密钥名称白名单：Core 的 SecretStore、桌面主进程的加密文件、界面提示共用。
 *
 * 两处各自维护会出现“一处接受、另一处静默丢弃”的漂移：设置里填了密钥，重启后又要重填。
 * 新增密钥只改这里，并同步 `packages/core/src/secrets.ts` 的使用方与测试。
 */
const FIXED_SECRET_NAMES = new Set([
  'parsing.service_key',
  'zotero.api_key',
  'zotero.webdav_password',
  'speech.asr_key',
  'speech.tts_key',
  'search.api_key'
]);

export function isAllowedSecretName(name: string): boolean {
  return (
    FIXED_SECRET_NAMES.has(name) ||
    /^platform\.[A-Za-z0-9_-]+\.api_key$/.test(name) ||
    /^speech\.[A-Za-z0-9_-]+\.key$/.test(name)
  );
}

/** 加密后的密钥文件结构：值只存 base64 密文，明文永远不写进这个对象。 */
export interface EncryptedSecretsFile {
  version: typeof SECRETS_FILE_VERSION;
  /** 密钥名 → base64(系统安全存储密文)。 */
  values: Record<string, string>;
}

/** 宿主提供的加解密适配；Electron 主进程用 `safeStorage` 实现。 */
export interface SecretsFileCipher {
  isEncryptionAvailable(): boolean;
  /** 明文 → 可直接放进 JSON 的 base64 字符串。 */
  encryptToBase64(plainText: string): string;
  /** base64 字符串 → 明文；解不开时应抛错。 */
  decryptFromBase64(encoded: string): string;
}

/** 宿主提供的文件读写适配（只处理文本，权限/目录创建由宿主负责）。 */
export interface SecretsFileStorage {
  /** 读取文件文本；文件不存在或不可读时返回 null。 */
  read(): string | null;
  /** 覆盖写入文件文本（宿主要保证只有当前用户可读）。 */
  write(text: string): void;
}

/** 密钥状态：界面只用它判断“能否持久保存”和“已保存了哪些名字”。 */
export interface SecretsFileStatus {
  /** 系统凭据加密是否可用；不可用时保存会被拒绝。 */
  encryptionAvailable: boolean;
  configured: string[];
}

export function emptySecretsFile(): EncryptedSecretsFile {
  return { version: SECRETS_FILE_VERSION, values: {} };
}

/**
 * 解析文件文本。损坏/版本不认识/含非白名单名字时逐项丢弃，不抛异常——
 * 旧机器换用户后解不开某条密钥不应让应用启动失败。
 */
export function parseSecretsFile(raw: string | null): EncryptedSecretsFile {
  if (!raw) return emptySecretsFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySecretsFile();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== SECRETS_FILE_VERSION ||
    typeof (parsed as { values?: unknown }).values !== 'object' ||
    (parsed as { values?: unknown }).values == null
  ) {
    return emptySecretsFile();
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    (parsed as { values: Record<string, unknown> }).values
  )) {
    if (isAllowedSecretName(name) && typeof value === 'string' && value) values[name] = value;
  }
  return { version: SECRETS_FILE_VERSION, values };
}

/** 序列化成落盘文本：固定两空格缩进 + 末尾换行，便于人工核对（内容仍是密文）。 */
export function serializeSecretsFile(file: EncryptedSecretsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * 把一个密钥加密进文件结构（返回新对象，不改入参）。
 *
 * 加密不可用时直接抛错，绝不回退明文：这是“要么加密落盘、要么明确拒绝”的硬边界。
 */
export function encryptSecretValue(
  file: EncryptedSecretsFile,
  cipher: SecretsFileCipher,
  name: string,
  value: string
): EncryptedSecretsFile {
  if (!isAllowedSecretName(name)) throw new Error(`不支持的密钥：${name}`);
  if (!cipher.isEncryptionAvailable()) {
    throw new Error(SECRET_ENCRYPTION_UNAVAILABLE_MESSAGE);
  }
  return {
    version: SECRETS_FILE_VERSION,
    values: { ...file.values, [name]: cipher.encryptToBase64(value) }
  };
}

/** 从文件结构里删除一个密钥（返回新对象）。 */
export function clearSecretFromFile(
  file: EncryptedSecretsFile,
  name: string
): EncryptedSecretsFile {
  const values = { ...file.values };
  delete values[name];
  return { version: SECRETS_FILE_VERSION, values };
}

/**
 * 解密文件里的全部密钥。
 *
 * 加密不可用时返回空对象；单条解不开（换机器/换用户）时跳过该条而不是整体失败。
 */
export function decryptSecretsFile(
  file: EncryptedSecretsFile,
  cipher: SecretsFileCipher
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cipher.isEncryptionAvailable()) return result;
  for (const [name, encoded] of Object.entries(file.values)) {
    try {
      result[name] = cipher.decryptFromBase64(encoded);
    } catch {
      // 旧机器/换用户后解不开时，丢弃该条而不是让应用启动失败。
    }
  }
  return result;
}

/**
 * 加密密钥文件的读写门面：宿主只提供文件读写与加解密，格式/白名单/错误文案在这里统一。
 *
 * 桌面主进程的 `setSecret` / `clearSecret` / 启动注入都通过这个类，避免主进程里
 * 另写一套 JSON 校验；将来的 DSH 宿主也可以直接复用（或换成自己的安全存储实现）。
 */
export class SecretFileStore {
  constructor(
    private readonly storage: SecretsFileStorage,
    private readonly cipher: SecretsFileCipher
  ) {}

  /** 读取并校验磁盘上的文件；不存在/损坏时返回空结构。 */
  read(): EncryptedSecretsFile {
    try {
      return parseSecretsFile(this.storage.read());
    } catch {
      return emptySecretsFile();
    }
  }

  status(): SecretsFileStatus {
    const file = this.read();
    return {
      encryptionAvailable: this.cipher.isEncryptionAvailable(),
      configured: Object.keys(file.values)
    };
  }

  /** 保存或删除（空值）一个密钥；加密不可用时抛中文错误并拒绝写入。 */
  save(name: string, value: string): SecretsFileStatus {
    if (!isAllowedSecretName(name)) throw new Error(`不支持的密钥：${name}`);
    const current = this.read();
    const next =
      value.trim() === ''
        ? clearSecretFromFile(current, name)
        : encryptSecretValue(current, this.cipher, name, value);
    this.storage.write(serializeSecretsFile(next));
    return this.status();
  }

  /** 删除一个密钥（同时更新磁盘文件）。 */
  clear(name: string): SecretsFileStatus {
    if (!isAllowedSecretName(name)) throw new Error(`不支持的密钥：${name}`);
    this.storage.write(serializeSecretsFile(clearSecretFromFile(this.read(), name)));
    return this.status();
  }

  /** 解密全部密钥，供启动时注入 Core；加密不可用时返回空对象。 */
  decrypted(): Record<string, string> {
    return decryptSecretsFile(this.read(), this.cipher);
  }
}
