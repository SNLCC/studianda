import { isAllowedSecretName } from '@studianda/shared';

function isAllowedSecret(name: string): boolean {
  return isAllowedSecretName(name);
}

/** 只驻留内存；持久化由 Electron 主进程用 OS 凭据库加密完成。 */
export class SecretStore {
  private readonly values = new Map<string, string>();

  set(name: string, value: string): void {
    if (!isAllowedSecret(name)) throw new Error(`不支持的密钥：${name}`);
    if (!value) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, value);
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  configured(): string[] {
    return [...this.values.keys()];
  }

  clear(name: string): void {
    this.values.delete(name);
  }
}
