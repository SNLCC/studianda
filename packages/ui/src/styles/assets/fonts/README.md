# 随包字体（woff2 子集）

本目录的 `*.woff2` 是**子集化后的 Web 字体**，由 `scripts/build-fonts.py` 从各上游官方发布版转换而来，不是上游原始文件。对应的上游版本、源文件、SHA-256、字重与许可文件登记在仓库根目录的 `legal/fonts.json`，请以该文件为准。

内容共五个字体族、九个文件：`StudiandaSerifSC-*`（Noto Serif CJK SC）、`StudiandaSansSC-*`（Noto Sans CJK SC）、`StudiandaKaiSC-Regular`（LXGW WenKai GB）、`StudiandaSerifLatin-*` / `StudiandaSansLatin-*`（latin-greek-cyrillic）。其中拉丁伴随字体只通过 CSS `unicode-range` 局部补充 CJK 字体缺失的码位，不单独作为界面字体使用。

- **许可**：这些字体以 **SIL Open Font License 1.1** 授权，**不适用**本项目根目录 `LICENSE`（Apache License 2.0）中的代码许可。字体的授权不因本项目代码许可而收紧，也不随项目整体许可改变。
- 许可全文与逐字版权行见 `legal/font-licenses/`；机器可读清单见 `legal/fonts.json` 的 `license` / `licenseFile` / `copyright` 字段。
- Kai 族（`StudiandaKaiSC-Regular.woff2`）已按 OFL §3 将字体名改为 `Studianda Kai`，name 表中不再包含上游保留名称（`霞鹜`、`霞鶩`、`落霞孤鹜`、`落霞孤鶩`、`LXGW`）。
- **不得**把这些 woff2 解出、转回 TTF/OTF 后作为可安装桌面字体对外分发或上传字体平台；它们仅经 CSS `@font-face` 在应用内加载，应用不提供字体安装或导出功能。
- **不要手动编辑**这些二进制文件：改名、改 `name` 表、裁剪字形都会改变版权与许可声明，可能同时违反 OFL 的保留名称与版权条款。需要变更时修改 `scripts/build-fonts.py` 的参数并重新生成，并同步更新 `legal/fonts.json`、`legal/font-licenses/README.md` 与 `legal/THIRD-PARTY.md`。
