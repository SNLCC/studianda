# 第三方许可与本项目许可的兼容性说明

本项目自身代码按 **Apache License 2.0** 发布；随安装包分发的第三方组件仍适用各自
许可证，二者是**相互独立**的许可层。

## 关键结论

- 项目许可只覆盖本项目原创代码，不改变、不重新授权任何第三方组件（包括随包字体、PDF.js 资源、
  安装器插件与 Electron 运行时）；
- 再分发安装包时，需要保留项目 `LICENSE` / `NOTICE` 与第三方 `legal/` 中的许可、声明和源码（这是 Apache-2.0 与各第三方许可证的要求）；
- 第三方许可赋予接收者的权利（例如 LGPL 下的源码获取、修改与再分发权利，MPL 下对源码的权利）
  不能被项目许可限制；
- 本项目采用 OSI 认可的开源许可 Apache License 2.0；其授权与第三方组件的许可并不冲突。

## 主要组件许可

| 组件 | 许可证 | 义务要点 |
|---|---|---|
| 本项目代码 | Apache License 2.0 | 保留 `LICENSE` / `NOTICE`（含归属声明） |
| Electron | MIT | 保留版权与许可声明 |
| Chromium | BSD-3-Clause 等 | 保留 `LICENSES.chromium.html` |
| Node.js | MIT | 保留 `runtime/Node-LICENSE.txt` |
| FFmpeg（Electron 内置） | LGPL-2.1-or-later | 保留许可；源码与构建配置见 Electron 官方（见下文「FFmpeg」） |
| NSIS 安装器 stub | zlib/libpng | 保留许可声明 |
| StdUtils（NSIS 插件） | LGPL-2.1-or-later + 作者澄清 | 逐字使用 DLL；保留许可、澄清与源码 |
| UAC（NSIS 插件） | ZLIB/LIBPNG | 保留许可、来源与源码 |
| nsis7z / 7-Zip | 7-Zip License（GNU LGPL-2.1+ 为主，含 unRAR 限制） | 保留许可；随包提供完整对应源码；记录随包 DLL 来源与哈希 |
| **WinShell（NSIS 插件）** | **无许可文本，仅 "Freeware"** | **已移除，不再随包分发（见下文）** |
| PDF.js 资源（CMaps、标准字体、ICC、WASM） | Adobe BSD-3 / PDFium BSD-3 / CC0-1.0 / BSD-2 / MIT / Apache-2.0 | 保留各自许可与版权行 |
| libjpeg-turbo（内嵌于 Tesseract WASM 与 `skia.node`） | IJG + Modified BSD | 仅分发二进制时，文档须包含 IJG 固定署名句（已写入） |
| 随包字体（9 个 woff2） | SIL Open Font License 1.1 | 保留 OFL 与版权行；子集化/改名按 §3、§5 合规；**不属于本项目许可范围** |
| 其他 npm 依赖 | 各自许可证 | 见 `inventory.json`、`licenses/`、`THIRD-PARTY.md` |

## 强制署名：libjpeg-turbo（IJG）

libjpeg-turbo 同时受 IJG 与 Modified BSD 约束；在只分发二进制（本项目随包的 Tesseract WASM 与
`skia.node` 即为二进制）时，IJG 要求在**产品文档**中写明：

> This software is based in part on the work of the Independent JPEG Group.

该句已写入 `legal/THIRD-PARTY.md`、`legal/NOTICE.html` 与安装许可提示 `apps/desktop/build/INSTALLER-NOTICE.txt`。

## MPL-2.0：`@napi-rs/canvas` 内的 4 个组件

`cssparser`、`cssparser-macros`、`dtoa-short`、`selectors` 为 MPL-2.0（文件级弱 copyleft）。
MPL-2.0 §3.2(a) 要求：以可执行形式分发时，必须同时**提供源码**并告知接收方获取方式。

本项目为此随包提供这四个组件的**未修改上游源码归档**：

- 目录：`legal/upstream/official/napi-canvas/mpl-sources/`
- 内容：`cssparser-0.38.0.crate`、`cssparser-macros-0.7.0.crate`、`dtoa-short-0.3.5.crate`、
  `selectors-0.41.0.crate`（crates.io 发布包原样），逐一记录 SHA-256，见同目录 `README.md`；
- 安装包内路径：`resources/legal/upstream/official/napi-canvas/mpl-sources/`；
- 同时保留官方仓库地址，接收方也可从上游获取同一版本。

MPL-2.0 §3.2(b) 要求可执行形式的条款不得限制接收方对源码的权利：`THIRD-PARTY.md` 已声明本项目
许可不改变、不限制第三方组件在其许可下的权利。

## 快捷方式 AppUserModelID：WinShell 已由本项目脚本实现替代

`WinShell.dll` 的上游页面只标注 "License: Freeware"，官方发行包内只有两个 DLL，没有许可文本、
没有源码 —— 不构成再分发授权。electron-builder 的 NSIS 模板原本调用
`WinShell::SetLnkAUMI` / `WinShell::UninstShortcut` / `WinShell::UninstAppUserModelId`，
从而把该 DLL 嵌进安装器。

