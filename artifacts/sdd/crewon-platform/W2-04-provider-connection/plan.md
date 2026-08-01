# W2-04PC Implementation Plan

## Stage A: State kernel

1. migration `0043_provider_connections.sql` 只新增 immutable connection identity table。
2. 独立 `provider_connection_records.rs` 定义 strict record、canonical hash、Debug redaction 与 resolve outcome。
3. 独立 `runtime/provider_connection.rs` 使用 `BEGIN IMMEDIATE` 实现 create-or-resolve 与 exact read。
4. sibling tests 覆盖 validation、reopen、concurrency、tamper 与 capacity。

## Stage B: Provider API

1. [x] 新增 projection/resource DTO；client-selected Credential selection Params 经 review 撤回，禁止复用包含 authority 状态的旧 Ref 作为输入。
2. [x] prototype processor 完成 authority review 后撤回：它证明双检算法可行，但 production 没有 Credential provisioning，不能注册或接线。
3. [x] production Agent Platform factory 使用显式 `/provider/v3/` endpoint/mode 与 Provider Run RS256 key，复用 W2-03 endpoint/HTTP guard、authorizer 与 strict descriptor；禁止复用旧 Open API key 或从 identity-source URL 猜路径。
4. [ ] Resource list/read 只消费已重验的 live provider client；Resource Binding persistence 另做独立可评审切片。
5. [x] 完成 `W2-04-provider-access-grant` 前置，并在独立 composition 切片中从真实 process environment 构造私有 runtime、注入 grant-aware processor，以 restart/config-removal/readiness Harness 证明 authority 不会残留。
6. [x] 注册 provider/connect/read RPC 与方法级 schema/TestAppServer；Resource list/read 与 Binding persistence 继续独立评审。

## Review 与回滚

- Stage A production logic 低于 500 LoC，总非机械 diff 低于 800 行。
- migration additive，无依赖与外部 API 变化。
- 回滚只需停止调用新 State API；旧表可保留，不影响现有 session、rollout、Workspace 或 Provider Run。
