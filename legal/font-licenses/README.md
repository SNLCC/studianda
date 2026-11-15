# 字体许可文本（legal/font-licenses）

本目录存放随包字体的**上游许可原文**，以及与之配套的版权声明说明。

## 1. 这里的 `.txt` 是上游原文，禁止编辑

本目录下的四个 `.txt` 文件是上游发布的 **SIL Open Font License 1.1 原文**，逐字节照抄，**不得修改**。它们不是本项目的文档，而是许可条款本身；任何修订（包括换行、空格、版本号）都会破坏"逐字复制"这一 OFL §2 的要求。若上游发布新版本，应当整体替换文件，而不是局部编辑。

| 文件 | 对应字体 | 上游 |
| --- | --- | --- |
| `NotoSerifCJK-OFL-1.1.txt` | Noto Serif CJK SC | notofonts/noto-cjk |
| `NotoSansCJK-OFL-1.1.txt` | Noto Sans CJK SC | notofonts/noto-cjk |
| `LXGWWenKaiGB-OFL-1.1.txt` | LXGW WenKai GB | lxgw/LxgwWenKaiGB |
| `NotoLatin-OFL-1.1.txt` | Noto Serif / Noto Sans（latin-greek-cyrillic） | notofonts/latin-greek-cyrillic |

（路径均相对于仓库根目录；机器可读的完整清单见 `legal/fonts.json`。）

## 2. 版权行（name ID 0）：五个字体

**为什么需要专门列出：** Noto CJK 上游发布的许可文本（`NotoSansCJK-OFL-1.1.txt`、`NotoSerifCJK-OFL-1.1.txt`）**本身不含任何版权行**，只有 OFL 条款正文。而 OFL §2 要求"每份副本都包含上述版权声明与本许可"。因此本项目把版权声明承载在**字体二进制 `name` 表的 nameID 0** 中（这是上游 TTF 自带的、面向用户的机器可读字段），并在三处重现它：本文件、`legal/fonts.json` 的 `copyright` 字段、`legal/THIRD-PARTY.md`。三者与二进制中的 nameID 0 逐字节一致，可由 `scripts/audit-packaged-legal.mjs` 与人工脚本校验。

以下版权行均为对应 woff2 文件 `name` 表 **nameID 0** 的逐字内容；同一字体的多个字重共享同一字符串。

### 1. Noto Serif CJK SC — `StudiandaSerifSC-Regular.woff2`、`StudiandaSerifSC-SemiBold.woff2`

```
© 2017-2024 Adobe (http://www.adobe.com/).
```

许可文本：`NotoSerifCJK-OFL-1.1.txt`（原文无版权行，见上）。

### 2. Noto Sans CJK SC — `StudiandaSansSC-Regular.woff2`、`StudiandaSansSC-Medium.woff2`

```
© 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
```

许可文本：`NotoSansCJK-OFL-1.1.txt`（原文无版权行，见上）。保留字体名称为 `Source`；本项目未使用该名称作为字体主名（参见下文字体族名）。

### 3. LXGW WenKai GB（霞鹜文楷 GB）— `StudiandaKaiSC-Regular.woff2`

```
Copyright 2022-2026 LXGW (https://github.com/lxgw/LxgwWenKaiGB), with Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'.
Copyright 2020 The Klee Project Authors (https://github.com/fontworks-fonts/Klee)
```

（nameID 0 为两行，换行符为 `\n`；JSON 中写作 `\n` 转义。）

许可文本：`LXGWWenKaiGB-OFL-1.1.txt`。该字体的 `name` 表**没有 nameID 7（商标）**，因此无商标声明可引；保留名称只出现在 nameID 0 的版权行中。随包 woff2 的 nameID 1/3/4/6 均已按 OFL §3 改为 `Studianda Kai` / `StudiandaKaiSC-Regular`，不再包含任何保留名称。

### 4. Noto Serif（latin-greek-cyrillic）— `StudiandaSerifLatin-Regular.woff2`、`StudiandaSerifLatin-SemiBold.woff2`

```
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)
```

许可文本：`NotoLatin-OFL-1.1.txt`。

### 5. Noto Sans（latin-greek-cyrillic）— `StudiandaSansLatin-Regular.woff2`、`StudiandaSansLatin-Medium.woff2`

```
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)
```

许可文本：`NotoLatin-OFL-1.1.txt`。

## 3. LXGW 的 `[ADDITIONAL PERMISSION]`（逐字）

