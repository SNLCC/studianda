/**
 * 「按项目圈定范围」的提交口径（纯函数，node 环境，无需 DOM）。
 *
 * 钉住的既有前提：项目 / 手选文献 / 标签三选一。
 * 服务端两处 `projectId` 冲突校验的命名差异（设计文档 §7 第 2 条）不可由客户端触发，
 * 依据就是这里 + ChatPanel 只用 `scope_documents` 透传：客户端永远不会同时给
 * `projectId` 与非空 `scopeDocuments`/`scopeTags`，所以两边口径不同也构造不出
 * 「同一请求一个接口 400、另一个 200」。
 */
import { describe, expect, it } from 'vitest';
import { projectScopeAskPayload } from '../src/project-scope';

describe('projectScopeAskPayload：项目/文献/标签互斥', () => {
  it('按项目：只带 projectId，手选文献与标签一律清空', () => {
    expect(
      projectScopeAskPayload({
        mode: 'project',
        scopeDocuments: ['doc-a'],
        scopeTags: ['tag-a'],
        usableProjectId: 'project-1'
      })
    ).toEqual({ projectId: 'project-1', scopeDocuments: [] });
  });

  it('项目为空/失效（usableProjectId 为空串）：不带 projectId，调用方还会拦请求', () => {
    const payload = projectScopeAskPayload({
      mode: 'project',
      scopeDocuments: [],
      scopeTags: [],
      usableProjectId: ''
    });
    expect(payload.projectId).toBeUndefined();
    expect(payload.scopeDocuments).toEqual([]);
  });

  it('按手选文献：不带 projectId 与标签', () => {
    expect(
      projectScopeAskPayload({
        mode: 'documents',
        scopeDocuments: ['doc-a', 'doc-b'],
        scopeTags: ['tag-a'],
        usableProjectId: 'project-1'
      })
    ).toEqual({ scopeDocuments: ['doc-a', 'doc-b'] });
  });

  it('按标签：不带 projectId 与手选文献；没有标签时也不留空数组', () => {
    expect(
      projectScopeAskPayload({
        mode: 'tags',
        scopeDocuments: ['doc-a'],
        scopeTags: ['tag-a'],
        usableProjectId: 'project-1'
      })
    ).toEqual({ scopeDocuments: [], scopeTags: ['tag-a'] });
    expect(
      projectScopeAskPayload({
        mode: 'tags',
        scopeDocuments: ['doc-a'],
        scopeTags: [],
        usableProjectId: 'project-1'
      })
    ).toEqual({ scopeDocuments: [] });
  });
});
