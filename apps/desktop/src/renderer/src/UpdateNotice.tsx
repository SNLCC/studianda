import type { RuntimeAdapter } from '@studianda/app';
import { UPDATE_PAGE_URL, type UpdateState } from '@studianda/shared';
import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';

/** 用户选择"跳过此版本"时记录在 localStorage 的键。 */
const SKIP_KEY = 'studianda.update.skippedVersion';

function readSkippedVersion(): string {
  try {
    return window.localStorage.getItem(SKIP_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeSkippedVersion(version: string): void {
  try {
    window.localStorage.setItem(SKIP_KEY, version);
  } catch {
    // 存不下就只在本次会话跳过
  }
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * 全局更新提示条。
 *
 * 主进程在启动后静默检查更新，发现新版本时通过 IPC 推送过来；这里只负责提示与
 * 用户确认（下载、重启安装、稍后、跳过此版本）。详细说明与进度也在设置页里有一份。
 *
 * 放在桌面壳的 renderer 里（而不是 packages/app）是因为它需要常驻在设置面板之外，
 * 而 shell 只这一个入口；仍然只通过 RuntimeAdapter 的 update 能力工作。
 */
export function UpdateNotice({ adapter }: { adapter: RuntimeAdapter }): JSX.Element | null {
  const update = adapter.update;
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [skipped, setSkipped] = useState(() => readSkippedVersion());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!update) return;
    let alive = true;
    void update.getState().then((initial) => {
      if (alive && initial) setState(initial);
    });
    const off = update.onStatus((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, [update]);

  const download = useCallback(() => {
    if (!update) return;
    setBusy(true);
    setNote('');
    void update
      .download()
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [update]);

  const install = useCallback(() => {
    if (!update) return;
    setBusy(true);
    setNote('');
    void update
      .install()
      .then((result) => {
        if (!result.ok) setNote(result.message ?? '未能安装更新。');
      })
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [update]);

  if (!update || !state) return null;
  if (dismissed) return null;

  const phase = state.phase;
  const visible =
    phase === 'downloading' ||
    phase === 'downloaded' ||
    phase === 'installing' ||
    (phase === 'available' && state.version !== skipped) ||
    (phase === 'error' && state.manual === true && Boolean(state.progress) === false);
  if (!visible) return null;

  const title =
    phase === 'available'
      ? `发现新版本 ${state.version ?? ''}`
      : phase === 'downloading'
        ? '正在下载更新'
        : phase === 'downloaded'
          ? '更新已下载'
          : phase === 'installing'
            ? '正在安装更新'
            : '更新失败';

  const progress = state.progress;
  const percent = Math.round(progress?.percent ?? 0);
  const size = formatBytes(state.size);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 60,
        width: 336,
        padding: '14px 16px',
        border: '1px solid #d8cbb2',
        borderRadius: 12,
        background: '#fbf7ec',
        color: '#2c2a24',
        boxShadow: '0 18px 50px rgb(70 55 30 / 18%)',
        fontFamily: '"Studianda Sans", "Noto Sans CJK SC", system-ui, sans-serif',
        fontSize: 13,
        lineHeight: 1.6
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        {phase !== 'installing' ? (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="隐藏更新提示"
            title="稍后再说"
            style={{
              border: 'none',
              background: 'transparent',
              color: '#6f6759',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0
            }}
          >
            ×
          </button>
        ) : null}
      </div>

      {phase === 'available' ? (
        <p style={{ margin: '6px 0 10px', color: '#6f6759' }}>
          {size ? `安装包约 ${size}。` : ''}点击更新后在应用内下载，安装前会自动备份资料，资料目录不受影响。
        </p>
      ) : null}
      {phase === 'downloading' ? (
        <>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: '#e8dfcb',
              overflow: 'hidden',
              margin: '8px 0 4px'
            }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              style={{
                width: `${Math.max(0, Math.min(100, percent))}%`,
                height: '100%',
                background: '#4f6f5a',
                transition: 'width 200ms linear'
              }}
            />
          </div>
          <p style={{ margin: '0 0 8px', color: '#6f6759' }}>
            {percent}%
            {progress?.total
              ? `（${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}）`
              : ''}
          </p>
        </>
      ) : null}
      {phase === 'downloaded' ? (
        <p style={{ margin: '6px 0 10px', color: '#6f6759' }}>
          重启后完成安装；更新前会自动备份资料。
        </p>
      ) : null}
      {phase === 'installing' ? (
        <p style={{ margin: '6px 0 2px', color: '#6f6759' }}>{state.message ?? '应用即将重启…'}</p>
      ) : null}
      {phase === 'error' && state.message ? (
        <p style={{ margin: '6px 0 10px', color: '#8a3b2e' }}>{state.message}</p>
      ) : null}
      {note ? <p style={{ margin: '6px 0 10px', color: '#8a3b2e' }}>{note}</p> : null}

      {phase !== 'installing' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {phase === 'available' ? (
            <>
              <button
                type="button"
                onClick={download}
                disabled={busy}
                style={{
                  padding: '5px 12px',
                  border: '1px solid #4f6f5a',
                  borderRadius: 7,
                  background: '#4f6f5a',
                  color: '#fbf7ec',
                  font: 'inherit',
                  cursor: 'pointer'
                }}
              >
                {busy ? '准备中…' : '立即更新'}
              </button>
              <button type="button" onClick={() => setDismissed(true)} style={secondaryStyle}>
                稍后
              </button>
              <button
                type="button"
                onClick={() => {
                  if (state.version) {
                    writeSkippedVersion(state.version);
                    setSkipped(state.version);
                  }
                  setDismissed(true);
                }}
                style={secondaryStyle}
              >
                跳过此版本
              </button>
            </>
          ) : phase === 'downloaded' ? (
            <>
              <button
                type="button"
                onClick={install}
                disabled={busy}
                style={{
                  padding: '5px 12px',
                  border: '1px solid #4f6f5a',
                  borderRadius: 7,
                  background: '#4f6f5a',
                  color: '#fbf7ec',
                  font: 'inherit',
                  cursor: 'pointer'
                }}
              >
                {busy ? '正在安装…' : '重启并安装'}
              </button>
              <button type="button" onClick={() => setDismissed(true)} style={secondaryStyle}>
                稍后
              </button>
            </>
          ) : phase === 'downloading' ? (
            <button type="button" onClick={() => setDismissed(true)} style={secondaryStyle}>
              后台继续，先隐藏
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setBusy(true);
                  void update
                    .check(true)
                    .finally(() => setBusy(false));
                }}
                disabled={busy}
                style={secondaryStyle}
              >
                重试
              </button>
              {adapter.openExternal ? (
                <button
                  type="button"
                  onClick={() => {
                    void adapter.openExternal?.(UPDATE_PAGE_URL);
                  }}
                  style={secondaryStyle}
                >
                  打开发布页
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

const secondaryStyle: CSSProperties = {
  padding: '5px 12px',
  border: '1px solid #d8cbb2',
  borderRadius: 7,
  background: '#f4eedf',
  color: '#2c2a24',
  font: 'inherit',
  cursor: 'pointer'
};
