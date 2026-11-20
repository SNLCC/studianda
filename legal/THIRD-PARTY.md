# 第三方组件与许可证声明

生成时间：2026-11-20T18:48:24.569Z

本清单从**实际安装包** `resources/app.asar` 的依赖树生成，覆盖渲染器、Core 和生产依赖；不是仅根据源码清单推测。

本项目的 Apache License 2.0 许可证仅适用于本项目原创代码；随包分发的第三方组件仍分别适用其自身许可证，本项目许可证不改变、不限制这些组件在其许可证下的权利。随包字体、PDF.js 包内的第三方资源（CMaps、标准字体、ICC、WASM 解码器）与 Electron 运行时文件（含 Chromium、FFmpeg、ICU 等）均分别按各自自身许可分发，均不属于本项目许可范围；逐项许可见 `legal/THIRD-PARTY.md`、`legal/upstream/official/pdfjs-wasm/` 与 `legal/upstream/official/electron-runtime-dlls.md`；随包字体的逐款许可、版权与保留名见 `legal/fonts.json` 与 `legal/font-licenses/`。

## Electron 与 Chromium

- Electron：44.5.1，MIT License；
- Chromium：Electron 内置，第三方许可证全文见 `electron/LICENSES.chromium.html`；
- Electron 自身许可证：`electron/LICENSE.txt`；
- Node.js：24.21.0，MIT License，许可证见 `runtime/Node-LICENSE.txt`。

## 随安装包分发的运行时依赖

