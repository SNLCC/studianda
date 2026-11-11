import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OCR_LANGUAGES,
  downloadOcrLanguages,
  OCR_LANGUAGE_API_URL,
  OCR_LANGUAGE_BASE_URL,
  OCR_LANGUAGE_CATALOG,
  OCR_LANGUAGE_SOURCE,
  ocrLanguageStatus,
  selectedOcrLanguages
} from '../src/ocr-languages.js';
import { ensureOcrLanguageData } from '../src/ocr.js';
import {
  getParsingConfig,
  ParsingConfigError,
  saveParsingConfig
} from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const secrets = new SecretStore();
const dataDirs: string[] = [];
const stores: Store[] = [];

function newStore(): Store {
  const dir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-langs-'));
  dataDirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  return store;
}

function gzipData(bytes = 150_000): Buffer {
  return gzipSync(Buffer.alloc(bytes, 7));
}

async function waitForJob(store: Store, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const status = ocrLanguageStatus(store);
    if (status.job && !status.job.running) return status;
    if (Date.now() - started > timeoutMs) throw new Error('等待语言包下载任务超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const previousLangPath = process.env.STUDIANDA_OCR_LANG_PATH;
const previousLangs = process.env.STUDIANDA_OCR_LANGS;

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousLangPath === undefined) delete process.env.STUDIANDA_OCR_LANG_PATH;
  else process.env.STUDIANDA_OCR_LANG_PATH = previousLangPath;
  if (previousLangs === undefined) delete process.env.STUDIANDA_OCR_LANGS;
  else process.env.STUDIANDA_OCR_LANGS = previousLangs;
});

afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

describe('OCR 语言包目录与选择', () => {
  it('空目录：内置目录齐全、默认选 eng+chi_sim、installed 全 false', () => {
    const store = newStore();
    const status = ocrLanguageStatus(store);
    expect(status.packs.map((pack) => pack.code)).toEqual([
      'eng',
      'chi_sim',
      'chi_tra',
      'jpn',
      'kor',
      'deu',
      'fra',
      'rus'
    ]);
    expect(status.packs.every((pack) => pack.installed === false)).toBe(true);
    expect(status.packs.every((pack) => pack.bytes === 0)).toBe(true);
    expect(status.selected).toEqual([...DEFAULT_OCR_LANGUAGES]);
    expect(status.job).toBeNull();
    expect(status.dataDir).toContain(path.join('ocr-tessdata', 'langs'));
    expect(status.packs.every((pack) => pack.license.includes('Apache-2.0'))).toBe(true);
    expect(status.packs.every((pack) => pack.source.includes('tessdata_fast'))).toBe(true);
  });

  it('保存 ocr_langs 后 selected 反映设置；未知 code 保存报中文错误', () => {
    const store = newStore();
    saveParsingConfig(store, secrets, { mode: 'local', ocr_langs: ['eng', 'jpn'] });
    expect(selectedOcrLanguages(store)).toEqual(['eng', 'jpn']);
    expect(ocrLanguageStatus(store).selected).toEqual(['eng', 'jpn']);
    expect(getParsingConfig(store, secrets).ocr_langs).toEqual(['eng', 'jpn']);

    expect(() =>
      saveParsingConfig(store, secrets, { ocr_langs: ['eng', 'nope'] })
    ).toThrow(ParsingConfigError);
    try {
      saveParsingConfig(store, secrets, { ocr_langs: ['nope'] });
    } catch (error) {
      expect((error as Error).message).toContain('未知的 OCR 语言包');
      expect((error as Error).message).toContain('nope');
    }
    // 其它模式也允许保存（UI 不必因切模式丢选择），但仅本地模式生效。
    saveParsingConfig(store, secrets, { mode: 'vision', ocr_langs: ['chi_sim'] });
    expect(selectedOcrLanguages(store)).toEqual(['chi_sim']);
  });

  it('STUDIANDA_OCR_LANGS 是兜底：设置优先于 env', () => {
    const store = newStore();
    process.env.STUDIANDA_OCR_LANGS = 'deu';
    expect(selectedOcrLanguages(store)).toEqual(['deu']);
    saveParsingConfig(store, secrets, { mode: 'local', ocr_langs: ['eng'] });
    expect(selectedOcrLanguages(store)).toEqual(['eng']);
  });
});