本项目**不再随包分发该 DLL**，但**保留了原行为**：`scripts/patch-nsis-templates.mjs` 在打包前把
这些调用改写为 `apps/desktop/build/nsis/aumid.nsh` 里的宏；该宏用 NSIS 自带的 System 插件与官方
`Win\COM.nsh` / `Win\Propkey.nsh` 定义，调用 Windows 公开 API（`CLSID_ShellLink` →
`IPersistFile` → `IPropertyStore` → `PKEY_AppUserModel_ID`）写入/清除快捷方式属性，并调用
`IPersistFile::Save` 落盘。

- 不包含任何第三方插件，也没有自编译 DLL：全部是安装器脚本；
- 安装时仍会像以前一样，在开始菜单/桌面快捷方式上写入 `com.studianda.app` 这个 AUMID；
- 卸载与快捷方式迁移时仍会清除旧快捷方式的该属性；
- 应用启动时也仍调用 `app.setAppUserModelId(...)`，与快捷方式属性一致。

实现细节与验证方式见 `legal/upstream/official/nsis-plugins/winshell/README.md` 与
`apps/desktop/build/nsis/aumid.nsh`。

## FFmpeg（Electron 内置 `ffmpeg.dll`）

- `ffmpeg.dll` 由 Electron 官方构建提供，本项目**未修改**，且以独立 DLL 形式存在、可被替换；
- 许可全文随包：`legal/upstream/official/ffmpeg-LGPL-2.1.txt`；
- 对应源码：Electron 在其官方仓库 <https://github.com/electron/electron> 公开 FFmpeg 源码与构建配置，
  版本与本安装包内的 Electron 版本一致（见 `legal/inventory.json` 的 `electron` 字段）；
- 本项目在此作出书面说明：如需该 FFmpeg 构建的对应源码，请按上述仓库的对应版本获取；本项目不分发、
  也不修改 FFmpeg 源码。

依据：LGPL-2.1 §6 要求随作品提供对应源码或以书面方式告知获取途径；本项目以“DLL 可替换 + 上游公开
源码 + 本文书面说明”履行。

## Electron 随包的运行时二进制（补充说明）

`Studianda.exe` 同目录下的 `d3dcompiler_47.dll`、`dxcompiler.dll`、`dxil.dll`、`vulkan-1.dll`、
`vk_swiftshader.dll`、`icudtl.dat`、`ffmpeg.dll` 均由 Electron/Chromium 发行物提供，本项目未修改。
其版权与许可声明随 `LICENSES.chromium.html` 一并分发；来源与许可依据的补充说明见
`legal/upstream/official/electron-runtime-dlls.md`。

## LGPL 的特别说明

`nsis7z.dll` / 7-Zip 按 LGPL 分发。LGPL 允许其与本项目代码一起分发，但要求：

1. 显著声明使用了该库，并附上 LGPL 许可文本；
2. 随附完整对应源码（本目录已随包提供）或符合 LGPL §6 的替代方式；
3. 不限制接收者依据 LGPL 修改该库、为调试而反向工程以及再分发的权利。

`nsis7z` 随包源码见 `upstream/official/nsis7z/source/nsis7z/`，7-Zip 源码见
`upstream/official/nsis7z/7z1900-src.7z`。实际随包 DLL 的来源与 SHA-256 记录在
`upstream/official/nsis7z/README.md`。

> 7-Zip 的许可文本允许按 **GNU LGPL 2.1 或更高版本** 使用；本项目按 LGPL 2.1 履行，并随包提供完整
> 对应源码，因此不依赖 LGPL 的“共享库机制”例外。LGPL 并不要求源码必须物理放进安装包，但“随包源码”
> 是最直接、无需书面要约或依赖外部链接的履行方式。

## 构建工具：electron-builder（MIT，不随包分发）

安装器的 NSIS 脚本基于 **electron-builder**（MIT，Copyright (c) 2015 Loopline Systems；作者
Vladimir Krivosheev 及贡献者）的模板。本项目在构建期按自身需要修改该模板
（`scripts/patch-nsis-templates.mjs`：把 WinShell 插件调用改为本项目自己的脚本实现，见
`apps/desktop/build/nsis/aumid.nsh`）；修改后的模板只存在于构建时的 `node_modules` 中，
**不随安装包分发**，安装包中也不包含 electron-builder 的源码或二进制。

electron-builder 的 MIT 许可声明由其 npm 包内的 `LICENSE` 文件携带；本项目没有再分发该包，因此
不产生额外的声明义务。此处记录仅为权属与来源说明，并致谢其作者与贡献者。

## 分发结构

`nsis7z.dll` 作为独立的 NSIS 插件随安装器分发，和本项目代码是相互独立的组件。项目许可不改变或
重新授权 7-Zip / nsis7z，也不限制 LGPL 赋予接收者的源码获取、修改、调试反向工程与再分发权利；对应
源码与许可原文均已随包提供。

> 本文件是工程合规说明，不构成法律意见。