| 组件 | 版本 | 许可证 | 许可证文件 |
|---|---|---|---|
| @napi-rs/canvas | 1.0.13 | MIT | [@napi-rs_canvas@1.0.13-LICENSE](licenses/@napi-rs_canvas@1.0.13-LICENSE) |
| @napi-rs/canvas-win32-x64-msvc | 1.0.13 | MIT | [@napi-rs_canvas@1.0.13-LICENSE](licenses/@napi-rs_canvas@1.0.13-LICENSE) |
| @tanstack/query-core | 5.105.0 | MIT | [@tanstack_query-core@5.105.0-LICENSE](licenses/@tanstack_query-core@5.105.0-LICENSE) |
| @tanstack/react-query | 5.105.0 | MIT | [@tanstack_react-query@5.105.0-LICENSE](licenses/@tanstack_react-query@5.105.0-LICENSE) |
| argparse | 2.0.1 | Python-2.0 | [argparse@2.0.1-LICENSE](licenses/argparse@2.0.1-LICENSE) |
| builder-util-runtime | 9.7.0 | MIT | [builder-util-runtime@9.7.0-LICENSE](licenses/builder-util-runtime@9.7.0-LICENSE) |
| debug | 4.4.3 | MIT | [debug@4.4.3-LICENSE](licenses/debug@4.4.3-LICENSE) |
| electron-updater | 6.8.11 | MIT | [electron-updater@6.8.11-LICENSE](licenses/electron-updater@6.8.11-LICENSE) |
| fs-extra | 10.1.0 | MIT | [fs-extra@10.1.0-LICENSE](licenses/fs-extra@10.1.0-LICENSE) |
| graceful-fs | 4.2.11 | ISC | [graceful-fs@4.2.11-LICENSE](licenses/graceful-fs@4.2.11-LICENSE) |
| js-yaml | 4.3.2 | MIT | [js-yaml@4.3.2-LICENSE](licenses/js-yaml@4.3.2-LICENSE) |
| jsonfile | 6.2.1 | MIT | [jsonfile@6.2.1-LICENSE](licenses/jsonfile@6.2.1-LICENSE) |
| lazy-val | 1.0.5 | MIT | [LazyVal-MIT.txt](upstream/LazyVal-MIT.txt) |
| lodash.escaperegexp | 4.1.2 | MIT | [lodash.escaperegexp@4.1.2-LICENSE](licenses/lodash.escaperegexp@4.1.2-LICENSE) |
| lodash.isequal | 4.5.0 | MIT | [lodash.isequal@4.5.0-LICENSE](licenses/lodash.isequal@4.5.0-LICENSE) |
| ms | 2.1.3 | MIT | [ms@2.1.3-license.md](licenses/ms@2.1.3-license.md) |
| pdfjs-dist | 6.4.299 | Apache-2.0 | [pdfjs-dist@6.4.299-cmaps_LICENSE](licenses/pdfjs-dist@6.4.299-cmaps_LICENSE)<br>[pdfjs-dist@6.4.299-iccs_LICENSE](licenses/pdfjs-dist@6.4.299-iccs_LICENSE)<br>[pdfjs-dist@6.4.299-LICENSE](licenses/pdfjs-dist@6.4.299-LICENSE)<br>[pdfjs-dist@6.4.299-standard_fonts_LICENSE_FOXIT](licenses/pdfjs-dist@6.4.299-standard_fonts_LICENSE_FOXIT)<br>[pdfjs-dist@6.4.299-wasm_LICENSE_JBIG2](licenses/pdfjs-dist@6.4.299-wasm_LICENSE_JBIG2)<br>[pdfjs-dist@6.4.299-wasm_LICENSE_OPENJPEG](licenses/pdfjs-dist@6.4.299-wasm_LICENSE_OPENJPEG)<br>[pdfjs-dist@6.4.299-wasm_LICENSE_PDFJS_JBIG2](licenses/pdfjs-dist@6.4.299-wasm_LICENSE_PDFJS_JBIG2)<br>[pdfjs-dist@6.4.299-wasm_LICENSE_PDFJS_OPENJPEG](licenses/pdfjs-dist@6.4.299-wasm_LICENSE_PDFJS_OPENJPEG)<br>[pdfjs-dist@6.4.299-wasm_LICENSE_PDFJS_QCMS](licenses/pdfjs-dist@6.4.299-wasm_LICENSE_PDFJS_QCMS)<br>[pdfjs-dist@6.4.299-wasm_LICENSE_QCMS](licenses/pdfjs-dist@6.4.299-wasm_LICENSE_QCMS) |
| react | 19.3.1 | MIT | [react@19.3.1-LICENSE](licenses/react@19.3.1-LICENSE) |
| react-dom | 19.3.1 | MIT | [react-dom@19.3.1-LICENSE](licenses/react-dom@19.3.1-LICENSE) |
| sax | 1.6.1 | BlueOak-1.0.0 | [sax@1.6.1-LICENSE.md](licenses/sax@1.6.1-LICENSE.md) |
| scheduler | 0.28.0 | MIT | [scheduler@0.28.0-LICENSE](licenses/scheduler@0.28.0-LICENSE) |
| semver | 7.7.4 | ISC | [semver@7.7.4-LICENSE](licenses/semver@7.7.4-LICENSE) |
| tiny-typed-emitter | 2.1.0 | MIT | [tiny-typed-emitter@2.1.0-LICENSE](licenses/tiny-typed-emitter@2.1.0-LICENSE) |
| universalify | 2.0.1 | MIT | [universalify@2.0.1-LICENSE](licenses/universalify@2.0.1-LICENSE) |
| zustand | 5.0.16 | MIT | [zustand@5.0.16-LICENSE](licenses/zustand@5.0.16-LICENSE) |
| @fastify/ajv-compiler | 4.0.7 | MIT | [@fastify_ajv-compiler@4.0.7-LICENSE](licenses/@fastify_ajv-compiler@4.0.7-LICENSE) |
| @fastify/busboy | 3.2.4 | MIT | [@fastify_busboy@3.2.4-deps_dicer_LICENSE](licenses/@fastify_busboy@3.2.4-deps_dicer_LICENSE)<br>[@fastify_busboy@3.2.4-LICENSE](licenses/@fastify_busboy@3.2.4-LICENSE) |
| @fastify/deepmerge | 3.2.4 | MIT | [@fastify_deepmerge@3.2.4-LICENSE](licenses/@fastify_deepmerge@3.2.4-LICENSE) |
| @fastify/error | 4.2.1 | MIT | [@fastify_error@4.2.1-LICENSE](licenses/@fastify_error@4.2.1-LICENSE) |
| @fastify/fast-json-stringify-compiler | 5.1.1 | MIT | [@fastify_fast-json-stringify-compiler@5.1.1-LICENSE](licenses/@fastify_fast-json-stringify-compiler@5.1.1-LICENSE) |
| @fastify/forwarded | 3.1.2 | MIT | [@fastify_forwarded@3.1.2-LICENSE](licenses/@fastify_forwarded@3.1.2-LICENSE) |
| @fastify/merge-json-schemas | 0.2.2 | MIT | [@fastify_merge-json-schemas@0.2.2-LICENSE](licenses/@fastify_merge-json-schemas@0.2.2-LICENSE) |
| @fastify/multipart | 10.1.6 | MIT | [@fastify_multipart@10.1.6-LICENSE](licenses/@fastify_multipart@10.1.6-LICENSE) |
| @fastify/proxy-addr | 5.1.2 | MIT | [@fastify_proxy-addr@5.1.2-LICENSE](licenses/@fastify_proxy-addr@5.1.2-LICENSE) |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | [@pdf-lib_standard-fonts@1.0.0-LICENSE.md](licenses/@pdf-lib_standard-fonts@1.0.0-LICENSE.md) |
| @pdf-lib/upng | 1.0.1 | MIT | [@pdf-lib_upng@1.0.1-LICENSE](licenses/@pdf-lib_upng@1.0.1-LICENSE) |
| @pinojs/redact | 0.4.0 | MIT | [@pinojs_redact@0.4.0-LICENSE](licenses/@pinojs_redact@0.4.0-LICENSE) |
| abstract-logging | 2.0.1 | MIT | [AbstractLogging-MIT.txt](upstream/AbstractLogging-MIT.txt) |
| fast-uri | 3.1.9 | BSD-3-Clause | [fast-uri@3.1.9-LICENSE](licenses/fast-uri@3.1.9-LICENSE) |
| ajv | 8.20.0 | MIT | [ajv@8.20.0-LICENSE](licenses/ajv@8.20.0-LICENSE) |
| ajv-formats | 3.0.1 | MIT | [ajv-formats@3.0.1-LICENSE](licenses/ajv-formats@3.0.1-LICENSE) |
| atomic-sleep | 1.0.0 | MIT | [atomic-sleep@1.0.0-LICENSE](licenses/atomic-sleep@1.0.0-LICENSE) |
| avvio | 9.3.1 | MIT | [avvio@9.3.1-LICENSE](licenses/avvio@9.3.1-LICENSE) |
| bmp-js | 0.1.0 | MIT | [bmp-js@0.1.0-LICENSE](licenses/bmp-js@0.1.0-LICENSE) |
| cookie | 2.0.1 | MIT | [cookie@2.0.1-LICENSE](licenses/cookie@2.0.1-LICENSE) |
| dequal | 2.0.3 | MIT | [dequal@2.0.3-license](licenses/dequal@2.0.3-license) |
| fast-decode-uri-component | 1.0.1 | MIT | [fast-decode-uri-component@1.0.1-LICENSE](licenses/fast-decode-uri-component@1.0.1-LICENSE) |
| fast-deep-equal | 3.1.3 | MIT | [fast-deep-equal@3.1.3-LICENSE](licenses/fast-deep-equal@3.1.3-LICENSE) |
| fast-json-stringify | 7.2.0 | MIT | [fast-json-stringify@7.2.0-LICENSE](licenses/fast-json-stringify@7.2.0-LICENSE) |
| fast-querystring | 1.1.2 | MIT | [fast-querystring@1.1.2-LICENSE](licenses/fast-querystring@1.1.2-LICENSE) |
| fast-uri | 4.2.3 | BSD-3-Clause | [fast-uri@4.2.3-LICENSE](licenses/fast-uri@4.2.3-LICENSE) |
| fastify | 5.12.7 | MIT | [fastify@5.12.7-LICENSE](licenses/fastify@5.12.7-LICENSE) |
| fastify-plugin | 6.0.1 | MIT | [fastify-plugin@6.0.1-LICENSE](licenses/fastify-plugin@6.0.1-LICENSE) |
| fastq | 1.20.3 | ISC | [fastq@1.20.3-LICENSE](licenses/fastq@1.20.3-LICENSE) |
| fflate | 0.8.3 | MIT | [fflate@0.8.3-LICENSE](licenses/fflate@0.8.3-LICENSE) |
| find-my-way | 9.10.0 | MIT | [find-my-way@9.10.0-LICENSE](licenses/find-my-way@9.10.0-LICENSE) |
| idb-keyval | 6.3.0 | Apache-2.0 | [idb-keyval@6.3.0-LICENCE](licenses/idb-keyval@6.3.0-LICENCE) |
| ipaddr.js | 2.5.0 | MIT | [ipaddr.js@2.5.0-LICENSE](licenses/ipaddr.js@2.5.0-LICENSE) |
| is-url | 1.2.4 | MIT | [is-url@1.2.4-LICENSE-MIT](licenses/is-url@1.2.4-LICENSE-MIT) |
| json-schema-ref-resolver | 3.0.1 | MIT | [json-schema-ref-resolver@3.0.1-LICENSE](licenses/json-schema-ref-resolver@3.0.1-LICENSE) |
| json-schema-traverse | 1.0.0 | MIT | [json-schema-traverse@1.0.0-LICENSE](licenses/json-schema-traverse@1.0.0-LICENSE) |
| light-my-request | 6.8.0 | BSD-3-Clause | [light-my-request@6.8.0-LICENSE](licenses/light-my-request@6.8.0-LICENSE) |
| node-fetch | 2.7.0 | MIT | [node-fetch@2.7.0-LICENSE.md](licenses/node-fetch@2.7.0-LICENSE.md) |
| on-exit-leak-free | 2.1.2 | MIT | [on-exit-leak-free@2.1.2-LICENSE](licenses/on-exit-leak-free@2.1.2-LICENSE) |
| opencollective-postinstall | 2.0.3 | MIT | [opencollective-postinstall@2.0.3-LICENSE](licenses/opencollective-postinstall@2.0.3-LICENSE) |
| pako | 1.0.11 | (MIT AND Zlib) | [pako@1.0.11-LICENSE](licenses/pako@1.0.11-LICENSE) |
| pdf-lib | 1.17.1 | MIT | [pdf-lib@1.17.1-LICENSE.md](licenses/pdf-lib@1.17.1-LICENSE.md) |
| pino | 10.4.0 | MIT | [pino@10.4.0-LICENSE](licenses/pino@10.4.0-LICENSE) |
| pino-abstract-transport | 3.0.0 | MIT | [pino-abstract-transport@3.0.0-LICENSE](licenses/pino-abstract-transport@3.0.0-LICENSE) |
| pino-std-serializers | 7.1.0 | MIT | [pino-std-serializers@7.1.0-LICENSE](licenses/pino-std-serializers@7.1.0-LICENSE) |
| process-warning | 5.1.1 | MIT | [process-warning@5.1.1-LICENSE](licenses/process-warning@5.1.1-LICENSE) |
| quick-format-unescaped | 4.0.4 | MIT | [quick-format-unescaped@4.0.4-LICENSE](licenses/quick-format-unescaped@4.0.4-LICENSE) |
| real-require | 1.0.0 | MIT | [real-require@1.0.0-LICENSE.md](licenses/real-require@1.0.0-LICENSE.md) |
| regenerator-runtime | 0.13.11 | MIT | [regenerator-runtime@0.13.11-LICENSE](licenses/regenerator-runtime@0.13.11-LICENSE) |
| require-from-string | 2.0.2 | MIT | [require-from-string@2.0.2-license](licenses/require-from-string@2.0.2-license) |
| ret | 0.5.1 | MIT | [ret@0.5.1-LICENSE](licenses/ret@0.5.1-LICENSE) |
| reusify | 1.1.0 | MIT | [reusify@1.1.0-LICENSE](licenses/reusify@1.1.0-LICENSE) |
| rfdc | 1.4.1 | MIT | [rfdc@1.4.1-LICENSE](licenses/rfdc@1.4.1-LICENSE) |
| safe-regex2 | 5.1.2 | MIT | [safe-regex2@5.1.2-LICENSE](licenses/safe-regex2@5.1.2-LICENSE) |
| safe-stable-stringify | 2.5.0 | MIT | [safe-stable-stringify@2.5.0-LICENSE](licenses/safe-stable-stringify@2.5.0-LICENSE) |
| secure-json-parse | 4.1.1 | BSD-3-Clause | [secure-json-parse@4.1.1-LICENSE](licenses/secure-json-parse@4.1.1-LICENSE) |
| semver | 7.8.5 | ISC | [semver@7.8.5-LICENSE](licenses/semver@7.8.5-LICENSE) |
| set-cookie-parser | 3.2.1 | MIT | [set-cookie-parser@3.2.1-LICENSE](licenses/set-cookie-parser@3.2.1-LICENSE) |
| sonic-boom | 4.2.1 | MIT | [sonic-boom@4.2.1-LICENSE](licenses/sonic-boom@4.2.1-LICENSE) |
| split2 | 4.2.0 | ISC | [split2@4.2.0-LICENSE](licenses/split2@4.2.0-LICENSE) |
| tesseract.js | 7.0.0 | Apache-2.0 | [tesseract.js@7.0.0-LICENSE.md](licenses/tesseract.js@7.0.0-LICENSE.md) |
| tesseract.js-core | 7.0.0 | Apache-2.0 | [tesseract.js-core@7.0.0-LICENSE](licenses/tesseract.js-core@7.0.0-LICENSE) |
| thread-stream | 4.2.0 | MIT | [thread-stream@4.2.0-LICENSE](licenses/thread-stream@4.2.0-LICENSE) |
| toad-cache | 3.7.4 | MIT | [toad-cache@3.7.4-LICENSE](licenses/toad-cache@3.7.4-LICENSE) |
| tr46 | 0.0.3 | MIT | [tr46-MIT.txt](upstream/tr46-MIT.txt) |
| tslib | 1.14.1 | 0BSD | [tslib@1.14.1-LICENSE.txt](licenses/tslib@1.14.1-LICENSE.txt) |
| wasm-feature-detect | 1.9.0 | Apache-2.0 | [wasm-feature-detect@1.9.0-LICENSE](licenses/wasm-feature-detect@1.9.0-LICENSE) |
| webidl-conversions | 3.0.1 | BSD-2-Clause | [webidl-conversions@3.0.1-LICENSE.md](licenses/webidl-conversions@3.0.1-LICENSE.md) |
| whatwg-url | 5.0.0 | MIT | [whatwg-url@5.0.0-LICENSE.txt](licenses/whatwg-url@5.0.0-LICENSE.txt) |
| zlibjs | 0.3.1 | MIT | [zlibjs@0.3.1-LICENSE](licenses/zlibjs@0.3.1-LICENSE) |

