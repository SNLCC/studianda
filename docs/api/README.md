# API 契约清单（生成物）

`route-manifest.json` 由 [`scripts/check-contract.mjs`](../../scripts/check-contract.mjs) 生成，
用来把 `packages/core/src/server.ts` 的路由与 `packages/api-client/src/index.ts` 的方法对拍，
防止"改了服务端忘了客户端"。

## 什么时候跑

- 新增/删除/修改任何 `packages/core/src/server.ts` 路由后；
- 修改 `packages/api-client` 方法路径后；
- 发版前（建议与 `pnpm typecheck`、`pnpm test` 一起）。

```bash
pnpm check:contract
```

- 通过：输出 `[contract] ok`，退出码 0；
- 失败：打印差集并以退出码 1 结束。

## 判定口径

- 比较 **方法 + 路径**：`GET /api/v1/documents/:p`。
- 路径参数统一为 `:p`（`${id}`、`${encodeURIComponent(id)}`、Fastify `:id` 等价）。
- query 不参与比较；`${suffix}`/`${query}`/`${params}` 视为查询串。
- 只检查"接口是否被客户端覆盖"，不检查参数/返回类型；参数与响应类型由 `packages/shared` 的
  TypeScript 类型和 core 测试兜底。

## 白名单

`scripts/contract-allowlist.json` 只允许两类条目，且必须写 `reason`：

1. **壳专用**：例如 `secrets*` 由桌面主进程通过 Electron safeStorage + IPC 处理，不经过 api-client；
2. **兼容保留**：例如整页 navigation 覆盖接口，目前只有新客户端不使用的兼容路由。

新增白名单必须在代码评审中说明原因；白名单本身也是契约的一部分，不能用来掩盖漏改。

## 说明

当前是"手工契约 + 差集门禁"，本清单作为防漂移基线保留：服务端路由数为 208 条，
调整路由或 api-client 方法后重新运行 `pnpm check:contract`。
