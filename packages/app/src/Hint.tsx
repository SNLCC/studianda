import { useId, useLayoutEffect, useRef, useState, type JSX } from 'react';

export function SendingNotice({ text }: { text: string }): JSX.Element {
  return (
    <p className="kr-settings__privacy">
      <span className="kr-settings__privacy-label">提示</span>
      <span>{text}</span>
    </p>
  );
}

/**
 * 标题后的小问号：说明收到问号里，指针移上去才显示。
 * 用 fixed 定位，避免被设置卡片的 overflow 裁掉；靠近窗口边缘时自动翻转/夹回。
 */
export function HintMark({
  text,
  label = '说明'
}: {
  text: string;
  label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const anchorBox = anchor.getBoundingClientRect();
    const bubbleBox = bubble.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        anchorBox.left + anchorBox.width / 2 - bubbleBox.width / 2,
        window.innerWidth - bubbleBox.width - 8
      )
    );
    let top = anchorBox.bottom + 8;
    if (top + bubbleBox.height > window.innerHeight - 8) {
      top = Math.max(8, anchorBox.top - bubbleBox.height - 8);
    }
    setPosition((current) =>
      current.left === left && current.top === top ? current : { left, top }
    );
  }, [open]);

  const show = (): void => setOpen(true);
  const hide = (): void => setOpen(false);

  return (
    <span className="kr-hint-wrap">
      <button
        ref={anchorRef}
        type="button"
        className="kr-hint-mark"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M5.7 6.2c0-1.25 1-2.1 2.35-2.1 1.35 0 2.35.8 2.35 2 0 1.7-2.3 1.7-2.3 3.35v.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinecap="round"
          />
          <circle cx="8.1" cy="12.2" r="0.95" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <span
          ref={bubbleRef}
          id={id}
          className="kr-hint-bubble"
          role="tooltip"
          style={{ left: position.left, top: position.top }}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
