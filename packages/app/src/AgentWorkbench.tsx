import React, { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '@studianda/api-client';
import {
  defaultAgentScope,
  type AgentScope,
  type DocumentSummary,
  type ProjectSummary
} from '@studianda/shared';
import type { RuntimeAdapter } from './runtime.js';

type Target = 'none' | 'document' | 'project' | 'library';

const TTL_MS = 2 * 60 * 60 * 1000;

function expiry(): string {
  return new Date(Date.now() + TTL_MS).toISOString();
}

function describe(scope: AgentScope, documents: DocumentSummary[], projects: ProjectSummary[]): string {
  if (scope.kind === 'none') return '未共享（agent 只能看标题）';
  if (scope.kind === 'library') return '全库只读';
  if (scope.projectId) {
    const project = projects.find((item) => item.id === scope.projectId);
    return `项目「${project?.name ?? scope.projectId}」· ${scope.documentIds.length} 篇`;
  }
  const names = scope.documentIds
    .map((id) => documents.find((item) => item.id === id)?.name ?? id)
    .slice(0, 3);
  return `文献：${names.join('、')}${scope.documentIds.length > 3 ? ' 等' : ''}`;
}

/**
 * Agent 工作台（P0）：只负责"共享范围"与交接说明。
 * 不画聊天框——聊天在 DSH；这里只写 scope，让外部 agent 通过 MCP 读到。
 */
export function AgentWorkbench({
  api,
  adapter,
  documents,
  currentDocumentId,
  currentPage
}: {
  api: ApiClient;
  adapter: RuntimeAdapter;
  documents: DocumentSummary[];
  currentDocumentId?: string;
  currentPage?: number;
}): React.JSX.Element {
  const [scope, setScope] = useState<AgentScope>(() => defaultAgentScope());
  const [dataDir, setDataDir] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [target, setTarget] = useState<Target>('none');
  const [documentId, setDocumentId] = useState(currentDocumentId ?? '');
  const [projectId, setProjectId] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [current, list] = await Promise.all([api.getAgentScope(), api.listProjects()]);
        if (disposed) return;
        setScope(current);
        setProjects(list);
        if (current.kind === 'library') setTarget('library');
        else if (current.kind === 'documents') {
          setTarget(current.projectId ? 'project' : 'document');
          setDocumentId(current.documentIds[0] ?? currentDocumentId ?? '');
          setProjectId(current.projectId ?? '');
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [api, currentDocumentId]);

  useEffect(() => {
    let disposed = false;
    if (!adapter.getDataLocation) return undefined;
    void adapter
      .getDataLocation()
      .then((value) => {
        if (!disposed) setDataDir(value);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [adapter]);

  useEffect(() => {
    if (!documentId && currentDocumentId) setDocumentId(currentDocumentId);
  }, [currentDocumentId, documentId]);

  const briefText = useMemo(() => {
    const targetText =
      target === 'none'
        ? '未共享（只允许列标题）'
        : target === 'library'
          ? '全库只读（2 小时）'
          : target === 'project'
            ? `项目「${projects.find((item) => item.id === projectId)?.name ?? projectId}」`
            : `文献《${documents.find((item) => item.id === documentId)?.name ?? documentId}》`;
    return [
      `【任务】${target === 'none' ? '先确认共享范围' : '请基于共享范围完成：<在这里写任务>'}`,
      `【范围】${targetText}；scope 由勘读的 Agent 工作台写入，范围不够先请求，不要猜。`,
      `【已知】当前页 ${currentPage ?? '未打开文献'}；引用必须带文献 id 与页码。`,
      `【边界】只读；不改批注、不导出、不写文件；没有的结论写"材料未覆盖"。`
    ].join('\n');
  }, [target, projectId, documentId, documents, projects, currentPage]);

  useEffect(() => {
    setBrief(briefText);
  }, [briefText]);

  const dshConfig = useMemo(() => {
    const install = '<安装目录，例如 C:\\Users\\你\\AppData\\Local\\Programs\\Studianda>';
    const data = dataDir || '<资料目录>';
    return [
      '- id: mcp-studianda',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: studianda',
      '    transport: stdio',
      `    command: '${install}\\Studianda.exe'`,
      '    args:',
      `      - '${install}\\resources\\agent-bridge.mjs'`,
      "      - '--data-dir'",
      `      - '${data}'`,
      '    env:',
      "      ELECTRON_RUN_AS_NODE: '1'",
      `      STUDIANDA_DATA_DIR: '${data}'`,
      '    failOnStartupError: true',
      '    toolCallTimeoutMs: 120000'
    ].join('\n');
  }, [dataDir]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (target === 'none') {
        setScope(await api.clearAgentScope());
        setNotice('已撤销共享。');
        return;
      }
      let next: AgentScope;
      if (target === 'library') {
        next = { ...defaultAgentScope(), kind: 'library', caps: ['read'], expiresAt: expiry() };
      } else if (target === 'project') {
        if (!projectId) throw new Error('先选择项目');
        const rows = await api.listProjectDocuments(projectId);
        if (rows.length === 0) throw new Error('这个项目还没有文献');
        next = {
          ...defaultAgentScope(),
          kind: 'documents',
          projectId,
          documentIds: rows.map((row) => row.id),
          caps: ['read'],
          expiresAt: expiry()
        };
      } else {
        if (!documentId) throw new Error('先选择文献');
        next = {
          ...defaultAgentScope(),
          kind: 'documents',
          documentIds: [documentId],
          page: currentPage ?? null,
          caps: ['read'],
          expiresAt: expiry()
        };
      }
      setScope(await api.setAgentScope(next));
      setNotice('共享范围已更新；外部 agent 下一次工具调用即可读到。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyBrief = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(brief);
      setNotice('任务说明已复制，粘贴给 DSH 即可。');
    } catch {
      setNotice('复制失败：请手动选中任务说明复制。');
    }
  };

  const copyConfig = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(dshConfig);
      setNotice('DSH 配置已复制；粘到 profile 的 cordis.patch.yml 后重启 DSH。');
    } catch {
      setNotice('复制失败：请展开配置手动复制。');
    }
  };

  return (
    <section className="kr-agent" aria-label="Agent 工作台">
      <header className="kr-agent__head">
        <div>
          <h1>Agent 工作台</h1>
          <p className="kr-muted">
            外部 agent（DSH / Claude Code / Codex）通过 MCP 读取这里共享的范围。这里不画聊天框——对话在 agent 那边。
          </p>
        </div>
        <div className={`kr-agent__scope${scope.kind === 'none' ? ' is-none' : ''}`}>
          <span className="kr-agent__scope-label">当前范围</span>
          <strong>{describe(scope, documents, projects)}</strong>
          {scope.expiresAt ? (
            <span className="kr-muted">
              到期 {new Date(scope.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null}
        </div>
      </header>

      <div className="kr-agent__grid">
        <div className="kr-agent__card">
          <h2>共享给 agent</h2>
          <div className="kr-agent__options" role="radiogroup" aria-label="共享范围">
            {(
              [
                ['none', '不共享', 'agent 只能列标题'],
                ['document', '当前文献', '可读这篇的正文'],
                ['project', '项目', '项目内全部文献'],
                ['library', '全库', '整个文献库只读']
              ] as Array<[Target, string, string]>
            ).map(([value, label, hint]) => (
              <label key={value} className={`kr-agent__option${target === value ? ' is-active' : ''}`}>
                <input
                  type="radio"
                  name="agent-target"
                  value={value}
                  checked={target === value}
                  onChange={() => setTarget(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>

          {target === 'document' ? (
            <label className="kr-agent__field">
              文献
              <select value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
                <option value="">选择文献…</option>
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {target === 'project' ? (
            <label className="kr-agent__field">
              项目
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">选择项目…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}（{project.documentCount} 篇）
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <p className="kr-muted">
            只授予只读；2 小时后自动失效；随时可撤销。写入能力（笔记/批注/整理）在 P1，尚未开放。
          </p>
          {error ? (
            <p className="kr-page-error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="kr-agent__notice" role="status">
              {notice}
            </p>
          ) : null}
          <div className="kr-agent__actions">
            <button type="button" className="kr-primary" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : target === 'none' ? '撤销共享' : '保存共享范围'}
            </button>
            <button type="button" className="kr-ghost" disabled={busy} onClick={() => void copyBrief()}>
              复制任务说明
            </button>
          </div>
        </div>

        <div className="kr-agent__card">
          <h2>交给 agent 的任务说明</h2>
          <p className="kr-muted">
            这段文字可以直接粘进 DSH。范围以勘读写入的 scope 为准——即使文字被改乱，agent 调 scope 仍能拿到正确范围。
          </p>
          <textarea
            className="kr-agent__brief"
            value={brief}
            rows={12}
            onChange={(event) => setBrief(event.target.value)}
          />
          <div className="kr-agent__hint">
            接入方式：设置 → 外部 Agent（下一步）。当前 P0 可用环境变量
            <code> STUDIANDA_AGENT_SCOPE </code>临时验证。
          </div>
          <div className="kr-agent__actions">
            <button type="button" className="kr-ghost" onClick={() => void copyConfig()}>
              复制 DSH 接入配置
            </button>
          </div>
          <details className="kr-agent__config-details">
            <summary>查看 YAML（安装目录与资料目录需替换）</summary>
            <pre className="kr-agent__config">{dshConfig}</pre>
          </details>
        </div>
      </div>
    </section>
  );
}
