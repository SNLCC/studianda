import type { ApiClient } from '@studianda/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { HintMark } from './Hint.js';
import { useSettingsFeedback } from './SettingsFeedback.js';

import { SHORTCUT_FIELDS as FIELDS } from './shortcut-defaults.js';

/** 把用户输入钳到合法区间；空/非数字回退默认值（服务端也会再钳一次）。 */
function clampNumber(raw: string, min: number, max: number, fallback: number): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function ShortcutSettingsPanel({ api }: { api: ApiClient }): JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => api.getSettings() });
  const { notify } = useSettingsFeedback();
  const [values, setValues] = useState<Record<string, string>>({});
  const [fontSize, setFontSize] = useState('14');
  const [answerFontSize, setAnswerFontSize] = useState('16');
  const [wheelAction, setWheelAction] = useState('zoom');
  // 证据审计输出模式（合规 P2-19）：默认按证据确定性改正文；可选只标注、不改写正文。
  const [auditRewrite, setAuditRewrite] = useState('rewrite');
  // 预算确认阈值：默认 20 页 / 60000 token，保存到 reading.budget_pages / reading.budget_tokens。
  const [budgetPages, setBudgetPages] = useState('20');
  const [budgetTokens, setBudgetTokens] = useState('60000');

  useEffect(() => {
    if (!settingsQuery.data) return;
    const next: Record<string, string> = {};
    for (const field of FIELDS) next[field.key] = settingsQuery.data[field.key] ?? field.fallback;
    setValues(next);
    setFontSize(settingsQuery.data['ui.fontSize'] ?? '14');
    setAnswerFontSize(settingsQuery.data['ui.answerFontSize'] ?? '16');
    setWheelAction(settingsQuery.data['ui.wheelAction'] ?? 'zoom');
    setAuditRewrite(
      settingsQuery.data['audit.rewrite_mode'] === 'annotate' ? 'annotate' : 'rewrite'
    );
    setBudgetPages(settingsQuery.data['reading.budget_pages'] ?? '20');
    setBudgetTokens(settingsQuery.data['reading.budget_tokens'] ?? '60000');
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        ...values,
        'ui.fontSize': fontSize,
        'ui.answerFontSize': answerFontSize,
        'ui.wheelAction': wheelAction,
        'audit.rewrite_mode': auditRewrite,
        'reading.budget_pages': String(clampNumber(budgetPages, 1, 3000, 20)),
        'reading.budget_tokens': String(clampNumber(budgetTokens, 1000, 4_000_000, 60_000))
      }),
    onSuccess: () => {
      notify('快捷键与阅读设置已保存。');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: Error) =>
      notify(`快捷键与阅读设置保存失败：${error.message}`, 'error')
  });

  const reset = (): void => {
    const next: Record<string, string> = {};
    for (const field of FIELDS) next[field.key] = field.fallback;
    setValues(next);
    setFontSize('14');
    setAnswerFontSize('16');
    setWheelAction('zoom');
    setAuditRewrite('rewrite');
    setBudgetPages('20');
    setBudgetTokens('60000');
  };

  return (
    <section className="kr-settings__section">
      <div className="kr-settings__section-head">
        <h2>快捷键与阅读</h2>
        <HintMark text="快捷键只作用于本机。" />
      </div>
      <p className="kr-muted">配置阅读区快捷键、界面字号与滚轮行为。</p>
      <div className="kr-shortcut-grid">
        <label>
          <span>界面字号</span>
          <input value={fontSize} onChange={(event) => setFontSize(event.target.value)} />
        </label>
        <label>
          <span>会话字号</span>
          <input
            value={answerFontSize}
            onChange={(event) => setAnswerFontSize(event.target.value)}
          />
        </label>
        <label>
          <span>文献区 Ctrl + 鼠标滚轮</span>
          <select value={wheelAction} onChange={(event) => setWheelAction(event.target.value)}>
            <option value="zoom">缩放文献</option>
            <option value="scroll">上下滚动</option>
          </select>
        </label>
        <label>
          <span>证据审计输出</span>
          <select value={auditRewrite} onChange={(event) => setAuditRewrite(event.target.value)}>
            <option value="rewrite">按证据确定性改写缺证段落（默认）</option>
            <option value="annotate">只标注，不改写正文</option>
          </select>
        </label>
      </div>
      <p className="kr-muted">
        默认“按证据改写”：本地会按固定规则替换缺证段落、给推断加前缀并移除未核验引用/页码
        （规则固定、可复现，不是开放式二次创作）。选择“只标注”则回答正文保持模型原文，
        缺证/推断/未核验引用只在审计报告与界面里标出。
      </p>
      <div className="kr-shortcut-grid">
        {FIELDS.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              value={values[field.key] ?? ''}
              onChange={(event) =>
                setValues({ ...values, [field.key]: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Backspace') {
                  event.preventDefault();
                  setValues({ ...values, [field.key]: '' });
                }
              }}
            />
          </label>
        ))}
      </div>
      <p className="kr-settings__group-label">阅读预算确认</p>
      <p className="kr-muted">
        单轮读取页数或 token 超过阈值时，先弹确认再读取；阈值只影响提示，不改变阅读范围。
        默认 20 页 / 60000 token。
      </p>
      <div className="kr-shortcut-grid">
        <label>
          <span>页数阈值（1–3000）</span>
          <input
            type="number"
            min={1}
            max={3000}
            step={1}
            value={budgetPages}
            onChange={(event) => setBudgetPages(event.target.value)}
          />
        </label>
        <label>
          <span>token 阈值（1000–4000000）</span>
          <input
            type="number"
            min={1000}
            max={4_000_000}
            step={1000}
            value={budgetTokens}
            onChange={(event) => setBudgetTokens(event.target.value)}
          />
        </label>
      </div>
      <div className="kr-settings__actions">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存快捷键与字号'}
        </button>
        <button type="button" className="kr-secondary" onClick={reset}>
          恢复默认
        </button>
      </div>
    </section>
  );
}
