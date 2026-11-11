import { describe, expect, it } from 'vitest';
import { isAllowedSecretName } from '@studianda/shared';

/**
 * 密钥名称白名单回归（合规整改 P1-14）。
 *
 * 背景：桌面主进程只把白名单内的密钥用 safeStorage 加密写进 secrets.json；
 * 这里与 Core 的 SecretStore 共用 shared 的 isAllowedSecretName，避免两处各自维护
 * 导致“设置里填了、重启后静默丢失”。
 */
describe('isAllowedSecretName', () => {
  it('accepts every fixed Core secret name', () => {
    for (const name of [
      'parsing.service_key',
      'zotero.api_key',
      'zotero.webdav_password',
      'speech.asr_key',
      'speech.tts_key',
      'search.api_key'
    ]) {
      expect(isAllowedSecretName(name), name).toBe(true);
    }
  });

  it('accepts platform and speech dynamic names', () => {
    expect(isAllowedSecretName('platform.deepseek.api_key')).toBe(true);
    expect(isAllowedSecretName('platform.my-platform_1.api_key')).toBe(true);
    expect(isAllowedSecretName('speech.mimo.key')).toBe(true);
    expect(isAllowedSecretName('speech.asr.key')).toBe(true);
  });

  it('rejects unknown names and malformed patterns', () => {
    for (const name of [
      '',
      'unknown.key',
      'platform.api_key',
      'platform..api_key',
      'platform.x.token',
      'speech.key',
      'speech..key',
      'speech.x.api_key',
      'search.api_key.extra'
    ]) {
      expect(isAllowedSecretName(name), name).toBe(false);
    }
  });
});
