import { UPDATE_PAGE_URL, type UpdateState } from '@studianda/shared';
import { useCallback, useEffect, useState, type JSX } from 'react';
import type { RuntimeAdapter } from './runtime.js';

/** 字节数显示（与设置页其它大小显示同风格）。 */
function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!Number.isFinite(bytesPerSecond) || !bytesPerSecond || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 阶段 → 用户可读说明（message 有更具体内容时优先用它）。 */
function phaseText(state: UpdateState): string {
  switch (state.phase) {
    case 'checking':
      return '正在检查更新…';
    case 'up-to-date':
      return state.message ?? '当前已经是最新版本。';
    case 'available':
      return `发现新版本 ${state.version ?? ''}：可以立即更新。`;
    case 'downloading':
      return '正在下载更新…';
    case 'downloaded':
      return `新版本 ${state.version ?? ''} 已下载，重启后完成安装。`;
    case 'installing':
      return state.message ?? '正在退出并安装更新…';
    case 'error':
      return state.message ?? '更新失败。';
    case 'unsupported':
      return state.message ?? '当前环境不支持应用内更新。';
    default:
      return state.message ?? '尚未检查更新。';
  }
}

/**
 * 设置页「关于与更新」分区。
 *
 * 只通过 RuntimeAdapter 的 update 能力工作：没有该能力的宿主（非 Electron）
 * 仍然能显示版本号，但更新按钮不出现，也不会假装能更新。
 */
export function UpdatePanel({ adapter }: { adapter: RuntimeAdapter }): JSX.Element {
  const update = adapter.update;
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null);

  useEffect(() => {
    if (!update?.getAutoCheck) return;
    let alive = true;
    void update.getAutoCheck().then((enabled) => {
      if (alive && enabled !== null) setAutoCheck(enabled);
    });
    return () => {
      alive = false;
    };
  }, [update]);

  const changeAutoCheck = async (enabled: boolean): Promise<void> => {
    if (!update?.setAutoCheck) return;
    setAutoCheck(enabled);
    const next = await update.setAutoCheck(enabled);
    if (next !== null) setAutoCheck(next);
  };

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

  const run = useCallback(
    async (action: () => Promise<unknown>, label: string) => {
      setBusy(true);
      setNote('');
      try {
        await action();
      } catch (error) {
        setNote(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const check = useCallback(() => {
    if (!update) return;
    void run(() => update.check(true), '检查更新');
  }, [run, update]);

  const download = useCallback(() => {
    if (!update) return;
    void run(() => update.download(), '下载更新');
  }, [run, update]);

  const install = useCallback(() => {
    if (!update) return;
    void run(async () => {
      const result = await update.install();
      if (!result.ok) setNote(result.message ?? '未能安装更新。');
    }, '安装更新');
  }, [run, update]);

  const phase = state?.phase ?? 'idle';
  const canCheck = Boolean(update) && !busy && phase !== 'downloading' && phase !== 'installing';
  const progress = state?.progress;
  const notes = state?.releaseNotes?.trim();

  return (
    <>
      <p>
        <strong>当前版本：</strong>
        {state?.currentVersion ? `v${state.currentVersion}` : '未知'}
      </p>

      {update?.getAutoCheck && autoCheck !== null ? (
        <label className="kr-settings__check">
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(event) => void changeAutoCheck(event.target.checked)}
          />
          <span>
            启动后自动检查更新（默认关闭；只发送版本号等元数据；手动检查仍可用）
          </span>
        </label>
      ) : null}

      <p className="kr-muted">
        启动后默认不自动检查更新；开启后只向 GitHub Releases 发送版本号等版本元数据，不上传
        文献、笔记、批注或会话内容。可在此处开启或关闭；设置环境变量{' '}
        <code>STUDIANDA_DISABLE_UPDATE_CHECK=1</code> 可强制关闭（重启应用后生效）；关闭后仍可
        在本页手动检查。
      </p>

      {update ? (
        <>
          <p className="kr-muted">{phaseText(state ?? { currentVersion: '', phase: 'idle' })}</p>

          {phase === 'downloading' ? (
            <div>
              <div
                style={{
                  height: 6,
                  borderRadius: 999,
                  background: '#e8dfcb',
                  overflow: 'hidden',
                  margin: '6px 0 4px'
                }}
                role="progressbar"
                aria-valuenow={Math.round(progress?.percent ?? 0)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  style={{
                    width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%`,
                    height: '100%',
                    background: '#4f6f5a',
                    transition: 'width 200ms linear'
                  }}
                />
              </div>
              <p className="kr-muted">
                {Math.round(progress?.percent ?? 0)}%
                {progress?.total
                  ? `（${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}）`
                  : ''}
                {formatSpeed(progress?.bytesPerSecond) ? ` ${formatSpeed(progress?.bytesPerSecond)}` : ''}
              </p>
            </div>
          ) : null}

          <div className="kr-settings__actions">
            {phase === 'available' ? (
              <>
                <button type="button" onClick={download} disabled={busy}>
                  {busy ? '准备中…' : `更新到 ${state?.version ?? '新版本'}`}
                </button>
                <button type="button" className="kr-secondary" onClick={check} disabled={!canCheck}>
                  重新检查
                </button>
              </>
            ) : phase === 'downloaded' ? (
              <>
                <button type="button" onClick={install} disabled={busy}>
                  {busy ? '正在安装…' : '重启并安装'}
                </button>
                <button type="button" className="kr-secondary" onClick={check} disabled={!canCheck}>
                  重新检查
                </button>
              </>
            ) : (
              <button type="button" onClick={check} disabled={!canCheck}>
                {busy && phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
            )}
            {adapter.openExternal ? (
              <button
                type="button"
                className="kr-secondary"
                onClick={() => {
                  void adapter.openExternal?.(UPDATE_PAGE_URL);
                }}
              >
                打开发布页
              </button>
            ) : null}
          </div>

          {state?.phase === 'downloaded' ? (
            <p className="kr-muted">
              安装会重启应用：更新前会自动备份资料，资料目录（文献、笔记、会话）不会被改动。
            </p>
          ) : null}
          {state?.phase === 'available' ? (
            <p className="kr-muted">
              安装包大小约 {formatBytes(state.size)}；点击更新后才会开始下载，可随时关闭设置继续使用。
            </p>
          ) : null}
          {note ? <p className="kr-settings__message">{note}</p> : null}

          {notes && (phase === 'available' || phase === 'downloaded') ? (
            <details>
              <summary>更新说明</summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  maxHeight: 220,
                  overflow: 'auto',
                  fontSize: 12,
                  lineHeight: 1.6,
                  margin: '8px 0 0'
                }}
              >
                {notes}
              </pre>
            </details>
          ) : null}
        </>
      ) : (
        <p className="kr-muted">
          当前运行环境没有应用内更新能力；需要新版本时请到发布页手动下载安装包覆盖安装。
        </p>
      )}
    </>
  );
}
