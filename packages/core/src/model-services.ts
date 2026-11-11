import type {
  ModelServiceAssignment,
  ModelServiceConnection,
  ModelServiceKind,
  ModelServiceModel,
  ModelServiceRouting,
  ModelServicesConfig
} from '@studianda/shared';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';
import { officialModelMetadata, speechModels } from './model-metadata.js';

const SERVICES_KEY = 'model.services';
const ROUTING_KEY = 'model.routing';

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function readModelServices(store: Store): ModelServicesConfig {
  const settings = store.getSettings();
  return {
    connections: parseJson<ModelServiceConnection[]>(settings[SERVICES_KEY], []),
    routing: parseJson<ModelServiceRouting>(settings[ROUTING_KEY], {})
  };
}

/**
 * 读取时用官方文档快照补「最大输出」。
 *
 * 只读字段：按当前快照现算，`saveModelServices` 会把它丢掉，所以快照更新后不会残留旧值。
 * 官方没登记该模型的输出上限时，把可能残留的旧字段一并清掉。
 */
function withOfficialOutputInfo(model: ModelServiceModel, baseUrl: string): ModelServiceModel {
  const official = officialModelMetadata(baseUrl, model.name || model.id || '');
  if (typeof official?.maxOutput !== 'number') {
    if (model.max_output === undefined && model.max_output_source === undefined) return model;
    const next = { ...model };
    delete next.max_output;
    delete next.max_output_source;
    return next;
  }
  return {
    ...model,
    max_output: official.maxOutput,
    max_output_source: official.source
  };
}

export function publicModelServices(
  store: Store,
  secrets: SecretStore
): ModelServicesConfig {
  const config = readModelServices(store);
  return {
    connections: config.connections.map((connection) => ({
      ...connection,
      models: (connection.models ?? []).map((model) =>
        withOfficialOutputInfo(model, connection.baseUrl)
      ),
      hasKey: Boolean(secrets.get(`platform.${connection.id}.api_key`)?.trim())
    })),
    routing: config.routing
  };
}

/** 从平台返回的模型元数据判断能力。 */
export function classifyPlatformCapabilities(row: Record<string, unknown>): string[] | undefined {
  const type = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  const subType = typeof row.sub_type === 'string' ? row.sub_type.toLowerCase() : '';
  const architecture =
    row.architecture && typeof row.architecture === 'object'
      ? (row.architecture as { input_modalities?: unknown; output_modalities?: unknown })
      : {};
  const inputs = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    : [];
  const outputs = Array.isArray(architecture.output_modalities)
    ? architecture.output_modalities.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    : [];
  const capabilities = new Set<string>();
  const label = `${type} ${subType}`;
  if (/embedding/.test(label)) capabilities.add('embedding');
  if (/rerank/.test(label)) capabilities.add('rerank');
  if (/\basr\b|speech[-_ ]?to[-_ ]?text|transcri/.test(label)) capabilities.add('asr');
  if (/\btts\b|text[-_ ]?to[-_ ]?speech|speech[-_ ]?synth/.test(label)) capabilities.add('tts');
  if (inputs.includes('image') && outputs.includes('text')) capabilities.add('vision');
  if (inputs.includes('audio') && outputs.includes('text')) capabilities.add('asr');
  if (inputs.includes('text') && outputs.includes('text') && !capabilities.has('embedding') && !capabilities.has('rerank')) {
    capabilities.add('chat');
  }
  return capabilities.size > 0 ? [...capabilities] : undefined;
}

/**
 * 删除这条平台连接会影响哪些用途（只读；供界面在确认前如实提示）。
 */
export function modelServicesImpact(
  store: Store,
  connectionId: string
): { kinds: string[]; parsing: boolean; speechAsr: boolean; speechTts: boolean } {
  const id = (connectionId ?? '').trim();
  const config = readModelServices(store);
  const kinds = Object.entries(config.routing)
    .filter(([, assignment]) => assignment?.connectionId === id)
    .map(([kind]) => kind);
  const settings = store.getSettings();
  return {
    kinds,
    parsing: (settings['parsing.connection_id'] ?? '') === id,
    speechAsr: (settings['speech.asr_connection_id'] ?? '') === id,
    speechTts: (settings['speech.tts_connection_id'] ?? '') === id
  };
}
function isLocalOrLanHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return true;
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * 校验并规范化模型服务根地址：
 * 只 http/https；http 仅本机/局域网；禁止账号密码/query/fragment；禁止写成具体接口路径。
 */
export function validateModelServiceUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('请填写服务地址');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('服务地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('服务地址必须以 http:// 或 https:// 开头');
  }
  if (url.username || url.password) throw new Error('服务地址不能包含账号密码');
  if (url.search || url.hash) throw new Error('服务地址不能包含查询参数或片段');
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (url.protocol === 'http:' && !isLocalOrLanHost(host)) {
    throw new Error('http 地址只允许本机或局域网；远程服务请使用 https');
  }
  const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
  for (const suffix of [
    '/chat/completions',
    '/completions',
    '/models',
    '/embeddings',
    '/rerank',
    '/audio/transcriptions',
    '/audio/speech'
  ]) {
    if (pathname.endsWith(suffix)) {
      throw new Error('服务地址应是接口根地址（不要带 /chat/completions 等具体接口路径）');
    }
  }
  return trimmed.replace(/\/+$/, '');
}

