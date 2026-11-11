# 桌面端打包

## 前置

- Node 24；
- pnpm 10；
- 已安装依赖；
- 不要在 `ELECTRON_RUN_AS_NODE=1` 的终端里启动应用，否则 Electron 会按 Node 解释参数。

## 一条命令打包

```powershell
# 仓库根目录；默认生成未安装目录 apps/desktop/release/win-unpacked
node scripts/package.mjs

# 额外生成 NSIS 安装包与更新元数据（latest.yml / SHA256SUMS.txt）
node scripts/package.mjs --installer

# 复用已有 dist/out，只重打包（调试打包配置时用）
node scripts/package.mjs --skip-build
```

脚本会依次：构建 shared/core/desktop → 清理并 `pnpm deploy` Core → 校验
`out/core/dist/index.js` 与 `packages/core/dist/index.js` 的 sha256 一致 → 调 electron-builder
（`--dir`）→ 重新生成并同步 `legal/` → 补齐并校验 `resources/app-update.yml` →
（`--installer` 时）用 `--prepackaged` 生成 NSIS 安装包 → 校验 `latest.yml`、写
`SHA256SUMS.txt` → 写 `apps/desktop/release/build-manifest.json`。不一致会直接退出 1，
避免把旧的手工 `out/core` 打进安装包。

两处 electron-builder 调用都显式带 `--publish never`：**打包脚本永远不会发布**，发布只由
`.github/workflows/release.yml` 用 `gh release` 完成，避免 CI 环境里被 electron-builder 隐式发布。

> Core deploy 不使用 `--legacy`，会从 `pnpm-lock.yaml` 解析版本，部署结果与 lockfile 一致。
> deploy 需要访问 registry（本地 store 已缓存全部 tarball 时可离线）。
> 打包会自动在生成 `app.asar` 后重跑 `legal:generate`，并校验 `legal/inventory.json` 与实际 asar 的包集合、字体声明一致。
> `--installer` 需要 electron-builder 的 nsis/winCodeSign 缓存；网络受限时先用 `--dir` 验证。

## 版本号

- electron-builder 读取 **`apps/desktop/package.json` 的 `version`**，决定安装包名
  `Studianda-Setup-<version>.exe` 与 `latest.yml` 的 `version`；
- root `package.json` 与 `packages/*/package.json` 的 `version` 必须与它一致，
  `node scripts/check-version.mjs` 会校验；升级用 `node scripts/bump-version.mjs <x.y.z>`，
  不要手改单个文件；
- `build-manifest.json` 同时记录 `versions.root` 与 `versions.desktop`，写盘前后都会断言两者相等，
  避免出现「manifest 版本是 root 的、安装包版本是 desktop 的」这种偏差。

## 产物

`--installer` 在 `apps/desktop/release/` 下产出：

```text
win-unpacked/                              未安装目录（Studianda.exe + resources/）
Studianda-Setup-<version>.exe              NSIS 安装包（per-user，可改安装目录）
Studianda-Setup-<version>.exe.blockmap     差分更新分块图（electron-updater 增量下载用）
latest.yml                                 更新元数据（版本、文件名、sha512、大小、发布时间）
SHA256SUMS.txt                             安装包 SHA256（"<sha256>  Studianda-Setup-<v>.exe"）
build-manifest.json                        构建信息（版本、commit/dirty、Core 与产物 hash）
```

`win-unpacked/resources/app-update.yml` 是应用内更新的渠道配置（provider/owner/repo 等），
会随安装包一起打进用户机器。

## 更新元数据（latest.yml / app-update.yml）

- `publish` 配置在 `apps/desktop/electron-builder.yml`：GitHub、`owner: SNLCC`、
  `repo: studianda`、`releaseType: draft`；`electronUpdaterCompatibility: '>= 2.16'` 让
  electron-builder 生成 electron-updater 2.16+ 格式的元数据。
- electron-builder 在真正打包 NSIS target 并产出安装包后生成 `latest.yml`；
  本脚本的两段式打包（`--dir` → `--prepackaged`）仍会触发这一步，但如果文件缺失或其中
  `version` / `path` / `files[0].size` / `files[0].sha512` 与实际安装包不一致，
  `scripts/package.mjs` 会按实际产物重新生成一份，格式为：

  ```yaml
  version: 0.1.0
  files:
    - url: Studianda-Setup-0.1.0.exe
      sha512: <安装包 SHA-512，base64>
      size: 246069769
  path: Studianda-Setup-0.1.0.exe
  sha512: <同上>
  releaseDate: <ISO 时间>
  ```

- `app-update.yml` 只在 electron-builder 真正打包 NSIS target 的 `afterPack` 阶段写入；
  本脚本的 `--dir` / `--prepackaged` 路径都不经过该阶段，因此 `scripts/package.mjs`
  会在 `--dir` 之后按 `publish` 配置**每次重写**该文件（不保留旧文件），并校验
  `provider` / `owner` / `repo` 等字段。写入时所有值都加 YAML 双引号：
  `updaterCacheDirName` 以 `@` 开头（包名 `@studianda/desktop` 清洗而来），裸写会让
  js-yaml 解析失败，客户端表现为"检查更新失败"。
  注意：应用内更新只依赖安装包里的 `app-update.yml`，不依赖这里的构建脚本。
- `latest.yml` 必须作为 Release 资产上传；electron-updater 从最新已发布 Release 里读取它。

