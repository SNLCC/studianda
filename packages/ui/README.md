# @studianda/ui

Studianda 的 React 组件与样式包。**React / React DOM 是 peerDependencies**，由宿主提供。

## 使用

```tsx
// 样式（含 @font-face 与全局宣纸主题 token）
import '@studianda/ui/styles.css';
import '@studianda/ui/qa.css';

// 组件
import { ChatPanel, DocumentList, MarkdownEditor } from '@studianda/ui';
```

- 样式文件在 `src/styles/`，字体在 `src/styles/assets/fonts/`（10 个 woff2，约 38 MB，OFL 许可，见 `legal/`）。
- 样式目前仍是**全局** `kr-*` 选择器（含 `:root` token 与 `body` 规则）。挂载到非本应用宿主时，
  建议给容器加 `kr-root` 类。
- 本包**不依赖 Electron / Vite 专属语法**；`dist/` 是 ESM 并用 `packages: external` 保留
  `react`、`react-dom`、`@studianda/shared` 等运行时依赖，可由任意 bundler 消费。

## 构建

```bash
pnpm --filter @studianda/shared build
pnpm --filter @studianda/ui build   # dist/index.js + 逐文件 .d.ts（scripts/build-lib.mjs）
```

- 类型声明通过 `tsconfig.build.json` 生成，引用 `@studianda/shared` 的 dist 类型；
  因此构建前必须先生成 shared 的 `dist`。
- `styles.css` / `qa.css` 与字体作为源码资产随包提供（`exports` 直接指向 `src/styles/*`），
  不复制进 `dist/`，避免每次构建重复拷贝 38 MB 字体。

## 宿主集成约定

- 样式已做**作用域收口**：页面级布局只在 `body:has(.kr-desktop)`（桌面壳）生效；
  `button/input/select/textarea/a`、`box-sizing`、滚动条等规则限定在 `.kr-root` 内。
  `<StudiandaApp>`、`BootstrapGate` 与 portal（目录生成/设置 toast）都会渲染 `.kr-root` 挂载点；
  宿主应把 `<StudiandaApp>` 放进一个有确定高度/滚动策略的容器。
- 背景/宣纸纹理由桌面壳 `body:has(.kr-desktop)` 提供；宿主若需要同一主题背景，可自行设置
  `background: var(--kr-paper)` 或在容器上加 `kr-root` 样式。
- 原生 `confirm/alert/prompt` 通过 `appDialogs`/`confirmAction` 注入，宿主可覆盖。

## 宿主集成限制

- 全局样式作用域已收口，但尚未在独立宿主工程做完整视觉回归；正式接入前建议在宿主中走一遍主要页面。
- `@studianda/app` 已不再包含 Vite 专属导入；它的 `dist` 要求宿主在挂载时提供 pdf.js worker
  资源（`<StudiandaApp pdfWorkerUrl={...} />`），桌面壳用 Vite `?url` 传入。
  `@studianda/ui` 本身无任何 Vite 依赖。