export interface ModelServicesUnbound {
  /** 用途：chat/embedding/rerank/speech:asr/speech:tts/parsing。 */
  kind: string;
  /** 中文用途名（界面直接展示）。 */
  label: string;
  /** 中文降级说明（已改成什么）。 */
  result: string;
}

/** 保存模型服务的结果：配置本体 + 删除连接时触发的降级清单。 */
export type SaveModelServicesResult = ModelServicesConfig & {
  unbound: ModelServicesUnbound[];
};

const UNBOUND_LABELS: Record<string, string> = {
  chat: '会话模型',
  embedding: 'Embedding',
  rerank: 'Rerank',
  translation: '翻译',
  asr: '语音识别',
  tts: '语音生成',
  vision: '视觉读页',
  omni: '全模态',
  'speech:asr': '语音识别',
  'speech:tts': '语音播报',
  parsing: 'PDF 与文字识别'
};

/**
 * 找出"平台连接还在、但模型被删掉"的模型（按 id / name 双向匹配）。
 *
 * 删除整个连接由 `saveModelServices` 的连接分支处理；这里只处理连接保留、
 * 模型清单里少了一条的情况，用来清掉指向该模型的悬空引用。
 */
function removedModelsOf(
  current: ModelServiceConnection[],
  next: ModelServiceConnection[]
): Array<{ connectionId: string; models: ModelServiceModel[] }> {
  const result: Array<{ connectionId: string; models: ModelServiceModel[] }> = [];
  for (const connection of next) {
    const previous = current.find((item) => item.id === connection.id);
    if (!previous) continue;
    const kept = new Set<string>();
    for (const model of connection.models) {
      if (model.id) kept.add(model.id);
      if (model.name) kept.add(model.name);
    }
    const removed = previous.models.filter(
      (model) => !kept.has(model.id) && !kept.has(model.name)
    );
    if (removed.length > 0) result.push({ connectionId: connection.id, models: removed });
  }
  return result;
}

