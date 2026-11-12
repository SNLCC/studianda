import { appDialogs } from './dialogs.js';
import type { ApiClient, SpeechSystemStatus } from '@studianda/api-client';
import type {
  BackupJobRecord,
  ClearUserDataResult,
  ParsingCheckResult,
  ParsingConfigRecord,
  NoteAssetGcReport,
  NoteAssetReindexJob
} from '@studianda/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { HintMark, SendingNotice } from './Hint.js';
import { SettingsFeedbackProvider, useSettingsFeedback } from './SettingsFeedback.js';
import type { RuntimeAdapter } from './runtime.js';
import { mediaRecordingSupport } from './runtime.js';
import { ModelServicesPanel } from './ModelServicesPanel.js';
import { ModelUsagePanel } from './ModelUsagePanel.js';
import { ShortcutSettingsPanel } from './ShortcutSettingsPanel.js';
import { TranslationSettingsPanel } from './TranslationSettingsPanel.js';
import { UpdatePanel } from './UpdatePanel.js';
import { USAGE_NOTICE_DOC_URL, openExternalLink } from './external-links.js';
import {
  USAGE_NOTICE_EFFECTIVE_DATE,
  USAGE_NOTICE_VERSION,
  UsageNoticeDialog,
  hasAcknowledgedCurrentUsageNotice,
  hasReadCurrentUsageNotice
} from './usage-notice.js';

/** 任务约定的默认语言：英文与简体中文。 */
const DEFAULT_OCR_LANGS = ['eng', 'chi_sim'];

/** 笔记图片上限的兜底默认值（服务端未返回设置时使用）。 */
const DEFAULT_NOTE_IMAGE_MAX_MB = 10;
const DEFAULT_NOTE_IMAGE_MAX_MP = 25;

/** 资源索引重建阶段的中文标签。 */
export function reindexPhaseLabel(phase: NoteAssetReindexJob['phase']): string {
  switch (phase) {
    case 'scanning':
      return '扫描文件';
    case 'notes':
      return '扫描笔记引用';
    case 'annotations':
      return '扫描批注引用';
    case 'finalizing':
      return '写入索引';
    default:
      return '准备中';
  }
}

/** 资源索引重建进度百分比（0–100，total<=0 时 0 或完成 100）。 */
export function reindexPercent(job: Pick<NoteAssetReindexJob, 'status' | 'done' | 'total'>): number {
  if (job.status === 'done') return 100;
  if (!Number.isFinite(job.total) || job.total <= 0) return 0;
  const percent = Math.round((job.done / job.total) * 100);
  return Math.min(100, Math.max(0, percent));
}

/** 字节数显示（清理图片资源时使用）。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function SectionHeading({
  title,
  hint,
  note
}: {
  title: string;
  hint?: string;
  note?: string;
}): JSX.Element {
  return (
    <div className="kr-settings__section-head">
      <h2>{title}</h2>
      {note ? <span className="kr-settings__section-note">{note}</span> : null}
      {hint ? <HintMark text={hint} /> : null}
    </div>
  );
}

const SETTINGS_NAV: Array<{
  group: string;
  items: Array<{ label: string; target: string }>;
}> = [
  {
    group: '模型服务',
    items: [{ label: '平台与模型', target: '模型服务' }]
  },
  {
    group: '会话与检索',
    items: [
      { label: '会话模型', target: '会话模型' },
      { label: 'Embedding / Rerank', target: 'Embedding 与 Rerank' },
      { label: '联网搜索', target: '联网搜索' }
    ]
  },
  { group: '翻译', items: [{ label: '翻译', target: '翻译' }] },
  {
    group: '交互',
    items: [
      { label: '语音识别', target: '语音识别' },
      { label: '语音播报', target: '语音播报' },
      { label: '快捷键与阅读', target: '快捷键与阅读' }
    ]
  },
  { group: '文献来源', items: [{ label: '从 Zotero 导入', target: 'Zotero（第三方服务）连接' }] },
  {
    group: 'PDF 与文字识别',
    items: [{ label: '识别方式与服务', target: 'PDF 与文字识别' }]
  },
  {
    group: '数据与更新',
    items: [
      { label: '数据与维护', target: '数据与维护' },
      { label: '关于与更新', target: '关于与更新' }
    ]
  }
];

/** 一个导航页可以包含多个旧分区，避免「备份/资料位置/诊断/迁移/声明」各自只剩一个按钮。 */
const SECTION_GROUPS: Record<string, string[]> = {
  数据与维护: [
    '使用引导',
    '资料位置',
    '数据备份',
    '清空全部本地数据',
    '诊断与维护',
    '从旧版迁移数据',
    '第三方许可与声明'
  ],
  关于与更新: ['关于与更新', '使用须知与隐私说明']
};

// 视觉读页一次最多解读多少页（与 reading.visual_max_pages 的范围一致）。
const VISUAL_MAX_PAGES_INPUT = 32;

export function SettingsView({
  api,
  adapter,
  onBack,
  onShowGuide,
  onUserDataCleared
}: {
  api: ApiClient;
  adapter: RuntimeAdapter;
  onBack(): void;
  onShowGuide?(): void;
  /** 「清空全部本地数据」成功后通知外层清空当前文献选择与工作区状态。 */
  onUserDataCleared?(): void;
}): JSX.Element {
  return (
    <SettingsFeedbackProvider>
      <SettingsViewContent
        api={api}
        adapter={adapter}
        onBack={onBack}
        onShowGuide={onShowGuide}
        onUserDataCleared={onUserDataCleared}
      />
    </SettingsFeedbackProvider>
  );
}

