# FFmpeg 对应源码书面要约

本安装包内的 `ffmpeg.dll` 来自 **Electron 44.5.1** 官方发行物（`apps/desktop/node_modules/electron/dist/ffmpeg.dll` 及其安装包副本），本项目未修改该文件。

依据 GNU LGPL 2.1-or-later 第 6(c) 条，**Studianda contributors** 向收到本安装包的任何人作出如下书面要约：

> 自包含本文件的安装包发布之日起 **三年内**，任何收到该安装包的第三方均可通过
> <https://github.com/SNLCC/studianda/issues> 提出书面请求，我们将向其提供该
> `ffmpeg.dll` 对应的完整、机器可读的对应源码（包括构建与安装所需的脚本），
> 或者提供从网络服务器下载同一源码的等价方式。除执行提供所需的成本外，不收取
> 额外费用。

本要约是 LGPL 2.1 §6(c) 所要求的书面要约，**不要求接收方在收到安装包时预先作出回应**；
接收方可在上述三年有效期内随时提出书面请求。安装包版本与发布日期以随包的
`build-manifest.json` / `latest.yml` 为准。

对应源码版本：

- Electron：<https://github.com/electron/electron/tree/v44.5.1>
- Electron 官方发行物中的 FFmpeg 源码与构建配置：以 Electron v44.5.1 仓库及其
  `script/`、`third_party/ffmpeg` 相关文件为准；
- 本项目未修改 FFmpeg 源码，也未单独重新编译 `ffmpeg.dll`。

说明：

- 该要约仅针对安装包内的 `ffmpeg.dll`；Electron/Chromium 运行时中的其它二进制
  仍按 `legal/electron/LICENSE.txt` 与 `legal/electron/LICENSES.chromium.html` 分发。
- 本文件是工程合规说明，不构成法律意见；正式商业发布前建议由法务复核要约措辞与
  保存期限。
