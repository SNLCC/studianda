import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import type {
  ZoteroAnnotationImportReport,
  ZoteroCollection,
  ZoteroConfigRecord,
  ZoteroItem,
  ZoteroNoteImportItem,
  ZoteroProbeResult
} from '@studianda/shared';
import {
  MAX_ZOTERO_IMPORT,
  NOTE_REPORT_PREVIEW,
  mapZoteroAnnotation,
  mapZoteroNote,
  normalizeZoteroRects,
  zoteroAttachmentKey,
  zoteroPositionData,
  type ZoteroAnnotationCandidate,
  type ZoteroNoteCandidate,
  type ZoteroPageGeometry
} from './zotero-annotations.js';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';

const LOCAL_BASE = 'http://127.0.0.1:23119/api';
const CLOUD_BASE = 'https://api.zotero.org';
const DEFAULT_WEBDAV = 'https://dav.jianguoyun.com/dav/zotero';

export function getZoteroConfig(
  store: Store,
  secrets: SecretStore
): ZoteroConfigRecord {
  const settings = store.getSettings();
  const mode = settings['zotero.mode'];
  return {
    mode: mode === 'cloud' || mode === 'webdav' ? mode : 'local',
    library_type: settings['zotero.library_type'] === 'groups' ? 'groups' : 'users',
    library_id: settings['zotero.library_id'] ?? '0',
    webdav_url: settings['zotero.webdav_url'] ?? DEFAULT_WEBDAV,
    webdav_user: settings['zotero.webdav_user'] ?? '',
    has_key: Boolean(secrets.get('zotero.api_key')?.trim()),
    has_password: Boolean(secrets.get('zotero.webdav_password')?.trim())
  };
}

export function saveZoteroConfig(
  store: Store,
  secrets: SecretStore,
  input: Partial<ZoteroConfigRecord> & {
    api_key?: string;
    clear_key?: boolean;
    webdav_password?: string;
    clear_password?: boolean;
  }
): ZoteroConfigRecord {
  const current = getZoteroConfig(store, secrets);
  const mode = input.mode ?? current.mode;
  const libraryType = input.library_type ?? current.library_type;
  const libraryId = (input.library_id ?? current.library_id).trim();
  const webdavUrl = (input.webdav_url ?? current.webdav_url).trim().replace(/\/+$/, '');
  const webdavUser = (input.webdav_user ?? current.webdav_user).trim();
  if (!['local', 'cloud', 'webdav'].includes(mode)) throw new Error('不支持的 Zotero 模式');
  if (!['users', 'groups'].includes(libraryType)) throw new Error('不支持的资料库类型');
  if (!/^\d{1,20}$/.test(libraryId)) throw new Error('资料库 ID 必须是数字');
  if (mode !== 'local' && libraryId === '0') {
    throw new Error('云端模式请填写 Zotero 用户或群组的数字 ID');
  }
  if (mode === 'webdav') {
    if (libraryType !== 'users') throw new Error('Zotero WebDAV 附件仅支持个人资料库');
    try {
      const url = new URL(webdavUrl);
      if (url.protocol !== 'https:') throw new Error();
    } catch {
      throw new Error('WebDAV 地址必须使用 HTTPS');
    }
  }
  if (input.clear_key) {
    secrets.clear('zotero.api_key');
  } else if (input.api_key?.trim()) {
    secrets.set('zotero.api_key', input.api_key.trim());
  }
  if (input.clear_password) {
    secrets.clear('zotero.webdav_password');
  } else if (input.webdav_password?.trim()) {
    secrets.set('zotero.webdav_password', input.webdav_password.trim());
  }
  store.updateSettings({
    'zotero.mode': mode,
    'zotero.library_type': libraryType,
    'zotero.library_id': libraryId,
    'zotero.webdav_url': webdavUrl,
    'zotero.webdav_user': webdavUser
  });
  return getZoteroConfig(store, secrets);
}

/** 按「连接方式 + HTTP 状态」给可执行说明。 */
export function zoteroFailureMessage(status: number, mode: string): string {
  if (mode === 'local') {
    if (status === 403) {
      return '本机 Zotero 拒绝了这次读取（HTTP 403）。请在 Zotero 的「设置 → 高级 → 其他」里勾选允许其他应用与 Zotero 通信。';
    }
    if (status === 404) {
      return '本机 Zotero 里没有这个文献库（HTTP 404）。请确认文献库 ID 应为 0。';
    }
    return `本机 Zotero 返回 HTTP ${status}；请查看 Zotero 客户端日志。`;
  }
  if (status === 403) {
    return 'Zotero 云端拒绝了本次读取（HTTP 403）：API Key 无效、已被删除，或这个密钥没有该文献库的读取权限。请在 zotero.org 的 API Keys 页面确认已勾选个人库/群组库读取权限后重试。';
  }
  if (status === 404) {
    return 'Zotero 云端找不到这个文献库（HTTP 404）：需要填对数字用户 ID 或群组 ID。请到「诊断连接」核对 API Key 对应的数字 ID。';
  }
  if (status === 412 || status === 428) {
    return `Zotero 云端要求满足校验版本（HTTP ${status}），请稍后重试。`;
  }
  if (status === 429) {
    return 'Zotero 云端限流（HTTP 429），请稍后重试，并减少同时进行的读取。';
  }
  if (status >= 500) {
    return `Zotero 云端暂时不可用（HTTP ${status}），请稍后重试。`;
  }
  return `Zotero 云端返回 HTTP ${status}。`;
}

/** 网络层错误说明。 */
export function zoteroNetworkMessage(mode: string): string {
  return mode === 'local'
    ? '连接不上本机 Zotero（http://localhost:23119）。请确认 Zotero 已启动，并在设置里允许其他应用与 Zotero 通信。'
    : '连接不上 api.zotero.org。请检查网络、代理或防火墙设置。';
}

