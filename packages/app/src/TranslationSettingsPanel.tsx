import type { ApiClient } from '@studianda/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { HintMark, SendingNotice } from './Hint.js';
import { useSettingsFeedback } from './SettingsFeedback.js';

/** 与 core 的 `modelSupports` 同口径：翻译没有专用模型能力，用会话模型即可。 */
function supportsTranslation(model: { capabilities: string[] }): boolean {
  return (
    model.capabilities.includes('chat') ||
    model.capabilities.includes('omni') ||
    model.capabilities.includes('translation')
  );
}

export function TranslationSettingsPanel({ api }: { api: ApiClient }): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useSettingsFeedback();
  const servicesQuery = useQuery({
    queryKey: ['model-services'],
    queryFn: () => api.getModelServices()
  });
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [probe, setProbe] = useState<{
    ok: boolean;
    text?: string;
    reason?: string;
  } | null>(null);

  // 翻译服务只有一个来源：「模型服务 · 翻译」路由，没有独立的地址/密钥配置。
  useEffect(() => {
    if (!servicesQuery.data) return;
    const assignment = servicesQuery.data.routing.translation;
    if (assignment) {
      setConnectionId(assignment.connectionId);
      setModel(assignment.model);
    }
  }, [servicesQuery.data]);

  const connections = (servicesQuery.data?.connections ?? []).filter((item) =>
    item.models.some((candidate) => supportsTranslation(candidate))
  );
  const selectedConnection = connections.find((item) => item.id === connectionId);
  const models = (selectedConnection?.models ?? []).filter((candidate) =>
    supportsTranslation(candidate)
  );

  const save = useMutation({
    mutationFn: () =>
      api.updateModelServices({
        connections: servicesQuery.data?.connections ?? [],
        routing: {
          ...(servicesQuery.data?.routing ?? {}),
          translation: connectionId ? { connectionId, model } : undefined
        }
      }),
    onSuccess: () => {
      notify('翻译服务设置已保存（目标语言不受影响）。');
      void queryClient.invalidateQueries({ queryKey: ['model-services'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-config'] });
    },
    onError: (error: Error) =>
      notify(`翻译服务设置保存失败：${error.message}`, 'error')
  });

  // 试译一句：只发示例文本、不发送文献内容；无配置时后端返回 ok=false（不是 500）。
  const probeMutation = useMutation({
    mutationFn: () => api.probeTranslation(),
    onSuccess: (result) =>
      setProbe({ ok: result.ok, text: result.text, reason: result.reason }),
    onError: (error: Error) => setProbe({ ok: false, reason: error.message })
  });

  return (
    <section className="kr-settings__section">
      <div className="kr-settings__section-head">
        <h2>翻译</h2>
        <HintMark text="译文随文献一起删除。" />
      </div>
      <p className="kr-muted">
        翻译服务来自「模型服务」里给「翻译」用途选择的路由；目标语言在阅读器右侧的「翻译」面板里选择。
        没有专用翻译模型类型：选择哪个平台就使用该平台上的模型，通常直接复用会话模型。
      </p>
      <SendingNotice text="翻译时，待翻译的原文会发送到所选服务。试译只发送一句示例文本，不发送文献内容。" />
      {connections.length === 0 ? (
        <p className="kr-muted">还没有可用平台，请先到「模型服务」添加平台并获取模型。</p>
      ) : null}
      <label>
        <span>使用哪个平台</span>
        <select
          value={connectionId}
          onChange={(event) => {
            setConnectionId(event.target.value);
            const connection = connections.find((item) => item.id === event.target.value);
            setModel(
              connection?.models.find((candidate) => supportsTranslation(candidate))?.name ?? ''
            );
          }}
        >
          <option value="">不使用外部翻译服务</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>模型</span>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="">选择模型</option>
          {models.map((candidate) => (
            <option key={candidate.id} value={candidate.name}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <div className="kr-settings__actions">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存翻译设置'}
        </button>
        <button
          type="button"
          onClick={() => probeMutation.mutate()}
          disabled={probeMutation.isPending}
          title="用一句示例文本验证当前翻译配置；不会发送任何文献内容"
        >
          {probeMutation.isPending ? '试译中…' : '试译一句'}
        </button>
      </div>
      {probe ? (
        probe.ok ? (
          <p className="kr-settings__message">试译结果：{probe.text}</p>
        ) : (
          <p className="kr-page-error">试译失败：{probe.reason ?? '未知原因'}</p>
        )
      ) : null}
    </section>
  );
}
