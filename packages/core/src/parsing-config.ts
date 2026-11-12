import type {
  ParsingCheckResult,
  ParsingConfigRecord,
  ParsingConfigUpdate
} from '@studianda/shared';
import { resolveModelConnection, resolveModelService } from './model-services.js';
import { isOcrLanguageCode, OCR_LANGUAGE_CATALOG } from './ocr-languages.js';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';

export const MINERU_ONLINE_BASE = 'https://mineru.net/api/v4';
export const MINERU_AGENT_BASE = 'https://mineru.net/api/v1/agent';

const MODES = new Set([
  'local',
  'vision',
  'mineru_online',
  'mineru_agent',
  'custom'
]);
const ONLINE_MODELS = new Set(['vlm', 'pipeline']);

const DEFAULTS = {
  mode: 'local',
  connection_id: '',
  model: '',
  service_url: '',
  allow_remote: false,
  mineru_online_model: 'vlm',
  auto_ocr: false
};

export class ParsingConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ParsingConfigError';
    this.status = status;
  }
}

/** 读取设置里的 ocr_langs JSON 数组；坏值/未知 code 一律丢弃（读取侧宽容）。 */
function readOcrLanguages(settings: Record<string, string>): string[] {
  const raw = settings['parsing.ocr_langs'];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => isOcrLanguageCode(value))
      )
    ];
  } catch {
    return [];
  }
}

export function getParsingConfig(
  store: Store,
  secrets: SecretStore
): ParsingConfigRecord {
  const settings = store.getSettings();
  const mode = (settings['parsing.mode'] ?? DEFAULTS.mode) as ParsingConfigRecord['mode'];
  const config: ParsingConfigRecord = {
    mode: MODES.has(mode) ? mode : 'local',
    connection_id: settings['parsing.connection_id'] ?? '',
    model: settings['parsing.model'] ?? '',
    service_url: settings['parsing.service_url'] ?? '',
    allow_remote: settings['parsing.allow_remote'] === 'true',
    mineru_online_model: (settings['parsing.mineru_online_model'] ??
      DEFAULTS.mineru_online_model) as ParsingConfigRecord['mineru_online_model'],
    auto_ocr: settings['parsing.auto_ocr'] === 'true',
    ocr_langs: readOcrLanguages(settings),
    has_key: Boolean(secrets.get('parsing.service_key')?.trim())
  };
  // 旧配置迁移：早期「自定义解析服务」借用平台连接时
  // 只存 connection_id、不存 service_url。读取时解析出地址并清掉连接 id；
  // 只影响读取，不写库——用户下一次保存会自然写成新结构。
  if (config.mode === 'custom' && !config.service_url && config.connection_id) {
    const connection = resolveModelConnection(store, secrets, config.connection_id);
    if (connection?.baseUrl) {
      config.service_url = connection.baseUrl;
      config.connection_id = '';
    }
  }
  return config;
}

export function saveParsingConfig(
  store: Store,
  secrets: SecretStore,
  input: ParsingConfigUpdate
): ParsingConfigRecord {
  const current = getParsingConfig(store, secrets);
  const mode = input.mode ?? current.mode;
  if (!MODES.has(mode)) throw new ParsingConfigError(400, '不支持的页面识别方式');
  const onlineModel = input.mineru_online_model ?? current.mineru_online_model;
  if (!ONLINE_MODELS.has(onlineModel)) throw new ParsingConfigError(400, '不支持的在线解析模型');

  let serviceUrl = (input.service_url ?? current.service_url).trim().replace(/\/+$/, '');
  if (mode === 'mineru_online') serviceUrl = MINERU_ONLINE_BASE;
  if (mode === 'mineru_agent') serviceUrl = MINERU_AGENT_BASE;
  if (mode === 'custom' && !serviceUrl) {
    throw new ParsingConfigError(
      400,
      '请填写自定义解析服务的地址。'
    );
  }
  if (serviceUrl && mode !== 'vision') validateUrl(serviceUrl);

  const key = input.service_key?.trim() ?? '';
  if (key.length > 8192) throw new ParsingConfigError(400, '密钥过长');
  if (mode === 'mineru_online' && !key && !input.clear_service_key) {
    const canKeep = current.mode === 'mineru_online' && current.has_key;
    if (!canKeep) {
      throw new ParsingConfigError(
        400,
        'MinerU 在线精准解析需要一个在 mineru.net 申请的 API Token（Bearer）。Token 只保存在本机并加密。若不想申请 Token，可以改选「轻量解析 Agent」，它无需 Token。'
      );
    }
  }
  if (input.clear_service_key) {
    secrets.clear('parsing.service_key');
  } else if (key) {
    secrets.set('parsing.service_key', key);
  } else if (current.service_url !== serviceUrl) {
    // 地址变了且没有重新提供密钥：旧密钥不再适用。
    secrets.clear('parsing.service_key');
  }

  // 语言包选择：允许任意模式保存（界面不必因模式切换丢失选择），但只有 local
  // （本机 Tesseract）实际生效；未知 code 直接 400，避免写进不存在的语言。
  let ocrLangs = current.ocr_langs ?? [];
  if (input.ocr_langs !== undefined) {
    if (!Array.isArray(input.ocr_langs)) {
      throw new ParsingConfigError(400, 'ocr_langs 必须是数组');
    }
    const normalized = [
      ...new Set(
        input.ocr_langs
          .filter((code): code is string => typeof code === 'string')
          .map((code) => code.trim())
          .filter(Boolean)
      )
    ];
    const unknown = normalized.filter((code) => !isOcrLanguageCode(code));
    if (unknown.length > 0) {
      throw new ParsingConfigError(
        400,
        `未知的 OCR 语言包：${unknown.join('、')}；可选：${OCR_LANGUAGE_CATALOG.map(
          (entry) => entry.code
        ).join('、')}`
      );
    }
    ocrLangs = normalized;
  }

  const settings: Record<string, string> = {
    'parsing.mode': mode,
    'parsing.connection_id': (input.connection_id ?? current.connection_id).trim(),
    'parsing.model': (input.model ?? current.model).trim(),
    'parsing.service_url': serviceUrl,
    'parsing.allow_remote': (input.allow_remote ?? current.allow_remote) ? 'true' : 'false',
    'parsing.mineru_online_model': onlineModel,
    'parsing.auto_ocr': (input.auto_ocr ?? current.auto_ocr) ? 'true' : 'false',
    'parsing.ocr_langs': JSON.stringify(ocrLangs)
  };
  store.updateSettings(settings);
  return getParsingConfig(store, secrets);
}