## 非 npm 随包组件（机器可读清单）

以下组件不经过 npm 依赖树进入安装包，却实际随包分发：安装器 stub 与插件、Electron 运行时平台文件、FFmpeg、预编译原生二进制、内嵌 WASM、随包源码归档。逐条记录（含随包实物路径、字节数、SHA-256）在 `legal/inventory.json`：平台运行时条目在 `runtime[]`，其余在 `bundled[]`（本表来自同一批条目，组件名与版本即清单中的 `name`/`version`）。`source.verified` 为 `false` 的表示上游未发布可对照的官方哈希或二进制只在安装器/工具缓存中，原因写在该条目的 `source.reason`。

| 组件 | 版本 | 类别 | 许可证 | 来源核对 |
|---|---|---|---|---|
| Electron 运行时二进制（第三方 DLL / ICU / Pak / V8 快照） | 44.5.1 | Electron 运行时 | BSD-3-Clause 等（逐组件声明见 Chromium 第三方声明） | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| FFmpeg（Electron 内置 ffmpeg.dll） | Electron 44.5.1 内置构建 | 运行时（FFmpeg） | LGPL-2.1-or-later | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| NSIS 安装器 stub | 3.0.4.1 | 安装器 stub | zlib/libpng License | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| nsis7z.dll | 19.00（Nsis7z 19.00，基于 7-Zip 19.00） | 安装器插件 | 7-Zip License（GNU LGPL-2.1+ 及 BSD 条款，含 unRAR 限制） | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| StdUtils.dll | 1.1.4.0 | 安装器插件 | GNU LGPL-2.1-or-later | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| UAC.dll | 0.2.4c | 安装器插件 | ZLIB/LIBPNG License | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| elevate.exe | 未标注（随 NSIS 3.0.4.1 / electron-builder nsis-resources 提供） | 安装器辅助程序 | MIT | 来源哈希未核对（原因见 inventory.json 的 source.reason） |
| @napi-rs/canvas 预编译原生二进制（Skia / ICU / SBOM 142 个组件） | 1.0.13 | 预编译原生二进制 | MIT（@napi-rs/canvas）及 SBOM 内各组件自身许可证（BSD-3-Clause、MPL-2.0、Apache-2.0 等） | 来源哈希已核对 |
| MPL-2.0 组件源码归档（cssparser / cssparser-macros / dtoa-short / selectors） | cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0 | 随包源码归档 | MPL-2.0 | 来源哈希已核对 |
| tesseract.js-core WASM（内嵌 Tesseract / Leptonica / libjpeg-turbo / libpng / libtiff / libwebp / giflib / openlibm / zlib） | tesseract.js-core 7.0.0 | 内嵌 WASM | Apache-2.0（tesseract.js-core）及内嵌组件各自许可证 | 来源哈希已核对 |
| PDF.js WASM 解码器（JBIG2 / OpenJPEG / QCMS） | 6.4.299（pdfjs-dist） | 内嵌 WASM | Apache-2.0 / BSD-3-Clause / MIT 等（逐组件见 PDFJS-WASM-THIRD-PARTY.md） | 来源哈希已核对 |
| Agent MCP bridge bundle（agent-bridge.mjs，内嵌 MCP SDK / zod 等 8 个 npm 包） | 0.1.3 | mcp-bridge-bundle | MIT / BSD-3-Clause / ISC（逐包见 upstream/agent-bridge/THIRD-PARTY.md） | 来源哈希未核对（原因见 inventory.json 的 source.reason） |

