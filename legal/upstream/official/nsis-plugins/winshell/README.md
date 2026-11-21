# WinShell 插件：已由本项目脚本实现替代

## 结论

**本项目的安装包不包含、也不调用 `WinShell.dll`，但保留了它原本提供的快捷方式
AUMID 行为。**

## 为什么不能继续用

- 上游页面 <https://nsis.sourceforge.io/WinShell_plug-in> 只在 Plugin Info 里标注
  **"License: Freeware"**，页面没有任何许可条款；
- 官方发行包 `WinShell.zip`（<https://nsis.sourceforge.io/mediawiki/images/5/54/WinShell.zip>，
  2 864 B）解开后**只有两个 DLL**（`Plugins/x86-ansi/WinShell.dll` 与
  `Plugins/x86-unicode/WinShell.dll`，各 3 072 B），既没有 `LICENSE`/`README`，也没有源码；
- “Freeware”只说明可以免费取得，**不构成再分发授权**；在没有明示授权的情况下，版权默认保留
  （再分发权未授予）。

electron-builder 的**旧版本** NSIS 模板曾调用 `WinShell::SetLnkAUMI`、
`WinShell::UninstShortcut` 与 `WinShell::UninstAppUserModelId`，从而把该 DLL 嵌进安装器。
本项目固定的 `app-builder-lib@26.18.0` 的全包中 **“WinShell” 出现 0 次**（模板已不再调用该插件），
`scripts/patch-nsis-templates.mjs` 在 pinned 版本上不会改动任何文件，属幂等防回归措施。

## 现在怎么实现

`scripts/patch-nsis-templates.mjs` 在 electron-builder 编译 NSIS **之前**，把（若再出现的）WinShell
调用改写成 `apps/desktop/build/nsis/aumid.nsh` 里的宏（由 `electron-builder.yml` 的 `nsis.include` 注入）：

| 原调用 | 现在的实现 |
|---|---|
| `WinShell::SetLnkAUMI "<lnk>" "<AUMID>"` | `${StudiandaSetLnkAUMI}`（`$R8` = 快捷方式，`$R9` = AUMID） |
| `WinShell::UninstShortcut "<lnk>"` | `${StudiandaClearLnkAUMI}`（`$R8` = 快捷方式） |
| `WinShell::UninstAppUserModelId "<AUMID>"` | `${StudiandaUnregisterAUMID}`（`$R9` = AUMID） |

宏内部只使用 NSIS 自带的 System 插件与官方 `Win\COM.nsh` / `Win\Propkey.nsh` 定义，调用
Windows 公开 API：

1. `CoCreateInstance(CLSID_ShellLink)` → `IPersistFile::Load(path, STGM_READWRITE)`
2. `QueryInterface(IID_IPropertyStore)` → `SetValue(PKEY_AppUserModel_ID, VT_LPWSTR)`
3. `Commit()` → `IPersistFile::Save(path, TRUE)`
4. 清除时改用 `VT_EMPTY` 的 `SetValue`，删除该属性

不包含任何第三方插件、不自编译 DLL、不下载任何二进制：安装器里只有脚本文本。

## 行为是否与以前一致

- 安装时仍会把 `com.studianda.app` 写入开始菜单/桌面快捷方式的 `System.AppUserModel.ID`；
- 升级迁移快捷方式、卸载时仍会清除旧快捷方式上的该属性；
- 应用启动时仍调用 `app.setAppUserModelId(...)`，与快捷方式属性一致；
- 因此“把未运行的快捷方式固定到任务栏”“系统通知归属”等依赖 AUMID 的行为与使用
  WinShell 时相同。

## 验证

- 宏的独立验证：用缓存的 makensis 编译一个测试安装器，创建快捷方式 → 调用宏 → 用
  `SHGetPropertyStoreFromParsingName` + `IPropertyStore::GetValue` 读回，得到
  `vt=31 / value=com.studianda.test`；再调用清除宏后读回 `vt=0`（属性已删除）。
- 打包验证：`node scripts/package.mjs --skip-build --installer` 成功；`scripts/patch-nsis-templates.mjs`
  复核模板中 `WinShell::` 调用数为 0，且 `aumid.nsh` 已定义三个宏。
