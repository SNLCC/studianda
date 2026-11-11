import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import {
  getSpeechConfig,
  saveSpeechConfig,
  synthesizeSpeech,
  transcribeAudio
} from '../src/speech.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-speech-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('speech', () => {
  it('defaults to system modes and disabled input/output', () => {
    expect(getSpeechConfig(store, secrets)).toMatchObject({
      asr_mode: 'system',
      tts_mode: 'system',
      input_enabled: false,
      output_enabled: false,
      has_asr_key: false
    });
  });

  it('requires address and model for custom services', () => {
    expect(() => saveSpeechConfig(store, secrets, { asr_mode: 'custom' })).toThrow();
  });

  it('transcribes and synthesizes through OpenAI-compatible endpoints', async () => {
    const mock = createServer((request, response) => {
      if (request.url === '/audio/transcriptions') {
        request.resume();
        request.on('end', () => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ text: 'hello', confidence: 0.9 }));
        });
        return;
      }
      if (request.url === '/audio/speech') {
        request.resume();
        request.on('end', () => {
          response.setHeader('content-type', 'audio/wav');
          response.end(Buffer.from('RIFFaudio'));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address();
    if (address == null || typeof address === 'string') throw new Error('mock address');
    const base = `http://127.0.0.1:${address.port}`;
    saveSpeechConfig(store, secrets, {
      asr_mode: 'custom',
      asr_url: base,
      asr_model: 'asr-model',
      tts_mode: 'custom',
      tts_url: base,
      tts_model: 'tts-model',
      voice: 'alloy',
      asr_key: 'asr-secret',
      tts_key: 'tts-secret'
    });
    try {
      const transcription = await transcribeAudio(
        store,
        secrets,
        new Uint8Array([1, 2, 3])
      );
      expect(transcription.text).toBe('hello');
      expect(transcription.confidence).toBe(0.9);
      const speech = await synthesizeSpeech(store, secrets, 'read this');
      expect(Buffer.from(speech.bytes).toString('utf8')).toBe('RIFFaudio');
      expect(speech.contentType).toBe('audio/wav');
      expect(JSON.stringify(getSpeechConfig(store, secrets))).not.toContain('asr-secret');
    } finally {
      await new Promise<void>((resolve, reject) =>
        mock.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('uses the MiMo chat protocol for ASR and TTS', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      requests.push({ url: String(url), body });
      if (body.includes('input_audio')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'mimo transcript' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { audio: { data: Buffer.from('RIFF').toString('base64') } } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    saveSpeechConfig(store, secrets, {
      asr_mode: 'custom',
      asr_url: 'https://api.xiaomimimo.com/v1',
      asr_model: 'mimo-asr',
      tts_mode: 'custom',
      tts_url: 'https://api.xiaomimimo.com/v1',
      tts_model: 'mimo-v2.5-tts',
      voice: 'mimo_default',
      asr_key: 'key',
      tts_key: 'key'
    });
    try {
      const transcription = await transcribeAudio(store, secrets, new Uint8Array([1, 2]));
      expect(transcription.text).toBe('mimo transcript');
      const audio = await synthesizeSpeech(store, secrets, 'hello');
      expect(Buffer.from(audio.bytes).toString('utf8')).toBe('RIFF');
      expect(requests[0]?.url).toContain('/chat/completions');
      expect(requests[0]?.body).toContain('input_audio');
      expect(requests[1]?.body).toContain('mimo_default');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the MiniMax protocol for ASR and TTS', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url).includes('/speech_to_text')) {
        return new Response(JSON.stringify({ text: 'minimax transcript' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: { audio: Buffer.from('RIFF').toString('hex') }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    saveSpeechConfig(store, secrets, {
      asr_mode: 'custom',
      asr_url: 'https://api.minimax.io/v1',
      asr_model: 'minimax-asr',
      tts_mode: 'custom',
      tts_url: 'https://api.minimax.io/v1',
      tts_model: 'speech-02',
      voice: 'Chinese (Mandarin)_Lyrical_Voice',
      asr_key: 'key',
      tts_key: 'key'
    });
    try {
      const transcription = await transcribeAudio(store, secrets, new Uint8Array([1, 2]));
      expect(transcription.text).toBe('minimax transcript');
      const audio = await synthesizeSpeech(store, secrets, 'hello');
      expect(Buffer.from(audio.bytes).toString('utf8')).toBe('RIFF');
      expect(requests[0]?.url).toContain('/speech_to_text');
      expect(requests[1]?.url).toContain('/t2a_v2');
      expect(requests[1]?.body).toContain('voice_id');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
