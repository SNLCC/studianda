import { appDialogs } from './dialogs.js';
import type { ApiClient } from '@studianda/api-client';
import type {
  ModelServiceConnection,
  ModelServiceKind,
  ModelServiceModel,
  ModelServiceRouting,
  ModelServicesConfig,
  ProviderPreset
} from '@studianda/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type JSX } from 'react';
import { HintMark, SendingNotice } from './Hint.js';
import { useSettingsFeedback } from './SettingsFeedback.js';
import type { RuntimeAdapter } from './runtime.js';

// 顺序有意义：全模态放最前，它蕴含的「会话 / 视觉 / 语音识别」紧跟在后面。
// 语音合成是独立服务能力，不由全模态自动包含；没有「音频输入」这种单独类型，
// 因为对用户来说它和语音识别是同一件事，全模态的音频能力就用语音识别表示。
// 没有「翻译」类型：翻译走会话模型，不再要求专用翻译模型能力。
const CAPABILITY_META: Array<{ kind: string; symbol: string; label: string }> = [
  { kind: 'omni', symbol: '全', label: '全模态' },
  { kind: 'chat', symbol: '◈', label: '会话' },
  { kind: 'vision', symbol: '眼', label: '视觉' },
  { kind: 'asr', symbol: '声', label: '语音识别' },
  { kind: 'embedding', symbol: '◎', label: '向量' },
  { kind: 'rerank', symbol: '↕', label: '重排' },
  { kind: 'tts', symbol: '播', label: '语音合成' }
];

const KIND_LABELS: Record<ModelServiceKind, string> = {
  chat: '会话模型',
  embedding: 'Embedding',
  rerank: 'Rerank',
  translation: '翻译',
  asr: '语音识别',
  tts: '语音生成',
  vision: '视觉读页',
  omni: '全模态'
};

const DEFAULT_CAPABILITIES: Record<ModelServiceKind, string[]> = {
  chat: ['chat'],
  embedding: ['embedding'],
  rerank: ['rerank'],
  translation: ['translation'],
  asr: ['asr'],
  tts: ['tts'],
  vision: ['vision'],
  omni: ['omni']
};

/** 手动上下文窗口的允许范围。 */
const CAPACITY_MIN = 8192;
const CAPACITY_MAX = 4_000_000;
const CAPACITY_MANUAL_SOURCE = '手动指定';

function capabilitiesOf(name: string): string[] {
  const value = name.toLowerCase();
  const official: Record<string, string[]> = {
    'mimo-v2.5-asr': ['asr'],
    'mimo-v2.5-tts': ['tts'],
    'mimo-v2.5-tts-voiceclone': ['tts'],
    'mimo-v2.5-tts-voicedesign': ['tts'],
    'mimo-v2.6-flash': ['chat', 'audio', 'omni'],
    'mimo-v2.6-pro': ['chat', 'audio', 'omni'],
    'mimo-v2.6-pro-ultraspeed': ['chat', 'audio', 'omni'],
    // MiniMax 官方 OpenAI 兼容接口支持文本 + 图片输入（当前不支持音频输入）。
    'MiniMax-M3.1-Flash': ['chat', 'vision'],
    'MiniMax-M3': ['chat', 'vision']
  };
  if (official[name]) return official[name];
  const capabilities = new Set<string>(['chat']);
  if (/(embed|embedding|bge|gte|e5|nomic)/.test(value)) capabilities.add('embedding');
  if (/(rerank|ranker)/.test(value)) capabilities.add('rerank');
  if (/(tts|speech|audio|voice|cosyvoice|fish)/.test(value)) capabilities.add('tts');
  if (/(asr|whisper|transcrib|paraformer|sensevoice)/.test(value)) capabilities.add('asr');
  // 名称像视觉模型只是提示，真正的用途仍要用户在这里确认并标注。
  if (/(vision|vl|multimodal)/.test(value)) {
    capabilities.add('chat');
    capabilities.add('vision');
  }
  if (/omni/.test(value)) capabilities.add('omni');
  return [...capabilities];
}

function newId(): string {
  return crypto.randomUUID();
}

