/**
 * 「项目」最小可用界面：项目列表 + 项目详情（文献清单、从文献库加入、移出）。
 *
 * - 只消费 api-client 已封装的 7 个 `/projects` 方法，不直接拼 HTTP；
 * - 服务端中文错误（尤其重名「已存在同名项目：X」）原样上屏，不折叠成「操作失败」；
 * - 视觉全部复用 @studianda/ui 的 kr-* 类名（kr-library / kr-doc-list / kr-doc-row /
 *   kr-empty / kr-page-status / kr-page-error / kr-modal*），不新增 CSS 或图标库。
 *
 * 不做：项目级检索作用域、项目级集合、跨篇会话（下一轮）。
 */
import { appDialogs } from './dialogs.js';
import type { ApiClient } from '@studianda/api-client';
import type { DocumentSummary, ProjectDocumentRecord, ProjectSummary } from '@studianda/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

/** 服务端错误原样变成界面文案：中文错误（如重名）不能被吞成「操作失败」。 */
export function projectErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '操作失败';
}

/** 「最近更新时间」的本地短文案；空串/非法时间不抛错。 */
export function formatProjectTime(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

type ProjectDialogState = { mode: 'create' } | { mode: 'rename'; project: ProjectSummary };

/**
 * 新建/改名共用的小弹窗。重名等错误由容器通过 `error` 传入并**原样**渲染在
 * `.kr-modal__error` 里，方便用户直接看到服务端的中文提示。
 */
export function ProjectNameDialog({
  mode,
  originalName,
  value,
  error,
  pending,
  onChange,
  onSubmit,
  onClose
}: {
  mode: 'create' | 'rename';
  originalName?: string;
  value: string;
  error: string;
  pending: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
}): JSX.Element {
  return (
    <div className="kr-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="kr-modal kr-modal--folder"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? '新建项目' : '重命名项目'}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{mode === 'create' ? '新建项目' : '重命名项目'}</h2>
        {mode === 'rename' && originalName ? (
          <p className="kr-muted">原名称：{originalName}</p>
        ) : (
          <p className="kr-muted">把文献按课题或论文分组；项目只保存关联，不移动、不删除文献。</p>
        )}
        <label className="kr-modal__field">
          项目名称
          <input
            autoFocus
            maxLength={60}
            value={value}
            placeholder="例如：毕业论文、方法论、待读"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmit();
              }
              if (event.key === 'Escape') onClose();
            }}
          />
        </label>
        {error ? (
          <p className="kr-modal__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="kr-modal__actions">
          <button type="button" className="kr-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="kr-primary"
            onClick={onSubmit}
            disabled={pending || value.trim().length === 0}
          >
            {pending ? '保存中…' : mode === 'create' ? '新建' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 项目列表（纯展示，便于 SSR 冒烟覆盖列表/空态/错误态）。 */
export function ProjectsList({
  projects,
  loading,
  error,
  includeArchived,
  pending,
  notice,
  actionError,
  onCreate,
  onOpen,
  onRename,
  onToggleArchived,
  onDelete,
  onIncludeArchivedChange,
  onRetry
}: {
  projects: ProjectSummary[];
  loading: boolean;
  error: string;
  includeArchived: boolean;
  pending: boolean;
  notice: string;
  actionError: string;
  onCreate(): void;
  onOpen(project: ProjectSummary): void;
  onRename(project: ProjectSummary): void;
  onToggleArchived(project: ProjectSummary): void;
  onDelete(project: ProjectSummary): void;
  onIncludeArchivedChange(value: boolean): void;
  onRetry(): void;
}): JSX.Element {
  return (
    <section className="kr-library">
      <div className="kr-library__filters">
        <div className="kr-library__count">{loading ? '正在读取项目…' : `${projects.length} 个项目`}</div>
        <label>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => onIncludeArchivedChange(event.target.checked)}
          />
          显示已归档
        </label>
        <button type="button" className="kr-primary" onClick={onCreate}>
          + 新建项目
        </button>
      </div>
      {notice ? (
        <p className="kr-settings__message" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="kr-page-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {error ? (
        <div className="kr-page-error" role="alert">
          <p>项目读取失败：{error}</p>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : loading && projects.length === 0 ? (
        <p className="kr-page-status">正在读取项目…</p>
      ) : projects.length === 0 ? (
        <div className="kr-empty">
          <p>还没有项目。</p>
          <p className="kr-muted">
            把文献按课题或论文分组；项目只保存关联，不移动、不删除文献。
          </p>
        </div>
      ) : (
        <ul className="kr-doc-list kr-doc-list--rows">
          {projects.map((project) => (
            <li
              className="kr-doc-row"
              key={project.id}
              role="button"
              tabIndex={0}
              title={`打开项目「${project.name}」`}
              onClick={(event) => {
                if (event.target instanceof Element && event.target.closest('button')) return;
                onOpen(project);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen(project);
                }
              }}
            >
              <div className="kr-doc-row__main">
                <span className="kr-doc-row__title">{project.name}</span>
                <span className="kr-doc-row__badges">
                  <span className="kr-doc-card__tag">{project.documentCount} 篇文献</span>
                  {project.archivedAt ? <span className="kr-doc-card__folder">已归档</span> : null}
                  {project.description ? (
                    <span className="kr-doc-row__state" title={project.description}>
                      {project.description}
                    </span>
                  ) : null}
                </span>
              </div>
              <span className="kr-doc-row__meta">最近更新 {formatProjectTime(project.updatedAt)}</span>
              <span className="kr-doc-row__actions">
                <button
                  type="button"
                  title={`重命名「${project.name}」`}
                  onClick={() => onRename(project)}
                  disabled={pending}
                >
                  改名
                </button>
                <button
                  type="button"
                  title={
                    project.archivedAt
                      ? `取消归档「${project.name}」（文献关联不受影响）`
                      : `归档「${project.name}」：默认不再出现在项目列表里`
                  }
                  onClick={() => onToggleArchived(project)}
                  disabled={pending}
                >
                  {project.archivedAt ? '取消归档' : '归档'}
                </button>
                <button
                  type="button"
                  className="kr-danger"
                  title={`删除「${project.name}」（只删除项目，不删除文献）`}
                  onClick={() => onDelete(project)}
                  disabled={pending}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 项目工作区：列表 ↔ 详情由内部状态切换，不新增导航体系。
 *
 * 打开详情里的文献时通过 `onOpenDocument` 交给 Workspace 打开阅读页（与现有文献列表一致）。
 */
export function ProjectsView({
  api,
  documents,
  onOpenDocument
}: {
  api: ApiClient;
  documents: DocumentSummary[];
  onOpenDocument(document: DocumentSummary): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickedDocumentIds, setPickedDocumentIds] = useState<string[]>([]);

  const projectsQuery = useQuery({
    queryKey: ['projects', includeArchived],
    queryFn: () => api.listProjects(includeArchived)
  });
  const projects = projectsQuery.data ?? [];
  const selectedProject = selectedProjectId
    ? (projects.find((project) => project.id === selectedProjectId) ?? null)
    : null;

  const projectDocumentsQuery = useQuery({
    queryKey: ['project-documents', selectedProjectId],
    queryFn: () => api.listProjectDocuments(selectedProjectId ?? ''),
    enabled: selectedProjectId !== null
  });
  const projectDocuments = projectDocumentsQuery.data ?? [];

  // 列表与详情共用同一批查询键：链接变化也会改 project.updatedAt/documentCount。
  const refreshProjects = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  const refreshProjectDocuments = (projectId: string): void => {
    void queryClient.invalidateQueries({ queryKey: ['project-documents', projectId] });
  };
  const resetTransient = (): void => {
    setNotice('');
    setActionError('');
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: (project) => {
      refreshProjects();
      setDialog(null);
      setDialogError('');
      resetTransient();
      setNotice(`已新建项目「${project.name}」。`);
    },
    onError: (error: Error) => setDialogError(projectErrorMessage(error))
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateProject(id, { name }),
    onSuccess: (project) => {
      refreshProjects();
      setDialog(null);
      setDialogError('');
      resetTransient();
      setNotice(`已把项目改名为「${project.name}」。`);
    },
    onError: (error: Error) => setDialogError(projectErrorMessage(error))
  });

  const archiveMutation = useMutation({
    mutationFn: ({ project, archived }: { project: ProjectSummary; archived: boolean }) =>
      api.updateProject(project.id, { archived }),
    onSuccess: (project, variables) => {
      refreshProjects();
      if (variables.archived && selectedProjectId === project.id) setSelectedProjectId(null);
      resetTransient();
      setNotice(
        variables.archived
          ? `已归档项目「${project.name}」。`
          : `已取消归档项目「${project.name}」。`
      );
    },
    onError: (error: Error) => setActionError(projectErrorMessage(error))
  });

  const deleteMutation = useMutation({
    mutationFn: (project: ProjectSummary) => api.deleteProject(project.id),
    onSuccess: (result, project) => {
      refreshProjects();
      if (selectedProjectId === project.id) setSelectedProjectId(null);
      resetTransient();
      setNotice(
        `已删除项目「${project.name}」，${result.detachedDocuments} 篇文献仍保留在文献库。`
      );
    },
    onError: (error: Error) => setActionError(projectErrorMessage(error))
  });

  const addMutation = useMutation({
    mutationFn: async ({
      projectId,
      documentIds
    }: {
      projectId: string;
      documentIds: string[];
    }) => {
      let added = 0;
      for (const documentId of documentIds) {
        await api.addProjectDocument(projectId, documentId);
        added += 1;
      }
      return added;
    },
    onSuccess: (added, variables) => {
      refreshProjectDocuments(variables.projectId);
      refreshProjects();
      setPickedDocumentIds([]);
      setPickerSearch('');
      setPickerOpen(false);
      resetTransient();
      setNotice(`已把 ${added} 篇文献加入项目。`);
    },
    onError: (error: Error, variables) => {
      // 循环里可能已加入前几篇：失败也刷新一次，界面与服务端保持一致。
      refreshProjectDocuments(variables.projectId);
      refreshProjects();
      setActionError(projectErrorMessage(error));
    }
  });

  const removeMutation = useMutation({
    mutationFn: ({
      projectId,
      documentId
    }: {
      projectId: string;
      documentId: string;
    }) => api.deleteProjectDocument(projectId, documentId),
    onSuccess: (_result, variables) => {
      refreshProjectDocuments(variables.projectId);
      refreshProjects();
      const removed = projectDocuments.find(
        (document) => document.id === variables.documentId
      );
      resetTransient();
      setNotice(`已从项目移出${removed ? `「${removed.name}」` : '文献'}，文献本身未删除。`);
    },
    onError: (error: Error) => setActionError(projectErrorMessage(error))
  });

  const openCreateDialog = (): void => {
    resetTransient();
    setDialog({ mode: 'create' });
    setNameInput('');
    setDialogError('');
  };

  const openRenameDialog = (project: ProjectSummary): void => {
    resetTransient();
    setDialog({ mode: 'rename', project });
    setNameInput(project.name);
    setDialogError('');
  };

  const closeDialog = (): void => {
    setDialog(null);
    setDialogError('');
  };

  const submitDialog = (): void => {
    if (!dialog) return;
    const name = nameInput.trim();
    if (!name) {
      setDialogError('请输入项目名称。');
      return;
    }
    setDialogError('');
    if (dialog.mode === 'create') createMutation.mutate(name);
    else renameMutation.mutate({ id: dialog.project.id, name });
  };

  const toggleArchived = (project: ProjectSummary): void => {
    const archived = !project.archivedAt;
    if (archived) {
      const confirmed = appDialogs.confirm(
        `归档项目「${project.name}」？\n\n归档后默认不在项目列表里显示（可勾选「显示已归档」找到并取消归档），文献关联不受影响。`
      );
      if (!confirmed) return;
    }
    resetTransient();
    archiveMutation.mutate({ project, archived });
  };

  const confirmDelete = (project: ProjectSummary): void => {
    const confirmed = appDialogs.confirm(
      `删除项目「${project.name}」？\n\n只删除项目，不删除文献：项目里的 ${project.documentCount} 篇文献仍保留在文献库中。此操作不可恢复。`
    );
    if (!confirmed) return;
    resetTransient();
    deleteMutation.mutate(project);
  };

  const confirmRemove = (document: ProjectDocumentRecord): void => {
    if (!selectedProject) return;
    const confirmed = appDialogs.confirm(
      `将「${document.name}」移出项目「${selectedProject.name}」？\n\n仅移出项目，不删除文献：文献仍保留在文献库中。`
    );
    if (!confirmed) return;
    resetTransient();
    removeMutation.mutate({ projectId: selectedProject.id, documentId: document.id });
  };

  const inProjectIds = new Set(projectDocuments.map((document) => document.id));
  const pickerQuery = pickerSearch.trim().toLowerCase();
  const pickerCandidates = documents.filter((document) => {
    if (inProjectIds.has(document.id)) return false;
    if (!pickerQuery) return true;
    return `${document.name} ${document.author}`.toLowerCase().includes(pickerQuery);
  });
  const addPicked = (): void => {
    if (!selectedProject || pickedDocumentIds.length === 0) return;
    resetTransient();
    addMutation.mutate({
      projectId: selectedProject.id,
      documentIds: [...pickedDocumentIds]
    });
  };

  if (selectedProject) {
    const documentsLoading = projectDocumentsQuery.isLoading;
    const documentsError = projectDocumentsQuery.isError
      ? projectErrorMessage(projectDocumentsQuery.error)
      : '';
    return (
      <section className="kr-library">
        <div className="kr-library__filters">
          <button
            type="button"
            onClick={() => {
              setSelectedProjectId(null);
              setPickerOpen(false);
              setPickerSearch('');
              setPickedDocumentIds([]);
              resetTransient();
            }}
          >
            ← 返回项目列表
          </button>
          <div className="kr-library__count">
            {selectedProject.name} · {projectDocuments.length} 篇文献
            {selectedProject.archivedAt ? ' · 已归档' : ''}
          </div>
          <button
            type="button"
            className="kr-secondary"
            aria-expanded={pickerOpen}
            onClick={() => {
              setPickerOpen(!pickerOpen);
              resetTransient();
            }}
            disabled={addMutation.isPending}
          >
            {pickerOpen ? '收起添加面板' : '+ 从文献库添加'}
          </button>
        </div>
        <p className="kr-muted">项目只保存文献关联：从项目移出不会删除文献。</p>
        {notice ? (
          <p className="kr-settings__message" role="status">
            {notice}
          </p>
        ) : null}
        {actionError ? (
          <p className="kr-page-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {pickerOpen ? (
          <div>
            <div className="kr-library__filters">
              <label>
                搜索文献
                <input
                  type="search"
                  value={pickerSearch}
                  placeholder="标题或作者"
                  onChange={(event) => setPickerSearch(event.target.value)}
                />
              </label>
              <span className="kr-library__count">可添加 {pickerCandidates.length} 篇</span>
              <button
                type="button"
                className="kr-primary"
                onClick={addPicked}
                disabled={pickedDocumentIds.length === 0 || addMutation.isPending}
              >
                {addMutation.isPending
                  ? '正在加入…'
                  : `加入所选${pickedDocumentIds.length > 0 ? `（${pickedDocumentIds.length}）` : ''}`}
              </button>
            </div>
            {pickerCandidates.length === 0 ? (
              <p className="kr-muted">
                {documents.length === 0
                  ? '文献库还没有文献。'
                  : '没有可添加的文献（已在项目里的不会重复列出）。'}
              </p>
            ) : (
              <ul className="kr-doc-list kr-doc-list--rows">
                {pickerCandidates.map((document) => (
                  <li className="kr-doc-row" key={document.id}>
                    <label className="kr-doc-row__main">
                      <span className="kr-doc-row__title">
                        <input
                          type="checkbox"
                          checked={pickedDocumentIds.includes(document.id)}
                          onChange={() =>
                            setPickedDocumentIds((current) =>
                              current.includes(document.id)
                                ? current.filter((id) => id !== document.id)
                                : [...current, document.id]
                            )
                          }
                        />{' '}
                        {document.name}
                      </span>
                      <span className="kr-doc-row__badges">
                        {document.author ? (
                          <span className="kr-doc-card__tag">@{document.author}</span>
                        ) : null}
                        <span className="kr-doc-row__meta">{document.pages} 页</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {documentsLoading ? <p className="kr-page-status">正在读取项目文献…</p> : null}
        {documentsError ? (
          <div className="kr-page-error" role="alert">
            <p>项目文献读取失败：{documentsError}</p>
            <button type="button" onClick={() => void projectDocumentsQuery.refetch()}>
              重试
            </button>
          </div>
        ) : null}
        {!documentsLoading && !documentsError && projectDocuments.length === 0 ? (
          <div className="kr-empty">
            <p>这个项目还没有文献。</p>
            <p className="kr-muted">
              点「+ 从文献库添加」把已有文献加进来；加入/移出都不改动文献本身。
            </p>
          </div>
        ) : null}
        {projectDocuments.length > 0 ? (
          <ul className="kr-doc-list kr-doc-list--rows">
            {projectDocuments.map((document) => (
              <li
                className="kr-doc-row"
                key={document.id}
                role="button"
                tabIndex={0}
                title={`打开「${document.name}」`}
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest('button')) return;
                  onOpenDocument(document);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenDocument(document);
                  }
                }}
              >
                <div className="kr-doc-row__main">
                  <span className="kr-doc-row__title">{document.name}</span>
                  <span className="kr-doc-row__badges">
                    {document.author ? (
                      <span className="kr-doc-card__tag">@{document.author}</span>
                    ) : null}
                    {document.missing_file ? (
                      <span className="kr-doc-card__missing">附件缺失</span>
                    ) : null}
                  </span>
                </div>
                <span className="kr-doc-row__meta">
                  {document.pages} 页 · 加入于 {formatProjectTime(document.addedAt)}
                </span>
                <span className="kr-doc-row__actions">
                  <button
                    type="button"
                    disabled={removeMutation.isPending}
                    title={`将「${document.name}」移出项目（仅移出项目，不删除文献）`}
                    onClick={() => confirmRemove(document)}
                  >
                    移出
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <ProjectsList
        projects={projects}
        loading={projectsQuery.isLoading}
        error={projectsQuery.isError ? projectErrorMessage(projectsQuery.error) : ''}
        includeArchived={includeArchived}
        pending={archiveMutation.isPending || deleteMutation.isPending}
        notice={notice}
        actionError={actionError}
        onCreate={openCreateDialog}
        onOpen={(project) => {
          setSelectedProjectId(project.id);
          resetTransient();
        }}
        onRename={openRenameDialog}
        onToggleArchived={toggleArchived}
        onDelete={confirmDelete}
        onIncludeArchivedChange={(value) => {
          setIncludeArchived(value);
          resetTransient();
        }}
        onRetry={() => void projectsQuery.refetch()}
      />
      {dialog ? (
        <ProjectNameDialog
          mode={dialog.mode}
          originalName={dialog.mode === 'rename' ? dialog.project.name : undefined}
          value={nameInput}
          error={dialogError}
          pending={createMutation.isPending || renameMutation.isPending}
          onChange={setNameInput}
          onSubmit={submitDialog}
          onClose={closeDialog}
        />
      ) : null}
    </>
  );
}
