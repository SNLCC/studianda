/**
 * 「按项目圈定范围」的纯逻辑与展示（跨文献范围弹窗里的「按项目」页）。
 *
 * 为什么单独放一个模块：项目范围有三条必须被验证的规则（空项目不提问、已选项目失效要降级、
 * 项目与手选文献/标签互斥），把它们做成纯函数后，无 UI 测试基建时也能用临时 SSR 冒烟覆盖；
 * ChatPanel 只负责把状态与回调接上，不复写判定。
 *
 * 视觉只复用既有的 kr-chat__scope-* / kr-chat__scope-count 类名，不新增 CSS。
 */
import type { JSX } from 'react';

/** 项目范围需要的最小项目信息（`listProjects` 的 ProjectSummary 结构兼容）。 */
export interface ProjectScopeOption {
  id: string;
  name: string;
  /** 项目当前可用于检索/阅读的文献数（`listProjects` 的 documentCount，同一口径）。 */
  documentCount?: number;
  /** 归档时间（空串 = 未归档）；归档项目不能再作为检索/阅读范围。 */
  archivedAt?: string;
}

/** 空项目提示：界面固定文案，选中空项目时显示且不发出提问/检索请求。 */
export const PROJECT_SCOPE_EMPTY_NOTICE = '该项目暂无文献';
/** 已选项目失效（被删除/归档后不再出现在可选项里）时的降级提示。 */
export const PROJECT_SCOPE_MISSING_NOTICE =
  '所选项目已不可用（可能已删除或已归档），已切回手选范围。';

export type ProjectScopeState = 'none' | 'ok' | 'empty' | 'missing' | 'pending';

export interface ProjectScopeResolution {
  state: ProjectScopeState;
  /** 选中且可用（非空）的项目；其它状态为 undefined。 */
  project?: ProjectScopeOption;
  /** 界面提示；没有提示时为空串。 */
  notice: string;
  /** true = 不能带这个范围提问（空项目/失效项目）；调用方应拦下请求。 */
  blocked: boolean;
}

/** 只保留未归档项目：归档项目不能再作为范围（与项目列表默认口径一致）。 */
export function activeProjectOptions(
  projects: readonly ProjectScopeOption[]
): ProjectScopeOption[] {
  return projects.filter((project) => !(project.archivedAt && project.archivedAt.trim() !== ''));
}

/**
 * 解析当前选中的项目范围。
 *
 * - 未选项目：`none`（不拦提问，按原范围走）；
 * - 项目列表还没拿到（`undefined`）：`pending`，不下结论、不拦，避免把「正在读取」误判成失效；
 * - 项目不在未归档列表里：`missing` + 降级提示（调用方应清空选择、回到手选范围）；
 * - 项目存在但 0 篇文献：`empty` + 「该项目暂无文献」提示，且 `blocked`；
 * - 其余：`ok`。
 */
export function resolveProjectScope(
  projects: readonly ProjectScopeOption[] | undefined,
  selectedId: string
): ProjectScopeResolution {
  if (!selectedId) return { state: 'none', notice: '', blocked: false };
  if (!projects) return { state: 'pending', notice: '', blocked: false };
  const project = activeProjectOptions(projects).find((item) => item.id === selectedId);
  if (!project) {
    return { state: 'missing', notice: PROJECT_SCOPE_MISSING_NOTICE, blocked: true };
  }
  if (typeof project.documentCount === 'number' && project.documentCount <= 0) {
    return { state: 'empty', project, notice: PROJECT_SCOPE_EMPTY_NOTICE, blocked: true };
  }
  return { state: 'ok', project, notice: '', blocked: false };
}

/**
 * 本轮提问的提交口径：项目/文献/标签三选一。
 *
 * 选了项目就**不再**带 scopeDocuments/scopeTags，选了手选文献或标签也**不再**带 projectId——
 * 互斥在前端就拦掉，不等服务端 400。空项目/未选中时不给 projectId（调用方还会拦请求）。
 */
