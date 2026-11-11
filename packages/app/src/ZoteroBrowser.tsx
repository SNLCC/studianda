import { appDialogs } from './dialogs.js';
import { ApiRequestError, type ApiClient } from '@studianda/api-client';
import { API_ERROR_CODES, type DocumentDetail, type ZoteroItem } from '@studianda/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type JSX } from 'react';

/** 每页 25 条。 */
const PAGE_SIZE = 25;

export function ZoteroBrowser({
  api,
  onOpen
}: {
  api: ApiClient;
  onOpen(document: DocumentDetail): void;
}): JSX.Element {
  const configQuery = useQuery({ queryKey: ['zotero-config'], queryFn: () => api.getZoteroConfig() });
  const collectionsQuery = useQuery({
    queryKey: ['zotero-collections'],
    queryFn: () => api.listZoteroCollections(),
    enabled: Boolean(configQuery.data)
  });
  const [collection, setCollection] = useState('');
  const [searchInput, setSearchInput] = useState('');
  // 真正发给服务端的 Zotero 快速搜索词（qmode=titleCreatorYear：标题/作者/年份）。
  const [query, setQuery] = useState('');
  const [start, setStart] = useState(0);
  const [loaded, setLoaded] = useState<ZoteroItem[]>([]);
  useEffect(() => {
    setStart(0);
    setLoaded([]);
  }, [collection, query]);
  const itemsQuery = useQuery({
    queryKey: ['zotero-items', collection, query, start],
    queryFn: () =>
      api.listZoteroItems(collection || undefined, start, query || undefined),
    enabled: Boolean(configQuery.data)
  });
  useEffect(() => {
    if (!itemsQuery.data) return;
    setLoaded((current) => (start === 0 ? itemsQuery.data : [...current, ...itemsQuery.data]));
  }, [itemsQuery.data, start]);
  const diagnose = useMutation({ mutationFn: () => api.diagnoseZotero() });
  const applySearch = (value: string): void => {
    setStart(0);
    setLoaded([]);
    setQuery(value.trim());
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    applySearch(searchInput);
  };
  const open = useMutation({
    mutationFn: async (itemKey: string) => {
      let confirmDuplicate = false;
      for (;;) {
        try {
          return await api.openZoteroItem(itemKey, confirmDuplicate);
        } catch (error) {
          if (
            error instanceof ApiRequestError &&
            error.status === 409 &&
            error.code === API_ERROR_CODES.duplicateRequired
          ) {
            const details = error.details as
              | {
                  candidates?: Array<{ id: string; name: string; reasons?: string[] }>;
                  canOverride?: boolean;
                }
              | undefined;
            const candidates = details?.candidates ?? [];
            const lines = candidates.map(
              (candidate) => `《${candidate.name}》（${(candidate.reasons ?? []).join('、')}）`
            );
            if (details?.canOverride) {
              if (
                !appDialogs.confirm(
                  `文献库中已有相同或相似的文献：\n\n${lines.join(
                    '\n'
                  )}\n\n仍然导入一篇新的记录吗？`
                )
              ) {
                throw new Error('已取消导入');
              }
              confirmDuplicate = true;
              continue;
            }
            if (appDialogs.confirm(`文献库中已有同一文件：\n\n${lines.join('\n')}\n\n打开已有文献？`)) {
              const existing = candidates[0];
              if (existing) return await api.getDocument(existing.id);
            }
            throw new Error('已取消导入');
          }
          throw error;
        }
      }
    },
    onSuccess: (document) => {
      if (document.sizeBytes > 100 * 1024 * 1024) {
        const mb = Math.round(document.sizeBytes / (1024 * 1024));
        appDialogs.alert(
          `这本 PDF 约有 ${mb} MB。导入本身不受大小限制，但后续会话、翻译或 OCR 若使用外部服务，` +
            '可能产生较多 token 费用和更长的处理时间。'
        );
      }
      onOpen(document);
    }
  });
  const items = loaded;
  return (
    <section className="kr-library kr-zotero">
      <header className="kr-library__head">
        <div>
          <h2>从 Zotero 导入</h2>
          <p className="kr-muted">
            这里的条目来自 Zotero；是否复制 PDF 取决于下面的导入方式。
          </p>
        </div>
      </header>
      <div className="kr-zotero__import-note" role="note">
        <strong>{configQuery.data?.mode === 'local' ? '导入方式' : '说明'}</strong>
        {configQuery.data?.mode === 'local' ? (
          <p>
            本机 Zotero 导入只保存只读链接，不复制源文件；请勿删除或移动 Zotero
            里的条目或 PDF，否则将无法打开。
          </p>
        ) : null}
        <p>批注和笔记只保存在本应用，不会写回 Zotero。</p>
      </div>
      {!configQuery.data ? (
        <p className="kr-muted">正在读取 Zotero 配置…</p>
      ) : (
        <>
          <div className="kr-library__filters">
            <label>
              分类
              <select value={collection} onChange={(event) => setCollection(event.target.value)}>
                <option value="">全部文献</option>
                {(collectionsQuery.data ?? []).map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <form className="kr-zotero-search" onSubmit={submitSearch}>
              <input
                value={searchInput}
                maxLength={500}
                placeholder="搜索标题、作者、年份（Zotero 快速搜索）"
                aria-label="Zotero 快速搜索"
                onChange={(event) => {
                  const value = event.target.value;
                  setSearchInput(value);
                  // 清空输入即恢复全部条目，不需要再点搜索。
                  if (!value.trim() && query) applySearch('');
                }}
              />
              <button type="submit" className="kr-secondary">
                搜索
              </button>
            </form>
            <button
              type="button"
              className="kr-secondary"
              onClick={() => diagnose.mutate()}
              disabled={diagnose.isPending}
            >
              {diagnose.isPending ? '诊断中…' : '诊断连接'}
            </button>
          </div>
          <p className="kr-muted">
            搜索由 Zotero 快速搜索完成：匹配标题、作者与年份（不是只匹配标题）。
          </p>
          {diagnose.data ? (
            <div className="kr-zotero-diagnose" role="status">
              <p>
                <strong>
                  诊断：{diagnose.data.mode_name} · {diagnose.data.ok ? '可用' : '不可用'}
                </strong>
              </p>
              <p className={diagnose.data.ok ? 'kr-muted' : 'kr-page-error'}>
                {diagnose.data.message}
              </p>
              {diagnose.data.suggested_library_id ? (
                <p className="kr-muted">
                  建议填写的数字资料库 ID：{diagnose.data.suggested_library_id}
                  （当前填写的 ID 与这把密钥所属账户不一致；云端按数字 ID 取库，读不到分类时要先改这里）
                </p>
              ) : null}
              {diagnose.data.detail.length > 0 ? (
                <details>
                  <summary>诊断细节（{diagnose.data.detail.length} 条）</summary>
                  <ul>
                    {diagnose.data.detail.map((line, index) => (
                      <li key={`${index}-${line.slice(0, 12)}`}>{line}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
          {diagnose.isError ? (
            <p className="kr-page-error">诊断失败：{diagnose.error.message}</p>
          ) : null}
          {itemsQuery.isLoading ? <p className="kr-muted">正在读取 Zotero 文献…</p> : null}
          {itemsQuery.isError ? (
            <p className="kr-page-error">读取 Zotero 失败：{itemsQuery.error.message}</p>
          ) : null}
          {open.isError ? (
            <p className="kr-page-error">导入失败：{open.error.message}</p>
          ) : null}
          {open.isPending ? (
            <p className="kr-muted">
              正在从 Zotero/WebDAV 导入附件并解析；大文件可能需要几十秒，请稍候…
            </p>
          ) : null}
          <div className="kr-library__grid">
            {items.map((item) => (
              <article className="kr-doc-card" key={item.key}>
                <h3>{item.title}</h3>
                <p>{item.creators}</p>
                {item.publication ? <p className="kr-muted">{item.publication}</p> : null}
                <p className="kr-muted">{item.date}</p>
                <button type="button" onClick={() => open.mutate(item.key)} disabled={open.isPending}>
                  {open.isPending && open.variables === item.key ? '导入中…' : '导入文献'}
                </button>
              </article>
            ))}
            {!itemsQuery.isLoading && items.length === 0 ? (
              <p className="kr-muted">没有找到 Zotero 文献。</p>
            ) : null}
          </div>
          <p className="kr-muted">
            已显示 {items.length} 条 Zotero 文献{query ? `（搜索：${query}）` : ''}。
          </p>
          {itemsQuery.data?.length === PAGE_SIZE ? (
            <button
              type="button"
              className="kr-secondary"
              onClick={() => setStart((value) => value + PAGE_SIZE)}
              disabled={itemsQuery.isFetching}
            >
              {itemsQuery.isFetching ? '加载中…' : '加载更多'}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
