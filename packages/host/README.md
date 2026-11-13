# @studianda/host

宿主契约包。`RuntimeAdapter`、`HostCapabilities`、窗口/更新/数据位置接口都在这里；
`@studianda/app` 与 `@studianda/ui` 只依赖它，不直接接触 Electron 或 DSH。

本包是项目自有代码，按根目录 `LICENSE` / `NOTICE` 的 PolyForm Noncommercial 1.0.0
发布；不包含第三方运行时代码。

## 实现方

- `apps/desktop`：Electron 壳（窗口、safeStorage、原生文件对话框、更新）。
- 未来的 `packages/host-dsh`：DSH 宿主插件（sidecar、面板、HTTP 资源、Peer 权限）。

## 新增能力时的规则

1. 先在这里加**可选**方法或能力位；不要直接在 app/ui 里判断宿主。
2. app/ui 必须能在能力缺失时降级，不能假定新方法一定存在。
3. 每个新方法都要在 Electron 与未来 DSH 实现里明确“支持 / 不支持”，
   不支持时由界面给出中文说明或隐藏入口。

接入步骤与规则细节见维护者本地资料（不随仓库发布）；包边界由
`pnpm check:host` 持续检查。
