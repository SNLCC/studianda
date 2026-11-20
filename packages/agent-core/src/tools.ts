/** 只读工具的执行层：一个实现，两个适配器（MCP bridge / DSH Host）共用。 */

export interface CoreApi {
  request<T>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T>;
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

export interface ToolSpec {
  name: string;
  description: string;
  actions: string[];
}

const IMPLEMENTED_ACTIONS: Record<string, string[]> = {
  scope: ['get'],
  capabilities: ['list'],
  library: ['list', 'get', 'pages', 'outline', 'references'],
  notes: ['list', 'list_for_document', 'create'],
  annotations: ['list_for_document', 'create'],
  organize: ['preview', 'apply', 'undo'],
  reading: ['sessions', 'tasks', 'summary'],
  system: ['health']
};

export function toolSpecs(): ToolSpec[] {
  const defs: Array<[string, string]> = [
    ['scope', '查看当前共享范围（只读）。'],
    ['capabilities', '列出当前可用的只读能力（op / action / 说明）。'],
    ['library', '文献与结构：list / get / pages / outline / references。'],
    ['notes', '笔记：list（独立笔记）/ list_for_document / create（写 AI 笔记，需要写入范围）。'],
    ['annotations', '批注：list_for_document / create（写 AI 批注，需要写入范围）。'],
    ['organize', '整理（可撤销）：preview（dry-run）/ apply / undo；需要允许写入的共享范围。'],
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
    throw new Error(`annotations 不支持 action=${action}`);
  }

  if (name === 'organize') {
    const hasWrite = scope.kind !== 'none' && (scope.caps ?? []).includes('write');
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
