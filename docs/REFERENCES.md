# 参考文献识别（文末列表 + 页下注）

阅读侧「参考」面板识别文末参考文献、页面底部脚注式引用，以及正文里的引用标记，
点击即可跳到对应页并高亮条目/引用的位置。

## 1. 能识别什么

| 来源 | 识别依据 | 说明 |
| --- | --- | --- |
| 文末参考文献列表 | 章节识别出的 `references` 小节（标题为 References / Bibliography / 参考文献 / 引用文献…） | 条目按编号拆开：`[1]`、`(1)`、`1.`、`①`；同一个块里挤了多条时按 `[n]`/`①` 再切 |
| 页面底部脚注式引用 | `footnote` 块 + 书目特征 | 有年份且含出版社/期刊/书名号/`[J][M]` 等文献类型标识才算；普通说明注不误收 |
| 正文引用标记 | 正文/列表/题注块里的文字模式 | `[1]`、`[1,3]`、`[1–3]`、`[10–12]`、`(Smith, 2020)`、（张三，2020） |

条目字段（**能解析多少显示多少；解析不出的字段留空**）：
- `authors`、`year`、`title`、`venue`；
- 支持常见格式：英文 APA/IEEE（`Smith, J. (2020). Alpha study. Journal A, 12(3), 45-67.`）、
  GB/T 7714（`李四. 社会研究的逻辑[J]. 社会学研究, 2019, 34(2): 1-20.`）、
  中文页下注（`张三：《研究方法》，北京：某出版社，2020年，第12页。`）；
- `raw` 永远是原文条目文字（未改写）。

引用 → 条目的解析：
- 数字编号只对应**文末列表**编号（页下注的 ①② 是另一套编号，不混用）；
- 作者-年份按「姓名 + 年份」匹配，可命中文末列表或页下注条目；
- 匹配不到时 `entryIds` 为空数组，界面如实显示「未在参考文献表中找到对应条目」。

## 2. 数据与接口

共享类型：`ReferenceEntry`、`ReferenceCitation`、`DocumentReferences`（`packages/shared`）。

`GET /api/v1/documents/:id/references` 返回：

```ts
interface DocumentReferences {
  documentId: string;
  version: string;                        // 识别版本（文件 size/mtime + 页遮罩版本）
  entries: ReferenceEntry[];              // 文末 + 页下注 + 手动，按页排序
  citations: Record<string, ReferenceCitation[]>; // 按页码分组（"1": [...]）
  stats: {
    pages: number;
    endEntries: number;
    footnoteEntries: number;
    manualEntries: number;                // 用户手动添加
    editedEntries: number;                // 被覆盖编辑的识别条目
    citations: number;
    resolvedCitations: number;
    unresolvedCitations: number;
    staleEdits: number;                   // 识别版本变化后失效的编辑
  };
}
```

`ReferenceEntry` 带 `source: 'recognized' | 'manual'` 与可选 `edited`，界面据此标「手动」「已编辑」。

每个条目带 `page`/`bbox`/`blockId`，每条引用带 `page`/`bbox`/`blockId`，因此界面点击
「跳到原文」时会翻到对应页并用块 bbox 高亮（不是新证据，只是位置提示）。

编辑接口（都返回套用编辑后的完整 `DocumentReferences`，并带 `stats.staleEdits`）：
- `PUT /api/v1/documents/:id/references/entries/:entryId` 修改条目字段；
- `DELETE /api/v1/documents/:id/references/entries/:entryId` 删除条目；
- `POST /api/v1/documents/:id/references/entries` 新增手动条目；
- `POST /api/v1/documents/:id/references/reset` 清空本文献全部编辑。

API 客户端：`api.getReferences` / `api.updateReferenceEntry` / `api.addReferenceEntry` /
`api.deleteReferenceEntry` / `api.resetReferenceEdits`。

## 3. 阅读界面

阅读页右侧「阅读伙伴」新增**「参考」**标签（在批注 / 笔记 / 对话之后）：
- **本页引用**：当前页识别到的引用标记 + 解析到的条目；点击标记跳到引用位置，点击条目跳到参考文献；
- **文末参考文献**：全部文末条目（编号 + 作者/年份/标题/出处 + 页码），点击跳转高亮；
- **页面底部引用**：页下注形式的参考文献，点击跳转；
- **正文点击引用标记**：在阅读区点 `[1]`、`[1–3]`、`(Smith, 2020)` 会在点击处弹出小窗，
  显示这条引用指向的条目；点条目直接跳到参考文献位置。首次点击会按需加载参考文献数据
  （不需要先打开「参考」面板）；
