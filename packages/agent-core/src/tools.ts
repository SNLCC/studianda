/** 只读工具的执行层：一个实现，两个适配器（MCP bridge / DSH Host）共用。 */

export interface CoreApi {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    pathname: string,
    body?: unknown
  ): Promise<T>;
}

export type AgentScope =
  | { kind: 'none' }
  | { kind: 'library'; caps?: string[] }
  | { kind: 'documents'; documentIds: string[]; caps?: string[] };

export class ScopeError extends Error {
  constructor(
    readonly code: 'scope_missing' | 'scope_denied',
    message: string
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** P0 用环境变量表达共享范围；正式版由应用写入 scope 表/工单。 */
export function scopeFromEnv(value: string | undefined): AgentScope {
  const raw = value?.trim();
  if (!raw) return { kind: 'none' };
  if (raw === 'library') return { kind: 'library', caps: ['read'] };
  if (raw.startsWith('document:')) {
    const ids = raw
      .slice('document:'.length)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.length > 0 ? { kind: 'documents', documentIds: ids, caps: ['read'] } : { kind: 'none' };
  }
  return { kind: 'none' };
}

export function assertDocumentAllowed(scope: AgentScope, documentId: string): void {
  if (scope.kind === 'library') return;
  if (scope.kind === 'documents' && scope.documentIds.includes(documentId)) return;
  throw new ScopeError(
    'scope_denied',
    scope.kind === 'none'
      ? '当前没有共享范围；请先在勘读里共享这篇文献，或设置 STUDIANDA_AGENT_SCOPE=library。'
      : `文献 ${documentId} 不在共享范围内。`
  );
}

/** 写入（笔记/批注/整理）要求用户在工作台勾选「允许整理」。 */
export function assertWriteAllowed(scope: AgentScope, message: string): void {
  if (scope.kind === 'none' || !(scope.caps ?? []).includes('write')) {
    throw new ScopeError('scope_denied', message);
  }
}

function requireLibraryScope(scope: AgentScope, message: string): void {
  if (scope.kind !== 'library') throw new ScopeError('scope_denied', message);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} 必须是非空字符串数组`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

async function assertNoteBelongs(
  api: CoreApi,
  documentId: string,
  noteId: string,
  trash: boolean
): Promise<void> {
  const path = `/documents/${encodeURIComponent(documentId)}/notes${trash ? '?trash=true' : ''}`;
  const rows = await api.request<Array<{ id?: unknown }>>('GET', path);
  if (!Array.isArray(rows) || !rows.some((row) => row.id === noteId)) {
    throw new Error(trash ? '回收站里没有这条笔记' : '这条笔记不在该文献下');
  }
}

async function assertAnnotationBelongs(
  api: CoreApi,
  documentId: string,
  annotationId: string,
  trash: boolean
): Promise<void> {
  const path = `/documents/${encodeURIComponent(documentId)}/annotations${trash ? '?trash=true' : ''}`;
  const rows = await api.request<Array<{ id?: unknown }>>('GET', path);
  if (!Array.isArray(rows) || !rows.some((row) => row.id === annotationId)) {
    throw new Error(trash ? '回收站里没有这条批注' : '这条批注不在该文献下');
  }
}

export interface ToolSpec {
  name: string;
  description: string;
  actions: string[];
}

const IMPLEMENTED_ACTIONS: Record<string, string[]> = {
  scope: ['get'],
  capabilities: ['list'],
  library: ['list', 'get', 'search', 'pages', 'outline', 'references'],
  notes: ['list', 'list_for_document', 'create', 'update', 'set_tags', 'delete', 'restore'],
  annotations: ['list_for_document', 'create', 'update', 'delete', 'restore'],
  organize: [
    'preview',
    'apply',
    'undo',
    'folders',
    'folder_create',
    'folder_rename',
    'folder_delete',
    'projects',
    'project_create',
    'project_update',
    'project_delete',
    'project_documents',
    'project_add_documents',
    'project_remove_documents',
    'reorder_documents',
    'trash_document',
    'restore_document'
  ],
  compute: ['start', 'status', 'cancel'],
  reading: ['sessions', 'tasks', 'summary'],
  system: ['health']
};

export function toolSpecs(): ToolSpec[] {
  const defs: Array<[string, string]> = [
    ['scope', '查看当前共享范围（只读）。'],
    ['capabilities', '列出当前可用的只读能力（op / action / 说明）。'],
    ['library', '文献、检索与结构：list / get / search / pages / outline / references。'],
    ['notes', '笔记全生命周期：list / list_for_document / create / update / set_tags / delete / restore（写入需允许整理）。'],
    ['annotations', '批注：list_for_document / create / update / delete / restore（写入需允许整理）。'],
    ['organize', '整理与撤销：preview / apply / undo（标签/题录/文件夹）+ folders / projects / 排序 / 回收站；写操作需允许整理。'],
    ['compute', '长任务：start / status / cancel；kind=summary（全书摘要）或 translate（整篇翻译）。'],
    ['reading', '阅读会话：sessions / tasks / summary。'],
    ['system', '系统状态：health。']
  ];
  return defs.map(([name, description]) => ({
    name,
    description,
    actions: IMPLEMENTED_ACTIONS[name] ?? []
  }));
}

interface ToolArgs {
  action?: unknown;
  document_id?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
  kind?: unknown;
  items?: unknown;
  operation_id?: unknown;
  page?: unknown;
  quote?: unknown;
  content?: unknown;
  color?: unknown;
  style?: unknown;
  note_id?: unknown;
  annotation_id?: unknown;
  query?: unknown;
  types?: unknown;
  tags?: unknown;
  folder_path?: unknown;
  folder_id?: unknown;
  folder_name?: unknown;
  project_id?: unknown;
  project_name?: unknown;
  description?: unknown;
  before_id?: unknown;
  after_id?: unknown;
  document_ids?: unknown;
  archived?: unknown;
  pages?: unknown;
  language?: unknown;
  force?: unknown;
  job_id?: unknown;
}

const MAX_PAGES = 8;
const MAX_LIST = 50;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} 必须是 ${min}–${max} 的整数`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown, field: string, max = 500): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  return value.slice(0, max);
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
  context: { scope: AgentScope; api: CoreApi; agentName?: string }
): Promise<unknown> {
  const args = asRecord(rawArgs) as ToolArgs;
  const action = typeof args.action === 'string' ? args.action : '';
  const { scope, api } = context;

  if (name === 'scope') {
    if (action !== 'get') throw new Error(`scope 不支持 action=${action}`);
    return { scope };
  }

  if (name === 'capabilities') {
    if (action !== 'list') throw new Error(`capabilities 不支持 action=${action}`);
    return {
      scope,
      tools: toolSpecs().map((tool) => ({ name: tool.name, actions: tool.actions }))
    };
  }

  if (name === 'library') {
    const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
    if (action === 'list') {
      const limit = optionalInt(args.limit, 'limit', 1, MAX_LIST) ?? 20;
      const rows = await api.request<Array<Record<string, unknown>>>('GET', '/documents');
      const allowed =
        scope.kind === 'library'
          ? rows
          : scope.kind === 'documents'
            ? rows.filter((row) => scope.documentIds.includes(String(row.id)))
            : rows;
      const documents = allowed.slice(0, limit).map((row) =>
        scope.kind === 'none'
          ? { id: row.id, name: row.name }
          : { id: row.id, name: row.name, pages: row.pages, tags: row.tags }
      );
      return {
        documents,
        ...(allowed.length > documents.length
          ? { truncation: `共 ${allowed.length} 篇，本次返回 ${documents.length} 篇` }
          : {}),
        ...(scope.kind === 'none' ? { note: '未共享范围，只返回标题；共享后可读正文与元数据。' } : {})
      };
    }
    if (action === 'search') {
      if (scope.kind === 'none') {
        throw new ScopeError('scope_denied', '检索需要先共享文献或全库范围。');
      }
      const query = requireString(args.query, 'query');
      const limit = optionalInt(args.limit, 'limit', 1, MAX_LIST) ?? 20;
      const types = optionalString(args.types, 'types', 100);
      const pathname = `/library-search?q=${encodeURIComponent(query)}${
        types ? `&types=${encodeURIComponent(types)}` : ''
      }`;
      const rows = await api.request<Array<Record<string, unknown>>>('GET', pathname);
      const allowed =
        scope.kind === 'documents' ? new Set(scope.documentIds) : null;
      const hits = (Array.isArray(rows) ? rows : []).filter((hit) => {
        if (!allowed) return true;
        const documentId = typeof hit.documentId === 'string' ? hit.documentId : '';
        return allowed.has(documentId);
      });
      return {
        query,
        hits: hits.slice(0, limit),
        ...(hits.length > limit ? { truncation: `共 ${hits.length} 条，本次返回 ${limit} 条` } : {})
      };
    }
    if (!documentId) throw new Error('该 action 需要 document_id');
    assertDocumentAllowed(scope, documentId);
    if (action === 'get') {
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}`);
    }
    if (action === 'outline') {
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/outline`);
    }
    if (action === 'references') {
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/references`);
    }
    if (action === 'pages') {
      const from = optionalInt(args.from, 'from', 1, 100000);
      const to = optionalInt(args.to, 'to', 1, 100000);
      if (from == null) throw new Error('pages 需要 from');
      const end = to ?? from;
      if (end < from) throw new Error('to 不能小于 from');
      if (end - from + 1 > MAX_PAGES) throw new Error(`单次最多 ${MAX_PAGES} 页`);
      const pages: Array<{ page: number; text: string; origin?: string }> = [];
      for (let page = from; page <= end; page += 1) {
        const row = await api.request<{ page: number; text: string; origin?: string }>(
          'GET',
          `/documents/${encodeURIComponent(documentId)}/pages/${page}/text`
        );
        pages.push({ page: row.page, text: row.text, origin: row.origin });
      }
      return { document_id: documentId, pages };
    }
    throw new Error(`library 不支持 action=${action}`);
  }

  if (name === 'notes') {
    if (action === 'list') {
      if (scope.kind !== 'library') throw new ScopeError('scope_denied', '独立笔记列表需要 library 范围');
      return api.request('GET', '/notes/standalone');
    }
    if (action === 'list_for_document') {
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/notes`);
    }
    if (action === 'create') {
      assertWriteAllowed(scope, '写笔记需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const content = requireString(args.content, 'content');
      const page = optionalInt(args.page, 'page', 0, 100000) ?? 0;
      return api.request('POST', '/notes', {
        documentId,
        page,
        quote: optionalString(args.quote, 'quote', 2000) ?? '',
        content,
        origin: 'ai',
        agentName: context.agentName ?? 'agent'
      });
    }
    if (action === 'update') {
      assertWriteAllowed(scope, '更新笔记需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const noteId = requireString(args.note_id, 'note_id');
      await assertNoteBelongs(api, documentId, noteId, false);
      const patch: Record<string, unknown> = {};
      if (args.content !== undefined) patch.content = requireString(args.content, 'content');
      if (args.quote !== undefined) patch.quote = optionalString(args.quote, 'quote', 2000) ?? '';
      if (args.page !== undefined) patch.page = optionalInt(args.page, 'page', 0, 100000);
      if (args.folder_path !== undefined) {
        patch.folderPath = optionalString(args.folder_path, 'folder_path', 240) ?? '';
      }
      if (Object.keys(patch).length === 0) throw new Error('update 至少需要一个字段');
      return api.request('PATCH', `/notes/${encodeURIComponent(noteId)}`, patch);
    }
    if (action === 'set_tags') {
      assertWriteAllowed(scope, '改笔记标签需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const noteId = requireString(args.note_id, 'note_id');
      await assertNoteBelongs(api, documentId, noteId, false);
      if (!Array.isArray(args.tags) || !args.tags.every((tag) => typeof tag === 'string')) {
        throw new Error('tags 必须是字符串数组');
      }
      return api.request('PUT', `/notes/${encodeURIComponent(noteId)}/tags`, {
        tags: args.tags
      });
    }
    if (action === 'delete') {
      assertWriteAllowed(scope, '删除笔记需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const noteId = requireString(args.note_id, 'note_id');
      await assertNoteBelongs(api, documentId, noteId, false);
      await api.request('DELETE', `/notes/${encodeURIComponent(noteId)}`);
      return { ok: true, noteId, deleted: true };
    }
    if (action === 'restore') {
      assertWriteAllowed(scope, '恢复笔记需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const noteId = requireString(args.note_id, 'note_id');
      await assertNoteBelongs(api, documentId, noteId, true);
      return api.request('POST', `/notes/${encodeURIComponent(noteId)}/restore`);
    }
    throw new Error(`notes 不支持 action=${action}`);
  }

  if (name === 'annotations') {
    if (action === 'list_for_document') {
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/annotations`);
    }
    if (action === 'create') {
      assertWriteAllowed(scope, '写批注需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const page = optionalInt(args.page, 'page', 1, 100000);
      if (page == null) throw new Error('写批注需要 page');
      const content = requireString(args.content, 'content');
      return api.request('POST', '/annotations', {
        documentId,
        page,
        quote: optionalString(args.quote, 'quote', 2000) ?? '',
        content,
        color: optionalString(args.color, 'color', 20) ?? 'yellow',
        style: optionalString(args.style, 'style', 20) ?? 'highlight',
        origin: 'ai',
        agentName: context.agentName ?? 'agent'
      });
    }
    if (action === 'update') {
      assertWriteAllowed(scope, '更新批注需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const annotationId = requireString(args.annotation_id, 'annotation_id');
      await assertAnnotationBelongs(api, documentId, annotationId, false);
      const patch: Record<string, unknown> = {};
      if (args.content !== undefined) patch.content = requireString(args.content, 'content');
      if (args.color !== undefined) patch.color = optionalString(args.color, 'color', 20);
      if (args.style !== undefined) patch.style = optionalString(args.style, 'style', 20);
      if (Object.keys(patch).length === 0) throw new Error('update 至少需要一个字段');
      return api.request('PATCH', `/annotations/${encodeURIComponent(annotationId)}`, patch);
    }
    if (action === 'delete') {
      assertWriteAllowed(scope, '删除批注需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const annotationId = requireString(args.annotation_id, 'annotation_id');
      await assertAnnotationBelongs(api, documentId, annotationId, false);
      await api.request('DELETE', `/annotations/${encodeURIComponent(annotationId)}`);
      return { ok: true, annotationId, deleted: true };
    }
    if (action === 'restore') {
      assertWriteAllowed(scope, '恢复批注需要在共享范围里勾选「允许整理」。');
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const annotationId = requireString(args.annotation_id, 'annotation_id');
      await assertAnnotationBelongs(api, documentId, annotationId, true);
      return api.request('POST', `/annotations/${encodeURIComponent(annotationId)}/restore`);
    }
    throw new Error(`annotations 不支持 action=${action}`);
  }

  if (name === 'organize') {
    const hasWrite = scope.kind !== 'none' && (scope.caps ?? []).includes('write');
    const writeMessage = '该整理操作需要在共享范围里勾选「允许整理」。';

    if (action === 'folders') {
      requireLibraryScope(scope, '文件夹列表需要全库范围。');
      return api.request('GET', '/folders');
    }
    if (action === 'folder_create' || action === 'folder_rename' || action === 'folder_delete') {
      assertWriteAllowed(scope, writeMessage);
      requireLibraryScope(scope, '文件夹管理需要全库范围。');
      const name = optionalString(args.folder_name, 'folder_name', 60);
      if (action === 'folder_create') {
        if (!name) throw new Error('folder_create 需要 folder_name');
        return api.request('POST', '/folders', { name });
      }
      const folderId = requireString(args.folder_id, 'folder_id');
      if (action === 'folder_rename') {
        if (!name) throw new Error('folder_rename 需要 folder_name');
        return api.request('PATCH', `/folders/${encodeURIComponent(folderId)}`, { name });
      }
      return api.request('DELETE', `/folders/${encodeURIComponent(folderId)}`);
    }

    if (action === 'projects') {
      requireLibraryScope(scope, '项目列表需要全库范围。');
      return api.request('GET', '/projects');
    }
    if (action === 'project_create') {
      assertWriteAllowed(scope, writeMessage);
      requireLibraryScope(scope, '项目管理需要全库范围。');
      const name = requireString(args.project_name, 'project_name');
      return api.request('POST', '/projects', {
        name,
        ...(args.description !== undefined
          ? { description: optionalString(args.description, 'description', 500) ?? '' }
          : {})
      });
    }
    if (action === 'project_update') {
      assertWriteAllowed(scope, writeMessage);
      requireLibraryScope(scope, '项目管理需要全库范围。');
      const projectId = requireString(args.project_id, 'project_id');
      const patch: Record<string, unknown> = {};
      if (args.project_name !== undefined) {
        patch.name = requireString(args.project_name, 'project_name');
      }
      if (args.description !== undefined) {
        patch.description = optionalString(args.description, 'description', 500) ?? '';
      }
      if (args.archived !== undefined) {
        if (typeof args.archived !== 'boolean') throw new Error('archived 必须是布尔值');
        patch.archived = args.archived;
      }
      if (Object.keys(patch).length === 0) throw new Error('project_update 至少需要一个字段');
      return api.request('PATCH', `/projects/${encodeURIComponent(projectId)}`, patch);
    }
    if (action === 'project_delete') {
      assertWriteAllowed(scope, writeMessage);
      requireLibraryScope(scope, '项目管理需要全库范围。');
      const projectId = requireString(args.project_id, 'project_id');
      return api.request('DELETE', `/projects/${encodeURIComponent(projectId)}`);
    }
    if (action === 'project_documents') {
      requireLibraryScope(scope, '项目文献列表需要全库范围。');
      const projectId = requireString(args.project_id, 'project_id');
      return api.request('GET', `/projects/${encodeURIComponent(projectId)}/documents`);
    }
    if (action === 'project_add_documents' || action === 'project_remove_documents') {
      assertWriteAllowed(scope, writeMessage);
      const projectId = requireString(args.project_id, 'project_id');
      const documentIds = requireStringArray(args.document_ids, 'document_ids');
      for (const documentId of documentIds) assertDocumentAllowed(scope, documentId);
      const results: unknown[] = [];
      let changed = 0;
      for (const documentId of documentIds) {
        try {
          const result =
            action === 'project_add_documents'
              ? await api.request('POST', `/projects/${encodeURIComponent(projectId)}/documents`, {
                  documentId
                })
              : await api.request(
                  'DELETE',
                  `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`
                );
          changed += 1;
          results.push({ documentId, ok: true, result });
        } catch (error) {
          results.push({
            documentId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return { projectId, changed, results };
    }

    if (action === 'reorder_documents') {
      assertWriteAllowed(scope, writeMessage);
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      const beforeId = optionalString(args.before_id, 'before_id', 200) ?? null;
      const afterId = optionalString(args.after_id, 'after_id', 200) ?? null;
      if (beforeId && afterId) throw new Error('before_id 与 after_id 只能给一个');
      return api.request('POST', `/documents/${encodeURIComponent(documentId)}/move`, {
        beforeId,
        afterId
      });
    }
    if (action === 'trash_document' || action === 'restore_document') {
      assertWriteAllowed(scope, writeMessage);
      const documentId = requireString(args.document_id, 'document_id');
      assertDocumentAllowed(scope, documentId);
      if (action === 'trash_document') {
        return api.request('DELETE', `/documents/${encodeURIComponent(documentId)}`);
      }
      return api.request('POST', `/documents/${encodeURIComponent(documentId)}/restore`);
    }

    if (action !== 'preview' && action !== 'apply' && action !== 'undo') {
      throw new Error(`organize 不支持 action=${action}`);
    }
    if (action === 'undo') {
      if (!hasWrite) {
        throw new ScopeError('scope_denied', '撤销变更需要新的共享范围，并勾选「允许整理」。');
      }
      const operationId = requireString(args.operation_id, 'operation_id');
      return api.request('POST', '/agent/changes/undo', { operationId });
    }
    const kind = args.kind;
    if (kind !== 'tags' && kind !== 'metadata' && kind !== 'folder') {
      throw new Error('kind 必须是 tags / metadata / folder');
    }
    if (!Array.isArray(args.items) || args.items.length === 0) {
      throw new Error('items 不能为空');
    }
    const items = args.items.map((raw, index) => {
      const item = asRecord(raw);
      const documentId = requireString(item.documentId, `items[${index}].documentId`);
      return { ...item, documentId };
    });
    for (const item of items) assertDocumentAllowed(scope, item.documentId);
    if (action === 'apply' && !hasWrite) {
      throw new ScopeError('scope_denied', '应用变更需要在共享范围里勾选「允许整理」。');
    }
    return api.request('POST', `/agent/changes/${action}`, {
      action: kind,
      items,
      agentName: context.agentName ?? 'agent'
    });
  }

  if (name === 'compute') {
    const kind = args.kind;
    if (kind !== 'summary' && kind !== 'translate') {
      throw new Error('compute.kind 必须是 summary / translate');
    }
    const documentId = requireString(args.document_id, 'document_id');
    assertDocumentAllowed(scope, documentId);
    const encoded = encodeURIComponent(documentId);
    if (action === 'status') {
      if (kind === 'summary') {
        return api.request('GET', `/documents/${encoded}/book-summary`);
      }
      return api.request('GET', `/documents/${encoded}/translation/progress`);
    }
    if (action !== 'start' && action !== 'cancel') {
      throw new Error(`compute 不支持 action=${action}`);
    }
    assertWriteAllowed(scope, '启动/取消生成任务需要在共享范围里勾选「允许整理」。');
    if (kind === 'summary') {
      if (action === 'start') {
        return api.request('POST', `/documents/${encoded}/book-summary/start`, {});
      }
      return api.request('POST', `/documents/${encoded}/book-summary/cancel`, {});
    }
    if (action === 'start') {
      let pages: number[] | undefined;
      if (args.pages !== undefined) {
        if (!Array.isArray(args.pages) || !args.pages.every((page) => Number.isInteger(page))) {
          throw new Error('pages 必须是整数数组');
        }
        pages = args.pages as number[];
      }
      return api.request('POST', `/documents/${encoded}/translation`, {
        ...(pages ? { pages } : {}),
        ...(args.language !== undefined
          ? { language: optionalString(args.language, 'language', 20) }
          : {}),
        force: args.force === true
      });
    }
    return api.request('POST', `/documents/${encoded}/translation/stop`, {});
  }

  if (name === 'reading') {
    const documentId = requireString(args.document_id, 'document_id');
    assertDocumentAllowed(scope, documentId);
    if (action === 'sessions') {
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/chat-sessions`);
    }
    if (action === 'tasks') {
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/reading-tasks`);
    }
    if (action === 'summary') {
      return api.request('GET', `/documents/${encodeURIComponent(documentId)}/book-summary`);
    }
    throw new Error(`reading 不支持 action=${action}`);
  }

  if (name === 'system') {
    if (action !== 'health') throw new Error(`system 不支持 action=${action}`);
    return api.request('GET', '/health');
  }

  throw new Error(`未知工具：${name}`);
}