export function saveModelServices(
  store: Store,
  input: Partial<ModelServicesConfig>,
  secrets?: SecretStore
): SaveModelServicesResult {
  const current = readModelServices(store);
  const connections = Array.isArray(input.connections)
    ? input.connections.map((connection) => {
        // `max_output` / `max_output_source` 是读取时按官方快照填入的只读字段，不落库：
        // 否则快照更新（或换平台）后会一直留着旧值，误导容量显示。
        const models = (connection.models ?? []).map((model) => {
          const next = { ...model };
          delete next.max_output;
          delete next.max_output_source;
          return next;
        });
        return {
          ...connection,
          models,
          baseUrl: validateModelServiceUrl(connection.baseUrl)
        };
      })
    : current.connections;
  const routing: ModelServiceRouting = input.routing && typeof input.routing === 'object'
    ? input.routing
    : current.routing;
  const unbound: ModelServicesUnbound[] = [];
  const settings = store.getSettings();
  const patch: Record<string, string> = {};
  const secretsToClear = new Set<string>();
  // 删除连接时解除引用并**明确降级**：
  // 只清 connection_id 会让语音仍停在 model 模式、视觉仍停在 vision 模式，
  // 之后才在运行期报“请先选择语音平台/配置模型服务地址”。
  const removed = current.connections.filter(
    (connection) => !connections.some((next) => next.id === connection.id)
  );
  if (removed.length > 0) {
    const removedIds = new Set(removed.map((connection) => connection.id));
    const removedAssignments: Array<{ kind: ModelServiceKind; connectionId: string }> = [];
    // 注意：要从**删除前**的 routing 找被解绑的用途。更新请求里的 routing 可能已经把这些
    // 键删掉了（UI 删除时就是这样），只看新 routing 会漏掉降级说明。
    for (const [kind, assignment] of Object.entries(current.routing)) {
      if (assignment && removedIds.has(assignment.connectionId)) {
        removedAssignments.push({
          kind: kind as ModelServiceKind,
          connectionId: assignment.connectionId
        });
        // 新 routing 里若还残留指向已删连接的键，一并清掉；不要误删已经改指新连接的同名用途。
        const nextAssignment = (routing as Record<string, unknown>)[kind] as
          | ModelServiceAssignment
          | undefined;
        if (nextAssignment && removedIds.has(nextAssignment.connectionId)) {
          delete (routing as Record<string, unknown>)[kind];
        }
      }
    }
    for (const connection of removed) {
      const removedId = connection.id;
      // chat/embedding/rerank：路由被删除后该用途变为未配置，需要重新选择模型。
      for (const assignment of removedAssignments) {
        if (assignment.connectionId !== removedId) continue;
        const kind = assignment.kind;
        if (kind !== 'chat' && kind !== 'embedding' && kind !== 'rerank') continue;
        unbound.push({
          kind,
          label: UNBOUND_LABELS[kind] ?? kind,
          result: '已改为未配置，需要重新在模型服务选择模型'
        });
      }
      // 语音：该连接的 ASR/TTS 改回本机 Windows，并清平台密钥。
      for (const kind of ['asr', 'tts'] as const) {
        if ((settings[`speech.${kind}_connection_id`] ?? '') !== removedId) continue;
        patch[`speech.${kind}_mode`] = 'system';
        patch[`speech.${kind}_url`] = '';
        patch[`speech.${kind}_model`] = '';
        patch[`speech.${kind}_connection_id`] = '';
        secretsToClear.add(`speech.${kind}_key`);
        unbound.push({
          kind: `speech:${kind}`,
          label: UNBOUND_LABELS[`speech:${kind}`] ?? kind,
          result: '已改回本机 Windows，可在语音设置重新选择'
        });
      }
      // 解析：优先保留用户原填的服务地址，其次回填被删平台地址。
      if ((settings['parsing.connection_id'] ?? '') === removedId) {
        patch['parsing.service_url'] =
          (settings['parsing.service_url'] ?? '').trim() ||
          connection.baseUrl.replace(/\/+$/, '');
        patch['parsing.connection_id'] = '';
        if (settings['parsing.mode'] === 'vision') {
          patch['parsing.mode'] = 'local';
          patch['parsing.model'] = '';
          unbound.push({
            kind: 'parsing',
            label: UNBOUND_LABELS.parsing ?? 'PDF 与文字识别',
            result: '图像模型来自该平台，已改回本机 OCR'
          });
        } else {
          unbound.push({
            kind: 'parsing',
            label: UNBOUND_LABELS.parsing ?? 'PDF 与文字识别',
            result: '已改为独立服务地址，请核对'
          });
        }
      }
    }
    for (const connection of removed) {
      secretsToClear.add(`platform.${connection.id}.api_key`);
    }
  }

  // 删除单个模型（平台连接仍保留）时同样要自动清引用：否则 routing、语音、识别设置里
  // 会留下指向"已经不存在的模型"的配置——界面看起来已选好，实际调用才报错。
  for (const removal of removedModelsOf(current.connections, connections)) {
    const { connectionId, models: removedModels } = removal;
    // 其余用途（会话/翻译/Embedding/Rerank/视觉/全模态/语音路由）：解除绑定后需要重新选择。
    for (const [kind, assignment] of Object.entries(routing)) {
      if (!assignment || assignment.connectionId !== connectionId) continue;
      if (
        !removedModels.some(
          (model) => model.name === assignment.model || model.id === assignment.model
        )
      ) {
        continue;
      }
      delete (routing as Record<string, unknown>)[kind];
      unbound.push({
        kind,
        label: UNBOUND_LABELS[kind] ?? kind,
        result: `模型「${assignment.model}」已删除，已自动解绑，需要重新选择模型`
      });
    }
    // 语音设置里选中的该模型：改回本机 Windows（与删除平台时的降级一致）。
    for (const kind of ['asr', 'tts'] as const) {
      if ((settings[`speech.${kind}_connection_id`] ?? '') !== connectionId) continue;
      const assigned = (settings[`speech.${kind}_model`] ?? '').trim();
      if (
        !assigned ||
        !removedModels.some((model) => model.name === assigned || model.id === assigned)
      ) {
        continue;
      }
      patch[`speech.${kind}_mode`] = 'system';
      patch[`speech.${kind}_url`] = '';
      patch[`speech.${kind}_model`] = '';
      patch[`speech.${kind}_connection_id`] = '';
      secretsToClear.add(`speech.${kind}_key`);
      unbound.push({
        kind: `speech:${kind}`,
        label: UNBOUND_LABELS[`speech:${kind}`] ?? kind,
        result: '使用的模型已删除，已改回本机 Windows，可在语音设置重新选择'
      });
    }
    // 识别设置里选中的该模型：视觉模式改回本机 OCR；其它模式只清掉悬空的模型名。
    const parsingModel = (settings['parsing.model'] ?? '').trim();
    if ((settings['parsing.connection_id'] ?? '') === connectionId && parsingModel) {
      if (removedModels.some((model) => model.name === parsingModel || model.id === parsingModel)) {
        if (settings['parsing.mode'] === 'vision') {
          patch['parsing.mode'] = 'local';
          patch['parsing.model'] = '';
          patch['parsing.connection_id'] = '';
          unbound.push({
            kind: 'parsing',
            label: UNBOUND_LABELS.parsing ?? 'PDF 与文字识别',
            result: '视觉模型已删除，已改回本机 OCR'
          });
        } else {
          patch['parsing.model'] = '';
        }
      }
    }
  }

  // 赋值校验：模型明确标注了能力、但不支持该用途时拒绝保存，
  // 避免"选中一个跑不通的组合"到运行期才失败；能力未知（空数组）时放行。
  for (const [kind, assignment] of Object.entries(routing)) {
    if (!assignment) continue;
    const connection = connections.find((item) => item.id === assignment.connectionId);
    const model = connection?.models.find(
      (item) => item.name === assignment.model || item.id === assignment.model
    );
    if (!model || model.capabilities.length === 0) continue;
    const required = kind === 'translation' ? 'chat' : kind;
    // 旧配置里可能还留着历史「翻译」能力标注；翻译实际使用会话模型，两者都接受。
    const supported =
      kind === 'translation' && model.capabilities.includes('translation')
        ? true
        : modelSupports(required, model);
    if (!supported) {
      throw new Error(
        `模型「${assignment.model}」不支持「${kind}」用途，请重新选择模型或先标注能力。`
      );
    }
  }
  // 校验通过后才落库解绑结果：校验失败时不留半套配置（不静默改设置/清密钥）。
  if (Object.keys(patch).length > 0) store.updateSettings(patch);
  for (const secret of secretsToClear) secrets?.clear(secret);
  store.updateSettings({
    [SERVICES_KEY]: JSON.stringify(connections),
    [ROUTING_KEY]: JSON.stringify(routing)
  });
  return { connections, routing, unbound };
}

