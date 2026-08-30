# W2-04RB Specification: Durable Provider Resource Binding

状态：B1、B2 Green。严格、Secret-free、path-free 的 State record、additive migration、create/existing/read/reactivate/unbind runtime、session-owned Workspace proof resolver、live Catalog + Federation adapter，以及 experimental bind/unbind RPC 和 current-connection-only notification 已完成；不接 UI、Dynamic Tool Router、Task 创建链或 Wave 2 中心 composition。

## 1. 已确认边界

- `ResourceBindParams.workspaceBindingId` 是当前连接的 Workspace scope binding，不是 durable identity。它只能在 app-server bind processor 中解析为 server-owned `WorkspaceRef`；不得直接写入 SQLite。
- authenticated workspace 的 `workspaceKey` 已由 durable workspace root mapping 跨进程恢复；Resource Binding 必须持久化该 key、Workspace scope/scopeId 和 stable principal owner，但不得持久化 root path。
- Provider connection 已持久化 exact owner/provider/protocol/grant revision。Resource Binding 保存 server-owned `connectionId` 作为 bind 时的 authority provenance；它不能替代执行时对当前 Provider authority 的重验。
- `crewon-resource-federation::ResolvedResourceBindingSnapshot` 已定义 exact resource revision、manifest metadata、capability 和可选本地 materialization。State crate 不新增对 resource-federation 的依赖，app-server adapter 负责两者之间的显式转换。
- 当前 Agent Platform 只声明 `providerManaged + provider` Agent capability；localSnapshot/localFork 暂无 materializer。State record 保留完整、严格的本地 materialization字段，但后续 app-server processor 在没有真实 materializer 时必须拒绝本地模式。

## 2. Durable record

`ProviderResourceBindingRecord` 保存：

- server-owned `resource-binding:<uuid>`；
- stable actor/tenant/space owner；
- server-owned connectionId；
- durable workspaceKey、Workspace scope/scopeId；
- exact providerId/protocolVersion/resource kind/resourceId/revision；
- binding mode、execution location；
- manifest schema version、可选 content digest；
- 本地 materialization 的 source/local revision 与 digest 四元组，Provider-only 模式必须全部为空；
- active/unbound status、monotonic revision、created/updated/unbound timestamps、canonical record hash。

字段有硬上限、closed enum wire 值和一致性校验。Debug 必须隐藏 owner、workspaceKey、scopeId、connectionId、resourceId、digest 和 record hash。

## 3. State lifecycle

- create 只接受 active revision 1，`createdAt == updatedAt` 且 `unboundAt == null`；
- exact active selection replay 返回 Existing；并发相同 selection 只产生一个 bindingId；
- exact unbound selection 再次 bind 时复用原 bindingId，revision + 1 并重新 Active，避免 bind/unbind 重试产生无界历史行；
- unbind 按 bindingId + stable owner 原子执行；missing 或 cross-owner 都返回 NotFound，重复 unbind 返回 ExistingUnbound；
- immutable selection 或 snapshot metadata 漂移返回 Conflict；bindingId collision、时间回退、revision overflow、tamper 和容量耗尽 fail-closed；
- 表总量硬上限 1024，不淘汰或覆盖其他 binding。

State resolve 必须在同一事务中确认 referenced Provider connection 存在且 owner/provider/protocol exact 匹配，并确认 durable workspace root 存在。外键只是额外完整性约束，不代替该校验。

## 4. app-server Gate

State Green 后独立实现的 app-server Gate 已完成：

1. WorkspaceRegistry 根据当前 session-owned workspaceBindingId 刷新 Root Catalog 后返回完整、path-free `WorkspaceRef`；
2. bind 在同一个 pinned live catalog session 内 exact read Manifest，经 Federation capability resolver 生成 snapshot，再显式映射为 State record；
3. localSnapshot/localFork 在没有真实 materializer 时 fail-closed，不能伪造本地 materialization；
4. unbind 只需要 authenticated stable owner，可在 Provider runtime/grant 已撤销时清理 binding；
5. bind/unbind notification 只发给发起连接，禁止全局广播导致跨 principal projection 泄漏；
6. 若需要跨重连独立恢复 UI binding 列表，必须另行增加 owner-scoped list/read API，不能依赖广播通知或浏览器缓存猜测权威状态。

## 5. Breaking-change 与停止条件

- migration additive；不修改现有 connection/workspace/grant row，不改变 rollout/session resume、CLI 或配置加载。
- 不给现有 DTO 增加客户端 authority 字段；若 bind/unbind contract 不足，先以 experimental additive API amendment 解决。
- 不把 workspaceBindingId 当 durable ID，不持久化 root path/endpoint/Secret，不让 notification 全局广播。
- B1a/B1b/B2a1/B2a2/B2b 各自控制在可评审范围；不把 State、app-server wire、UI 或 Dynamic Tool Router 合并为单一变更。
