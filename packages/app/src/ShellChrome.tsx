import { BrandMark, onHostKeyDown } from '@studianda/ui';
import React, { useEffect, useState } from 'react';
import type { DataSetupState, RuntimeAdapter } from './runtime.js';
import { SHORTCUT_FIELDS } from './shortcut-defaults.js';

/**
 * 壳层通用界面：无边框窗口标题栏与首次启动页。
 *
 * 只依赖 `RuntimeAdapter`，桌面壳与将来的 DSH 插件可以共用：
 * - 宿主没有 windowControls 时标题栏不渲染（由宿主提供窗口装饰）；
 * - 宿主不实现 getDataSetup 时视为已配置，直接进入应用。
 */

export function ShellTitleBar({ adapter }: { adapter: RuntimeAdapter }): React.JSX.Element | null {
  const controls = adapter.windowControls;
  const [maximized, setMaximized] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (!controls) return undefined;
    let disposed = false;
    void controls.isMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });
    return controls.onMaximized((value) => {
      if (!disposed) setMaximized(value);
    });
  }, [controls]);

  // 帮助弹层：Esc 关闭（与阅读器/设置的 Esc 语义一致）。
  useEffect(() => {
    if (!showHelp) return undefined;
    return onHostKeyDown((event) => {
      if (event.key === 'Escape') setShowHelp(false);
    });
  }, [showHelp]);

  if (!controls) return null;
  return (
    <header className="kr-titlebar">
      <span className="kr-titlebar__title">勘读 · 本地文献阅读</span>
      <div className="kr-titlebar__buttons">
        <button
          type="button"
          aria-label="帮助与快捷键"
          aria-expanded={showHelp}
          onClick={() => setShowHelp((value) => !value)}
        >
          ?
        </button>
        <button type="button" aria-label="最小化" onClick={() => controls.minimize()}>
          —
        </button>
        <button
          type="button"
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => controls.toggleMaximize()}
        >
          {maximized ? '❐' : '□'}
        </button>
        <button
          type="button"
          className="kr-titlebar__close"
          aria-label="关闭"
          onClick={() => controls.close()}
        >
          ×
        </button>
      </div>
      {showHelp ? (
        <div className="kr-help-popover" role="dialog" aria-label="帮助与快捷键">
          <strong>快捷键与使用提示</strong>
          <p>以下为默认快捷键；可在「设置 → 快捷键与阅读」中修改。</p>
          <dl>
            {SHORTCUT_FIELDS.map((field) => (
              <React.Fragment key={field.key}>
                <dt>{field.label}</dt>
                <dd>{field.fallback}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p>
            主流程：导入 PDF → 左侧文献库 → 中间原文 → 右侧「阅读伙伴」切换批注 / 笔记 / 会话 / 翻译 / 引用。
          </p>
          <button type="button" onClick={() => setShowHelp(false)}>
            关闭
          </button>
        </div>
      ) : null}
    </header>
  );
}

/** 首次启动：让用户选择资料位置。 */
export function DataSetupView({
  adapter,
  onDone
}: {
  adapter: RuntimeAdapter;
  onDone(): void;
}): React.JSX.Element {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async (): Promise<void> => {
    if (!adapter.setupDataLocation) {
      setMessage('当前宿主不支持选择资料位置。');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await adapter.setupDataLocation();
      if (result.ok) {
        try {
          // 资料位置确定后重新展示一次使用引导（引导本身仍只显示一次）。
          window.localStorage.removeItem('studianda.guide.seen');
        } catch {
          // 存储不可用时忽略，不影响进入应用。
        }
        onDone();
      } else {
        setMessage(result.message);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '设置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kr-setup">
      <section className="kr-setup__card" aria-labelledby="kr-setup-title">
        <div className="kr-setup__mark">
          <BrandMark size={64} />
        </div>
        <span className="kr-setup__step">首次启动</span>
        <h1 id="kr-setup-title">把资料放在一个安全的位置</h1>
        <p className="kr-setup__lead">
          文献、批注、笔记和索引都会保存在这里。资料必须放在安装目录之外，更新或卸载程序不会删除它。
        </p>
        <ul className="kr-setup__rules">
          <li>建议放在文稿、资料盘或云盘同步目录。</li>
          <li>不要选择勘读的安装目录或其子目录。</li>
          <li>之后可以在设置 → 资料位置中更改。</li>
        </ul>
        <p className="kr-setup__notice">
          资料与导出备份均为明文，未内置加密，请使用磁盘加密或系统账户隔离保护敏感资料；请只导入您拥有合法权利或已获授权的资料。
        </p>
        <div className="kr-setup__actions">
          <button type="button" className="kr-primary" disabled={busy} onClick={() => void choose()}>
            {busy ? '正在准备…' : '选择资料文件夹'}
          </button>
          <button
            type="button"
            className="kr-ghost"
            onClick={() => adapter.windowControls?.close()}
            disabled={!adapter.windowControls}
          >
            退出勘读
          </button>
        </div>
        {message ? (
          <p className="kr-setup__error" role="alert">
            {message}
          </p>
        ) : null}
        <p className="kr-setup__privacy">不启用外部服务时，资料只保存在这台电脑。</p>
      </section>
    </div>
  );
}

/**
 * 首次启动门禁：宿主未实现 getDataSetup 时直接放行。
 *
 * 只关心"是否需要先选资料位置"，不负责加载业务页面；业务页面由调用方作为 children 传入。
 */
export function BootstrapGate({
  adapter,
  children
}: {
  adapter: RuntimeAdapter;
  children: React.ReactNode;
}): React.JSX.Element {
  const [configured, setConfigured] = useState<DataSetupState | null>(() =>
    adapter.getDataSetup ? null : { configured: true, current: '' }
  );

  useEffect(() => {
    if (!adapter.getDataSetup) {
      setConfigured({ configured: true, current: '' });
      return;
    }
    let disposed = false;
    void adapter
      .getDataSetup()
      .then((state) => {
        if (!disposed) setConfigured(state);
      })
      .catch(() => {
        if (!disposed) setConfigured({ configured: false, current: '' });
      });
    return () => {
      disposed = true;
    };
  }, [adapter]);

  if (!configured) {
    return (
      <div className="kr-root">
        <div className="kr-setup kr-setup--loading">正在检查资料位置…</div>
      </div>
    );
  }
  if (!configured.configured) {
    return (
      <div className="kr-root">
        <DataSetupView adapter={adapter} onDone={() => window.location.reload()} />
      </div>
    );
  }
  return <div className="kr-root">{children}</div>;
}
