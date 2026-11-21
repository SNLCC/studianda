# FFmpeg 对应源码书面要约

本安装包（`Studianda-Setup-<版本号>.exe`，版本号见安装包文件名；其中的 `resources/ffmpeg.dll` 副本）内的
`ffmpeg.dll` 来自 **Electron 44.5.1 官方发行物**（`apps/desktop/node_modules/electron/dist/ffmpeg.dll`），
本项目**未修改**该文件，也未单独重新编译它。

依据 GNU LGPL 2.1-or-later 第 6(c) 条，**Studianda contributors** 向收到本安装包的任何人作出如下书面要约：

> 自包含本文件的安装包发布之日起 **三年内**，任何收到该安装包的第三方均可通过
> <https://github.com/SNLCC/studianda/issues> 提出书面请求，我们将向其提供该
> `ffmpeg.dll` 对应的**完整、机器可读的对应源码**（包括构建与安装所需的脚本、构建参数与
> Electron 对 FFmpeg 的补丁），或者提供从网络服务器下载同一源码的等价方式。
> 我们将在收到请求后 30 日内完成交付。除执行提供所需的成本外，不收取额外费用。

本要约是 LGPL 2.1 §6(c) 所要求的书面要约，**不要求接收方在收到安装包时预先作出回应**；
接收方可在上述三年有效期内随时提出书面请求。

要约所指的安装包是本文件随附的 Studianda Windows x64 安装包（版本号见安装包文件名 `Studianda-Setup-<版本号>.exe`）；该安装包文件的发布日期与
SHA-256 见对应 GitHub Release 页面及其 `SHA256SUMS.txt` / `build-manifest.json`。上述发布
页面由本项目长期维护，不依赖安装包内的额外文件。

## 对应源码的版本与获取位置（全部为官方来源）

| 内容 | 版本 | 官方位置 |
|---|---|---|
| Electron 主仓库（含 FFmpeg 构建参数与补丁） | v44.5.1 | <https://github.com/electron/electron/tree/v44.5.1> |
| Electron FFmpeg 构建参数 | v44.5.1 | <https://github.com/electron/electron/blob/v44.5.1/build/args/ffmpeg.gn>（配合同目录 `all.gn` / `release.gn`） |
| Electron 对 FFmpeg 的补丁 | v44.5.1 | <https://github.com/electron/electron/tree/v44.5.1/patches/ffmpeg> |
| Electron 固定的 Chromium 版本 | 152.0.7977.130 | <https://github.com/electron/electron/blob/v44.5.1/DEPS> |
| Chromium / FFmpeg 完整源码 | Chromium 152.0.7977.130 tag 的 `third_party/ffmpeg`（其精确 revision 由该 tag 的 `DEPS` 固定） | <https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/third_party/ffmpeg> 与 <https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/DEPS> |
| Electron 官方发行物（含 `ffmpeg.dll` 实物） | v44.5.1 | <https://github.com/electron/electron/releases/tag/v44.5.1> |

获取方式（任选其一，均为上游官方渠道）：

1. 按上述 tag 克隆 Electron 与 Chromium 源码后，使用 `build/args/ffmpeg.gn` 与 Electron
   `patches/ffmpeg/` 还原构建；
2. 或按本要约向本项目提出书面请求，由本项目提供与 `ffmpeg.dll` 对应的源码压缩包
   （含 `third_party/ffmpeg` 在该 Chromium revision 下的完整源码、Electron 补丁与构建参数），
   交付方式与期限如要约所述。

本项目未修改 Chromium `third_party/ffmpeg` 的源码；`ffmpeg.dll` 与 Electron 官方发行物中的
同名文件逐字节一致。

## 说明

- 该要约仅针对安装包内的 `ffmpeg.dll`；Electron/Chromium 运行时中的其它二进制仍按
  `legal/electron/LICENSE.txt` 与 `legal/electron/LICENSES.chromium.html` 分发。
- `ffmpeg.dll` 以独立 DLL 形式存在，接收方可自行替换、修改与再分发（LGPL 权利不因本项目
  许可证而受限）。
- 本文件是工程合规说明，不构成法律意见；正式商业发布前建议由法务复核要约措辞与保存期限。
