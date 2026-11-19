import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectSearchResult, ProjectSummary } from '@studianda/shared';
import { resolveProjectScope } from '../src/project-scope.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 逻辑项目接检索/精读作用域（schema 22 的项目表 + `/search` + `/corpus-sessions` + 精读入口）。
 *
 * 验收点：
 * - 按项目检索只命中项目内文献；文献移出项目后不再命中；documentId 在项目外也不扩大范围；
 * - 空项目返回 200 + 空结果 + `scope.empty` 标记（不是错误）；项目不存在 404；
 * - projectId 与显式 documentIds/scopeDocuments/scope_documents 互斥 → 400；
 * - 用 projectId 建跨文献会话：快照等于项目当前文献集合；之后项目增删文献不影响已建会话；
 * - 精读入口（/chat/budget、/chat/ask）同样按项目解析范围；
 * - 项目 `documentCount` 与解析出的可用文献数同口径，直接复用、不加冗余字段。
 *
 * 全部走本机确定性逻辑（检索/预算/快照），不需要模型服务；样张 PDF 运行时生成。
 */

const token = 'project-scope-token';
const root = mkdtempSync(path.join(tmpdir(), 'studianda-project-scope-'));
const dataDir = path.join(root, 'data');
const store = new Store(dataDir);
const server = buildServer({
  token,
  version: 'test-version',
  store,
  secrets: new SecretStore()
});
const headers = { 'x-studianda-token': token };

let documentA = '';
let documentB = '';
let documentC = '';

/** 每篇一页、带唯一检索词；三篇共享 `common` 词用于验证范围过滤。 */
async function importPdf(name: string, text: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([420, 594]);
  page.drawText(text, { x: 30, y: 560, size: 12, font });
  const file = path.join(root, `${name}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, `${name}.pdf`, true);
  return document.id;
}

/** 建项目并按顺序加入文献（项目只存链接，文献仍全局唯一）。 */
function makeProject(name: string, documentIds: string[]): string {
  const project = store.createProject({ name });
  for (const documentId of documentIds) store.addProjectDocument(project.id, documentId);
  return project.id;
}

interface SearchResponse {
  statusCode: number;
  body: ProjectSearchResult | Array<{ documentId: string }>;
}

async function postSearch(payload: Record<string, unknown>): Promise<SearchResponse> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/search',
    headers,
    payload
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as SearchResponse['body']
  };
}

/** 命中来自哪些文献（去重排序，避免把顺序当成断言）。 */
function hitDocumentIds(result: ProjectSearchResult): string[] {
  return [...new Set(result.hits.map((hit) => hit.documentId))].sort();
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

beforeAll(async () => {
  documentA = await importPdf('proj-a', 'common alpha retrieval findings');
  documentB = await importPdf('proj-b', 'common beta retrieval analysis');
  documentC = await importPdf('proj-c', 'common gamma retrieval appendix');
  // 检索前确认导入确实产生了可检索的段落，否则后面的断言会掩盖导入失败。
  expect(store.listChunks(documentA).length).toBeGreaterThan(0);
  expect(store.listChunks(documentB).length).toBeGreaterThan(0);
  expect(store.listChunks(documentC).length).toBeGreaterThan(0);
}, 120_000);

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('逻辑项目解析成范围（resolveProjectScope）', () => {
  it('项目不存在 → null；空项目 → []；有文献 → 当前可读文献 id', () => {
    expect(resolveProjectScope(store, 'not-a-project')).toBeNull();

    const empty = store.createProject({ name: '空项目-解析' });
    expect(resolveProjectScope(store, empty.id)).toEqual([]);

    const project = makeProject('解析项目', [documentA, documentC]);
    expect(sorted(resolveProjectScope(store, project) ?? [])).toEqual(
      sorted([documentA, documentC])
    );
  });
});

describe('按项目检索（POST /search）', () => {
  it('只命中项目内文献；documentId 在项目外也不扩大范围；移出项目后不再命中', async () => {
    const projectId = makeProject('检索项目', [documentA, documentB]);

    const scoped = await postSearch({ query: 'common', projectId, limit: 20 });
    expect(scoped.statusCode).toBe(200);
    expect(Array.isArray(scoped.body)).toBe(false);
    const body = scoped.body as ProjectSearchResult;
    expect(body.scope).toMatchObject({ kind: 'project', projectId, empty: false });
    expect(sorted(body.scope.documentIds)).toEqual(sorted([documentA, documentB]));
    expect(hitDocumentIds(body)).toEqual(sorted([documentA, documentB]));

    // 当前文献在项目外也只作为排序锚点，不能把范围撑大。
    const outsideAnchor = await postSearch({
      query: 'common',
      projectId,
      documentId: documentC,
      limit: 20
    });
    expect(outsideAnchor.statusCode).toBe(200);
    expect(hitDocumentIds(outsideAnchor.body as ProjectSearchResult)).toEqual(
      sorted([documentA, documentB])
    );

    // 移出项目：下一次检索立刻按新范围走。
    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentA)}`,
      headers
    });
    expect(removed.statusCode).toBe(200);
    const afterRemove = await postSearch({ query: 'common', projectId, limit: 20 });
    expect(afterRemove.statusCode).toBe(200);
    expect(hitDocumentIds(afterRemove.body as ProjectSearchResult)).toEqual([documentB]);
  });

  it('不带 projectId 的原 documentIds 路径行为不变（仍返回命中数组）', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers,
      payload: {
        query: 'common',
        documentId: documentC,
        crossBook: true,
        scope: 'all'
      }
    });
    expect(response.statusCode).toBe(200);
    const hits = response.json() as Array<{ documentId: string }>;
    expect(Array.isArray(hits)).toBe(true);
    expect(sorted([...new Set(hits.map((hit) => hit.documentId))])).toEqual(
      sorted([documentA, documentB, documentC])
    );
  });

  it('空项目：200 + 空结果 + scope.empty 标记，不是错误', async () => {
    const projectId = store.createProject({ name: '检索空项目' }).id;
    const response = await postSearch({ query: 'common', projectId });
    expect(response.statusCode).toBe(200);
    const body = response.body as ProjectSearchResult;
    expect(body.hits).toEqual([]);
    expect(body.scope).toEqual({
      kind: 'project',
      projectId,
      documentIds: [],
      empty: true
    });
  });

  it('项目不存在 404；projectId 与 scopeDocuments/scopeTags 同时给 400', async () => {
    const missing = await postSearch({ query: 'common', projectId: 'missing-project' });
    expect(missing.statusCode).toBe(404);

    const projectId = makeProject('检索互斥项目', [documentA]);
    const bothDocuments = await postSearch({
      query: 'common',
      projectId,
      scopeDocuments: [documentA]
    });
    expect(bothDocuments.statusCode).toBe(400);
    expect(String((bothDocuments.body as { message?: string }).message)).toContain('不能同时给');

    const bothTags = await postSearch({
      query: 'common',
      projectId,
      scopeTags: ['标签']
    });
    expect(bothTags.statusCode).toBe(400);

    const blank = await postSearch({ query: 'common', projectId: '   ' });
    expect(blank.statusCode).toBe(400);
  });
});

