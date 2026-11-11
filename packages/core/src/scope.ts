export interface ScopeDocument {
  id: string;
  tags: string[];
}

export interface ScopeRequest {
  documentId: string;
  crossBook?: boolean;
  scope?: 'all' | 'tags' | 'documents';
  scopeTags?: string[];
  scopeDocuments?: string[];
}

/** 文献范围：当前文献始终在范围内；空范围直接报错。 */
export function resolveScopeIds(
  documents: ScopeDocument[],
  request: ScopeRequest
): string[] {
  if (!request.crossBook) return [request.documentId];
  let ids: string[];
  const scope = request.scope ?? 'all';
  if (scope === 'all') {
    ids = documents.map((document) => document.id);
  } else if (scope === 'tags') {
    const tags = new Set(request.scopeTags ?? []);
    ids = documents
      .filter((document) => document.tags.some((tag) => tags.has(tag)))
      .map((document) => document.id);
  } else {
    const selected = new Set(request.scopeDocuments ?? []);
    ids = documents
      .filter((document) => selected.has(document.id))
      .map((document) => document.id);
  }
  if (ids.length === 0) throw new Error('所选跨文献范围为空，请选择标签或文献');
  if (!ids.includes(request.documentId)) ids.push(request.documentId);
  return ids;
}