安装器容器：`apps/desktop/release/Studianda-Setup-0.1.3.exe`（248449784 B，SHA-256 `42dcfb93f749bd1d7aa502c42b3bc6d1b31a4875576426a4c360e6011342e8dd`）；随其分发的组件：NSIS 安装器 stub、nsis7z.dll、StdUtils.dll、UAC.dll、elevate.exe。

## 随包字体

字体文件由 `scripts/build-fonts.py` 从官方发行物生成（冻结静态字重 + 子集化 + woff2），不属于 npm 依赖树，故单独列出。另有 1 个水印专用子集 TTF（`packages/core/assets/fonts/StudiandaWatermark.ttf`，源自 Noto Sans CJK SC，经 `extraResources` 放在 `resources/assets/fonts/`），其版权与许可见下表的 Noto Sans CJK SC 一行。逐文件的字节数与 SHA-256 见 `legal/inventory.json` 的 `fonts[].artifacts`，并与 `packages/ui/src/styles/assets/fonts/fonts.manifest.json` 交叉核对。

| 字体 | 版本 | 部署别名 | 许可证 | 许可证文件 |
|---|---|---|---|---|
| Noto Serif CJK SC | 2.003 | `Studianda Serif` | SIL Open Font License 1.1 | [font-noto-serif-cjk-sc-NotoSerifCJK-OFL-1.1.txt](licenses/font-noto-serif-cjk-sc-NotoSerifCJK-OFL-1.1.txt) |
| Noto Sans CJK SC | 2.004 | `Studianda Sans` | SIL Open Font License 1.1 | [font-noto-sans-cjk-sc-NotoSansCJK-OFL-1.1.txt](licenses/font-noto-sans-cjk-sc-NotoSansCJK-OFL-1.1.txt) |
| LXGW WenKai GB（霞鹜文楷 GB） | 1.530 | `Studianda Kai` | SIL Open Font License 1.1 | [font-lxgw-wenkai-gb-LXGWWenKaiGB-OFL-1.1.txt](licenses/font-lxgw-wenkai-gb-LXGWWenKaiGB-OFL-1.1.txt) |
| Noto Serif | 2.015 | `Studianda Serif Latin` | SIL Open Font License 1.1 | [font-noto-serif-latin-NotoLatin-OFL-1.1.txt](licenses/font-noto-serif-latin-NotoLatin-OFL-1.1.txt) |
| Noto Sans | 2.015 | `Studianda Sans Latin` | SIL Open Font License 1.1 | [font-noto-sans-latin-NotoLatin-OFL-1.1.txt](licenses/font-noto-sans-latin-NotoLatin-OFL-1.1.txt) |

