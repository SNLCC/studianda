# MPL-2.0 组件源码归档（Source Code Form）

本目录保存 `@napi-rs/canvas-win32-x64-msvc@1.0.13` 预编译原生二进制中所含四个 MPL-2.0 组件的**上游源码归档**。文件均为 crates.io 上发布的原始 `.crate` 包（gzip 压缩的 tar 归档，内部为对应版本的完整 Rust 源码），**未做任何修改**，字节与发布时一致。

## 为什么随安装包分发这些文件

MPL-2.0 第 3.2(a) 条要求：以可执行形式分发 Covered Software 时，必须告知接收方如何获取 Source Code Form 的副本。本项目分发的安装包本身不含源码，因此把上述四个组件的原始源码归档**随安装包一起发布**，位于安装目录下的：

```
resources/legal/upstream/official/napi-canvas/mpl-sources/
```

接收方无需额外请求，直接从已安装应用的同目录即可获得与二进制精确对应的源码归档。这与仅在文档里给出仓库 URL 不同：源码随分发物一并提供，符合 §3.2(a) 的"informed how to obtain"要求。

## 归档清单

| 组件 | 版本 | 文件名 | 字节大小 | SHA-256 | 下载 URL |
|---|---|---|---|---|---|
| cssparser | 0.38.0 | `cssparser-0.38.0.crate` | 57272 | `11119743ad110e8c1bdccd930d7f5c30c99e5fc76a7b63ec9807e84eef0c5f59` | https://crates.io/api/v1/crates/cssparser/0.38.0/download |
| cssparser-macros | 0.7.0 | `cssparser-macros-0.7.0.crate` | 8167 | `10a2a99df6e410a8ff4245aa2006499ea662245f967cc7c0a38c83ef8eb44dbf` | https://crates.io/api/v1/crates/cssparser-macros/0.7.0/download |
| dtoa-short | 0.3.5 | `dtoa-short-0.3.5.crate` | 8287 | `cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87` | https://crates.io/api/v1/crates/dtoa-short/0.3.5/download |
| selectors | 0.41.0 | `selectors-0.41.0.crate` | 69626 | `8322aebea94a6cc288ff884e8a49bdbceef60206c400c6c46d22e62fc4fd91a6` | https://crates.io/api/v1/crates/selectors/0.41.0/download |

四个组件全部从 crates.io 取得原始发布包，无需回退到 GitHub 归档。

校验方法：对任意文件执行 `Get-FileHash <文件名> -Algorithm SHA256`（PowerShell）或 `sha256sum <文件名>`，结果应与上表一致。

## 官方获取渠道

接收方也可以从下列官方仓库获取同一份源码：

- cssparser / cssparser-macros：https://github.com/servo/rust-cssparser （crates.io：https://crates.io/crates/cssparser 、https://crates.io/crates/cssparser-macros ）
- dtoa-short：https://github.com/upsuper/dtoa-short （crates.io：https://crates.io/crates/dtoa-short ）
- selectors：https://github.com/servo/stylo （crates.io：https://crates.io/crates/selectors ；0.41.0 对应提交 `34d25f741765a0bdb894f8271852e633299352d8`，记录于该 crate 包内 `.cargo_vcs_info.json`）

## 许可证

四个组件均声明 MPL-2.0。许可证正文见上层目录（`napi-canvas/`）的 `MPL-2.0.txt`，以及 `napi-canvas/vendored/` 下：

- `cssparser@0.38.0-LICENSE.txt`（从 `cssparser-0.38.0.crate` 内的 `LICENSE` 提取）
- `selectors@0.41.0-repo-LICENSE.txt`（Mozilla 官方 MPL 2.0 正文）

说明：`selectors-0.41.0.crate` 包内**不含** `LICENSE` 文件（其 `Cargo.toml` 只有 `license = "MPL-2.0"` 声明，仓库 `servo/stylo` 的该提交根目录也没有 LICENSE 文件），因此 selectors 的许可证正文取 Mozilla 官方发布的 MPL 2.0 文本，而非从该 crate 内提取。
