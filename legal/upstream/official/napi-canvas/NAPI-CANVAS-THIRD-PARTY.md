# @napi-rs/canvas 原生二进制第三方组件

来源：`@napi-rs/canvas-win32-x64-msvc@1.0.13`，包含 `skia.win32-x64-msvc.node` 和 ICU 数据。

该包自身是 MIT License，但预编译原生二进制包含 Skia 和 Rust/ICU 等组件。包内提供 `sbom.cdx.json`，列出 142 个组件。

## SBOM 中的许可证分布

- MIT OR Apache-2.0：67
- MIT：30
- 未标注：9
- Apache-2.0 OR MIT：8
- Unlicense OR MIT：4
- MPL-2.0：4
- Apache-2.0：3
- BSD-2-Clause：3
- Zlib OR Apache-2.0 OR MIT：2
- Zlib：2
- BSD-3-Clause：2
- 其余：少量

## 未标注组件的许可证认定

| SBOM 组件 | 认定许可证 | 依据 |
|---|---|---|
| `skia.win32-x64-msvc.node` | BSD-3-Clause（Skia） | `Skia-LICENSE.txt` |
| `anstyle` | MIT OR Apache-2.0 | Rust crate 声明；`anstyle-LICENSE-*.txt` |
| `canvas` | MIT（本地 NAPI 包装 crate） | 包自身 LICENSE；`canvas-LICENSE.txt` |
| `clap` | MIT OR Apache-2.0 | `clap-LICENSE-*.txt` |
| `clap_builder` | MIT OR Apache-2.0 | 同上（clap 仓库） |
| `clap_lex` | MIT OR Apache-2.0 | 同上（clap 仓库） |
| `cxxbridge-cmd` | MIT OR Apache-2.0 | `cxx-LICENSE-*.txt` |
| `skia-fontations` | Apache-2.0 | Fontations；`fontations-LICENSE.txt` |
| `strsim` | MIT | `strsim-LICENSE.txt` |

## MPL-2.0 组件

`cssparser`、`cssparser-macros`、`dtoa-short`、`selectors` 为 MPL-2.0；已附 `MPL-2.0.txt`。MPL-2.0 是文件级弱 copyleft，不要求整包开源，但需保留声明和许可证文本，并让接收方能够获得这些文件的源码。本项目分发的安装包不含源码，对应源码可从各自官方仓库获取：

- cssparser / cssparser-macros 0.38.0 / 0.7.0：https://github.com/servo/rust-cssparser
- dtoa-short 0.3.5：https://github.com/upsuper/dtoa-short
- selectors 0.41.0：https://github.com/servo/stylo

版本以本目录 `sbom.cdx.json` 为准；如需 MPL-2.0 文件的源码副本，可通过上述仓库获取。

## BSD-2 / ISC / Zlib / 其他特殊组件

- `libavif` 0.14.0 / `libavif-sys` 0.17.0（BSD-2-Clause）：`libavif-BSD-2-Clause.txt`、`libavif-sys-BSD-2-Clause.txt`
- `libaom-sys` 0.17.2（BSD-2-Clause，内嵌 libaom 3.11.0）：`libaom-sys-BSD-2-Clause.txt`
- `libloading` 0.9.0（ISC）：`libloading-ISC.txt`
- `foldhash` 0.2.0（Zlib）：`foldhash-Zlib.txt`；`bytemuck` / `bytemuck_derive`（Zlib OR Apache-2.0 OR MIT）：`bytemuck-Zlib.txt`
- `libjpeg-turbo`：`IJG.txt`；`libpng`：`libpng-2.0.txt`；FreeType（fontations）：`FTL.txt`；Unicode 数据：`Unicode-3.0.txt`；Unlicense 组件：`Unlicense.txt`
- 原生二进制实际包含 libavif/libaom（AVIF/AV1 解码）等组件，SBOM 的许可证类型覆盖不等于版权行覆盖；具体版权行以上述组件官方文本为准。

以上文件的 URL 与 SHA-256 见 `SOURCES.json`。

## 许可证原文文件

`legal/upstream/official/napi-canvas/`：

- `Skia-LICENSE.txt`
- `ICU-LICENSE.txt`
- `MPL-2.0.txt`
- `libavif-BSD-2-Clause.txt`、`libavif-sys-BSD-2-Clause.txt`、`libaom-sys-BSD-2-Clause.txt`
- `libloading-ISC.txt`、`foldhash-Zlib.txt`、`bytemuck-Zlib.txt`
- `FTL.txt`、`IJG.txt`、`libpng-2.0.txt`、`Unicode-3.0.txt`、`Unlicense.txt`
- `anstyle-LICENSE-MIT.txt` / `anstyle-LICENSE-APACHE.txt`
- `canvas-LICENSE.txt`
- `clap-LICENSE-MIT.txt` / `clap-LICENSE-APACHE.txt`
- `cxx-LICENSE-MIT.txt` / `cxx-LICENSE-APACHE.txt`
- `fontations-LICENSE.txt`
- `strsim-LICENSE.txt`
- `sbom.cdx.json`
- `COMPONENTS.md` / `COMPONENTS.json`：142 个组件的版本、许可证类型与官方仓库/版本源
- `COMPONENT-LICENSES.md`：从官方 crate 包提取的逐组件许可证全文（提取不到时注明）
- `COMPONENT-COMPLIANCE.md`：商业发行前逐组件合规审查矩阵
- `SOURCES.json`：URL 与 SHA-256