## 发布：不要用 git 存安装包

- `apps/desktop/release/` 已被 `.gitignore` 忽略；**安装包、blockmap、latest.yml、
  SHA256SUMS.txt、build-manifest.json 都不要提交进 git**。仓库只存源码与可复现的打包脚本。
- 发布走 GitHub Actions：打 `v*` tag → `.github/workflows/release.yml` 构建 → 创建 draft
  Release 并上传上述资产 → 人工检查后发布。完整步骤与回滚策略见 [RELEASE.md](RELEASE.md)。
- 本地手工打出的安装包仅用于验证；不要直接上传到已发布的 Release，也不要用它覆盖线上资产
  （会让 `latest.yml`、blockmap 与用户已下载的差分块对不上）。

## Core 独立运行（诊断）

```powershell
node packages/core/dist/index.js --help
node packages/core/dist/index.js --check --data-dir <目录>     # 数据目录/SQLite 自检，退出码 0/1
node packages/core/dist/index.js --print-runtime --data-dir <目录> --port 0
#   → stdout 输出 {port,token,pid,version,startedAt}，父进程无需再读 runtime.json
```

`--data-dir` 优先于 `STUDIANDA_DATA_DIR`；`--port` 默认 0（随机端口，只绑定 127.0.0.1）。

## 手工步骤（排障用）

```powershell
# 在仓库根目录执行

# 1. 构建 Core
pnpm --filter @studianda/core build

# 2. 部署扁平 node_modules（out/core 是构建产物，已存在时先删除，否则 pnpm 报 ERR_PNPM_DEPLOY_DIR_NOT_EMPTY）
pnpm --filter @studianda/core deploy --prod `
  --config.node-linker=hoisted `
  --store-dir "$PWD/.pnpm-store" `
  apps/desktop/out/core

# 3. 构建桌面主进程/预加载/渲染层
pnpm --filter @studianda/desktop build

# 4. 生成未安装目录（--publish never：手工验证也绝不发布）
cd apps/desktop
pnpm exec electron-builder --dir --publish never --config electron-builder.yml
```

产物：

```text
apps/desktop/release/win-unpacked/Studianda.exe
```

## 当前配置

- 安装包命名：`artifactName: Studianda-Setup-${version}.${ext}`（Windows NSIS 安装包即
  `Studianda-Setup-<version>.exe`）；electron-updater 的 `latest.yml` 与它绑定，改名前先读
  [RELEASE.md](RELEASE.md)；
- 自动更新渠道：`publish: { provider: github, owner: SNLCC, repo: studianda, releaseType: draft }`；
- Core 部署到 `out/core`；
- 打包时 `out/**/*` 进入 `app.asar`；
- 原生模块 `.node`、`@napi-rs/canvas`、`tesseract.js`、`tesseract.js-core` 通过 `asarUnpack` 解包；
- 主进程打包后从 `app.asar/out/core/dist/index.js` 启动 Core；
- 安装包通过 `extraResources` 携带 `legal/`（第三方清单、许可证原文、Electron/Chromium/Node 声明）；
- 源码仓库同时保留 `LICENSE`、`NOTICE`、`legal/`。

## 安装与资料位置

- NSIS 使用辅助安装：`oneClick: false`，允许用户修改安装目录；
- 安装过程不询问资料位置；首次启动时在应用内选择：
  - 用户点击「选择资料文件夹」，选中后本地服务才启动；
  - 选择安装目录或其子目录会直接显示错误并停留在当前页面；
  - 可新建或选择其他盘/文件夹；
  - 选择「退出勘读」直接关闭应用；
- 指针保存在 `%APPDATA%\Studianda\storage.json`；
- 设置页「资料位置」可查看当前路径并更改：
  - 要求选择空文件夹；
  - 写入待迁移标记；
  - 重启时复制当前资料到新位置；
  - 复制成功后更新指针；
  - 采用复制方式，原目录文件保留作为安全备份；
  - 设置页和确认框都会明确提示原目录不会自动删除。
- 静默安装不弹窗，首次启动再选择；
- 卸载默认不删除资料；资料在安装目录外，更新/卸载只处理程序目录；
- 安装程序配置 `nsis.license: build/INSTALLER-NOTICE.txt`，安装前显示项目许可、第三方范围和风险摘要。

> `apps/desktop/build/INSTALLER-NOTICE.txt` 必须保存为 **UTF-8 with BOM**。Windows 的 `makensis`
> 只有在许可证文件带 UTF-8 BOM 时才按 UTF-8 解析，否则按系统 ANSI 代码页（简体中文系统为 GBK）
> 解码，安装器许可证页会整页乱码；electron-builder 26.18.0 对 `nsis.license` 指定的自定义文件
> 不会再补 BOM（只有 `license_<lang>.txt` 走自动补 BOM 的分支），所以 BOM 必须存在于文件本身。
> 核对：`$b=[System.IO.File]::ReadAllBytes('apps/desktop/build/INSTALLER-NOTICE.txt'); ($b[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' '` 应为 `EF BB BF`。

## 代码签名

当前不使用代码签名证书，安装包与主程序均未签名：Windows SmartScreen 可能提示「未知发布者」。
应用内更新依赖 HTTPS 下载 + `latest.yml` 中的 sha512 校验完整性，但这不等于发布者身份签名。
接入签名后需要同步更新 electron-builder 的签名配置、[RELEASE.md](RELEASE.md) 与 README 的更新说明。
