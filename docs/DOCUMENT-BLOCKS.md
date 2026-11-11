# 文献结构与内容块识别

本文说明版面级内容块识别、章节划分与章节级问答索引片段：识别到什么粒度、依据什么规则、接口怎么用。

## 1. 一句话结论

- 基础能力：标题在哪一页（`structure.ts` 的目录/章节树，页码粒度）。
- 内容块：标题在页面哪个位置、正文被切成哪些块、每块属于哪一节（版面粒度）。
- 块类别：标题、自然段、列表项、图表题注、公式、脚注、参考文献条目、表格行。
- 问答索引：`section-index` 接口把「章节标题 + 连续正文」切成带起止页的索引片段，
  片段不跨章节、带章节标题，可直接作为检索单元。

**识别结果不是新的原文证据**：块的 `text` 就是版面上的同一段文字；识别只是给它一个
可引用的单位（章节/段/列表项…）与位置（页码/bbox）。引用与「逐字证据」口径不变。

> 在此基础上另有**参考文献识别**（文末列表 + 页下注 + 正文引用标记，阅读页「参考」面板），
> 见 [`REFERENCES.md`](REFERENCES.md)。

## 2. 识别规则（本机纯函数，不调模型）

代码：`packages/core/src/blocks.ts`；段落边界的几何规则来自
`packages/shared/src/paragraph.ts`（与阅读区「选中一段」批注共用同一套规则，
所以界面里选中的一段与索引里的一块是同一段文字）。

### 2.1 行 → 块

1. 每页先按已有阅读顺序取行（`structure.readingOrderLines`）：双栏页按「左栏整栏 → 右栏」，
   跨栏标题作为分割点；页遮罩掉的区域不参与。
2. 排除跨页重复的页眉/页脚文字（`structure.repeatedMarginTexts`）。
3. 用段落几何规则合并行：行距突变、首行缩进、字号突变、上一行明显短于栏宽且以句末标点
   收尾、列表/题注/编号开头、参考文献悬挂缩进等都会切段。一个自然段 = 一个块。
4. 对块分类（按优先级）：
   - 作者/单位/邮箱行 → 不当标题（首页居中、字号偏大也排除）；
   - 标题：编号标题（`2.1 Methods`、`第3章`、`I.`、`A.`）、章节词（Abstract/References…）、
     或「本页最大字号量级 + 居中短行」；
   - 图表题注（`Figure 1`/`表 3`/`Table II`/`资料来源`）；
   - 公式（数学符号密度高、连续词少）；
   - 表格行（行内存在明显列间距，`LayoutLine.gap ≥ 0.03`）；
   - 列表项（项目符号，或「编号 + 大写/汉字」开头，避免把句中 `(3) write…` 误判）；
   - 脚注（字号小于正文 0.88 倍、贴近页底、块不超过 3 行）；
   - 其余 → 自然段。

### 2.2 块 → 章节

1. **优先 PDF 书签目录**：每个目录项落到对应页上最像它的块（先精确匹配归一化标题，
   再包含匹配，最后退到该页第一个标题块/第一个块）。章节标题用目录文字，`origin='outline'`。
2. **没有目录时**按识别出的标题块分节，`origin='heading'`；`level` 由编号层级决定
   （`2.1` 是 2 级）。
3. 第一个标题之前的块（封面、作者、摘要等）单独成「前置部分」（`level=0`、`title` 为空
   或文档名）。
4. 小节类别：`abstract` / `references` / `appendix` / `body` / `front`；
   参考文献小节里的正文块改标 `reference`。

### 2.3 块 id 稳定性

块 id 为阅读顺序的 `b0…bn`；同一版面（同一 PDF、同一页遮罩）重算结果完全一致。
文件改变或页遮罩变化后，Store 的识别缓存自动失效重算。

## 3. 数据模型

```ts
interface ContentBlock {
  id: string;              // b{index}，阅读顺序
  page: number;            // PDF 物理页（1 起）
  kind: 'heading' | 'paragraph' | 'list' | 'caption' | 'table' | 'formula' | 'footnote' | 'reference';
  level?: number;          // 标题层级（1 起）
  section: number;         // 所属章节下标；前置部分为 -1
  text: string;            // 块文字（版面上的同一段文字）
  bbox: [number, number, number, number]; // 归一化页面坐标，左上原点
  lines: number;           // 组成这一块的行数
}

interface DocumentSection {
  index: number;
  title: string;
  level: number;
  kind: 'front' | 'body' | 'abstract' | 'references' | 'appendix';
  origin: 'outline' | 'heading';
  pageStart: number; pageEnd: number;
  blockStart: number; blockEnd: number; // sections 覆盖的块下标（闭区间）
  parent: number | null;
}
```

## 4. 接口

### 4.1 `GET /api/v1/documents/:id/blocks`

返回 `DocumentBlocks`：`documentId`、`sections[]`、`blocks[]`、`stats`。

- `?text=0`：只返回位置与类别，省略块文字（结构浏览/缩略视图用）。
- `stats`：页数、块数、各类块数、章节数、`basis`（章节依据：`outline`/`heading`/`none`）。

