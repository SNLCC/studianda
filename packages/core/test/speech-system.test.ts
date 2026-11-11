import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import {
  parseSystemSpeechStatus,
  systemSpeechStatus,
  transcribeAudio,
  validateWav
} from '../src/speech.js';
import { Store } from '../src/store.js';

// 系统语音自检要跑 PowerShell；用 mock 返回固定 status JSON，避免依赖本机语音组件。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const spawn = vi.fn(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (stdout as unknown as { setEncoding: (value: string) => void }).setEncoding = () => {};
    (stderr as unknown as { setEncoding: (value: string) => void }).setEncoding = () => {};
    const child = new EventEmitter();
    Object.assign(child, {
      stdout,
      stderr,
      kill: () => {},
      stdin: {
        end: () => {
          setTimeout(() => {
            stdout.emit(
              'data',
              JSON.stringify({
                voices: ['Microsoft Huihui Desktop'],
                recognizers: ['zh-CN']
              })
            );
            child.emit('close', 0);
          }, 0);
        }
      }
    });
    return child;
  });
  return { ...actual, spawn };
});

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-speech-system-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface WavOptions {
  channels?: number;
  sampleWidth?: number;
  sampleRate?: number;
  durationSeconds?: number;
  dataSizeOverride?: number;
}

/** 造一个最小 PCM WAV；参数可越界用于错误用例。 */
function makeWav(options: WavOptions = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const sampleWidth = options.sampleWidth ?? 2;
  const sampleRate = options.sampleRate ?? 16000;
  const duration = options.durationSeconds ?? 1;
  const dataSize =
    options.dataSizeOverride ??
    Math.max(1, Math.round(sampleRate * channels * sampleWidth * duration));
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * sampleWidth, 28);
  buffer.writeUInt16LE(channels * sampleWidth, 32);
  buffer.writeUInt16LE(sampleWidth * 8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buffer);
}

describe('validateWav', () => {
  it('accepts a mono 16-bit PCM WAV within 60 seconds', () => {
    const info = validateWav(makeWav());
    expect(info).toMatchObject({ channels: 1, bitsPerSample: 16, sampleRate: 16000 });
    expect(info?.durationSeconds).toBeCloseTo(1, 3);
    expect(validateWav(makeWav({ sampleRate: 8000 }))?.sampleRate).toBe(8000);
    expect(validateWav(makeWav({ sampleRate: 48000 }))?.sampleRate).toBe(48000);
  });

  it('returns null for non-WAV audio (webm compatibility)', () => {
    expect(validateWav(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(validateWav(new Uint8Array(64))).toBeNull();
  });

  it('rejects stereo / 8-bit / out-of-range sample rates / too-long WAVs', () => {
    const message = '需要最长 60 秒的单声道 PCM WAV';
    expect(() => validateWav(makeWav({ channels: 2 }))).toThrow(message);
    expect(() => validateWav(makeWav({ sampleWidth: 1 }))).toThrow(message);
    expect(() => validateWav(makeWav({ sampleRate: 7999 }))).toThrow(message);
    expect(() => validateWav(makeWav({ sampleRate: 48001 }))).toThrow(message);
    expect(() => validateWav(makeWav({ sampleRate: 8000, durationSeconds: 61.5 }))).toThrow(
      message
    );
    expect(() => validateWav(makeWav({ sampleRate: 8000, durationSeconds: 61 }))).not.toThrow();
  });

  it('rejects recordings larger than 8 MB with the length message', () => {
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    expect(() => validateWav(huge)).toThrow('录音过长，最多 60 秒');
  });

  it('rejects malformed containers and is enforced before transcription', async () => {
    const truncated = new Uint8Array(12);
    truncated.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    truncated.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE，但没有 fmt/data
    expect(() => validateWav(truncated)).toThrow('需要最长 60 秒的单声道 PCM WAV');
    await expect(
      transcribeAudio(store, secrets, makeWav({ channels: 2 }))
    ).rejects.toThrow('需要最长 60 秒的单声道 PCM WAV');
  });
});

describe('system speech status', () => {
  it('parses Windows status JSON (arrays and scalars)', () => {
    const result = parseSystemSpeechStatus(
      'win32',
      JSON.stringify({ voices: ['A', 'B'], recognizers: ['zh-CN', 'en-US'] })
    );
    expect(result).toMatchObject({ platform: 'win32', ok: true });
    expect(result.tts_voices).toEqual(['A', 'B']);
    expect(result.asr_languages).toEqual(['zh-CN', 'en-US']);
    expect(result.message).toContain('2 个 TTS 音色');

    const scalar = parseSystemSpeechStatus(
      'win32',
      JSON.stringify({ voices: 'OnlyVoice', recognizers: 'zh-CN' })
    );
    expect(scalar.tts_voices).toEqual(['OnlyVoice']);
    expect(scalar.asr_languages).toEqual(['zh-CN']);
  });

  it('reports unparsable Windows status as not ok', () => {
    const result = parseSystemSpeechStatus('win32', 'not json');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法解析');
    expect(result.detail).toHaveLength(1);
  });

  it('explains that system speech only works on Windows', async () => {
    const result = await systemSpeechStatus('darwin');
    expect(result).toMatchObject({
      platform: 'darwin',
      ok: false,
      tts_voices: [],
      asr_languages: []
    });
    expect(result.message).toContain('Windows');
  });

  it('returns Windows voices and recognizers through the mocked script', async () => {
    const result = await systemSpeechStatus('win32');
    expect(result.platform).toBe('win32');
    if (process.platform === 'win32') {
      expect(result.ok).toBe(true);
      expect(result.tts_voices).toContain('Microsoft Huihui Desktop');
      expect(result.asr_languages).toContain('zh-CN');
    }
  });
});

describe('GET /api/v1/speech/system', () => {
  it('returns the read-only system speech status', async () => {
    const server = buildServer({
      token: 'test-token',
      version: 'test-version',
      store,
      secrets
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/speech/system',
        headers: { 'x-studianda-token': 'test-token' }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        platform: string;
        ok: boolean;
        tts_voices: string[];
        asr_languages: string[];
        message: string;
        detail: string[];
      };
      expect(body.platform).toBe(process.platform);
      expect(typeof body.ok).toBe('boolean');
      expect(Array.isArray(body.tts_voices)).toBe(true);
      expect(Array.isArray(body.asr_languages)).toBe(true);
      expect(typeof body.message).toBe('string');
      expect(Array.isArray(body.detail)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
