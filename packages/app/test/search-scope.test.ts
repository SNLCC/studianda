/**
 * 文献库「检索范围」的回归网（纯函数，node 环境，无需 DOM/Electron/真实网络）。
 *
 * 盯住的核心口径：项目与手选文献/标签互斥；切走「按项目」不残留旧项目 id；
 * 已归档/删除的项目要能被识别为失效并降级；空项目不能发检索请求。
 */
import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '@studianda/shared';
import {
  chooseSearchProject,
  resolveSearchProject,
  searchScopeReady,
  switchSearchScopeMode,
  type SearchScopeSelection
} from '../src/search-scope.js';

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'project-1',
    name: '近代史资料',
    description: '',
    archivedAt: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    documentCount: 3,
    ...overrides
  };
}

function selection(overrides: Partial<SearchScopeSelection> = {}): SearchScopeSelection {
  return { mode: 'all', documents: [], tags: [], projectId: '', ...overrides };
}

describe('resolveSearchProject', () => {
  it('未选项目时不算范围（active/empty 都为 false）', () => {
    expect(resolveSearchProject([project()], 'all', '')).toEqual({
      project: null,
      active: false,
      empty: false
    });
    expect(resolveSearchProject([project()], 'project', '')).toEqual({
      project: null,
      active: false,
      empty: false
    });
  });

  it('项目存在且有文献：范围生效且不空', () => {
    const result = resolveSearchProject([project()], 'project', 'project-1');
    expect(result.active).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.project?.name).toBe('近代史资料');
  });

  it('非「按项目」方式下即使残留 id 也不算项目范围', () => {
    const result = resolveSearchProject([project()], 'tags', 'project-1');
    expect(result.active).toBe(false);
    expect(result.empty).toBe(false);
  });

  it('空项目：active=true 但 empty=true（提示且不发请求）', () => {
    const result = resolveSearchProject([project({ documentCount: 0 })], 'project', 'project-1');
    expect(result.active).toBe(true);
    expect(result.empty).toBe(true);
  });

  it('项目已归档/删除（不在清单里）：project=null 但 active 仍为 true，供调用方降级', () => {
    const result = resolveSearchProject([], 'project', 'project-gone');
    expect(result.project).toBeNull();
    expect(result.active).toBe(true);
    expect(result.empty).toBe(false);
  });

  it('只在传入的清单里查找，不跨项目匹配', () => {
    const result = resolveSearchProject([project({ id: 'project-2' })], 'project', 'project-1');
    expect(result.project).toBeNull();
    expect(result.active).toBe(true);
  });
});

describe('searchScopeReady', () => {
  it('全部文献永远算选全（不要求任何选择）', () => {
    expect(searchScopeReady(selection())).toBe(true);
  });

  it('指定文献至少选 1 项', () => {
    expect(searchScopeReady(selection({ mode: 'documents' }))).toBe(false);
    expect(searchScopeReady(selection({ mode: 'documents', documents: ['doc-1'] }))).toBe(true);
  });

  it('标签至少选 1 项', () => {
    expect(searchScopeReady(selection({ mode: 'tags' }))).toBe(false);
    expect(searchScopeReady(selection({ mode: 'tags', tags: ['近代史'] }))).toBe(true);
  });

  it('按项目至少要选 1 个项目', () => {
    expect(searchScopeReady(selection({ mode: 'project' }))).toBe(false);
    expect(searchScopeReady(selection({ mode: 'project', projectId: 'project-1' }))).toBe(true);
  });
});

describe('switchSearchScopeMode', () => {
  it('从「按项目」切到「全部文献」：清空手选范围并清掉项目 id', () => {
    expect(
      switchSearchScopeMode('all', {
        mode: 'project',
        documents: ['doc-1'],
        tags: ['近代史'],
        projectId: 'project-1'
      })
    ).toEqual({ mode: 'all', documents: [], tags: [], projectId: '' });
  });

  it('切到「指定文献」/「标签」同样清空项目 id 与另一种手选范围', () => {
    expect(
      switchSearchScopeMode('documents', {
        mode: 'project',
        documents: [],
        tags: ['近代史'],
        projectId: 'project-1'
      })
    ).toEqual({ mode: 'documents', documents: [], tags: [], projectId: '' });
    expect(
      switchSearchScopeMode('tags', {
        mode: 'documents',
        documents: ['doc-1'],
        tags: [],
        projectId: ''
      })
    ).toEqual({ mode: 'tags', documents: [], tags: [], projectId: '' });
  });

  it('切到「按项目」时保留已有项目 id（只在切走时清理，避免选择被无谓重置）', () => {
    expect(
      switchSearchScopeMode('project', {
        mode: 'project',
        documents: [],
        tags: [],
        projectId: 'project-1'
      }).projectId
    ).toBe('project-1');
  });
});

describe('chooseSearchProject', () => {
  it('选中项目：进入按项目方式，带项目 id', () => {
    expect(chooseSearchProject('project-1')).toEqual({
      mode: 'project',
      documents: [],
      tags: [],
      projectId: 'project-1'
    });
  });

  it('与手选文献/标签互斥：选了项目后两者必为空', () => {
    const next = chooseSearchProject('project-1');
    expect(next.documents).toHaveLength(0);
    expect(next.tags).toHaveLength(0);
  });

  it('空串视为清空选择：仍停在按项目方式，但不带 id（界面提示请选择）', () => {
    expect(chooseSearchProject('')).toEqual({
      mode: 'project',
      documents: [],
      tags: [],
      projectId: ''
    });
  });
});
