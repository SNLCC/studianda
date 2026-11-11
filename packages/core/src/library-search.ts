import { markdownPlainText } from '@studianda/shared';
import type { LibrarySearchHit, LibrarySearchKind } from '@studianda/shared';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';

const LIMIT = 60;

export function searchLibrary(
  store: Store,
  _secrets: SecretStore,
  query: string,
  kinds: LibrarySearchKind[]
): LibrarySearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const selected = new Set(kinds.length > 0 ? kinds : ['document', 'annotation', 'note', 'chunk']);
  const documents = store.listDocuments(false);
  const results: LibrarySearchHit[] = [];
  const matches = (text: string): boolean => text.toLowerCase().includes(needle);

  if (selected.has('document')) {
    for (const document of documents) {
      const haystack = `${document.name}\n${document.author}`;
      if (!matches(haystack)) continue;
      results.push({
        kind: 'document',
        id: document.id,
        documentId: document.id,
        documentName: document.name,
        title: document.name,
        snippet: document.author
      });
    }
  }

  if (selected.has('tag')) {
    for (const document of documents) {
      const tags = document.tags.join(' ');
      if (!matches(tags)) continue;
      results.push({
        kind: 'tag',
        id: document.id,
        documentId: document.id,
        documentName: document.name,
        title: document.name,
        snippet: document.tags.join('、')
      });
    }
  }

  for (const document of documents) {
    if (selected.has('annotation')) {
      for (const annotation of store.listAnnotations(document.id)) {
        // 批注正文是 Markdown：匹配与摘要都用纯文本，避免 `**`、`#` 等标记进入搜索；
        // quote 是 PDF 原文，保持原样。
        const comment = markdownPlainText(annotation.content);
        if (!matches(`${annotation.quote}\n${comment}`)) continue;
        results.push({
          kind: 'annotation',
          id: annotation.id,
          documentId: document.id,
          documentName: document.name,
          page: annotation.page,
          title: `批注 · 第 ${annotation.page} 页`,
          snippet: `${annotation.quote}${comment ? `\n批注：${comment}` : ''}`
        });
      }
    }
    if (selected.has('note')) {
      for (const note of store.listNotes(document.id)) {
        const text = markdownPlainText(note.content);
        if (!matches(text)) continue;
        results.push({
          kind: 'note',
          id: note.id,
          documentId: document.id,
          documentName: document.name,
          page: note.page,
          title: `笔记 · 第 ${note.page} 页`,
          snippet: text
        });
      }
    }
  }

  if (selected.has('chunk')) {
    for (const hit of store.search(query, undefined, LIMIT)) {
      if (hit.warning) continue;
      results.push({
        kind: 'chunk',
        id: hit.chunkId,
        documentId: hit.documentId,
        documentName: hit.documentName,
        page: hit.page,
        title: hit.documentName,
        snippet: hit.snippet,
        // 命中行/译文/派生标记要透传给界面：否则前端只能显示片段，命中词无法标出、
        // 译文命中也会被当成原文（如实区分来源比"看起来一样"重要）。
        ...(hit.match ? { match: hit.match } : {}),
        ...(hit.translation ? { translation: true } : {}),
        ...(hit.derived ? { derived: true } : {})
      });
    }
  }
  return results.slice(0, LIMIT);
}

/**
 * 命中检索条件的文献 id（按文献列表顺序返回，不按命中段落截断）。
 *
 * 文献工作台的搜索是"过滤下方文献列表"，不是展示命中段落面板；因此这里只回答
 * "哪些文献符合"，并对标题/作者、标签、批注、笔记做与 `searchLibrary` 同口径的匹配，
 * 正文命中交给 `Store.matchDocumentIds` 做整库去重查询。
 */
export function searchLibraryDocuments(
  store: Store,
  _secrets: SecretStore,
  query: string,
  kinds: LibrarySearchKind[]
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const selected = new Set(kinds.length > 0 ? kinds : ['document', 'tag', 'annotation', 'note', 'chunk']);
  const matches = (text: string): boolean => text.toLowerCase().includes(needle);
  const chunkMatched = selected.has('chunk') ? new Set(store.matchDocumentIds(query)) : null;

  return store
    .listDocuments(false)
    .filter((document) => {
      if (selected.has('document') && matches(`${document.name}\n${document.author}`)) return true;
      if (selected.has('tag') && matches(document.tags.join(' '))) return true;
      if (
        selected.has('annotation') &&
        store
          .listAnnotations(document.id)
          .some((annotation) =>
            matches(`${annotation.quote}\n${markdownPlainText(annotation.content)}`)
          )
      ) {
        return true;
      }
      if (
        selected.has('note') &&
        store
          .listNotes(document.id)
          .some((note) => matches(markdownPlainText(note.content)))
      ) {
        return true;
      }
      return chunkMatched?.has(document.id) === true;
    })
    .map((document) => document.id);
}