export interface ResolvedModelService {
  baseUrl: string;
  model: string;
  apiKey: string;
  connectionId: string;
}

export interface ResolvedModelConnection {
  baseUrl: string;
  apiKey: string;
  connectionId: string;
}

/**
 * 按连接 id 取地址与密钥（模型由调用方按自己的用途给出）。
 *
 * 视觉识别这类"模型不在 routing 里"的用途需要它：解析配置只存了
 * `connection_id` 与 `model`，地址与密钥必须回到「模型服务」里那条连接上取，
 * 不能去读无人写入的 `model.base_url`。连接不存在或没有地址时返回 null，
 * 由调用方决定如何降级。
 */
export function resolveModelConnection(
  store: Store,
  secrets: SecretStore,
  connectionId: string | null | undefined
): ResolvedModelConnection | null {
  const id = (connectionId ?? '').trim();
  if (!id) return null;
  const config = readModelServices(store);
  const connection = config.connections.find((item) => item.id === id);
  if (!connection?.baseUrl) return null;
  return {
    baseUrl: connection.baseUrl.replace(/\/+$/, ''),
    apiKey: secrets.get(`platform.${connection.id}.api_key`)?.trim() || '',
    connectionId: connection.id
  };
}

export function resolveModelService(
  store: Store,
  secrets: SecretStore,
  kind: ModelServiceKind
): ResolvedModelService | null {
  const config = readModelServices(store);
  return resolveAssignment(config, secrets, config.routing[kind]);
}

/** 模型元数据里的容量范围。 */
export const MIN_MODEL_CONTEXT_WINDOW = 8192;
export const MAX_MODEL_CONTEXT_WINDOW = 4_000_000;

export interface ResolvedModelCapacity {
  /** 合法（整数且 8192–4000000）的上下文窗口；缺失/越界时省略。 */
  contextWindow?: number;
  capacityMode?: 'auto' | 'manual';
  taskThinking?: boolean;
  source?: string;
  /** 官方登记的大输出模型：输出预留至少抬到 16384。 */
  outputReserve?: number;
}

/**
 * 按「模型服务」里给某用途绑定的模型，取它的容量元数据。
 *
 * - `manual`：只认用户保存的容量，不回退官方快照（用户明确覆盖）。
 * - `auto`/未标注：先看已保存的平台元数据；没有时查**官方登记**（DeepSeek 1M 上下文、
 *   大输出模型抬 output_reserve），仍没有则省略，由调用方退回全局设置。
 * - 越界/坏值当作没有元数据，不能让阅读直接失败。
 */
export function resolveModelCapacity(
  store: Store,
  kind: ModelServiceKind = 'chat'
): ResolvedModelCapacity | null {
  const config = readModelServices(store);
  const model = assignedModelOf(config, config.routing[kind]);
  if (!model) return null;
  const raw = model.context_window;
  let contextWindow =
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= MIN_MODEL_CONTEXT_WINDOW &&
    raw <= MAX_MODEL_CONTEXT_WINDOW
      ? raw
      : undefined;
  const capacityMode =
    model.capacity_mode === 'manual'
      ? 'manual'
      : model.capacity_mode === 'auto'
        ? 'auto'
        : undefined;
  let source = model.capacity_source;
  let outputReserve: number | undefined;
  if (capacityMode !== 'manual') {
    const connection = config.connections.find(
      (item) => item.id === config.routing[kind]?.connectionId
    );
    const official = connection
      ? officialModelMetadata(connection.baseUrl, model.name || model.id || '')
      : null;
    if (official) {
      if (contextWindow === undefined && official.contextWindow) {
        contextWindow = official.contextWindow;
        source = official.source;
      }
      if (official.maxOutput !== undefined && official.maxOutput >= 16384) {
        outputReserve = 16384;
      }
    }
  }
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(capacityMode ? { capacityMode } : {}),
    ...(typeof model.task_thinking === 'boolean' ? { taskThinking: model.task_thinking } : {}),
    ...(source ? { source } : {}),
    ...(outputReserve !== undefined ? { outputReserve } : {})
  };
}

