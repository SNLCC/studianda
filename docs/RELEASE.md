# 发布流程（Windows）

目标：打一个 `v*` 标签，GitHub Actions 自动构建 Windows 安装包、更新元数据与校验文件，创建一个 **draft Release**；人工检查后手动发布。发布后，装有上一版本的客户端可以在应用内检查更新。

相关文件：

- `apps/desktop/electron-builder.yml`：产物命名、`publish`（GitHub）配置；
- `scripts/package.mjs`：一条命令完成构建、打包与更新元数据；
- `scripts/bump-version.mjs`、`scripts/check-version.mjs`：版本同步与校验；
- `.github/workflows/release.yml`：tag 触发的发布流水线；
- `docs/releases/<tag>.md`：发版说明正文，workflow 会读取它。

## 版本号规则

- 使用 SemVer：`x.y.z`；git tag 固定为 `v` + 版本号，例如版本 `0.1.0` 对应 tag `v0.1.0`。
- **版本真源是 `apps/desktop/package.json` 的 `version`**：electron-builder 读它决定安装包名 `Studianda-Setup-<version>.exe` 与 `latest.yml` 里的 `version`。
- 发布时要求 root `package.json`、`apps/desktop/package.json`、`packages/*/package.json` 的 `version` 完全一致，由 `pnpm check:version` 强制校验。**不要手改单个 package.json**，用：

  ```powershell
  node scripts/bump-version.mjs 0.1.1
  ```

- 面向普通用户的版本只发正式版；预发布（Release 勾选 pre-release）不会进入 GitHub 的 latest，`allowPrerelease=false` 的客户端不会收到。

## 发布前检查

1. 工作区干净，`pnpm install --frozen-lockfile` 已通过（lockfile 与 package.json 一致）。
2. 写发版说明：从 `docs/releases/v0.1.0.md` 复制为 `docs/releases/<tag>.md` 并改写内容。
3. 自检版本：`pnpm check:version`。
4. **必须**跑一遍 `pnpm verify`（`typecheck` + `test` + `check:contract` + `check:ui` + `check:telemetry` + `check:governance` + `build`）：全绿才能发版，失败不发布。CI 的 `ci.yml` 在 main 上跑同一入口，本地与 CI 结果应一致。
5. **文档与声明自检**：如果本次发版改动了联网功能、默认行为或数据流向，同步更新 `docs/USAGE-NOTICE.md`（含文档版本与生效日期）与 README「数据与隐私」，并确认 `docs/USAGE-NOTICE.md` 与 `CONTRIBUTING.md` 中的产品边界仍然成立。
6. **备份与回滚预案**：在测试机准备一份资料目录备份；确认回滚目标（上一个已发布版本）与紧急止损方式（见「回滚策略」）；准备发版说明与（如有必要）用户公告。

## 发布检查单

发布前逐项勾选，任何一项不满足就不要打 tag。

**代码与构建**

- [ ] `pnpm install --frozen-lockfile` 通过
- [ ] `pnpm verify` 全绿（typecheck / test / check:contract / check:ui / check:telemetry / check:governance / build）
- [ ] `pnpm check:version` 通过，tag 为 `v` + 版本号
- [ ] `docs/releases/<tag>.md` 已写好，含变更、已知问题（未签名）与校验方法
- [ ] 若改了联网功能或数据流向：`docs/USAGE-NOTICE.md` 与 README「数据与隐私」已同步

**完整性校验**

- [ ] `SHA256SUMS.txt` 与安装包的 SHA256 逐字符一致（忽略大小写）
- [ ] `latest.yml` 的 `version` / `files[0].url` / `files[0].size` / `files[0].sha512` 与实际安装包一致
- [ ] `build-manifest.json` 的版本与 commit 正确，`versions.root` 与 `versions.desktop` 相等
- [ ] `resources/app-update.yml` 存在且可解析（打包脚本会校验）
- [ ] draft Release 的 5 个资产齐全（见「产物与校验」）

**备份与回滚**

