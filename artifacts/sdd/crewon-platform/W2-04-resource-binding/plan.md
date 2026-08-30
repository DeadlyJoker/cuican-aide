# W2-04RB Implementation Plan

## B1a: Strict State record

1. [x] Red：新增 sibling record Harness，先引用不存在的 record/status/closed enum。
2. [x] 实现 strict bounded record、closed status/mode/location/kind/scope、materialization consistency 与 canonical hash。
3. [x] 覆盖 tamper、invalid lifecycle、local materialization、Debug redaction。
4. [x] targeted/full state test、scoped fix、final fmt。

## B1b1: Migration and resolve/read/reactivate runtime

1. [x] 新增 additive `0045_provider_resource_bindings.sql`，包含 parent foreign keys、exact selection unique constraint 和 bounded checks。
2. [x] 实现 create/existing/reactivate、read/reopen/concurrency 与 parent exact validation。
3. [x] State runtime 在事务内 exact 校验 Provider connection owner/provider/protocol 和 durable workspace existence。
4. [x] targeted + full `crewon-state`、migration smoke、scoped fix、final fmt。

## B1b2: Unbind and bounded lifecycle

1. [x] 实现 owner-scoped idempotent unbind、cross-owner not-found 与 time/revision conflict。
2. [x] 覆盖 persisted tamper、capacity 1024 和 unbind/reactivate 竞态。
3. [x] targeted + full `crewon-state`、scoped fix、final fmt。

## B2a1: session-owned Workspace proof

1. [x] WorkspaceRegistry 增加 session-owned binding resolver，返回 path-free WorkspaceRef。
2. [x] 每次解析先 bounded refresh Root Catalog，跨 session、未知 binding 和已移除 root fail-closed。

## B2a2: Federation snapshot and State adapter

1. [x] bind 复用 Provider Resource begin/finish authority bracket 和 pinned live catalog exact read。
2. [x] Federation `resolve_binding` 负责 capability/execution location/Manifest 一致性，显式 adapter 负责 strict State record。
3. [x] 无 materializer 时拒绝 localSnapshot/localFork；unbind 保持 State-only cleanup。

## B2b: experimental RPC and notification

1. [x] 注册 experimental resource/bind、resource/unbind 与 resource/binding/updated。
2. [x] notification 只发送给 initiating connection，并复用 experimental capability/opt-out transport filter。
3. [x] TestAppServer、schema/README、protocol/app-server tests。

## Review Gate

- B1a、B1b、B2a1、B2a2、B2b 分开评审；不在 B1 加 RPC，不在 B2 接 UI/Task/Dynamic Tool consumer。
- 不新增 crate；State 不依赖 resource-federation。
- 完整 workspace `just test` 仍需用户明确授权。