function resolveAssignment(
  config: ModelServicesConfig,
  secrets: SecretStore,
  assignment: ModelServiceAssignment | undefined
): ResolvedModelService | null {
  if (!assignment?.connectionId || !assignment.model) return null;
  const connection = config.connections.find((item) => item.id === assignment.connectionId);
  if (!connection?.baseUrl) return null;
  return {
    baseUrl: connection.baseUrl.replace(/\/+$/, ''),
    model: assignment.model,
    apiKey: secrets.get(`platform.${connection.id}.api_key`)?.trim() || '',
    connectionId: connection.id
  };
}

/** 在某条连接的模型清单里找到被指派的那条模型（按 name 或 id 都认）。 */
function assignedModelOf(
  config: ModelServicesConfig,
  assignment: ModelServiceAssignment | undefined
): ModelServiceConnection['models'][number] | null {
  if (!assignment?.connectionId || !assignment.model) return null;
  const connection = config.connections.find((item) => item.id === assignment.connectionId);
  if (!connection) return null;
  return (
    connection.models.find(
      (item) => item.name === assignment.model || item.id === assignment.model
    ) ?? null
  );
}

/**
 * 这个模型能不能承担某个用途。
 *
 * `omni`（全模态）是"一个模型同时会做"的声明：它蕴含 chat / vision / audio。
 * 其余能力必须显式标注——名称像视觉模型不等于它真能读图。
 */
export function modelSupports(
  kind: string,
  model: { capabilities?: readonly string[] } | null | undefined
): boolean {
  const capabilities = model?.capabilities ?? [];
  if (capabilities.includes(kind)) return true;
  if (!capabilities.includes('omni')) return false;
  return kind === 'chat' || kind === 'vision' || kind === 'audio' || kind === 'omni';
}

/**
 * 视觉读页用的模型：优先 `routing.vision`，其次 `routing.omni`，
 * 最后回退到"本身带视觉能力（vision 或 omni）的会话模型"。
 *
 * 视觉读页产出的是**派生解读**（图表/公式/结构），不是逐字原文，不能当逐字证据；
 * OCR 的「视觉模型」只做页面文字转录。两者可以复用同一个模型，也可以分别选择。
 */
export function resolveVisualService(
  store: Store,
  secrets: SecretStore
): ResolvedModelService | null {
  const config = readModelServices(store);
  const direct =
    resolveAssignment(config, secrets, config.routing.vision) ??
    resolveAssignment(config, secrets, config.routing.omni);
  if (direct) return direct;
  const chatAssignment = config.routing.chat;
  const model = assignedModelOf(config, chatAssignment);
  if (!model || !modelSupports('vision', model)) return null;
  return resolveAssignment(config, secrets, chatAssignment);
}

/**
 * 全模态用途（需要"同一个模型同时处理文本+图像/音频"时）：
 * 优先 `routing.omni`，其次回退到带 omni/audio 能力的会话模型。
 */
export function resolveOmniService(
  store: Store,
  secrets: SecretStore
): ResolvedModelService | null {
  const config = readModelServices(store);
  const direct = resolveAssignment(config, secrets, config.routing.omni);
  if (direct) return direct;
  const chatAssignment = config.routing.chat;
  const model = assignedModelOf(config, chatAssignment);
  if (!model || !modelSupports('audio', model)) return null;
  return resolveAssignment(config, secrets, chatAssignment);
}

/** `/models` 行里可能出现的容量字段名（各平台命名不同）。 */
const FETCHED_CAPACITY_FIELDS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len'
] as const;

const FETCHED_CAPACITY_SOURCE = '平台 /models 元数据';
const OLLAMA_CAPACITY_SOURCE = 'Ollama 本机元数据';

/** 连接是不是 Ollama：显式 platform，或典型的本机 11434 端口。 */
function isOllamaConnection(connection: ModelServiceConnection): boolean {
  if ((connection.platform ?? '').toLowerCase() === 'ollama') return true;
  try {
    return new URL(connection.baseUrl).port === '11434';
  } catch {
    return false;
  }
}

function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function validContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MODEL_CONTEXT_WINDOW &&
    value <= MAX_MODEL_CONTEXT_WINDOW
    ? value
    : undefined;
}

/** 从 `/api/show` 的 model_info 或顶层字段里取合法上下文长度。 */
function contextFromShow(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as { model_info?: unknown; context_length?: unknown };
  if (record.model_info && typeof record.model_info === 'object' && !Array.isArray(record.model_info)) {
    for (const [key, value] of Object.entries(record.model_info as Record<string, unknown>)) {
      if (!key.endsWith('.context_length')) continue;
      const context = validContextWindow(value);
      if (context !== undefined) return context;
    }
  }
  return validContextWindow(record.context_length);
}

/**
 * Ollama 的 `/models` 不返回容量；按下面的顺序补查：
 * 每个缺容量的模型 `POST /api/show`（model_info.*.context_length / 顶层 context_length），
 * 仍未补到的再 `GET /api/ps` 一次（按 name/model 匹配 context_length）。
 * 全部只读；任何网络/解析/非 2xx 错误静默跳过，不影响 `/models` 结果。
 */