### 4.2 `GET /api/v1/documents/:id/section-index?max_chars=1200&overlap=120`

返回 `DocumentSectionIndex`：`chunks[]`（`id`/`section`/`sectionTitle`/`level`/`page`/`pageEnd`/`text`/`characters`）
与 `totalCharacters`、`maxChunkCharacters`。

- `max_chars`：200–20000，默认 1200；保证 `characters ≤ max_chars`（章节标题过长时按一半截断）。
- `overlap`：0–1000，默认 120；片段边界带上一片段尾部若干字符，避免答案被切在边界上。
- 片段 id 稳定：`{documentId}:s{section}:{part}`。

API 客户端同步新增 `getDocumentBlocks()` / `getSectionIndex()`（`packages/api-client`）。

## 5. 与问答索引的关系

- **识别层 + 章节级索引片段**：`section-index` 的输出就是「可检索单元」：
  每段带章节标题、起止页，不跨章节。
- **独立问答的库内检索**（`packages/core/src/section-context.ts`）：
  检索排序**完全不变**（仍是 `retrieval.retrieve` 的 chunks/派生来源、RRF、rerank）；
  命中之后，用 `getDocumentBlocks` + `getSectionIndex` 把「命中页 → 命中段落/所在章节片段」
  作为模型上下文。提示词与来源都标注「命中片段 · 章节标题」，并说明不是已读全文；
  来源新增可选 `sectionTitle` / `pageEnd`，跳转仍按原命中页。
- **退回规则**：识别不出块（扫描页没有文本层、识别失败）、命中词与页面上任何块都不重合、
  或该页被用户校订过（块文字来自 PDF 文本层，可能与校订正文不一致）时，退回整页原文，
  来源不带 `sectionTitle` 并标「整页原文」——与未启用块识别时一致。
- **证据口径不变**：片段就是原页上的同一段文字，不是模型转述；引用仍指向原文页，
  `citation_support`/越界引用检查照旧；库内检索依然**不是**逐段审计路径（要审计请用跨文献精读）。
- 检索结果元数据：`SearchHit` 新增可选 `sectionTitle`/`blockId`，`GET/POST /search` 自动补。
  只使用**已就绪**的识别缓存（`Store.peekDocumentBlocks`）：检索不会为了"命中在哪一节"去解析
  整篇 PDF；缓存未就绪时后台预热（最多 3 篇，避免搜索这种高频操作把整库 PDF 都解析一遍），
  下一次检索就能带上章节。
- 跳转定位：`ChatSource` 新增 `locate`（检索命中的那一行），界面跳转时优先用它做逐字定位高亮；
  `quotes`/`anchor` 的语义不变（证据/复核锚点），`locate` 只用于定位、不参与引用核验。
- **按页切批的约束**：跨文献精读的批次切分保持页码粒度，**不**按章节边界切批。原因：
  逐字证据核验依赖"来源 = 页粒度原文"，把来源切成章节片段会让恰好落在片段外的引文被误丢。
  章节信息只用于"显示 / 定位 / 索引 / 问答上下文"，不改变阅读批次与证据来源的粒度。

## 6. 已知限制

1. **跨页段落**：段落识别按页进行，被分页切开的自然段会成为两个块（两页各一块）；
   章节与索引片段仍连续，不影响引用页。
2. **扫描件/OCR 页**：OCR 行没有字号，标题判定主要靠文字规则；纯图片页仍依赖 OCR 文本，
   没有文字就没有块。
3. **启发式边界**：句首括号编号（如 `(3) write…`）可能被单独切成一块；表格按「列间距」
   识别，无文本层的表格识别不到；多行公式可能被并入相邻块。
4. **章节依据**：没有书签目录时，章节完全依赖标题规则；标题漏识别会少一节，
   但块本身仍可用（`basis='none'` 时只有块、没有章节）。
5. **页码是 PDF 物理页**，不是印刷页码；引用跳转仍按物理页。
6. **性能**：识别是纯函数，一篇几百页的书首次计算在百毫秒级；Store 内有进程内 LRU
   （8 篇，随文件/遮罩版本失效），不写数据库。

## 7. 验证

- 单测：`pnpm --filter @studianda/core exec vitest run test/blocks.test.ts`
  （段落合并、标题/列表/题注/脚注/参考文献、目录分节、遮罩、双栏不串栏、索引片段长度与 id 稳定性、
  Store 缓存与失效、HTTP 200/400/404）。
- 命中片段定位：`test/section-context.test.ts`（选块/选章节片段/无章节/无块/null 退回）。
- 问答端到端：`test/standalone-qa-section-context.test.ts`（命中片段进提示词与来源 `sectionTitle`、
  校订页退回整页、模型调用次数不变）。
- 全量：`pnpm typecheck`、`pnpm test`、`pnpm build`。
- 真实样本（双栏样例 PDF）：36 块、10 节（含参考文献小节 4 条条目）、索引片段最长 703 字符
  （`max_chars=800`）。
