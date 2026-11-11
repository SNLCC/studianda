# 第三方组件与许可证声明

生成时间：2026-11-09T17:24:16.011Z

本清单从**实际安装包** `resources/app.asar` 的依赖树生成，覆盖渲染器、Core 和生产依赖；不是仅根据源码清单推测。

本项目的 PolyForm Noncommercial 1.0.0 许可证仅适用于本项目原创代码；随包分发的第三方组件仍分别适用其自身许可证，本项目许可证不改变、不限制这些组件在其许可证下的权利。

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

## 随包字体

字体文件由 `scripts/build-fonts.py` 从官方发行物生成（冻结静态字重 + 子集化 + woff2），不属于 npm 依赖树，故单独列出。

| 字体 | 版本 | 部署别名 | 许可证 | 许可证文件 |
|---|---|---|---|---|
| Noto Serif CJK SC | 2.003 | `Studianda Serif` | SIL Open Font License 1.1 | [font-noto-serif-cjk-sc-NotoSerifCJK-OFL-1.1.txt](licenses/font-noto-serif-cjk-sc-NotoSerifCJK-OFL-1.1.txt) |
| Noto Sans CJK SC | 2.004 | `Studianda Sans` | SIL Open Font License 1.1 | [font-noto-sans-cjk-sc-NotoSansCJK-OFL-1.1.txt](licenses/font-noto-sans-cjk-sc-NotoSansCJK-OFL-1.1.txt) |
| Studianda Kai | 1.530 | `Studianda Kai` | SIL Open Font License 1.1 | [font-lxgw-wenkai-gb-LXGWWenKaiGB-OFL-1.1.txt](licenses/font-lxgw-wenkai-gb-LXGWWenKaiGB-OFL-1.1.txt) |
| Noto Serif | 2.015 | `Studianda Serif Latin` | SIL Open Font License 1.1 | [font-noto-serif-latin-NotoLatin-OFL-1.1.txt](licenses/font-noto-serif-latin-NotoLatin-OFL-1.1.txt) |
| Noto Sans | 2.015 | `Studianda Sans Latin` | SIL Open Font License 1.1 | [font-noto-sans-latin-NotoLatin-OFL-1.1.txt](licenses/font-noto-sans-latin-NotoLatin-OFL-1.1.txt) |

- `Studianda Serif`：字重 400 / 600；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：© 2017-2024 Adobe (http://www.adobe.com/).；来源 https://github.com/notofonts/noto-cjk/releases；覆盖口径见 `legal/fonts.json`。
- `Studianda Sans`：字重 400 / 500；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：© 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.；来源 https://github.com/notofonts/noto-cjk/releases；覆盖口径见 `legal/fonts.json`。
- `Studianda Kai`：字重 400；已按 OFL 第 3 条改名（原保留名：霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW），版权声明、作者与许可字段原样保留；版权声明：Copyright 2022-2026 LXGW, with Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'. / Copyright 2020 The Klee Project Authors.；来源 https://github.com/lxgw/LxgwWenKaiGB/releases；覆盖口径见 `legal/fonts.json`。
- `Studianda Serif Latin`：字重 400 / 600；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)；来源 https://github.com/notofonts/latin-greek-cyrillic；覆盖口径见 `legal/fonts.json`。
- `Studianda Sans Latin`：字重 400 / 500；保留字体内部名（其保留名与本项目命名不冲突）；版权声明：Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)；来源 https://github.com/notofonts/latin-greek-cyrillic；覆盖口径见 `legal/fonts.json`。

## 内嵌原生二进制（native binary）/ WASM / 安装器组件

以下组件内嵌在二进制、WASM 或安装器中，不单独出现在 node_modules 依赖树；本节的许可证原文均在 `legal/upstream/` 下随包分发。

