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




本目录保存：

- `LICENSE_CMAPS`
- `LICENSE_FOXIT`
- `LICENSE_ICCS`
- `LICENSE_JBIG2`
- `LICENSE_OPENJPEG`
- `LICENSE_PDFJS_JBIG2`
- `LICENSE_PDFJS_OPENJPEG`
- `LICENSE_PDFJS_QCMS`
- `LICENSE_QCMS`