async function zoteroRequest(
  store: Store,
  secrets: SecretStore,
  path: string,
  params: Record<string, string>,
  overrideLocalBase?: string
): Promise<unknown> {
  const config = getZoteroConfig(store, secrets);
  const key = secrets.get('zotero.api_key')?.trim() ?? '';
  const base =
    config.mode === 'local'
      ? `${(overrideLocalBase ?? LOCAL_BASE).replace(/\/+$/, "")}/${config.library_type}/${config.library_id || "0"}`
      : `${CLOUD_BASE}/${config.library_type}/${config.library_id}`;
  if (config.mode !== 'local' && !key) throw new Error('云端模式需要先保存 Zotero API Key');
  const query = new URLSearchParams(params).toString();
  let response: Response;
  try {
    response = await fetch(`${base}${path}?${query}`, {
      headers: {
        'Zotero-API-Version': '3',
        ...(config.mode !== 'local' ? { 'Zotero-API-Key': key } : {})
      },
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new Error(zoteroNetworkMessage(config.mode));
  }
  if (!response.ok) {
    throw new Error(zoteroFailureMessage(response.status, config.mode));
  }
  return response.json();
}

export async function listZoteroCollections(
  store: Store,
  secrets: SecretStore,
  overrideLocalBase?: string
): Promise<ZoteroCollection[]> {
  const payload = (await zoteroRequest(
    store,
    secrets,
    '/collections',
    { format: 'json', limit: '100' },
    overrideLocalBase
  )) as Array<{ key?: string; data?: { name?: string; parentCollection?: string } }>;
  return (Array.isArray(payload) ? payload : []).map((row) => ({
    key: String(row.key ?? ''),
    name: String(row.data?.name ?? '未命名分类'),
    parentCollection: String(row.data?.parentCollection ?? '')
  }));
}

/**
 * 列出 Zotero 顶层条目（分页 25 条）。
 *
 * `q` 是 Zotero 自己的快速搜索：默认 qmode=titleCreatorYear，**匹配标题、作者与年份**，
 * 不是只匹配标题；界面输入框的说明必须与之一致。
 *
 * 兼容性：历史调用把 `overrideLocalBase` 放在第 5 个参数（测试里会显式传本地 mock 地址），
 * 因此这里做一次向后兼容判断——第 5 个参数如果是 http(s) URL，就把它当成 overrideLocalBase，
 * 而不是搜索词。
 */
export async function listZoteroItems(
  store: Store,
  secrets: SecretStore,
  collection = '',
  start = 0,
  q = '',
  overrideLocalBase?: string
): Promise<ZoteroItem[]> {
  let query = q;
  let localBase = overrideLocalBase;
  if (localBase === undefined && /^https?:\/\//i.test(query)) {
    localBase = query;
    query = '';
  }
  const path = collection
    ? `/collections/${encodeURIComponent(collection)}/items/top`
    : '/items/top';
  const params: Record<string, string> = {
    format: 'json',
    limit: '25',
    start: String(Math.max(0, Number.isFinite(start) ? start : 0))
  };
  const search = query.trim().slice(0, 500);
  if (search) params.q = search;
  const payload = (await zoteroRequest(
    store,
    secrets,
    path,
    params,
    localBase
  )) as Array<{ key?: string; data?: Record<string, unknown> }>;
  return (Array.isArray(payload) ? payload : []).map((row) => {
    const data = row.data ?? {};
    const creators = Array.isArray(data.creators)
      ? (data.creators as Array<Record<string, unknown>>)
          .map((creator) =>
            String(
              creator.name ??
                [creator.firstName, creator.lastName].filter(Boolean).join(' ')
            )
          )
          .filter(Boolean)
          .join(', ')
      : '';
    return {
      key: String(row.key ?? ''),
      title: String(data.title ?? '未命名条目'),
      creators,
      publication: String(data.publicationTitle ?? data.bookTitle ?? data.publisher ?? ''),
      date: String(data.date ?? ''),
      itemType: String(data.itemType ?? '')
    };
  });
}

export interface ZoteroAttachment {
  itemKey: string;
  title: string;
  author: string;
  publication: string;
  doi: string;
  /**
   * 父条目的 Zotero itemType 原文（book / journalArticle / thesis / …）。
   *
   * 独立附件、父条目不存在或读取失败时为空串；不翻译、不裁剪，保持 Zotero 原值，
   * 分类由 shared 的 `documentCategoryOf` 统一计算。
   */
  docType: string;
  /** 稳定身份：`mode:library_type:library_id:server_id:item_key[:path]`。 */
  identity: string;
  /** 旧版身份（不含 Server-ID / 路径），用于兼容升级前的 external_key。 */
  legacyIdentity?: string;
  externalPath?: string;
  bytes?: Uint8Array;
}

/** `identity`：`mode:library_type:library_id:Zotero-Server-ID:item_key`。 */
function attachmentIdentity(
  config: { mode: string; library_type: string; library_id: string },
  serverId: string,
  itemKey: string,
  filePath?: string
): string {
  const base = `${config.mode}:${config.library_type}:${config.library_id}:${serverId || 'legacy'}:${itemKey}`;
  return filePath ? `${base}:${filePath}` : base;
}

/** 旧版身份（无 Server-ID、无路径），仅用于读取升级前的 external_key。 */
function legacyAttachmentIdentity(
  config: { mode: string; library_type: string; library_id: string },
  itemKey: string,
  filePath?: string
): string {
  const base = `${config.mode}:${config.library_type}:${config.library_id}:${itemKey}`;
  return filePath ? `${base}:${filePath}` : base;
}

function doiOf(data: Record<string, unknown>): string {
  return String(data.DOI ?? data.doi ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;:)\]}。]+$/g, '')
    .toLowerCase();
}