describe('缺语言数据不自动下载', () => {
  it('缺数据抛中文错误引导去设置里下载，且不发任何网络请求', async () => {
    const store = newStore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    saveParsingConfig(store, secrets, { mode: 'local', ocr_langs: ['eng', 'chi_sim'] });
    await expect(ensureOcrLanguageData(store)).rejects.toThrow(/缺少语言数据：eng、chi_sim/);
    await expect(ensureOcrLanguageData(store)).rejects.toThrow(/设置.*下载语言包/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('STUDIANDA_OCR_LANG_PATH 指向本机 tessdata 时可用（离线兼容）', async () => {
    const store = newStore();
    const langDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-langpath-'));
    dataDirs.push(langDir);
    writeFileSync(path.join(langDir, 'eng.traineddata'), Buffer.alloc(150_000, 1));
    writeFileSync(path.join(langDir, 'chi_sim.traineddata'), Buffer.alloc(150_000, 1));
    process.env.STUDIANDA_OCR_LANG_PATH = langDir;
    await expect(ensureOcrLanguageData(store)).resolves.toBe(langDir);
  });
});

describe('显式下载语言包', () => {
  it('后台下载成功后 installed=true、bytes>0，文件为解压后的合法数据', async () => {
    const store = newStore();
    const fetchMock = vi.fn(async () => new Response(gzipData(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const initial = downloadOcrLanguages(store, ['eng', 'jpn', 'jpn']);
    // 不阻塞请求：立即返回 running=true 的任务，codes 已去重。
    expect(initial.job?.running).toBe(true);
    expect(initial.job?.codes).toEqual(['eng', 'jpn']);
    expect(initial.job?.total).toBe(2);
    const status = await waitForJob(store);
    expect(status.job?.error).toBe('');
    expect(status.job?.done).toBe(2);
    const eng = status.packs.find((pack) => pack.code === 'eng')!;
    const jpn = status.packs.find((pack) => pack.code === 'jpn')!;
    expect(eng.installed).toBe(true);
    expect(eng.bytes).toBeGreaterThan(100_000);
    expect(jpn.installed).toBe(true);
    const target = path.join(status.dataDir, 'eng.traineddata');
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).size).toBe(150_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('部分失败：job.error 写清失败项、已成功项保留、进程不崩', async () => {
    const store = newStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/jpn.traineddata')) {
          return new Response('bad', { status: 500 });
        }
        return new Response(gzipData(), { status: 200 });
      })
    );
    downloadOcrLanguages(store, ['eng', 'jpn']);
    const status = await waitForJob(store);
    expect(status.job?.running).toBe(false);
    expect(status.job?.done).toBe(2);
    expect(status.job?.error).toContain('下载失败');
    expect(status.job?.error).toContain('jpn');
    expect(status.packs.find((pack) => pack.code === 'eng')!.installed).toBe(true);
    expect(status.packs.find((pack) => pack.code === 'jpn')!.installed).toBe(false);
  });

  it('空列表/未知 code 直接中文报错，不启动任务', () => {
    const store = newStore();
    expect(() => downloadOcrLanguages(store, [])).toThrow(/请选择要下载的 OCR 语言包/);
    expect(() => downloadOcrLanguages(store, ['eng', 'nope'])).toThrow(/未知的 OCR 语言包：nope/);
    // 之前的后台任务可能已完成（job.running=false），但这两次报错不应启动新任务。
    expect(ocrLanguageStatus(store).job?.running ?? false).toBe(false);
  });

  it('目录清单与 label 一致（8 种语言都有中文 label）', () => {
    expect(OCR_LANGUAGE_CATALOG).toHaveLength(8);
    expect(OCR_LANGUAGE_CATALOG.every((entry) => entry.label.length > 0)).toBe(true);
    // 来源给官方仓库页；下载用官方 raw / GitHub API，都是 https、同仓库、无第三方镜像。
    expect(OCR_LANGUAGE_SOURCE).toBe('https://github.com/tesseract-ocr/tessdata_fast');
    expect(OCR_LANGUAGE_BASE_URL).toBe(
      'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main'
    );
    expect(OCR_LANGUAGE_API_URL).toBe(
      'https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents'
    );
  });

  it('下载地址是官方 tessdata_fast 的 https raw 路径（仓库/分支/语言代码固定）', async () => {
    const store = newStore();
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(gzipData(), { status: 200 });
      })
    );
    downloadOcrLanguages(store, ['deu', 'rus']);
    await waitForJob(store);
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/deu.traineddata',
      'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/rus.traineddata'
    ]);
    for (const url of urls) {
      // 必须是 https、官方仓库、main 分支、<code>.traineddata；不能退回 http 或第三方镜像。
      expect(url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\/main\/[a-z_]+\.traineddata$/
      );
    }
  });

  it('raw 不可达时回退官方 GitHub Contents API（同仓库同文件、https、raw 媒体类型）', async () => {
    const store = newStore();
    const calls: Array<{ url: string; headers?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), headers: init?.headers });
        if (String(url).startsWith(OCR_LANGUAGE_BASE_URL)) {
          throw new TypeError('fetch failed');
        }
        return new Response(gzipData(), { status: 200 });
      })
    );
    downloadOcrLanguages(store, ['eng']);
    const status = await waitForJob(store);
    expect(status.job?.error).toBe('');
    expect(status.packs.find((pack) => pack.code === 'eng')!.installed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${OCR_LANGUAGE_BASE_URL}/eng.traineddata`);
    expect(calls[1]!.url).toBe(`${OCR_LANGUAGE_API_URL}/eng.traineddata?ref=main`);
    expect(calls[1]!.url).toMatch(
      /^https:\/\/api\.github\.com\/repos\/tesseract-ocr\/tessdata_fast\/contents\/eng\.traineddata\?ref=main$/
    );
    expect((calls[1]!.headers as Record<string, string>).accept).toBe(
      'application/vnd.github.raw'
    );
  });
});