describe('按项目建跨文献会话（POST /corpus-sessions）', () => {
  async function sessionDocuments(
    sessionId: string
  ): Promise<{ documentIds: string[]; documents: Array<{ id: string }> }> {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/corpus-sessions',
      headers
    });
    expect(response.statusCode).toBe(200);
    const sessions = (response.json() as {
      sessions: Array<{
        id: string;
        documentIds: string[];
        documents: Array<{ id: string }>;
      }>;
    }).sessions;
    const session = sessions.find((item) => item.id === sessionId);
    expect(session).toBeTruthy();
    return {
      documentIds: session!.documentIds,
      documents: session!.documents
    };
  }

  it('快照 = 建会话时项目当前文献；之后项目增删文献不影响该会话', async () => {
    const projectId = makeProject('会话项目', [documentA, documentB]);
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { projectId }
    });
    expect(created.statusCode).toBe(200);
    const payload = created.json() as {
      session: {
        id: string;
        documentIds: string[];
        documents: Array<{ id: string }>;
        skippedDocumentIds: string[];
      };
    };
    const sessionId = payload.session.id;
    expect(sorted(payload.session.documentIds)).toEqual(sorted([documentA, documentB]));
    expect(sorted(payload.session.documents.map((item) => item.id))).toEqual(
      sorted([documentA, documentB])
    );
    expect(payload.session.skippedDocumentIds).toEqual([]);

    // 之后往项目加文献：已建会话的快照不变。
    store.addProjectDocument(projectId, documentC);
    expect(sorted((await sessionDocuments(sessionId)).documentIds)).toEqual(
      sorted([documentA, documentB])
    );

    // 之后从项目移出文献：快照仍不变（快照里的文献本身没被删除，照样可读）。
    store.removeProjectDocument(projectId, documentB);
    const afterRemove = await sessionDocuments(sessionId);
    expect(sorted(afterRemove.documentIds)).toEqual(sorted([documentA, documentB]));
    expect(sorted(afterRemove.documents.map((item) => item.id))).toEqual(
      sorted([documentA, documentB])
    );
  });

  it('显式 documentIds 路径不变：仍按给定顺序固化快照', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { documentIds: [documentC, documentA] }
    });
    expect(response.statusCode).toBe(200);
    const session = (response.json() as {
      session: { documentIds: string[] };
    }).session;
    expect(session.documentIds).toEqual([documentC, documentA]);
  });

  it('互斥 400 / 项目不存在 404 / 空项目 400 / projectId 非字符串 400', async () => {
    const projectId = makeProject('会话校验项目', [documentA]);

    const both = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { projectId, documentIds: [documentA] }
    });
    expect(both.statusCode).toBe(400);
    expect(String((both.json() as { message?: string }).message)).toContain('不能同时给');

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { projectId: 'missing-project' }
    });
    expect(missing.statusCode).toBe(404);

    const emptyProject = store.createProject({ name: '会话空项目' });
    const empty = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { projectId: emptyProject.id }
    });
    expect(empty.statusCode).toBe(400);

    const notString = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { projectId: 42 }
    });
    expect(notString.statusCode).toBe(400);
  });
});