export interface FetchedCapacityMetadata {
  contextWindow?: number;
  capacitySource?: string;
  /** 官方/平台登记的用途（语音模型等平台不列能力时用）。 */
  capabilities?: string[];
  source?: string;
  metadataUrl?: string;
}

/**
 * 把 `/models` 拉到的元数据写回模型清单（只填“自动”来源）。
 *
 * - 只有 metadata 里带**合法** `contextWindow` 的模型才会被写入 `context_window` /
 *   `capacity_mode='auto'` / `capacity_source`；
 * - **用户手动设置过容量（`capacity_mode='manual'`）的模型绝不覆盖**；
 * - 官方登记的用途（如 MiniMax/MiMo 语音模型）随 metadata 一并写入，来源照官方标注；
 * - 没有元数据的模型保持原样（容量区显示“平台未提供容量，使用全局设置”）。
 */
export function applyFetchedCapacity(
  models: ModelServiceModel[],
  metadata: Record<string, FetchedCapacityMetadata>
): ModelServiceModel[] {
  return models.map((model) => {
    const fetched = metadata[model.name] ?? metadata[model.id];
    if (!fetched) return model;
    const next: ModelServiceModel = { ...model };
    // 官方登记的用途（语音模型）先应用；用户手动改过的能力仍以用户为准。
    if (
      Array.isArray(fetched.capabilities) &&
      fetched.capabilities.length > 0 &&
      model.source !== 'user'
    ) {
      next.capabilities = fetched.capabilities;
      next.source = 'preset';
    }
    if (fetched.contextWindow && model.capacity_mode !== 'manual') {
      next.context_window = fetched.contextWindow;
      next.capacity_mode = 'auto';
      if (fetched.capacitySource) next.capacity_source = fetched.capacitySource;
    }
    if (fetched.metadataUrl) next.metadata_url = fetched.metadataUrl;
    return next;
  });
}

function emptyConnection(platform: ProviderPreset | null): ModelServiceConnection {
  return {
    id: newId(),
    name: platform?.name ?? '自定义平台',
    platform: platform?.id ?? 'custom',
    baseUrl: platform?.baseUrl ?? '',
    models: (platform?.models ?? []).map((name) => ({
      id: name,
      name,
      capabilities: capabilitiesOf(name),
      source: 'preset',
      enabled: true
    })),
    hasKey: false
  };
}

