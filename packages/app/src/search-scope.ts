/**
 * 文献库「检索范围」的纯逻辑：范围方式（全部/指定文献/标签/按项目）的组装与互斥清理。
 *
 * 为什么单独放一个模块：这些规则被文献库检索、项目详情「在此项目中检索」、项目失效降级
 * 三处共用，且都要求「项目与手选文献/标签互斥、失效项目绝不静默带 404 id」。
 * 以前内联在 StudiandaApp 里只能靠真机手测；提取成纯函数后由 `test/search-scope.test.ts` 回归。
 *
 * 这里只管判定与下一次选择的值；状态写回（setState）留给调用方。
 */
import type { ProjectSummary } from '@studianda/shared';

/** 检索范围方式（与界面下拉一一对应）。 */
export type LibraryScopeMode = 'all' | 'tags' | 'documents' | 'project';

/** 一次检索范围选择的完整状态（对应组件里的 4 个 useState）。 */
export interface SearchScopeSelection {
  mode: LibraryScopeMode;
  /** 「指定文献」范围（mode=documents 时生效）。 */
  documents: readonly string[];
  /** 「标签」范围（mode=tags 时生效）。 */
  tags: readonly string[];
  /** 「按项目」范围：项目 id；空串 = 未选。 */
  projectId: string;
}

/** 「按项目」当前的解析结果：项目是否还有效、范围是否生效、是否空项目。 */
export interface SearchProjectResolution {
  /** 选中且仍在未归档项目清单里的项目；未选/已失效为 null。 */
  project: ProjectSummary | null;
  /** true = 处于「按项目」且确实选了 id（不代表项目仍有效）。 */
  active: boolean;
  /** true = 项目存在但 0 篇文献：界面提示且不发检索请求。 */
  empty: boolean;
}

/**
 * 解析「按项目」检索范围。
 *
 * - 未选项目：`active=false`，不当作范围；
 * - 项目已被归档/删除（不在列表里）：`project=null` 但 `active` 仍为 true，
 *   调用方据此降级回全部文献，绝不静默带一个 404 的 id；
 * - 项目存在但 `documentCount<=0`：`empty=true`，界面提示且一个检索请求都不发。
 */
export function resolveSearchProject(
  projects: readonly ProjectSummary[],
  mode: LibraryScopeMode,
  projectId: string
): SearchProjectResolution {
  const project =
    projectId !== '' ? (projects.find((item) => item.id === projectId) ?? null) : null;
  const active = mode === 'project' && projectId !== '';
  const empty = active && project !== null && project.documentCount <= 0;
  return { project, active, empty };
}

/**
 * 范围是否「选全了」：指定文献/标签至少要 1 项，按项目至少要选 1 个项目。
 *
 * 只表示选择是否完整，不判断项目是否还有效（失效由 `resolveSearchProject` 负责）。
 */
export function searchScopeReady(selection: SearchScopeSelection): boolean {
  if (selection.mode === 'all') return true;
  if (selection.mode === 'documents') return selection.documents.length > 0;
  if (selection.mode === 'tags') return selection.tags.length > 0;
  return selection.projectId !== '';
}

/**
 * 切换范围方式：清空手选文献/标签；**切走项目时清掉项目 id**，
 * 避免下次切回「按项目」时残留一个旧项目。
 */
export function switchSearchScopeMode(
  next: LibraryScopeMode,
  current: SearchScopeSelection
): SearchScopeSelection {
  return {
    mode: next,
    documents: [],
    tags: [],
    projectId: next === 'project' ? current.projectId : ''
  };
}

/**
 * 选中一个项目：进入「按项目」范围并清空手选文献/标签（与它们互斥）。
 *
 * 空串表示「还没有可用项目」/清空选择；调用方应把 4 个字段一起写回。
 */
export function chooseSearchProject(projectId: string): SearchScopeSelection {
  return { mode: 'project', documents: [], tags: [], projectId };
}
