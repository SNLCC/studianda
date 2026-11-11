import {
  BootstrapGate,
  ShellTitleBar,
  StudiandaApp,
  TranslationWindow,
  type RuntimeAdapter
} from '@studianda/app';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@studianda/ui/styles.css';
import '@studianda/ui/qa.css';
import { UpdateNotice } from './UpdateNotice.js';
// worker 是壳内静态资源：由 renderer 打包，再经 pdfWorkerUrl 传给 app（app 包不再依赖 Vite）。
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// 把渲染进程里漏掉的错误也打到控制台；主进程会把它写进 renderer.log，便于排查白屏。
window.addEventListener('error', (event) => {
  console.error('[renderer] window error:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled rejection:', event.reason);
});

/** 兜底错误边界：单个视图出错时不要整窗白屏，至少给出错误信息和重新加载入口。 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] uncaught render error:', error?.stack, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.stack || this.state.error.message;
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          height: '100vh',
          padding: 24,
          background: '#f4eedf',
          color: '#2c2a24',
          fontFamily: '"Studianda Sans", "Noto Sans CJK SC", system-ui, sans-serif'
        }}
      >
        <div
          style={{
            maxWidth: 680,
            padding: 24,
            border: '1px solid #d8cbb2',
            borderRadius: 14,
            background: '#fbf7ec',
            boxShadow: '0 18px 50px rgb(70 55 30 / 12%)'
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 18 }}>界面加载出错了</h1>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6f6759' }}>
            错误已写入日志。可以点「重新加载」；如果反复出现，请把下面的信息发给开发者。
          </p>
          <pre
            style={{
              maxHeight: 220,
              overflow: 'auto',
              margin: '0 0 16px',
              padding: 10,
              borderRadius: 8,
              background: '#f4eedf',
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap'
            }}
          >
            {message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '7px 16px',
              border: '1px solid #4f6f5a',
              borderRadius: 7,
              background: '#4f6f5a',
              color: '#fbf7ec',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

const desktopBridge = window.studianda as typeof window.studianda & {
  openTranslationWindow?: (input: {
    documentId: string;
    page: number;
  }) => Promise<{ ok: boolean; message?: string }>;
};

/**
 * 更新桥：preload 一定带 update（与渲染层同一份构建），这里仍然做存在性检查，
 * 这样万一宿主只提供了旧版 preload，界面会降级成"没有更新能力"而不是直接报错。
 */
const updateBridge = window.studianda.update;

/**
 * 桌面壳适配器：renderer 里唯一允许直接访问 `window.studianda` 的地方。
 * 界面层只通过这个对象拿壳能力；将来 DSH 插件实现自己的 adapter 即可复用同一套界面。
 */
const adapter: RuntimeAdapter = {
  getRuntime: () => window.studianda.getRuntime(),
  pickPdf: () => window.studianda.pickPdf(),
  pickDirectory: () => window.studianda.pickDirectory(),
  pickMarkdownVault: () => window.studianda.pickMarkdownVault(),
  openNoteAsset: (url) => window.studianda.openNoteAsset(url),
  getSecretStatus: () => window.studianda.getSecretStatus(),
  setSecret: (name, value) => window.studianda.setSecret(name, value),
  clearSecret: (name) => window.studianda.clearSecret(name),
  getDataLocation: () => window.studianda.getDataLocation(),
  openDataLocation: () => window.studianda.openDataLocation(),
  openLegalNotice: () => window.studianda.openLegalNotice(),
  changeDataLocation: () => window.studianda.changeDataLocation(),
  openTranslationWindow: (input) => {
    const method = desktopBridge.openTranslationWindow;
    if (!method) {
      return Promise.resolve({ ok: false, message: '当前桌面壳不支持独立译文窗口' });
    }
    return method(input);
  },
  windowControls: {
    minimize: () => window.studianda.windowControls.minimize(),
    toggleMaximize: () => window.studianda.windowControls.toggleMaximize(),
    close: () => window.studianda.windowControls.close(),
    isMaximized: () => window.studianda.windowControls.isMaximized(),
    onMaximized: (callback) => window.studianda.windowControls.onMaximized(callback)
  },
  getDataSetup: () => window.studianda.getDataSetup(),
  setupDataLocation: () => window.studianda.setupDataLocation(),
  openExternal: (url) => window.studianda.openExternal(url),
  saveBlob: (data, filename) => window.studianda.saveBlob(data, filename),
  clearUserDataLogs: () => window.studianda.clearUserDataLogs(),
  update: updateBridge
    ? {
        getState: () => updateBridge.getState(),
        getAutoCheck: () => updateBridge.getAutoCheck(),
        setAutoCheck: (enabled) => updateBridge.setAutoCheck(enabled),
        check: (manual) => updateBridge.check(manual),
        download: () => updateBridge.download(),
        install: () => updateBridge.install(),
        onStatus: (callback) => updateBridge.onStatus(callback)
      }
    : undefined
};

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

// 独立译文窗口与主窗口共用同一份 renderer：只带 query，不渲染主界面/标题栏。
const isTranslationWindow =
  new URLSearchParams(window.location.search).get('translationWindow') === '1';

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isTranslationWindow ? (
        <div className="kr-root">
          <div className="kr-desktop__body kr-desktop__body--translation">
            <TranslationWindow adapter={adapter} />
          </div>
        </div>
      ) : (
        <div className="kr-root">
          <div className="kr-desktop">
            <div className="kr-desktop__body">
              <BootstrapGate adapter={adapter}>
                <StudiandaApp adapter={adapter} pdfWorkerUrl={pdfWorkerUrl} />
              </BootstrapGate>
            </div>
            <ShellTitleBar adapter={adapter} />
            <UpdateNotice adapter={adapter} />
          </div>
        </div>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