export function ModelServicesPanel({
  api,
  adapter
}: {
  api: ApiClient;
  adapter: RuntimeAdapter;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useSettingsFeedback();
  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.listProviders()
  });
  const servicesQuery = useQuery({
    queryKey: ['model-services'],
    queryFn: () => api.getModelServices()
  });
  const [config, setConfig] = useState<ModelServicesConfig>({ connections: [], routing: {} });
  const [activeId, setActiveId] = useState('');
  const [draft, setDraft] = useState<ModelServiceConnection | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  /** 最近一次 /models 拉到的容量元数据（只含平台确实带合法窗口的模型）。 */
  const [availableModelMetadata, setAvailableModelMetadata] = useState<
    Record<string, FetchedCapacityMetadata>
  >({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [customModel, setCustomModel] = useState('');
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!modelPickerOpen) return;
    const close = (event: MouseEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) setModelPickerOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [modelPickerOpen]);
  const [busy, setBusy] = useState(false);
  /** 当前展开「容量」设置区的模型 id（'' = 全部收起）。 */
  const [capacityOpenId, setCapacityOpenId] = useState('');

  useEffect(() => {
    if (!servicesQuery.data) return;
    setConfig(servicesQuery.data);
    setActiveId((current) => current || servicesQuery.data.connections[0]?.id || '');
  }, [servicesQuery.data]);

  useEffect(() => {
    const current = config.connections.find((item) => item.id === activeId);
    setDraft(current ? { ...current, models: [...current.models] } : null);
    setApiKey('');
  }, [activeId, config.connections]);

  // 切换平台时清掉上一个平台拉到的模型与容量元数据，避免把 A 平台的容量写到 B 平台的同名模型上。
  useEffect(() => {
    setAvailableModels([]);
    setAvailableModelMetadata({});
  }, [activeId]);

  const save = useMutation({
    mutationFn: async (next: ModelServicesConfig) => {
      if (apiKey.trim() && draft) {
        await adapter.setSecret(`platform.${draft.id}.api_key`, apiKey.trim());
      }
      return api.updateModelServices({
        connections: next.connections,
        routing: next.routing
      });
    },
    onSuccess: (saved) => {
      setConfig(saved);
      setApiKey('');
      // 删除平台或单个模型都会触发服务端解绑（routing/语音/识别等自动降级）：
      // 如实逐条提示，不弹“已保存”把解绑藏起来。
      const unbound = saved.unbound ?? [];
      notify(
        unbound.length > 0
          ? `模型服务已保存。删除后已自动解绑：${unbound
              .map((item) => `${item.label}：${item.result}`)
              .join('；')}`
          : '模型服务已保存。'
      );
      void queryClient.invalidateQueries({ queryKey: ['model-services'] });
      void queryClient.invalidateQueries({ queryKey: ['secret-status'] });
      void queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      // 删模型可能把语音/识别设置降级：同步刷新，别让旧页签继续显示已删模型。
      void queryClient.invalidateQueries({ queryKey: ['speech-config'] });
      void queryClient.invalidateQueries({ queryKey: ['parsing-config'] });
    },
    onError: (error: Error) => notify(`模型服务保存失败：${error.message}`, 'error')
  });

  const commitConnections = (connections: ModelServiceConnection[]): void => {
    const next = { ...config, connections };
    setConfig(next);
    save.mutate(next);
  };

  const saveDraft = (): void => {
    if (!draft) return;
    const connections = config.connections.some((item) => item.id === draft.id)
      ? config.connections.map((item) => (item.id === draft.id ? draft : item))
      : [...config.connections, draft];
    commitConnections(connections);
  };

  const addPlatform = (platform: ProviderPreset | null): void => {
    const connection = emptyConnection(platform);
    const connections = [...config.connections, connection];
    setConfig({ ...config, connections });
    setActiveId(connection.id);
    setDraft(connection);
    save.mutate({ ...config, connections });
  };

  const removePlatform = async (): Promise<void> => {
    if (!draft) return;
    // 先问服务端这条连接被哪些用途占用，确认框里如实列出来（不只说"删除模型配置"）。
    let impactText = '';
    try {
      const impact = await api.getModelServicesImpact(draft.id);
      const parts = [
        ...impact.kinds,
        ...(impact.parsing ? ['页面识别'] : []),
        ...(impact.speechAsr ? ['语音识别'] : []),
        ...(impact.speechTts ? ['语音播报'] : [])
      ];
      if (parts.length > 0) impactText = `\n\n会同时解绑：${parts.join('、')}。`;
    } catch {
      // 影响预览失败不阻断删除：服务端保存时仍会清理引用。
    }
    if (!appDialogs.confirm(`删除平台「${draft.name}」及其模型配置？${impactText}`)) return;
    const connections = config.connections.filter((item) => item.id !== draft.id);
    const routing = { ...config.routing };
    for (const kind of Object.keys(routing) as ModelServiceKind[]) {
      if (routing[kind]?.connectionId === draft.id) delete routing[kind];
    }
    const next = { connections, routing };
    setConfig(next);
    setActiveId(connections[0]?.id ?? '');
    save.mutate(next);
  };

  const loadModels = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      // 一次调用同时拿模型名与容量元数据；metadata 分支服务端会把平台容量回写到
      // 已保存的模型上（manual 不覆盖、幂等），并通过 updated 返回实际更新数量。
      const detailed = await api.fetchConnectionModelsDetailed(draft.id);
      const updatedCount =
        (detailed as { updated?: number }).updated ?? 0;
      setAvailableModels(detailed.models);
      setAvailableModelMetadata(detailed.metadata);
      if (updatedCount > 0) {
        // 服务端已回写容量：刷新连接数据，并用最新连接更新当前草稿（避免覆盖旧容量）。
        await queryClient.invalidateQueries({ queryKey: ['model-services'] });
        const refreshed = await api.getModelServices();
        queryClient.setQueryData(['model-services'], refreshed);
        const latest = refreshed.connections.find((item) => item.id === draft.id);
        if (latest) setDraft({ ...latest, models: [...latest.models] });
      }
      const withCapacity = Object.keys(detailed.metadata).length;
      const notice = detailed.notice?.trim() ?? '';
      setModelPickerOpen(true);
      if (notice) {
        // 实时列表失败：显示已保存模型 + 官方语音快照，并如实说明没拿到实时列表，
        // 不要用“已获取 N 个模型”假装成功。
        notify(
          `${notice}（当前可添加 ${detailed.models.length} 个已保存/官方登记的模型）`
        );
      } else {
        notify(
          `已获取 ${detailed.models.length} 个模型` +
            (withCapacity > 0 ? `（其中 ${withCapacity} 个带平台容量元数据）` : '') +
            (updatedCount > 0 ? `；已自动补充 ${updatedCount} 个模型的平台容量` : '') +
            '，请从下拉列表选择要添加的模型。'
        );
      }
    } catch (error) {
      notify(
        `官方模型列表获取失败：${error instanceof Error ? error.message : '未知错误'}；可手动添加模型。`
      );
    } finally {
      setBusy(false);
    }
  };

  const updateModel = (
    modelId: string,
    patch: Partial<ModelServiceModel>
  ): void => {
    if (!draft) return;
    const models = draft.models.map((item) =>
      item.id === modelId ? { ...item, ...patch } : item
    );
    const updated = { ...draft, models };
    setDraft(updated);
    save.mutate({
      ...config,
      connections: config.connections.map((item) => (item.id === updated.id ? updated : item))
    });
  };

  const addModel = (): void => {
    if (!draft || !modelName.trim()) return;
    addModelByName(modelName.trim());
  };

  const addModelByName = (name: string): void => {
    if (!draft || !name) return;
    if (draft.models.some((item) => item.name === name)) {
      notify('模型已存在。', 'error');
      return;
    }
    const models = applyFetchedCapacity(
      [
        ...draft.models,
        {
          id: name,
          name,
          capabilities: capabilitiesOf(name),
          source: 'user' as const,
          enabled: true
        }
      ],
      availableModelMetadata
    );
    const updated = { ...draft, models };
    setDraft(updated);
    setModelName('');
    commitConnections(
      config.connections.map((item) => (item.id === updated.id ? updated : item))
    );
  };

  const setAssignment = (
    kind: ModelServiceKind,
    connectionId: string,
    model: string
  ): void => {
    const routing: ModelServiceRouting = {
      ...config.routing,
      [kind]: { connectionId, model }
    };
    if (!connectionId || !model) delete routing[kind];
    const next = { ...config, routing };
    setConfig(next);
    save.mutate(next);
  };

  const allModels = config.connections.flatMap((connection) =>
    connection.models.map((model) => ({ connection, model }))
  );
  const candidateModels = draft
    ? [...new Set([...draft.models.map((model) => model.name), ...availableModels])]
    : [];

  const selectedPreset =
    providersQuery.data?.find((provider) => provider.id === draft?.platform) ?? null;

  return (
    <section className="kr-settings__section">
      <div className="kr-settings__section-head">
        <h2>模型服务</h2>
        <HintMark
          text="集中配置平台与模型；会话、Embedding、Rerank、翻译、语音等需要模型的页面都从这里选择对应服务。"
        />
      </div>
      <SendingNotice text="若触发模型调用，相关内容会被发送到相应服务。" />
      <p className="kr-muted" role="note">
        请仅接入依法合规运营的生成式 AI 服务；请勿接入未备案/未合规服务、来源不明的共享
        Key 或中转端点，相关数据传输风险与合规责任由用户自行承担。应用不验证服务商是否已备案。
      </p>

      <div className="kr-model-services">
        <aside className="kr-model-services__platforms">
          {config.connections.map((connection) => (
            <button
              key={connection.id}
              type="button"
              className={connection.id === activeId ? 'is-active' : ''}
              onClick={() => setActiveId(connection.id)}
            >
              <strong>{connection.name}</strong>
              <small>{connection.platform}</small>
            </button>
          ))}
          <select
            className="kr-model-services__add"
            value=""
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              const platform = providersQuery.data?.find((item) => item.id === value) ?? null;
              addPlatform(platform);
            }}
          >
            <option value="">＋ 添加平台</option>
            {(providersQuery.data ?? []).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
            <option value="custom">自定义平台</option>
          </select>
        </aside>

        <div className="kr-model-services__editor">
          {draft ? (
            <>
              <div className="kr-model-services__row">
                <label>
                  <span>连接名称</span>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  <span>平台</span>
                  <select
                    value={draft.platform}
                    onChange={(event) => {
                      const platform = providersQuery.data?.find(
                        (item) => item.id === event.target.value
                      );
                      setDraft({
                        ...draft,
                        platform: event.target.value,
                        name: platform?.name ?? draft.name,
                        baseUrl: platform?.baseUrl ?? draft.baseUrl,
                        models: platform
                          ? platform.models.map((name) => ({
                              id: name,
                              name,
                              capabilities: capabilitiesOf(name),
                              source: 'preset' as const,
                              enabled: true
                            }))
                          : draft.models
                      });
                    }}
                  >
                    <option value="custom">自定义</option>
                    {(providersQuery.data ?? []).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedPreset?.description ? (
                <p className="kr-muted kr-model-services__preset-hint">
                  {selectedPreset.description}
                  {selectedPreset.docsUrl ? (
                    <>
                      {' '}
                      <a
                        className="kr-link-button"
                        href={selectedPreset.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        官方接入文档
                      </a>
                    </>
                  ) : null}
                </p>
              ) : null}
              {draft.platform === 'local' ? (
                <label>
                  <span>本地服务类型</span>
                  <select
                    value=""
                    onChange={(event) => {
                      const presets: Record<string, { name: string; baseUrl: string }> = {
                        ollama: { name: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
                        lmstudio: { name: '本机 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
                        vllm: { name: '本机 vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
                        llamacpp: { name: '本机 llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
                        localai: { name: '本机 LocalAI', baseUrl: 'http://127.0.0.1:8081/v1' },
                        xinference: { name: '本机 Xinference', baseUrl: 'http://127.0.0.1:9997/v1' },
                        jan: { name: '本机 Jan', baseUrl: 'http://127.0.0.1:1337/v1' },
                        textgen: {
                          name: '本机 Text generation webui',
                          baseUrl: 'http://127.0.0.1:5000/v1'
                        }
                      };
                      const preset = presets[event.target.value];
                      if (preset) setDraft({ ...draft, name: preset.name, baseUrl: preset.baseUrl });
                    }}
                  >
                    <option value="">选择本地服务</option>
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="vllm">vLLM</option>
                    <option value="llamacpp">llama.cpp</option>
                    <option value="localai">LocalAI</option>
                    <option value="xinference">Xinference</option>
                    <option value="jan">Jan</option>
                    <option value="textgen">Text generation webui</option>
                  </select>
                </label>
              ) : null}
              <label>
                <span>服务根地址</span>
                <input
                  type="url"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  placeholder="例如 https://api.deepseek.com/v1"
                />
              </label>
              <label>
                <span>API Key（已保存时留空保留）</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={draft.hasKey ? '已保存，留空保留' : '填写平台 API Key'}
                  autoComplete="off"
                />
                {selectedPreset?.keyHint ? (
                  <small className="kr-muted">{selectedPreset.keyHint}</small>
                ) : null}
              </label>
              <div className="kr-settings__actions">
                <button type="button" onClick={saveDraft} disabled={save.isPending}>
                  保存平台
                </button>
                <button type="button" className="kr-secondary" onClick={() => void loadModels()} disabled={busy}>
                  {busy ? '获取中…' : '获取模型'}
                </button>
                <button type="button" className="kr-secondary" onClick={() => void removePlatform()}>
                  删除此平台
                </button>
              </div>

              <div className="kr-model-picker" ref={pickerRef}>
                <div className="kr-model-picker__bar">
                  <button
                    type="button"
                    className="kr-model-picker__trigger"
                    aria-expanded={modelPickerOpen}
                    onClick={() => setModelPickerOpen((value) => !value)}
                  >
                    <span
                      className={
                        draft.models.length === 0
                          ? 'kr-model-picker__placeholder'
                          : undefined
                      }
                    >
                      添加模型
                    </span>
                    {draft.models.length > 0 ? (
                      <span className="kr-model-picker__count">{draft.models.length}</span>
                    ) : null}
                    <span aria-hidden="true">▾</span>
                  </button>
                  <button
                    type="button"
                    className="kr-secondary"
                    onClick={() => void loadModels()}
                    disabled={busy}
                  >
                    {busy ? '获取中…' : '获取模型'}
                  </button>
                </div>
                {modelPickerOpen ? (
                  <div className="kr-model-picker__popover">
                    <input
                      autoFocus
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="搜索模型…"
                    />
                    <div className="kr-model-picker__list">
                      {candidateModels
                        .filter((name) =>
                          name.toLowerCase().includes(modelSearch.trim().toLowerCase())
                        )
                        .map((name) => {
                          const added = draft.models.some((item) => item.name === name);
                          return (
                            <button
                              key={name}
                              type="button"
                              className={added ? 'is-added' : ''}
                              onClick={() => {
                                if (added) {
                                  const updated = {
                                    ...draft,
                                    models: draft.models.filter((item) => item.name !== name)
                                  };
                                  setDraft(updated);
                                  commitConnections(
                                    config.connections.map((item) =>
                                      item.id === updated.id ? updated : item
                                    )
                                  );
                                } else {
                                  addModelByName(name);
                                }
                              }}
                            >
                              <span className="kr-model-picker__check">
                                {added ? '✓' : ''}
                              </span>
                              <span>{name}</span>
                            </button>
                          );
                        })}
                      {candidateModels.length === 0 ? (
                        <p className="kr-muted">
                          点击右侧「获取模型」读取官方模型列表，或在下方输入自定义模型。
                        </p>
                      ) : null}
                    </div>
                    <div className="kr-model-picker__custom">
                      <input
                        value={customModel}
                        onChange={(event) => setCustomModel(event.target.value)}
                        placeholder="输入 ID 添加自定义模型"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addModelByName(customModel.trim());
                            setCustomModel('');
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="kr-secondary"
                        onClick={() => {
                          addModelByName(customModel.trim());
                          setCustomModel('');
                        }}
                      >
                        添加
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="kr-model-added">
                {draft.models.map((model) => (
                  <div className="kr-model-added__item" key={model.id}>
                    <div className="kr-model-added__row">
                    <div className="kr-model-added__name">
                      <strong title={model.name}>{model.name}</strong>
                    </div>
                    <div className="kr-cap-pills">
                      {CAPABILITY_META.map((meta) => {
                        const isOmni = model.capabilities.includes('omni');
                        const implied =
                          isOmni && ['chat', 'vision', 'asr'].includes(meta.kind);
                        const active =
                          model.capabilities.includes(meta.kind) || implied;
                        return (
                          <button
                            key={meta.kind}
                            type="button"
                            className={`kr-cap-pill ${active ? 'is-on' : ''}${
                              implied ? ' is-implied' : ''
                            }`}
                            title={
                              implied
                                ? `${meta.label}：由「全模态」包含，取消全模态后可单独调整`
                                : meta.label
                            }
                            disabled={implied}
                            onClick={() => {
                              if (meta.kind === 'omni') {
                                const next = active
                                  ? model.capabilities.filter((item) => item !== 'omni')
                                  : [
                                      ...new Set([
                                        ...model.capabilities,
                                        'omni',
                                        'chat',
                                        'vision',
                                        'asr'
                                      ])
                                    ];
                                updateModel(model.id, { capabilities: next });
                                return;
                              }
                              const next = active
                                ? model.capabilities.filter(
                                    (item) =>
                                      item !== meta.kind &&
                                      // 取消任一被全模态蕴含的能力，同时取消全模态：
                                      // 避免“全模态还在，但包含项被关掉”的矛盾状态。
                                      !(isOmni && item === 'omni')
                                  )
                                : [...new Set([...model.capabilities, meta.kind])];
                              updateModel(model.id, {
                                capabilities: next.length ? next : [meta.kind]
                              });
                            }}
                          >
                            <span aria-hidden="true">{meta.symbol}</span>
                            {meta.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="kr-model-added__actions">
                    <button
                      type="button"
                      className="kr-link-button"
                      onClick={() => {
                        const updated = {
                          ...draft,
                          models: draft.models.filter((item) => item.id !== model.id)
                        };
                        setDraft(updated);
                        commitConnections(
                          config.connections.map((item) =>
                            item.id === updated.id ? updated : item
                          )
                        );
                      }}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="kr-link-button"
                      title="容量与任务思考设置"
                      onClick={() =>
                        setCapacityOpenId(capacityOpenId === model.id ? '' : model.id)
                      }
                    >
                      容量
                    </button>
                    {model.metadata_url ? (
                      <a
                        className="kr-link-button"
                        href={model.metadata_url}
                        target="_blank"
                        rel="noreferrer"
                        title="官方来源（模型能力/容量由官方文档登记）"
                      >
                        来源
                      </a>
                    ) : null}
                    </div>
                    </div>
                    {capacityOpenId === model.id ? (
                      <div className="kr-model-added__capacity">
                        <label className="kr-model-added__capacity-mode">
                          <input
                            type="checkbox"
                            checked={model.capacity_mode === 'manual'}
                            onChange={(event) => {
                              if (event.target.checked) {
                                updateModel(model.id, {
                                  capacity_mode: 'manual',
                                  context_window: model.context_window ?? 65536,
                                  capacity_source: CAPACITY_MANUAL_SOURCE
                                });
                              } else {
                                updateModel(model.id, {
                                  capacity_mode: 'auto',
                                  capacity_source:
                                    model.capacity_source === CAPACITY_MANUAL_SOURCE
                                      ? undefined
                                      : model.capacity_source
                                });
                              }
                            }}
                          />
                          手动指定容量
                        </label>
                        <label className="kr-model-added__capacity-window">
                          上下文窗口（token）
                          <input
                            type="number"
                            min={CAPACITY_MIN}
                            max={CAPACITY_MAX}
                            step={1024}
                            value={model.context_window ?? ''}
                            disabled={model.capacity_mode !== 'manual'}
                            onChange={(event) => {
                              const raw = event.target.value.trim();
                              if (!raw) {
                                updateModel(model.id, { context_window: undefined });
                                return;
                              }
                              const value = Number(raw);
                              if (
                                !Number.isInteger(value) ||
                                value < CAPACITY_MIN ||
                                value > CAPACITY_MAX
                              ) {
                                notify(
                                  `上下文窗口需为 ${CAPACITY_MIN}–${CAPACITY_MAX} 之间的整数`,
                                  'error'
                                );
                                return;
                              }
                              updateModel(model.id, {
                                context_window: value,
                                capacity_source: CAPACITY_MANUAL_SOURCE
                              });
                            }}
                          />
                        </label>
                        <label className="kr-model-added__thinking">
                          <input
                            type="checkbox"
                            checked={Boolean(model.task_thinking)}
                            onChange={(event) =>
                              updateModel(model.id, {
                                task_thinking: event.target.checked
                              })
                            }
                          />
                          任务型调用关闭深度思考
                        </label>
                        <p className="kr-muted kr-model-added__capacity-hint">
                          来源：
                          {model.capacity_source ||
                            (model.capacity_mode === 'manual'
                              ? CAPACITY_MANUAL_SOURCE
                              : '平台未提供容量，使用全局设置（可手动指定）')}
                          。「任务型调用关闭深度思考」仅对支持思考开关的平台生效；本版本只保存设置并在此展示，
                          不会向平台发送猜测的私有参数。
                        </p>
                        <p className="kr-muted kr-model-added__capacity-hint">
                          最大输出：
                          {model.max_output !== undefined
                            ? `${model.max_output.toLocaleString('zh-CN')} token`
                            : '未登记'}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="kr-muted">先添加一个平台。</p>
          )}

        </div>
      </div>
    </section>
  );
}
