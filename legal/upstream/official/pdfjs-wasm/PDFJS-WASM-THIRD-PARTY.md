# PDF.js 资源组件声明

`pdfjs-dist@6.4.299` 的以下资源随应用分发：

- `wasm/jbig2.wasm` / `jbig2_nowasm_fallback.js`：JBIG2 解码
- `wasm/openjpeg.wasm` / `openjpeg_nowasm_fallback.js`：JPEG 2000 解码（OpenJPEG）
- `wasm/qcms_bg.wasm`：QCMS 色彩管理
- `cmaps/`：CJK 编码映射表
- `standard_fonts/`：仅 Foxit 标准字体
- `iccs/`：ICC 色彩配置

这些文件不是新增的 npm 依赖，而是 `pdfjs-dist` 包内资源；但随应用分发后，需要保留其上游许可证和版权声明。

## 许可证文件

本目录保存下列 9 份许可证/版权文本，与上述资源一一对应：

- `LICENSE_CMAPS`（2080 字节）：`cmaps/` CJK 编码映射表的版权与再分发条款（Copyright 1990-2009 Adobe Systems Incorporated）
- `LICENSE_FOXIT`（1553 字节）：`standard_fonts/` Foxit 标准字体的 BSD 式许可证（Copyright 2014 PDFium Authors）
- `LICENSE_ICCS`（6553 字节）：`iccs/` ICC 色彩配置的 CC0 1.0 Universal 公有领域贡献声明
- `LICENSE_JBIG2`（12862 字节）：JBIG2 解码器上游（PDFium）的 BSD 式许可证（Copyright 2014 The PDFium Authors）
- `LICENSE_OPENJPEG`（2112 字节）：OpenJPEG（JPEG 2000 解码）的 2 条款 BSD 许可证
- `LICENSE_PDFJS_JBIG2`（555 字节）：PDF.js 自身 JBIG2 适配代码的 Apache License 2.0（Copyright 2026 Mozilla Foundation）
- `LICENSE_PDFJS_OPENJPEG`（1285 字节）：PDF.js 自身 OpenJPEG 适配代码的 BSD 3 条款许可证（Copyright (c) 2024 Mozilla Foundation）
- `LICENSE_PDFJS_QCMS`（1036 字节）：PDF.js 自身 QCMS 适配代码的 MIT 许可证
- `LICENSE_QCMS`（1121 字节）：qcms 色彩管理库的 MIT 许可证（Copyright (C) 2009-2024 Mozilla Corporation、1998-2007 Marti Maria）

各文件的 URL 与 SHA-256 见同目录 `SOURCES.json`。
