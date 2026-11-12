import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recognizePage, recognizeRegion } from '../src/ocr.js';
import { readRecentErrors } from '../src/error-log.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-region-ocr-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const originalFetch = globalThis.fetch;
let documentId = '';

const REGION = { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 };
const VISION_TEXT = '图 1 数据\n单位为 %';

/** 查询本页 visual 空间中、指定 text 的 chunk（原生文本块也写 visual 空间，需按文本区分）。 */
function rawVisualChunks(matchText: string): Array<{ text: string; bbox: string; bbox_space: string }> {
  const db = (store as unknown as { db: DatabaseSync }).db;
  return db
    .prepare(
      `SELECT text, bbox, bbox_space FROM chunks
       WHERE document_id = ? AND page = 1 AND bbox_space = 'visual' AND text = ? ORDER BY rowid`
    )
    .all(documentId, matchText) as unknown as Array<{
    text: string;
    bbox: string;
    bbox_space: string;
  }>;
}

/** mock 一次视觉/自定义服务调用，返回调用次数、地址与最后一次请求体。 */
function mockJsonResponse(payload: unknown): {
  calls: () => number;
  body: () => string;
  url: () => string;
} {
  let calls = 0;
  let body = '';
  let url = '';
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls += 1;
    url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
    body = typeof init?.body === 'string' ? init.body : '';
    return {
      ok: true,
      status: 200,
      json: async () => payload
    } as unknown as Response;
  }) as typeof fetch;
  return { calls: () => calls, body: () => body, url: () => url };
}

/** 在「模型服务」里配置一个视觉模型（routing.vision），用于验证区域识别的回退。 */
function configureVisualService(): void {
  secrets.set('platform.c-vis.api_key', 'k-vis');
  store.updateSettings({
    'model.services': JSON.stringify([
      {
        id: 'c-vis',
        name: '视觉平台',
        platform: 'custom',
        baseUrl: 'https://vision.example.com/v1',
        models: [
          {
            id: 'm-vis',
            name: 'vis-routed-model',
            capabilities: ['vision'],
            source: 'manual',
            enabled: true
          }
        ]
      }
    ]),
    'model.routing': JSON.stringify({ vision: { connectionId: 'c-vis', model: 'vis-routed-model' } })
  });
}

function clearModelServices(): void {
  store.updateSettings({ 'model.services': '[]', 'model.routing': '{}' });
}

function pngSize(dataUrl: string): { width: number; height: number } {
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

interface FetchRule {
  /** URL 子串或正则。 */
  match: string | RegExp;
  status?: number;
  /** 原样响应文本（非 JSON 网关页也可）。 */
  text?: string;
  /** 响应 JSON（自动序列化）。 */
  json?: unknown;
  /** 直接抛出的网络错误（如超时 DOMException）。 */
  reject?: Error;
}

/** 按 URL 路由的 fetch mock：用于验证 MinerU 各步骤的 HTTP 状态/返回 message/超时文案。 */
function mockFetchRules(rules: FetchRule[]): { urls: () => string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
    void init;
    calls.push(url);
    const rule = rules.find((item) =>
      typeof item.match === 'string' ? url.includes(item.match) : item.match.test(url)
    );
    if (!rule) throw new Error(`未预期的请求：${url}`);
    if (rule.reject) throw rule.reject;
    const status = rule.status ?? 200;
    const text =
      rule.text ?? (rule.json === undefined ? '' : JSON.stringify(rule.json));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => new TextEncoder().encode(text).buffer
    } as unknown as Response;
  }) as typeof fetch;
  return { urls: () => calls };
}

