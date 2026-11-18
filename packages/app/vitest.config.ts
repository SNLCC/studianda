import { defineConfig } from 'vitest/config';

/**
 * app 包最小测试基建：只测纯逻辑（node 环境，不引 jsdom/happy-dom）。
 *
 * 组件渲染、React Query 状态与 Electron 桥接仍靠真机手测；这里覆盖从 StudiandaApp
 * 大文件里提取出来的范围判定/互斥清理，给后续继续拆大文件留回归网。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