- `Studianda Serif`：字重 400 / 600；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：© 2017-2024 Adobe (http://www.adobe.com/).；来源 https://github.com/notofonts/noto-cjk/releases；覆盖口径见 `legal/fonts.json`。
- `Studianda Sans`：字重 400 / 500；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：© 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.；来源 https://github.com/notofonts/noto-cjk/releases；覆盖口径见 `legal/fonts.json`。
- `Studianda Kai`：字重 400；已按 OFL 第 3 条改名（原保留名：霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW），版权声明、作者与许可字段原样保留；版权声明：Copyright 2022-2026 LXGW (https://github.com/lxgw/LxgwWenKaiGB), with Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'. Copyright 2020 The Klee Project Authors (https://github.com/fontworks-fonts/Klee)；来源 https://github.com/lxgw/LxgwWenKaiGB/releases；覆盖口径见 `legal/fonts.json`。
- `Studianda Serif Latin`：字重 400 / 600；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)；来源 https://github.com/notofonts/latin-greek-cyrillic；覆盖口径见 `legal/fonts.json`。
- `Studianda Sans Latin`：字重 400 / 500；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)；来源 https://github.com/notofonts/latin-greek-cyrillic；覆盖口径见 `legal/fonts.json`。

## 内嵌原生二进制（native binary）/ WASM / 安装器组件

