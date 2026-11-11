import { createApiClient, type ApiClient } from '@studianda/api-client';
import type {
  DocumentDetail,
  RuntimeInfo,
  TranslationConfigRecord,
  TranslationPagePayload
} from '@studianda/shared';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useAiCopyGuard } from './use-ai-copy-guard.js';

/** 主窗口与译文窗口之间的同步频道（页码/文献）。 */
export const TRANSLATION_CHANNEL = 'studianda-translation';

interface TranslationPageMessage {
  type: 'page';
  documentId: string;
  page: number;
  /** main=主窗口面板广播；translation-window=译文窗口广播（避免回环）。 */
  source: 'main' | 'translation-window';
}

function readQuery(): { documentId: string; page: number } {
  const params = new URLSearchParams(window.location.search);
  const documentId = params.get('doc') ?? '';
  const parsed = Number(params.get('page') ?? 1);
  return {
    documentId,
    page: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
  };
}

/**
 * 独立译文窗口（多显示器只显示译文）。
 *
 * - 与主窗口共用同一个 renderer，靠 query 区分（`?translationWindow=1&doc=&page=`）；
 * - 只读：按段折叠显示原文/译文，不提供编辑/删除；
 * - 用 BroadcastChannel 与主窗口同步页码；自己翻页也广播，供主窗口跟随。
 */
export function TranslationWindow({
  adapter
}: {
  adapter: { getRuntime(): Promise<RuntimeInfo | null> };
}): JSX.Element {
  useAiCopyGuard();
  const initial = useMemo(readQuery, []);
  const [documentId] = useState(initial.documentId);
  const [page, setPage] = useState(initial.page);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [config, setConfig] = useState<TranslationConfigRecord | null>(null);
  const [payload, setPayload] = useState<TranslationPagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adapter
      .getRuntime()
      .then((info) => {
        if (!cancelled) setRuntime(info);
      })
      .catch(() => {
        if (!cancelled) setRuntime(null);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  const api = useMemo<ApiClient | null>(
    () =>
      runtime
        ? createApiClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token: runtime.token })
        : null,
    [runtime]
  );

  // 与主窗口同步：只接受来自主窗口面板的页码消息，自己发出的不回环。
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(TRANSLATION_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<TranslationPageMessage> | null;
      if (!data || data.type !== 'page' || data.source !== 'main') return;
      if (data.documentId !== documentId) return;
      const next = Number(data.page);
      if (Number.isInteger(next) && next >= 1) setPage(next);
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [documentId]);

  // 打开/翻页时广播当前页码，让主窗口可以跟随（source 标记为译文窗口，主窗口据此过滤）。
  useEffect(() => {
    if (!documentId) return;
    channelRef.current?.postMessage({
      type: 'page',
      documentId,
      page,
      source: 'translation-window'
    } satisfies TranslationPageMessage);
  }, [documentId, page]);

  useEffect(() => {
    if (!api || !documentId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [detail, translationConfig, pagePayload] = await Promise.all([
          api.getDocument(documentId),
          api.getTranslationConfig(),
          api.getTranslationPage(documentId, page)
        ]);
        if (cancelled) return;
        setDocument(detail);
        setConfig(translationConfig);
        setPayload(pagePayload);
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : '读取译文失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, documentId, page]);

  const changePage = (next: number): void => {
    const total = document?.pages ?? Number.MAX_SAFE_INTEGER;
    const clamped = Math.max(1, Math.min(total, next));
    if (clamped === page) return;
    setPage(clamped);
    channelRef.current?.postMessage({
      type: 'page',
      documentId,
      page: clamped,
      source: 'translation-window'
    } satisfies TranslationPageMessage);
  };

  const segments = (payload?.segments ?? []).filter(
    (segment) => (segment.text ?? '').trim().length > 0 || (segment.source ?? '').trim().length > 0
  );

  return (
    <div className="kr-translation-window">
      <header className="kr-translation-window__head">
        <div>
          <h1>{document?.name ?? '译文'}</h1>
          <p className="kr-muted">
            第 {page}
            {document ? ` / ${document.pages}` : ''} 页 · 目标语言：
            {config?.target_language ?? '—'}
          </p>
          <p className="kr-translation-window__ai" role="note">
            机器翻译 · 由 AI 生成，可能出错，请核对原文
          </p>
        </div>
        <div className="kr-translation-window__actions">
          <button type="button" onClick={() => changePage(page - 1)} disabled={page <= 1}>
            上一页
          </button>
          <button
            type="button"
            onClick={() => changePage(page + 1)}
            disabled={Boolean(document && page >= document.pages)}
          >
            下一页
          </button>
          <button type="button" onClick={() => window.close()}>
            关闭
          </button>
        </div>
      </header>
      {error ? <p className="kr-page-error">读取译文失败：{error}</p> : null}
      {!runtime && !loading ? (
        <p className="kr-page-error">
          无法连接本地服务：请先打开勘读主窗口并确认资料已就绪后重试。
        </p>
      ) : null}
      {loading ? <p className="kr-muted">正在读取译文…</p> : null}
      {!loading && !error && runtime && segments.length === 0 ? (
        <p className="kr-translation-window__empty">
          本页还没有译文，请回主窗口翻译。
        </p>
      ) : null}
      {!loading && !error && runtime && segments.length > 0 ? (
        <ul className="kr-translation-window__segments">
          {segments.map((segment) => (
            <li key={segment.id || `segment-${segment.segment}`}>
              <details open>
                <summary>
                  <span>第 {segment.segment} 段</span>
                  {segment.service ? (
                    <span className="kr-muted">（{segment.service}）</span>
                  ) : null}
                </summary>
                <p className="kr-translation-window__source">{segment.source}</p>
                <p className="kr-translation-window__text" data-ai-copy="translation">
                  {segment.text || '（未翻译）'}
                </p>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="kr-translation-window__foot">
        只读译文窗口 · 与主窗口页码同步；不提供编辑/删除。
      </footer>
    </div>
  );
}