function SettingsViewContent({
  api,
  adapter,
  onBack,
  onShowGuide,
  onUserDataCleared
}: {
  api: ApiClient;
  adapter: RuntimeAdapter;
  onBack(): void;
  onShowGuide?(): void;
  onUserDataCleared?(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  // 使用须知弹窗：与欢迎引导页共用同一个精简版说明；关闭时记录已读版本（不强制阻断）。
  const [usageNoticeOpen, setUsageNoticeOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // 只有“在遮罩上按下并在原地松开”才关闭；拖动窗口/面板缩放手柄后松开不应误关。
  const backdropStartRef = useRef<{ x: number; y: number } | null>(null);
  // 键盘可达性：打开聚焦关闭按钮；Esc 关闭；Tab 焦点限制在对话框内；关闭后恢复原焦点。
  useEffect(() => {
    const root = settingsRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const focusables = (): HTMLElement[] => {
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 使用须知弹窗叠在设置之上时由它自己处理 Esc（先关弹窗，不误关设置）。
        if (root?.querySelector('[data-usage-notice]')) return;
        event.preventDefault();
        onBack();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    // 背景 inert：设置打开期间，Tab/点击/读屏都不应到达背后的侧栏与阅读区；
    // 设置遮罩是 .kr-app-shell 的直接子元素，其余兄弟节点统一 inert，关闭时恢复。
    const shell = root?.closest('.kr-app-shell');
    const inerted: HTMLElement[] = [];
    if (shell) {
      for (const child of Array.from(shell.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.contains(root)) continue;
        if (child.hasAttribute('inert')) continue;
        child.setAttribute('inert', '');
        inerted.push(child);
      }
    }
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const element of inerted) element.removeAttribute('inert');
      previouslyFocused?.focus?.();
    };
  }, [onBack]);
  const [activeSection, setActiveSection] = useState('模型服务');
  useLayoutEffect(() => {
    const root = settingsRef.current;
    if (!root) return;
    root.querySelector<HTMLElement>('.kr-settings__content')?.scrollTo({ top: 0 });
  }, [activeSection]);
  useLayoutEffect(() => {
    const root = settingsRef.current;
    if (!root) return;
    const targets = SECTION_GROUPS[activeSection] ?? [activeSection];
    for (const section of root.querySelectorAll<HTMLElement>(
      '.kr-settings__content > .kr-settings__section'
    )) {
      const heading = section.querySelector('h2')?.textContent?.trim() ?? '';
      const show = targets.some((target) => heading === target || heading.includes(target));
      section.style.display = show ? '' : 'none';
    }
  }, [activeSection]);
  const [legacyPath, setLegacyPath] = useState('');
  const [autoOcr, setAutoOcr] = useState(false);
  // 视觉读页：把图表/公式/结构页交给视觉模型做派生解读（不是逐字原文）。
  const [visualEnabled, setVisualEnabled] = useState(false);
  const [visualUseOcrModel, setVisualUseOcrModel] = useState(true);
  const [visualMaxPagesInput, setVisualMaxPagesInput] = useState('8');
  const [visualConnectionId, setVisualConnectionId] = useState('');
  const [visualModelName, setVisualModelName] = useState('');
  const [parsingMode, setParsingMode] = useState<ParsingConfigRecord['mode']>('local');
  const [parsingUrl, setParsingUrl] = useState('');
  const [parsingModel, setParsingModel] = useState('');
  // 视觉模型要从「模型服务」里挑，必须同时记住那条连接的 id：只说模型名的话，
  // 识别时就不知道去哪个服务地址、用哪个密钥。
  const [parsingConnectionId, setParsingConnectionId] = useState('');
  const [parsingKey, setParsingKey] = useState('');
  const [parsingClearKey, setParsingClearKey] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  // 本机 Tesseract 语言包：选中的语言（与 parsing.ocr_langs 同步）、下载状态与提示。
  const [ocrLangs, setOcrLangs] = useState<string[]>(DEFAULT_OCR_LANGS);
  const [ocrLanguageMessage, setOcrLanguageMessage] = useState('');
  const [ocrDownloading, setOcrDownloading] = useState(false);
  const [zoteroMode, setZoteroMode] = useState<'local' | 'cloud' | 'webdav'>('local');
  const [zoteroType, setZoteroType] = useState<'users' | 'groups'>('users');
  const [zoteroId, setZoteroId] = useState('0');
  const [zoteroKey, setZoteroKey] = useState('');
  const [webdavUrl, setWebdavUrl] = useState('');
  const [webdavUser, setWebdavUser] = useState('');
  const [webdavPassword, setWebdavPassword] = useState('');
  const [searchProvider, setSearchProvider] = useState<'deepseek' | 'tavily'>('deepseek');
  const [searchBaseUrl, setSearchBaseUrl] = useState('');
  const [searchPermission, setSearchPermission] = useState<'off' | 'review' | 'auto'>('review');
  const [searchPrivacyMode, setSearchPrivacyMode] = useState<
    'keywords-only' | 'question' | 'scope'
  >('keywords-only');
  const [searchPlanner, setSearchPlanner] = useState(true);
  const [searchFollowup, setSearchFollowup] = useState(true);
  const [searchAllow, setSearchAllow] = useState({
    question: true,
    history: true,
    selection: true,
    notes: false,
    annotations: false,
    answer: false,
    document: false,
    currentPage: false,
    surrounding: false,
    title: true
  });
  const [searchKey, setSearchKey] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ title: string; url: string; snippet: string }>>([]);
  const [ttsMode, setTtsMode] = useState<'system' | 'model' | 'custom'>('system');
  const [ttsUrl, setTtsUrl] = useState('');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsVoice, setTtsVoice] = useState('');
  const [voiceOptions, setVoiceOptions] = useState<string[]>([]);
  // 「获取音色」返回的展示名、来源说明，以及拿到列表时所针对的平台/模型/地址。
  // 用 context 对比当前选择：用过期的列表选音色时如实提示「可能不适用」。
  const [voiceLabels, setVoiceLabels] = useState<Record<string, string>>({});
  const [voiceInfo, setVoiceInfo] = useState<{
    context: string;
    source: string;
    message: string;
  } | null>(null);
  const [ttsKey, setTtsKey] = useState('');
  const [asrMode, setAsrMode] = useState<'system' | 'model' | 'custom'>('system');
  const [asrUrl, setAsrUrl] = useState('');
  const [asrModel, setAsrModel] = useState('');
  const [asrKey, setAsrKey] = useState('');
  const [asrConnectionId, setAsrConnectionId] = useState('');
  const [ttsConnectionId, setTtsConnectionId] = useState('');
  const [autoSend, setAutoSend] = useState(false);
  const [autoRead, setAutoRead] = useState(false);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [triggerMode, setTriggerMode] = useState<'hold' | 'click'>('hold');
  const [directAudio, setDirectAudio] = useState(false);
  const [correction, setCorrection] = useState(true);
  const [correctionContext, setCorrectionContext] = useState(false);
  const [zoteroDocumentId, setZoteroDocumentId] = useState('');
  // 保存/操作反馈统一走 SettingsFeedbackProvider 的 toast：同一位置、同一时长、同一套成功/失败样式。
  const { notify } = useSettingsFeedback();
  const [migration, setMigration] = useState<string | null>(null);
  // 浏览器/Electron 能力探测：不支持时在语音区如实说明（麦克风按钮会保持禁用）。
  const recordingSupport = mediaRecordingSupport();

  /* ---- 清空全部本地数据：二次确认（勾选 + 输入「清空」）后调用服务端 ---- */
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [clearDataAck, setClearDataAck] = useState(false);
  const [clearDataConfirmText, setClearDataConfirmText] = useState('');
  const [clearDataError, setClearDataError] = useState('');
  const [clearDataRemoved, setClearDataRemoved] = useState<
    ClearUserDataResult['removed'] | null
  >(null);
  const clearUserData = useMutation({
    mutationFn: () => api.clearUserData(),
    onSuccess: (result) => {
      const removed = result.removed;
      setClearDataError('');
      setClearDataOpen(false);
      setClearDataAck(false);
      setClearDataConfirmText('');
      setClearDataRemoved(removed);
      notify(
        `已清空本机用户数据：文献 ${removed.documents} 篇、笔记 ${removed.notes} 条、批注 ${removed.annotations} 条、会话 ${removed.sessions} 个（消息 ${removed.messages} 条）、译文 ${removed.translations} 条、图片资源 ${removed.note_assets} 个、备份 ${removed.backups} 份。`
      );
      // 服务端已删除数据，界面缓存必须整体失效，避免继续展示已删除的文献/笔记。
      void queryClient.invalidateQueries();
      // userData 下的渲染/更新日志不在资料目录；有壳能力时顺带清掉（best-effort）。
      void adapter.clearUserDataLogs?.().catch(() => {});
      onUserDataCleared?.();
    },
    onError: (error: Error) => {
      setClearDataError(`清空失败：${error.message}`);
      notify(`清空失败：${error.message}`, 'error');
    }
  });

  /* ---- 使用须知完整版：优先安装包内 legal/USAGE-NOTICE.md，回退仓库文档 ---- */
  const openNoticeDoc = async (): Promise<void> => {
    const result = await openExternalLink(adapter, USAGE_NOTICE_DOC_URL);
    if (!result.ok) {
      notify(result.message ?? '无法打开链接，请复制链接在浏览器中打开。', 'error');
    }
  };
  const openFullUsageNotice = async (): Promise<void> => {
    if (adapter.openUsageNotice) {
      try {
        const local = await adapter.openUsageNotice();
        if (local.ok) return;
      } catch {
        // 回退到仓库文档
      }
    }
    await openNoticeDoc();
  };
  const usageNoticeRead = hasReadCurrentUsageNotice();
  const usageNoticeAcknowledged = hasAcknowledgedCurrentUsageNotice();

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings()
  });

  const embeddingQuery = useQuery({
    queryKey: ['embedding-status'],
    queryFn: () => api.getEmbeddingStatus()
  });

  const parsingQuery = useQuery({
    queryKey: ['parsing-config'],
    queryFn: () => api.getParsingConfig()
  });

  // 本机 OCR 语言包：目录/安装状态/当前选择（不联网）；仅本机识别方式需要。
  const ocrLanguagesQuery = useQuery({
    queryKey: ['ocr-language-status'],
    queryFn: () => api.getOcrLanguages(),
    enabled: parsingMode === 'local'
  });

  const backupQuery = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.listBackups()
  });

  const dataLocationQuery = useQuery({
    queryKey: ['data-location'],
    queryFn: async () => (adapter.getDataLocation ? adapter.getDataLocation() : null),
    enabled: Boolean(adapter.getDataLocation)
  });

  const zoteroQuery = useQuery({
    queryKey: ['zotero-config'],
    queryFn: () => api.getZoteroConfig()
  });

  useEffect(() => {
    if (!zoteroQuery.data) return;
    setZoteroMode(zoteroQuery.data.mode);
    setZoteroType(zoteroQuery.data.library_type);
    setZoteroId(zoteroQuery.data.library_id);
    setWebdavUrl(zoteroQuery.data.webdav_url);
    setWebdavUser(zoteroQuery.data.webdav_user);
  }, [zoteroQuery.data]);

  const zoteroPayload = (overrides: Record<string, unknown> = {}) => ({
    mode: zoteroMode,
    library_type: zoteroType,
    library_id: zoteroId,
    webdav_url: webdavUrl,
    webdav_user: webdavUser,
    ...(webdavPassword.trim() ? { webdav_password: webdavPassword.trim() } : {}),
    ...(zoteroKey.trim() ? { api_key: zoteroKey.trim() } : {}),
    ...overrides
  });

  const saveZotero = useMutation({
    mutationFn: () => api.updateZoteroConfig(zoteroPayload()),
    onSuccess: () => {
      setZoteroKey('');
      setWebdavPassword('');
      void queryClient.invalidateQueries({ queryKey: ['zotero-config'] });
      notify('Zotero（第三方服务）设置已保存。');
    },
    onError: (error: Error) => notify(`Zotero（第三方服务）设置保存失败：${error.message}`)
  });

  /**
   * 保存并检查连接：个人资料库会先用 API Key 查到的数字 userID 自动校正资料库 ID。
   * 之前用户在「数字资料库 ID」里填了 1，Zotero 云端会直接 403，看起来像 Key 权限问题。
   */
  const checkZotero = useMutation({
    mutationFn: async () => {
      await api.updateZoteroConfig(zoteroPayload());
      let result = await api.testZotero();
      let corrected = '';
      if (!result.ok && zoteroMode !== 'local' && zoteroType === 'users') {
        try {
          const diagnosis = await api.diagnoseZotero();
          const suggested = (diagnosis.suggested_library_id ?? '').trim();
          if (suggested && /^\d+$/.test(suggested) && suggested !== zoteroId) {
            await api.updateZoteroConfig(zoteroPayload({ library_id: suggested }));
            setZoteroId(suggested);
            result = await api.testZotero();
            corrected = suggested;
          }
        } catch {
          // 查不到账户信息时保留原始失败信息。
        }
      }
      return { result, corrected };
    },
    onSuccess: ({ result, corrected }) => {
      setZoteroKey('');
      setWebdavPassword('');
      void queryClient.invalidateQueries({ queryKey: ['zotero-config'] });
      notify(
        result.ok
          ? `Zotero（第三方服务）连接成功：${result.mode}，${result.latencyMs} ms${
              corrected ? `；已按 API Key 自动校正数字资料库 ID 为 ${corrected}` : ''
            }`
          : `Zotero（第三方服务）连接失败：${result.message}`
      );
    },
    onError: (error: Error) => notify(`Zotero（第三方服务）连接失败：${error.message}`)
  });

  const zoteroItemsQuery = useQuery({
    queryKey: ['zotero-items'],
    queryFn: () => api.listZoteroItems('', 0),
    enabled: false
  });

  const openZotero = useMutation({
    mutationFn: (key: string) => api.openZoteroItem(key),
    onSuccess: (document) => {
      setZoteroDocumentId(document.id);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      notify(`已打开 Zotero 文献：${document.name}`);
    },
    onError: (error: Error) => notify(`打开 Zotero 文献失败：${error.message}`)
  });

  const zoteroAnnotations = useMutation({
    mutationFn: (preview: boolean) =>
      preview
        ? api.previewZoteroAnnotations(zoteroDocumentId)
        : api.importZoteroAnnotations(zoteroDocumentId),
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ['annotations'] });
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      notify(`${report.message}${report.warnings.length ? `；${report.warnings[0]}` : ''}`);
    },
    onError: (error: Error) => notify(`Zotero 批注与笔记处理失败：${error.message}`)
  });

  const snapshotZotero = useMutation({
    mutationFn: () => api.snapshotZoteroDocument(zoteroDocumentId),
    onSuccess: (document) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      notify(`已保存本机副本：${document.name}`);
    },
    onError: (error: Error) => notify(`保存本机副本失败：${error.message}`)
  });

  const speechQuery = useQuery({
    queryKey: ['speech-config'],
    queryFn: () => api.getSpeechConfig()
  });
  const speechServicesQuery = useQuery({
    queryKey: ['model-services'],
    queryFn: () => api.getModelServices()
  });
  const visionModels = (speechServicesQuery.data?.connections ?? []).flatMap((connection) =>
    connection.models
      .filter((model) => model.capabilities.includes('chat'))
      .map((model) => ({ connection, model }))
  );
  // 视觉读页可选的模型：显式「视觉」或「全模态」能力；全模态同时承担会话/视觉/音频。
  const visualModelOptions = (speechServicesQuery.data?.connections ?? []).flatMap(
    (connection) =>
      connection.models
        .filter(
          (model) =>
            model.capabilities.includes('vision') || model.capabilities.includes('omni')
        )
        .map((model) => ({ connection, model }))
  );
  useEffect(() => {
    const routing = speechServicesQuery.data?.routing;
    const assigned = routing?.vision ?? routing?.omni;
    if (assigned) {
      setVisualConnectionId(assigned.connectionId);
      setVisualModelName(assigned.model);
    }
  }, [speechServicesQuery.data]);
  const hasAudioModel = (speechServicesQuery.data?.connections ?? []).some((connection) =>
    connection.models.some(
      (model) =>
        model.capabilities.includes('audio') || model.capabilities.includes('omni')
    )
  );
  // 直接语音输入只列「已配置的全模态/音频模型」，用户不需要再选识别方式或纠错流程。
  const audioModelOptions = (speechServicesQuery.data?.connections ?? []).flatMap(
    (connection) =>
      connection.models
        .filter(
          (model) =>
            model.capabilities.includes('audio') || model.capabilities.includes('omni')
        )
        .map((model) => ({ connection, model }))
  );
  // 语音识别/播报的「模型服务」模式：只列真的有对应能力的平台与模型。
  // 否则选中一个没有 TTS 模型的平台后，模型下拉框里只剩“选择模型”，看起来像没保存。
  const asrPlatforms = (speechServicesQuery.data?.connections ?? []).filter((connection) =>
    connection.models.some((model) => model.capabilities.includes('asr'))
  );
  const asrModelOptions =
    asrPlatforms
      .find((connection) => connection.id === asrConnectionId)
      ?.models.filter((model) => model.capabilities.includes('asr')) ?? [];
  const ttsPlatforms = (speechServicesQuery.data?.connections ?? []).filter((connection) =>
    connection.models.some((model) => model.capabilities.includes('tts'))
  );
  const ttsModelOptions =
    ttsPlatforms
      .find((connection) => connection.id === ttsConnectionId)
      ?.models.filter((model) => model.capabilities.includes('tts')) ?? [];
  // 已保存的连接若后来被删掉/改了能力，仍要能显示“当前是哪个平台”，不能直接退回占位选项。
  const speechConnections = speechServicesQuery.data?.connections ?? [];
  const asrConnectionName =
    speechConnections.find((connection) => connection.id === asrConnectionId)?.name ?? '';
  const ttsConnectionName =
    speechConnections.find((connection) => connection.id === ttsConnectionId)?.name ?? '';

  useEffect(() => {
    if (!speechQuery.data) return;
    setTtsMode(speechQuery.data.tts_mode);
    setTtsUrl(speechQuery.data.tts_url);
    setTtsModel(speechQuery.data.tts_model);
    setTtsVoice(speechQuery.data.voice);
    setAsrMode(speechQuery.data.asr_mode);
    setAsrUrl(speechQuery.data.asr_url);
    setAsrModel(speechQuery.data.asr_model);
    setAsrConnectionId(speechQuery.data.asr_connection_id);
    setTtsConnectionId(speechQuery.data.tts_connection_id);
    setAutoSend(speechQuery.data.auto_send);
    setAutoRead(speechQuery.data.auto_read);
    setInputEnabled(speechQuery.data.input_enabled);
    setTriggerMode(speechQuery.data.trigger_mode);
    setDirectAudio(speechQuery.data.direct_audio);
    setCorrection(speechQuery.data.correction);
    setCorrectionContext(speechQuery.data.context);
  }, [speechQuery.data]);

  // 旧版本在「模型服务」模式下只保存了语音模型名（没有 connection_id），或者连接后来
  // 被删掉：界面看似「配置了模型」，获取音色却会回退到旧的 TTS 地址（常见是 MiMo）。
  // 这里按「模型服务 → 语音播报」的分配补齐平台与模型，只补一次，不覆盖用户后续选择。
  const adoptedRoutingTts = useRef(false);
  useEffect(() => {
    if (adoptedRoutingTts.current) return;
    if (!speechQuery.data || !speechServicesQuery.data) return;
    adoptedRoutingTts.current = true;
    if (speechQuery.data.tts_mode !== 'model') return;
    const savedConnection = speechConnections.find(
      (connection) => connection.id === speechQuery.data.tts_connection_id
    );
    if (savedConnection?.models.some((model) => model.capabilities.includes('tts'))) return;
    const assignment = speechServicesQuery.data.routing?.tts;
    if (!assignment) return;
    const connection = speechConnections.find(
      (item) =>
        item.id === assignment.connectionId &&
        item.models.some((model) => model.capabilities.includes('tts'))
    );
    if (!connection) return;
    const model =
      connection.models.find((item) => item.name === assignment.model)?.name ||
      connection.models.find((item) => item.capabilities.includes('tts'))?.name ||
      '';
    setTtsConnectionId(connection.id);
    if (model) setTtsModel(model);
  }, [speechQuery.data, speechServicesQuery.data, speechConnections]);

  const searchQueryConfig = useQuery({
    queryKey: ['search-config'],
    queryFn: () => api.getSearchConfig()
  });

  useEffect(() => {
    if (!searchQueryConfig.data) return;
    setSearchProvider(searchQueryConfig.data.provider);
    setSearchBaseUrl(searchQueryConfig.data.base_url);
    setSearchPermission(searchQueryConfig.data.permission);
    setSearchPlanner(searchQueryConfig.data.planner);
    setSearchPrivacyMode(searchQueryConfig.data.privacy_mode);
    setSearchFollowup(searchQueryConfig.data.followup);
    setSearchAllow({
      question: searchQueryConfig.data.allow_question,
      history: searchQueryConfig.data.allow_history,
      selection: searchQueryConfig.data.allow_selection,
      notes: searchQueryConfig.data.allow_notes,
      annotations: searchQueryConfig.data.allow_annotations,
      answer: searchQueryConfig.data.allow_answer,
      document: searchQueryConfig.data.allow_document,
      currentPage: searchQueryConfig.data.allow_current_page,
      surrounding: searchQueryConfig.data.allow_surrounding,
      title: searchQueryConfig.data.allow_title
    });
  }, [searchQueryConfig.data]);

  const saveSearch = useMutation({
    mutationFn: () =>
      api.updateSearchConfig({
        provider: searchProvider,
        base_url: searchBaseUrl,
        permission: searchPermission,
        privacy_mode: searchPrivacyMode,
        planner: searchPlanner,
        followup: searchFollowup,
        allow_question: searchAllow.question,
        allow_history: searchAllow.history,
        allow_selection: searchAllow.selection,
        allow_notes: searchAllow.notes,
        allow_annotations: searchAllow.annotations,
        allow_answer: searchAllow.answer,
        allow_document: searchAllow.document,
        allow_current_page: searchAllow.currentPage,
        allow_surrounding: searchAllow.surrounding,
        allow_title: searchAllow.title,
        ...(searchKey.trim() ? { api_key: searchKey.trim() } : {})
      }),
    onSuccess: () => {
      setSearchKey('');
      void queryClient.invalidateQueries({ queryKey: ['search-config'] });
      notify('联网搜索设置已保存。');
    },
    onError: (error: Error) => notify(`联网搜索设置保存失败：${error.message}`, 'error')
  });

  const runSearch = useMutation({
    mutationFn: () => api.searchWeb(searchQuery.trim()),
    onSuccess: (results) => {
      setSearchResults(results);
      notify(`搜索到 ${results.length} 条结果。`);
    },
    onError: (error: Error) => notify(`联网搜索失败：${error.message}`)
  });

  // 当前「获取音色」的目标：模式 + 平台连接 + 模型 + 服务地址。列表与音色都绑定在这个
  // 目标上；切换目标后旧的音色选项不能继续用（否则保存后播报会拿错平台的音色）。
  const ttsVoiceContextKey =
    ttsMode === 'model'
      ? `model|${ttsConnectionId}|${ttsModel}`
      : ttsMode === 'system'
        ? 'system'
        : `custom|${ttsUrl.trim()}|${ttsModel.trim()}`;
  const voiceInfoStale = Boolean(voiceInfo && voiceInfo.context !== ttsVoiceContextKey);

  const resetVoicesForTargetChange = (message: string): void => {
    setVoiceOptions([]);
    setVoiceLabels({});
    setVoiceInfo(null);
    if (ttsVoice.trim()) {
      setTtsVoice('');
      notify(`${message}，旧音色已清空，请重新「获取音色」后再选择。`);
    }
  };

  const loadVoices = useMutation({
    mutationFn: async () => {
      if (ttsMode === 'model' && !ttsConnectionId.trim()) {
        throw new Error('请先在「语音平台」中选择平台，再获取音色。');
      }
      if (ttsMode === 'custom' && !ttsUrl.trim()) {
        throw new Error('请先填写 TTS 服务地址，再获取音色。');
      }
      const context = ttsVoiceContextKey;
      // 必须显式传 mode（和当前已保存配置无关），并给 model 传空串而不是省略：
      // 否则服务端会把空的 connection/model 当“没传”，回退到旧配置（MiMo）。
      const result = await api.getSpeechVoices(
        ttsMode === 'model'
          ? { mode: 'model', connectionId: ttsConnectionId, model: ttsModel }
          : ttsMode === 'system'
            ? { mode: 'system' }
            : { mode: 'custom', url: ttsUrl.trim(), model: ttsModel.trim() }
      );
      return { result, context };
    },
    onSuccess: ({ result, context }) => {
      setVoiceOptions(result.voices);
      setVoiceLabels(result.labels ?? {});
      setVoiceInfo({
        context,
        source: result.source ?? '',
        message: result.message ?? ''
      });
      const keep = ttsVoice.trim();
      const stale = keep && result.voices.length > 0 && !result.voices.includes(keep);
      notify(
        result.voices.length > 0
          ? `已获取 ${result.voices.length} 个音色${
              result.source ? `（来源：${result.source}）` : ''
            }${stale ? `；当前音色「${keep}」不在列表中，请重新选择` : ''}。`
          : result.message ?? '没有获取到音色，可手动填写。'
      );
    },
    onError: (error: Error) => {
      setVoiceOptions([]);
      setVoiceLabels({});
      setVoiceInfo(null);
      notify(`获取音色失败：${error.message}`, 'error');
    }
  });

  const changeDataLocation = useMutation({    mutationFn: async () => {      if (!adapter.changeDataLocation) throw new Error('当前运行环境不支持更改资料位置');
      return adapter.changeDataLocation();
    },
    onSuccess: (result) => {
      notify(result.message);
    },
    onError: (error: Error) => notify(`更改资料位置失败：${error.message}`)
  });

  const saveSpeech = useMutation({    mutationFn: () =>
      api.updateSpeechConfig({
        asr_mode: asrMode,
        asr_url: asrUrl,
        asr_model: asrModel,
        asr_connection_id: asrConnectionId,
        tts_connection_id: ttsConnectionId,
        input_enabled: inputEnabled,
        auto_send: autoSend,
        auto_read: autoRead,
        trigger_mode: triggerMode,
        direct_audio: directAudio,
        correction,
        context: correctionContext,
        tts_mode: ttsMode,
        tts_url: ttsUrl,
        tts_model: ttsModel,
        voice: ttsVoice,
        ...(asrKey.trim() ? { asr_key: asrKey.trim() } : {}),
        ...(ttsKey.trim() ? { tts_key: ttsKey.trim() } : {})
      }),
    onSuccess: (saved) => {
      setTtsKey('');
      setAsrKey('');
      void queryClient.invalidateQueries({ queryKey: ['speech-config'] });
      void queryClient.invalidateQueries({ queryKey: ['model-services'] });
      // 保存回执写清「实际生效」的播报目标与音色：否则用户只看到“已保存”，
      // 无法确认模型/音色是否真的换了（本次 bug 13 的反馈点）。
      const modeLabel =
        saved.tts_mode === 'system'
          ? '系统语音'
          : saved.tts_mode === 'model'
            ? '模型服务'
            : '自定义服务';
      const target =
        saved.tts_mode === 'system'
          ? 'Windows 系统语音'
          : saved.tts_mode === 'model'
            ? `${ttsConnectionName || saved.tts_connection_id || '未选择平台'}${
                saved.tts_model ? ` / ${saved.tts_model}` : ''
              }`
            : saved.tts_url || '未填写地址';
      notify(
        `语音设置已保存：播报方式 ${modeLabel}，目标 ${target}，音色 ${saved.voice || '默认音色'}。`
      );
    },
    onError: (error: Error) => notify(`语音设置保存失败：${error.message}`)
  });

  // 语音系统自检：只读本机 Windows 语音组件信息，不发送音频/文本。
  const [speechSystem, setSpeechSystem] = useState<SpeechSystemStatus | null>(null);
  const checkSpeechSystem = useMutation({
    mutationFn: () => api.getSpeechSystemStatus(),
    onMutate: () => setSpeechSystem(null),
    onSuccess: (result) => {
      setSpeechSystem(result);
      // 系统自检顺手把本机音色填进下拉（仅在系统播报模式下），用户不必再点一次
      // 「获取音色」；不会改动用户已经选中的音色。
      if (ttsMode === 'system') {
        setVoiceOptions(result.tts_voices);
        setVoiceLabels({});
        setVoiceInfo({
          context: 'system',
          source: '系统语音',
          message: result.message
        });
      }
    },
    onError: (error: Error) =>
      setSpeechSystem({
        platform: '',
        ok: false,
        tts_voices: [],
        asr_languages: [],
        message: `语音自检失败：${error.message}`,
        detail: []
      })
  });

  // 「当前播报配置」摘要：模式/平台/模型/音色/可用性。播报按钮读的是**已保存**配置，
  // 所以这里把表单值与已保存值对比，提示“未保存的修改”，避免用户以为改了没生效。
  const ttsModeLabel =
    ttsMode === 'system' ? '系统语音' : ttsMode === 'model' ? '模型服务' : '自定义服务';
  const ttsPlatformLabel =
    ttsMode === 'system'
      ? 'Windows 系统语音'
      : ttsMode === 'model'
        ? ttsConnectionName ||
          (ttsConnectionId ? '已保存的平台（不在模型服务列表中）' : '未选择平台')
        : ttsUrl.trim() || '未填写地址';
  const ttsModelLabel =
    ttsMode === 'system'
      ? '系统默认（TTS 引擎自动选择）'
      : ttsMode === 'model' || ttsMode === 'custom'
        ? ttsModel.trim() || '未填写模型'
        : '';
  const ttsReadiness = ((): { ok: boolean; reasons: string[] } => {
    if (ttsMode === 'system') {
      if (!speechSystem) {
        return {
          ok: false,
          reasons: ['尚未做语音自检，无法确认本机 Windows 系统语音是否可用']
        };
      }
      if (!speechSystem.ok) return { ok: false, reasons: [speechSystem.message] };
      const systemVoice = ttsVoice.trim();
      if (
        systemVoice &&
        speechSystem.tts_voices.length > 0 &&
        !speechSystem.tts_voices.includes(systemVoice)
      ) {
        return {
          ok: false,
          reasons: [
            `当前音色「${systemVoice}」不在本机系统音色列表中，系统播报会失败；请重新选择系统音色或留空使用默认`
          ]
        };
      }
      return { ok: true, reasons: [] };
    }
    if (ttsMode === 'model') {
      const reasons: string[] = [];
      const connection = speechConnections.find((item) => item.id === ttsConnectionId);
      if (!ttsConnectionId.trim()) reasons.push('未选择语音平台');
      else if (!connection) reasons.push('所选的语音平台连接不存在（可能已删除），请重新选择');
      else {
        if (!connection.models.some((model) => model.capabilities.includes('tts'))) {
          reasons.push('所选平台没有标记「语音生成」能力的模型');
        }
        if (!ttsModel.trim()) reasons.push('未选择语音模型');
        else if (
          connection.models.length > 0 &&
          !connection.models.some(
            (model) =>
              model.name === ttsModel.trim() || model.id === ttsModel.trim()
          )
        ) {
          reasons.push('所选语音模型不属于当前平台，请重新选择');
        }
        if (connection.hasKey === false) reasons.push('该平台还没有保存 API Key');
      }
      return { ok: reasons.length === 0, reasons };
    }
    const reasons: string[] = [];
    if (!ttsUrl.trim()) reasons.push('未填写服务地址');
    if (!ttsModel.trim()) reasons.push('未填写模型');
    if (!speechQuery.data?.has_tts_key && !ttsKey.trim()) {
      reasons.push('未填写 API Key（部分自建服务可留空）');
    }
    return { ok: reasons.length === 0, reasons };
  })();
  const speechConfigDirty = Boolean(speechQuery.data) &&
    (speechQuery.data!.tts_mode !== ttsMode ||
      speechQuery.data!.tts_connection_id !== ttsConnectionId ||
      speechQuery.data!.tts_model !== ttsModel.trim() ||
      speechQuery.data!.tts_url !== ttsUrl.trim() ||
      speechQuery.data!.voice !== ttsVoice.trim());

  const diagnosticsQuery = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.getDiagnostics(),
    enabled: false
  });

  const diagnosticsPackagesQuery = useQuery({
    queryKey: ['diagnostics-packages'],
    queryFn: () => api.listDiagnosticsPackages()
  });

  const maintenanceStatusQuery = useQuery({
    queryKey: ['maintenance-status'],
    queryFn: () => api.getMaintenanceStatus()
  });

  // 图片资源占用统计：与笔记彻底删除共用 ['note-asset-usage']，删除后自动刷新。
  const noteAssetUsageQuery = useQuery({
    queryKey: ['note-asset-usage'],
    queryFn: () => api.getNoteAssetUsage()
  });

  // 手动重建资源索引：后台任务 + 轮询进度，避免阻塞 UI。
  const [reindexJob, setReindexJob] = useState<NoteAssetReindexJob | null>(null);
  const [reindexError, setReindexError] = useState('');
  const startReindex = useMutation({
    mutationFn: () => api.startNoteAssetReindex(),
    onSuccess: (job) => {
      setReindexError('');
      setReindexJob(job);
      // 任务极快完成时不会再进入轮询：这里补一次完成/失败处理。
      if (job.status === 'done') {
        void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
        void queryClient.invalidateQueries({ queryKey: ['settings'] });
        notify(
          `资源索引已重建：${job.indexedFiles} 个文件、${job.indexedRefs} 条引用。`
        );
      } else if (job.status === 'error') {
        const message = job.error || '重建资源索引失败';
        setReindexError(message);
        notify(message, 'error');
      }
    },
    onError: (error: Error) => {
      setReindexError(`启动重建资源索引失败：${error.message}`);
      notify(`启动重建资源索引失败：${error.message}`, 'error');
    }
  });

  // 重建中每 650ms 轮询状态；done/error 后停止并刷新统计。
  useEffect(() => {
    if (!reindexJob || reindexJob.status !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const job = await api.getNoteAssetReindexStatus();
        if (cancelled) return;
        setReindexJob(job);
        if (job.status === 'running') {
          timer = setTimeout(poll, 650);
          return;
        }
        if (job.status === 'done') {
          setReindexError('');
          void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
          void queryClient.invalidateQueries({ queryKey: ['settings'] });
          notify(
            `资源索引已重建：${job.indexedFiles} 个文件、${job.indexedRefs} 条引用。`
          );
        } else if (job.status === 'error') {
          const message = job.error || '重建资源索引失败';
          setReindexError(message);
          notify(message, 'error');
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '未知错误';
        setReindexError(`读取重建进度失败：${message}`);
        notify(`读取重建进度失败：${message}`, 'error');
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reindexJob?.status]);

  const rebuildNoteAssetIndex = (): void => {
    if (
      !appDialogs.confirm(
        '重建图片资源索引？会重新扫描所有笔记/批注内容，用于修复外部直接改数据库等造成的引用统计不一致。'
      )
    ) {
      return;
    }
    setReindexError('');
    setReindexJob(null);
    startReindex.mutate();
  };

  // 本地图片资源清理：先 dryRun 预览，确认后再正式清理。
  const [gcReport, setGcReport] = useState<NoteAssetGcReport | null>(null);
  const [gcError, setGcError] = useState('');
  const [gcBusy, setGcBusy] = useState(false);
  // 默认保护「只被已删除笔记/批注引用」的图片，避免恢复笔记后图片丢失。
  const [gcIncludeDeleted, setGcIncludeDeleted] = useState(true);

  // 笔记图片上限设置（note_image.max_mb / note_image.max_pixels）。
  const [noteImageMaxMb, setNoteImageMaxMb] = useState(String(DEFAULT_NOTE_IMAGE_MAX_MB));
  const [noteImageMaxMp, setNoteImageMaxMp] = useState(String(DEFAULT_NOTE_IMAGE_MAX_MP));
  const [noteImageLimitError, setNoteImageLimitError] = useState('');

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings) return;
    const maxMb = Number(settings['note_image.max_mb']);
    if (Number.isFinite(maxMb) && maxMb >= 1 && maxMb <= 20) {
      setNoteImageMaxMb(String(maxMb));
    }
    const maxPixels = Number(settings['note_image.max_pixels']);
    if (Number.isFinite(maxPixels) && maxPixels > 0) {
      setNoteImageMaxMp(String(maxPixels / 1_000_000));
    }
  }, [settingsQuery.data]);

  const saveNoteImageLimits = useMutation({
    mutationFn: async (input: { maxMb: number; maxPixels: number }) => {
      await api.updateSettings({
        'note_image.max_mb': String(input.maxMb),
        'note_image.max_pixels': String(input.maxPixels)
      });
    },
    onSuccess: () => {
      notify('笔记图片上限已保存；仅影响之后上传的图片，已有图片不受影响。');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: Error) => notify(`保存图片上限失败：${error.message}`, 'error')
  });

  const submitNoteImageLimits = (): void => {
    const maxMb = Number(noteImageMaxMb);
    const maxMp = Number(noteImageMaxMp);
    if (!Number.isFinite(maxMb) || maxMb < 1 || maxMb > 20) {
      setNoteImageLimitError('单图大小上限需在 1–20 MB 之间。');
      return;
    }
    if (!Number.isFinite(maxMp) || maxMp < 1 || maxMp > 25) {
      setNoteImageLimitError('单图像素上限需在 1–25 百万像素之间。');
      return;
    }
    setNoteImageLimitError('');
    saveNoteImageLimits.mutate({
      maxMb: Math.round(maxMb * 10) / 10,
      maxPixels: Math.round(maxMp * 1_000_000)
    });
  };

  const cleanNoteAssets = async (): Promise<void> => {
    if (gcBusy) return;
    setGcError('');
    setGcReport(null);
    setGcBusy(true);
    try {
      const includeDeleted = gcIncludeDeleted;
      const preview = await api.gcNoteAssets(true, includeDeleted);
      const confirmed = appDialogs.confirm(
        `将清理笔记/批注里插入的本地图片资源。\n\n只删除 24 小时以上、且没有被任何笔记或批注引用的文件（24 小时内的新文件会跳过）。\n\n${
          includeDeleted
            ? '已删除笔记/批注中引用的图片也会被保留（恢复笔记后图片不会丢）。'
            : '⚠ 未勾选「保留已删除笔记/批注引用的图片」：只被已删除内容引用的图片也会被清理，恢复笔记后这些图片可能缺失。'
        }\n\n可删除：${preview.deletedFiles} 个文件，可释放空间：${formatBytes(
          preview.bytesFreed
        )}。\n扫描：${preview.scannedFiles} 个文件，其中 ${preview.referencedFiles} 个仍被引用、${
          preview.skippedRecent
        } 个新文件会跳过。\n\n确认现在清理？`
      );
      if (!confirmed) return;
      const report = await api.gcNoteAssets(false, includeDeleted);
      setGcReport(report);
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      notify(
        `已清理 ${report.deletedFiles} 个未引用图片，释放 ${formatBytes(report.bytesFreed)}。`
      );
    } catch (error) {
      setGcError(error instanceof Error ? error.message : '清理未引用图片失败');
    } finally {
      setGcBusy(false);
    }
  };

  const copyDataDir = async (): Promise<void> => {
    const target = maintenanceStatusQuery.data?.data_dir;
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      notify('已复制数据目录路径。');
    } catch {
      notify(`复制失败，请手动复制：${target}`);
    }
  };

  const openDataDir = (): void => {
    const target = maintenanceStatusQuery.data?.data_dir ?? '';
    if (adapter.openDataLocation) {
      void adapter.openDataLocation().then((result) => {
        notify(result.ok ? result.message : `${result.message}（${target}）`);
      });
      return;
    }
    notify(`当前运行环境不支持自动打开文件管理器，请手动打开：${target}`);
  };

  const createDiagnosticsPackage = useMutation({
    mutationFn: () => api.createDiagnosticsPackage(),
    onSuccess: (result) => {
      notify(`已生成诊断包：${result.name}`);
      void queryClient.invalidateQueries({ queryKey: ['diagnostics-packages'] });
    },
    onError: (error: Error) => notify(`生成诊断包失败：${error.message}`)
  });

  const testModel = useMutation({
    mutationFn: () => api.testModel(),
    onSuccess: (result) =>
      notify(
        result.ok
          ? `模型连接成功：${result.model}，${result.latencyMs} ms`
          : `模型连接失败：${result.message}`
      )
  });

  // 备份任务：文件收集阶段可取消；zip 压缩期间任务会停在 zip 阶段。
  const [backupJob, setBackupJob] = useState<BackupJobRecord | null>(null);
  const backupActive =
    backupJob != null && ['queued', 'running', 'cancelling'].includes(backupJob.state);
  const backupStageLabel = (stage: string): string =>
    ({
      queued: '排队中',
      databases: '快照数据库',
      files: '收集文件',
      zip: '压缩',
      cancelling: '正在取消',
      done: '完成',
      cancelled: '已取消'
    })[stage] ?? stage;
  useEffect(() => {
    if (!backupJob || !backupActive) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.getBackupJob(backupJob.id);
          if (cancelled) return;
          if (next.state === 'done' || next.state === 'failed' || next.state === 'cancelled') {
            setBackupJob(null);
            if (next.state === 'done') {
              void queryClient.invalidateQueries({ queryKey: ['backups'] });
              notify(`备份已生成：${next.backup?.name ?? ''}`);
            } else if (next.state === 'cancelled') {
              notify('备份已取消。');
            } else {
              notify(`备份失败：${next.error?.message ?? '未知错误'}`, 'error');
            }
          } else {
            setBackupJob(next);
          }
        } catch (error) {
          if (cancelled) return;
          setBackupJob(null);
          notify(
            `备份任务状态读取失败：${error instanceof Error ? error.message : String(error)}`,
            'error'
          );
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [backupJob, backupActive, api, queryClient, notify]);

  const startBackup = async (): Promise<void> => {
    try {
      const { jobId } = await api.startBackupJob(false);
      setBackupJob({
        id: jobId,
        state: 'queued',
        progress: 0,
        stage: 'queued',
        startedAt: new Date().toISOString()
      });
    } catch (error) {
      notify(
        `备份启动失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  };

  const cancelBackup = async (): Promise<void> => {
    if (!backupJob) return;
    try {
      setBackupJob(await api.cancelBackupJob(backupJob.id));
    } catch (error) {
      notify(
        `取消备份失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  };

  const verifyBackup = useMutation({
    mutationFn: (name: string) => api.verifyBackup(name),
    onSuccess: (result) =>
      notify(
        `备份校验：${result.name}，${result.entries} 个条目，数据库 ${result.integrity}`
      ),
    onError: (error: Error) => notify(`备份校验失败：${error.message}`)
  });

  const restoreBackup = useMutation({
    mutationFn: (name: string) => api.restoreBackup(name),
    onSuccess: (result) =>
      notify(
        `已准备恢复 ${result.pending.backup}：请完全退出并重新启动应用后生效。`
      ),
    onError: (error: Error) => notify(`恢复准备失败：${error.message}`)
  });

  useEffect(() => {
    if (!parsingQuery.data) return;
    setAutoOcr(parsingQuery.data.auto_ocr);
    setParsingMode(parsingQuery.data.mode);
    setParsingUrl(parsingQuery.data.service_url);
    setParsingModel(parsingQuery.data.model);
    setParsingConnectionId(parsingQuery.data.connection_id);
    setAllowRemote(parsingQuery.data.allow_remote);
  }, [parsingQuery.data]);

  const saveParsing = useMutation({
    mutationFn: () =>
      api.updateParsingConfig({
        mode: parsingMode,
        connection_id: parsingConnectionId,
        service_url: parsingUrl.trim(),
        model: parsingModel.trim(),
        allow_remote: allowRemote,
        auto_ocr: autoOcr,
        ...(parsingKey.trim() ? { service_key: parsingKey.trim() } : {}),
        ...(parsingClearKey ? { clear_service_key: true } : {})
      }),
    onSuccess: () => {
      setParsingKey('');
      setParsingClearKey(false);
      void queryClient.invalidateQueries({ queryKey: ['parsing-config'] });
      notify('识别设置已保存。');
    },
    onError: (error: Error) => notify(`识别设置保存失败：${error.message}`)
  });

  // 语言选择与 parsing.ocr_langs 同步；旧配置没有该字段时默认 eng+chi_sim。
  useEffect(() => {
    if (!parsingQuery.data) return;
    const saved = parsingQuery.data.ocr_langs;
    setOcrLangs(Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_OCR_LANGS);
  }, [parsingQuery.data]);

  const ocrPollRef = useRef<number | null>(null);
  const stopOcrPolling = (): void => {
    if (ocrPollRef.current !== null) {
      window.clearInterval(ocrPollRef.current);
      ocrPollRef.current = null;
    }
  };
  // 卸载时清掉轮询，避免设置页关闭后还继续请求。
  useEffect(() => stopOcrPolling, []);

  const finishOcrDownload = (): void => {
    stopOcrPolling();
    setOcrDownloading(false);
    void queryClient.invalidateQueries({ queryKey: ['ocr-language-status'] });
  };

  const beginOcrPolling = (): void => {
    stopOcrPolling();
    setOcrDownloading(true);
    ocrPollRef.current = window.setInterval(() => {
      void api
        .getOcrLanguages()
        .then((status) => {
          queryClient.setQueryData(['ocr-language-status'], status);
          const job = status.job;
          if (job?.running) {
            setOcrLanguageMessage(`正在下载语言包：${job.done}/${job.total}`);
            return;
          }
          finishOcrDownload();
          if (job?.error) {
            setOcrLanguageMessage(
              `下载未完成：${job.error}（已下载的语言包会保留，可重试）`
            );
          } else {
            setOcrLanguageMessage('语言包下载完成。');
          }
        })
        .catch((error: unknown) => {
          finishOcrDownload();
          setOcrLanguageMessage(
            `下载状态查询失败：${error instanceof Error ? error.message : '未知错误'}`
          );
        });
    }, 1500);
  };

  // 打开设置时如果后台仍在下（例如下载中关闭又打开），继续显示进度。
  useEffect(() => {
    if (parsingMode !== 'local') {
      stopOcrPolling();
      setOcrDownloading(false);
      return;
    }
    const job = ocrLanguagesQuery.data?.job;
    if (job?.running) {
      beginOcrPolling();
    } else if (job?.error) {
      setOcrLanguageMessage(`上次下载未完成：${job.error}（已下载的语言包会保留）`);
    }
    // 只在“是否正在跑/识别方式”变化时触发，避免每次轮询都重启定时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsingMode, ocrLanguagesQuery.data?.job?.running]);

  const saveOcrLanguages = useMutation({
    mutationFn: () => api.updateParsingConfig({ ocr_langs: ocrLangs }),
    onSuccess: (config) => {
      queryClient.setQueryData(['parsing-config'], config);
      void queryClient.invalidateQueries({ queryKey: ['parsing-config'] });
      notify('语言选择已保存；下次识别会使用这些语言。');
    },
    onError: (error: Error) => notify(`保存语言选择失败：${error.message}`, 'error')
  });

  const downloadOcrLanguages = useMutation({
    mutationFn: (codes: string[]) => api.downloadOcrLanguages(codes),
    onMutate: () => setOcrLanguageMessage(''),
    onSuccess: (status) => {
      queryClient.setQueryData(['ocr-language-status'], status);
      const job = status.job;
      if (job && !job.running) {
        finishOcrDownload();
        setOcrLanguageMessage(
          job.error ? `下载未完成：${job.error}（已下载的语言包会保留，可重试）` : '语言包下载完成。'
        );
        return;
      }
      beginOcrPolling();
    },
    onError: (error: Error) => {
      finishOcrDownload();
      setOcrLanguageMessage(
        `下载失败：${error.message}（已下载的语言包会保留，可重试）`
      );
    }
  });

  const ocrPacks = ocrLanguagesQuery.data?.packs ?? [];
  const ocrPackByCode = new Map(ocrPacks.map((pack) => [pack.code, pack]));
  const ocrMissingCodes = ocrPacks
    .filter((pack) => ocrLangs.includes(pack.code) && !pack.installed)
    .map((pack) => pack.code);
  const ocrSelectedAllInstalled =
    ocrLangs.length > 0 && ocrLangs.every((code) => ocrPackByCode.get(code)?.installed);

  // 识别服务只读自检：结果来自本机配置，不发页面内容、不发起网络探测。
  const [parsingCheck, setParsingCheck] = useState<ParsingCheckResult | null>(null);  const checkParsing = useMutation({
    mutationFn: () => api.checkParsing(),
    onMutate: () => setParsingCheck(null),
    onSuccess: (result) => setParsingCheck(result),
    onError: (error: Error) =>
      setParsingCheck({
        mode: parsingMode,
        url: '',
        tier: '',
        ok: false,
        message: `检测失败：${error.message}`,
        detail: []
      })
  });

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings) return;
    setVisualEnabled(settings['reading.visual_enabled'] === 'true');
    setVisualUseOcrModel(settings['reading.visual_use_ocr_model'] !== 'false');
    setVisualMaxPagesInput(settings['reading.visual_max_pages'] ?? '8');
  }, [settingsQuery.data]);

  const indexEmbeddings = useMutation({
    mutationFn: () => api.indexEmbeddings(),
    onSuccess: (result) => {
      notify(
        result.external
          ? `外部 Embedding 缓存已预热：${result.indexed} 个片段（${result.model}）。`
          : '当前使用本地 TF-IDF，检索时即时计算，无需建立索引。'
      );
      void queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
    },
    onError: (error: Error) => notify(`建立索引失败：${error.message}`)
  });

  const saveVisualReading = useMutation({
    mutationFn: async (input: { enabled: boolean; useOcrModel: boolean; maxPages: number }) => {
      await api.updateSettings({
        'reading.visual_enabled': String(input.enabled),
        'reading.visual_use_ocr_model': String(input.useOcrModel),
        'reading.visual_max_pages': String(input.maxPages)
      });
      // 不复用 OCR 视觉模型时，把选择写进模型服务的「视觉读页」路由。
      if (
        (!input.useOcrModel || parsingMode !== 'vision') &&
        visualConnectionId &&
        visualModelName
      ) {
        const current = speechServicesQuery.data;
        await api.updateModelServices({
          connections: current?.connections ?? [],
          routing: {
            ...(current?.routing ?? {}),
            vision: { connectionId: visualConnectionId, model: visualModelName }
          }
        });
      }
    },
    onSuccess: () => {
      notify(
        '视觉读页设置已保存。视觉读页是派生解读（图表/公式/结构），引用时请回原页核对。'
      );
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['model-services'] });
    },
    onError: (error: Error) => {
      notify(`视觉读页设置保存失败：${error.message}`, 'error');
    }
  });

  const submitVisualReading = (): void => {
    const text = visualMaxPagesInput.trim();
    const pages = Number(text);
    if (!text || !Number.isInteger(pages) || pages < 1 || pages > VISUAL_MAX_PAGES_INPUT) {
      notify(`最多解读页数请填 1-${VISUAL_MAX_PAGES_INPUT} 的整数。`, 'error');
      return;
    }
    if (
      visualEnabled &&
      (!visualUseOcrModel || parsingMode !== 'vision') &&
      (!visualConnectionId || !visualModelName)
    ) {
      notify('请选择视觉读页使用的视觉模型，或改为复用视觉识别模型。', 'error');
      return;
    }
    saveVisualReading.mutate({
      enabled: visualEnabled,
      useOcrModel: visualUseOcrModel && parsingMode === 'vision',
      maxPages: pages
    });
  };

  const migrate = useMutation({
    mutationFn: () => api.migrateLegacy(legacyPath.trim()),
    onSuccess: (report) => {
      setMigration(
        `迁移完成：文档 ${report.documents}、片段 ${report.chunks}、批注 ${report.annotations}、` +
          `笔记 ${report.notes}、会话 ${report.messages}、设置 ${report.settings}、向量缓存 ${report.embeddings}、` +
          `翻译 ${report.translations}、页面编辑 ${report.pageEdits}、导航 ${report.navigation}、` +
          `页面遮罩 ${report.pageMasks}、阅读任务 ${report.readingTasks}、结构 ${report.structures}、` +
          `平台连接 ${report.connections}。` +
          (report.backupPath ? ` 迁移前备份：${report.backupPath}。` : '') +
          (report.skippedDocuments ? ` 跳过 ${report.skippedDocuments} 个找不到 PDF 的文档。` : '') +
          (report.warnings.length ? ` 提示：${report.warnings.join('；')}` : '')
      );
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
    },
    onError: (error: Error) => setMigration(`迁移失败：${error.message}`)
  });

  const scrollToSetting = (label: string) => {
    setActiveSection(label);
  };

  return (
    <div
      className="kr-settings-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        backdropStartRef.current =
          event.target === event.currentTarget
            ? { x: event.clientX, y: event.clientY }
            : null;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const start = backdropStartRef.current;
        backdropStartRef.current = null;
        if (!start) return;
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved <= 4) onBack();
      }}
    >
      <div
        className="kr-settings"
        ref={settingsRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
      <header className="kr-reader__bar">
        <span className="kr-reader__title">设置</span>
        <span className="kr-settings__bar-note">
          配置相应服务后，使用相关功能时会将相关内容发送至相应服务。
        </span>
        <button
          ref={closeButtonRef}
          type="button"
          className="kr-settings__close"
          aria-label="关闭设置"
          onClick={onBack}
        >
          ×
        </button>
      </header>

      <nav className="kr-settings__nav" aria-label="设置分区">
        {SETTINGS_NAV.map((group) => (
          <div className="kr-settings__nav-section" key={group.group}>
            <span className="kr-settings__nav-group">{group.group}</span>
            {group.items.map((item) => (
              <button
                key={item.target}
                type="button"
                className={activeSection === item.target ? 'is-active' : undefined}
                aria-current={activeSection === item.target ? 'page' : undefined}
                onClick={() => scrollToSetting(item.target)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="kr-settings__content">
      <p className="kr-muted">
        提示：模型、解析、翻译、联网搜索、语音、OCR 语言包以及 Zotero/WebDAV 等由对应外部服务提供；
        使用这些功能时相关内容会发送到对应服务，并需遵守其服务条款与隐私政策。
      </p>
      <ModelServicesPanel api={api} adapter={adapter} />

      <ModelUsagePanel
        api={api}
        kind="chat"
        inlineDescription="会话、阅读对话，以及选择交给模型规划时的联网搜索规划使用的模型。"
      />

      <section className="kr-settings__section">
        <SectionHeading
          title="Embedding 与 Rerank"
          note="语义检索与候选重排使用的模型。"
          hint="Embedding 用于语义检索，未选择时使用本地 TF-IDF；Rerank 用于重排候选片段，未选择时使用本地重排规则。两者可以分别选择，也可以都不启用。"
        />
        <SendingNotice text="启用 Embedding 或 Rerank 后，检索文本或候选片段会发送到相应服务。" />
        <div className="kr-settings__model-usage">
          <p>
            <strong>Embedding 当前用途：</strong>
            语义检索；覆盖台账的“维度—缺口命中页”匹配；语义反向召回。
            {embeddingQuery.data?.external
              ? ` 已启用外部模型（${embeddingQuery.data.model}）。`
              : ''}
          </p>
          <p>
            <strong>Rerank 当前用途：</strong>
            检索候选片段重排。
          </p>
        </div>
        <div className="kr-usage-pair">
          <ModelUsagePanel api={api} kind="embedding" inlineDescription="语义检索" />
          <ModelUsagePanel api={api} kind="rerank" inlineDescription="候选重排" />
        </div>
      </section>

      <TranslationSettingsPanel api={api} />

      <section className="kr-settings__section">
        <SectionHeading title="PDF 与文字识别" />
        <p className="kr-muted">配置扫描页的识别方式。</p>
        <div className="kr-settings__model-usage">
          <p>
            <strong>OCR 结果可能用于：</strong>
            读取无文本层扫描页的内容；把引用与批注定位到扫描页的具体文字行；
            生成目录时提供标题和章节判断所需的文字行框。
          </p>
        </div>
        <label>
          <span>识别方式</span>
          <select
            value={parsingMode}
            onChange={(event) => {
              const mode = event.target.value as ParsingConfigRecord['mode'];
              setParsingMode(mode);
              // 官方入口是固定的：选到 MinerU 时直接填好地址，避免用户以为还要手填。
              if (mode === 'mineru_online') {
                setParsingUrl('https://mineru.net/api/v4');
              } else if (mode === 'mineru_agent') {
                setParsingUrl('https://mineru.net/api/v1/agent');
              }
            }}
          >
            <option value="local">本机 Tesseract OCR（默认）</option>
            <option value="vision">视觉模型（/chat/completions）</option>
            <option value="custom">自定义解析服务（/parse）</option>
            <option value="mineru_online">MinerU 在线 · 精准解析（官方）</option>
            <option value="mineru_agent">MinerU 在线 · 轻量解析（官方）</option>
          </select>
        </label>
        {parsingMode !== 'local' ? (
          <SendingNotice text="在线识别会把相应内容发送到所选服务的服务器；选择该服务并点击识别即表示同意发送。若希望只在本机处理，请选择「本机 Tesseract OCR」。" />
        ) : null}
        {parsingMode === 'vision' ? (
          <label>
            <span>图像模型</span>
            <select
              value={
                parsingConnectionId && parsingModel
                  ? `${parsingConnectionId}\u001f${parsingModel}`
                  : ''
              }
              onChange={(event) => {
                const raw = event.target.value;
                const separator = raw.indexOf('\u001f');
                if (separator < 0) {
                  setParsingConnectionId('');
                  setParsingModel('');
                  return;
                }
                setParsingConnectionId(raw.slice(0, separator));
                setParsingModel(raw.slice(separator + 1));
              }}
            >
              <option value="">从模型服务中选择</option>
              {visionModels.map(({ connection, model }) => (
                <option
                  key={`${connection.id}:${model.id}`}
                  value={`${connection.id}\u001f${model.name}`}
                >
                  {connection.name} / {model.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {parsingMode === 'mineru_agent' ? (
          <p className="kr-muted">
            MinerU 轻量解析（Agent）使用官方固定入口，<strong>不需要 Token/API Key</strong>；
            识别时会把单页 PDF 上传到 MinerU 的服务器。
          </p>
        ) : null}
        {parsingMode === 'mineru_online' ? (
          <p className="kr-muted">
            MinerU 在线精准解析使用官方固定入口，需要在 mineru.net 申请 API Token；
            Token 只保存在本机并加密。
          </p>
        ) : null}
        {parsingMode !== 'local' && parsingMode !== 'vision' ? (
          <label>
            <span>识别服务地址</span>
            <input
              type="url"
              value={parsingUrl}
              onChange={(event) => setParsingUrl(event.target.value)}
              placeholder="http://127.0.0.1:8000"
              readOnly={parsingMode === 'mineru_online' || parsingMode === 'mineru_agent'}
            />
          </label>
        ) : null}
        {parsingMode !== 'local' &&
        parsingMode !== 'vision' &&
        parsingMode !== 'mineru_agent' ? (
          <label>
            <span>
              {parsingMode === 'mineru_online'
                ? 'MinerU API Token（必填，只存本机）'
                : '识别服务密钥（只存本机，可不填）'}
            </span>
            <input
              type="password"
              value={parsingKey}
              onChange={(event) => setParsingKey(event.target.value)}
              placeholder={parsingQuery.data?.has_key ? '已保存，留空保留' : '可留空'}
            />
          </label>
        ) : null}
        {parsingMode !== 'local' &&
        parsingMode !== 'vision' &&
        parsingMode !== 'mineru_agent' ? (
          <label className="kr-settings__check">
            <input
              type="checkbox"
              checked={parsingClearKey}
              onChange={(event) => setParsingClearKey(event.target.checked)}
            />
            清除已保存的识别服务密钥
          </label>
        ) : null}
        {parsingMode !== 'local' ? (
          <label className="kr-settings__check">
            <input
              type="checkbox"
              checked={allowRemote}
              onChange={(event) => setAllowRemote(event.target.checked)}
            />
            允许向所选远程服务发送页面图像
          </label>
        ) : null}
        <label className="kr-settings__check">
          <input
            type="checkbox"
            checked={autoOcr}
            onChange={(event) => setAutoOcr(event.target.checked)}
          />
          空文本页自动本机 OCR（默认关闭）
        </label>
        <div className="kr-settings__actions">
          <button
            type="button"
            onClick={() => saveParsing.mutate()}
            disabled={saveParsing.isPending}
          >
            {saveParsing.isPending ? '保存中…' : '保存识别设置'}
          </button>
          <button
            type="button"
            onClick={() => checkParsing.mutate()}
            disabled={checkParsing.isPending}
          >
            {checkParsing.isPending ? '检测中…' : '检测识别服务'}
          </button>
        </div>
        {parsingCheck ? (
          <div className="kr-settings__hint" role="status">
            <p>{parsingCheck.message}</p>
            <p>
              方式：{parsingCheck.mode || '未配置'}
              {parsingCheck.url ? `；地址：${parsingCheck.url}` : ''}
              {parsingCheck.tier ? `；层级：${parsingCheck.tier}` : ''}
            </p>
            {parsingCheck.detail.length > 0 ? (
              <details>
                <summary>检测详情</summary>
                <ul>
                  {parsingCheck.detail.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        {parsingMode === 'local' ? (
          <div className="kr-settings__model-usage">
            <SectionHeading
              title="本机 OCR 语言包"
              hint="本机 Tesseract 需要语言数据才能识别。语言包来自开源项目 tessdata_fast（Apache-2.0），只有点「下载所选语言包」才会联网下载；下载后缓存在本机数据目录，不随安装包分发，未安装的语言不能用于识别。"
            />
            <p className="kr-muted">
              语言包不随安装包分发；只有点「下载所选语言包」才会联网下载，下载后缓存在本机数据目录。
              来源 tesseract-ocr/tessdata_fast（Apache-2.0）。
            </p>
            {ocrLanguagesQuery.isLoading ? (
              <p className="kr-muted">正在读取语言包状态…</p>
            ) : ocrLanguagesQuery.isError ? (
              <p className="kr-page-error">
                读取语言包状态失败：{ocrLanguagesQuery.error.message}
              </p>
            ) : (
              <>
                <p className="kr-muted">
                  来源：
                  <a
                    href="https://github.com/tesseract-ocr/tessdata_fast"
                    target="_blank"
                    rel="noreferrer"
                  >
                    tesseract-ocr/tessdata_fast
                  </a>
                  （Apache-2.0）；下载位置：
                  {ocrLanguagesQuery.data?.dataDir || '本机数据目录'}
                </p>
                {ocrPacks.length === 0 ? (
                  <p className="kr-muted">接口没有返回可用语言包目录。</p>
                ) : (
                  <div className="kr-settings__actions" style={{ display: 'grid', gap: 6 }}>
                    {ocrPacks.map((pack) => (
                      <label className="kr-settings__check" key={pack.code}>
                        <input
                          type="checkbox"
                          checked={ocrLangs.includes(pack.code)}
                          disabled={ocrDownloading}
                          onChange={(event) =>
                            setOcrLangs((current) =>
                              event.target.checked
                                ? [...new Set([...current, pack.code])]
                                : current.filter((code) => code !== pack.code)
                            )
                          }
                        />
                        <span>
                          {pack.label || pack.code}（{pack.code}）·{' '}
                          {pack.installed
                            ? `已安装${pack.bytes ? ` · ${(pack.bytes / 1024 / 1024).toFixed(1)} MB` : ''}`
                            : '未安装'}
                          {' '}· {pack.source || 'tessdata_fast'} · {pack.license || 'Apache-2.0'}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="kr-settings__actions">
                  <button
                    type="button"
                    onClick={() => saveOcrLanguages.mutate()}
                    disabled={
                      ocrLangs.length === 0 ||
                      saveOcrLanguages.isPending ||
                      ocrDownloading
                    }
                  >
                    {saveOcrLanguages.isPending ? '保存中…' : '保存语言选择'}
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadOcrLanguages.mutate(ocrMissingCodes)}
                    disabled={
                      ocrLangs.length === 0 ||
                      ocrMissingCodes.length === 0 ||
                      ocrDownloading ||
                      downloadOcrLanguages.isPending
                    }
                  >
                    {ocrDownloading ? '下载中…' : '下载所选语言包'}
                  </button>
                </div>
                {ocrLangs.length === 0 ? (
                  <p className="kr-muted">请至少选择 1 种识别语言。</p>
                ) : null}
                {ocrSelectedAllInstalled && ocrPacks.length > 0 ? (
                  <p className="kr-muted">
                    所选语言包都已安装，无需重复下载；可直接保存语言选择。
                  </p>
                ) : null}
                {ocrDownloading && ocrLanguagesQuery.data?.job ? (
                  <p className="kr-muted" role="status">
                    正在下载语言包：{ocrLanguagesQuery.data.job.done}/
                    {ocrLanguagesQuery.data.job.total}
                  </p>
                ) : null}
                {ocrLanguageMessage ? (
                  <p className="kr-muted" role="status">
                    {ocrLanguageMessage}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <div className="kr-visual-reading">
          <label className="kr-settings__check kr-visual-reading__toggle">
            <input
              type="checkbox"
              checked={visualEnabled}
              onChange={(event) => setVisualEnabled(event.target.checked)}
            />
            启用视觉读页（图表/公式页视觉解读）
          </label>
          <p className="kr-settings__hint">
            OCR 的视觉模型只转录文字；视觉读页是图表/公式的派生解读，不作为逐字证据，引用时回原页核对。
          </p>
          {visualEnabled ? (
            <div className="kr-visual-reading__body">
              <div className="kr-visual-reading__row">
                <label className="kr-settings__check">
                  <input
                    type="checkbox"
                    checked={visualUseOcrModel && parsingMode === 'vision'}
                    disabled={parsingMode !== 'vision'}
                    onChange={(event) => setVisualUseOcrModel(event.target.checked)}
                  />
                  复用上面的视觉识别模型
                </label>
                <label className="kr-visual-reading__pages">
                  <span>最多解读页数</span>
                  <input
                    type="number"
                    min={1}
                    max={VISUAL_MAX_PAGES_INPUT}
                    step={1}
                    value={visualMaxPagesInput}
                    onChange={(event) => setVisualMaxPagesInput(event.target.value)}
                  />
                </label>
              </div>
              {parsingMode !== 'vision' ? (
                <p className="kr-settings__hint">
                  识别方式不是「视觉模型」，视觉读页将使用下方单独选择的模型。
                </p>
              ) : null}
              {!visualUseOcrModel || parsingMode !== 'vision' ? (
                <>
                  <label className="kr-visual-reading__model">
                    <span>视觉读页模型</span>
                    <select
                      value={
                        visualConnectionId && visualModelName
                          ? `${visualConnectionId}\u001f${visualModelName}`
                          : ''
                      }
                      onChange={(event) => {
                        const [connectionId = '', model = ''] =
                          event.target.value.split('\u001f');
                        setVisualConnectionId(connectionId);
                        setVisualModelName(model);
                      }}
                    >
                      <option value="">选择视觉 / 全模态模型</option>
                      {visualModelOptions.map(({ connection, model }) => (
                        <option
                          key={`${connection.id}:${model.id}`}
                          value={`${connection.id}\u001f${model.name}`}
                        >
                          {connection.name} / {model.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="kr-settings__hint">
                    带「全模态」能力的模型会同时承担会话、视觉读页与音频；带「视觉」能力的模型只承担视觉读页。
                  </p>
                  {visualModelOptions.length === 0 ? (
                    <p className="kr-settings__hint">
                      还没有可用的视觉模型：请先到「模型服务」给模型勾选「视觉」或「全模态」。
                    </p>
                  ) : null}
                </>
              ) : null}
              <div className="kr-visual-reading__actions">
                <button
                  type="button"
                  onClick={submitVisualReading}
                  disabled={saveVisualReading.isPending}
                >
                  {saveVisualReading.isPending ? '保存中…' : '保存视觉读页设置'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="使用引导"
          hint="首次启动时展示的入门说明：导入、阅读与外部服务。"
        />
        <p className="kr-muted">可随时重新查看「欢迎使用勘读」引导页。</p>
        <div className="kr-settings__actions">
          <button type="button" onClick={onShowGuide} disabled={!onShowGuide}>
            重新查看使用引导
          </button>
        </div>
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="资料位置"
          hint="文献、批注、笔记和索引都保存在这里。更改位置采用「复制」方式：资料复制到新文件夹并重启应用。"
        />
        <p className="kr-muted">修改资料保存位置。</p>
        <p className="kr-muted">原目录文件不会自动删除，确认新位置正常后可自行清理。</p>
        <p className="kr-muted">
          当前：<code>{dataLocationQuery.data ?? '读取中…'}</code>
        </p>
        <div className="kr-settings__actions">
          <button
            type="button"
            onClick={() => {
              if (
                appDialogs.confirm(
                  '更改资料位置会复制当前全部资料到新文件夹，然后重启应用。原目录文件会保留，作为迁移期间的安全备份；确认新位置正常后可自行删除。确定继续？'
                )
              ) {
                changeDataLocation.mutate();
              }
            }}
            disabled={changeDataLocation.isPending}
          >
            {changeDataLocation.isPending ? '准备中…' : '更改资料位置'}
          </button>
        </div>
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="数据备份"
          hint="备份使用 SQLite 一致性快照，再打包数据库、PDF 与用户文件；不递归包含旧备份和诊断目录，默认不含日志。备份文件是不加密的压缩包，请存放在受保护的位置。"
        />
        <p className="kr-muted">创建、校验或恢复本机备份。</p>
        <div className="kr-settings__actions">
          {backupActive ? (
            <>
              <span className="kr-muted" role="status">
                备份中… {backupJob?.progress ?? 0}%（{backupStageLabel(backupJob?.stage ?? '')}
                {backupJob?.filesTotal
                  ? `，文件 ${backupJob.filesDone ?? 0}/${backupJob.filesTotal}`
                  : ''}
                ）
              </span>
              <button
                type="button"
                onClick={() => void cancelBackup()}
                disabled={backupJob?.state === 'cancelling'}
              >
                {backupJob?.state === 'cancelling' ? '正在取消…' : '取消备份'}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void startBackup()}>
              立即备份
            </button>
          )}
        </div>
        {backupQuery.data && backupQuery.data.length > 0 ? (
          <ul className="kr-settings__backups">
            {backupQuery.data.slice(0, 10).map((item) => (
              <li key={item.name}>
                {item.name} · {(item.sizeBytes / 1024 / 1024).toFixed(1)} MB
                <button
                  type="button"
                  onClick={() => verifyBackup.mutate(item.name)}
                  disabled={verifyBackup.isPending}
                >
                  校验
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      appDialogs.confirm(
                        `将在下次启动时用 ${item.name} 覆盖当前数据；旧数据会保留在 .pre-restore-*。继续？`
                      )
                    ) {
                      restoreBackup.mutate(item.name);
                    }
                  }}
                  disabled={restoreBackup.isPending}
                >
                  恢复
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="kr-muted">还没有备份。</p>
        )}
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="清空全部本地数据"
          hint="删除本机资料目录中的文献与 PDF 副本、笔记、批注、会话记录、译文、索引、图片资源、备份与诊断包；不删除模型/搜索等服务配置与密钥，也不删除程序本身。清空后不可恢复。"
        />
        <p className="kr-muted">
          只删除本机用户数据；已导出的文件不受影响。只想删除部分文献时，请回文献库逐篇删除。
        </p>
        {clearDataRemoved ? (
          <div className="kr-settings__clear-report" role="status">
            <p>
              <strong>本机用户数据已清空。</strong>删除结果：
            </p>
            <ul className="kr-settings__backups">
              <li>文献：{clearDataRemoved.documents} 篇（含 PDF 副本与附件）</li>
              <li>
                笔记：{clearDataRemoved.notes} 条 · 批注：
                {clearDataRemoved.annotations} 条
              </li>
              <li>
                会话记录：{clearDataRemoved.sessions} 个 · 消息：
                {clearDataRemoved.messages} 条
              </li>
              <li>
                译文：{clearDataRemoved.translations} 条 · 图片资源：
                {clearDataRemoved.note_assets} 个
              </li>
              <li>备份：{clearDataRemoved.backups} 份</li>
            </ul>
            <p className="kr-muted">
              界面已刷新：当前文献选择与列表引用已清空。如需继续使用，请重新导入文献。
            </p>
            <div className="kr-settings__actions">
              <button type="button" onClick={() => setClearDataRemoved(null)}>
                关闭提示
              </button>
            </div>
          </div>
        ) : clearDataOpen ? (
          <div
            className="kr-settings__danger-zone"
            role="group"
            aria-label="确认清空全部本地数据"
          >
            <p className="kr-settings__danger-text">
              确定要清空本机全部用户数据吗？此操作不可恢复，模型与密钥配置会保留。
            </p>
            <label className="kr-settings__check">
              <input
                type="checkbox"
                checked={clearDataAck}
                disabled={clearUserData.isPending}
                onChange={(event) => setClearDataAck(event.target.checked)}
              />
              我已了解：清空后无法恢复，需要重新导入文献。
            </label>
            <label>
              <span>输入「清空」以确认</span>
              <input
                value={clearDataConfirmText}
                placeholder="清空"
                autoFocus
                disabled={clearUserData.isPending}
                onChange={(event) => setClearDataConfirmText(event.target.value)}
              />
            </label>
            {clearDataError ? (
              <p className="kr-page-error" role="alert">
                {clearDataError}
              </p>
            ) : null}
            <div className="kr-settings__actions">
              <button
                type="button"
                className="kr-secondary"
                disabled={clearUserData.isPending}
                onClick={() => {
                  setClearDataOpen(false);
                  setClearDataAck(false);
                  setClearDataConfirmText('');
                  setClearDataError('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="kr-danger"
                disabled={
                  clearUserData.isPending ||
                  !clearDataAck ||
                  clearDataConfirmText.trim() !== '清空'
                }
                onClick={() => clearUserData.mutate()}
              >
                {clearUserData.isPending ? '清空中…' : '确认清空全部本地数据'}
              </button>
            </div>
          </div>
        ) : (
          <div className="kr-settings__actions">
            <button
              type="button"
              className="kr-danger"
              onClick={() => {
                setClearDataRemoved(null);
                setClearDataError('');
                setClearDataOpen(true);
              }}
            >
              清空全部本地数据…
            </button>
          </div>
        )}
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="Zotero（第三方服务）连接"
          hint="本机模式读取 Zotero（第三方服务）桌面端的本地 API；云端模式读取 api.zotero.org。云端/WebDAV 由对应服务提供，使用即需遵守其服务条款与隐私政策。"
        />
        <p className="kr-muted">配置 Zotero（第三方服务）连接方式与资料库。</p>
        <label>
          <span>连接方式</span>
          <select
            value={zoteroMode}
            onChange={(event) =>
              setZoteroMode(event.target.value as 'local' | 'cloud' | 'webdav')
            }
          >
            <option value="local">本机 Zotero（第三方服务）</option>
            <option value="cloud">Zotero（第三方服务）云端</option>
            <option value="webdav">Zotero（第三方服务）云端 + WebDAV 附件</option>
          </select>
        </label>
        {zoteroMode !== 'local' ? (
          <SendingNotice text="云端模式会向 api.zotero.org 发送连接信息与读取请求；WebDAV 模式下附件请求会发送到所填地址。" />
        ) : null}
        {zoteroMode === 'cloud' || zoteroMode === 'webdav' ? (
          <>
            <label>
              <span>资料库类型</span>
              <select
                value={zoteroType}
                onChange={(event) => setZoteroType(event.target.value as 'users' | 'groups')}
              >
                <option value="users">个人资料库</option>
                <option value="groups">群组资料库</option>
              </select>
            </label>
            <label>
              <span>数字资料库 ID</span>
              <input
                value={zoteroId}
                onChange={(event) => setZoteroId(event.target.value)}
                placeholder="例如 1234567"
              />
            </label>
            <p className="kr-muted">
              个人资料库要填 API Key 对应的数字 userID（在 zotero.org/settings/keys 页面查看，不是 1）；
              不确定时直接点「检查连接」，会按 API Key 自动校正。
            </p>
            <label>
              <span>Zotero（第三方服务）API Key</span>
              <input
                type="password"
                value={zoteroKey}
                onChange={(event) => setZoteroKey(event.target.value)}
                placeholder={zoteroQuery.data?.has_key ? '已保存，留空保留' : '只存本机'}
              />
            </label>
            <p className="kr-muted">
              Zotero（第三方服务）云端用 API Key 认证，不需要账号密码；Key 决定所属账号与可读资料库。
            </p>
          </>
        ) : null}
        {zoteroMode === 'webdav' ? (
          <>
            <label>
              <span>WebDAV 地址</span>
              <input
                value={webdavUrl}
                onChange={(event) => setWebdavUrl(event.target.value)}
                placeholder="https://dav.jianguoyun.com/dav/zotero"
              />
            </label>
            <label>
              <span>WebDAV 账号</span>
              <input
                value={webdavUser}
                onChange={(event) => setWebdavUser(event.target.value)}
              />
            </label>
            <label>
              <span>WebDAV 应用密码</span>
              <input
                type="password"
                value={webdavPassword}
                onChange={(event) => setWebdavPassword(event.target.value)}
                placeholder={zoteroQuery.data?.has_password ? '已保存，留空保留' : '只存本机'}
              />
            </label>
          </>
        ) : null}
        <div className="kr-settings__actions">
          <button type="button" onClick={() => saveZotero.mutate()} disabled={saveZotero.isPending}>
            {saveZotero.isPending ? '保存中…' : '保存 Zotero（第三方服务）设置'}
          </button>
          <button
            type="button"
            className="kr-secondary"
            onClick={() => checkZotero.mutate()}
            disabled={saveZotero.isPending || checkZotero.isPending}
          >
            {saveZotero.isPending || checkZotero.isPending ? '测试中…' : '检查连接'}
          </button>
        </div>
        {zoteroDocumentId ? (
          <>
            <div className="kr-settings__actions">
              <button
                type="button"
                className="kr-secondary"
                onClick={() => zoteroAnnotations.mutate(true)}
                disabled={zoteroAnnotations.isPending}
              >
                预览 Zotero 批注与笔记
              </button>
              <button
                type="button"
                onClick={() => zoteroAnnotations.mutate(false)}
                disabled={zoteroAnnotations.isPending}
              >
                导入 Zotero 批注与笔记
              </button>
              <button
                type="button"
                className="kr-secondary"
                onClick={() => snapshotZotero.mutate()}
                disabled={snapshotZotero.isPending}
              >
                {snapshotZotero.isPending ? '保存中…' : '保存本机副本'}
              </button>
            </div>
            <p className="kr-muted">
              预览会分别列出将导入的批注条数与整篇文献笔记（Zotero 笔记）条数；重复导入同一条不会重复写入。
            </p>
          </>
        ) : null}
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="联网搜索"
          hint="联网搜索需要先配置搜索服务。搜索权限影响何时询问、自动允许或关闭；搜索规划隐私策略影响会话模型在规划搜索时可以收到哪些内容。"
        />
        <p className="kr-muted">
          配置搜索服务、允许搜索的时机，以及搜索规划可以发送的内容。
        </p>
        <SendingNotice text="搜索时，搜索词与规划搜索所需的内容会发送到所选搜索服务。" />
        <p className="kr-muted">
          联网结果来自第三方网页，未经本应用核验，引用请以原文为准。
        </p>
        <label>
          <span>平台</span>
          <select
            value={searchProvider}
            onChange={(event) => setSearchProvider(event.target.value as 'deepseek' | 'tavily')}
          >
            <option value="deepseek">DeepSeek 官方搜索 API</option>
            <option value="tavily">Tavily</option>
          </select>
        </label>
        {searchProvider === 'deepseek' ? (
          <>
            <label>
              <span>DeepSeek 搜索服务地址（默认官方入口）</span>
              <input
                value={searchBaseUrl}
                onChange={(event) => setSearchBaseUrl(event.target.value)}
                placeholder="https://api.deepseek.com"
              />
            </label>
            <p className="kr-muted">
              使用 DeepSeek 官方 Search API（<code>POST /v1/tools/search</code>），
              需要填写 DeepSeek API Key；可在{' '}
              <a href="https://api-docs.deepseek.com/zh-cn/guides/search" target="_blank" rel="noreferrer">
                官方文档
              </a>{' '}
              查看搜索语法与计费说明。
            </p>
          </>
        ) : null}
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={searchKey}
            onChange={(event) => setSearchKey(event.target.value)}
            placeholder={searchQueryConfig.data?.has_key ? '已保存，留空保留' : '必填，只存本机'}
          />
        </label>
        <label>
          <span>权限</span>
          <select
            value={searchPermission}
            onChange={(event) =>
              setSearchPermission(event.target.value as 'off' | 'review' | 'auto')
            }
          >
            <option value="off">关闭联网搜索</option>
            <option value="review">每次询问</option>
            <option value="auto">自动允许</option>
          </select>
        </label>
        <label>
          <span>搜索规划隐私策略</span>
          <select
            value={searchPrivacyMode}
            onChange={(event) =>
              setSearchPrivacyMode(event.target.value as 'keywords-only' | 'question' | 'scope')
            }
          >
            <option value="keywords-only">仅提取关键词</option>
            <option value="question">只把当前问题交给会话模型判断是否需要搜索</option>
            <option value="scope">按下方范围发送内容给会话模型</option>
          </select>
        </label>
        <p className="kr-settings__group-label">搜索行为</p>
        <div className="kr-settings__checks">
          <label>
            <input
              type="checkbox"
              checked={searchPlanner}
              onChange={(event) => setSearchPlanner(event.target.checked)}
            />
            允许当前会话模型规划搜索（可能是云端模型）
          </label>
          <label>
            <input
              type="checkbox"
              checked={searchFollowup}
              onChange={(event) => setSearchFollowup(event.target.checked)}
            />
            回答过程中允许提出补充搜索（最多两轮）
          </label>
        </div>
        <p className="kr-settings__group-label">
          搜索规划可发送的内容
          <HintMark text="仅在「按下方范围发送」策略下生效；默认仅本地关键词。" />
        </p>
        <div className="kr-settings__checks">
          {(
            [
              ['question', '当前问题'],
              ['history', '最近提问与回答'],
              ['selection', '选中原文'],
              ['currentPage', '当前页文本'],
              ['surrounding', '当前页前后各一页'],
              ['title', '文献标题/作者'],
              ['notes', '当前文献笔记'],
              ['annotations', '当前文献批注'],
              ['answer', '本轮回答草稿'],
              ['document', '整篇文献阅读材料（风险最高）']
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={searchAllow[key]}
                onChange={(event) =>
                  setSearchAllow({ ...searchAllow, [key]: event.target.checked })
                }
              />
              允许用于搜索规划：{label}
            </label>
          ))}
        </div>
        <div className="kr-settings__actions">
          <button type="button" onClick={() => saveSearch.mutate()} disabled={saveSearch.isPending}>
            {saveSearch.isPending ? '保存中…' : '保存搜索设置'}
          </button>
        </div>
      </section>

      <section className="kr-settings__section">
        <SectionHeading title="语音识别" />
        <p className="kr-muted">配置语音输入方式、识别方式与识别后的处理。</p>
        <p className="kr-muted">
          识别结果默认填入会话输入框，可自行核对；勾选「识别后自动发送」则会直接提问。
          直接语音输入（全模态）本身就会直接提问。
        </p>
        <SendingNotice text="使用外部识别服务时，录音会发送到所选服务。" />
        <div className="kr-settings__checks">
          <label>
            <input
              type="checkbox"
              checked={inputEnabled}
              onChange={(event) => setInputEnabled(event.target.checked)}
            />
            启用语音输入（会话输入框显示麦克风按钮）
          </label>
        </div>
        <p className={recordingSupport.supported ? 'kr-muted' : 'kr-page-error'}>
          {recordingSupport.supported
            ? `${recordingSupport.message}；单次录音最长 60 秒，按住不足 300ms 视为误触忽略。`
            : `${recordingSupport.message}。启用后麦克风按钮仍会保持禁用。`}
        </p>
        <label>
          <span>触发方式</span>
          <select
            value={triggerMode}
            onChange={(event) => setTriggerMode(event.target.value as 'hold' | 'click')}
          >
            <option value="hold">按住说话（松开识别）</option>
            <option value="click">单击开始 / 再次单击结束</option>
          </select>
        </label>
        <p className="kr-muted">
          {triggerMode === 'hold'
            ? '按住麦克风说话，松开后开始识别；按 Esc 可取消本次录音。'
            : '单击麦克风开始录音，再次单击结束；按 Esc 可取消本次录音。'}
        </p>
        {hasAudioModel ? (
          <div className="kr-settings__checks">
            <label>
              <input
                type="checkbox"
                checked={directAudio}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setDirectAudio(checked);
                  if (checked && !asrModel) {
                    const first = audioModelOptions[0];
                    if (first) {
                      setAsrConnectionId(first.connection.id);
                      setAsrModel(first.model.name);
                    }
                  }
                }}
              />
              语音直接交给全模态会话模型（不先转文字）
            </label>
          </div>
        ) : (
          <p className="kr-muted">
            当前模型服务中没有标记「音频」能力的全模态模型，因此不提供直接语音输入。
          </p>
        )}
        {directAudio ? (
          <label>
            <span>全模态模型（语音直接交给它，不再单独识别）</span>
            <select
              value={
                asrConnectionId && asrModel
                  ? `${asrConnectionId}\u001f${asrModel}`
                  : ''
              }
              onChange={(event) => {
                const raw = event.target.value;
                const separator = raw.indexOf('\u001f');
                if (separator < 0) {
                  setAsrConnectionId('');
                  setAsrModel('');
                  return;
                }
                setAsrConnectionId(raw.slice(0, separator));
                setAsrModel(raw.slice(separator + 1));
              }}
            >
              <option value="">从模型服务中选择</option>
              {audioModelOptions.map(({ connection, model }) => (
                <option
                  key={`${connection.id}:${model.id}`}
                  value={`${connection.id}\u001f${model.name}`}
                >
                  {connection.name} / {model.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <div className="kr-settings__checks">
              <label>
                <input
                  type="checkbox"
                  checked={correction}
                  onChange={(event) => setCorrection(event.target.checked)}
                />
                将识别文字交给会话模型检查错字
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={correctionContext}
                  onChange={(event) => setCorrectionContext(event.target.checked)}
                />
                允许发送当前页片段与最近对话用于纠错
              </label>
            </div>
            <label>
              <span>识别方式</span>
              <select
                value={asrMode}
                onChange={(event) =>
                  setAsrMode(event.target.value as 'system' | 'model' | 'custom')
                }
              >
                <option value="system">系统语音（Windows）</option>
                <option value="model">模型服务中已配置的语音服务</option>
                <option value="custom">自定义 OpenAI 兼容服务</option>
              </select>
            </label>
        {asrMode === 'model' ? (
          <>
            <label>
              <span>语音平台</span>
              <select
                value={asrConnectionId}
                onChange={(event) => {
                  setAsrConnectionId(event.target.value);
                  const connection = asrPlatforms.find(
                    (item) => item.id === event.target.value
                  );
                  // 默认选该平台第一个「语音识别」模型：直接取 models[0] 可能是对话模型，
                  // 下拉框里没有这个值，看起来就像“没有选中模型”。
                  setAsrModel(
                    connection?.models.find((model) => model.capabilities.includes('asr'))
                      ?.name ?? ''
                  );
                }}
              >
                <option value="">选择平台</option>
                {asrConnectionId &&
                !asrPlatforms.some((connection) => connection.id === asrConnectionId) ? (
                  <option value={asrConnectionId}>
                    {asrConnectionName || '已保存的平台'}（没有语音识别模型）
                  </option>
                ) : null}
                {asrPlatforms.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>语音模型</span>
              <select value={asrModel} onChange={(event) => setAsrModel(event.target.value)}>
                <option value="">选择模型</option>
                {asrModel && !asrModelOptions.some((model) => model.name === asrModel) ? (
                  <option value={asrModel}>{asrModel}（已保存）</option>
                ) : null}
                {asrModelOptions.map((model) => (
                  <option key={model.id} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        {asrMode === 'custom' ? (
          <>
            <label>
              <span>服务地址</span>
              <input
                value={asrUrl}
                onChange={(event) => setAsrUrl(event.target.value)}
                placeholder="http://127.0.0.1:8000/v1"
              />
            </label>
            <label>
              <span>模型</span>
              <input
                value={asrModel}
                onChange={(event) => setAsrModel(event.target.value)}
                placeholder="whisper-1"
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={asrKey}
                onChange={(event) => setAsrKey(event.target.value)}
                placeholder={speechQuery.data?.has_asr_key ? '已保存，留空保留' : '可留空'}
              />
            </label>
          </>
        ) : null}
          </>
        )}
        {directAudio ? (
          <p className="kr-muted">
            直接语音输入会直接提问，不经过「识别成文字后核对」这一步。
          </p>
        ) : (
          <div className="kr-settings__checks">
            <label>
              <input
                type="checkbox"
                checked={autoSend}
                onChange={(event) => setAutoSend(event.target.checked)}
              />
              识别完成后自动发送提问（关闭时先填入输入框，由你核对后发送）
            </label>
          </div>
        )}
      </section>

      <section className="kr-settings__section">
        <SectionHeading title="语音播报" />
        <p className="kr-muted">配置朗读方式、语音服务与播放行为。</p>
        <SendingNotice text="使用外部语音服务时，待朗读文字会发送到所选服务。" />
        <label>
          <span>播报方式</span>
          <select
            value={ttsMode}
            onChange={(event) => {
              const next = event.target.value as 'system' | 'model' | 'custom';
              if (next === ttsMode) return;
              setTtsMode(next);
              resetVoicesForTargetChange('已切换播报方式');
            }}
          >
            <option value="system">系统语音（Windows）</option>
            <option value="model">模型服务中已配置的语音服务</option>
            <option value="custom">自定义 OpenAI 兼容服务</option>
          </select>
        </label>
        {ttsMode === 'model' ? (
          <>
            {ttsPlatforms.length === 0 ? (
              <p className="kr-muted">
                模型服务里还没有标记「语音生成」能力的平台。请先到「模型服务」添加带 TTS 能力的平台与模型，或改用「系统语音 / 自定义服务」。
              </p>
            ) : null}
            <label>
              <span>语音平台</span>
              <select
                value={ttsConnectionId}
                onChange={(event) => {
                  const next = event.target.value;
                  setTtsConnectionId(next);
                  const connection = ttsPlatforms.find((item) => item.id === next);
                  // 默认选该平台第一个「语音生成」模型：直接取 models[0] 可能是对话模型，
                  // 下拉框里没有这个值，看起来就像“没有选中模型”。
                  setTtsModel(
                    connection?.models.find((model) => model.capabilities.includes('tts'))
                      ?.name ?? ''
                  );
                  // 音色是平台相关的：换平台后旧音色（常见是 MiMo）必须清掉，否则保存后
                  // 实际播报仍会用错音色，看起来像“设置没生效”。
                  resetVoicesForTargetChange('已切换语音平台');
                }}
              >
                <option value="">选择平台</option>
                {ttsConnectionId &&
                !ttsPlatforms.some((connection) => connection.id === ttsConnectionId) ? (
                  <option value={ttsConnectionId}>
                    {ttsConnectionName || '已保存的平台'}（没有语音合成模型）
                  </option>
                ) : null}
                {ttsPlatforms.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>语音模型</span>
              <select
                value={ttsModel}
                onChange={(event) => {
                  setTtsModel(event.target.value);
                  // 不同模型可能支持不同音色清单（例如 MiMo 的音色设计/复刻模型没有预置音色）。
                  resetVoicesForTargetChange('已切换语音模型');
                }}
              >
                <option value="">选择模型</option>
                {ttsModel && !ttsModelOptions.some((model) => model.name === ttsModel) ? (
                  <option value={ttsModel}>{ttsModel}（已保存）</option>
                ) : null}
                {ttsModelOptions.map((model) => (
                  <option key={model.id} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            {ttsConnectionId && !ttsModel.trim() ? (
              <p className="kr-muted">
                请选择该平台的语音生成模型：播报时会严格按「平台连接 + 模型」调用，模型不匹配会明确报错。
              </p>
            ) : null}
          </>
        ) : null}
        {ttsMode === 'custom' ? (
          <>
            <label>
              <span>服务地址</span>
              <input
                value={ttsUrl}
                onChange={(event) => setTtsUrl(event.target.value)}
                placeholder="http://127.0.0.1:8000/v1"
              />
            </label>
            <label>
              <span>模型</span>
              <input
                value={ttsModel}
                onChange={(event) => setTtsModel(event.target.value)}
                placeholder="tts-1"
              />
            </label>
          </>
        ) : null}
        {/* 三种播报方式都提供音色选择：下拉（获取到的列表）+「获取音色」+ 手动填写 ID。 */}
        <label>
          <span>声音（朗读音色）</span>
          <div className="kr-inline-actions">
            <select
              value={voiceOptions.includes(ttsVoice) ? ttsVoice : ''}
              onChange={(event) => setTtsVoice(event.target.value)}
            >
              <option value="">
                {ttsMode === 'system' ? '系统默认音色' : '使用服务 / 平台默认音色'}
              </option>
              {voiceOptions.map((voice) => (
                <option key={voice} value={voice}>
                  {voiceLabels[voice] ?? voice}
                </option>
              ))}
              {ttsVoice && !voiceOptions.includes(ttsVoice) ? (
                <option value={ttsVoice}>{ttsVoice}（当前 / 手动）</option>
              ) : null}
            </select>
            <button
              type="button"
              className="kr-secondary"
              onClick={() => loadVoices.mutate()}
              disabled={loadVoices.isPending}
            >
              {loadVoices.isPending ? '获取中…' : '获取音色'}
            </button>
          </div>
          <input
            value={ttsVoice}
            onChange={(event) => setTtsVoice(event.target.value)}
            placeholder={
              ttsMode === 'system'
                ? '也可手动填写系统音色名称（留空使用系统默认）'
                : '也可手动填写音色 ID 或名称（留空使用服务默认）'
            }
          />
          <p className="kr-muted">
            音色来源：
            {ttsMode === 'system'
              ? 'Windows 系统语音'
              : ttsMode === 'model'
                ? `模型服务 ${
                    ttsConnectionName ||
                    (ttsConnectionId ? '（平台不在模型服务列表中）' : '（未选择平台）')
                  }${ttsModel ? ` / ${ttsModel}` : ''}`
                : `自定义服务 ${ttsUrl.trim() || '（未填写地址）'}`}
            {voiceInfo && !voiceInfoStale
              ? `；音色列表来源：${voiceInfo.source || '—'}${
                  voiceInfo.message ? `（${voiceInfo.message}）` : ''
                }`
              : ''}
          </p>
          {voiceInfoStale ? (
            <p className="kr-muted" role="alert">
              当前音色列表是在其它平台/服务地址下获取的，可能不适用；请重新点「获取音色」再选择。
            </p>
          ) : null}
          {ttsMode === 'model' && !ttsConnectionId ? (
            <p className="kr-muted">模型服务模式需要先选择「语音平台」，才能获取并选择音色。</p>
          ) : null}
        </label>
        {ttsMode === 'custom' ? (
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={ttsKey}
              onChange={(event) => setTtsKey(event.target.value)}
              placeholder={speechQuery.data?.has_tts_key ? '已保存，留空保留' : '可留空'}
            />
          </label>
        ) : null}
        <div className="kr-settings__actions">
          <label className="kr-settings__check">
            <input
              type="checkbox"
              checked={autoRead}
              onChange={(event) => setAutoRead(event.target.checked)}
            />
            回答后自动朗读
          </label>
        </div>
        <div className="kr-settings__actions">
          <button type="button" onClick={() => saveSpeech.mutate()} disabled={saveSpeech.isPending}>
            {saveSpeech.isPending ? '保存中…' : '保存语音设置'}
          </button>
          <button
            type="button"
            onClick={() => checkSpeechSystem.mutate()}
            disabled={checkSpeechSystem.isPending}
          >
            {checkSpeechSystem.isPending ? '检测中…' : '语音自检'}
          </button>
        </div>
        {/* 当前播报配置（只读摘要）：播报按钮读的是已保存配置，这里把「界面上的设置」
            和「实际会用的设置」放在一起，避免模型/音色没生效却看不出来。 */}
        <div className="kr-settings__hint" role="status" aria-label="当前播报配置">
          <p>
            当前播报配置：模式 {ttsModeLabel}；平台 {ttsPlatformLabel}；模型 {ttsModelLabel}；音色{' '}
            {ttsVoice.trim() || '默认音色'}。
          </p>
          <p>
            可用性：{ttsReadiness.ok ? '配置完整，可用于播报' : ttsReadiness.reasons.join('；')}
          </p>
          {speechConfigDirty ? (
            <p>有未保存的修改：点「保存语音设置」后才会生效。</p>
          ) : (
            <p>以上配置已保存，播报时按此配置调用。</p>
          )}
          {voiceInfoStale ? <p>音色列表与当前平台/模型不匹配，请重新获取音色。</p> : null}
        </div>
        {speechSystem ? (
          <div className="kr-settings__hint" role="status">
            <p>{speechSystem.message}</p>
            <p>
              平台：{speechSystem.platform || '未知'}；系统语音：
              {speechSystem.ok ? '可用' : '不可用'}；TTS 音色：
              {speechSystem.tts_voices.length} 个；识别语言：
              {speechSystem.asr_languages.length} 个
            </p>
            <p>
              本次自检只读取本机 Windows 语音组件，不检测外部模型服务；当前播报配置：
              {ttsModeLabel} / {ttsPlatformLabel} / {ttsModelLabel} / 音色{' '}
              {ttsVoice.trim() || '默认音色'}。
            </p>
            {speechSystem.detail.length > 0 ? (
              <details>
                <summary>自检详情</summary>
                <ul>
                  {speechSystem.detail.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>

      <ShortcutSettingsPanel api={api} />

      <section className="kr-settings__section">
        <SectionHeading
          title="诊断与维护"
          hint="检查数据库完整性、文件缺失、数据量；报告不包含密钥或文档正文。"
        />
        <p className="kr-muted">
          生成诊断报告；或导出诊断包（zip：脱敏诊断报告 + 最近错误日志，不含 PDF、正文或密钥）。
        </p>
        {maintenanceStatusQuery.data ? (
          <ul className="kr-settings__backups">
            <li>
              版本：{maintenanceStatusQuery.data.version}（{maintenanceStatusQuery.data.platform}）
            </li>
            <li>数据目录：{maintenanceStatusQuery.data.data_dir}</li>
            <li>
              数据库：{(maintenanceStatusQuery.data.database_bytes / 1024 / 1024).toFixed(1)} MB；
              日志：{(maintenanceStatusQuery.data.log_bytes / 1024).toFixed(0)} KB
            </li>
            <li>
              诊断包：{maintenanceStatusQuery.data.diagnostics_count} 个；备份：
              {maintenanceStatusQuery.data.backups_count} 个
              {maintenanceStatusQuery.data.last_backup
                ? `（最近：${maintenanceStatusQuery.data.last_backup}）`
                : ''}
            </li>
            <li>
              运行时长：{maintenanceStatusQuery.data.uptime_seconds ?? 0} 秒；core PID：
              {maintenanceStatusQuery.data.core_pid ?? '未提供'}
              （启动时会清理能确认身份的遗留 core；运行期间不做常驻守护）
            </li>
          </ul>
        ) : null}
        <div className="kr-settings__actions">
          <button
            type="button"
            onClick={() => void diagnosticsQuery.refetch()}
            disabled={diagnosticsQuery.isFetching}
          >
            {diagnosticsQuery.isFetching ? '检查中…' : '生成诊断报告'}
          </button>
          <button
            type="button"
            onClick={() => createDiagnosticsPackage.mutate()}
            disabled={createDiagnosticsPackage.isPending}
          >
            {createDiagnosticsPackage.isPending ? '导出中…' : '导出诊断包'}
          </button>
          <button type="button" onClick={() => void copyDataDir()}>
            复制数据目录
          </button>
          <button type="button" onClick={openDataDir}>
            打开数据目录
          </button>
        </div>
        <details className="kr-settings__details">
          <summary>图片资源占用与清理</summary>
          <div className="kr-settings__details-body">
            {noteAssetUsageQuery.isLoading ? (
              <p className="kr-muted">正在统计图片资源…</p>
            ) : noteAssetUsageQuery.isError ? (
              <p className="kr-page-error" role="alert">
                读取图片资源统计失败：
                {noteAssetUsageQuery.error instanceof Error
                  ? noteAssetUsageQuery.error.message
                  : '未知错误'}
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void noteAssetUsageQuery.refetch()}
                >
                  重试
                </button>
              </p>
            ) : noteAssetUsageQuery.data ? (
              <>
                <ul className="kr-settings__backups" aria-label="图片资源占用">
                  <li>
                    文件数：{noteAssetUsageQuery.data.fileCount} 个；总占用：
                    {formatBytes(noteAssetUsageQuery.data.totalBytes)}
                  </li>
                  <li>
                    仍被引用（未删除内容）：
                    {noteAssetUsageQuery.data.activeReferencedFiles ?? 0} 个；仅被已删除内容引用：
                    {noteAssetUsageQuery.data.deletedReferencedFiles ?? 0} 个
                  </li>
                  <li>
                    孤儿：{noteAssetUsageQuery.data.orphanFiles} 个；上次清理：
                    {noteAssetUsageQuery.data.lastGcAt
                      ? new Date(noteAssetUsageQuery.data.lastGcAt).toLocaleString()
                      : '从未清理'}
                  </li>
                  <li>
                    资源索引：
                    {noteAssetUsageQuery.data.indexedAt
                      ? new Date(noteAssetUsageQuery.data.indexedAt).toLocaleString()
                      : '未记录'}
                    （文件 {noteAssetUsageQuery.data.indexedFiles ?? 0} 个、引用{' '}
                    {noteAssetUsageQuery.data.indexedRefs ?? 0} 条）
                  </li>
                </ul>
                <p className="kr-muted">
                  共享图片只要仍有任一未删除笔记/批注引用就不会被清理。「仅被已删除内容引用」默认保留；需文件超过
                  24 小时，并在清理时取消「保留已删除内容引用」才会删除。
                </p>
                <p className="kr-muted">
                  资源索引时间/文件数/引用条数是上次迁移或重建时的快照；当前实时数量以文件数、被引用、孤儿为准。
                </p>
              </>
            ) : null}
            <div className="kr-settings__actions">
              <button
                type="button"
                onClick={() => void noteAssetUsageQuery.refetch()}
                disabled={noteAssetUsageQuery.isFetching}
                title="重新统计本地笔记图片资源占用与孤儿数量"
              >
                {noteAssetUsageQuery.isFetching ? '刷新中…' : '刷新'}
              </button>
              <button
                type="button"
                onClick={rebuildNoteAssetIndex}
                disabled={startReindex.isPending || reindexJob?.status === 'running'}
                title="重新扫描所有笔记/批注内容，修复外部改库造成的引用统计不一致"
              >
                {startReindex.isPending || reindexJob?.status === 'running'
                  ? '重建中…'
                  : '重建资源索引'}
              </button>
            </div>
            <p className="kr-muted">
              重建资源索引：用于修复外部直接改数据库等造成的引用统计不一致；会重新扫描所有笔记/批注内容。
            </p>
            {reindexJob?.status === 'running' ? (
              <div className="kr-reindex-progress" role="status">
                <p>
                  正在重建资源索引：{reindexPhaseLabel(reindexJob.phase)}（{reindexJob.done}/
                  {reindexJob.total}，{reindexPercent(reindexJob)}%）
                </p>
                <progress
                  value={Math.min(reindexJob.done, Math.max(1, reindexJob.total))}
                  max={Math.max(1, reindexJob.total)}
                  aria-label="资源索引重建进度"
                />
              </div>
            ) : reindexJob?.status === 'done' ? (
              <p className="kr-settings__message" role="status">
                资源索引已重建：{reindexJob.indexedFiles} 个文件、{reindexJob.indexedRefs} 条引用
                {reindexJob.indexedAt
                  ? `（${new Date(reindexJob.indexedAt).toLocaleString()}）`
                  : ''}
                。
              </p>
            ) : reindexJob?.status === 'error' ? (
              <p className="kr-page-error" role="alert">
                重建资源索引失败：{reindexJob.error || reindexError || '未知错误'}
              </p>
            ) : reindexError ? (
              <p className="kr-page-error" role="alert">
                {reindexError}
              </p>
            ) : null}
            <p className="kr-muted">
              清理未引用图片：只删除 24 小时以上、且没有被任何笔记/批注引用的本地图片资源（24
              小时内的新文件会跳过）；先预览可删除数量与可释放空间，再确认执行。
            </p>
            <div className="kr-settings__checks">
              <label>
                <input
                  type="checkbox"
                  checked={gcIncludeDeleted}
                  disabled={gcBusy}
                  onChange={(event) => setGcIncludeDeleted(event.target.checked)}
                />
                保留已删除笔记/批注引用的图片（推荐）
              </label>
            </div>
            <p className="kr-muted">
              {gcIncludeDeleted
                ? '已删除笔记/批注中引用的图片也会保留，恢复笔记后图片不会丢失。'
                : '⚠ 取消勾选后，只被已删除笔记/批注引用的图片也会被清理；之后恢复这些笔记时图片可能缺失。'}
            </p>
            <div className="kr-settings__actions">
              <button
                type="button"
                onClick={() => void cleanNoteAssets()}
                disabled={gcBusy}
                title="扫描本地图片资源，删除 24 小时以上且未被引用的文件"
              >
                {gcBusy ? '清理中…' : '清理未引用图片'}
              </button>
            </div>
            {gcError ? (
              <p className="kr-page-error" role="alert">
                清理未引用图片失败：{gcError}
              </p>
            ) : null}
            {gcReport ? (
              <ul className="kr-settings__backups" aria-label="图片清理结果">
                <li>
                  扫描：{gcReport.scannedFiles} 个文件；仍被引用：
                  {gcReport.referencedFiles} 个
                </li>
                <li>
                  已删除：{gcReport.deletedFiles} 个；保留：{gcReport.keptFiles} 个；跳过新文件：
                  {gcReport.skippedRecent} 个
                </li>
                <li>释放空间：{formatBytes(gcReport.bytesFreed)}</li>
              </ul>
            ) : null}
          </div>
        </details>
        <details className="kr-settings__details">
          <summary>笔记图片上限</summary>
          <div className="kr-settings__details-body">
            <p className="kr-muted">
              仅影响之后上传的图片，已有图片不受影响。服务端会按这里的上限校验新上传的
              note-assets 图片（大小与像素）。
            </p>
            <div className="kr-note-image-limits">
              <label>
                <span>单图大小上限（MB，1–20）</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={0.5}
                  value={noteImageMaxMb}
                  disabled={saveNoteImageLimits.isPending}
                  onChange={(event) => {
                    setNoteImageMaxMb(event.target.value);
                    setNoteImageLimitError('');
                  }}
                />
              </label>
              <label>
                <span>单图像素上限（百万像素，1–25）</span>
                <input
                  type="number"
                  min={1}
                  max={25}
                  step={1}
                  value={noteImageMaxMp}
                  disabled={saveNoteImageLimits.isPending}
                  onChange={(event) => {
                    setNoteImageMaxMp(event.target.value);
                    setNoteImageLimitError('');
                  }}
                />
              </label>
              <button
                type="button"
                onClick={submitNoteImageLimits}
                disabled={saveNoteImageLimits.isPending || settingsQuery.isLoading}
                title="保存笔记图片大小与像素上限（仅影响之后上传的图片）"
              >
                {saveNoteImageLimits.isPending ? '保存中…' : '保存图片上限'}
              </button>
            </div>
            {settingsQuery.isLoading ? (
              <p className="kr-muted">正在读取图片上限设置…</p>
            ) : null}
            {noteImageLimitError ? (
              <p className="kr-page-error" role="alert">
                {noteImageLimitError}
              </p>
            ) : null}
          </div>
        </details>
        <details className="kr-settings__details">
          <summary>诊断报告与诊断包</summary>
          <div className="kr-settings__details-body">
            {(diagnosticsPackagesQuery.data ?? []).length > 0 ? (
              <ul className="kr-settings__backups">
                {(diagnosticsPackagesQuery.data ?? []).map((item) => (
                  <li key={item.name} title={item.path}>
                    {item.name} · {(item.bytes / 1024).toFixed(0)} KB
                    <span className="kr-muted"> · {item.path}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kr-muted">还没有导出过诊断包（最多保留最近 5 个）。</p>
            )}
            {diagnosticsQuery.data ? (
              <ul className="kr-settings__backups">
                <li>数据库完整性：{diagnosticsQuery.data.integrity}</li>
                <li>缺失文件：{diagnosticsQuery.data.missingFiles}</li>
                <li>文档：{diagnosticsQuery.data.counts.documents ?? 0}</li>
                <li>备份：{diagnosticsQuery.data.usage.backups} 个</li>
                <li>
                  数据量：数据库{' '}
                  {(diagnosticsQuery.data.usage.databaseBytes / 1024 / 1024).toFixed(1)} MB，
                  PDF {(diagnosticsQuery.data.usage.papersBytes / 1024 / 1024).toFixed(1)} MB
                </li>
                <li>最近错误：{diagnosticsQuery.data.recentErrors.length} 条</li>
                {diagnosticsQuery.data.failedTasks.map((item) => (
                  <li key={item.category}>
                    失败任务 · {item.category}：{item.count} 次
                    {item.lastMessage ? `（最近：${item.lastMessage}）` : ''}
                  </li>
                ))}
                {diagnosticsQuery.data.recentErrors.length > 0 ? (
                  <li>
                    <details>
                      <summary>查看最近 {diagnosticsQuery.data.recentErrors.length} 条错误</summary>
                      <ul>
                        {diagnosticsQuery.data.recentErrors.map((item) => (
                          <li key={`${item.timestamp}-${item.context}`}>
                            {item.timestamp} · {item.context} · {item.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ) : null}
                {diagnosticsQuery.data.recentErrors.slice(0, 3).map((item) => (
                  <li key={`${item.timestamp}-${item.context}`}>
                    {item.context} · {item.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {diagnosticsQuery.isError ? (
              <p className="kr-page-error">
                {diagnosticsQuery.error instanceof Error
                  ? diagnosticsQuery.error.message
                  : '诊断失败'}
              </p>
            ) : null}
          </div>
        </details>
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="从旧版迁移数据"
          hint="选择含 reader.sqlite3 的旧版资料目录：旧 Python 版的 PDF 在 data 目录根部，新版本的在 papers/ 下。迁移会复制文档、片段、批注、笔记、会话、译文、页面编辑与向量缓存；旧版 API Key 无法迁移，需要在这里重新填写。"
        />
        <p className="kr-muted">从旧版 data 目录复制资料。</p>
        <p className="kr-muted">源目录不会被修改。</p>
        <label>
          <span>旧版 data 目录</span>
          <input
            type="text"
            value={legacyPath}
            onChange={(event) => setLegacyPath(event.target.value)}
            placeholder="例如 E:\...\Studianda\data"
          />
        </label>
        <div className="kr-settings__actions">
          <button
            type="button"
            className="kr-secondary"
            onClick={async () => {
              const picked = await adapter.pickDirectory();
              if (picked) setLegacyPath(picked);
            }}
          >
            选择目录
          </button>
          <button
            type="button"
            onClick={() => migrate.mutate()}
            disabled={migrate.isPending || !legacyPath.trim()}
          >
            {migrate.isPending ? '迁移中…' : '开始迁移'}
          </button>
        </div>
        {migration ? <p className="kr-settings__message">{migration}</p> : null}
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="使用须知与隐私说明"
          hint="本地工具定位、第三方 AI 服务责任边界、BYOK 与密钥边界、三方角色、逐功能数据流向、风险提示、未成年人、责任边界与版本。"
        />
        <p className="kr-muted">
          应用内为精简版（版本 {USAGE_NOTICE_VERSION}，生效日期 {USAGE_NOTICE_EFFECTIVE_DATE}）。
          {usageNoticeRead
            ? '当前版本已阅读。'
            : '当前版本尚未标记已读；首次使用的引导页会要求阅读并勾选确认。'}
          {usageNoticeAcknowledged
            ? '已勾选确认「已查看使用须知与隐私说明」。'
            : '尚未勾选确认「已查看使用须知与隐私说明」。'}
        </p>
        <div className="kr-settings__actions">
          <button type="button" onClick={() => setUsageNoticeOpen(true)}>
            {usageNoticeRead ? '重新查看使用须知' : '查看使用须知'}
          </button>
          {adapter.openExternal ? (
            <button
              type="button"
              className="kr-secondary"
              title="优先打开安装包内的完整版；不可用时打开仓库文档"
              onClick={() => void openFullUsageNotice()}
            >
              打开完整版
            </button>
          ) : null}
        </div>
        <p className="kr-muted">
          使用本工具即表示你已阅读并理解本说明；AI
          生成的回答、译文与摘要可能出错，请以文献原文为准。
        </p>
      </section>

      <section className="kr-settings__section">
        <SectionHeading
          title="关于与更新"
          hint="应用内更新只替换程序目录；文献、笔记与会话都在资料目录里，更新不会改动它们。安装前会自动备份资料。"
        />
        <p className="kr-muted">
          “勘读”不提供模型、不代为生成、不运营云服务。AI 生成能力与内容由你配置的服务商（或
          你在本机运行的模型）提供，相应合规与标识义务由该服务提供者承担；使用本工具生成、导出、传播内容，需自行遵守法律法规与科研诚信要求。请勿将本工具用于对外提供咨询服务
        </p>
        <UpdatePanel adapter={adapter} />
      </section>

      <section className="kr-settings__section">
        <SectionHeading title="第三方许可与声明" />
        <p className="kr-muted">查看许可证与第三方组件清单。</p>
        <div className="kr-settings__actions">
          <button
            type="button"
            onClick={() => {
              if (adapter.openLegalNotice) {
                void adapter.openLegalNotice();
              }
            }}
            disabled={!adapter.openLegalNotice}
          >
            打开第三方许可声明
          </button>
        </div>
      </section>

      {usageNoticeOpen ? (
        <UsageNoticeDialog adapter={adapter} onClose={() => setUsageNoticeOpen(false)} />
      ) : null}
      </div>
      </div>
    </div>
  );
}
