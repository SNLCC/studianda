# 第三方许可与本项目许可的兼容性说明

本项目自身代码按 **PolyForm Noncommercial License 1.0.0** 发布；随安装包分发的第三方组件仍适用各自
许可证，二者是**相互独立**的许可层。

## 关键结论

- 项目许可只覆盖本项目原创代码，不改变、不重新授权任何第三方组件；
- 再分发安装包时，必须同时保留项目 `LICENSE` / `NOTICE` 与第三方 `legal/` 中的许可、声明和源码；
- 第三方许可赋予接收者的权利（例如 LGPL 下的源码获取、修改与再分发权利）不能被项目许可限制；
- 本项目按非商业目的发布；PolyForm Noncommercial 1.0.0 对非商业用途的授权与第三方组件的许可并不冲突。

## 主要组件许可

| 组件 | 许可证 | 义务要点 |
|---|---|---|
| 本项目代码 | PolyForm Noncommercial 1.0.0 | 保留 `LICENSE` / `NOTICE`；非商业使用；商业使用需单独授权 |
| Electron | MIT | 保留版权与许可声明 |
| Chromium | BSD-3-Clause 等 | 保留 `LICENSES.chromium.html` |
| Node.js | MIT | 保留 `runtime/Node-LICENSE.txt` |
| FFmpeg（Electron 内置） | LGPL-2.1-or-later | 保留许可；源码与构建配置见 Electron 官方 |
| NSIS 安装器 stub | zlib/libpng | 保留许可声明 |
| NSIS 插件（StdUtils / UAC / WinShell） | LGPL-2.1+ / ZLIB-LIBPNG / 上游标注 Freeware | 保留各自许可、来源与（StdUtils）源码；见 `upstream/official/nsis-plugins/` |
| nsis7z / 7-Zip | 7-Zip License（GNU LGPL-2.1+ 为主，含 unRAR 限制） | 保留许可；随包提供完整对应源码；见 `upstream/official/nsis7z/` |
| 其他 npm 依赖 | 各自许可证 | 见 `inventory.json`、`licenses/`、`THIRD-PARTY.md` |

## LGPL 的特别说明

`nsis7z.dll` / 7-Zip 按 LGPL 分发。LGPL 允许其与本项目代码一起分发，但要求：

1. 显著声明使用了该库，并附上 LGPL 许可文本；
2. 随附完整对应源码（本目录已随包提供）或符合 LGPL §6 的替代方式；
3. 不限制接收者依据 LGPL 修改该库、为调试而反向工程以及再分发的权利。

`nsis7z` 随包源码见 `upstream/official/nsis7z/source/nsis7z/`，7-Zip 源码见
`upstream/official/nsis7z/7z1900-src.7z`。

> 7-Zip 的许可文本允许按 **GNU LGPL 2.1 或更高版本** 使用；本项目按 LGPL 2.1 履行，并随包提供完整
> 对应源码，因此不依赖 LGPL 的“共享库机制”例外。LGPL 并不要求源码必须物理放进安装包，但“随包源码”
> 是最直接、无需书面要约或依赖外部链接的履行方式。

## 分发结构

`nsis7z.dll` 作为独立的 NSIS 插件随安装器分发，和本项目代码是相互独立的组件。项目许可不改变或
重新授权 7-Zip / nsis7z，也不限制 LGPL 赋予接收者的源码获取、修改、调试反向工程与再分发权利；对应
源码与许可原文均已随包提供。

> 本文件是工程合规说明，不构成法律意见。
