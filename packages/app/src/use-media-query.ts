import { useEffect, useState } from 'react';

/**
 * 订阅一条 CSS 媒体查询（用于「跨断点」的 JS 状态，例如侧栏自动折叠、阅读右栏覆盖层）。
 *
 * 与只写 CSS 的断点不同，需要 JS 参与的行为（默认开合、互斥、用户展开不被 resize 收回）
 * 必须知道当前是否处于窄档；这里用 matchMedia 而不是手写 resize 监听，避免阈值漂移。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