async function completeOllamaCapacity(
  connection: ModelServiceConnection,
  headers: Record<string, string>,
  models: string[],
  metadata: Record<string, FetchedModelMetadata>
): Promise<void> {
  const missing = (): string[] => models.filter((name) => !(name in metadata));
  if (missing().length === 0) return;
  const root = ollamaRoot(connection.baseUrl);
  for (const name of missing()) {
    try {
      const response = await fetch(`${root}/api/show`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) continue;
      const context = contextFromShow(await response.json());
      if (context !== undefined) {
        metadata[name] = { contextWindow: context, capacitySource: OLLAMA_CAPACITY_SOURCE };
      }
    } catch {
      // 静默：某个模型的 show 失败不影响其它模型/列表。
    }
  }
  if (missing().length === 0) return;
  try {
    const response = await fetch(`${root}/api/ps`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { models?: unknown };
    if (!Array.isArray(payload.models)) return;
    const byName = new Map<string, number>();
    for (const row of payload.models) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const item = row as { name?: unknown; model?: unknown; context_length?: unknown };
      const context = validContextWindow(item.context_length);
      if (context === undefined) continue;
      for (const key of [item.name, item.model]) {
        if (typeof key === 'string' && key.trim()) byName.set(key.trim(), context);
      }
    }
    for (const name of missing()) {
      const context = byName.get(name);
      if (context !== undefined) {
        metadata[name] = { contextWindow: context, capacitySource: OLLAMA_CAPACITY_SOURCE };
      }
    }
  } catch {
    // 静默：ps 不可用就保持"平台未提供容量"。
  }
}

export interface FetchedModelMetadata {
  /** 平台元数据里合法的上下文窗口（整数 8192–4000000）；没有命中时整个条目不会出现。 */
  contextWindow?: number;
  /** 来源说明（当前固定为“平台 /models 元数据”，显示在容量设置区）。 */
  capacitySource?: string;
  /** 官方登记的用途（语音模型快照用；平台不列 ASR/TTS 时据此补能力）。 */
  capabilities?: string[];
  /** 官方来源说明（含快照日期）。 */
  source?: string;
  metadataUrl?: string;
}

export interface FetchedModelsDetailed {
  models: string[];
  /** 只包含**确实带**合法容量字段的模型；其它模型没有条目。 */
  metadata: Record<string, FetchedModelMetadata>;
  /**
   * 实时列表失败时的中文说明：
   * 有值时 `models/metadata` 是“已保存模型 + 官方语音快照”，不是本次平台返回。
   */
  notice?: string;
}

/** 官方语音模型快照合并：平台 /models 往往只列对话模型（MiniMax/MiMo ASR/TTS 不在列表）。 */
function mergeSpeechPresets(
  connection: ModelServiceConnection,
  models: string[],
  metadata: Record<string, FetchedModelMetadata>
): void {
  for (const preset of speechModels(connection.baseUrl)) {
    if (!models.includes(preset.id)) models.push(preset.id);
    const current = metadata[preset.id];
    metadata[preset.id] = {
      ...(current ?? {}),
      ...(current?.capacitySource ? { capacitySource: current.capacitySource } : {}),
      capabilities: [...preset.capabilities],
      source: preset.source,
      metadataUrl: preset.metadata_url
    };
  }
}

/**
 * 把 `/models` 失败时的回退列表（已保存模型 + 官方语音快照）写回该 connection。
 *
 * 落库方式：`data['models']=models_of(data)` 后
 * UPDATE platform_connections，让下次打开或其它调用也能看到这些模型。
 *
 * 只追加缺失项：已有条目（尤其用户标注/source 元数据）原样保留；走与
 * `saveModelServices` 相同的设置键持久化，不触发路由/密钥副作用。
 */
function persistFallbackModels(
  store: Store,
  connectionId: string,
  models: string[],
  metadata: Record<string, FetchedModelMetadata>
): void {
  const config = readModelServices(store);
  const connection = config.connections.find((item) => item.id === connectionId);
  if (!connection) return;
  const names = new Set(
    connection.models.map((model) => String(model.name || model.id || '').trim())
  );
  const additions: ModelServiceConnection['models'] = [];
  for (const name of models) {
    if (!name || names.has(name)) continue;
    const meta = metadata[name];
    additions.push({
      id: name,
      name,
      capabilities:
        meta?.capabilities && meta.capabilities.length > 0
          ? [...meta.capabilities]
          : ['chat'],
      // 官方文档登记的语言/语音模型标 preset；其它回退项标 fetched，都不是用户标注。
      source: meta?.source && meta.source.includes('官方') ? 'preset' : 'fetched',
      // 未安装/未选择前不启用：回退列表只是“可添加”，不应改变现有用途路由。
      enabled: false,
      ...(meta?.contextWindow !== undefined
        ? {
            context_window: meta.contextWindow,
            capacity_mode: 'auto' as const,
            capacity_source: meta.capacitySource
          }
        : {}),
      ...(meta?.metadataUrl ? { metadata_url: meta.metadataUrl } : {})
    });
    names.add(name);
  }
  if (additions.length === 0) return;
  const connections = config.connections.map((item) =>
    item.id === connectionId ? { ...item, models: [...item.models, ...additions] } : item
  );
  store.updateSettings({ [SERVICES_KEY]: JSON.stringify(connections) });
}

