# W2-04DW Verification

状态：Discovery/spec、State Red/Green 与 Stage B app-server adapter 已完成；W2-04 projection/resource DTO、Provider Access Grant State + discovery provisioning + lifecycle resolver 与默认关闭的 production factory/config kernel 已完成。client-selected Credential processor 已撤回，grant-aware processor/startup composition/RPC/Resource API 尚未实现。

## Discovery evidence

- `authenticated_principal_tests::reconnect_preserves_principal_authority_but_rotates_connection_facts` 已证明重连后 actor/Tenant/Space、PolicyActor 和 CredentialOwner deep equal，session/trace 不同。
- `WorkspaceRegistry` 由 `owner_session_id` 授权，`refresh` 对每个新 session 使用 `Uuid::new_v4()` 生成 workspaceKey；旧 key 明确不能跨连接或重启恢复。
- Task/CloudExecutionSpec/Provider journal 已持久引用 workspaceKey，因此直接接 W2-04 会留下不可恢复引用。
- W1-02 的 session-scoped 选择在当时没有可信 principal 时是正确的；本 amendment 不修改旧路径，只为 authenticated principal 增加独立 durable identity。

## State Red / Green

- Red：新增 sibling Harness 先引用不存在的 `DurableWorkspaceRootRecord`、resolve outcome、StateRuntime methods 与 runtime module；`just test -p crewon-state durable_workspace` 按预期因 unresolved production API/module 编译失败。
- migration `0042_durable_workspace_roots.sql` 只新增内部表；数据库唯一约束同时保护 workspaceKey 与 exact node/environment/root fingerprint。
- record 固定 `workspace:<canonical UUID>`、bounded node/environment、lowercase SHA-256 root fingerprint、非负 createdAt 和 domain-separated record hash；Debug 隐藏 fingerprint/hash。
- State 不保存 canonical root、相对路径、OS user、Secret、permission snapshot 或客户端字段；读取每条 record 都重新 validation/hash，直接修改 persisted fingerprint 后 fail-closed。
- `BEGIN IMMEDIATE` 下相同 root 的不同随机 key 并发 resolve 只有一个 Created，loser 返回同一 Existing winner；workspaceKey 指向另一 root 返回 Conflict。
- 表硬上限 1024；达到容量返回 `CapacityExceeded`，不删除、覆盖或复用旧 key。
- close/reopen 返回 deep-equal record；不同 fingerprint 产生独立 workspaceKey。

## Commands

- `just test -p crewon-state durable_workspace`：5/5 通过。
- `just test -p crewon-state`：178/178 通过，0 skipped。
- `just fix -p crewon-state`：通过，无遗留 Clippy 错误。
- 最终 `just fmt`：通过；按仓库规则未在 fix/fmt 后重复测试。
- `git diff --check`：fix/fmt 前通过。

## app-server Stage B Red / Green

- Red：新增 sibling Harness 先调用不存在的 `WorkspaceRegistry::list_with_state`，`just test -p crewon-app-server durable_workspace_adapter` 按预期因 missing method 编译失败。
- adapter 以 Unix 原始 path bytes / Windows UTF-16LE 生成跨编译器版本稳定的 domain-separated SHA-256 root fingerprint，只向 State 提交 fingerprint、node/environment 与随机 key；不提交 canonical path。State 错误、冲突、容量耗尽或 authenticated path 缺少 State 均返回统一 fail-closed error，不回退 session random。
- 当前启动 `WorkspaceRootCatalog` 每次 refresh 重新成为唯一可见 root 集；State 历史记录不能单独恢复已移除 root。被移除 root 的旧 key 无法 bind，相关 session binding 同步清理。
- `refresh_guard` 串行化同一连接 registry 的 root refresh，避免两个并发首次请求生成不同 key 并让先返回 key 失效。
- signed-bearer WebSocket integration 真正停止并重启 app-server process，复用同一 State/codex home 后 authenticated workspace projection deep equal；session/trace/audit facts 仍按重连轮换。
- Stdio/InProcess/no-principal 路径继续使用 session random；两个独立普通连接不会得到同一 key，旧 TestAppServer restart key 继续拒绝。

## app-server Commands

- `just test -p crewon-app-server durable_workspace_adapter`：2/2 通过。
- `just test -p crewon-app-server 'platform_control::workspace::tests'`：4/4 通过，包含并发 refresh 回归。
- `just test -p crewon-app-server workspace_registry`：2/2 通过，保持旧 stdio/path-free 行为。
- `just test -p crewon-app-server websocket_transport_projects_verified_principal_across_reconnects`：1/1 通过，覆盖真实 process restart。
- `just test -p crewon-app-server`：1054/1055 通过；唯一既有 Office startup recovery 用例在并行全量下两次停在 queued，随后隔离复跑 1/1 通过。未发现 workspace/identity/State/Provider 回归。
- `just fix -p crewon-app-server`：通过；本切片新增的 async-lock/expect lint 已清零，剩余 5 条 warning 均位于既有 Office/Agent Platform 模块。
- 最终 `just fmt`：通过；按仓库规则未在 fix/fmt 后重复测试。

## Review

- production record 190 LoC、runtime 132 LoC，均低于 500；migration + production + sibling tests 共 615 行，低于 800 行 review Gate。
- additive migration 与新 `crewon-state` API 不改变 app-server v1/v2、CLI/config、现有 rollout/session resume 或旧 WorkspaceRegistry 行为。
- 没有新增依赖、Cargo.lock 或 Bazel lock 变化；没有向 `crewon-core` 添加 Workspace 领域代码。
- connection-scoped identity 仍不能消费 durable key；adapter 只为 verified authenticated principal 选择 State mapping，State kernel 本身不授予权限。

## 未验证

- W2-04 startup composition/RPC/Resource API；production factory kernel 与 connect/read subject/Tenant/Space owner mix-up Harness 已完成。
- production key/config、真实云模型、CloudWorker/scheduler composition；当前 production Gate 继续关闭。