- 顶部与各处如实统计：文末 N 条 / 页下注 M 条 / 手动 K 条 / 已编辑 J 条 / 全篇引用 X 处（未解析 Y 处）。

### 3.1 用户编辑（兜底识别错误）

- 每条条目都有「编辑」「删除」：
  - 编辑可改编号、作者、年份、标题、出处、条目原文；只改原文未改其他字段时，会按新原文重新解析；
  - 删除 = 隐藏该识别条目（可「恢复自动识别」找回）；手动条目删除即移除；
- 「＋ 添加条目」可手动补一条参考文献（编号/作者/年份/标题/出处/原文；页码取当前页）；
- 「恢复自动识别」清空本文献的全部编辑（有确认）；
- 编辑是**覆盖层**：不写入 PDF、不改原文；识别结果本身仍按原逻辑重算；
- 编辑持久化在本地数据库 `reference_edits` 表（按文献 + 条目 id）；
- 编辑只对**同一识别版本**（文件 size/mtime + 页遮罩版本）生效；换文件/改遮罩导致版本变化后，
  旧编辑会被忽略并在面板顶部如实提示「N 条编辑已失效」。

实现位置：
- 识别与编辑合并：`packages/core/src/references.ts`（`applyReferenceEdits` 等）+ `Store` 的
  `getDocumentReferences` / `updateReferenceEntry` / `addReferenceEntry` / `deleteReferenceEntry` /
  `resetReferenceEdits`；
- 接口：`packages/core/src/server.ts`、`packages/api-client`；
- 面板与编辑表单：`packages/ui/src/ReferencePanel.tsx`；
- 正文引用点击弹窗：`packages/app/src/StudiandaApp.tsx` 的 `ReaderPage`（文本层点击 → 行内引用标记定位）；
- 样式：`packages/ui/src/styles/styles.css` 末尾 `.kr-refs*` / `.kr-cite-pop*`。

## 4. 与已有能力的关系

- 依赖**结构与内容块识别**（`docs/DOCUMENT-BLOCKS.md`）：文末小节判定、`reference`/`footnote` 块类型；
- 对内容块识别做了一处修正：带书目标志的长行（如 `1. Smith, J. Journal A, 2020…`）不再被误判为章节标题，
  页底的书目式脚注先于"列表项"识别（否则 `1. …` 会被当列表）；
- 不变：参考文献识别**不改变**原文、不改变检索/阅读/证据策略；条目只是结构化展示，
  不是引用证据（引用核验仍走原有 `quotes`/逐字核验路径）。

## 5. 已知限制

1. **扫描件**：没有文本层就没有条目/引用；需要先 OCR。
2. **上标数字引用**（如正文里的上标 `1`）识别不到：PDF 文本层常丢失上标信息，目前只认
   括号数字与作者-年份两种显式写法。
3. **编号体系不同**：页下注 `①②` 与文末 `[1]` 是两套编号；数字引用只解析到文末列表，
   作者-年份可跨两套匹配。
4. **解析是启发式**：作者/标题/出处可能为空或切分不完美（尤其是没有标准标点的旧排版）；
   界面按"能显示多少显示多少"，`raw` 始终可看原文。
5. **跨页条目**：条目跨页时以起始页记录，bbox 取条目所在块（跨页部分不单独标注）。
6. **不保证穷尽**：识别不到「参考文献」小节标题（例如只有裸列表、没有标题）时，文末条目不会被识别；
   脚注式引用要求有书目特征，纯缩写注（「同上」「参见前引」）不算条目。
7. **用户编辑的边界**：编辑只对同一识别版本生效（换文件/改页遮罩后失效并提示，可重做）；
   手动条目没有版面位置，跳转只按页码、高亮整页；编辑不写回 PDF 原文，导出/备份需另做
   （当前只存在本地数据库）。
8. **正文点击引用**：只认括号编号/作者-年份；上标数字做不到（文本层常丢上标），
   行内位置按字符比例估算，旧排版可能有几像素偏差。

## 6. 验证

- 单测/集成：`pnpm --filter @studianda/core exec vitest run test/references.test.ts`
  （英文/中文/GB-T 解析、脚注过滤、合并条目拆分、编号/区间/作者-年份解析、未解析留空、
  Store 与 HTTP 端点、缺文档 404）。
- 全量：`pnpm typecheck`、`pnpm test`、`pnpm build`。
