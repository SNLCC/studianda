# electron-builder / app-builder-lib（构建期组件）

安装包 `Studianda-Setup-*.exe` 由 **electron-builder 26.18.0**（含 `app-builder-lib` 26.18.0）的 NSIS 目标生成。本项目在构建期使用其 NSIS 模板，并用 `scripts/patch-nsis-templates.mjs` 将 WinShell 插件调用改写为项目自己的 `apps/desktop/build/nsis/aumid.nsh`。

- 许可证：MIT License
- 版权：Copyright (c) 2015 Loopline Systems；作者 Vladimir Krivosheev 及贡献者
- 官方仓库：<https://github.com/electron-userland/electron-builder>
- 官方 LICENSE 原文：`upstream/official/repos/electron-userland_electron-builder-LICENSE.txt`
- 本项目**不随安装包分发** electron-builder 的源码或构建二进制；但安装器内的 NSIS 脚本由 MIT 许可的模板生成，故在 `legal/` 中保留其版权与许可声明。
