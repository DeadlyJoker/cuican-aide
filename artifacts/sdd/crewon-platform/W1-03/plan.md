# W1-03 Implementation Plan

## Stage A: Credential lifecycle

1. 在 `crewon-secrets` 新增独立 `credential` 模块，定义 bounded metadata、redacted Secret handle、错误与 `CredentialStore` port。
2. 实现 `LocalCredentialStore`，复用现有 `SecretsBackend`，不改动 Account Auth/MCP OAuth 文件格式。
3. 实现 `FakeCredentialStore` Harness；测试完整对象与生命周期状态，不逐字段拼接断言。
4. 扩展 v2 `CredentialRef` 的 scope/revision，并更新 canonical fixture/schema/TypeScript。

Review 边界：Credential stage 不修改 app-server processor、UI 或 Agent Platform 请求路径；预计复杂逻辑控制在 500 LoC 内。

## Stage B1: Endpoint policy

1. 在 `app-server/src/platform_control/` 新增 `provider_endpoint_policy.rs`，保持 request processor 只做 composition。
2. 使用 RPITIT `EndpointResolver` port 与 production `SystemEndpointResolver`，测试使用可编程 Fake resolver。
3. URL/DNS/IP/redirect 校验返回包含 pinned SocketAddr 的 `ValidatedProviderEndpoint`。

Review 边界：Policy implementation + DNS/redirect Harness 独立评审，复杂实现文件低于 500 LoC。

## Stage B2: Pinned HTTP guard

1. 在独立 `provider_http_guard.rs` 中构造 redirect-disabled、timeout-bounded、DNS-pinned 的 reqwest client。
2. 固定请求 origin，拒绝 absolute cross-origin path、query/fragment 注入。
3. 提供有上限的响应读取函数。
4. 用本地 HTTP mock 验证 response cap/timeout；Production 地址规则仍使用 Fake DNS，不放宽生产策略。

Review 边界：Endpoint stage 不接入任何现有 Provider client，不接收 Secret，也不成为通用 HTTP proxy。

## Stage C: Verification only

1. 运行 `just test -p crewon-secrets`。
2. 运行 `just test -p crewon-app-server-protocol`。
3. 运行 endpoint policy 精确测试与 `just test -p crewon-app-server`。
4. 生成 app-server schema；检查 diff 只包含预期 CredentialRef 字段。
5. 扫描代码、fixture、snapshot、日志文本中的测试 Secret。
6. 运行 scoped `just fix`，最后运行 `just fmt`；按仓库规则不在 fix/fmt 后重复测试。

## Authority cutover

W1-03 只建立安全底座。后续 Provider Connection 接入时执行一次性切换：

- UI token Params -> server-owned CredentialRef
- Agent Platform env/service token -> Local/Cloud adapter
- MCP/Account auth -> 明确迁移或保持独立产品认证，不允许双写
- Provider client -> Endpoint Policy validated/pinned client

任何消费者未满足全部 Gate 时继续使用旧权威路径，不做 fallback 到新路径。
