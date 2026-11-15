import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { saveModelServices } from '../src/model-services.js';
import {
  deepseekVoiceList,
  getSpeechConfig,
  saveSpeechConfig,
  speechBillableChars,
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

  it('模型模式按选中的平台连接与模型播报，并拒绝来自其它平台的旧模型名', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(Buffer.from('RIFF'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' }
      });
    });
    try {
      saveModelServices(store, {
        connections: [
          {
            id: 'conn-openai-tts',
            name: 'OpenAI 兼容平台',
            platform: 'openai',
            baseUrl: 'https://tts.example.com/v1',
            models: [
              {
                id: 'chat-1',
                name: 'chat-model',
                capabilities: ['chat'],
                source: 'preset',
                enabled: true
              },
              {
                id: 'tts-1',
                name: 'tts-model',
                capabilities: ['tts'],
                source: 'preset',
                enabled: true
              }
            ]
          }
        ]
      });
      saveSpeechConfig(store, secrets, {
        tts_mode: 'model',
        tts_connection_id: 'conn-openai-tts',
        tts_model: 'tts-model',
        voice: 'alloy'
      });
      const audio = await synthesizeSpeech(store, secrets, 'hello');
      expect(Buffer.from(audio.bytes).toString('utf8')).toBe('RIFF');
      expect(requests[0]?.url).toBe('https://tts.example.com/v1/audio/speech');
      expect(requests[0]?.body).toContain('"model":"tts-model"');
      expect(requests[0]?.body).toContain('"voice":"alloy"');

      // 没有保存模型时优先选该平台「有 TTS 能力」的模型，而不是模型列表第一行的对话模型。
      saveSpeechConfig(store, secrets, { tts_model: '' });
      await synthesizeSpeech(store, secrets, 'hello');
      expect(requests[1]?.body).toContain('"model":"tts-model"');

      // 换了平台却还留着旧平台的模型名：必须明确报错，不能悄悄用到别的地址/模型上。
      saveSpeechConfig(store, secrets, { tts_model: 'mimo-v2.5-tts' });
      await expect(synthesizeSpeech(store, secrets, 'hello')).rejects.toThrow(
        '不属于当前平台'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('MiniMax 播报缺音色时明确要求先选音色，而不是静默用默认值', async () => {
    saveSpeechConfig(store, secrets, {
      tts_mode: 'custom',
      tts_url: 'https://api.minimax.io/v1',
      tts_model: 'speech-02',
      voice: ''
    });
    await expect(synthesizeSpeech(store, secrets, 'hello')).rejects.toThrow('必须指定音色 ID');
  });
});

describe('DeepSeek 语音（ASR / TTS / 流式可用性）', () => {
  const deepseek = 'https://api.deepseek.com';

  function useDeepseekSpeech(voice = 'stella'): void {
    saveSpeechConfig(store, secrets, {
      asr_mode: 'custom',
      asr_url: deepseek,
      asr_model: 'deepseek-asr',
      asr_key: 'k',
      tts_mode: 'custom',
      tts_url: deepseek,
      tts_model: 'deepseek-tts',
      tts_key: 'k',
      voice
    });
  }

  it('识别：multipart 打到 /v1/tools/asr，返回文本', async () => {
    useDeepseekSpeech();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: '  你好  ', duration_ms: 1200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    try {
      const result = await transcribeAudio(
        store,
        secrets,
        new Uint8Array([1, 2, 3]),
        'a.wav',
        'audio/wav'
      );
      expect(result.text).toBe('你好');
      expect(result.source).toBe('deepseek');
      expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/tools/asr');
      expect(calls[0]!.init!.method).toBe('POST');
      expect(calls[0]!.init!.body).toBeInstanceOf(FormData);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('合成：voice_id/format/filter_markdown 正确，超长按计费字符截断', async () => {
    useDeepseekSpeech('tide');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/wav' }
      });
    });
    try {
      await synthesizeSpeech(store, secrets, '正'.repeat(6000));
      expect(bodies[0]).toMatchObject({
        voice_id: 'tide',
        format: 'wav',
        filter_markdown: true
      });
      // 汉字算 2 个计费字符：10,000 上限 → 最多 5,000 个汉字。
      expect((bodies[0]!.text as string).length).toBe(5000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('只接受两个预置音色', async () => {
    useDeepseekSpeech('alloy');
    await expect(synthesizeSpeech(store, secrets, 'hello')).rejects.toThrow('stella');
  });

  it('计费字符按官方口径计算；流式可用性只对官方连接为真', () => {
    expect(speechBillableChars('中文abc')).toBe(7);
    useDeepseekSpeech();
    expect(getSpeechConfig(store, secrets).tts_streaming).toBe(true);
    saveSpeechConfig(store, secrets, {
      tts_mode: 'custom',
      tts_url: 'https://api.example.com/v1'
    });
    expect(getSpeechConfig(store, secrets).tts_streaming).toBe(false);
    expect(deepseekVoiceList().voices.map((voice) => voice.id)).toEqual(['stella', 'tide']);
  });
});
