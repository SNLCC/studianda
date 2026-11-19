# UAC plug-in for NSIS

- 作者：Anders
- 上游：<https://nsis.sourceforge.io/UAC_plug-in>
- 版本：0.2.4c（2015-05-26）
- 许可：ZLIB/LIBPNG License（见 `LICENSE.txt`）
- 用途：electron-builder 的 NSIS 安装器在需要提权时嵌入并使用 `UAC.dll`
- 源码：`source/`（来自上游 `UAC.zip`，含 `uac.cpp`、`UAC.nsh` 等）
- 本项目未修改该插件
- 本安装器实际嵌入 electron-builder `nsis-resources-3.4.1` 的 `plugins/x86-unicode/UAC.dll`：14,848 字节，SHA-256 `2F7F8FC05DC4FD0D5CDA501B47E4433357E887BBFED7292C028D99C73B52DC08`（可与该资源包核对；本项目未修改）

对应源码与许可原文已随安装包放在 `resources/legal/upstream/official/nsis-plugins/uac/`。
