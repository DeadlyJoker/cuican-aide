# ADR-003：REST、SSE 与 Device Protocol 分工

状态：Accepted  
日期：2026-08-08

## 背景

当前 PC UI 使用 app-server JSON-RPC，同时仍直接调用 Agent Platform REST。未来还要支持 Web、Mobile 和远程 Device Runner。继续扩展一套同时承担 CRUD、流、审批、设备控制和本地工具的自定义 RPC，会放大客户端兼容成本。

## 决策

1. 产品 CRUD 和 command 使用 REST resource。
2. PC/Web/Mobile 的实时 Run 事件使用 SSE。
3. Rust Device Native Runtime 使用独立、版本化的双向 Device Protocol。
4. OpenAPI 3.1/JSON Schema 是产品 API 的 wire source of truth，并生成客户端。
5. Device Protocol 使用独立 schema package，不导入产品 domain struct。
6. WebSocket 不承担普通产品 CRUD；SSE 不承担 Device command。

## REST 规则

- ID 是 string。
- mutation 使用 `Idempotency-Key`。
- revision-sensitive command 携带 `expectedRevision`。
- actor、tenant、space、credential owner 和 workspace root 由服务端解析。
- list 默认 cursor pagination。
- 错误使用稳定分类和 requestId。

## SSE 规则

- `Last-Event-ID` 支持续读。
- 服务端从持久化 Event 补齐后进入 live tail。
- heartbeat 不占业务 sequence。
- 慢客户端断开后恢复，不让 UI 反压阻塞 Worker。
- Event schema 向前兼容；未知 event type 不能让客户端崩溃，但安全相关 unknown state 必须 fail closed。

## Device Protocol 规则

每个 command 固定：

```text
protocolVersion
requestId
runnerId
leaseId + leaseEpoch + expiry
runId + stepId + attemptId
workspaceBindingId
capability
actionDigest
arguments or payloadRef
output limits
```

每个结果固定 receipt、status、bounded output refs、digest 和 timing。Transport 断开不能被解释为 command 失败；Authority 必须通过 receipt/reconcile 判断 unknown outcome。

## 拒绝方案

### 所有能力继续使用 JSON-RPC

拒绝。它可以工作，但对浏览器缓存、标准 HTTP 中间件、OpenAPI Client、SSE resume 和资源语义没有额外价值。

### 所有能力使用一个 WebSocket

拒绝。连接状态会与 CRUD、认证刷新、重试和设备控制耦合，且难以利用普通 HTTP 基础设施。

### GraphQL subscription

拒绝。当前资源和执行流不需要引入 GraphQL schema、resolver 和 subscription runtime。

## 兼容策略

- 旧 JSON-RPC 只作为迁移 Adapter。
- 新 UI feature 不增加旧 RPC fallback。
- 旧客户端兼容期明确版本和截止时间，不允许永久 capability probing。

## 验收 Gate

- generated client 在 PC/Web 测试中使用相同 schema。
- SSE 断线、重复、续读和 slow consumer tests 通过。
- Runner command 在断线前/中/后都有确定的 receipt/reconcile 行为。
- 未授权事件不可跨 tenant/thread/run 泄露。
