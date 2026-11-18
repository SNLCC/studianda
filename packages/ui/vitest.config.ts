import { defineConfig } from 'vitest/config';

/**
 * ui 包最小测试基建：只测纯逻辑（node 环境，不引 jsdom/happy-dom）。
 *
 * 组件渲染/交互仍靠真机手测；这里覆盖的是从组件里提取出来的判定与文案组合，
 * 给后续继续拆 ChatPanel 等大文件留回归网。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
