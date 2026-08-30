# W2-03 Specification: Rust Agent Platform Provider Adapter

状态：W2-02C、W2-03A/B/C/D 已完成。strict discovery/CatalogProvider 与 durable Run start/read/events/cancel client 已通过 Harness；W2-04、W2-07 已解锁进入各自 Discovery，但后续 Discovery 又识别出 authenticated principal 与 execution journal 前置，实施暂缓；W2-08 仍受 W2-04 至 W2-07 的组合前置约束。

## 1. 当前事实

- canonical Provider v3 fixture 已覆盖 durable Run command/event/error，但没有定义 catalog HTTP envelope。
- `crewon-resource-federation::CatalogProvider` 已冻结 bounded list 与 exact manifest read port；它不依赖 HTTP、Secret、Task Runtime 或 app-server。
- Agent Platform `/provider/v3` 已提供分离授权的 descriptor、exact AgentVersion list/read、Run 与 Artifact API，可满足 CatalogProvider 与 capability discovery。
- 旧 Agent Open API 和 CrewON catalog 只表达 one-shot/latest 或非版本化资源，禁止 fallback。
- W1-03 Provider Endpoint Policy 与 pinned HTTP guard 已迁移到独立 `crewon-provider-transport`；app-server 私有副本、模块声明和兼容 facade 均已删除。
- Run delegation 继续强制绑定 exact ResourceRef、taskId、CredentialId 与 expected Credential revision；provider-level discovery 使用独立、短期、无 wildcard 的 discovery delegation。revision 已进入 Rust authorizer request、Agent Platform signed claim verifier、authorization digest、Run/Delegation persistence 与 existing-run ownership。真实签发端和 production composition 尚未建立，因此仍未开启 production cutover。

## 2. 必要前置修正

### 2.1 W2-02C Provider discovery surface

Agent Platform 已提供并通过 Harness：

1. 独立 signed discovery delegation：绑定 service、tenant、space、subject、purpose、scopes、jti、iat/exp；不携带 Credential、taskId 或 Resource wildcard。
2. authenticated descriptor/capability read：返回固定 provider ID、protocol version、durable Run capability 和 Resource Federation capability；未知 capability 不进入响应。
3. exact AgentVersion resource list：只返回调用者当前可访问、Agent active/api-enabled、Version active 的 exact `agent-version:<n>`；limit/cursor/scan/Permission 调用均有硬上限。
4. exact resource manifest read：返回 Agent resource ref、manifest schema version 和对 immutable version snapshot 的 canonical digest；不返回 system prompt、model credential、mutable dependency 或 Secret。
5. discovery 与 Run authority 分离；exact read/start 仍使用 Run delegation，不允许 discovery token 执行 Run。

### 2.2 Endpoint Policy 单一权威

W2-03A 已将现有、已验证的 endpoint policy 与 pinned HTTP guard 无行为变化地迁移到 `crewon-provider-transport`：

- app-server 直接改用新 crate并删除原文件，不保留 re-export/facade 或双实现；
- Production HTTPS、development loopback、DNS/IP/metadata/redirect/rebinding、timeout 和 response cap 不变量保持完整对象等值；
- crate 不依赖 app-server、core、Task Runtime、UI 或 Provider-specific wire。

## 3. Agent Platform Adapter 边界

W2-03B 新建 `crewon-provider-agent-platform`，只拥有：

- Agent Platform v3 strict wire DTO 与 domain mapping；
- descriptor/capability、catalog list/read 与 Run start/read/events/cancel；
- 通过 `crewon-provider-transport` 发起所有请求；redirect 自动跟随关闭；
- 通过窄 authorization port 获得短期 service/discovery/run header。CredentialRef 和签名材料只进入 authorizer 最短路径，adapter Debug/error 不包含 header 或 Secret；
- 实现 `CatalogProvider`，并提供不依赖 Task Runtime 的 durable Run client port。

Adapter 不拥有：Task/Attempt/Retry reducer、聊天 session、Context compression、Artifact authority、UI state、one-shot fallback 或生产切换。

当前 Agent Platform production descriptor 只声明 `durableRun`、`remoteAgent`、`resumableEvents`，production HTTP application 也没有 approval/tool-result mutation route。因此 W2-03 不暴露伪能力或空实现：canonical fixture 中的 approval/tool-result command 只做严格契约 round-trip，收到未声明能力对应的事件必须 fail-closed。未来若后端同时提供 descriptor capability、授权操作、幂等 mutation route 和 Harness，必须用独立 SDD amendment 扩展 adapter。

## 4. Error 与 capability mapping

- HTTP 401/403 -> Unauthorized；404 -> NotFound；409 -> Conflict；422 capabilityUnsupported -> Incompatible。
- 429 必须读取 bounded `Retry-After` 并返回显式 RateLimited；不得在 adapter 内 sleep/retry。
- canonical providerUnavailable/timeout/unknownOutcome、transport timeout/network/response cap/malformed JSON 分别映射为闭集领域错误。
- 未知 error code、event type、resource kind、capability、terminal duplication、cursor regression 或 schema version均 fail-closed 为 InvalidResponse/Incompatible。
- descriptor 缺 `durableRun` 或 `resumableEvents` 时 Run API 在发请求前返回 Incompatible，不模拟兼容。

## 5. Harness-first 验收

1. mock HTTP 覆盖 descriptor、catalog list/read、start/read/events/cancel；未声明的 approval/tool-result 事件在网络边界 fail-closed。
2. canonical Provider v3 fixture 完整对象 equality；字段删除、未知 union tag、错误 nullable 或 cursor 漂移必然失败。
3. 请求扫描证明没有 workspace root、成员私有 Context、长期 Secret、Credential owner 或客户端 authority。
4. redirect/private/link-local/metadata/DNS rebinding、429/Retry-After、5xx、timeout、oversize、malformed JSON、重复/未知 event/cursor 全部 fail-closed。
5. 相同 command/idempotency input 不在 adapter 内生成第二语义；adapter 不实现 retry。
6. `just test -p crewon-provider-transport`、`just test -p crewon-provider-agent-platform`、dependency boundary、Bazel lock check、scoped fix 与 final fmt 通过；Bazel unit target 若被仓库级外部依赖/工具链阻断，必须记录原始失败且不得宣称通过。

## 6. 停止条件

- W2-02C 已完成；若后续实现回退到 wildcard Resource、旧 access token 或 one-shot API，立即停止。
- Endpoint Policy 无法在不复制的情况下成为单一 crate authority 时停止并回到 W1-03 amendment。
- Agent Platform capability 不满足 durableRun/resumableEvents 时返回不支持，不接 one-shot API。
