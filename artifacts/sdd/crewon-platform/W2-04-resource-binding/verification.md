# W2-04RB Verification

状态：B1、B2 Green。strict production record、additive migration、create/existing/read/reactivate/unbind runtime、session-owned Workspace proof、live Catalog + Federation adapter、experimental bind/unbind RPC 和 current-connection-only notification 均已完成；完整 workspace test 仍等待用户明确授权。

## Discovery evidence

- WorkspaceRegistry 的 `bindingId` 只存在连接内存，refresh/reconnect 后会变化；authenticated workspaceKey 则由 State durable root mapping 恢复。
- Provider connection row 已绑定 stable owner、provider/protocol 和 exact grant revision；Resource Binding 不能保存或接受客户端 Credential/endpoint。
- federation binding resolver 已能验证 exact ResourceRef、Provider capability、execution location、manifest digest 和 local materialization provenance；State 不应复制这套领域解析。
- TaskContract snapshot 已持有完整 `ResolvedResourceBindingSnapshot`，因此 durable binding 是创建/恢复 Task 的权威输入之一，不应从 UI 标签或 Provider latest 重新推导。
- app-server 的无目标 notification 是全局广播；Resource Binding 路由因此必须显式传入 initiating connectionId，并继续经过 experimental capability 与 notification opt-out filter。

## Current gate

W2-04 Resource Binding 的实现 Gate 已通过。W2-05 Dynamic Tool Router 与 W2-06 UI Provider/Resource 可以基于当前 experimental contract 各自进入独立 SDD/Red Harness；W2-08 仍等待 W2-05、W2-06、W2-07 的组合 Gate，Cloud Agent 生产切换、UI 接线和 Task consumer 均未发生。

## B1a evidence

- Red Harness 首次只因 `provider_resource_binding_records` 及其 record/status/closed enum 不存在而编译失败。
- `ProviderResourceBindingRecord` 使用 server-owned bindingId、stable owner、connectionId、durable workspaceKey/scope、exact Provider Resource、manifest metadata、materialization、status/revision/timestamps 和 canonical hash；没有 root path、endpoint、Secret 或 token。
- closed enum 覆盖 Workspace scope、Resource kind、binding mode、execution location 和 active/unbound status；不使用无约束 JSON。
- Provider-only 模式要求 Provider execution 且 materialization 全空；LocalSnapshot/LocalFork 要求完整 source/local revision+digest，Snapshot 还要求本地内容 exact 等于源内容。
- active revision 为奇数且无 unboundAt；unbound revision 为偶数且 `unboundAt == updatedAt`，为 B1b 的幂等 unbind/reactivate 状态机预留严格不变量。
- Debug 隐藏 owner、connection、workspace、scopeId、resource identity、digest 和 hash。

## B1a verification

- `just test -p crewon-state provider_resource_binding_record`：2/2 通过。
- `just test -p crewon-state`：192/192 通过，0 skipped。
- `just fix -p crewon-state`：通过，无 warning。
- `just fmt`：通过。
- production record 435 行，sibling Harness 157 行，总计 592 行；单生产模块低于 500 行，总切片低于 800 行。

## B1b1 evidence

- Red Harness 明确失败于缺失 lifecycle module、runtime module、resolve/read 方法与 outcome；没有混入 app-server RPC 或 UI。
- additive `0045_provider_resource_bindings.sql` 以 foreign key 连接 immutable Provider connection 与 durable workspace root，并用 closed wire values、bounded columns、materialization/lifecycle checks 和 exact selection unique constraint fail-closed。
- resolve 在同一个 `BEGIN IMMEDIATE` 事务内重验 connection owner/provider/protocol 与 workspace existence；相同 active selection 返回 Existing，同一 unbound selection 复用原 bindingId、CAS revision + 1 后 Reactivated。
- persisted row 每次读取都重新解析 closed enum、验证完整 record 与 canonical hash；State 表不保存 workspace path、endpoint、Credential、Secret 或 token。
- 并发相同 selection 只创建一行；missing connection/workspace、parent mismatch、bindingId collision 与 reactivation 时间回退均不会产生新权威。

## B1b1 verification

- `just test -p crewon-state provider_resource_binding_`：4/4 通过。
- `just test -p crewon-state`：194/194 通过，0 skipped；其中 StateRuntime init/close/reopen 覆盖 0045 migration smoke。
- `just fix -p crewon-state`：通过，无 warning；`just fmt`：通过。
- production runtime 348 行，B1b1 sibling Harness 198 行，lifecycle 13 行，migration 72 行；生产模块低于 500 行，B1b1 总切片低于 800 行。

## B1b2 evidence

