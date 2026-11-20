import { randomUUID } from 'node:crypto';
import type {
  AgentChangeAction,
  AgentChangeApplyResult,
  AgentChangeItem,
  AgentChangeItemPreview,
  AgentChangePreview,
  AgentChangeRequest,
  AgentChangeUndoResult
} from '@studianda/shared';
import type { Store } from './store.js';
import { normalizeTags } from './store/notes.js';

const MAX_ITEMS = 20;
const MAX_TEXT = 500;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('items 必须是对象数组');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} 最多 ${max} 字`);
  return trimmed;
}

/** 校验并规范化变更请求；路由与工具共用同一套边界。 */
export function normalizeChangeRequest(input: unknown): AgentChangeRequest {
  const body = asRecord(input);
  const action = body.action;
  if (action !== 'tags' && action !== 'metadata' && action !== 'folder') {
    throw new Error('action 必须是 tags / metadata / folder');
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error('items 不能为空');
  }
  if (body.items.length > MAX_ITEMS) {
    throw new Error(`单次最多 ${MAX_ITEMS} 篇文献`);
  }
  const seen = new Set<string>();
  const items: AgentChangeItem[] = [];
  for (const [index, raw] of body.items.entries()) {
    const item = asRecord(raw);
    const documentId = text(item.documentId, `items[${index}].documentId`, 200);
    if (seen.has(documentId)) throw new Error(`items 里重复的文献：${documentId}`);
    seen.add(documentId);
    if (action === 'tags') {
      if (!Array.isArray(item.tags)) throw new Error(`items[${index}].tags 必须是数组`);
      items.push({ documentId, tags: normalizeTags(item.tags) });
    } else if (action === 'metadata') {
      const metadata = asRecord(item.metadata);
      const patch: NonNullable<AgentChangeItem['metadata']> = {};
      if (metadata.name !== undefined) {
        const name = text(metadata.name, `items[${index}].metadata.name`, 300);
        if (!name) throw new Error(`items[${index}].metadata.name 不能为空`);
        patch.name = name;
      }
      if (metadata.author !== undefined) {
        patch.author = text(metadata.author, `items[${index}].metadata.author`);
      }
      if (metadata.docType !== undefined) {
        patch.docType = text(metadata.docType, `items[${index}].metadata.docType`, 100);
      }
      if (Object.keys(patch).length === 0) {
        throw new Error(`items[${index}].metadata 至少需要一个字段`);
      }
      items.push({ documentId, metadata: patch });
    } else {
      const folderId =
        item.folderId === undefined ? '' : text(item.folderId, `items[${index}].folderId`, 200);
      items.push({ documentId, folderId });
    }
  }
  return { action, items };
}

function folderExists(store: Store, folderId: string): boolean {
  if (!folderId) return true;
  return store.listFolders().folders.some((folder) => folder.id === folderId);
}

/** 计算 before/after，不写库。 */
export function previewChanges(store: Store, input: unknown): AgentChangePreview {
  const request = normalizeChangeRequest(input);
  const items: AgentChangeItemPreview[] = [];
  for (const item of request.items) {
    const document = store.getDocument(item.documentId);
    if (!document) throw new Error(`文献不存在：${item.documentId}`);
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    if (request.action === 'tags') {
      before = { tags: document.tags };
      after = { tags: item.tags ?? [] };
    } else if (request.action === 'metadata') {
      before = {
        name: document.name,
        author: document.author,
        docType: document.docType ?? ''
      };
      after = { ...before, ...(item.metadata ?? {}) };
    } else {
      const folderId = item.folderId ?? '';
      if (!folderExists(store, folderId)) throw new Error(`文件夹不存在：${folderId}`);
      before = { folderId: document.folderId ?? '' };
      after = { folderId };
    }
    items.push({
      documentId: document.id,
      documentName: document.name,
      before,
      after,
      changed: JSON.stringify(before) !== JSON.stringify(after)
    });
  }
  const changed = items.filter((item) => item.changed).length;
  return {
    action: request.action,
    items,
    changed,
    requiresReview: changed > 10
  };
}

function applyOne(store: Store, action: AgentChangeAction, item: AgentChangeItem): void {
  if (action === 'tags') {
    store.setDocumentTags(item.documentId, item.tags ?? []);
    return;
  }
  if (action === 'folder') {
    store.updateDocument(item.documentId, { folderId: item.folderId ?? '' });
    return;
  }
  const patch = item.metadata ?? {};
  store.updateDocument(item.documentId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.author !== undefined ? { author: patch.author } : {}),
    ...(patch.docType !== undefined ? { docType: patch.docType } : {})
  });
}

export function applyChanges(
  store: Store,
  input: unknown,
  agentName: string
): AgentChangeApplyResult {
  const preview = previewChanges(store, input);
  const request = normalizeChangeRequest(input);
  const changed = preview.items.filter((item) => item.changed);
  if (changed.length === 0) {
    return { action: request.action, operationId: '', applied: 0, items: preview.items };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const before = changed.map((item) => ({ documentId: item.documentId, ...item.before }));
  const after = changed.map((item) => ({ documentId: item.documentId, ...item.after }));
  store.withTransaction(() => {
    for (const item of request.items) {
      if (!changed.some((entry) => entry.documentId === item.documentId)) continue;
      applyOne(store, request.action, item);
    }
    store.insertAgentOperation({
      id,
      agentName,
      tool: 'organize',
      action: request.action,
      requestJson: JSON.stringify(request),
      resultJson: JSON.stringify({ applied: changed.length }),
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
      created: now
    });
  });
  return { action: request.action, operationId: id, applied: changed.length, items: preview.items };
}

/** 撤销一次 apply：按 before 快照恢复；只能撤销一次。 */
export function undoChanges(store: Store, operationId: string): AgentChangeUndoResult {
  const operation = store.getAgentOperation(operationId);
  if (!operation) throw new Error('变更记录不存在');
  if (operation.status !== 'applied') throw new Error(`变更状态为 ${operation.status}，不能撤销`);
  if (operation.action !== 'tags' && operation.action !== 'metadata' && operation.action !== 'folder') {
    throw new Error(`不支持的变更类型：${operation.action}`);
  }
  let before: Array<Record<string, unknown>>;
  try {
    before = JSON.parse(operation.before_json) as Array<Record<string, unknown>>;
  } catch {
    throw new Error('变更快照损坏，无法撤销');
  }
  if (!Array.isArray(before)) throw new Error('变更快照损坏，无法撤销');
  const now = new Date().toISOString();
  store.withTransaction(() => {
    for (const entry of before) {
      const documentId = String(entry.documentId ?? '');
      if (!documentId) continue;
      if (operation.action === 'tags') {
        store.setDocumentTags(documentId, Array.isArray(entry.tags) ? (entry.tags as string[]) : []);
      } else if (operation.action === 'folder') {
        store.updateDocument(documentId, { folderId: String(entry.folderId ?? '') });
      } else {
        store.updateDocument(documentId, {
          name: String(entry.name ?? ''),
          author: String(entry.author ?? ''),
          docType: String(entry.docType ?? '')
        });
      }
    }
    store.markAgentOperationUndone(operationId, now);
  });
  return { operationId, restored: before.length };
}