export interface VisionServiceProfile {
  baseUrl: string;
  apiKey: string;
  source: 'connection' | 'routing' | 'env';
}

/**
 * vision 识别要用的服务地址与密钥。
 *
 * 优先用解析配置里保存的 `connection_id`（就是「模型服务」里那条连接），
 * 其次回退到「会话模型」的 routing，最后只看环境变量覆盖（无界面运行/调试用）。
 * 新式界面的视觉模型下拉只写 `connection_id`+`model`，
 * 所以第一条路径是主路径。
 */
export function resolveVisionProfile(
  store: Store,
  secrets: SecretStore,
  config: ParsingConfigRecord
): VisionServiceProfile | null {
  const connection = resolveModelConnection(store, secrets, config.connection_id);
  if (connection) {
    return {
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      source: 'connection'
    };
  }
  const routed = resolveModelService(store, secrets, 'chat');
  if (routed) {
    return { baseUrl: routed.baseUrl, apiKey: routed.apiKey, source: 'routing' };
  }
  const baseUrl = (process.env.STUDIANDA_MODEL_BASE_URL?.trim() || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: process.env.STUDIANDA_MODEL_API_KEY?.trim() || '',
    source: 'env'
  };
}

export function parsingConfigForUse(
  store: Store,
  secrets: SecretStore
): ParsingConfigRecord {
  const config = getParsingConfig(store, secrets);
  if (config.mode === 'local') return config;
  if (config.mode === 'vision') {
    if (!config.model) throw new ParsingConfigError(400, '请先选择支持图像的识别模型。');
    const profile = resolveVisionProfile(store, secrets, config);
    if (!profile?.baseUrl) {
      throw new ParsingConfigError(400, 'vision 模式需要先配置模型服务地址。');
    }
    if (!config.allow_remote && !isLoopback(profile.baseUrl)) {
      throw new ParsingConfigError(403, '请先在识别设置中允许向所选远程服务发送页面图像。');
    }
    return config;
  }
  if (!config.service_url) {
    throw new ParsingConfigError(400, '请先在识别设置中填写 MinerU / 解析服务的地址。');
  }
  if (!config.allow_remote && !isLoopback(config.service_url)) {
    throw new ParsingConfigError(403, '请先在识别设置中允许向所选远程服务发送页面图像。');
  }
  return config;
}

function validateUrl(value: string): void {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new ParsingConfigError(400, '识别服务地址必须是 http/https URL');
  }
}

