import React, { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '@studianda/api-client';
import {
  defaultAgentScope,
  type AgentOperationRecord,
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
  const [bridge, setBridge] = useState<{
    command: string;
    script: string;
    packaged: boolean;
  } | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [target, setTarget] = useState<Target>('none');
  const [allowWrite, setAllowWrite] = useState(false);
  const [documentId, setDocumentId] = useState(currentDocumentId ?? '');
  const [projectId, setProjectId] = useState('');
  const [brief, setBrief] = useState('');
  const [operations, setOperations] = useState<AgentOperationRecord[]>([]);
  const [undoing, setUndoing] = useState('');
  const [busy, setBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [pluginDir, setPluginDir] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [current, list] = await Promise.all([api.getAgentScope(), api.listProjects()]);
        if (disposed) return;
        setScope(current);
        setAllowWrite(current.caps.includes('write'));
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
    void refreshOperations();
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
    let disposed = false;
    if (!adapter.getAgentBridge) return undefined;
    void adapter
      .getAgentBridge()
      .then((value) => {
        if (disposed) return;
        setBridge(value);
        if (value) setDataDir(value.dataDir);
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
      allowWrite
        ? '【边界】可写：只限标签/题录/文件夹，先 preview 再 apply；每次 apply 返回 operationId，可撤销。不写正文/批注/文件。'
        : '【边界】只读；不改批注、不导出、不写文件；没有的结论写"材料未覆盖"。'
    ].join('\n');
  }, [target, projectId, documentId, documents, projects, currentPage, allowWrite]);

  useEffect(() => {
    setBrief(briefText);
  }, [briefText]);

  const dshConfig = useMemo(() => {
    const command = bridge?.command ?? '<安装目录>\\Studianda.exe';
    const script = bridge?.script ?? '<安装目录>\\resources\\agent-bridge.mjs';
    const data = dataDir || '<资料目录>';
    return [
      '- id: mcp-studianda',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: studianda',
      '    transport: stdio',
      `    command: '${command}'`,
      '    args:',
      `      - '${script}'`,
      "      - '--data-dir'",
      `      - '${data}'`,
      '    env:',
      "      ELECTRON_RUN_AS_NODE: '1'",
      `      STUDIANDA_DATA_DIR: '${data}'`,
      '    failOnStartupError: true',
      '    toolCallTimeoutMs: 120000'
    ].join('\n');
  }, [bridge, dataDir]);

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
      const caps = allowWrite ? ['read', 'write'] : ['read'];
      if (target === 'library') {
        next = { ...defaultAgentScope(), kind: 'library', caps, expiresAt: expiry() };
      } else if (target === 'project') {
        if (!projectId) throw new Error('先选择项目');
        const rows = await api.listProjectDocuments(projectId);
        if (rows.length === 0) throw new Error('这个项目还没有文献');
        next = {
          ...defaultAgentScope(),
          kind: 'documents',
          projectId,
          documentIds: rows.map((row) => row.id),
          caps,
          expiresAt: expiry()
        };
      } else {
        if (!documentId) throw new Error('先选择文献');
        next = {
          ...defaultAgentScope(),
          kind: 'documents',
          documentIds: [documentId],
          page: currentPage ?? null,
          caps,
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
      setNotice('YAML 已复制（备用方式）；推荐直接用「在 DSH 中安装」。');
    } catch {
      setNotice('复制失败：请展开配置手动复制。');
    }
  };

  const installInDsh = async (): Promise<void> => {
    setInstallBusy(true);
    setError('');
    setNotice('');
    try {
      if (!adapter.prepareAgentBridge) {
        setNotice('当前宿主不支持自动生成插件目录；请用下方 YAML 备用方式。');
        return;
      }
      const result = await adapter.prepareAgentBridge();
      if (result.ok) {
        setPluginDir(result.directory ?? '');
        setNotice(result.message);
      } else {
        setError(result.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstallBusy(false);
    }
  };

  const copyPluginDir = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(pluginDir);
      setNotice('插件目录路径已复制。');
    } catch {
      setNotice(`请手动复制目录：${pluginDir}`);
    }
  };

  async function refreshOperations(): Promise<void> {
    try {
      setOperations(await api.listAgentOperations(10));
    } catch {
      // 操作历史读取失败不阻断共享/安装主流程。
    }
  }

  const undoOperation = async (operation: AgentOperationRecord): Promise<void> => {
    setUndoing(operation.id);
    setError('');
    try {
      const result = await api.undoAgentChanges(operation.id);
      setNotice(`已撤销 ${result.restored} 篇文献的变更。`);
      await refreshOperations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUndoing('');
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

          <label className={`kr-agent__option${allowWrite ? ' is-active' : ''}`}>
            <input
              type="checkbox"
              checked={allowWrite}
              onChange={(event) => setAllowWrite(event.target.checked)}
            />
            <span>
              <strong>允许整理</strong>
              <small>标签 / 题录 / 文件夹；每次写入都可在 DSH 里撤销</small>
            </span>
          </label>

          <p className="kr-muted">
            只授予只读；2 小时后自动失效；随时可撤销。勾选「允许整理」后 agent 才能写标签/题录/文件夹，
            每次写入都有 before/after 记录，可撤销。
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
            点「在 DSH 中安装」会生成一个本地 DSH 插件目录并打开；在 DSH 的
            <strong> 插件 → 添加插件 </strong>
            里选择这个目录，启用「勘读文献库」，然后新开会话验证。不需要手写 YAML。
          </div>
          <div className="kr-agent__actions">
            <button
              type="button"
              className="kr-primary"
              disabled={installBusy}
              onClick={() => void installInDsh()}
            >
              {installBusy ? '生成中…' : '在 DSH 中安装…'}
            </button>
            {pluginDir ? (
              <button type="button" className="kr-ghost" onClick={() => void copyPluginDir()}>
                复制插件目录
              </button>
            ) : null}
          </div>
          {pluginDir ? (
            <p className="kr-agent__hint">
              插件目录：<code>{pluginDir}</code>
            </p>
          ) : null}
          <details className="kr-agent__config-details">
            <summary>高级：手动 YAML（不推荐，仅 CLI/无插件页时使用）</summary>
            <pre className="kr-agent__config">{dshConfig}</pre>
            <div className="kr-agent__actions">
              <button type="button" className="kr-ghost" onClick={() => void copyConfig()}>
                复制 YAML
              </button>
            </div>
          </details>
        </div>
      </div>

      <div className="kr-agent__card kr-agent__history">
        <div className="kr-agent__history-head">
          <h2>最近变更</h2>
          <button type="button" className="kr-link-button" onClick={() => void refreshOperations()}>
            刷新
          </button>
        </div>
        {operations.length === 0 ? (
          <p className="kr-muted">这个库里还没有 agent 写操作。允许整理后，agent 的每次 apply 都会记在这里。</p>
        ) : (
          <ul className="kr-agent__history-list">
            {operations.map((operation) => (
              <li key={operation.id}>
                <span className={`kr-agent__history-status is-${operation.status}`}>
                  {operation.status === 'applied' ? '已应用' : '已撤销'}
                </span>
                <strong>{operation.agentName || 'Agent'}</strong>
                <span>{changeLabel(operation.action)}</span>
                <span className="kr-muted">
                  {new Date(operation.created).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
                {operation.status === 'applied' ? (
                  <button
                    type="button"
                    className="kr-ghost"
                    disabled={undoing === operation.id}
                    onClick={() => void undoOperation(operation)}
                  >
                    {undoing === operation.id ? '撤销中…' : '撤销'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function changeLabel(action: string): string {
  if (action === 'tags') return '标签';
  if (action === 'metadata') return '题录';
  if (action === 'folder') return '文件夹';
  return action;
}