/** 官方登记容量/能力：平台 /models 与已保存设置都没给时，用官方文档快照补齐。 */
function applyOfficialMetadata(
  connection: ModelServiceConnection,
  models: string[],
  metadata: Record<string, FetchedModelMetadata>
): void {
  for (const name of models) {
    const official = officialModelMetadata(connection.baseUrl, name);
    if (!official) continue;
    const entry = metadata[name] ?? {};
    if (entry.contextWindow === undefined && official.contextWindow !== undefined) {
      entry.contextWindow = official.contextWindow;
      entry.capacitySource = official.source;
    }
    if (!entry.capabilities?.length && official.capabilities?.length) {
      entry.capabilities = [...official.capabilities];
      entry.source = '官方文档';
    }
    if (!entry.metadataUrl && official.metadataUrl) entry.metadataUrl = official.metadataUrl;
    if (Object.keys(entry).length > 0) metadata[name] = entry;
  }
}

/** 已保存模型 + 官方语音快照（`/models` 失败时的回退，并写回连接）。 */
function savedModelsFallback(
  store: Store,
  connection: ModelServiceConnection
): FetchedModelsDetailed {
  const models: string[] = [];
  const metadata: Record<string, FetchedModelMetadata> = {};
  for (const model of connection.models ?? []) {
    const name = String(model.name || model.id || '').trim();
    if (!name || models.includes(name)) continue;
    models.push(name);
    const entry: FetchedModelMetadata = {};
    if (typeof model.context_window === 'number') {
      entry.contextWindow = model.context_window;
      entry.capacitySource = model.capacity_source ?? '已保存设置';
    }
    if (model.capabilities?.length) entry.capabilities = [...model.capabilities];
    if (model.source) entry.source = model.source;
    if (model.metadata_url) entry.metadataUrl = model.metadata_url;
    if (Object.keys(entry).length > 0) metadata[name] = entry;
  }
  mergeSpeechPresets(connection, models, metadata);
  applyOfficialMetadata(connection, models, metadata);
  // 失败回退时把合并后的列表写回平台连接（保留已有用户标注）。
  persistFallbackModels(store, connection.id, models, metadata);
  return { models, metadata };
}

/** 失败原因转成给用户看的中文（不夹带英文堆栈）。 */
function fallbackNotice(reason: string): string {
  const detail = reason.replace(/\s+/g, ' ').trim().slice(0, 200) || '未知原因';
  return (
    `实时模型列表没有取到（${detail}）；当前显示的是已保存的模型与官方文档登记的语音模型，` +
    '可手动添加其它模型。'
  );
}

/** 从一行 `/models` 记录里取合法容量；多个字段同时出现时按上面的顺序取第一个合法值。 */
function fetchedContextWindow(row: Record<string, unknown>): number | undefined {
  for (const field of FETCHED_CAPACITY_FIELDS) {
    const value = row[field];
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= MIN_MODEL_CONTEXT_WINDOW &&
      value <= MAX_MODEL_CONTEXT_WINDOW
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * 拉取平台模型列表 + 容量元数据。
 *
 * 平台命名不一，容量字段接受 `context_length` / `context_window` / `max_context_length` /
 * `max_model_len`，只认**整数且 8192–4000000**；不合法就当没给（不写元数据）。
 * 解析失败不影响模型列表本身：`metadata` 里没有该条目，UI 就显示“平台未提供容量”。
 */
export async function fetchConnectionModelsDetailed(
  store: Store,
  secrets: SecretStore,
  connectionId: string
): Promise<FetchedModelsDetailed> {
  const config = readModelServices(store);
  const connection = config.connections.find((item) => item.id === connectionId);
  if (!connection) throw new Error('平台连接不存在');
  const key = secrets.get(`platform.${connection.id}.api_key`)?.trim() || '';
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...savedModelsFallback(store, connection),
      notice: fallbackNotice(`请求失败：${message}`)
    };
  }
  if (!response.ok) {
    // 平台没有 /models 或本次失败时，不丢一个失败提示，
    // 而是继续展示已保存模型与官方登记的语音模型，并如实说明“实时列表没拿到”。
    return {
      ...savedModelsFallback(store, connection),
      notice: fallbackNotice(`平台返回 HTTP ${response.status}`)
    };
  }
  let payload: { data?: unknown; models?: unknown };
  try {
    payload = (await response.json()) as {
      data?: unknown;
      models?: unknown;
    };
  } catch {
    return {
      ...savedModelsFallback(store, connection),
      notice: fallbackNotice('平台返回内容不是有效 JSON')
    };
  }
  const rows = [
    ...(Array.isArray(payload.data) ? payload.data : []),
    ...(Array.isArray(payload.models) ? payload.models : [])
  ].filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === 'object' && !Array.isArray(row)
  );
  const models: string[] = [];
  const metadata: Record<string, FetchedModelMetadata> = {};
  for (const row of rows) {
    const rawName =
      typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '';
    const name = rawName.trim();
    if (!name || name.length > 300) continue;
    const contextWindow = fetchedContextWindow(row);
    const capabilities = classifyPlatformCapabilities(row);
    if (!(name in metadata) && (contextWindow !== undefined || capabilities)) {
      metadata[name] = {
        ...(contextWindow !== undefined
          ? { contextWindow, capacitySource: FETCHED_CAPACITY_SOURCE }
          : {}),
        ...(capabilities ? { capabilities, source: '平台元数据' } : {})
      };
    }
    if (!models.includes(name)) models.push(name);
  }
  // 官方语音模型快照：平台列表里没有、但官方文档登记过的语音模型补进来。
  mergeSpeechPresets(connection, models, metadata);
  applyOfficialMetadata(connection, models, metadata);
  if (isOllamaConnection(connection)) {
    // Ollama 的 /models 通常不带容量：用本机 /api/show、/api/ps 补齐（失败静默）。
    await completeOllamaCapacity(
      connection,
      key ? { authorization: `Bearer ${key}` } : {},
      models,
      metadata
    );
  }
  return { models, metadata };
}

