import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { getAppPortalRoot } from '@studianda/ui';

export type SettingsFeedbackKind = 'success' | 'error';

interface SettingsFeedbackItem {
  /** 每条反馈的序号：同样的文案再次触发时也能重新播报/重新计时。 */
  id: number;
  text: string;
  kind: SettingsFeedbackKind;
}

interface SettingsFeedbackApi {
  /**
   * 统一的设置保存/操作反馈：右上角 toast，保留 5–12 秒（文案越长越久）。
   * 不传 kind 时按文案判断成败；保存成功/失败请显式传，避免文案里带“失败”以外的错误词时误判。
   */
  notify(text: string, kind?: SettingsFeedbackKind): void;
}

const SettingsFeedbackContext = createContext<SettingsFeedbackApi | null>(null);

const BASE_DURATION_MS = 5000;
const MAX_DURATION_MS = 12000;

/** 信息越长读得越久：5 秒起步，每 40 个字符 +1 秒，最多 12 秒。 */
function durationFor(text: string): number {
  return Math.min(MAX_DURATION_MS, BASE_DURATION_MS + Math.floor(text.length / 40) * 1000);
}

/** 兼容只传文案的调用点：旧文案约定“失败/错误/无法…”即报错。 */
function inferKind(text: string): SettingsFeedbackKind {
  return /失败|错误|无法|不可用|不能|请填|请选择|需为|已存在|未获取到/.test(text)
    ? 'error'
    : 'success';
}

/**
 * 设置页所有分区的保存反馈统一走这里：同一位置、同一时长、同一套成功/失败样式。
 * 之前「模型服务」「会话模型」「翻译」「快捷键」「视觉读页」「语言包」各自在按钮下方
 * 内联一行绿字，和右上角 toast 混用，同一操作在不同页面看起来不一样。
 */
export function SettingsFeedbackProvider({
  children
}: {
  children: ReactNode;
}): JSX.Element {
  const [item, setItem] = useState<SettingsFeedbackItem | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(() => setItem(null), durationFor(item.text));
    return () => window.clearTimeout(timer);
  }, [item]);

  const notify = useCallback((text: string, kind?: SettingsFeedbackKind) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sequence.current += 1;
    setItem({ id: sequence.current, text: trimmed, kind: kind ?? inferKind(trimmed) });
  }, []);

  const value = useMemo<SettingsFeedbackApi>(() => ({ notify }), [notify]);

  return (
    <SettingsFeedbackContext.Provider value={value}>
      {children}
      {item
        ? createPortal(
            <div className="kr-root">
            <div
              key={item.id}
              className={`kr-settings__toast${item.kind === 'error' ? ' is-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {item.text}
            </div>
            </div>,
            getAppPortalRoot()
          )
        : null}
    </SettingsFeedbackContext.Provider>
  );
}

export function useSettingsFeedback(): SettingsFeedbackApi {
  const value = useContext(SettingsFeedbackContext);
  if (!value) {
    throw new Error('useSettingsFeedback 必须在 SettingsFeedbackProvider 内使用');
  }
  return value;
}