以下组件内嵌在二进制、WASM 或安装器中，不单独出现在 node_modules 依赖树；本节的许可证原文均在 `legal/upstream/` 下随包分发。这些组件已全部纳入机器可读清单：Electron 运行时平台文件（DLL/ICU/Pak/V8 快照）与 FFmpeg 在 `legal/inventory.json` 的 `runtime[]`，安装器组件、预编译原生二进制、内嵌 WASM 与随包源码归档在 `bundled[]`，随包字体在 `fonts[]`；每条都带随包实物路径、字节数与 SHA-256，来源哈希无法与官方发布物核对的条目标 `source.verified: false` 并写明原因。下表组件名与版本即 `inventory.json` 中的 `name`/`version`。

- @napi-rs/canvas 原生二进制（Node-API native addon，`bundled[]` 中 name「@napi-rs/canvas 预编译原生二进制（Skia / ICU / SBOM 142 个组件）」、version 1.0.13）：包含 Skia、ICU、libavif 0.14.0 / libavif-sys 0.17.0、libaom-sys 0.17.2（BSD-2-Clause）、libjpeg-turbo（IJG/BSD/Zlib）、libloading 0.9.0（ISC）、foldhash 0.2.0 / bytemuck 1.25.2（Zlib）、MPL-2.0 组件（cssparser、cssparser-macros、dtoa-short、selectors）等 142 个 SBOM 组件。清单与逐组件许可证类型见 `upstream/official/napi-canvas/NAPI-CANVAS-THIRD-PARTY.md` 、`COMPONENTS.md` 、`COMPONENT-LICENSES.md` 与 `sbom.cdx.json`，原文见同目录。四个 MPL-2.0 组件的**未修改上游源码归档**随包提供于 `upstream/official/napi-canvas/mpl-sources/`（含 SHA-256 清单，`bundled[]` 中 name「MPL-2.0 组件源码归档（cssparser / cssparser-macros / dtoa-short / selectors）」），同时保留官方仓库地址。
- Tesseract.js-core WASM（`bundled[]` 中 name「tesseract.js-core WASM（内嵌 Tesseract / Leptonica / libjpeg-turbo / libpng / libtiff / libwebp / giflib / openlibm / zlib）」、version「tesseract.js-core 7.0.0」）：内嵌 Tesseract、Leptonica、giflib、libjpeg-turbo、libpng、libtiff、libwebp、openlibm、zlib；说明见 `upstream/Tesseract-core-THIRD-PARTY.md`，原文见 `upstream/official/tesseract-core/`。其 Tesseract 来自 `naptha/tesseract.js-core` 为 WebAssembly 适配而修改的上游分支（本项目未修改该 WASM），修改清单与源码地址见 `upstream/official/tesseract-core/README.md`。
- PDF.js WASM / 资源（`bundled[]` 中 name「PDF.js WASM 解码器（JBIG2 / OpenJPEG / QCMS）」、version 6.4.299（pdfjs-dist））：JBIG2、OpenJPEG、QCMS、CMaps、标准字体、ICC；说明见 `upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md`。
- tesseract.js 预构建 dist：内嵌 buffer 6.0.3（MIT）、ieee754 1.2.1（BSD-3-Clause）、regenerator-runtime（MIT）、zlib.js（MIT）；buffer/ieee754 原文见 `upstream/official/tesseract-embedded/`。
- NSIS 安装器 stub（`bundled[]` 中 name「NSIS 安装器 stub」、version 3.0.4.1）：安装器 stub 使用 NSIS 3.0.4.1（zlib/libpng license），许可证原文见 `upstream/official/nsis-COPYING.txt`。
- nsis7z.dll（`bundled[]` 中 name「nsis7z.dll」、version「19.00（Nsis7z 19.00，基于 7-Zip 19.00）」）：NSIS 的 7z 解压插件（安装时解压 app-64.7z），基于 7-Zip 19.00 源码（Nik Medved / Igor Pavlov）；按 7-Zip License（GNU LGPL-2.1+，含 unRAR 限制）分发。许可原文、来源与完整对应源码见 `upstream/official/nsis7z/`；实际随包 DLL 的来源包与 SHA-256 见该目录 `README.md`。
- StdUtils.dll（`bundled[]` 中 name「StdUtils.dll」、version 1.1.4.0）：NSIS 插件（electron-builder 模板使用），作者 LoRd_MuldeR；按 GNU LGPL-2.1-or-later 分发，许可、澄清说明与完整对应源码见 `upstream/official/nsis-plugins/stdutils/`。
- electron-builder / app-builder-lib 26.18.0：构建期使用其 NSIS 模板生成安装器（MIT，Copyright (c) 2015 Loopline Systems）；不随包分发其源码或二进制，但安装器脚本由其模板生成，声明见 `upstream/official/electron-builder-NOTICE.md` 与 `upstream/official/repos/electron-userland_electron-builder-LICENSE.txt`。
- UAC.dll（`bundled[]` 中 name「UAC.dll」、version 0.2.4c）：NSIS 提权插件，作者 Anders；按 ZLIB/LIBPNG License 分发，许可与源码见 `upstream/official/nsis-plugins/uac/`；本安装器使用 electron-builder `nsis-resources-3.4.1` 的 `x86-unicode/UAC.dll`（14,848 字节，SHA-256 `2F7F8FC05DC4FD0D5CDA501B47E4433357E887BBFED7292C028D99C73B52DC08`），未修改。
- elevate.exe（`bundled[]` 中 name「elevate.exe」、version「未标注（随 NSIS 3.0.4.1 / electron-builder nsis-resources 提供）」）：NSIS 提权辅助程序（MIT，Copyright (c) 2007 Johannes Passing），原文见 `upstream/official/elevate-MIT.txt`。
- FFmpeg（`runtime[]` 中 name「FFmpeg（Electron 内置 ffmpeg.dll）」）：Electron 内置 `ffmpeg.dll`（LGPL-2.1-or-later，Electron 官方构建，未修改）；许可证见 `upstream/official/ffmpeg-LGPL-2.1.txt`，**LGPL 2.1 §6(c) 书面源码要约**见 `upstream/official/ffmpeg-SOURCE-OFFER.md`（三年有效，接收方无需预先回应），构建说明见 `legal/COMPATIBILITY.md`。
- Electron 运行时二进制（`runtime[]` 中 name「Electron 运行时二进制（第三方 DLL / ICU / Pak / V8 快照）」、version 44.5.1，`ffmpeg.dll`、`d3dcompiler_47.dll`、`dxcompiler.dll`、`dxil.dll`、`vulkan-1.dll`、`vk_swiftshader.dll`、`icudtl.dat` 等）：由 Electron/Chromium 发行物原样提供、本项目未修改；版权与许可声明随 `electron/LICENSE.txt` 与 `electron/LICENSES.chromium.html` 分发，补充说明见 `upstream/official/electron-runtime-dlls.md`。
- pako 的 zlib 兼容层：zlib 许可通知见 `upstream/official/pako-zlib-README.txt`（`NOTICE.html` 也收录全文）。

