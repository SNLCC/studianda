# 测试 PDF 样张

这里的 PDF 都**提交进仓库**，干净 clone / CI 里也能直接跑。它们全部是合成内容：
虚构的标题、作者、机构、期刊与数据，不含任何真实论文文本。

以前有个别测试引用本机被 `.gitignore` 忽略的 PDF（`dev-notes/` 与 `测试用pdf.pdf`），
文件不在就 `existsSync` 提前 return。本地看着是绿的，干净 clone 里那些断言根本没执行。
现在统一改成引用本目录下的已跟踪样张。

| 文件 | 来源 | 被谁用 |
| --- | --- | --- |
| `sample-paper.pdf` | `generate-sample-pdf.mjs` 用 `pdf-lib` 生成（2 页，英文） | backup、budget、ocr、server、toc-page-suppression、heading-merge 等 |
| `two-column-paper.pdf` | 外部准备的 2 页合成英文样张（作者 `Author1, Author2`，正文自述为演示文档）；由本机 `测试用pdf.pdf` 迁入，字节未改 | `heading-merge.test.ts`（双栏版式） |
| `demo-paper/demo-paper-01.pdf` | 合成的**占位**中文样张（6 页，标题/作者/机构/期刊/目录/正文均为占位文字）；曾用 Electron `printToPDF` 一次性生成，生成源已删除，只提交二进制 | `heading-merge`、`reading-units`、`section-index-contract`、`toc-page-suppression` |

## demo-paper 的版面约定

`demo-paper-01.pdf` 的版面被测试当作契约；样张本身是**一眼可辨的占位内容**：

- 第 1 页标题折成两行（`…第一行：合成占位内容仅用于测试` + `样张标题第二行`）——测跨行标题合并；
- 第 2 页是印刷目录（`第一节 示例章节：背景` 这类标题 + 页码）——测目录页识别且不产生正文章节；
- 第 3 页起 10 个正文章节（`第一节 示例章节：背景` … `第十节 示例章节：小结`）——测结构完整性、
  阅读单元与章节索引。

作者、机构、期刊分别是「作者甲、作者乙」「示例机构」「示例期刊」；正文是重复的占位句。

**不再提供生成器**（原 `demo-paper/paper.html` 与 `demo-paper/make-demo-pdf.mjs` 已删除）：
已提交的 PDF 就是测试基线，不要指望从仓库里重新生成。确需改版面时，按上面的契约另外制作，
并同步更新 4 组测试里对新文案的断言。`printToPDF` 输出依赖 Electron 版本与本机字体，
**未必逐字节可复现**；除非确实要更新版面，否则不要覆盖它。

## 注意

- 别把样张放进名为 `out/` 的目录：根 `.gitignore` 里 `out/` 是无锚点规则，任何层级的
  `out/` 都会被忽略，样张就会重新变成"本地有、仓库没有"。
- `generate-sample-pdf.mjs` 生成的 `sample-paper.pdf` 是确定性的（同一 `pdf-lib` 版本下）。
