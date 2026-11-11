# NSIS 7z 解压插件（nsis7z）与 7-Zip 许可

## 这是什么

Windows 安装包 `Studianda-Setup-*.exe` 由 electron-builder 的 NSIS 目标生成；安装时使用 NSIS 插件
`nsis7z.dll` 解压内嵌的 `app-64.7z` 应用负载。`nsis7z.dll` 基于 7-Zip 源码，**随安装包分发**，
因此需要按 7-Zip 的许可要求随附许可信息，并履行 LGPL 的源码提供义务。

- 插件：Nsis7z 19.00（2019-03-24），作者 Nik Medved（brainsucker）
- 上游基于：7-Zip 19.00，Copyright (C) 1999-2019 Igor Pavlov
- 插件来源：<https://nsis.sourceforge.io/Nsis7z_plug-in>
- 7-Zip 官方源码：<https://www.7-zip.org/source/>
- 本项目使用 electron-builder `nsis-resources-3.4.1` 中预编译的 `nsis7z.dll`，未修改其源码

## 许可

适用 7-Zip License（插件页明确说明“follows 7-Zip source code license”）：

- `LICENSE.txt`：7-Zip 的许可说明（GNU LGPL 为主；部分代码 BSD-3-Clause / BSD-2-Clause；
  含 unRAR license restriction）
- `LGPL-2.1.txt`：GNU Lesser General Public License 2.1 全文
- `unRAR-LICENSE.txt`：unRAR 许可限制说明

根据 7-Zip 许可，以二进制形式再分发时必须复现相关许可信息；本目录随安装包放在
`resources/legal/upstream/official/nsis7z/`，并在 `legal/THIRD-PARTY.md`、`legal/NOTICE.html`、
`legal/SOURCES.md` 与安装许可提示中引用。

unRAR 限制：7-Zip 中的 RAR 解压引擎基于 unRAR 源码，其许可禁止用该代码反向实现 RAR 压缩算法，
并要求在文档与源码注释中明确说明。本项目只使用 NSIS 插件解压 7z 应用负载，不提供 RAR 压缩/解压功能。

## 对应源码（随包提供）

为满足 LGPL 2.1 §4 / §6(a) 的源码要求，本目录**直接随包提供**对应源码，不依赖书面要约：

- `source/nsis7z/`：nsis7z 19.00 插件源码（来自 Nsis7z_19.00.7z 的 `Contrib/nsis7z/`）
- `7z1900-src.7z`：7-Zip 19.00 官方源码归档
  - SHA-256：`9ba70a5e8485cf9061b30a2a84fe741de5aeb8dd271aab8889da0e9b3bf1868e`
- 上游归档（供核对）：<https://www.7-zip.org/a/7z1900-src.7z>、
  <https://nsis.sourceforge.io/mediawiki/images/6/69/Nsis7z_19.00.7z>

来源与版本如下，构建时为可重链接需要，未修改上游源码：

| 组件 | 版本/来源 | SHA-256 |
|---|---|---|
| nsis7z 插件 | Nsis7z 19.00（2019-03-24），`Contrib/nsis7z` | `6f2f3730049926f40442ee0c8b7d3e3dee7ace544d82467ff8059ea3f4201c58`（归档） |
| 7-Zip | 7-Zip 19.00 源码归档 | `9ba70a5e8485cf9061b30a2a84fe741de5aeb8dd271aab8889da0e9b3bf1868e` |

## 与项目许可证（PolyForm Noncommercial 1.0.0）的关系

这是两个**相互独立**的许可层，不是把 7-Zip 重新按项目许可授权：

- 项目自身代码（包括本仓库的安装器脚本、应用代码）按 **PolyForm Noncommercial License 1.0.0** 发布；
- `nsis7z.dll` / 7-Zip 代码仍按 **7-Zip License（GNU LGPL-2.1+ 等）** 发布，任何再分发都必须保留
  LGPL 赋予接收者的权利，不能用项目许可限制这些权利；
- LGPL 允许把该库与采用其他条款的作品一起分发，条件是履行 LGPL 的声明、许可与源码义务；本项目通过
  “随包提供完整对应源码 + 许可原文”满足这一点；
- unRAR restriction 只约束 7-Zip 中 RAR 相关代码的使用，本项目不提供 RAR 压缩/解压功能；
- 上述结论是工程合规说明，不构成法律意见；正式发布前建议由法务复核。

## 重新构建

构建安装包时，electron-builder 会把 `nsis7z.dll` 编译进 NSIS 安装器；完整安装器模板与构建配置见
`apps/desktop/electron-builder.yml` 与 `scripts/package.mjs`。7-Zip 与 nsis7z 的上游源码未修改。
