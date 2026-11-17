# Tesseract.js-core 内嵌组件声明

`tesseract.js-core@7.0.0` 的 npm 包只提供 Apache-2.0 `LICENSE`，但其 WASM 由以下开源组件编译而来：

- Tesseract（Apache-2.0，来自 `naptha/tesseract.js-core` 为 WebAssembly 适配而修改的上游 Tesseract 分支；本项目未修改该 WASM）
- Leptonica（BSD-2-Clause）
- giflib（MIT）
- libjpeg-turbo（IJG / BSD 风格）
- libpng（libpng license）
- libtiff（libtiff license）
- libwebp（BSD-3-Clause）
- openlibm（MIT）
- zlib（zlib license）

> 上游修改说明：`tesseract.js-core` 的 Tesseract 分支对 `CMakeLists.txt`、`ltrresultiterator`、
> `src/arch_sse`、`baseapi` 等文件做了修改，完整修改清单见本目录
> `official/tesseract-core/README.md`（来自 npm 包 README）。本项目随包分发的是
> `tesseract.js-core@7.0.0` 的**未修改 npm 发行物**，不自行修改该 WASM；对应源码可从
> <https://github.com/naptha/tesseract.js-core/tree/v7.0.0> 获取。Apache-2.0 不要求
> 二进制分发随附源码，但要求保留许可证与修改声明；此处按该口径保留证据。

## 许可证原文文件

许可证原文位于 `legal/upstream/official/tesseract-core/`：

- `tesseract-LICENSE.txt`（tesseract-ocr/tesseract）
- `DanBloomberg-leptonica.txt`（leptonica）
- `libjpeg-turbo-LICENSE.md`
- `libpng-LICENSE.txt`
- `libtiff-LICENSE.md`
- `libwebp-COPYING.txt`
- `openlibm-LICENSE.md`
- `zlib-LICENSE.txt`
- `giflib-COPYING.txt`（giflib 官方 SourceForge `COPYING`，MIT）
- 以上文件的 URL 与 SHA-256 见 `legal/upstream/official/tesseract-core/SOURCES.json`。
