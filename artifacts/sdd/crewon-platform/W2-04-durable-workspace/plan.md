# W2-04DW Implementation Plan

## Stage A: State kernel

1. 增加 migration `0042_durable_workspace_roots.sql`，只包含 immutable root identity mapping。
2. 在 `crewon-state` 新增独立 record/validation 模块；不扩张 `runtime.rs` 或 `crewon-core`。
3. 在独立 `runtime/durable_workspace.rs` 实现 create-or-resolve 与 exact read；使用 `BEGIN IMMEDIATE` 和数据库唯一约束处理并发。
4. 测试放在 sibling `*_tests.rs`，覆盖 validation、reopen、concurrency 和数据库篡改。

## Stage B: app-server adapter（已完成）

1. `WorkspaceRootCatalog` 对 canonical root 生成 bounded fingerprint，但不把 path 交给 State。
2. verified authenticated principal 使用 State mapping 获得 stable workspaceKey；connection-scoped identity保持旧 session registry。
3. 模块 Harness 覆盖 State close/reopen、catalog removal、connection key 隔离与 path-free projection；真实 signed-bearer WebSocket Harness 覆盖 app-server process restart 后 stable key 恢复。
4. Stage B 不新增 Provider API；通过后再恢复 W2-04 A1-A3。

## 风险、兼容与回滚

- migration additive；旧 session workspace key 不迁移、不双写，继续按连接失效。
- stable key 只在 authenticated path opt-in，不改变默认 Stdio/InProcess/legacy WebSocket 行为。
- 回滚 Stage A 只需停止调用新 State API；表可保留，不影响旧路径。
- Stage A 与 Stage B 分开评审；adapter 独立模块 67 LoC，`workspace.rs` 保持低于 500 LoC。
