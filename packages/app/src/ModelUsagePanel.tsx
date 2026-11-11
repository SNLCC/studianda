import type { ApiClient } from '@studianda/api-client';
import type { ModelServiceKind } from '@studianda/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type JSX } from 'react';
import { HintMark, SendingNotice } from './Hint.js';
import { useSettingsFeedback } from './SettingsFeedback.js';

const LABELS: Record<ModelServiceKind, string> = {
  chat: '会话模型',
  embedding: 'Embedding',
  rerank: 'Rerank',
  translation: '翻译',
  asr: '语音识别',
  tts: '语音生成',
  vision: '视觉读页',
  omni: '全模态'
};

/**
 * 与 core 的 `modelSupports` 同口径：`omni`（全模态）蕴含 chat/vision；
 * 其余能力必须显式标注——名称像视觉模型不等于真能读图。
 */
function modelSupportsKind(
  kind: ModelServiceKind,
  model: { capabilities: string[] }
): boolean {
  // 翻译没有专用模型能力：直接使用会话模型（兼容旧数据里标注过 translation 的模型）。
  if (kind === 'translation') {
    return (
      model.capabilities.includes('chat') ||
      model.capabilities.includes('omni') ||
      model.capabilities.includes('translation')
    );
  }
  if (model.capabilities.includes(kind)) return true;
  if (!model.capabilities.includes('omni')) return false;
  // 全模态包含会话/视觉/语音识别（音频输入）；语音合成仍是独立能力。
  return kind === 'chat' || kind === 'vision' || kind === 'asr';
}

export function ModelUsagePanel({
  api,
  kind,
  description,
  inlineDescription,
  hint,
  notice
}: {
  api: ApiClient;
  kind: ModelServiceKind;
  /** 旧的分区说明；新代码优先用 inlineDescription / hint。 */
  description?: string;
  /** 跟在标题后面的简短说明（同一行）。 */
  inlineDescription?: string;
  /** 标题后问号里的详细说明。 */
  hint?: string;
  /** 触发外部服务时的提示。 */
  notice?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useSettingsFeedback();
  const servicesQuery = useQuery({
    queryKey: ['model-services'],
    queryFn: () => api.getModelServices()
  });
  const mutation = useMutation({
    mutationFn: (input: { connectionId: string; model: string }) =>
      api.updateModelServices({
        connections: servicesQuery.data?.connections ?? [],
        routing: {
          ...(servicesQuery.data?.routing ?? {}),
          [kind]: input.connectionId
            ? { connectionId: input.connectionId, model: input.model }
            : undefined
        }
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['model-services'] });
      void queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
      notify(`${LABELS[kind]}用途已保存。`);
    },
    onError: (error: Error) =>
      notify(`${LABELS[kind]}用途保存失败：${error.message}`, 'error')
  });
  const assignment = servicesQuery.data?.routing[kind];
  const connections = servicesQuery.data?.connections ?? [];
  const selected = connections.find((item) => item.id === assignment?.connectionId);
  const models = (selected?.models ?? []).filter((model) =>
    modelSupportsKind(kind, model)
  );
  const selectedModel = models.find((model) => model.name === assignment?.model);

  return (
    <section className="kr-settings__section">
      <div className="kr-settings__section-head">
        <h2>{LABELS[kind]}</h2>
        {inlineDescription ? (
          <span className="kr-settings__section-note">{inlineDescription}</span>
        ) : null}
        {hint ? <HintMark text={hint} /> : null}
      </div>
      {description ? <p className="kr-muted">{description}</p> : null}
      {notice ? <SendingNotice text={notice} /> : null}
      <label>
        <span>平台</span>
        <select
          value={assignment?.connectionId ?? ''}
          onChange={(event) => {
            const connection = connections.find((item) => item.id === event.target.value);
            mutation.mutate({
              connectionId: event.target.value,
              model:
                connection?.models.find((model) => modelSupportsKind(kind, model))?.name ??
                ''
            });
          }}
        >
          <option value="">不启用外部服务</option>
          {connections
            .filter((connection) =>
              connection.models.some((model) => modelSupportsKind(kind, model))
            )
            .map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span>模型</span>
        <select
          value={assignment?.model ?? ''}
          onChange={(event) =>
            mutation.mutate({
              connectionId: assignment?.connectionId ?? '',
              model: event.target.value
            })
          }
        >
          <option value="">选择模型</option>
          {models.map((model) => (
            <option key={model.id} value={model.name}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      {servicesQuery.data && connections.length === 0 ? (
        <p className="kr-muted">还没有平台，请先到「模型服务」添加平台并获取模型。</p>
      ) : null}
      {selectedModel?.capabilities.includes('omni') ? (
        <p className="kr-muted">
          全模态模型：同一模型同时承担会话、视觉读页与音频；视觉读页与音频会优先使用它。
        </p>
      ) : null}
      <div className="kr-settings__actions">
        <button
          type="button"
          onClick={() =>
            mutation.mutate({
              connectionId: assignment?.connectionId ?? '',
              model: assignment?.model ?? ''
            })
          }
          disabled={mutation.isPending}
        >
          {mutation.isPending ? '保存中…' : '保存设置'}
        </button>
      </div>
      {mutation.isPending ? <p className="kr-muted">保存中…</p> : null}
    </section>
  );
}
