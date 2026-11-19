/**
 * 宿主密钥持久化的能力判断与写入编排。
 *
 * 设计取舍：Core 是独立子进程，没有回推主进程的通道；“UI → Core 配置路由”仍保留
 * 作为**所有宿主都能用**的写入方式（Core 内存态）。有系统安全存储的宿主（Electron）
 * 额外经 `RuntimeAdapter.setSecret` 走同一条加密落盘链路，把同一份值写进
 * `userData/secrets.json`，重启后由主进程注入 Core。
 *
 * 这里只依赖 `RuntimeAdapter` 的可选能力，不新造能力探测：
 * - `setSecret` 存在 = 宿主支持加密落盘（与 `ModelServicesPanel` 的既有判断一致）；
 * - 不存在 = 优雅降级为“仅内存”，调用方必须如实提示用户重启后要重填，
 *   不能报错、也不能假装已持久保存。
 */
import type { RuntimeAdapter } from './runtime.js';

/** 一次密钥变更：有 `value` 表示保存，`clear: true` 表示删除。 */
export interface HostSecretChange {
  name: string;
  value?: string;
  clear?: boolean;
}

/** 当前宿主是否支持把密钥加密落盘（复用既有的 `setSecret` 可选能力判断）。 */
export function canPersistHostSecrets(adapter: Pick<RuntimeAdapter, 'setSecret'>): boolean {
  return typeof adapter.setSecret === 'function';
}

/**
 * 宿主不支持加密落盘时追加的提示文案。
 *
 * 语义是“本次运行可用、重启后要重填”，不是“保存失败”，所以放在成功回执后面；
 * 有加密能力的宿主不会看到这句话，也就不会出现“误以为重启后还在”的假象。
 */
export const MEMORY_ONLY_SECRET_NOTICE =
  '当前宿主不支持加密保存密钥：本次填写的密钥只保存在内存中，重启后需要重新填写。';

/** 保存成功回执：单宿主不支持落盘时追加“仅内存”提示。 */
export function withSecretPersistenceNotice(
  adapter: Pick<RuntimeAdapter, 'setSecret'>,
  message: string
): string {
  return canPersistHostSecrets(adapter) ? message : `${message}${MEMORY_ONLY_SECRET_NOTICE}`;
}

/**
 * 把密钥变更写进宿主的加密存储。
 *
 * 返回 `true` 表示确实走了加密落盘；`false` 表示宿主没有该能力（此时调用方应把密钥
 * 继续交给 Core 配置路由，让本次运行可用）。宿主有 `setSecret` 但加密不可用时，
 * 主进程会抛中文错误，这里不吞掉——调用方据此提示用户拒绝保存，而不是静默降级。
 */
export async function persistHostSecretChanges(
  adapter: RuntimeAdapter,
  changes: HostSecretChange[]
): Promise<boolean> {
  const setSecret = adapter.setSecret;
  if (!setSecret || changes.length === 0) return false;
  for (const change of changes) {
    if (change.clear) {
      if (adapter.clearSecret) await adapter.clearSecret(change.name);
      else await setSecret(change.name, '');
    } else if (change.value) {
      await setSecret(change.name, change.value);
    }
  }
  return true;
}

/** 单独删除若干个已落盘密钥（例如 Core 在保存模型服务时顺带清掉了语音密钥）。 */
export async function clearPersistedHostSecrets(
  adapter: RuntimeAdapter,
  names: string[]
): Promise<void> {
  if (names.length === 0) return;
  await persistHostSecretChanges(
    adapter,
    names.map((name) => ({ name, clear: true }))
  );
}

/**
 * 保存后按 Core 的“是否仍持有该密钥”校准加密文件。
 *
 * 部分配置保存会在 Core 侧**隐式清密钥**（例如识别方式改服务地址后旧 Token 不再适用、
 * 语音模型被删后回退本机）。只经 IPC 保存时 Core 的决定不会写回文件，重启注入就会把
 * 旧密钥又推回去；这里以 Core 的返回值 has_* 为准删除多余条目，保证两侧一致。
 */
export async function syncPersistedHostSecrets(
  adapter: RuntimeAdapter,
  presence: Array<{ name: string; present: boolean }>
): Promise<void> {
  const names = presence.filter((item) => !item.present).map((item) => item.name);
  await clearPersistedHostSecrets(adapter, names);
}