`LXGWWenKaiGB-OFL-1.1.txt` 第 1 行的版权声明之后，紧跟一段由作者附加的许可。原文逐字如下（紧接在 `[ADDITIONAL PERMISSION]` 标记之后）：

```
The Reserved Font Names '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW' may continue to be used in Modified Versions recompiled from the Original Version, without modifications to the font source code; or in Modified Versions subsetted or converted to other formats (e.g., WOFF/WOFF2) solely for web font delivery, provided such Modified Versions are not made available as installable desktop fonts (e.g., on mainstream platforms like Google Fonts, or third-party non-commercial platforms recognized by the author @lxgw; other web font platforms please contact the author @lxgw for confirmation).
```

### 它放宽了什么

OFL §3 默认禁止修改版使用保留名称。这段附加许可给"两类修改版"开了口子：

1. **从原始版本重新编译、且未改动字体源码**的修改版；或
2. **子集化 / 转成其他格式（如 WOFF/WOFF2）、仅用于 Web 字体交付**的修改版。

**条件（"not made available as installable desktop fonts"）**：这两类修改版**不得作为可安装的桌面字体对外提供**——原文举例为主流平台（Google Fonts）或作者认可的非商业第三方平台；其他 Web 字体平台需先联系作者确认。换言之：**允许"网页内加载"，不允许"下载后装进系统字体目录"**。这个条件针对的是分发形态，不是技术处理本身。

### 本项目的分发为什么满足该条件

- Kai 的 woff2 唯一存在位置是 `packages/ui/src/styles/assets/fonts/`，构建后打入 `app.asar`，由 CSS `@font-face` 在应用界面内加载；
- 应用**不提供**字体安装、导出、另存或"安装到系统"功能，也不把字体作为独立下载项提供给用户；
- 因此不存在"把 woff2 变成可安装桌面字体对外提供"的分发形态。子集化 + 转 WOFF2 本身属于上述第 2 类修改版。

### 为什么本项目其实**不依赖**这项附加许可

本项目按 OFL §3 的要求，直接把 Kai 的字体主名改掉了：`name` 表的 nameID 1/3/4/6 均为 `Studianda Kai` / `StudiandaKaiSC-Regular`，**不包含 `霞鹜`、`霞鶩`、`落霞孤鹜`、`落霞孤鶩`、`LXGW` 中任何一个保留名称**。既然修改版没有使用保留名称，OFL §3 的限制根本不触发，也就无需援引这段附加许可。附加许可在此仅作为"上游确实给出过额外授权"的事实记录，属于**冗余的、非必需的**合规余量：即使该许可不存在，本项目的做法依然合规；反过来，即使某天分发形态改变，只要保持改名，也依然合规。

## 4. 再分发者注意

若你要再分发本项目（或其修改版），请遵守以下各点：

- **保留许可原文**：不要删除或修改 `legal/font-licenses/` 下的四个 `.txt`。
- **保留版权行**：不要删除 `legal/fonts.json` 的 `copyright` 字段，也不要删除 `legal/THIRD-PARTY.md` / `legal/NOTICE.html` 中的字体版权声明。
- **不得单独售卖字体**：OFL §1 禁止把字体软件本身（原始或修改版）作为商品单独出售；随应用一起分发可以。
- **不得作为可安装桌面字体分发**：不要把 woff2 解出、转回 TTF/OTF 后作为桌面字体提供下载或上传字体平台。这既是 OFL 下游义务的稳妥做法，也是 LXGW 附加许可明确排除的形态。
- **不得用保留名称命名修改版**：修改版（含子集、转格式）的主字体名不得使用 `霞鹜`、`霞鶩`、`落霞孤鹜`、`落霞孤鶩`、`LXGW`、`Source`。若你继续修改字体并对外分发，请像本项目一样改用自有名称。
- **字体必须继续以 OFL 1.1 分发**：OFL §5 要求字体（含修改版）整体继续置于 OFL 之下，不能改为其他许可。

## 5. 字体不受本项目代码许可约束

本项目自身的源代码与文档采用 **Apache License 2.0**（见 `legal/PROJECT-LICENSE.txt`）。**随包的五个字体族不属于该许可的授权范围**，它们各自继续由 **SIL Open Font License 1.1** 授权（Kai 另附上述 `[ADDITIONAL PERMISSION]` 记录）。OFL 允许商业使用、修改与再分发（须遵守其条件），其授权不因本项目代码许可的变化而收紧或改变。引用字体时请依据 `legal/fonts.json` 的 `license` / `licenseFile` 字段，而不是项目根目录的 `LICENSE`。
