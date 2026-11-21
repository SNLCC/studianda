# Electron 随包运行时二进制：来源与声明依据

本文件补充说明安装目录下由 **Electron/Chromium 发行物** 提供、本项目**未修改**的运行时文件。
它们不是本项目的代码，也不适用本项目的 Apache License 2.0 许可。

## 文件清单

| 文件 | 字节数 | 来源/用途 | 声明依据 |
|---|---|---|---|
| `ffmpeg.dll` | 3 113 472 | Electron 官方构建的 FFmpeg（音视频解码） | LGPL-2.1-or-later；原文 `legal/upstream/official/ffmpeg-LGPL-2.1.txt` |
| `d3dcompiler_47.dll` | 4 741 488 | Chromium 在 Windows 上使用的 D3D 着色器编译器（Microsoft DirectX 可再分发组件） | Microsoft DirectX 可再分发组件条款；`LICENSES.chromium.html` 中**未逐字点名**该 DLL，故在此单独登记来源与许可依据 |
| `dxcompiler.dll` | 25 745 408 | Chromium 的 DirectX Shader Compiler（DXC）构建产物 | DirectXShaderCompiler 以 UIUC/NCSA（LLVM 系）许可发布；Chromium 声明中以 NCSA 文本收录，未逐一点名 |
| `dxil.dll` | 1 509 760 | DXC 的 DXIL 校验/签名组件 | 同上 |
| `vulkan-1.dll` | 939 520 | Vulkan loader（Chromium 分发） | Apache-2.0；Chromium 第三方声明 |
| `vk_swiftshader.dll` | 5 520 384 | SwiftShader（Vulkan 软件实现） | Apache-2.0/BSD 类；Chromium 第三方声明 |
| `icudtl.dat` | 10 876 560 | ICU 数据（Chromium/Electron） | Unicode License；Chromium 第三方声明 |
| `snapshot_blob.bin` / `v8_context_snapshot.bin` | 368 768 / 742 200 | V8 快照（Chromium） | Chromium 第三方声明 |
| `resources.pak` / `chrome_*.pak` | — | Chromium 界面资源 | Chromium 第三方声明 |

## 说明

- 以上文件均由 Electron 官方发行包原样带出，本项目未修改、未重新编译；
- 版权与许可声明的**权威文本**是随包分发的 `legal/electron/LICENSE.txt`（Electron 自身）与
  `legal/electron/LICENSES.chromium.html`（Chromium 及其第三方组件，约 20 MB）；
- `d3dcompiler_47.dll`、`dxcompiler.dll` / `dxil.dll` 在 `LICENSES.chromium.html` 中没有逐字点名的条目
  （该文件用 NCSA 文本收录了 UIUC/LLVM 系许可；`d3dcompiler_47.dll` 属 Microsoft DirectX 可再分发组件）。
  这属于 Electron 打包层面的声明粒度问题，本项目无法在源码侧修复，故在此登记来源与许可依据，
  供再分发者核对；
- 若后续升级 Electron 版本，应重新核对本表（文件大小与版本会变化），并确认 Chromium 声明文件已同步更新。
