import React from 'react';

/**
 * 身份徽标：只区分「我」与「Agent」，不做账号体系。
 * 名字来自 MCP clientInfo（后续由 notes/annotations.agent_name 提供）；缺失时只显示「Agent」。
 * 颜色 + 图标 + 文字三重编码，不只靠颜色。
 */
export function IdentityBadge({
  kind,
  name,
  size = 'sm',
  title
}: {
  kind: 'user' | 'agent';
  name?: string;
  size?: 'sm' | 'md';
  title?: string;
}): React.JSX.Element {
  const label = kind === 'agent' ? (name ? `Agent · ${name}` : 'Agent') : '我';
  return (
    <span
      className={`kr-identity kr-identity--${kind} kr-identity--${size}`}
      title={title ?? (kind === 'agent' ? 'AI 生成内容' : '用户内容')}
      aria-label={kind === 'agent' ? `Agent 生成，来源 ${name ?? '未知'}` : '用户内容'}
    >
      <span className="kr-identity__mark" aria-hidden="true">
        {kind === 'agent' ? '◈' : '我'}
      </span>
      <span className="kr-identity__label">{label}</span>
    </span>
  );
}
