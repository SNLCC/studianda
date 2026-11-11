# 品牌、名称与图标（Brand Notice）

本文件说明「勘读 / Studianda」的名称与图标作为项目标识的使用方式。

## 名称

- 中文名：**勘读**；英文名：**Studianda**。
- 英文名 Studianda 取自新拉丁语 *studianda*（「有待研习之事」）：词干 *studi-*（研习）+ 动形词中性复数词尾
  *-anda*（「应当被……的事物」的集合），与 agenda / memoranda / corrigenda 属同一构词法。完整的造词、含义、
  读音（/ˌstuː.diˈæn.də/，重音在 AN 音节）与写法规范见源码仓库 `docs/brand/NAME.md`。
- 名称与图标用于标识本项目及其发布版本。修改或再分发时，请保留来源说明，避免使用相同名称/图标让用户误以为是本项目官方版本。

## 图标

应用图标（叠书版与开卷版）、安装包/卸载程序图标、窗口图标以及应用内品牌标记，均由本仓库脚本
`scripts/generate-icon.py` 以几何图元程序化生成；生成过程不读取外部图片或字体。

- 图标生成脚本与输出文件见源码仓库 `scripts/generate-icon.py`、`apps/desktop/build/` 与 `docs/brand/`；
- 设计说明、色板与文件清单见源码仓库 `docs/brand/README.md`。

## 第三方

第三方软件组件的许可证见 [`legal/THIRD-PARTY.md`](THIRD-PARTY.md)；随应用内置的字体见 `legal/fonts.json`。

### Zotero 集成

「Zotero」是 Corporation for Digital Scholarship **注册的商标**
（<https://www.zotero.org/support/terms/trademark>）。本项目仅在兼容性说明中
作指称性使用，与 Zotero 项目无隶属、授权或背书关系；Zotero 集成只通过 Zotero 官方提供的
本机 API / Web API 读取用户自己的资料库与附件，不包含、不修改、也不重新分发 Zotero 的
软件代码、图标、主题或字体资源。用户使用 Zotero 云端同步或第三方 WebDAV 服务时，
还应遵守对应服务自身的条款与隐私政策。

## 联系

如需商业授权，请通过项目仓库公开的联系方式与维护者联系。
