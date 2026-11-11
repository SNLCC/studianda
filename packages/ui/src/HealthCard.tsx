import type React from 'react';

export type HealthState =
  | { status: 'connecting' }
  | { status: 'ok'; version: string; apiVersion: number }
  | { status: 'error'; message: string };

export interface HealthCardProps {
  state: HealthState;
  onRetry?: () => void;
}

export function HealthCard({ state, onRetry }: HealthCardProps): React.JSX.Element {
  if (state.status === 'connecting') {
    return (
      <section className="kr-card" aria-live="polite">
        <h1>勘读 · Studianda</h1>
        <p>正在连接本地 Core…</p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="kr-card kr-card--error" role="alert">
        <h1>勘读 · Studianda</h1>
        <p>Core 连接失败：{state.message}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            重试
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="kr-card" aria-live="polite">
      <h1>勘读 · Studianda</h1>
      <p className="kr-ok">Core 已连接</p>
      <dl>
        <dt>版本</dt>
        <dd>{state.version}</dd>
        <dt>API</dt>
        <dd>v{state.apiVersion}</dd>
      </dl>
      <p className="kr-hint">勘读 · 本地 Core 健康检查</p>
    </section>
  );
}