> 安装器**不随包分发 WinShell 插件**，但保留其行为：该插件上游只有 "Freeware" 标注、没有许可文本或源码，不构成再分发授权；构建期由 `scripts/patch-nsis-templates.mjs` 把调用改写为 `apps/desktop/build/nsis/aumid.nsh` 的宏（NSIS 自带 System 插件 + Windows 公开 API），快捷方式 AUMID 仍照常写入/清除。证据见 `upstream/official/nsis-plugins/winshell/README.md`。

## 强制署名与特别声明

- **libjpeg-turbo（IJG）**：随包分发的 Tesseract WASM 与 `skia.node` 只含 libjpeg-turbo 二进制、不含其源码，按 IJG 许可需在产品文档中写明：`This software is based in part on the work of the Independent JPEG Group.`
- **MPL-2.0**：cssparser、cssparser-macros、dtoa-short、selectors 四个组件按 MPL-2.0 §3.2(a) 随包提供未修改源码归档（见上文 `mpl-sources/`），并同时给出官方仓库地址。
- **随包字体**：9 个 woff2 与 1 个水印专用子集 TTF（`StudiandaWatermark.ttf`，源自 Noto Sans CJK SC，经 `extraResources` 放在 `resources/assets/fonts/`）按各自自身许可分发，不属于本项目许可范围；逐款许可、版权行、保留名与改名说明见 `legal/fonts.json`、`legal/font-licenses/README.md` 与本文件「随包字体」一节。