- `ProviderResourceBindingUnbindRequest` 只接受 server-owned bindingId、服务端派生 stable owner、expectedRevision 与 unboundAt；Debug 隐藏 owner。
- unbind 使用独立 `BEGIN IMMEDIATE` + revision/status CAS。missing 与 cross-owner 统一 NotFound；只有“前一 active revision + 同一 unboundAt”的重试返回 ExistingUnbound，其他版本/时间漂移返回 Conflict。
- unbind 不要求当前 Provider grant/connection 可用，因此授权撤销后仍可清理；它仍会在读取时校验 persisted canonical hash，tamper 直接 fail-closed。
- unbind/reactivate 并发 Harness 接受且验证两种合法串行顺序，最终只能是 revision 2 Unbound 或 revision 3 Active，不产生第二条 selection 或部分状态。
- 总表容量固定 1024；容量耗尽返回 CapacityExceeded，不淘汰、覆盖或复用其他 selection。

## B1b2 verification

- Red Harness 首次只因 unbind request/outcome 与 State 方法不存在而编译失败。
- `just test -p crewon-state provider_resource_binding_`：8/8 通过。
- `just test -p crewon-state`：198/198 通过，0 skipped。
- `just fix -p crewon-state`：通过，无 warning；`just fmt`：通过。
- record 480 行、lifecycle 63 行、runtime 415 行、sibling Harness 422 行；生产模块均低于 500 行，B1b2 增量保持独立可评审。

## B2a1 evidence and verification

- `WorkspaceRegistry::resolve_binding_ref_with_state` 先校验 registry identity 与 canonical `binding:<uuid>`，再按当前 authenticated/session 模式 bounded refresh Root Catalog，最后只从当前 session registry 返回 `WorkspaceRef`。
- Harness 覆盖同 session 成功、path-free serialization、cross-session/unknown binding 拒绝，以及 root 被移除后 refresh 立即失效。
- targeted Workspace resolver：1/1 通过；生产 `workspace.rs` 491 行，独立 `workspace_binding.rs` 45 行。

## B2a2 evidence and verification

- bind 复用现有 Provider Resource begin/connect/finish authority bracket；一次 pinned Catalog session 同时持有 strict descriptor 与 exact Manifest，Provider I/O 后再次校验 principal、mapping、grant 和 connection revision。
- Federation resolver 是 capability、execution location、Manifest 与 materialization 的唯一解析权威；app-server adapter 只做 exhaustive mapping、strict State validation 和 secret-free/path-free projection。
- `providerManaged`/remote reference 可落 State；localSnapshot/localFork 在没有真实 materializer 时返回 incompatible。unbind 是 authenticated stable owner 的 State-only 操作，grant/runtime 撤销后仍可清理，cross-owner 与 missing 统一 NotFound。
- adapter/core targeted：5/5 通过，覆盖 bind replay、unbind replay、cross-owner、local mode 拒绝和 Provider I/O 中 authority revoke。生产 adapter 203 行、binding processor 317 行。

## B2b evidence and verification

- experimental `resource/bind`、`resource/unbind` 和 `resource/binding/updated` 已注册；Params 不接受 owner、Credential、endpoint、workspace root 或 execution location。
- `MessageProcessor` 只负责 Workspace proof 解析、processor 调用、response 映射和 `send_server_notification_to_connections(&[connection_id], ...)`；没有全局广播。transport 现有 Harness 继续覆盖 experimental capability 与 notification opt-out filter。
- TestAppServer targeted：3/3 通过，覆盖注册、disabled runtime/State-only unbind、unknown authority field 和 experimental gate。
- `crewon-app-server-protocol`：242/242 通过；experimental schema 含 bind/unbind/updated，stable ClientRequest fixture 不含 bind/unbind。
- `crewon-app-server`：1088/1088 通过，1 skipped；2 个既有时序用例首次失败后 nextest retry Green，新 Resource Binding 用例无失败。
- 生产模块均低于 500 行。B2 按 Workspace proof、Federation/State core、wire/notification 三个独立评审切片落地，未把 UI、Task consumer 或 Dynamic Tool Router 混入。

## Remaining verification

- 完整 workspace `just test` 尚未执行，因为仓库规则要求用户明确授权。该项是 repo-wide release evidence，不否定已经通过的 W2-04 crate-level implementation Gate。

## TypeScript schema integrity amendment

- W2-06 Discovery 发现 stable `ClientRequest.ts` 的 import pruning 使用 substring 判断，导致实验 `ResourceReadParams` 被稳定 `McpResourceReadParams` 误判为仍在使用，而对应实验文件已按预期被删除。
- 新增通用 generated TypeScript 相对导入完整性 Harness；Red 首次只报告该悬空引用。
- pruning 改为完整 TypeScript identifier 边界匹配，未改变 stable/experimental 方法过滤边界。
- `just test -p crewon-app-server-protocol`：243/243 Green；stable `ClientRequest` 仍不含 Provider/Resource experimental RPC。