describe('跨篇会话记录来源项目快照（schema 25）', () => {
  interface CorpusSessionListItem {
    id: string;
    documentIds: string[];
    sourceProjectId: string | null;
    sourceProjectName: string | null;
    skippedDocumentIds: string[];
  }

  async function listCorpusSessions(): Promise<CorpusSessionListItem[]> {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/corpus-sessions',
      headers
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { sessions: CorpusSessionListItem[] }).sessions;
  }

  it('用 projectId 建会话：两字段落库并返回；项目改名/删除后仍是建会话时的名字', async () => {
    const projectId = makeProject('来源项目-建会话时', [documentA, documentB]);
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { projectId }
    });
    expect(created.statusCode).toBe(200);
    const session = (created.json() as { session: CorpusSessionListItem }).session;
    // 建立响应（= 服务端视图）带来源项目快照。
    expect(session.sourceProjectId).toBe(projectId);
    expect(session.sourceProjectName).toBe('来源项目-建会话时');
    // 数据层同样落库（不是只拼在响应里）。
    expect(store.getCorpusSession(session.id)).toMatchObject({
      sourceProjectId: projectId,
      sourceProjectName: '来源项目-建会话时'
    });

    // 列表也返回这两个字段（前端「来自项目 X」只读这里）。
    const listed = (await listCorpusSessions()).find((item) => item.id === session.id);
    expect(listed).toMatchObject({
      sourceProjectId: projectId,
      sourceProjectName: '来源项目-建会话时'
    });

    // 项目改名：会话仍展示建会话时的名字（快照，不联查项目表）。
    store.updateProject(projectId, { name: '来源项目-改名后' });
    expect(store.getProject(projectId)?.name).toBe('来源项目-改名后');
    expect((await listCorpusSessions()).find((item) => item.id === session.id)).toMatchObject({
      sourceProjectId: projectId,
      sourceProjectName: '来源项目-建会话时'
    });

    // 删项目：会话保留、source_project_id 悬空，name 仍是建会话时的名字；范围快照不变。
    store.deleteProject(projectId);
    expect(store.getProject(projectId)).toBeNull();
    const afterDelete = (await listCorpusSessions()).find((item) => item.id === session.id);
    expect(afterDelete).toMatchObject({
      sourceProjectId: projectId,
      sourceProjectName: '来源项目-建会话时'
    });
    expect(sorted(afterDelete!.documentIds)).toEqual(sorted([documentA, documentB]));
    expect(afterDelete!.skippedDocumentIds).toEqual([]);
  });

  it('不用 projectId 建会话：两字段为 NULL，读取正常', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/corpus-sessions',
      headers,
      payload: { documentIds: [documentA, documentC] }
    });
    expect(response.statusCode).toBe(200);
    const session = (response.json() as { session: CorpusSessionListItem }).session;
    expect(session.sourceProjectId).toBeNull();
    expect(session.sourceProjectName).toBeNull();
    expect(store.getCorpusSession(session.id)).toMatchObject({
      sourceProjectId: null,
      sourceProjectName: null
    });
    expect((await listCorpusSessions()).find((item) => item.id === session.id)).toMatchObject({
      sourceProjectId: null,
      sourceProjectName: null
    });
  });
});