## 运行时下载、不随包分发的资源

- Tesseract 语言训练数据（eng、chi_sim、chi_tra、jpn、kor、deu、fra、rus 等）：不包含在 npm 包中，也不随本安装包分发；用户在本机 OCR 设置里选择语言并点「下载所选语言包」后，才由主进程从 Tesseract 官方 tessdata_fast 发行物按需下载（Apache-2.0，官方仓库 https://github.com/tesseract-ocr/tessdata_fast ）；下载先走官方 raw（https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/<语言代码>.traineddata），该域名不可达时回退 GitHub 官方 Contents API（https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents/<语言代码>.traineddata?ref=main，Accept: application/vnd.github.raw），两者都是 HTTPS、同一仓库同一文件，不用第三方镜像；官方许可证原文见 legal/upstream/Tesseract-tessdata-APACHE-2.0.txt，来源与哈希见 legal/upstream/official/tessdata_fast-SOURCES.json；缓存在用户数据目录 ocr-tessdata/langs/，删除数据目录即移除；这是用户主动触发的数据下载（只取模型文件，不上传文献或问题），首次下载会向 GitHub 下载域名暴露 IP/时间；
- electron-builder / app-builder-lib 26.18.0（MIT）：仅构建期使用，安装器 NSIS 脚本由其模板生成；不随包分发其源码或构建二进制。声明见 legal/upstream/official/electron-builder-NOTICE.md 与 legal/upstream/official/repos/electron-userland_electron-builder-LICENSE.txt；
- Tesseract.js-core 的 WASM 内嵌 Tesseract、Leptonica、giflib、libjpeg、libpng、libtiff、libwebp、openlibm、zlib；官方许可证已补入 legal/upstream/official/tesseract-core/，说明见 legal/upstream/Tesseract-core-THIRD-PARTY.md；其 Tesseract 为 naptha/tesseract.js-core 为 WebAssembly 适配而修改的上游分支（本项目未修改该 WASM），修改清单见 legal/upstream/official/tesseract-core/README.md；
- @napi-rs/canvas 原生二进制（Node-API native addon）包含 Skia、ICU 和 Rust 组件；SBOM 与 Skia/ICU/MPL/各 Rust 组件许可证已补入 legal/upstream/official/napi-canvas/，SBOM 142 个组件的许可证类型已全部映射（0 个未覆盖）；具体版权行见该目录下对应组件原文；其中 MPL-2.0 组件（cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0）的源码可从 https://github.com/servo/rust-cssparser 、https://github.com/upsuper/dtoa-short 、https://github.com/servo/stylo 获取，许可证原文见 legal/upstream/official/napi-canvas/MPL-2.0.txt；
- PDF.js 的 WASM 解码组件（JBIG2、OpenJPEG、QCMS）以及 CMaps、标准字体、ICC 随应用分发；它们属于 pdfjs-dist 包内资源，不是新增 npm 依赖，许可证和版权声明见 legal/upstream/official/pdfjs-wasm/；

## 清单范围

本清单的 npm 依赖表只列安装包 `node_modules` 中实际存在的包；字体、内嵌原生二进制/WASM 组件、安装器组件与运行时下载资源分别见上文各节。非 npm 随包组件的机器可读记录在 `legal/inventory.json`：`runtime[]`（Electron 运行时平台文件、FFmpeg）、`bundled[]`（安装器 stub/插件、预编译原生二进制、内嵌 WASM、随包源码归档）与 `fonts[]`（逐字体文件），每条都带 `artifacts[].bytes` 与 `artifacts[].sha256`。

## 说明

- 许可证文件来自安装包内的实际文件；缺失项用 `legal/upstream/` 中的上游原文补充，并在 `inventory.json` 标记来源；
- `legal/SOURCES.md` 记录每个组件的官方仓库地址、许可证文件哈希与非 npm 组件的随包实物哈希；
- 非 npm 组件的 `bytes`/`sha256` 由 `scripts/audit-packaged-legal.mjs` 从仓库工作区内的实际文件现算，不手写、不编造；`source.verified: false` 的条目在 `source.reason` 写明无法核对的原因；
- 官方仓库许可证原文证据保存在 `legal/upstream/official/repos/`；
- 本文件是工程记录，不构成法律意见；商业发布前应做人工法律复核。

## 再分发

安装包内保留 `legal/` 目录。再分发时请保留该目录及其中的许可证原文（Apache-2.0 要求保留 LICENSE/NOTICE，各第三方许可证也要求保留其声明）。