- @napi-rs/canvas 原生二进制（Node-API native addon）：包含 Skia、ICU、libavif 0.14.0 / libavif-sys 0.17.0、libaom-sys 0.17.2（BSD-2-Clause）、libjpeg-turbo（IJG/BSD/Zlib）、libloading 0.9.0（ISC）、foldhash 0.2.0 / bytemuck 1.25.2（Zlib）、MPL-2.0 组件（cssparser、cssparser-macros、dtoa-short、selectors）等 142 个 SBOM 组件。清单与逐组件许可证类型见 `upstream/official/napi-canvas/NAPI-CANVAS-THIRD-PARTY.md` 、`COMPONENTS.md` 、`COMPONENT-LICENSES.md` 与 `sbom.cdx.json`，原文见同目录；MPL-2.0 源码获取方式见该说明。
- Tesseract.js-core WASM：内嵌 Tesseract、Leptonica、giflib、libjpeg-turbo、libpng、libtiff、libwebp、openlibm、zlib；说明见 `upstream/Tesseract-core-THIRD-PARTY.md`，原文见 `upstream/official/tesseract-core/`。
- PDF.js WASM / 资源：JBIG2、OpenJPEG、QCMS、CMaps、标准字体、ICC；说明见 `upstream/official/pdfjs-wasm/PDFJS-WASM-THIRD-PARTY.md`。
- tesseract.js 预构建 dist：内嵌 buffer 6.0.3（MIT）、ieee754 1.2.1（BSD-3-Clause）、regenerator-runtime（MIT）、zlib.js（MIT）；buffer/ieee754 原文见 `upstream/official/tesseract-embedded/`。
- NSIS 安装器：安装器 stub 使用 NSIS 3.0.4.1（zlib/libpng license），许可证原文见 `upstream/official/nsis-COPYING.txt`。
- elevate.exe：NSIS 提权辅助程序（MIT，Copyright (c) 2007 Johannes Passing），原文见 `upstream/official/elevate-MIT.txt`。
- FFmpeg：Electron 内置 `ffmpeg.dll`（LGPL-2.1-or-later，Electron 官方构建，未修改）；源代码与构建配置见 https://github.com/electron/electron ，许可证见 `upstream/official/ffmpeg-LGPL-2.1.txt`。
- pako 的 zlib 兼容层：说明见 `upstream/official/pako-zlib-README.txt`。


## 运行时下载、不随包分发的资源

- Tesseract 语言训练数据（eng、chi_sim、chi_tra、jpn、kor、deu、fra、rus 等）：不包含在 npm 包中，也不随本安装包分发；用户在本机 OCR 设置里选择语言并点「下载所选语言包」后，才由主进程从 Tesseract 官方 tessdata_fast 发行物按需下载（Apache-2.0，官方仓库 https://github.com/tesseract-ocr/tessdata_fast ）；下载先走官方 raw（https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/<语言代码>.traineddata），该域名不可达时回退 GitHub 官方 Contents API（https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents/<语言代码>.traineddata?ref=main，Accept: application/vnd.github.raw），两者都是 HTTPS、同一仓库同一文件，不用第三方镜像；官方许可证原文见 legal/upstream/Tesseract-tessdata-APACHE-2.0.txt；缓存在用户数据目录 ocr-tessdata/langs/，删除数据目录即移除；这是用户主动触发的数据下载（只取模型文件，不上传文献或问题），首次下载会向 GitHub 下载域名暴露 IP/时间；
- Tesseract.js-core 的 WASM 内嵌 Tesseract、Leptonica、giflib、libjpeg、libpng、libtiff、libwebp、openlibm、zlib；官方许可证已补入 legal/upstream/official/tesseract-core/，说明见 legal/upstream/Tesseract-core-THIRD-PARTY.md；
- @napi-rs/canvas 原生二进制（Node-API native addon）包含 Skia、ICU 和 Rust 组件；SBOM 与 Skia/ICU/MPL/各 Rust 组件许可证已补入 legal/upstream/official/napi-canvas/，SBOM 142 个组件的许可证类型已全部映射（0 个未覆盖）；具体版权行见该目录下对应组件原文；其中 MPL-2.0 组件（cssparser 0.38.0、cssparser-macros 0.7.0、dtoa-short 0.3.5、selectors 0.41.0）的源码可从 https://github.com/servo/rust-cssparser 、https://github.com/upsuper/dtoa-short 、https://github.com/servo/stylo 获取，许可证原文见 legal/upstream/official/napi-canvas/MPL-2.0.txt；
- PDF.js 的 WASM 解码组件（JBIG2、OpenJPEG、QCMS）以及 CMaps、标准字体、ICC 随应用分发；它们属于 pdfjs-dist 包内资源，不是新增 npm 依赖，许可证和版权声明见 legal/upstream/official/pdfjs-wasm/；

## 清单范围

本清单的 npm 依赖表只列安装包 `node_modules` 中实际存在的包；字体、内嵌原生二进制/WASM 组件、安装器组件与运行时下载资源分别见上文各节。

## 说明

- 许可证文件来自安装包内的实际文件；缺失项用 `legal/upstream/` 中的上游原文补充，并在 `inventory.json` 标记来源；
- `legal/SOURCES.md` 记录每个组件的官方仓库地址和许可证文件哈希；
- 官方仓库许可证原文证据保存在 `legal/upstream/official/repos/`；
- 本文件是工程记录，不构成法律意见；商业发布前应做人工法律复核。

## 再分发

安装包内保留 `legal/` 目录。再分发时不得删除该目录及其中的许可证原文。
