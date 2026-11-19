# NSIS 安装器插件与许可

Windows 安装包由 electron-builder 的 NSIS 目标生成，安装器内嵌以下插件：

| 插件 | 许可 / 说明 | 位置 |
|---|---|---|
| `System.dll`、`nsDialogs.dll`、`nsExec.dll` | NSIS 自带插件，NSIS zlib/libpng 许可 | `upstream/official/nsis-COPYING.txt` |
| `nsis7z.dll` | 基于 7-Zip 19.00，7-Zip License / LGPL-2.1+，含 unRAR 限制；随包源码 | `upstream/official/nsis7z/` |
| `StdUtils.dll` | GNU LGPL-2.1-or-later；随包源码 | `upstream/official/nsis-plugins/stdutils/` |
| `UAC.dll` | ZLIB/LIBPNG License（0.2.4c；x86-unicode DLL 14,848 B，SHA-256 `2F7F8FC05DC4FD0D5CDA501B47E4433357E887BBFED7292C028D99C73B52DC08`）；随包源码 | `upstream/official/nsis-plugins/uac/` |
| ~~`WinShell.dll`~~ | **已由脚本实现替代**：上游只有 "Freeware" 标注、无许可文本与源码，不构成再分发授权；`scripts/patch-nsis-templates.mjs` 把调用改写为 `apps/desktop/build/nsis/aumid.nsh` 的宏（Windows 公开 API，不随包 DLL） | `upstream/official/nsis-plugins/winshell/`（替代记录与证据） |

`elevate.exe`（MIT）与 Electron 内置 FFmpeg（LGPL-2.1-or-later）的声明见对应目录。

再分发安装包时请一并保留本目录与 `legal/` 下的各许可证原文。
