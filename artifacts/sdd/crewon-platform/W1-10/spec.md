# W1-10 Specification: Wave 1 Composition 与 Gate

## 1. 目标

W1-10 只负责组合 Wave 1 已经冻结的底座契约，不新增领域语义，也不切换现有 Cloud Agent、Office、Workflow 或 Experts 的生产 Authority。

本任务需要证明以下能力能够通过显式 adapter 安全组合：

1. `RequestIdentity` 由连接与服务端初始化状态派生，客户端不能声明 actor、tenant 或 space。
2. `WorkspaceRef` 由 Workspace Registry 绑定，Single 与 Office 使用不同 scope/binding，客户端不能提交 root path 绕过 registry。
3. Credential 只有 owner/status/revision/expiry 可进入 Policy；Secret value 不离开 Credential Store。
4. Provider endpoint 在执行前经过 fail-closed 的 scheme、DNS/IP 和 redirect 策略；Harness 不产生真实 HTTP 副作用。
5. Resource Federation 输出 exact revision 的 `ResourceBinding`，Task、Context、Policy 和 Artifact 只消费稳定引用。
6. Task Runtime/State 保持 command/event/idempotency/restart 语义。
7. Governed Context 强制 audience、trust、sensitivity、freshness、单片和总量上限。
8. Policy/Approval 将 actor/workspace/resource/credential/action digest 绑定到一次性授权决定，撤销 Credential 后旧决定不可复用。
9. Artifact/Audit 原子保存产物、manifest 与审计事件；Retention 删除正文后保留 tombstone、manifest 和 audit。

## 2. Composition 边界

app-server 只拥有以下协调职责：

- 从连接状态构造 `RequestIdentity`；
- 从 Registry 解析 `WorkspaceRef`；
- 将 Credential metadata 映射为 Policy 的 credential binding；
- 将 Resource/Task/Approval/Trace 稳定引用映射为 Artifact commit/delete input；
- 调用领域 crate 和 State port，不复制 reducer、Policy、Retention 或 endpoint 判断。

领域依赖方向固定为：

```text
resource-federation
       ^
       |-- task-runtime
       |-- policy
       `-- artifact <- task-runtime + policy

secrets ---------> app-server adapters <--------- state
core governed context ----^              ^---- app-server identity/workspace
```

约束：

- `crewon-core` 不依赖 Task/Resource/Policy/Artifact/Office。
- 新领域 crate 不依赖 app-server、State、SQL、HTTP client 或 UI。
- State 只实现持久化 port，不成为领域模型。
- app-server 中心 request processor 不承载新领域逻辑。
- W1-10 不新增临时 facade；发现上游契约问题应退回对应 W1 Task。

## 3. 显式 Adapter

### 3.1 Identity 与 Workspace

- `ConnectionRequestIdentity` 根据 transport、client information 和服务端 trace 派生 `RequestIdentity`。
- `RequestIdentity::policy_actor` 是 Policy actor 的唯一 app-server 映射入口。
- Workspace RPC 只接受 `workspaceKey/scope/scopeId`，root path 来自服务端 catalog。
- Single/Conversation 与 Office 绑定必须具有不同 binding ID；上下文 audience 继承已解析 workspace scope。

### 3.2 Credential

- `credential_owner(identity)` 根据 actor/tenant/space 构造 Credential Store owner。
- `policy_credential_binding(identity, metadata)` 必须先验证 exact owner，再映射 provider、status、revision 和 expiry。
- adapter 不接收、不返回、不序列化 Secret。
- `spaceId` 没有 `tenantId` 时 fail-closed。

### 3.3 Context、Policy 与 Approval

- Context adapter 从 identity/workspace 构造 audience 和 provenance，不接受客户端直接声明 scope key。
- Context 的预算包含 manifest 开销；正文即使被截断，最终渲染仍必须小于等于 `ContextBudget`。
- Policy action 绑定 exact Workspace、Resource revision 和 Credential revision。
- Approval request/decision/consume 必须复用同一 action digest；Credential 撤销后，即使 approval 曾通过也必须拒绝执行。

### 3.4 Artifact 与 Retention

- Artifact create/delete adapter 从 identity/workspace 派生 actor、workspace 和 trace。
- create 输入只接受稳定 Task/Conversation、Resource、Approval 引用及 bounded payload。
- delete 输入只接受 ArtifactRef、Retention authority/reason/time；不允许客户端覆盖 owner 或 workspace。
- Retention 到期后删除 payload，重启后 manifest/audit/tombstone 仍可读取。

## 4. Wave 1 Integration Harness

Harness 使用真实 `TestAppServer`、临时 `StateRuntime` 和以下 fake port：

- deterministic public-IP endpoint resolver；
- exact revision 的 catalog provider；
- in-memory/local fake Credential Store；
- 不连接网络、不启动模型循环、不调用外部 Agent/Skill/MCP/知识库。

单条 contract 必须覆盖：

1. 伪造 identity params 被协议拒绝。
2. 伪造 workspace root path 被协议拒绝。
3. Conversation 与 Office workspace 分开绑定。
4. exact Resource binding 和 available Credential 进入 Policy。
5. 大 Context 被确定性截断，最终渲染受硬上限约束；过多 fragment 被拒绝。
6. 外部动作进入 ApprovalRequired，正确 digest 决策后可消费。
7. Credential revoke 后旧 authorization 验证失败，Policy 拒绝。
8. Task 与 Artifact 写入 State，关闭并重开后仍存在。
9. 到期 Artifact 进入 bounded expiry list，payload 删除后正文不可读而 manifest/audit 保留。
10. 全流程只使用 fake provider/endpoint，不产生外部副作用。

## 5. 安全与正确性不变量

1. 所有 Authority 均由服务端对象派生，不相信模型/UI 提交的 actor、workspace、owner、approval 或 verification。
2. Secret 只存在于 Credential Store 内；Policy、Task、Context、Artifact 和 Audit 只持有 reference/metadata。
3. 所有正文、列表、ID、事件、Context 和 cleanup batch 均有硬上限。
4. Approval 不能脱离 action digest、Resource revision、Credential revision 或 workspace 重放。
5. Credential revoke/expire 优先于历史 approval/authorization。
6. restart 不改变 Task、Artifact、Audit、idempotency 或 tombstone 语义。
7. 测试不得依赖真实网络、云 Agent、真实 Credential 或不稳定时间。

## 6. 非目标

- 不注册新的 Provider Run、Office、Workflow 或 Experts RPC。
- 不把旧 Office record、旧 Task JSON、现有 Cloud Agent 会话切到新底座。
- 不实现 executor、outbox worker、SSE replay、跨服务事务或 UI。
- 不修改上游 W1-01 至 W1-09 public contract 来简化接线。
- 不引入通用 DI 容器、service locator 或新的 composition framework。

## 7. 验收

- Wave 1 integration Harness 通过并覆盖上述十项 contract。
- Resource/Task 现有依赖边界脚本通过；Artifact/Policy/Core 静态依赖扫描通过。
- app-server 定向测试与完整 package tests 通过。
- Cargo/Bazel lock 同步并通过 check。
- scoped fix 与 final fmt 通过；按仓库规则 fix/fmt 后不重跑测试。
- verification 明确记录未执行完整 workspace test，且没有生产 Authority cutover。