/** 旧接口：只要模型名数组（既有调用/接口兼容；行为与改动前一致）。 */
export async function fetchConnectionModels(
  store: Store,
  secrets: SecretStore,
  connectionId: string
): Promise<string[]> {
  return (await fetchConnectionModelsDetailed(store, secrets, connectionId)).models;
}

/**
 * 把 `/models` 拉到的容量元数据写回模型清单（只填“自动”来源）。
 *
 * - 只有 metadata 里带合法 `contextWindow` 的模型才写 `context_window` /
 *   `capacity_mode='auto'` / `capacity_source`；
 * - **用户手动设置过容量（`capacity_mode='manual'`）的模型绝不覆盖**；
 * - 没命中元数据的模型原样保留。
 *
 * 说明：渲染进程（app 包）不能 import core（Node 侧），`ModelServicesPanel` 里有一份
 * 同口径的本地实现供 UI 使用；两处逻辑保持一致，改这里时也要同步改 UI 那份。
 */
export function applyFetchedCapacity<T extends {
  id: string;
  name: string;
  context_window?: number;
  capacity_mode?: 'auto' | 'manual';
  capacity_source?: string;
  metadata_url?: string;
}>(
  models: T[],
  metadata: Record<string, FetchedModelMetadata>
): T[] {
  return models.map((model) => {
    const fetched = metadata[model.name] ?? metadata[model.id];
    if (!fetched) return model;
    const next = { ...model };
    if (fetched.contextWindow && model.capacity_mode !== 'manual') {
      next.context_window = fetched.contextWindow;
      next.capacity_mode = 'auto' as const;
      next.capacity_source = fetched.capacitySource;
    }
    if (fetched.metadataUrl) next.metadata_url = fetched.metadataUrl;
    return next;
  });
}

/**
 * 把 `/models` 拉到的容量元数据回写到**已保存**的平台连接里（只填自动来源）。
 *
 * - 只更新该 connectionId 下已保存的 model 条目；未知连接/未知模型不改；
 * - `capacity_mode === 'manual'` 的手动容量绝不覆盖；无元数据不改；
 * - 与 `applyFetchedCapacity` 同口径，但这里负责**持久化**并返回实际更新数量；
 * - 幂等：第二次拉取（值相同）返回 updated=0，不重复写库。
 *
 * `fetchConnectionModelsDetailed` 保持只读（拉列表本身没有隐藏副作用）；
 * 回写只发生在显式返回 metadata 的接口路径上。
 */
export function applyFetchedCapacityToConnection(
  store: Store,
  connectionId: string,
  metadata: Record<string, FetchedModelMetadata>
): { updated: number } {
  const config = readModelServices(store);
  const connection = config.connections.find((item) => item.id === connectionId);
  if (!connection) return { updated: 0 };
  let updated = 0;
  const models = connection.models.map((model) => {
    const fetched = metadata[model.name] ?? metadata[model.id];
    const wantsCapacity =
      fetched?.contextWindow !== undefined && model.capacity_mode !== 'manual';
    const wantsUrl =
      Boolean(fetched?.metadataUrl) && model.metadata_url !== fetched?.metadataUrl;
    if (!wantsCapacity && !wantsUrl) return model;
    const unchanged =
      (!wantsCapacity ||
        (model.context_window === fetched?.contextWindow &&
          model.capacity_mode === 'auto' &&
          model.capacity_source === fetched?.capacitySource)) &&
      (!wantsUrl || model.metadata_url === fetched?.metadataUrl);
    if (unchanged) return model;
    updated += 1;
    return {
      ...model,
      ...(wantsCapacity
        ? {
            context_window: fetched!.contextWindow,
            capacity_mode: 'auto' as const,
            capacity_source: fetched!.capacitySource
          }
        : {}),
      ...(wantsUrl ? { metadata_url: fetched!.metadataUrl } : {})
    };
  });
  if (updated === 0) return { updated: 0 };
  saveModelServices(store, {
    connections: config.connections.map((item) =>
      item.id === connectionId ? { ...item, models } : item
    )
  });
  return { updated };
}
