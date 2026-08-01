# W0-03 Cross-repository Provider Contract 规格

状态：完成  
上位任务：<code>artifacts/crewon-platform-wave-sdd-execution-guide.md</code> W0-03

## 当前事实

- CrewON 需要一个 durable Provider Run 协议，Agent Platform 当前只有 one-shot chat/SSE，尚没有 start/read/events/cancel/approval/tool-result 的持久运行 API。
- W0-03 只冻结双方未来实现必须遵守的 wire contract，不启动真实 Provider Run，也不把 one-shot chat 包装成 durable run。
- 两个仓库独立构建，没有现成的共享源码仓或 Contract Registry；直接各放一份手写 JSON 会形成双源。

## 单一所有权

- canonical source 归 Agent Platform 所有：<code>contracts/provider/v1/provider_contract.v1.json</code>。
- CrewON 仓库保存由 canonical source 生成的只读 distribution artifact：<code>codex-rs/app-server-protocol/schema/canonical/provider_contract.v1.json</code>。
- distribution artifact 不是第二契约源；其 provenance sidecar 固定 owner、source path、schemaVersion 和 SHA-256。
- 双仓联合 Gate 使用字节等值和 digest 校验阻止漂移；各仓默认 contract test 不启动网络和真实 Provider。

## 契约范围

- capability：durableRun、resumableEvents、persistentConversation、remoteAgent、approval、toolResult。
- authorization/delegation：audience、tenantId、spaceId、subject、scopes、purpose、credential owner、delegation jti/expiry。
- commands：start、read、listEvents、cancel、decideApproval、submitToolResult。
- events：runStarted、progress、approvalRequired、toolResultRequired、toolResultAccepted、completed、failed、cancelled。
- ordering：同一 providerRunId，严格递增 sequence，cursor 与 sequence 稳定对应，终态事件只能位于末尾。
- errors：使用 W0-01 平台错误分类，并显式携带 retryable、traceId 和 required-nullable providerRunId。

## 安全与正确性不变量

1. 所有结构 fail-closed：未知字段、未知 union tag、未知关键 enum 均拒绝。
2. required-nullable 字段必须存在；缺失与显式 null 不等价。
3. credential 只出现引用和 owner subject，不出现 secret/token。
4. delegation 必须有 audience、jti 和 expiresAt；fixture 不把高熵 Run ID 当授权。
5. start 必须携带 idempotencyKey 和 requestDigest；cancel 必须携带 expectedRevision。
6. approval 决策绑定 actionDigest 和 idempotencyKey；tool result 绑定 resultDigest 和 idempotencyKey。
7. event body 只保存有界摘要和 ArtifactRef，不保存无限模型正文或 Secret。

## 兼容策略

- schemaVersion 使用 major.minor.patch；新增 required 字段、rename、union tag/error code 变化属于 breaking change，必须升 major。
- 同 major 内只能新增明确 optional 的非权威字段，且需双端 Harness 先支持后发布。
- capability 是 admission contract；未声明能力必须拒绝对应 command，不做静默降级。
- live smoke 独立运行，不进入默认 hermetic contract Gate。

## 非目标

- 不新增 Agent Platform Provider Run 表、API、worker 或 AgentRuntime adapter。
- 不修改 CrewON Task Runtime 或 Provider HTTP adapter。
- 不引入第三个仓库、Contract Broker 或运行时网络下载。

## 验收

- 双端均可严格解析并完整等值序列化同一 canonical 内容。
- 双端 mutation Harness 覆盖缺字段、多字段、rename、错误 union tag、required-nullable、错误码、capability 和事件顺序漂移。

## W2-02 Contract Amendment

W2-02 在实现 Tool Bridge suspend/resume 时发现 v1 缺少结构化 `toolResultRequired`，且 `submitToolResult` 未绑定不可变 Tool Intent。继续使用 v1 会迫使控制面从自由文本猜测 toolCallId，无法满足安全基线。因此在尚未生产 cutover 前升为 **2.0.0**：

- 新增 `toolResultRequired`，携带 toolCallId、toolSchemaRevision、argumentsDigest、intentDigest、nonce 和 expiresAt；
- `submitToolResult` 新增 intentDigest；
- `toolResultAccepted` 回显 intentDigest；
- command 必须同时绑定 required intent 和 accepted result。

这是显式 major breaking change；v1 fixture 仅保留历史证据，v2 在该阶段成为 active canonical，随后由下述 production data-plane amendment 显式升级为 v3。
- Agent Platform 目标 pytest、CrewON 目标 Rust test 和跨仓字节/digest Gate 通过。

## W2-02 Production data-plane amendment

W2-02B 在接 production API 前继续发现 v2 无法正确建立 Artifact 数据面：`ArtifactRef` 必须携带 `taskId`，但 start/delegation 没有可信 Task 绑定；`contextRefs` 又只是无结构字符串，Provider 无法验证 exact revision、Task ownership 或重复引用。解析 idempotencyKey、使用 providerRunId 冒充 taskId、忽略 context，都会制造不可恢复的错误关联。

由于 v2 尚未生产 cutover，active contract 显式升为 **3.0.0**：

- authorization 新增由 signed delegation 提供的 `taskId`；Run、Delegation、Artifact 和后续 read/mutation 必须保持同一 Task binding；
- `ProviderRunInput.contextRefs` 从 `string[]` 改为 strict `ArtifactRef[]`，只接受 Provider 数据面预先导入并完成 tenant/space/subject/task/revision 校验的不可变引用；
- Provider output `ArtifactRef.taskId` 必须等于 Run 的 signed taskId；不得从 prompt、idempotencyKey 或客户端 metadata 推导；
- v1/v2 fixture 继续作为历史证据，v3 成为唯一 active canonical contract。

本修订不把 payload 正文放进 Run/Event；Context upload 和 Provider Artifact download 属于有界、鉴权的数据面 API，并在 W2-02B 独立落地。
