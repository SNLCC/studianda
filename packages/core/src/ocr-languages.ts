/**
 * 本机 Tesseract OCR 语言包管理（目录 / 安装状态 / 显式下载 / 当前选择）。
 *
 * 设计纪律（用户已决定）：
 * 1. **绝不自动下载**：只有用户点「下载语言包」才联网；识别时缺数据只返回中文错误引导。
 * 2. 来源只用官方 `tesseract-ocr/tessdata_fast`（Apache-2.0），不用第三方镜像当默认。
 * 3. 下载写到 `<dataDir>/ocr-tessdata/langs/<code>.traineddata`，先写临时文件再 rename，
 *    避免半包被当成已安装；最多 1 个后台任务，重复请求返回当前任务。
 */
import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type {
  OcrLanguageJob,
  OcrLanguagePack,
  OcrLanguageStatus
} from '@studianda/shared';
import type { Store } from './store.js';

/** 官方语言数据仓库（tessdata_fast，Apache-2.0）。 */
export const OCR_LANGUAGE_BASE_URL =
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main';
/** 官方仓库页（用于界面/文档展示“来源”，下载走上面的 raw 或下面的 GitHub API）。 */
export const OCR_LANGUAGE_SOURCE = 'https://github.com/tesseract-ocr/tessdata_fast';
/**
 * 备用下载地址：GitHub 官方 Contents API（`Accept: application/vnd.github.raw`）。
 *
 * 为什么需要它：真实环境里 `raw.githubusercontent.com` 可能被网络阻断（本机实测
 * `fetch failed`），而 `api.github.com` 仍可达。两者都是 GitHub 官方、HTTPS、
 * 同一仓库/同一文件，不是第三方镜像；API 未认证时有速率限制（每小时 60 次），
 * 只用于少数语言包下载，失败会如实报错。
 */
export const OCR_LANGUAGE_API_URL =
  'https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents';
export const OCR_LANGUAGE_LICENSE = 'Apache-2.0（tessdata_fast 仓库 LICENSE）';
/** 安装判定阈值：小于 100KB 视为未装/半包。 */
export const OCR_LANGUAGE_MIN_BYTES = 100_000;
/** 未配置选择时的默认语言（与旧行为一致）。 */
export const DEFAULT_OCR_LANGUAGES = ['eng', 'chi_sim'] as const;

interface CatalogEntry {
  code: string;
  label: string;
}

/** 内置目录（按界面展示顺序）。 */
export const OCR_LANGUAGE_CATALOG: readonly CatalogEntry[] = [
  { code: 'eng', label: '英文' },
  { code: 'chi_sim', label: '简体中文' },
  { code: 'chi_tra', label: '繁体中文' },
  { code: 'jpn', label: '日文' },
  { code: 'kor', label: '韩文' },
  { code: 'deu', label: '德文' },
  { code: 'fra', label: '法文' },
  { code: 'rus', label: '俄文' }
];

const CATALOG_CODES = new Set(OCR_LANGUAGE_CATALOG.map((entry) => entry.code));

export function isOcrLanguageCode(code: string): boolean {
  return CATALOG_CODES.has(code);
}

/** 语言包实际存放目录（`<dataDir>/ocr-tessdata/langs`）。 */
export function ocrLanguagesDir(store: Store): string {
  return path.join(store.dataDir, 'ocr-tessdata', 'langs');
}

function packPath(store: Store, code: string): string {
  return path.join(ocrLanguagesDir(store), `${code}.traineddata`);
}

/** 读取设置里的 ocr_langs（JSON 数组）；空/坏值返回空数组，由调用方回退。 */
function configuredOcrLanguages(store: Store): string[] {
  const raw = store.getSettings()['parsing.ocr_langs'];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      )
    ];
  } catch {
    return [];
  }
}

/**
 * 当前选用的语言包 code（设置优先、环境变量兜底、最后默认 eng+chi_sim）。
 *
 * `STUDIANDA_OCR_LANGS` 是高级覆盖：用于只读某语言的离线环境；用户一旦在设置里选了
 * 语言包，就以设置为准（避免环境变量悄悄改掉用户的选择）。
 */
export function selectedOcrLanguages(store: Store): string[] {
  const configured = configuredOcrLanguages(store);
  if (configured.length > 0) return configured;
  const env = process.env.STUDIANDA_OCR_LANGS?.trim();
  if (env) {
    const langs = env
      .split(/[+,]/)
      .map((lang) => lang.trim())
      .filter(Boolean);
    if (langs.length > 0) return [...new Set(langs)];
  }
  return [...DEFAULT_OCR_LANGUAGES];
}

