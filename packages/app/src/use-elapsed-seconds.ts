import { useEffect, useState } from 'react';

/**
 * 长任务的"已用时"秒数：只做可见反馈，不假装有进度百分比。
 *
 * 导入/区域 OCR 这类同步接口暂时没有真实进度与取消（需要后端 job API），
 * 先显示计时，避免用户以为界面卡死；`active` 变 false 时归零。
 */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}
