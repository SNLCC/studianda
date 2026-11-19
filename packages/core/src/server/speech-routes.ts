import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES, API_PREFIX } from '@studianda/shared';
import { resolveModelConnection } from '../model-services.js';
import {
  correctTranscript,
  getSpeechConfig,
  listSystemVoices,
  mimoVoiceList,
  saveSpeechConfig,
  speechStreamingAvailable,
  streamSpeech,
  synthesizeSpeech,
  systemSpeechStatus,
  transcribeAudio,
  validateWav,
  voicesForSpeechConnection
} from '../speech.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface SpeechRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/** 语音输入/播报/音色/转写纠错配置与流式朗读。从 server.ts 抽出。 */
export function registerSpeechRoutes(app: FastifyInstance, options: SpeechRouteOptions): void {
  app.get(`${API_PREFIX}/speech/config`, async () =>
    getSpeechConfig(options.store, options.secrets)
  );

  // 系统语音只读自检：不发送音频/文本，仅读取本机 Windows 语音组件信息。
  app.get(`${API_PREFIX}/speech/system`, async () => systemSpeechStatus());

  /**
   * 音色列表：按客户端当前正在编辑的播报方式取，而不是只按已保存的配置取。
   *
   * 关键约束：`mode=model` 时必须用「选中的平台连接 + 模型」取音色；拿不到连接就直接
   * 返回可操作的中文说明，**绝不回退**到 `config.tts_url`（旧版本存下来的 MiMo 地址）。
   * 之前正是这个回退导致用户「配置了模型，检测音色还是 MiMo」。
   */
  app.get(`${API_PREFIX}/speech/voices`, async (request) => {
    const query = request.query as {
      connection_id?: string;
      model?: string;
      mode?: string;
      url?: string;
    };
    const config = getSpeechConfig(options.store, options.secrets);
    const mode: 'system' | 'model' | 'custom' =
      query.mode === 'system' || query.mode === 'model' || query.mode === 'custom'
        ? query.mode
        : config.tts_mode;
    if (mode === 'model') {
      const connectionId = (query.connection_id ?? '').trim();
      if (!connectionId) {
        return {
          mode,
          voices: [],
          message:
            '模型服务模式需要先选择「语音平台」：请在上方选择平台与模型后再获取音色（不会回退到旧的 TTS 地址）。'
        };
      }
      const connection = resolveModelConnection(
        options.store,
        options.secrets,
        connectionId
      );
      if (!connection) {
        return {
          mode,
          connection_id: connectionId,
          voices: [],
          message: '模型服务连接不存在（可能已删除），请重新选择语音平台。'
        };
      }
      // 显式传来的 model（即使是空串）优先：避免用户换了模型后，服务端还拿已保存的旧模型名。
      const model = query.model !== undefined ? query.model.trim() : config.tts_model.trim();
      try {
        const list = await voicesForSpeechConnection(
          connection.baseUrl,
          connection.apiKey,
          model
        );
        return {
          mode,
          connection_id: connectionId,
          model,
          voices: list.voices.map((voice) => voice.id),
          labels: Object.fromEntries(list.voices.map((voice) => [voice.id, voice.label])),
          source: list.source,
          metadata_url: list.metadata_url,
          message: list.note
        };
      } catch (error) {
        return {
          mode,
          connection_id: connectionId,
          model,
          voices: [],
          message: error instanceof Error ? error.message : '获取音色失败'
        };
      }
    }
    if (mode === 'system') {
      try {
        const voices = await listSystemVoices();
        return {
          mode,
          voices,
          source: '系统语音',
          message:
            voices.length > 0
              ? `本机 Windows 已安装 ${voices.length} 个 TTS 音色；留空使用系统默认音色。`
              : '没有检测到已安装的系统 TTS 音色；可留空使用系统默认，或先安装 Windows 语音包。'
        };
      } catch {
        return {
          mode,
          voices: [],
          source: '系统语音',
          message: '系统语音音色列表读取失败，可留空使用系统默认。'
        };
      }
    }
    // 自定义 OpenAI 兼容服务：优先用客户端当前填写的地址（未保存也能取），其次已保存地址。
    const url = (query.url ?? config.tts_url).trim();
    const model = query.model !== undefined ? query.model.trim() : config.tts_model.trim();
    if (!url) return { mode, voices: [], message: '请先填写 TTS 服务地址。' };
    const key = options.secrets.get('speech.tts_key')?.trim() ?? '';
    const base = url.replace(/\/+$/, '');
    for (const path of ['/audio/voices', '/voices']) {
      try {
        const response = await fetch(`${base}${path}`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) continue;
        const payload = (await response.json()) as {
          voices?: Array<unknown>;
          data?: Array<unknown>;
        };
        const rows = payload.voices ?? payload.data ?? [];
        const voices = rows
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              const value = item as Record<string, unknown>;
              return typeof value.id === 'string'
                ? value.id
                : typeof value.voice_id === 'string'
                  ? value.voice_id
                  : typeof value.name === 'string'
                    ? value.name
                    : '';
            }
            return '';
          })
          .filter(Boolean);
        if (voices.length > 0) {
          return {
            mode,
            url,
            model,
            voices,
            source: '服务接口',
            message: `来自 TTS 服务 ${base}${path} 的音色列表，共 ${voices.length} 个。`
          };
        }
      } catch {
        // try next path
      }
    }
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    if (host === 'api.xiaomimimo.com') {
      const list = mimoVoiceList(model);
      return {
        mode,
        url,
        model,
        voices: list.voices.map((voice) => voice.id),
        labels: Object.fromEntries(list.voices.map((voice) => [voice.id, voice.label])),
        source: list.source,
        metadata_url: list.metadata_url,
        message: list.note
      };
    }
    return {
      mode,
      url,
      model,
      voices: [],
      message: '服务没有返回音色列表，可手动填写音色 ID。'
    };
  });

  app.put(`${API_PREFIX}/speech/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return saveSpeechConfig(options.store, options.secrets, {
        input_enabled: typeof body.input_enabled === 'boolean' ? body.input_enabled : undefined,
        output_enabled: typeof body.output_enabled === 'boolean' ? body.output_enabled : undefined,
        auto_send: typeof body.auto_send === 'boolean' ? body.auto_send : undefined,
        auto_read: typeof body.auto_read === 'boolean' ? body.auto_read : undefined,
        correction: typeof body.correction === 'boolean' ? body.correction : undefined,
        context: typeof body.context === 'boolean' ? body.context : undefined,
        trigger_mode:
          body.trigger_mode === 'hold' || body.trigger_mode === 'click'
            ? body.trigger_mode
            : undefined,
        direct_audio:
          typeof body.direct_audio === 'boolean' ? body.direct_audio : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
        asr_mode: body.asr_mode as never,
        tts_mode: body.tts_mode as never,
        asr_url: typeof body.asr_url === 'string' ? body.asr_url : undefined,
        tts_url: typeof body.tts_url === 'string' ? body.tts_url : undefined,
        asr_model: typeof body.asr_model === 'string' ? body.asr_model : undefined,
        tts_model: typeof body.tts_model === 'string' ? body.tts_model : undefined,
        // 「模型服务」模式必须记住选的是哪条平台连接：只存模型名的话，识别/播报时
        // 无法找回服务地址与密钥，界面刷新后也会退回「选择平台/选择模型」。
        asr_connection_id:
          typeof body.asr_connection_id === 'string' ? body.asr_connection_id : undefined,
        tts_connection_id:
          typeof body.tts_connection_id === 'string' ? body.tts_connection_id : undefined,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        asr_key: typeof body.asr_key === 'string' ? body.asr_key : undefined,
        tts_key: typeof body.tts_key === 'string' ? body.tts_key : undefined,
        clear_asr: body.clear_asr === true,
        clear_tts: body.clear_tts === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存语音配置失败');
    }
  });

  app.post(`${API_PREFIX}/speech/transcribe`, async (request, reply) => {
    let upload;
    try {
      upload = await request.file();
    } catch {
      return badRequest(reply, '需要 multipart 音频文件');
    }
    if (!upload) return badRequest(reply, '缺少音频文件');
    try {
      const bytes = await upload.toBuffer();
      const data = new Uint8Array(bytes);
      // 上传接口先做录音校验（WAV 严格解析；webm 等非 WAV 保持原有逻辑）。
      validateWav(data);
      return await transcribeAudio(
        options.store,
        options.secrets,
        data,
        upload.filename,
        upload.mimetype
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '语音识别失败');
    }
  });

  app.post(`${API_PREFIX}/speech/speak`, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return badRequest(reply, '需要 text');
    }
    try {
      const result = await synthesizeSpeech(options.store, options.secrets, body.text);
      return reply.header('content-type', result.contentType).send(Buffer.from(result.bytes));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '语音播报失败');
    }
  });

  // 流式朗读：只对 DeepSeek 官方连接开放；以裸 PCM 帧持续返回，供界面边收边播。
  // 先确认能力再写响应头：不支持时仍按普通 JSON 错误返回，客户端可回退到整段合成。
  app.post(`${API_PREFIX}/speech/stream`, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return badRequest(reply, '需要 text');
    }
    if (!speechStreamingAvailable(options.store, options.secrets)) {
      return badRequest(reply, '当前语音服务不支持流式朗读');
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'audio/L16;rate=24000;channels=1',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    });
    try {
      await streamSpeech(options.store, options.secrets, body.text, (chunk) => {
        if (!raw.writableEnded) raw.write(Buffer.from(chunk));
      });
      raw.end();
    } catch {
      // 已经开始发送音频：只能中断连接，让客户端知道这一轮不完整。
      if (!raw.writableEnded) raw.destroy();
    }
  });

  // 语音转写纠错：
  // 只校正转写文本，不回答问题；失败时由 correctTranscript 保留原文返回 needs_review。
  app.post(`${API_PREFIX}/speech/correct`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const documentId =
      typeof body.documentId === 'string'
        ? body.documentId
        : typeof body.document_id === 'string'
          ? body.document_id
          : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const page = typeof body.page === 'number' ? body.page : Number(body.page);
    if (!text.trim()) return badRequest(reply, '需要非空 text');
    if (text.length > 8000) return badRequest(reply, '语音文本过长（上限 8000 字符）');
    if (!documentId) return badRequest(reply, '需要 documentId');
    const document = options.store.getDocument(documentId);
    if (!document) return notFound(reply, '文档不存在');
    if (!Number.isInteger(page) || page < 1 || page > document.pages) {
      return badRequest(reply, '页码超出范围');
    }
    const history = Array.isArray(body.history)
      ? (body.history as Array<Record<string, unknown>>)
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            question: typeof item.question === 'string' ? item.question : undefined,
            answer: typeof item.answer === 'string' ? item.answer : undefined
          }))
      : undefined;
    try {
      return await correctTranscript(options.store, options.secrets, {
        documentId,
        page,
        text,
        history
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '语音纠错失败';
      if (message === '语音输入未开启') {
        return reply.code(403).send({ error: API_ERROR_CODES.forbidden, message });
      }
      // 兜底：纠错链路的异常不应变成 500（正常情况下 correctTranscript 已自行吞掉）。
      return badRequest(reply, message);
    }
  });
}
