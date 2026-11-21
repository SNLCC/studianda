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

上游 `sbom.cdx.json`（由 `@napi-rs/canvas` 官方生成）中有 **9 个组件的 `licenses` 字段为空**；本目录的 `COMPONENTS.json` 已由本项目按下列依据补注（保留 `licenseSource` 字段说明其为补注值，上游 SBOM 文件本身未改动）。`audit-napi-canvas-sbom.mjs` 以同一映射统计，故“142/142 已认定”指**本项目补注后的认定**，不是上游 SBOM 的原始字段完整率。

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

`cssparser`、`cssparser-macros`、`dtoa-short`、`selectors` 为 MPL-2.0；已附 `MPL-2.0.txt`。MPL-2.0 是文件级弱 copyleft，不要求整包开源，但需保留声明和许可证文本，并让接收方能够获得这些文件的源码。

这四个组件的**上游源码归档现已随安装包分发**，位于安装目录 `resources/legal/upstream/official/napi-canvas/mpl-sources/`（本源码树内即 `mpl-sources/`），均为 crates.io 发布的原始 `.crate` 包（未修改的 Source Code Form）：

- `cssparser-0.38.0.crate` — 57272 字节 — SHA-256 `11119743ad110e8c1bdccd930d7f5c30c99e5fc76a7b63ec9807e84eef0c5f59`
- `cssparser-macros-0.7.0.crate` — 8167 字节 — SHA-256 `10a2a99df6e410a8ff4245aa2006499ea662245f967cc7c0a38c83ef8eb44dbf`
- `dtoa-short-0.3.5.crate` — 8287 字节 — SHA-256 `cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87`
- `selectors-0.41.0.crate` — 69626 字节 — SHA-256 `8322aebea94a6cc288ff884e8a49bdbceef60206c400c6c46d22e62fc4fd91a6`

获取方式、官方渠道与校验方法见 `mpl-sources/README.md`。**此前本节"本项目分发的安装包不含源码，对应源码可从各自官方仓库获取"的表述已被取代（superseded）**：源码不再只是"可从他处获取"，而是作为归档随分发物一同提供。

同一份源码也可从各自官方仓库获取：

- cssparser / cssparser-macros 0.38.0 / 0.7.0：https://github.com/servo/rust-cssparser
- dtoa-short 0.3.5：https://github.com/upsuper/dtoa-short
- selectors 0.41.0：https://github.com/servo/stylo （crate 内 `.cargo_vcs_info.json` 记录提交 `34d25f741765a0bdb894f8271852e633299352d8`）

版本以本目录 `sbom.cdx.json` 为准。

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
- `vendored/`：无法从 crate 根目录直接取到的许可证原文（含 `expat-LICENSE.txt`、`selectors@0.41.0-repo-LICENSE.txt`）
- `mpl-sources/`：四个 MPL-2.0 组件的上游源码归档与 `README.md`
- `sbom.cdx.json`
- `COMPONENTS.md` / `COMPONENTS.json`：142 个组件的版本、许可证类型与官方仓库/版本源
- `COMPONENT-LICENSES.md`：从官方 crate 包提取的逐组件许可证全文（提取不到时注明）
- `COMPONENT-COMPLIANCE.md`：商业发行前逐组件合规审查矩阵
- `SOURCES.json`：URL 与 SHA-256