export function projectScopeAskPayload(input: {
  mode: 'documents' | 'tags' | 'project';
  scopeDocuments: readonly string[];
  scopeTags: readonly string[];
  /** 已解析且可用的项目 id；空项目/失效项目传空串。 */
  usableProjectId: string;
}): { projectId?: string; scopeDocuments: string[]; scopeTags?: string[] } {
  if (input.mode === 'project') {
    return {
      ...(input.usableProjectId ? { projectId: input.usableProjectId } : {}),
      scopeDocuments: []
    };
  }
  if (input.mode === 'tags') {
    return {
      scopeDocuments: [],
      ...(input.scopeTags.length > 0 ? { scopeTags: [...input.scopeTags] } : {})
    };
  }
  return { scopeDocuments: [...input.scopeDocuments] };
}

/**
 * 「按项目」范围面板（纯展示，便于 SSR 冒烟覆盖项目列表 / 空项目提示 / 失效降级三态）。
 *
 * 单选语义：项目范围只有一个；「不按项目（全部文献）」把选择清空，回到手选范围。
 */
export function ProjectScopePane({
  projects,
  selectedId,
  query,
  notice,
  onQueryChange,
  onSelect
}: {
  projects: readonly ProjectScopeOption[];
  selectedId: string;
  query: string;
  notice: string;
  onQueryChange(value: string): void;
  onSelect(projectId: string): void;
}): JSX.Element {
  const options = activeProjectOptions(projects);
  const filter = query.trim().toLowerCase();
  const visible = options.filter(
    (project) => !filter || project.name.toLowerCase().includes(filter)
  );
  const selected = options.find((project) => project.id === selectedId);
  const selectedEmpty =
    selected !== undefined &&
    typeof selected.documentCount === 'number' &&
    selected.documentCount <= 0;
  return (
    <div className="kr-chat__scope-projects">
      <div className="kr-chat__scope-search">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索项目名…"
          aria-label="搜索项目"
        />
      </div>
      <div className="kr-chat__scope-list" role="radiogroup" aria-label="按项目圈定范围">
        <label className="kr-chat__scope-option kr-chat__scope-all">
          <input
            type="radio"
            name="kr-chat-scope-project"
            checked={selectedId === ''}
            onChange={() => onSelect('')}
          />
          <span>不按项目（全部文献）</span>
        </label>
        {visible.map((project) => (
          <label className="kr-chat__scope-option" key={project.id}>
            <input
              type="radio"
              name="kr-chat-scope-project"
              checked={selectedId === project.id}
              onChange={() => onSelect(project.id)}
            />
            <span>
              {project.name}
              <small>
                {' · '}
                {typeof project.documentCount === 'number'
                  ? `${project.documentCount} 篇`
                  : '文献数未知'}
              </small>
            </span>
          </label>
        ))}
        {visible.length === 0 && options.length > 0 ? (
          <p className="kr-chat__scope-count">没有匹配的项目。</p>
        ) : null}
        {options.length === 0 ? (
          <p className="kr-chat__scope-count">
            还没有可用项目。先在「项目」里把文献分组，再按项目圈范围。
          </p>
        ) : null}
      </div>
      {notice ? (
        <p className="kr-chat__scope-count" role="status">
          {notice}
        </p>
      ) : null}
      <p className="kr-chat__scope-count">
        {selected
          ? `已选 项目「${selected.name}」${
              selectedEmpty ? ' · 暂无文献' : ''
            }${
              typeof selected.documentCount === 'number' && !selectedEmpty
                ? ` · ${selected.documentCount} 篇文献`
                : ''
            }`
          : selectedId
            ? '已选 项目（已不可用，请重新选择）'
            : '已选 不按项目（全部文献）'}
      </p>
      <p className="kr-muted">
        项目范围按项目当前文献圈定；空项目不能提问，检索与精读都只在这个项目里进行。
      </p>
    </div>
  );
}