function isLoopback(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/** 地址是否本机（区域识别回退视觉模型时用来判断是否触及 allow_remote 隐私开关）。 */
export function isLoopbackUrl(value: string): boolean {
  return isLoopback(value);
}

/** 地址归属层级：只描述可达性（本机/局域网/公网），不评价服务优劣。 */
function serviceTier(value: string): string {
  if (!value) return '';
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '::1' ||
      host === '127.0.0.1' ||
      host.endsWith('.localhost')
    ) {
      return '本机';
    }
    if (
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.lan')
    ) {
      return '局域网';
    }
    return '公网';
  } catch {
    return '';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 识别服务自检（只读）。
 *
 * 不发任何页面内容、不写数据库、不发起网络探测：只根据本机配置回答
 * "地址/模型是否配好、识别时会把页面送到哪里、有没有可用的只读探测"。
 * 出错时返回 ok=false 的结果，而不是让调用方 500。
 */
export function checkParsingService(
  store: Store,
  secrets: SecretStore
): ParsingCheckResult {
  try {
    const config = getParsingConfig(store, secrets);
    if (config.mode === 'local') {
      return {
        mode: config.mode,
        url: '',
        tier: '本机',
        ok: true,
        message: '本机识别不需要服务地址：页面图像只在本机处理，不会发送到远程服务。',
        detail: ['识别方式：本机 Tesseract（eng+chi_sim）', '页面图像：只在本机处理']
      };
    }
    if (config.mode === 'vision') {
      const profile = resolveVisionProfile(store, secrets, config);
      const url = profile?.baseUrl ?? '';
      const tier = serviceTier(url);
      const detail = [`模型：${config.model.trim() || '未选择'}`];
      if (url) detail.push(`地址：${url}`, `服务层级：${tier || '未知'}`);
      if (!config.model.trim()) {
        return {
          mode: config.mode,
          url,
          tier,
          ok: false,
          message: 'vision 模式还没有选择识别模型：请先选择支持图像的识别模型。',
          detail
        };
      }
      if (!profile?.baseUrl) {
        return {
          mode: config.mode,
          url,
          tier,
          ok: false,
          message:
            'vision 模式的识别服务地址无效：请重新选择平台连接，或在模型服务里配置可用的视觉模型地址。',
          detail
        };
      }
      return {
        mode: config.mode,
        url,
        tier,
        ok: true,
        message: `地址可用（${url}）：识别时会把页面图像发送到所选视觉模型。`,
        detail
      };
    }
    if (config.mode === 'custom') {
      const url = config.service_url.trim();
      if (!url) {
        return {
          mode: config.mode,
          url: '',
          tier: '',
          ok: false,
          message: '请先填写自定义解析服务的地址。',
          detail: []
        };
      }
      if (!isHttpUrl(url)) {
        return {
          mode: config.mode,
          url,
          tier: '',
          ok: false,
          message: '识别服务地址必须是 http/https URL。',
          detail: [`填写的是：${url}`]
        };
      }
      const tier = serviceTier(url);
      return {
        mode: config.mode,
        url,
        tier,
        ok: true,
        message: `地址格式可用（${url}）：识别时会把页面图像 POST 到该服务的 /parse。`,
        detail: [`服务层级：${tier || '未知'}`]
      };
    }
    if (config.mode === 'mineru_online') {
      const url = config.service_url.trim() || MINERU_ONLINE_BASE;
      return {
        mode: config.mode,
        url,
        tier: serviceTier(url),
        ok: false,
        message:
          'MinerU 在线精准解析使用官方固定入口（' +
          url +
          '），提交任务前没有可用的只读探测接口，因此无法预先校验 Token——' +
          '整页识别失败时以实际返回的错误为准（HTTP 状态/批次状态/返回 message/超时都会原样提示并写入诊断日志）；' +
          '区域框选识别永远不会调用 MinerU（它只支持整页/整文档解析），会改用本机 OCR 或你配置的视觉模型，结果里会注明来源。' +
          '识别会把这一页作为单页 PDF 上传到 MinerU 的服务器。',
        detail: [
          `地址：${url}`,
          `模型版本：${config.mineru_online_model}`,
          '区域框选：不调用 MinerU（改用本机 OCR/视觉模型，并在结果里注明）'
        ]
      };
    }
    if (config.mode === 'mineru_agent') {
      const url = config.service_url.trim() || MINERU_AGENT_BASE;
      return {
        mode: config.mode,
        url,
        tier: serviceTier(url),
        ok: false,
        message:
          'MinerU 轻量解析（Agent）使用官方固定入口（' +
          url +
          '），提交任务前没有可用的只读探测接口，因此无法预先校验——' +
          '整页识别失败时以实际返回的错误为准（HTTP 状态/任务状态/返回 message/超时/限频都会原样提示并写入诊断日志）；' +
          '区域框选识别永远不会调用 MinerU（它只支持整页/整文档解析），会改用本机 OCR 或你配置的视觉模型，结果里会注明来源。' +
          '识别会把这一页作为单页 PDF 上传到 MinerU 的服务器。',
        detail: [
          `地址：${url}`,
          '区域框选：不调用 MinerU（改用本机 OCR/视觉模型，并在结果里注明）'
        ]
      };
    }
    return {
      mode: config.mode,
      url: config.service_url,
      tier: '',
      ok: false,
      message: '未知识别方式，无法自检。',
      detail: []
    };
  } catch (error) {
    return {
      mode: '',
      url: '',
      tier: '',
      ok: false,
      message: `识别服务自检失败：${error instanceof Error ? error.message : '未知错误'}`,
      detail: []
    };
  }
}