- [ ] 测试机的资料目录已备份，并确认过恢复方式（设置 → 数据与维护 → 数据备份）
- [ ] 已确认本次更新不改动资料目录结构；若会改动，先验证旧数据升级路径与回退方式
- [ ] 已确认回滚方式：正常情况发 `x.y.z+1`；紧急情况把有问题的 Release 改回 draft
- [ ] 未删除、替换任何已发布 Release 的资产，未删除或移动 tag
- [ ] 发布后验证：用上一版本安装 → 应用内检查更新 → 下载安装 → 资料目录不受影响

## 发版步骤

```powershell
# 1) 从仓库根目录升级版本（会同步 root / apps/desktop / packages/*）
node scripts/bump-version.mjs 0.1.1

# 2) 写发版说明
#    docs/releases/v0.1.1.md → 参照 docs/releases/v0.1.0.md

# 3) 自检
pnpm check:version

# 4) 提交、打 tag、推送（脚本不会替你做这些）
git add package.json apps/desktop/package.json packages docs/releases/v0.1.1.md
git commit -m "chore(release): v0.1.1"
git tag v0.1.1
git push origin main --tags
```

5. 打开 GitHub → Actions → `Release`，等待 tag 触发的运行结束（超时上限 90 分钟）。流水线会：
   - `pnpm install --frozen-lockfile`；
   - `pnpm check:version`（断言 tag 与版本一致）；
   - `node scripts/package.mjs --installer`（构建、部署 Core、`--dir` 打包、legal 同步、NSIS 安装包、`latest.yml`、`SHA256SUMS.txt`、`build-manifest.json`）；
   - 校验产物；
   - `gh release create <tag> --draft` 上传资产。
6. 检查 draft Release 的 5 个资产（见下表），并装一次验证：版本号正确、资料目录不受影响、应用可正常启动。
7. **确认无误后在 Release 页面点「Publish release」**。draft 阶段对普通用户完全不可见，`/releases/latest` 也不会返回它；只有发布后应用内更新才能发现新版本。
8. 发布后验证：用上一版本安装包安装一份，在应用内检查更新，应能发现新版本并完成下载/安装。

### 失败重跑（dist → draft 之前）

第一次发版如果卡在打包步骤（日志里是 electron-builder 下载 NSIS/winCodeSign 失败、TLS/HTTP 超时之类），按成本从低到高处理：

1. **先点 Re-run all jobs**：构建工具下载失败多为 GitHub 资产 CDN 偶发问题，重跑通常就过。这个操作不会改任何代码。
2. 如果同一步连续失败：workflow 的打包步骤已内置自动重试（最多 3 次，后两次复用已构建产物）。确认这些改动已提交到默认分支后，用 **手动触发** 重跑：
   - 前提：workflow 文件已在 `main` 上（GitHub 只显示默认分支工作流的 Run workflow 按钮）。
   - Actions → `Release` → **Run workflow** → 分支选 `main` → `tag` 输入填 `v0.1.0` → Run。
   - 它构建当前 `main`、发布到已存在的标签 `v0.1.0`。注意：这种情况下 Release 记录的是 `main` 的 commit，而标签仍指向旧提交（`build-manifest.json` 里的 commit 是实际构建的 commit）。
   - 版本号与 tag 必须一致，`check-version` 会拦。
3. 若同 tag 已有 draft Release，`gh release create` 会失败。在 Releases 页面删除该草稿（**不要删 tag**），再重跑。
4. 不要为了重跑而删除/push 新 tag，也不要覆盖已发布 Release 的资产（原因见「回滚策略」）。正式版从 0.1.1 起走正常 tag 流程，标签与构建 commit 会一致。

## 产物与校验

发布资产（都来自 `apps/desktop/release/`，该目录被 `.gitignore` 忽略）。**注意：当前仓库的 Releases 页面可能尚无公开资产（draft 或未发布）；发布前必须确认已点「Publish release」且下列 5 个资产对公众可见，否则应用内更新会报 `No published versions on GitHub`。**

| 文件 | 用途 |
| --- | --- |
| `Studianda-Setup-<version>.exe` | Windows x64 NSIS 安装包 |
| `Studianda-Setup-<version>.exe.blockmap` | 差分更新分块图，electron-updater 增量下载用 |
| `latest.yml` | 更新元数据：版本、文件名、sha512、大小、发布时间 |
| `SHA256SUMS.txt` | 安装包 SHA256，人工/脚本校验用 |
| `build-manifest.json` | 构建信息：版本、commit/dirty、Core 与产物 hash |