function packStatus(store: Store, entry: CatalogEntry): OcrLanguagePack {
  const target = packPath(store, entry.code);
  let bytes = 0;
  let installed = false;
  try {
    if (existsSync(target)) {
      bytes = statSync(target).size;
      installed = bytes >= OCR_LANGUAGE_MIN_BYTES;
    }
  } catch {
    // 读不到就当未安装；不阻断状态查询。
  }
  return {
    code: entry.code,
    label: entry.label,
    installed,
    bytes,
    source: OCR_LANGUAGE_SOURCE,
    license: OCR_LANGUAGE_LICENSE
  };
}

/** 后台下载任务（同一时间最多一个；完成后保留最后一次结果供界面展示）。 */
let activeJob: OcrLanguageJob | null = null;

export function ocrLanguageStatus(store: Store): OcrLanguageStatus {
  return {
    packs: OCR_LANGUAGE_CATALOG.map((entry) => packStatus(store, entry)),
    selected: selectedOcrLanguages(store),
    job: activeJob ? { ...activeJob, codes: [...activeJob.codes] } : null,
    dataDir: ocrLanguagesDir(store)
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

/** 把一份 `.traineddata`（可能是 gzip 压缩流）原子写入目标路径。 */
function installLanguageData(target: string, payload: Buffer): void {
  const data =
    payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b
      ? gunzipSync(payload)
      : payload;
  if (data.length < OCR_LANGUAGE_MIN_BYTES) {
    throw new Error('语言数据不完整（小于 100KB）');
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, data);
    renameSync(temp, target);
  } finally {
    // rename 成功后临时文件已不存在；失败时清理，避免残留半包。
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // 清理失败不影响主流程。
    }
  }
}

/** 一个语言包的下载候选：先官方 raw（标准/最快），不可达再走官方 GitHub API。 */
function downloadSources(code: string): Array<{
  url: string;
  headers?: Record<string, string>;
}> {
  return [
    { url: `${OCR_LANGUAGE_BASE_URL}/${code}.traineddata` },
    {
      url: `${OCR_LANGUAGE_API_URL}/${code}.traineddata?ref=main`,
      headers: {
        accept: 'application/vnd.github.raw',
        'user-agent': 'Studianda'
      }
    }
  ];
}

async function downloadOne(store: Store, code: string): Promise<void> {
  const target = packPath(store, code);
  if (existsSync(target) && statSync(target).size >= OCR_LANGUAGE_MIN_BYTES) return;
  const failures: string[] = [];
  for (const source of downloadSources(code)) {
    try {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(180_000),
        ...(source.headers ? { headers: source.headers } : {})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = Buffer.from(await response.arrayBuffer());
      installLanguageData(target, payload);
      return;
    } catch (error) {
      failures.push(`${source.url}：${errorText(error)}`);
    }
  }
  throw new Error(failures.join('；'));
}

/** 后台逐个下载；单项失败写进 job.error 但保留已成功的包，继续尝试其它项。 */
async function runDownloadJob(store: Store, job: OcrLanguageJob): Promise<void> {
  const failures: string[] = [];
  try {
    for (const code of job.codes) {
      try {
        await downloadOne(store, code);
      } catch (error) {
        failures.push(`${code}（${errorText(error)}）`);
      }
      job.done += 1;
    }
  } finally {
    job.error =
      failures.length > 0
        ? `语言包下载失败：${failures.join('、')}；已成功的语言包保留，可稍后重试。`
        : '';
    job.running = false;
  }
}

/**
 * 显式下载语言包（用户点按钮才调用）：**立即返回**当前状态，下载在后台继续。
 *
 * - codes 必须非空、属于内置目录；重复调用时若已有任务在跑，直接返回当前任务；
 * - 已安装（>100KB）的 code 直接计入 done，不重复联网；
 * - 单项失败不清除已成功项，error 里写清失败 code 与原因。
 */
export function downloadOcrLanguages(store: Store, codes: string[]): OcrLanguageStatus {
  const requested = [
    ...new Set(
      (codes ?? [])
        .filter((code): code is string => typeof code === 'string')
        .map((code) => code.trim())
        .filter(Boolean)
    )
  ];
  if (requested.length === 0) throw new Error('请选择要下载的 OCR 语言包');
  const unknown = requested.filter((code) => !CATALOG_CODES.has(code));
  if (unknown.length > 0) {
    throw new Error(`未知的 OCR 语言包：${unknown.join('、')}`);
  }
  if (activeJob?.running) return ocrLanguageStatus(store);
  const job: OcrLanguageJob = {
    running: true,
    codes: requested,
    done: 0,
    total: requested.length,
    error: ''
  };
  activeJob = job;
  // 不阻塞 HTTP 请求：状态先返回 job.running=true，界面轮询 ocrLanguageStatus。
  void runDownloadJob(store, job).catch((error) => {
    job.error = `语言包下载失败：${errorText(error)}；已成功的语言包保留，可稍后重试。`;
    job.running = false;
  });
  return ocrLanguageStatus(store);
}
