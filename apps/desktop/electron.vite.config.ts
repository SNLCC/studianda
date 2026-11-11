import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../..');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: path.join(root, 'src/renderer'),
    resolve: {
      alias: {
        // 子路径别名必须放在包别名之前：Vite alias 对字符串 find 是按前缀匹配的。
        '@studianda/ui/styles.css': path.join(repo, 'packages/ui/src/styles/styles.css'),
        '@studianda/ui/qa.css': path.join(repo, 'packages/ui/src/styles/qa.css'),
        '@studianda/app': path.join(repo, 'packages/app/src/index.ts'),
        '@studianda/ui': path.join(repo, 'packages/ui/src/index.ts'),
        '@studianda/api-client': path.join(repo, 'packages/api-client/src/index.ts'),
        '@studianda/shared': path.join(repo, 'packages/shared/src/index.ts')
      }
    },
    plugins: [react()],
    server: {
      fs: {
        allow: [repo]
      }
    }
  }
});