describe('精读入口按项目圈范围（/chat/budget、/chat/ask）', () => {
  it('/chat/budget：projectId 解析成项目当前文献集合再估算', async () => {
    const projectId = makeProject('精读预算项目', [documentA, documentC]);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: { question: '这两篇讲了什么？', reading_scope: 'corpus', projectId }
    });
    expect(response.statusCode).toBe(200);
    const estimate = response.json() as { documents: number; pages: number };
    expect(estimate.documents).toBe(2);
    expect(estimate.pages).toBe(
      (store.getDocument(documentA)?.pages ?? 0) + (store.getDocument(documentC)?.pages ?? 0)
    );
  });

  it('/chat/budget：projectId 隐含跨文献口径（不带 reading_scope 也按项目整轮估算）', async () => {
    const projectId = makeProject('精读隐含项目', [documentA, documentC]);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      // 只给当前文献 + projectId：范围仍按项目两篇算，不能降级成单篇。
      payload: { question: '这两篇讲了什么？', documentId: documentB, projectId }
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { documents: number }).documents).toBe(2);
  });

  it('/chat/budget：互斥 400 / 不存在 404 / 空项目 400', async () => {
    const projectId = makeProject('精读预算校验项目', [documentA]);
    const both = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        reading_scope: 'corpus',
        projectId,
        scopeDocuments: [documentA]
      }
    });
    expect(both.statusCode).toBe(400);

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: { question: '这两篇讲了什么？', reading_scope: 'corpus', projectId: 'missing' }
    });
    expect(missing.statusCode).toBe(404);

    const emptyProject = store.createProject({ name: '精读空项目' });
    const empty = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        reading_scope: 'corpus',
        projectId: emptyProject.id
      }
    });
    expect(empty.statusCode).toBe(400);
  });

  it('/chat/ask：projectId 与 scope_documents 互斥 400（模型调用前就拒绝）', async () => {
    const projectId = makeProject('精读问答项目', [documentA]);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        documentId: documentB,
        reading_scope: 'corpus',
        projectId,
        scope_documents: [documentA]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(String((response.json() as { message?: string }).message)).toContain('不能同时给');

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        documentId: documentB,
        reading_scope: 'corpus',
        projectId: 'missing'
      }
    });
    expect(missing.statusCode).toBe(404);
  });
});

/**
 * 设计文档 §7 第 2 条（`applyChatProjectScope` vs `/chat/budget` 内联版本）的特征化测试。
 *
 * 两处的差异是历来的命名口径不同，**不是可由当前客户端触发的 bug**：
 * - `/chat/budget`：camel `scopeDocuments` 与 snake `scope_documents` 都收（camel 优先），
 *   两者都参与 projectId 互斥，400 文案固定写 camelCase；`scope_tags` 不参与互斥
 *   （预算估算本来就不消费标签）。
 * - `/chat/ask*`：只认 `ChatRequest` 声明的 snake `scope_documents`/`scope_tags` 判互斥，
 *   camel 命名被当未知字段忽略（不报冲突）。
 * 界面 `projectScopeAskPayload` 保证项目/手选文献/标签三选一，且 ask 只发 snake_case，
 * 因此客户端发不出"同时给 projectId 与显式范围"的请求。本组用例固化现状；
 * 若要统一命名/文案，需先确认契约与产品口径，并同步改这些断言。
 */