function publicationOf(data: Record<string, unknown>): string {
  return String(
    data.publicationTitle ?? data.bookTitle ?? data.publisher ?? data.conferenceName ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function creatorsAuthor(data: Record<string, unknown>): string {
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const names: string[] = [];
  for (const raw of creators) {
    if (!raw || typeof raw !== 'object') continue;
    const creator = raw as Record<string, unknown>;
    if (creator.creatorType !== 'author') continue;
    const name = [creator.firstName, creator.lastName]
      .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
      .join(' ')
      .trim();
    const fallback = typeof creator.name === 'string' ? creator.name.trim() : '';
    if (name || fallback) names.push(name || fallback);
  }
  return names.join('、').slice(0, 200);
}

interface WebdavZipEntry {
  rawName: string;
  name: string;
  originalSize: number;
}

/** 解开 Zotero WebDAV zip 里的 `%ZB64` 文件名；坏编码返回 null（跳过该条目）。 */
function decodeWebdavEntryName(rawName: string): string | null {
  let name = rawName;
  if (name.endsWith('%ZB64')) {
    try {
      name = Buffer.from(name.slice(0, -5), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return name.replace(/\\/g, '/');
}

function basenameOf(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

/**
 * 按请求的 filename 唯一匹配 PDF：
 * 全名或 basename 任一匹配；匹配不到时才在"只有 1 个 PDF"时回退；
 * 多 PDF 且无法唯一匹配就报错，**不取第一个**。
 */
function selectWebdavPdf(entries: WebdavZipEntry[], filename: string): WebdavZipEntry {
  const requested = String(filename ?? '').trim();
  const requestedBase = basenameOf(requested);
  const matches = requested
    ? entries.filter(
        (entry) =>
          entry.name === requested ||
          basenameOf(entry.name) === requested ||
          basenameOf(entry.name) === requestedBase
      )
    : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0 && entries.length === 1) return entries[0]!;
  throw new Error('WebDAV 压缩附件中无法唯一定位 PDF');
}

/**
 * 从 WebDAV 下载的 zip 里取出唯一 PDF：
 * 第一遍只读 zip 中央目录（不解压）拿到文件名与原始大小，按文件名唯一匹配并用
 * `file_size>100MB` 提前拒绝，第二遍只解压选中的那一个条目。
 */
function extractWebdavPdf(archiveBytes: Uint8Array, filename: string): Uint8Array {
  const entries: WebdavZipEntry[] = [];
  unzipSync(archiveBytes, {
    filter: (file) => {
      const name = decodeWebdavEntryName(file.name);
      if (name && name.toLowerCase().endsWith('.pdf')) {
        entries.push({
          rawName: file.name,
          name,
          originalSize: Number(file.originalSize) || 0
        });
      }
      return false;
    }
  });
  if (entries.length === 0) throw new Error('WebDAV 附件包里没有 PDF');
  const selected = selectWebdavPdf(entries, filename);
  const extracted = unzipSync(archiveBytes, {
    filter: (file) => file.name === selected.rawName
  });
  const bytes = extracted[selected.rawName];
  if (!bytes) throw new Error('WebDAV 压缩包解压失败');
  return bytes;
}

export async function zoteroAttachment(
  store: Store,
  secrets: SecretStore,
  itemKey: string,
  overrideLocalBase?: string,
  overrideCloudBase?: string
): Promise<ZoteroAttachment> {
  if (!/^[A-Z0-9]{8}$/.test(itemKey)) throw new Error('Zotero 条目标识无效');
  const config = getZoteroConfig(store, secrets);
  const key = secrets.get('zotero.api_key')?.trim() ?? '';
  const base =
    config.mode === 'local'
      ? `${(overrideLocalBase ?? LOCAL_BASE).replace(/\/+$/, "")}/${config.library_type}/${config.library_id || "0"}`
      : `${overrideCloudBase ?? CLOUD_BASE}/${config.library_type}/${config.library_id}`;
  const headers = {
    'Zotero-API-Version': '3',
    ...(config.mode !== 'local' ? { 'Zotero-API-Key': key } : {})
  } as Record<string, string>;
  const itemResponse = await fetch(`${base}/items/${itemKey}?format=json`, {
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  if (!itemResponse.ok) throw new Error(`Zotero 条目返回 HTTP ${itemResponse.status}`);
  // Zotero-Server-ID 用于区分"同一个 item key 出现在不同服务器/库"的情况；
  // 没有该响应头时用 legacy，保证同一附件多次打开 identity 稳定。
  const serverId = itemResponse.headers.get('zotero-server-id') ?? 'legacy';
  const item = (await itemResponse.json()) as { data?: Record<string, unknown> };
  let data = item.data ?? {};
  if (data.itemType !== 'attachment' || data.contentType !== 'application/pdf') {
    const childrenResponse = await fetch(
      `${base}/items/${itemKey}/children?format=json&limit=100`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );
    if (!childrenResponse.ok) throw new Error(`Zotero 子条目返回 HTTP ${childrenResponse.status}`);
    const children = (await childrenResponse.json()) as Array<{
      key?: string;
      data?: Record<string, unknown>;
    }>;
    const pdf = children.find(
      (child) =>
        child.data?.itemType === 'attachment' &&
        (child.data?.contentType === 'application/pdf' ||
          String(child.data?.filename ?? '').toLowerCase().endsWith('.pdf'))
    );
    if (!pdf?.key) throw new Error('这个 Zotero 条目没有可读取的 PDF 附件');
    itemKey = pdf.key;
    data = pdf.data ?? {};
  }
  let title = String(data.title ?? data.filename ?? itemKey);
  let author = '';
  let publication = publicationOf(data);
  let doi = doiOf(data);
  // 父条目 data.itemType 就是「文献类型」：图书/期刊论文/学位论文… 都用 Zotero 原值。
  // 独立附件没有父条目，保持空串（未分类），绝不拿 attachment 当文献类型。
  let docType = '';
  if (typeof data.parentItem === 'string' && data.parentItem) {
    const parentResponse = await fetch(
      `${base}/items/${data.parentItem}?format=json`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );
    if (parentResponse.ok) {
      const parent = (await parentResponse.json()) as { data?: Record<string, unknown> };
      title = String(parent.data?.title ?? title);
      author = creatorsAuthor(parent.data ?? {});
      publication = publicationOf(parent.data ?? {}) || publication;
      doi = doiOf(parent.data ?? {}) || doi;
      docType = String(parent.data?.itemType ?? '').trim();
    }
  }
  if (config.mode === 'webdav') {
    const password = secrets.get('zotero.webdav_password')?.trim() ?? '';
    if (!config.webdav_user || !password) {
      throw new Error('请配置 WebDAV 账号与应用密码');
    }
    const auth = Buffer.from(`${config.webdav_user}:${password}`).toString('base64');
    const response = await fetch(
      `${config.webdav_url.replace(/\/+$/, '')}/${encodeURIComponent(itemKey)}.zip`,
      {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(600_000)
      }
    );
    if (!response.ok) throw new Error(`WebDAV 附件下载返回 HTTP ${response.status}`);
    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    // 附件包可能含多份 PDF：按请求附件文件名唯一匹配；解压前用 zip 条目
    // 原始大小检查 100MB。
    const bytes = extractWebdavPdf(archiveBytes, String(data.filename ?? ''));
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      throw new Error('WebDAV 附件不是 PDF');
    }
    return {
      itemKey,
      title,
      author,
      publication,
      doi,
      docType,
      identity: attachmentIdentity(config, serverId, itemKey),
      legacyIdentity: legacyAttachmentIdentity(config, itemKey),
      bytes
    };
  }
  if (config.mode === 'local') {
    const fileResponse = await fetch(`${base}/items/${itemKey}/file`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000)
    });
    const location = fileResponse.headers.get('location') ?? '';
    if (!location.startsWith('file:')) {
      throw new Error('附件尚未下载到本机，请先在 Zotero 打开附件完成同步');
    }
    const filePath = fileURLToPath(location);
    if (!filePath.toLowerCase().endsWith('.pdf')) throw new Error('Zotero 附件不是 PDF');
    return {
      itemKey,
      title,
      author,
      publication,
      doi,
      docType,
      identity: attachmentIdentity(config, serverId, itemKey, filePath),
      legacyIdentity: legacyAttachmentIdentity(config, itemKey, filePath),
      externalPath: filePath
    };
  }
  if (!key) throw new Error('云端模式需要先保存 Zotero API Key');
  let response: Response;
  try {
    response = await fetch(`${base}/items/${itemKey}/file`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(600_000)
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new Error(zoteroNetworkMessage(config.mode));
  }
  if (response.status === 302) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Zotero 没有返回附件地址');
    if (!location.startsWith('https://')) {
      throw new Error('Zotero 附件下载地址必须是 HTTPS，已拒绝这次下载。');
    }
    try {
      response = await fetch(location, { signal: AbortSignal.timeout(600_000) });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
      throw new Error(zoteroNetworkMessage(config.mode));
    }
  }
  if (!response.ok) throw new Error(`Zotero 附件下载返回 HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new Error('Zotero 返回内容不是 PDF');
  }
  return {
    itemKey,
    title,
    author,
    publication,
    doi,
    docType,
    identity: attachmentIdentity(config, serverId, itemKey),
    legacyIdentity: legacyAttachmentIdentity(config, itemKey),
    bytes
  };
}

/**
 * 从附件条目解析父文献条目 key（Zotero 笔记挂在父条目下，不在附件下）。
 *
 * 任何失败都只降级笔记部分：返回空 key + 一条 warning，绝不抛出——
 * 批注导入不能因为父条目读不到而失败。
 */
async function zoteroParentItemKey(
  base: string,
  headers: Record<string, string>,
  attachmentKey: string
): Promise<{ parentKey: string; warning: string }> {
  try {
    const response = await fetch(`${base}/items/${attachmentKey}?format=json`, {
      headers,
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      return {
        parentKey: '',
        warning: `读取 Zotero 附件条目失败（HTTP ${response.status}），本次只导入批注，笔记未导入。`
      };
    }
    const payload = (await response.json()) as { data?: Record<string, unknown> } | null;
    const parentKey = String(payload?.data?.parentItem ?? '').trim();
    if (!/^[A-Z0-9]{8}$/.test(parentKey)) {
      return {
        parentKey: '',
        warning:
          '这个 Zotero 附件没有父文献条目（parentItem），无法定位笔记；本次只导入批注。'
      };
    }
    return { parentKey, warning: '' };
  } catch {
    return {
      parentKey: '',
      warning: '读取 Zotero 附件条目失败（网络或返回格式异常），本次只导入批注，笔记未导入。'
    };
  }
}

/**
 * 分页读取父条目 children，收集 itemType=note 的条目（笔记正文在 data.note）。
 * 失败时返回已读到的部分 + 一条 warning；不让批注导入失败。
 */
async function zoteroNoteRows(
  base: string,
  headers: Record<string, string>,
  parentKey: string
): Promise<{ rows: Array<{ key?: string; data?: Record<string, unknown> }>; warning: string }> {
  const rows: Array<{ key?: string; data?: Record<string, unknown> }> = [];
  for (let start = 0; start < 5000; start += 100) {
    let response: Response;
    try {
      response = await fetch(
        `${base}/items/${parentKey}/children?format=json&limit=100&start=${start}`,
        { headers, signal: AbortSignal.timeout(30_000) }
      );
    } catch {
      return {
        rows,
        warning: '读取 Zotero 父条目的笔记列表失败（网络异常），笔记部分未完整导入。'
      };
    }
    if (!response.ok) {
      return {
        rows,
        warning: `读取 Zotero 父条目的笔记列表返回 HTTP ${response.status}，笔记部分未完整导入。`
      };
    }
    let page: unknown;
    try {
      page = await response.json();
    } catch {
      return {
        rows,
        warning: 'Zotero 返回的父条目 children 数据无法解析，笔记部分未导入。'
      };
    }
    if (!Array.isArray(page)) {
      return {
        rows,
        warning: 'Zotero 返回的父条目 children 不是数组，笔记部分未导入。'
      };
    }
    rows.push(...(page as Array<{ key?: string; data?: Record<string, unknown> }>));
    if (page.length < 100) return { rows, warning: '' };
  }
  return {
    rows,
    warning: 'Zotero 返回的笔记列表达到读取上限，可能还有未列出的笔记。'
  };
}

/**
 * 读取当前文献的每页几何（宽/高/旋转），用于把 Zotero 自带坐标换算成本应用 rects。
 *
 * 传 `store.getDocumentPath` 里的真实 PDF（应用副本或 Zotero 外部路径），只读；
 * 读不到/解析失败时返回空数组，调用方全部回退文本逐字定位（不影响批注导入）。
 */
async function zoteroDocumentPageGeometry(
  store: Store,
  documentId: string
): Promise<ZoteroPageGeometry[]> {
  let filePath: string | null = null;
  try {
    filePath = store.getDocumentPath(documentId);
  } catch {
    // Zotero 外部附件被替换/缺失：不猜坐标，交给文本定位。
    return [];
  }
  if (!filePath) return [];
  try {
    const pdf = await PDFDocument.load(readFileSync(filePath), {
      ignoreEncryption: true,
      updateMetadata: false
    });
    return pdf.getPages().map((page) => {
      // PDF.js/Zotero 的可见页按 CropBox 渲染；无 CropBox 时 pdf-lib 返回 MediaBox。
      const box = page.getCropBox();
      return {
        width: box.width,
        height: box.height,
        rotation: page.getRotation().angle
      };
    });
  } catch {
    return [];
  }
}

/**
 * 由 annotationPosition.rects 换算本应用 rects（0..1、左上原点）。
 * 没有坐标、坐标无效、页面几何缺失或页面旋转时返回空数组 → 调用方回退文本定位。
 */
function zoteroCoordinateRects(
  data: Record<string, unknown>,
  page: number | undefined,
  geometry: ZoteroPageGeometry[]
): number[][] {
  if (!page || page < 1 || page > geometry.length) return [];
  const pageGeometry = geometry[page - 1];
  if (!pageGeometry) return [];
  const position = zoteroPositionData(data);
  if (position.rects.length === 0) return [];
  // 防御坏数据：pageIndex 与 mapZoteroAnnotation 得出的页码必须一致。
  if (position.pageIndex != null && position.pageIndex + 1 !== page) return [];
  const normalized = normalizeZoteroRects(position.rects, pageGeometry);
  return normalized.ok ? normalized.rects : [];
}

export async function importZoteroAnnotations(
  store: Store,
  secrets: SecretStore,
  documentId: string,
  commit: boolean,
  overrideLocalBase?: string
): Promise<ZoteroAnnotationImportReport> {
  const document = store.getDocument(documentId);
  if (!document) throw new Error('文献不存在');
  const identity = store.getDocumentExternalKey(documentId);
  const attachmentKey = zoteroAttachmentKey(identity);
  if (!attachmentKey) {
    throw new Error('找不到这篇文献对应的 Zotero 附件标识；请先重新打开 Zotero 附件');
  }
  const config = getZoteroConfig(store, secrets);
  const base =
    config.mode === 'local'
      ? `${(overrideLocalBase ?? LOCAL_BASE).replace(/\/+$/, "")}/${config.library_type}/${config.library_id || "0"}`
      : `${CLOUD_BASE}/${config.library_type}/${config.library_id}`;
  const key = secrets.get('zotero.api_key')?.trim() ?? '';
  if (config.mode !== 'local' && !key) throw new Error('云端模式需要先保存 Zotero API Key');
  const headers = {
    'Zotero-API-Version': '3',
    ...(config.mode !== 'local' ? { 'Zotero-API-Key': key } : {})
  } as Record<string, string>;
  const childRows: Array<{ key?: string; data?: Record<string, unknown> }> = [];
  let truncated = false;
  for (let start = 0; start < 5000; start += 100) {
    const response = await fetch(
      `${base}/items/${attachmentKey}/children?format=json&limit=100&start=${start}`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );
    if (!response.ok) throw new Error(`Zotero 批注列表返回 HTTP ${response.status}`);
    const page = (await response.json()) as Array<{
      key?: string;
      data?: Record<string, unknown>;
    }>;
    if (!Array.isArray(page)) throw new Error('Zotero 返回的批注列表不符合预期');
    childRows.push(...page);
    if (page.length < 100) break;
    if (start >= 4900) truncated = true;
  }

  // 批注在 Zotero 里是附件子条目，但某些版本/配置下 children 只返回笔记：
  // 没有 annotation 时再按 itemType=annotation 全库兜底（只读，上限 2000 条扫描）。
  // 判定放宽带 "缺字段"：有 annotationType 但没有 itemType 的行也算批注（老版本实测如此）。
  const rowKey = (row: { key?: string; data?: Record<string, unknown> }): string =>
    String(row.key ?? row.data?.key ?? '');
  const isAnnotationRow = (row: {
    key?: string;
    data?: Record<string, unknown>;
  }): boolean => {
    const data = row.data ?? {};
    if (data.deleted) return false;
    const type = String(data.itemType ?? '');
    if (type === 'annotation') return true;
    return type === '' && typeof data.annotationType === 'string' && data.annotationType.trim() !== '';
  };
  const dedupeRows = (
    rows: Array<{ key?: string; data?: Record<string, unknown> }>
  ): Array<{ key?: string; data?: Record<string, unknown> }> => {
    const seen = new Set<string>();
    const result: Array<{ key?: string; data?: Record<string, unknown> }> = [];
    for (const row of rows) {
      const key = rowKey(row);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      result.push(row);
    }
    return result;
  };
  let rows = dedupeRows(childRows.filter(isAnnotationRow));
  if (rows.length === 0) {
    const fallback: Array<{ key?: string; data?: Record<string, unknown> }> = [];
    let start = 0;
    let scanned = 0;
    try {
      for (;;) {
        const response = await fetch(
          `${base}/items?format=json&limit=100&start=${start}&itemType=annotation`,
          { headers, signal: AbortSignal.timeout(30_000) }
        );
        // 兜底只是补充：查询失败按"没有批注"处理，不让整个导入失败。
        if (!response.ok) break;
        const page = (await response.json()) as Array<{
          key?: string;
          data?: Record<string, unknown>;
        }>;
        if (!Array.isArray(page)) break;
        scanned += page.length;
        for (const row of page) {
          const data = row.data ?? {};
          if (String(data.parentItem ?? '') !== attachmentKey || data.deleted) continue;
          if (!isAnnotationRow(row)) continue;
          fallback.push(row);
        }
        if (page.length < 100) break;
        start += 100;
        if (scanned >= 2000) {
          truncated = true;
          break;
        }
      }
    } catch {
      // 网络错误同样降级为"没有额外批注"。
    }
    rows = dedupeRows(fallback);
  }
  // —— Zotero 笔记：父文献条目（parentItem）下 itemType=note 的子条目 ——
  // 笔记挂在父条目下而不是附件下，所以先由附件拿 parentItem，再分页读父条目 children。
  // 任一步失败都只降级笔记部分（noteTotal 记 0 + warning），批注导入照常完成。
  const noteRows: Array<{ key?: string; data?: Record<string, unknown> }> = [];
  let noteWarning = '';
  const parent = await zoteroParentItemKey(base, headers, attachmentKey);
  if (parent.warning) noteWarning = parent.warning;
  if (parent.parentKey) {
    const fetched = await zoteroNoteRows(base, headers, parent.parentKey);
    if (fetched.warning) noteWarning = noteWarning ? `${noteWarning} ${fetched.warning}` : fetched.warning;
    noteRows.push(...fetched.rows);
  }
  const noteRowsDeduped = dedupeRows(
    noteRows.filter((row) => {
      const data = row.data ?? {};
      if (data.deleted) return false;
      return String(data.itemType ?? '') === 'note';
    })
  );
  const existingNotes = store.noteExternalKeys(documentId);
  const notePrepared: ZoteroNoteCandidate[] = [];
  const noteItems: ZoteroNoteImportItem[] = [];
  let notesSkippedExisting = 0;
  let notesSkippedEmpty = 0;
  for (const row of noteRowsDeduped.slice(0, MAX_ZOTERO_IMPORT)) {
    const data = { ...(row.data ?? {}), key: row.key ?? row.data?.key ?? '' };
    const candidate = mapZoteroNote(data);
    const item: ZoteroNoteImportItem = {
      kind: 'note',
      zoteroKey: candidate.zoteroKey,
      type: 'note',
      page: 0,
      content: candidate.content.slice(0, NOTE_REPORT_PREVIEW),
      contentLength: candidate.content.length,
      action: commit ? 'import' : 'would-import',
      reason: ''
    };
    if (candidate.ok && existingNotes.has(candidate.zoteroKey)) {
      notesSkippedExisting += 1;
      noteItems.push({ ...item, action: 'skip-existing', reason: '已导入过' });
      continue;
    }
    if (!candidate.ok) {
      notesSkippedEmpty += 1;
      noteItems.push({ ...item, action: 'skip', reason: candidate.reason });
      continue;
    }
    notePrepared.push(candidate);
    noteItems.push(item);
  }
  const report: ZoteroAnnotationImportReport = {
    attachmentKey,
    mode: commit ? 'import' : 'preview',
    total: rows.length,
    imported: 0,
    wouldImport: 0,
    skippedExisting: 0,
    skippedType: 0,
    skippedPage: 0,
    skippedEmpty: 0,
    located: 0,
    pageLevel: 0,
    positioned: 0,
    repositioned: 0,
    unknownColor: 0,
    warnings: [],
    message: '',
    items: [],
    noteTotal: noteRowsDeduped.length,
    notesImported: 0,
    notesWouldImport: 0,
    notesSkippedExisting,
    notesSkippedEmpty,
    noteItems
  };
  if (noteWarning) report.warnings.push(noteWarning);
  if (noteRowsDeduped.length > MAX_ZOTERO_IMPORT) {
    report.warnings.push(
      `这篇文献共有 ${noteRowsDeduped.length} 条 Zotero 笔记，本次只处理前 ${MAX_ZOTERO_IMPORT} 条。`
    );
  }
  // 一次性加载 PDF 页面几何；读不到就全部回退文本逐字定位。
  const pageGeometry = await zoteroDocumentPageGeometry(store, documentId);
  const existingAnnotations = store.annotationExternalIndex(documentId);
  const prepared: Array<{
    candidate: ZoteroAnnotationCandidate;
    /** 由 Zotero 自带坐标换算的本应用 rects；空数组表示需要回退文本定位。 */
    coordinateRects: number[][];
  }> = [];
  const positionUpgrades: Array<{ annotationId: string; rects: string; style: string }> = [];
  for (const row of rows.slice(0, MAX_ZOTERO_IMPORT)) {
    const data = { ...(row.data ?? {}), key: row.key ?? row.data?.key ?? '' };
    const candidate = mapZoteroAnnotation(data, document.pages);
    if (!candidate.ok) {
      if (candidate.category === 'type') report.skippedType += 1;
      else if (candidate.category === 'page') report.skippedPage += 1;
      else report.skippedEmpty += 1;
      report.items.push({
        kind: 'annotation',
        zoteroKey: candidate.zoteroKey,
        type: candidate.type,
        page: candidate.page ?? 0,
        quote: candidate.quote,
        comment: candidate.comment,
        action: 'skip',
        reason: candidate.reason
      });
      continue;
    }
    // 优先用 Zotero 自带坐标：中文 PDF 的文本层与 Zotero 摘引常有空格/标点差异，
    // 逐字定位会大量失败并退化成"整页批注"。
    const coordinateRects = zoteroCoordinateRects(data, candidate.page, pageGeometry);
    const existingAnnotation = existingAnnotations.get(candidate.zoteroKey);
    if (existingAnnotation) {
      const currentRects = existingAnnotation.rects.trim();
      const hasPosition =
        currentRects !== '' && currentRects !== '[]' && existingAnnotation.style !== 'page';
      // 旧数据只有页级位置、这次能算出坐标：升级位置（保留用户改过的 content/color）。
      // 已软删除的批注保持旧行为：只计入已存在，不升级、不重复导入。
      if (!existingAnnotation.deleted && !hasPosition && coordinateRects.length > 0) {
        positionUpgrades.push({
          annotationId: existingAnnotation.id,
          rects: JSON.stringify(coordinateRects),
          style: candidate.style ?? 'highlight'
        });
        report.repositioned += 1;
        report.items.push({
          kind: 'annotation',
          zoteroKey: candidate.zoteroKey,
          type: candidate.type,
          page: candidate.page ?? 0,
          quote: candidate.quote,
          comment: candidate.comment,
          action: 'update-position',
          reason: '此前只有页级位置，本次按 Zotero 坐标升级为高亮/下划线'
        });
        continue;
      }
      report.skippedExisting += 1;
      report.items.push({
        kind: 'annotation',
        zoteroKey: candidate.zoteroKey,
        type: candidate.type,
        page: candidate.page ?? 0,
        quote: candidate.quote,
        comment: candidate.comment,
        action: 'skip-existing',
        reason: '已导入过'
      });
      continue;
    }
    prepared.push({ candidate, coordinateRects });
    if (coordinateRects.length > 0) report.positioned += 1;
    if (candidate.unknownColor) {
      report.unknownColor += 1;
      report.warnings.push(`批注 ${candidate.zoteroKey} 的颜色未知，已回落到黄色。`);
    }
    report.items.push({
      kind: 'annotation',
      zoteroKey: candidate.zoteroKey,
      type: candidate.type,
      page: candidate.page ?? 0,
      quote: candidate.quote,
      comment: candidate.comment,
      action: commit ? 'import' : 'would-import',
      reason: coordinateRects.length > 0 ? '按 Zotero 坐标定位' : ''
    });
  }
  if (rows.length > MAX_ZOTERO_IMPORT) {
    report.warnings.push(
      `这篇附件共有 ${rows.length} 条标注，本次只处理前 ${MAX_ZOTERO_IMPORT} 条。`
    );
  }
  if (truncated) {
    report.warnings.push('Zotero 返回的批注列表达到读取上限，可能还有未列出的批注。');
  }
  if (!commit) {
    report.wouldImport = prepared.length;
    report.notesWouldImport = notePrepared.length;
    const positionNotes: string[] = [];
    if (report.positioned) positionNotes.push(`其中 ${report.positioned} 条按 Zotero 坐标定位`);
    if (report.repositioned) {
      positionNotes.push(`${report.repositioned} 条已有的页级批注将按 Zotero 坐标升级位置`);
    }
    report.message =
      `将导入 ${prepared.length} 条批注、${notePrepared.length} 条笔记（预览，尚未写入）` +
      (positionNotes.length ? `；${positionNotes.join('；')}` : '');
    return report;
  }
  for (const { candidate, coordinateRects } of prepared.sort((left, right) =>
    (left.candidate.page ?? 0) - (right.candidate.page ?? 0) ||
    (left.candidate.sortIndex ?? '').localeCompare(right.candidate.sortIndex ?? '')
  )) {
    let rects = '[]';
    let style = 'page';
    if (coordinateRects.length > 0) {
      // 首选 Zotero 自带坐标（PDF 用户空间 → 本应用 0..1 归一化），不依赖文本层。
      rects = JSON.stringify(coordinateRects);
      style = candidate.style ?? 'highlight';
    } else if (candidate.quote) {
      try {
        const located = await store.locateCitationEx(
          documentId,
          candidate.page!,
          candidate.quote
        );
        // 批注要落在 candidate.page 上：只有记录页本身命中才写坐标；
        // 跨页更正的结果属于另一页，不能拿来当这一页的高亮框。
        if (!located.corrected && located.boxes.length > 0) {
          rects = JSON.stringify(located.boxes.map((row) => row.bbox));
          style = candidate.style ?? 'highlight';
          report.located += 1;
        }
      } catch {
        // 定位失败降级为页级批注，不猜坐标。
      }
    }
    if (rects === '[]') report.pageLevel += 1;
    store.createAnnotation({
      documentId,
      page: candidate.page!,
      quote: candidate.quote,
      content: candidate.comment,
      rects,
      color: candidate.color ?? 'yellow',
      style,
      externalKey: candidate.zoteroKey
    });
    report.imported += 1;
  }
  // 旧数据升级：已存在的页级批注按 Zotero 坐标补上 rects/style，保留用户编辑过的 content/color。
  for (const upgrade of positionUpgrades) {
    store.setAnnotationGeometry(upgrade.annotationId, {
      rects: upgrade.rects,
      style: upgrade.style
    });
  }
  // 笔记导入为「整篇文献笔记」：page 0，content 为 HTML 转出的纯文本；
  // external_key 记 Zotero note key，重复导入时由 noteExternalKeys 去重。
  for (const candidate of notePrepared) {
    store.createNote({
      documentId,
      page: 0,
      quote: '',
      content: candidate.content,
      externalKey: candidate.zoteroKey
    });
    report.notesImported += 1;
  }
  report.message = `已导入 ${report.imported} 条批注、${report.notesImported} 条笔记`;
  if (report.positioned) {
    report.message += `；其中 ${report.positioned} 条按 Zotero 坐标定位`;
  }
  if (report.repositioned) {
    report.message += `；${report.repositioned} 条页级批注升级了位置`;
  }
  const skippedExistingTotal = report.skippedExisting + report.notesSkippedExisting;
  if (skippedExistingTotal) {
    report.message += `；${skippedExistingTotal} 条已存在，未重复导入`;
  }
  const skippedTotal =
    report.skippedType + report.skippedPage + report.skippedEmpty + report.notesSkippedEmpty;
  if (skippedTotal) {
    report.message += `；跳过 ${skippedTotal} 条`;
  }
  return report;
}

const WEBDAV_PROBE_TIMEOUT_MS = 15_000;
/** WebDAV 目录可达的状态：207 是 PROPFIND 的正常应答；301/302 视为地址可用（只探测，不跟随）。 */
const WEBDAV_REACHABLE_STATUSES = new Set([200, 207, 301, 302]);

export interface WebdavProbeOutcome {
  /** false 表示还没配置账号/应用密码，没发出请求。 */
  checked: boolean;
  ok: boolean;
  /** HTTP 状态码；网络层失败时为 0。 */
  status: number;
  latencyMs: number;
  message: string;
}

/** WebDAV 探测失败说明（只含状态码与建议，不含账号/密码）。 */
export function webdavFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `WebDAV 账号或应用密码错误/无权限（HTTP ${status}）：请核对「WebDAV 账号」与应用密码（坚果云等服务要填应用密码，不是登录密码）。`;
  }
  if (status === 404) {
    return 'WebDAV 地址找不到附件目录（HTTP 404）：请核对 WebDAV 地址是否指向 Zotero 附件文件夹（通常是 https://dav.jianguoyun.com/dav/zotero）。';
  }
  if (status === 405) {
    return 'WebDAV 服务器不接受目录探测（HTTP 405）：请确认地址指向一个 WebDAV 目录，而不是普通网页。';
  }
  return `WebDAV 返回 HTTP ${status}：请检查 WebDAV 地址或稍后重试。`;
}

/**
 * 探测 WebDAV 时使用的地址：去掉 URL 里内嵌的账号/密码。
 *
 * fetch 不允许带凭据的 URL，而且我们希望诊断输出/请求都不夹带凭据；
 * 真正的账号密码只走 Authorization 头。
 */
function webdavProbeUrl(webdavUrl: string): string {
  let value = webdavUrl;
  try {
    const parsed = new URL(webdavUrl);
    parsed.username = '';
    parsed.password = '';
    value = parsed.toString();
  } catch {
    // 地址不合法时交给 fetch 报网络错误。
  }
  return `${value.replace(/\/+$/, '')}/`;
}

/**
 * 轻量探测 WebDAV 附件目录（与附件下载使用同一组 WebDAV 账号/应用密码）：
 * `PROPFIND Depth: 0`，服务器不支持（405/501）时退回 `HEAD`；
 * 200/207/301/302 视为可达，401/403 视为凭据错误，网络错误单独说明。
 * 返回值只含状态码与中文说明，**不出现账号或密码**。
 */
async function probeWebdavEndpoint(
  config: ZoteroConfigRecord,
  password: string
): Promise<WebdavProbeOutcome> {
  if (!config.webdav_user || !password) {
    return {
      checked: false,
      ok: false,
      status: 0,
      latencyMs: 0,
      message: '请先配置 WebDAV 账号与应用密码（WebDAV 附件下载需要这组凭据）。'
    };
  }
  const url = webdavProbeUrl(config.webdav_url);
  const auth = Buffer.from(`${config.webdav_user}:${password}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Depth: '0'
  };
  const request = async (method: string): Promise<Response> =>
    fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBDAV_PROBE_TIMEOUT_MS)
    });
  const started = Date.now();
  try {
    let response = await request('PROPFIND');
    if (response.status === 405 || response.status === 501) {
      // 少数服务器不实现 PROPFIND：释放响应后改用 HEAD 再确认一次，避免误报。
      await response.arrayBuffer().catch(() => undefined);
      response = await request('HEAD');
    }
    const status = response.status;
    await response.arrayBuffer().catch(() => undefined);
    const latencyMs = Date.now() - started;
    if (WEBDAV_REACHABLE_STATUSES.has(status)) {
      return {
        checked: true,
        ok: true,
        status,
        latencyMs,
        message: `WebDAV 附件目录可访问（HTTP ${status}）。`
      };
    }
    return { checked: true, ok: false, status, latencyMs, message: webdavFailureMessage(status) };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    const target = displayUrl(config.webdav_url);
    return {
      checked: true,
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      message:
        name === 'TimeoutError' || name === 'AbortError'
          ? `连接 WebDAV 服务器超时（${target}）：请检查地址、网络或代理设置。`
          : `连接不上 WebDAV 服务器（${target}）：请检查 WebDAV 地址、网络或代理设置。`
    };
  }
}

/**
 * 只读连接探测：分别检查 Zotero API Key/资料库读取与 WebDAV 附件目录是否可用。
 *
 * - 403 等 HTTP 错误统一走 `zoteroFailureMessage(status, mode)`：local 提示本机通信开关，
 *   cloud/webdav 提示 API Key 权限，不再把两种原因混在同一句话里；
 * - webdav 模式额外用保存的 WebDAV 账号/应用密码探测附件目录，两项都通过才算可用；
 * - 结果里补充 requestedMode/actualMode 与 detail，消息与明细都不含 API Key / WebDAV 密码。
 */
export async function probeZotero(
  store: Store,
  secrets: SecretStore,
  overrideLocalBase?: string
): Promise<ZoteroProbeResult> {
  const config = getZoteroConfig(store, secrets);
  const requestedMode = config.mode;
  // WebDAV 模式的分类/条目仍然从 api.zotero.org 读取，所以实际探测的 API 端点是 cloud。
  const actualMode: 'local' | 'cloud' = requestedMode === 'local' ? 'local' : 'cloud';
  const key = secrets.get('zotero.api_key')?.trim() ?? '';
  const webdavPassword = secrets.get('zotero.webdav_password')?.trim() ?? '';
  const localBase = `${(overrideLocalBase ?? LOCAL_BASE).replace(/\/+$/, '')}/${config.library_type}/${config.library_id || '0'}`;
  const base =
    actualMode === 'local'
      ? localBase
      : `${CLOUD_BASE}/${config.library_type}/${config.library_id}`;
  const detail: string[] = [
    `请求的连接方式：${MODE_NAMES[requestedMode]}；探测端点：${
      actualMode === 'local' ? '本机 Zotero 接口' : 'Zotero 云端接口'
    }。`,
    `探测地址：${base}。`
  ];
  if (requestedMode === 'webdav') {
    detail.push(`WebDAV 附件地址：${displayUrl(config.webdav_url)}。`);
  }
  if (requestedMode !== 'local' && !key) {
    return {
      ok: false,
      mode: requestedMode,
      requestedMode,
      actualMode,
      latencyMs: 0,
      message: '云端模式需要先保存 Zotero API Key。',
      detail
    };
  }
  const started = Date.now();
  let apiStatus = 0;
  let apiLatencyMs = 0;
  let apiFailure = '';
  try {
    const response = await fetch(`${base}/collections?format=json&limit=1`, {
      headers: {
        'Zotero-API-Version': '3',
        ...(requestedMode !== 'local' ? { 'Zotero-API-Key': key } : {})
      },
      signal: AbortSignal.timeout(15_000)
    });
    apiStatus = response.status;
    apiLatencyMs = Date.now() - started;
    if (!response.ok) {
      // 按连接方式区分原因：local 是本机通信开关，cloud/webdav 是 API Key 权限。
      apiFailure = zoteroFailureMessage(response.status, requestedMode);
      detail.push(`Zotero 接口错误：${apiFailure}`);
    } else {
      await response.arrayBuffer();
      detail.push(`Zotero 接口返回 HTTP ${apiStatus}，耗时 ${apiLatencyMs} ms。`);
    }
  } catch (error) {
    apiLatencyMs = Date.now() - started;
    const name = (error as { name?: string } | null)?.name;
    apiFailure =
      name === 'TimeoutError' || name === 'AbortError'
        ? '连接 Zotero 超时（15 秒）：请检查网络或代理设置后重试。'
        : zoteroNetworkMessage(requestedMode);
    detail.push(`Zotero 接口错误：${apiFailure}`);
  }
  if (requestedMode !== 'webdav') {
    if (apiFailure) {
      return {
        ok: false,
        mode: requestedMode,
        requestedMode,
        actualMode,
        latencyMs: apiLatencyMs,
        message: apiFailure,
        detail
      };
    }
    return {
      ok: true,
      mode: requestedMode,
      requestedMode,
      actualMode,
      latencyMs: apiLatencyMs,
      message: requestedMode === 'local' ? '本机 Zotero 可读。' : 'Zotero 云端可读。',
      detail
    };
  }
  const webdav = await probeWebdavEndpoint(config, webdavPassword);
  detail.push(`WebDAV 探测：${webdav.message}（耗时 ${webdav.latencyMs} ms）`);
  const latencyMs = apiLatencyMs + webdav.latencyMs;
  if (apiFailure && !webdav.ok) {
    return {
      ok: false,
      mode: requestedMode,
      requestedMode,
      actualMode,
      latencyMs,
      message: `Zotero 云端读取失败：${apiFailure} WebDAV 附件不可用：${webdav.message}`,
      detail,
      webdav
    };
  }
  if (apiFailure) {
    return {
      ok: false,
      mode: requestedMode,
      requestedMode,
      actualMode,
      latencyMs,
      message: apiFailure,
      detail,
      webdav
    };
  }
  if (!webdav.ok) {
    return {
      ok: false,
      mode: requestedMode,
      requestedMode,
      actualMode,
      latencyMs,
      message: `Zotero 云端可读，但 WebDAV 附件不可用：${webdav.message}`,
      detail,
      webdav
    };
  }
  return {
    ok: true,
    mode: requestedMode,
    requestedMode,
    actualMode,
    latencyMs,
    message: 'Zotero 云端可读，WebDAV 附件目录可访问。',
    detail,
    webdav
  };
}

export interface ZoteroDiagnoseResult {
  mode: 'local' | 'cloud' | 'webdav';
  mode_name: string;
  ok: boolean;
  message: string;
  detail: string[];
  /** 云端模式下若能确定密钥所属账户的数字 ID，会放在这里供用户对照填写。 */
  suggested_library_id?: string;
}

const MODE_NAMES: Record<ZoteroDiagnoseResult['mode'], string> = {
  local: '本机 Zotero',
  cloud: 'Zotero 云端',
  webdav: 'Zotero 云端 + WebDAV 附件'
};

/** 展示用地址：去掉 URL 里的账号/密码，避免诊断输出泄漏凭据。 */
function displayUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

/**
 * 只读查询当前 API Key 属于哪个账户、能读什么（`GET /keys/current`）。
 *
 * 只把密钥放在 `Zotero-API-Key` 请求头；返回值只含解析结果或中文错误，
 * 不包含密钥本身。返回 `fatal=true` 表示应按失败处理（网络/HTTP/不可解析）。
 */
async function zoteroKeyInfo(
  store: Store,
  secrets: SecretStore
): Promise<{ payload?: Record<string, unknown>; error?: string; fatal: boolean }> {
  const key = secrets.get('zotero.api_key')?.trim() ?? '';
  if (!key) {
    return {
      error: '还没有保存 Zotero API Key：云端与 WebDAV 附件模式都需要它。',
      fatal: true
    };
  }
  let response: Response;
  try {
    response = await fetch(`${CLOUD_BASE}/keys/current`, {
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': key },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    return {
      error: `无法查询密钥所属账户：${error instanceof Error ? error.message : '网络错误'}。请检查网络或代理后重试。`,
      fatal: true
    };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        error: `Zotero 拒绝了密钥查询（HTTP ${response.status}）：API Key 无效，或没有获得资料库读取权限。请到 zotero.org 的 API Keys 页面重新生成并勾选权限后再保存。`,
        fatal: true
      };
    }
    return {
      error: `Zotero 密钥查询返回 HTTP ${response.status}。`,
      fatal: true
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { error: '无法解析 Zotero 的密钥信息（响应不是 JSON）。', fatal: true };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    // 形状不符合预期不算"网络失败"：至少 probe 已证明资料库可读，这里只降级为信息缺失。
    return {
      error: 'Zotero 返回的密钥信息不符合预期（无法解析账户/权限）。',
      fatal: false
    };
  }
  return { payload: payload as Record<string, unknown>, fatal: false };
}

/**
 * 只读诊断：逐步确认连接卡在哪一步，给出下一步动作。
 *
 * - 不打日志、不改配置、不上传内容；
 * - 返回值与 detail 里**不出现 API Key / WebDAV 密码**（只写「是否已配置」）；
 * - 任何失败都返回 ok=false + message，不抛异常（路由不会 500）。
 */
export async function diagnoseZotero(
  store: Store,
  secrets: SecretStore
): Promise<ZoteroDiagnoseResult> {
  const config = getZoteroConfig(store, secrets);
  const mode = config.mode;
  const result: ZoteroDiagnoseResult = {
    mode,
    mode_name: MODE_NAMES[mode] ?? 'Zotero',
    ok: false,
    message: '',
    detail: [`连接方式：${MODE_NAMES[mode] ?? 'Zotero'}。`],
    suggested_library_id: ''
  };
  try {
    if (mode === 'local') {
      result.detail.push(
        `本机 Zotero 接口：${LOCAL_BASE}/${config.library_type}/${config.library_id || '0'}。`
      );
      try {
        await zoteroRequest(store, secrets, '/collections', {
          format: 'json',
          limit: '1'
        });
        result.ok = true;
        result.message = '本机 Zotero 可读：分类、条目与附件都从本机数据库读取。';
      } catch (error) {
        result.message = error instanceof Error ? error.message : '本机 Zotero 不可读。';
        result.detail.push(`错误：${result.message}`);
      }
      return result;
    }
    result.detail.push(
      `云端接口：${CLOUD_BASE}/${config.library_type}/${config.library_id}。`
    );
    if (mode === 'webdav') {
      result.detail.push(`WebDAV 附件地址：${displayUrl(config.webdav_url)}。`);
      if (!config.webdav_user || !secrets.get('zotero.webdav_password')?.trim()) {
        result.detail.push(
          'WebDAV 模式还缺账号或应用密码：不影响分类与条目读取，但打不开附件。'
        );
      }
    }
    const probe = await probeZotero(store, secrets);
    result.detail.push(`探测耗时：${probe.latencyMs} ms。`);
    if (probe.webdav) {
      result.detail.push(`WebDAV 探测：${probe.webdav.message}`);
    }
    const keyInfo = await zoteroKeyInfo(store, secrets);
    if (keyInfo.payload) {
      const payload = keyInfo.payload;
      const userId = payload.userID;
      const username = typeof payload.username === 'string' ? payload.username.trim() : '';
      const access =
        payload.access && typeof payload.access === 'object' && !Array.isArray(payload.access)
          ? (payload.access as Record<string, unknown>)
          : {};
      const personal =
        access.user && typeof access.user === 'object' && !Array.isArray(access.user)
          ? (access.user as Record<string, unknown>)
          : {};
      const groups =
        access.groups && typeof access.groups === 'object' && !Array.isArray(access.groups)
          ? (access.groups as Record<string, unknown>)
          : {};
      result.detail.push(
        `密钥属于账户 ${username || '（平台未返回用户名）'}，数字用户 ID 为 ${
          userId ?? '（平台未返回）'
        }。`
      );
      if (config.library_type === 'users') {
        if (userId != null && String(userId) !== config.library_id) {
          result.suggested_library_id = String(userId);
          result.detail.push(
            '当前填写的用户 ID 与这把密钥所属的账户不一致：云端按数字 ID 取库，请把资料库 ID 改成上面这个数字。'
          );
        }
        if (!personal.library) {
          result.detail.push(
            '这把密钥没有获得「个人资料库」读取权限（library=false），分类与条目都会被拒绝；请到 zotero.org 的 API Keys 页面重新勾选「允许读取资料库」后再保存密钥。'
          );
        }
      } else {
        const entry = groups[config.library_id];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          result.detail.push('这把密钥没有授权访问所填写的群组（群组 ID 也可能不对）。');
        } else if (!(entry as Record<string, unknown>).library) {
          result.detail.push(
            `这把密钥对群组 ${config.library_id} 没有读取权限；请到 zotero.org 的 API Keys 页面重新勾选该群组的读取权限后再保存密钥。`
          );
        } else {
          result.detail.push(`这把密钥对群组 ${config.library_id} 有读取权限。`);
        }
      }
    } else if (keyInfo.error) {
      result.detail.push(`密钥信息：${keyInfo.error}`);
      if (keyInfo.fatal) {
        result.ok = false;
        result.message = keyInfo.error;
        return result;
      }
    }
    if (probe.ok) {
      result.ok = true;
      result.message =
        mode === 'webdav'
          ? '连接可用：已成功读取 Zotero 云端资料库，WebDAV 附件目录也可访问。'
          : '连接可用：已成功读取 Zotero 云端资料库。';
    } else {
      result.ok = false;
      result.message = probe.message;
      result.detail.push(`错误：${probe.message}`);
    }
    return result;
  } catch (error) {
    result.ok = false;
    result.message = error instanceof Error ? error.message : 'Zotero 诊断失败';
    result.detail.push(`错误：${result.message}`);
    return result;
  }
}
