# NSIS 安装器插件与许可

Windows 安装包由 electron-builder 的 NSIS 目标生成，安装器内嵌以下插件：

| 插件 | 许可 / 说明 | 位置 |
|---|---|---|
| `System.dll`、`nsDialogs.dll`、`nsExec.dll` | NSIS 自带插件，NSIS zlib/libpng 许可 | `upstream/official/nsis-COPYING.txt` |
| `nsis7z.dll` | 基于 7-Zip 19.00，7-Zip License / LGPL-2.1+，含 unRAR 限制；随包源码 | `upstream/official/nsis7z/` |
| `StdUtils.dll` | GNU LGPL-2.1-or-later；随包源码 | `upstream/official/nsis-plugins/stdutils/` |
| `UAC.dll` | ZLIB/LIBPNG License；随包源码 | `upstream/official/nsis-plugins/uac/` |
| `WinShell.dll` | 作者 Anders，上游页面标注 Freeware | `upstream/official/nsis-plugins/winshell/` |

`elevate.exe`（MIT）与 Electron 内置 FFmpeg（LGPL-2.1-or-later）的声明见对应目录。

再分发安装包时请一并保留本目录与 `legal/` 下的各许可证原文。
