import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorkerMock = vi.fn();
vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args)
}));

import { recognizePage } from '../src/ocr.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 真实 E2E 踩过的缺陷：tesseract 语言数据下载失败时（默认 jsdelivr 在部分网络不可达、
 * 且真实环境里 worker 线程内 fetch 不可靠），没有 errorHandler 的 createWorker 会在
 * worker 里 throw 未捕获异常，**整个核心进程退出**。这里固定住：
 * 1) 语言数据由主线程落到本地目录，worker 只读本地文件（langPath + gzip:false）；
 * 2) 加载失败转成中文错误且不崩；失败后缓存清空、下一次可以重试。
 */

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ??
  path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-engine-'));
const langDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-langs-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const previousLangPath = process.env.STUDIANDA_OCR_LANG_PATH;
let documentId = '';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(langDir, { recursive: true, force: true });
  if (previousLangPath === undefined) delete process.env.STUDIANDA_OCR_LANG_PATH;
  else process.env.STUDIANDA_OCR_LANG_PATH = previousLangPath;
});

afterEach(() => {
  createWorkerMock.mockReset();
});

beforeEach(async () => {
  // 用本地假语言数据避免测试联网；大小阈值要求 >100KB。
  for (const lang of ['eng', 'chi_sim']) {
    writeFileSync(path.join(langDir, `${lang}.traineddata`), Buffer.alloc(200_000, 1));
  }
  process.env.STUDIANDA_OCR_LANG_PATH = langDir;
  if (!documentId) {
    const document = await store.importDocument(TEST_PDF, undefined, true);
    documentId = document.id;
  }
  saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: false });
});

describe('本机 OCR 引擎失败处理', () => {
  it('加载失败返回中文错误；worker 只读本地语言数据并带 errorHandler', async () => {
    createWorkerMock.mockRejectedValue(new Error('TypeError: fetch failed'));
    await expect(recognizePage(store, secrets, documentId, 1, 2)).rejects.toThrow(
      /本机 OCR (识别|初始化)失败.*fetch failed/s
    );
    expect(createWorkerMock).toHaveBeenCalled();
    const options = createWorkerMock.mock.calls[0]![2] as {
      langPath?: string;
      gzip?: boolean;
      errorHandler?: unknown;
    };
    // 语言数据由主线程准备，worker 不再联网（真实环境 worker fetch 不可靠）。
    expect(options.langPath).toBe(langDir);
    expect(options.gzip).toBe(false);
    expect(typeof options.errorHandler).toBe('function');
  });

  it('失败不缓存坏引擎：下一次识别可以成功', async () => {
    createWorkerMock.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(recognizePage(store, secrets, documentId, 1, 2)).rejects.toThrow(
      /本机 OCR (识别|初始化)失败/
    );

    const recognize = vi.fn().mockResolvedValue({
      data: {
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    text: 'Sample scanned line',
                    bbox: { x0: 10, y0: 20, x1: 200, y1: 40 }
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    createWorkerMock.mockResolvedValue({ recognize });
    const result = await recognizePage(store, secrets, documentId, 1, 2);
    expect(result.text).toContain('Sample scanned line');
    expect(result.engine).toBe('tesseract.js:eng+chi_sim');
    expect(store.getPageEdit(documentId, 1)?.origin).toBe('ocr');
  }, 120_000);
});