用户下载后可以这样核对安装包：

```powershell
Get-FileHash .\Studianda-Setup-0.1.0.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
# 两行 hash 应一致（SHA256SUMS.txt 为小写，Get-FileHash 默认大写，逐字符比较时忽略大小写）
```

`latest.yml` 里的 `sha512` 是安装包的 SHA-512 base64 摘要，由 electron-updater 下载后自动校验，普通用户不需要手动计算。

## draft → 发布

- draft Release 不参与 GitHub 的 latest 计算，也不会被 `electron-updater` 看到——这是先建 draft 的意义：构建、上传、安装测试都在不影响现有用户的前提下完成。
- 「Publish release」后，`/releases/latest` 立即指向新版本，已安装的客户端下一次检查更新即可收到。
- 勾选 pre-release 的 Release 不会成为 latest；正式版不要勾。

## 回滚策略：只能向前发新版本

- `electron-updater` 只认 GitHub 的 latest Release，且客户端可能已经缓存了 `latest.yml` 与差分块，**不支持降级**到旧版本。
- **不要删除、替换已发布 Release 的资产**（exe / blockmap / latest.yml），**不要删除或移动 tag**。删除资产会让 `latest.yml` 指向 404，用户更新直接失败；替换同名资产会让已下载的差分块与文件 hash 对不上。
- 发现严重问题时：
  1. 正常做法：发布下一个版本（`x.y.z+1`）修复，走同一流程。
  2. 紧急止损：把有问题的 Release **改回 draft**（GitHub Release 页面 Edit → 勾选 draft 后更新），这样 latest 会退回上一个已发布版本；随后尽快发新版本。改回 draft 期间已下载新版本的用户仍可能装上问题版本，因此仍需发版修复。
  3. 不建议让用户手动安装旧版本回退；资料目录与数据库结构可能已按新版本写入。

## 未签名说明

- 当前发布不使用代码签名证书。安装包与主程序没有签名，Windows SmartScreen 可能提示「未知发布者」或「Windows 已保护你的电脑」；用户需要点「更多信息 → 仍要运行」。
- 应用内更新通过 HTTPS 从 GitHub 下载，并用 `latest.yml` 里的 `sha512` 校验安装包完整性；但这不等于代码签名验证，不能证明发布者身份。
- 后续如果接入代码签名，需要同步更新 electron-builder 签名配置、本文件与 README 的「更新」说明。

## 排障

| 现象 | 处理 |
| --- | --- |
| `pnpm check:version` 失败 | 用 `node scripts/bump-version.mjs <ver>` 统一版本；确认 tag 是 `v` + 版本号 |
| workflow 第一步报「必须由 v* 标签触发」 | 用标签 ref 手动触发，或按流程 push tag |
| 打包报「未找到安装包 Studianda-Setup-<v>.exe」 | 检查 `electron-builder.yml` 的 `artifactName` 是否被改动，需与 `scripts/package.mjs` 的命名一致 |
| `latest.yml` 缺失或与包不一致 | `scripts/package.mjs` 会优先校验 electron-builder 的产物，缺失/对不上时按实际安装包重新生成 |
| 更新检查提示「没有更新配置」 | 安装包 `resources/app-update.yml` 缺失或 YAML 不合法；`scripts/package.mjs` 会按 `publish` 配置重写并校验（值带引号），检查打包日志与客户端 `%APPDATA%\Studianda\update.log` |
| Electron / NSIS 下载失败 | 重跑 workflow：打包步骤已自动重试 3 次（间隔 20 秒，后两次 `--skip-build`）。若反复失败，可考虑给 workflow 设置 `ELECTRON_BUILDER_BINARIES_MIRROR` 指向可信镜像（默认不启用） |
| `gh release create` 报已存在 | 删除旧 draft（不删 tag）后重跑 |

## 相关

- 打包细节：见 [PACKAGING.md](PACKAGING.md)。
- 发版说明模板：见 [docs/releases/v0.1.0.md](releases/v0.1.0.md)。
- 产品边界与提交要求：见 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [USAGE-NOTICE.md](USAGE-NOTICE.md)。
- 使用须知与逐功能数据流向：见 [USAGE-NOTICE.md](USAGE-NOTICE.md)。