/** 跑一次整页识别并返回错误消息（用于断言失败文案）。 */
async function pageRecognitionError(): Promise<string> {
  try {
    await recognizePage(store, secrets, documentId, 1);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('期望整页识别失败，但成功了');
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('region-ocr-fixture');
  pdf.setAuthor('Studianda test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 600]);
  page.drawText('Region OCR fixture body', { x: 40, y: 540, size: 12, font });
  const file = path.join(dataDir, 'fixture.pdf');
  writeFileSync(file, await pdf.save());
  documentId = (await store.importDocument(file)).id;
  // 环境变量覆盖：给无界面运行/调试用；测试用它给 vision 一个（不会真正连上的）地址。
  process.env.STUDIANDA_MODEL_BASE_URL = 'http://127.0.0.1:9/v1';
  saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
});

afterAll(() => {
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  globalThis.fetch = originalFetch;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
});

describe('region OCR', () => {
  it('crops the selected region, recognizes it with the vision model and stores a visual chunk', async () => {
    expect(rawVisualChunks(VISION_TEXT)).toHaveLength(0);
    const mock = mockJsonResponse({
      choices: [{ message: { content: VISION_TEXT } }]
    });

    const result = await recognizeRegion(store, secrets, documentId, 1, REGION);

    expect(mock.calls()).toBe(1);
    const body = mock.body();
    expect(body).toContain('只转录选区可见文字');
    expect(body).toContain('"max_tokens":4096');
    const match = body.match(/data:image\/png;base64,([^"]+)/);
    expect(match).toBeTruthy();
    // 发出去的是裁剪后的选区（400x600 页面 ×2 渲染；选区 0.5×0.3 → 400×360）。
    expect(pngSize(`data:image/png;base64,${match![1]}`)).toEqual({
      width: 400,
      height: 360
    });

    expect(result.text).toBe(VISION_TEXT);
    expect(result.textReflowed).not.toContain('\n');
    expect(result.textReflowed).toContain('图 1 数据');
    expect(result.bbox).toEqual([0.1, 0.1, 0.6, 0.4]);
    expect(result.engine).toBe('vision');
    // 纯 vision 模式：说明用了哪个模型/地址，不说 MinerU（没有回退）。
    expect(result.engine_note).toContain('vision 模式的视觉模型');
    expect(result.engine_note).toContain('vis-model');
    expect(result.fallback_from).toBeUndefined();

    const chunks = rawVisualChunks(VISION_TEXT);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: VISION_TEXT, bbox_space: 'visual' });
    expect(JSON.parse(chunks[0]!.bbox)).toEqual([0.1, 0.1, 0.6, 0.4]);
    // 区域文字进入 FTS，可以被检索命中。
    expect(store.search('单位为', documentId).some((hit) => hit.page === 1)).toBe(true);
    // 区域识别不写 page_edits（不影响整页文本）。
    expect(store.getPageEdit(documentId, 1)).toBeNull();
  });

  it('does not insert the same visual chunk twice', () => {
    const before = rawVisualChunks(VISION_TEXT).length;
    expect(store.addVisualChunk(documentId, 1, VISION_TEXT, [0.1, 0.1, 0.6, 0.4])).toBe(false);
    expect(rawVisualChunks(VISION_TEXT)).toHaveLength(before);

    expect(store.addVisualChunk(documentId, 1, '另一块区域文字', null)).toBe(true);
    expect(rawVisualChunks('另一块区域文字')).toHaveLength(1);
    expect(store.addVisualChunk(documentId, 1, '另一块区域文字', null)).toBe(false);
  });

  it('rejects invalid regions and out-of-range pages before rendering', async () => {
    await expect(
      recognizeRegion(store, secrets, documentId, 1, { x0: 0.5, y0: 0.1, x1: 0.5, y1: 0.4 })
    ).rejects.toThrow('请选择有效区域');
    await expect(
      recognizeRegion(store, secrets, documentId, 1, { x0: 0.1, y0: 0.4, x1: 0.6, y1: 0.2 })
    ).rejects.toThrow('请选择有效区域');
    await expect(
      recognizeRegion(store, secrets, documentId, 9, REGION)
    ).rejects.toThrow('页码超出范围');
  });

  it('rejects an empty recognition result', async () => {
    mockJsonResponse({ choices: [{ message: { content: '   \n  ' } }] });
    await expect(
      recognizeRegion(store, secrets, documentId, 1, { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.3 })
    ).rejects.toThrow('此区域未识别到文字');
  });

  it('recognizes a cropped region with a custom /parse service', async () => {
    saveParsingConfig(store, secrets, {
      mode: 'custom',
      service_url: 'http://127.0.0.1:9/parse',
      allow_remote: true
    });
    const mock = mockJsonResponse({ text: '自定义区域文字' });
    try {
      const result = await recognizeRegion(store, secrets, documentId, 1, {
        x0: 0.2,
        y0: 0.5,
        x1: 0.5,
        y1: 0.6
      });
      expect(mock.calls()).toBe(1);
      expect(result.engine).toBe('custom');
      expect(result.text).toBe('自定义区域文字');
      expect(mock.body()).toBe(''); // FormData 请求体不是 JSON 字符串
    } finally {
      saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
    }
  });

  it('MinerU 模式回退到已配置的视觉模型，只发送裁出的选区', async () => {
    saveParsingConfig(store, secrets, {
      mode: 'mineru_online',
      allow_remote: true,
      service_key: 'online-token'
    });
    // 清掉旧 vision 模式下残留的 parsing.model，让回退走「模型服务」里的视觉模型。
    store.updateSettings({ 'parsing.model': '' });
    configureVisualService();
    const mock = mockJsonResponse({
      choices: [{ message: { content: 'MINERU-FALLBACK-TEXT' } }]
    });
    try {
      const result = await recognizeRegion(store, secrets, documentId, 1, {
        x0: 0.2,
        y0: 0.2,
        x1: 0.4,
        y1: 0.3
      });
      expect(mock.calls()).toBe(1);
      expect(mock.url()).toContain('https://vision.example.com/v1/chat/completions');
      const body = mock.body();
      expect(body).toContain('"model":"vis-routed-model"');
      expect(body).toContain('只转录选区可见文字');
      const match = body.match(/data:image\/png;base64,([^"]+)/);
      expect(match).toBeTruthy();
      // 只发裁图：400×600 页 ×2 渲染，选区 0.2×0.1 → 160×120，而不是整页 800×1200。
      expect(pngSize(`data:image/png;base64,${match![1]}`)).toEqual({
        width: 160,
        height: 120
      });
      expect(result.engine).toBe('vision');
      expect(result.text).toBe('MINERU-FALLBACK-TEXT');
      // 回退必须可解释：engine 仍是 vision，但来源说明写清「MinerU 不支持框选、本次改用视觉模型、
      // MinerU 没有被调用」，用户据此能确认 MinerU 没参与、也不存在 MinerU 出错。
      expect(result.fallback_from).toBe('mineru_online');
      expect(result.engine_note).toContain('当前整页识别方式是MinerU 在线精准解析');
      expect(result.engine_note).toContain('不支持只识别框选区域');
      expect(result.engine_note).toContain('vis-routed-model');
      expect(result.engine_note).toContain('来自「模型服务」的视觉/全模态绑定');
      expect(result.engine_note).toContain('只发送裁出的选区图片');
      expect(result.engine_note).toContain('MinerU 没有被调用，因此不存在 MinerU 出错');
      expect(rawVisualChunks('MINERU-FALLBACK-TEXT')).toHaveLength(1);
    } finally {
      clearModelServices();
      saveParsingConfig(store, secrets, {
        mode: 'vision',
        model: 'vis-model',
        allow_remote: true
      });
    }
  });

  it('MinerU 模式 + 没有任何视觉模型时给出明确配置指引', async () => {
    saveParsingConfig(store, secrets, {
      mode: 'mineru_online',
      allow_remote: true,
      service_key: 'online-token'
    });
    store.updateSettings({ 'parsing.model': '' });
    clearModelServices();
    try {
      const message = await recognizeRegion(store, secrets, documentId, 1, REGION).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      expect(message).toContain(
        '未配置可用视觉模型：请在设置→识别方式选择视觉模型，或在模型服务为模型勾选视觉/全模态'
      );
      // 用户追问「怎么知道 MinerU 有没有出错」：这里也要直说区域框选没有调用 MinerU。
      expect(message).toContain('区域框选不会调用 MinerU，本次也没有调用 MinerU');
    } finally {
      saveParsingConfig(store, secrets, {
        mode: 'vision',
        model: 'vis-model',
        allow_remote: true
      });
    }
  });

  it('requires an existing document before writing a visual chunk', () => {
    expect(() => store.addVisualChunk('missing-document', 1, 'x', null)).toThrow('文档不存在');
  });
});

function timedOutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

function restoreVisionMode(): void {
  saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
}

function enableOnlineMineru(): void {
  saveParsingConfig(store, secrets, {
    mode: 'mineru_online',
    allow_remote: true,
    service_key: 'online-token'
  });
}

function enableAgentMineru(): void {
  saveParsingConfig(store, secrets, { mode: 'mineru_agent', allow_remote: true });
}

const ONLINE_APPLY_OK = {
  match: '/file-urls/batch',
  json: {
    code: 0,
    data: { batch_id: 'batch-1', file_urls: ['https://upload.mineru.test/page.pdf'] }
  }
} satisfies FetchRule;
const ONLINE_UPLOAD_OK: FetchRule = { match: 'upload.mineru.test', status: 200 };
const AGENT_APPLY_OK = {
  match: '/parse/file',
  json: {
    code: 0,
    data: { task_id: 'task-1', file_url: 'https://upload.mineru.test/page.pdf' }
  }
} satisfies FetchRule;

/**
 * 整页 MinerU 识别失败时的「可核对」文案：
 * 用户要能看出是哪个环节（申请上传/上传/轮询/下载）、HTTP 状态、MinerU 返回的 message、
 * 是超时还是限频，而不是笼统的「识别失败」。
 */
describe('MinerU 整页识别失败原因可见', () => {
  it('在线：HTTP 401 / 403 提示 Token 无效或没有权限，并写入错误日志', async () => {
    enableOnlineMineru();
    mockFetchRules([
      { match: '/file-urls/batch', status: 401, text: '{"code":-1000,"msg":"invalid token"}' }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 在线精准解析申请上传失败：HTTP 401');
      expect(message).toContain('invalid token');
      expect(message).toContain('MinerU Token 无效或没有权限');
      // 诊断日志里能查到这次失败的真实原因（不是只给 UI 看）。
      expect(
        readRecentErrors(dataDir, 50).some(
          (entry) =>
            entry.context.includes('ocr:page:mineru_online') &&
            entry.message.includes('HTTP 401')
        )
      ).toBe(true);
    } finally {
      restoreVisionMode();
    }
  });

  it('在线：HTTP 429 明确说被限频（不笼统失败）', async () => {
    enableOnlineMineru();
    process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS = '0';
    mockFetchRules([
      ONLINE_APPLY_OK,
      ONLINE_UPLOAD_OK,
      { match: '/extract-results/batch/batch-1', status: 429, text: '{"msg":"rate limit"}' }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 在线精准解析查询批次失败：HTTP 429');
      expect(message).toContain('rate limit');
      expect(message).toContain('请求被 MinerU 限频');
    } finally {
      restoreVisionMode();
      delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
    }
  });

  it('在线：批次失败原样带 MinerU 的 message 与错误码', async () => {
    enableOnlineMineru();
    process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS = '0';
    mockFetchRules([
      ONLINE_APPLY_OK,
      ONLINE_UPLOAD_OK,
      {
        match: '/extract-results/batch/batch-1',
        json: {
          code: 0,
          data: { extract_result: [{ state: 'failed', err_msg: 'page too large', err_code: -6001 }] }
        }
      }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 在线精准解析失败：page too large');
      expect(message).toContain('（错误码 -6001）');
    } finally {
      restoreVisionMode();
      delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
    }
  });

  it('在线：结果包下载失败区分「下载」环节与 HTTP 状态', async () => {
    enableOnlineMineru();
    process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS = '0';
    mockFetchRules([
      ONLINE_APPLY_OK,
      ONLINE_UPLOAD_OK,
      {
        match: '/extract-results/batch/batch-1',
        json: {
          code: 0,
          data: {
            extract_result: [{ state: 'done', full_zip_url: 'https://zip.mineru.test/result.zip' }]
          }
        }
      },
      { match: 'zip.mineru.test', status: 500, text: 'upstream error' }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 在线精准解析下载结果包失败：HTTP 500');
      expect(message).toContain('upstream error');
      expect(message).toContain('MinerU 服务端错误');
    } finally {
      restoreVisionMode();
      delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
    }
  });

  it('在线：网络超时说明 120 秒无响应（不吞原因）', async () => {
    enableOnlineMineru();
    mockFetchRules([{ match: '/file-urls/batch', reject: timedOutError() }]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 在线精准解析申请上传超时（120 秒没有响应）');
    } finally {
      restoreVisionMode();
    }
  });

  it('在线：轮询超时说明最后状态与 batch_id', async () => {
    enableOnlineMineru();
    process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS = '0';
    mockFetchRules([
      ONLINE_APPLY_OK,
      ONLINE_UPLOAD_OK,
      {
        match: '/extract-results/batch/batch-1',
        json: { code: 0, data: { extract_result: [{ state: 'running' }] } }
      }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 在线精准解析轮询超时');
      expect(message).toContain('最后状态：running');
      expect(message).toContain('batch_id=batch-1');
    } finally {
      restoreVisionMode();
      delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
    }
  });

  it('Agent：HTTP 500 与 code != 0 都带真实原因', async () => {
    enableAgentMineru();
    mockFetchRules([{ match: '/parse/file', status: 500, text: 'Internal Server Error' }]);
    try {
      expect(await pageRecognitionError()).toContain(
        'MinerU 轻量解析（Agent）申请上传失败：HTTP 500：Internal Server Error'
      );
    } finally {
      restoreVisionMode();
    }

    enableAgentMineru();
    mockFetchRules([
      { match: '/parse/file', json: { code: 10001, msg: 'invalid file' } }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 轻量解析（Agent）申请上传被拒绝：code=10001');
      expect(message).toContain('invalid file');
    } finally {
      restoreVisionMode();
    }
  });

  it('Agent：任务失败带 err_msg 与错误码', async () => {
    enableAgentMineru();
    process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS = '0';
    mockFetchRules([
      AGENT_APPLY_OK,
      ONLINE_UPLOAD_OK,
      {
        match: '/parse/task-1',
        json: { code: 0, data: { state: 'failed', err_msg: 'scan failed', err_code: 500 } }
      }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 轻量解析（Agent）失败：scan failed');
      expect(message).toContain('（错误码 500）');
    } finally {
      restoreVisionMode();
      delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
    }
  });

  it('Agent：Markdown 下载失败区分「下载 Markdown」环节', async () => {
    enableAgentMineru();
    process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS = '0';
    mockFetchRules([
      AGENT_APPLY_OK,
      ONLINE_UPLOAD_OK,
      {
        match: '/parse/task-1',
        json: { code: 0, data: { state: 'done', markdown_url: 'https://md.mineru.test/out.md' } }
      },
      { match: 'md.mineru.test', status: 404, text: 'not found' }
    ]);
    try {
      const message = await pageRecognitionError();
      expect(message).toContain('MinerU 轻量解析（Agent）下载 Markdown 文件失败：HTTP 404');
      expect(message).toContain('not found');
    } finally {
      restoreVisionMode();
      delete process.env.STUDIANDA_MINERU_POLL_INTERVAL_MS;
    }
  });
});
