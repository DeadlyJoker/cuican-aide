# W2-06 Implementation Plan

## P0: Protocol schema integrity amendment

1. [x] Red：生成 TypeScript 相对导入完整性 Harness 复现 `ResourceReadParams` 被 `McpResourceReadParams` 子串误判。
2. [x] Green：按 TypeScript identifier 边界裁剪无用 import，稳定 schema 不再含悬空引用。
3. [x] 最终 `just test -p crewon-app-server-protocol`：246/246。

## P1: Experimental platform TypeScript overlay

1. [x] Red：overlay fixture/file-set/import/index 测试先失败。
2. [x] 从 Rust DTO 递归导出 Workspace、Provider、Resource experimental client types；稳定 schema 零语义变化。
3. [x] 更新 schema writer、README 和 CrewON UI path alias。
4. [x] targeted protocol tests、schema regeneration、scoped fix/fmt。

## P2: RPC client and recovery controller

1. [x] Red：FakeWebSocket/RPC transport 覆盖 list/read/bind/unbind、重复 cursor、etag gap、断线 generation、revoked/unavailable、迟到 response。
2. [x] 新建独立 `provider-resource` client、closed error classification、bounded pagination 与 recovery controller。
3. [x] AppServerClient 只增加窄 transport adapter，不在大文件内实现状态机。
4. [x] 证明请求与持久化不含 Secret、actor、tenant、space、root path；不使用 localStorage。

## P3: Independent components and snapshots

1. [x] Red：真实 resource projection、空态、连接中、不可用、已绑定、能力不支持的组件 snapshot。
2. [x] 实现紧凑 Provider/Resource picker 与纯 ResourceRef -> Composer tag 映射。
3. [x] 验证选择 Skill/MCP/Knowledge 后只有标签，没有重复文本或多余换行；文件/文件夹/图片语义不变。
4. [x] 不接 `App.tsx`，记录 W2-08 props/events 接线契约。

## P4: Verification Gate

1. [x] `pnpm --filter @crewon/ui test`：222 files / 1270 tests Green。
2. [x] `pnpm --filter @crewon/ui build`：Green，只有既有 chunk size warning。
3. [x] 人工检查 snapshots 和 generated overlay diff。
4. [x] 更新 verification 与 Wave 状态；完整 Rust workspace test 仍需用户授权。