describe('精读入口 projectId 冲突校验：命名差异（设计文档 §7 第 2 条特征化）', () => {
  it('/chat/budget：camel/snake 两种命名都参与互斥，400 文案固定 camelCase', async () => {
    const projectId = makeProject('预算命名互斥项目', [documentA]);
    const camel = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        reading_scope: 'corpus',
        projectId,
        scopeDocuments: [documentA]
      }
    });
    expect(camel.statusCode).toBe(400);
    expect(String((camel.json() as { message?: string }).message)).toContain(
      'projectId 与 scopeDocuments 不能同时给：请二选一'
    );

    const snake = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        reading_scope: 'corpus',
        projectId,
        scope_documents: [documentA]
      }
    });
    expect(snake.statusCode).toBe(400);
    // 既有文案写的是 camel 变量名：snake 命中冲突时也回 camel 文案（改字会动返回体）。
    expect(String((snake.json() as { message?: string }).message)).toContain(
      'projectId 与 scopeDocuments 不能同时给：请二选一'
    );
  });

  it('/chat/budget：camel scopeDocuments 优先于 snake（空 camel 数组会压掉 snake）', async () => {
    const projectId = makeProject('预算命名优先级项目', [documentA]);
    const both = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        reading_scope: 'corpus',
        projectId,
        scopeDocuments: [documentA],
        scope_documents: [documentB]
      }
    });
    expect(both.statusCode).toBe(400);

    // `scopeDocumentIds` 的既有语义：camel 是数组就只看 camel，哪怕它是空数组。
    const emptyCamel = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload: {
        question: '这两篇讲了什么？',
        reading_scope: 'corpus',
        projectId,
        scopeDocuments: [],
        scope_documents: [documentB]
      }
    });
    expect(emptyCamel.statusCode).toBe(200);
    expect((emptyCamel.json() as { documents: number }).documents).toBe(1);
  });

  it('/chat/budget：projectId 与 scope_tags 不互斥（预算不消费标签），ask 侧才 400', async () => {
    const projectId = makeProject('预算标签项目', [documentA]);
    const payload = {
      question: '这两篇讲了什么？',
      reading_scope: 'corpus' as const,
      projectId,
      scope_tags: ['任意标签']
    };
    const budget = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload
    });
    expect(budget.statusCode).toBe(200);
    expect((budget.json() as { documents: number }).documents).toBe(1);

    // ask 的 scope_tags 会改变实际阅读范围，所以与 projectId 同时在就 400（模型调用前）。
    const ask = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers,
      payload: { ...payload, documentId: documentB }
    });
    expect(ask.statusCode).toBe(400);
    expect(String((ask.json() as { message?: string }).message)).toContain(
      'projectId 与 scope_tags 不能同时给：请二选一'
    );
  });

  it('/chat/ask*：camel scopeDocuments 不参与互斥（同请求 budget 400、ask 走项目解析）', async () => {
    // 项目不存在时两个入口都走不到模型：budget 先报互斥 400；ask 忽略 camel 后解析项目 → 404。
    // 这是两处差异的最小可复现形态（同一 payload，状态码不同）。
    const payload = {
      question: '这两篇讲了什么？',
      documentId: documentB,
      reading_scope: 'corpus' as const,
      projectId: 'missing-project',
      scopeDocuments: [documentA]
    };
    const budget = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/budget',
      headers,
      payload
    });
    expect(budget.statusCode).toBe(400);
    expect(String((budget.json() as { message?: string }).message)).toContain(
      'projectId 与 scopeDocuments 不能同时给：请二选一'
    );

    for (const url of ['/api/v1/chat/ask', '/api/v1/chat/ask/stream'] as const) {
      const ask = await server.inject({ method: 'POST', url, headers, payload });
      expect(ask.statusCode).toBe(404);
      expect(String((ask.json() as { message?: string }).message)).toContain('项目不存在');
    }
  });
});

describe('项目列表的 documentCount 直接复用', () => {
  it('documentCount 等于项目当前可检索/阅读的文献数，移出后同步减少', async () => {
    const projectId = makeProject('计数项目', [documentA, documentB]);
    const list = await server.inject({ method: 'GET', url: '/api/v1/projects', headers });
    expect(list.statusCode).toBe(200);
    const project = (list.json() as ProjectSummary[]).find((item) => item.id === projectId);
    expect(project?.documentCount).toBe(2);

    const scoped = await postSearch({ query: 'common', projectId });
    expect((scoped.body as ProjectSearchResult).scope.documentIds).toHaveLength(
      project!.documentCount
    );

    store.removeProjectDocument(projectId, documentB);
    const after = await server.inject({ method: 'GET', url: '/api/v1/projects', headers });
    const updated = (after.json() as ProjectSummary[]).find((item) => item.id === projectId);
    expect(updated?.documentCount).toBe(1);
  });

  it('回收站里的文献不计入 documentCount，也不在检索范围里', async () => {
    const projectId = makeProject('回收站项目', [documentC]);
    store.deleteDocument(documentC);
    try {
      const list = await server.inject({ method: 'GET', url: '/api/v1/projects', headers });
      const project = (list.json() as ProjectSummary[]).find((item) => item.id === projectId);
      expect(project?.documentCount).toBe(0);
      expect(resolveProjectScope(store, projectId)).toEqual([]);
      const scoped = await postSearch({ query: 'common', projectId });
      expect(scoped.statusCode).toBe(200);
      expect((scoped.body as ProjectSearchResult).scope.empty).toBe(true);
    } finally {
      store.restoreDocument(documentC);
    }
  });
});
