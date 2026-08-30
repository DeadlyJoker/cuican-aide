# W3-01 Specification: Durable Cloud Agent 纵向切换

状态：Discovery 与详细设计已冻结，Gate Red；只允许 Harness-first 实现，不允许生产切流或删除旧链。

## 1. 目标

W3-01 选择一个真实云 Agent 单聊场景，把当前浏览器 token、旧 one-shot/SSE chat、app-server 内存 Run Promise、local session file 和 UI fake Turn，原子替换为：

```text
standard Thread/Turn API
        -> CloudAgentTurnCoordinator
        -> durable Single Task + immutable ExecutionSpec
        -> CloudWorkerExecutor
        -> Agent Platform Provider v3 Durable Run
        -> durable Provider Event Projection + verified output Artifact
        -> Cloud Agent Turn Projection
        -> standard Turn/Item notifications and thread/read
```

最终必须同时成立：

1. 云 Agent 仍是单聊产品语义，但每个需要持久恢复的执行 Turn 使用 `StrategyKind::Single` Task；不新增 CloudAgent Strategy。
2. UI 只使用标准 `turn/start`、`turn/interrupt`、`thread/read` 和标准 Turn/Item notification；不再维护专用 Run Promise、fake Turn 或 session history。
3. Agent 选择由 Thread Execution Context 中的 exact Resource Binding 决定；UI 不能用 raw agentId、accessToken 或 threadSource 充当执行 authority。
4. Task Aggregate 是执行生命周期唯一权威；Provider Run journal 是外部执行事实；Cloud Agent Turn projection 是用户可见会话投影，三者通过稳定 ID 关联而不双写同一事实。
5. Provider completion 的 `outputArtifacts`、progress、sanitized failure 必须先持久化；output bytes 必须经 `/artifacts:read` 验证后导入本地 Artifact Store，不能从内存 response 拼假结果。
6. 断线、app-server 重启、Provider 重启、重复事件和重复 `turn/start` 后，返回同一 Turn/Task，最终只出现一个用户消息、一个结果和一组 exact Artifact refs。
7. Gate 通过后同一提交切 UI、协议/processor 和旧 session 存储；不双写、不 fallback、不保留“以后删”的生产执行调用点。

## 2. Discovery 事实

### 2.1 当前旧链

旧链目前由以下互相耦合的状态组成：

- app-server v2：`agentPlatform/chat`、`agentPlatform/chat/start`、`agentPlatform/run/cancel`、`agentPlatform/session/read`、`agentPlatform/session/clear`。
- notifications：`agentPlatform/chat/delta`、`resourceEvent`、`completed`、`failed`。
- `agent_platform_processor`：浏览器 access token、远端旧 `/api/v1/open/agent/{id}/chat` SSE、进程内 `HashMap<runId, RunRecord>`、connection-scoped cancellation、本地 `agent-platform-sessions` JSON history。
- UI `appServer.ts`：`agentPlatformRuns` Promise map、thread -> run map、orphan event buffer 和 5m30s timeout。
- UI `threadMessageActions.ts`：按 `agentPlatformAgentId` 走专用分支，手工创建 `agent-platform-turn-*`、增量修改 fake Turn、专用 interrupt。
- UI `agentPlatformThreadHistory.ts`：读取旧 session 后用 `createDemoTurn` 重建假会话。
- `threadRuntimeSettings.ts` / scene catalog：`agent-platform:agents:<raw id>` 同时承担展示、路由和隐式 authority。

这些状态在断线、重启、跨连接、凭据撤销和重复事件下都不是 durable authority，因此不能局部修补后继续保留。

### 2.2 新底座已就绪

- Task Runtime 已有 `StrategyKind::Single`、Authority command/event、Attempt/Lease/Fencing、Inbox/Outbox 和 restart-safe Store。
- CloudWorker 已能用 exact execution spec、Agent binding、Credential revision 启动/读取/取消 Provider Run。
- Provider supervisor 默认关闭且具 durable backoff/recovery；Thread Execution Context 已保存 owner、Conversation Workspace 和 exact Resource Binding revisions。
- Artifact/Audit、Governed Context、Provider Connection/Grant/Resource Binding 与 server-owned Dynamic Tool 已具独立 Harness。

### 2.3 必须先补的真实缺口

1. 当前没有 Thread/Turn -> Single Task 的消费者协调层，也没有公开 Task RPC；不能把旧 chat RPC简单改成调用 CloudWorker。
2. Provider `Completed { output_artifacts }` 当前只被折叠为 `WorkerOutcome::Succeeded`；output refs 没有进入 State。
3. Provider journal event 只保存 event metadata/type/hash，未保存 canonical bounded payload；相同 completed metadata 下的 output ref 变化无法成为可审计事实。
4. Agent Platform 已实现 Artifact import 与 `/artifacts:read`，但 Rust durable Provider adapter 两者都尚无对应 typed client；CloudWorker 当前把本地 context refs 直接放进 start request，却没有先保证这些 refs 已在 Provider task scope 中 materialize。
5. Thread Execution Context 当前只有资源集合，没有显式 execution binding；从“集合里恰好只有一个 Agent”推断目标会形成隐式规则和未来歧义。
6. 标准 `thread/read` 当前不知道 Cloud Agent Turn projection；直接把 Provider 结果追加到 Core rollout 又无法与 SQLite Task/Projection 跨存储原子去重。
7. Provider emitted known failure 会让 Task 进入 `Suspended(RetryDecision)`；消费者 Authority 必须显式决定 fail/retry，Provider supervisor 不能替它决定。
8. Cloud Agent Turn 不进入 Core rollout 时，标准 `thread/turns/list`、sidebar preview/updatedAt、search/list 排序也不会自动更新；只补 `thread/read` 会形成“打开后有消息、侧边栏却像空会话”的第二类假状态。

## 3. 权威与投影模型

### 3.1 Thread Execution Context

为 durable Thread context 增加：

```text
executionBinding: Option<{ bindingId, revision }>
```

不变量：

- `executionBinding` 必须同时存在于 `resourceBindings`，并在每次 start 前回读为 active `ResourceKind::Agent` exact revision。
- 无 execution binding 的 Thread 继续走现有本地 Core Turn；Agent binding 的 Thread 走 Cloud Agent coordinator；其他 kind fail-closed。
- execution binding 可在首个 Cloud Agent Turn 前设置或替换；一旦该 Thread 已接受 Cloud Agent Task，目标不可原地更换。选择另一个 Agent 必须创建新 Thread。
- 第一版 Cloud Agent Thread 不与本地 Core Turn 混写。这样 `thread/read` 不需要合并两个没有共同事务和 ordinal 的历史权威。
- resource bindings 仍可按既有 optimistic revision 更新；已创建 Task 永远使用 immutable execution spec 中的旧 exact snapshot，后续 Turn 才读取新资源集合。
- 除 execution Agent 外的 Skill/MCP/Knowledge bindings 不会被隐式委托给远端 Agent；只有本 Wave显式构造并上传的 governed context Artifacts进入 Provider Run。缺少 secure export/bridge 的资源 tag 必须禁用或拒绝，不能仅因“已绑定”就跨服务暴露。
- migration 编号冻结为：`0049_provider_run_event_projection.sql`、`0050_thread_execution_binding.sql`、`0051_cloud_agent_turns.sql`；不改写已存在的 `0048` migration，避免并行分支争用编号。

### 3.2 Task 与 Turn

每个新执行 Cloud Agent Turn 对应且只对应一个 Task；一次性导入的历史 Turn 使用独立 `LegacyImport` origin，不伪造 Task：

| 对象 | 权威职责 |
| --- | --- |
| Thread | 单聊 identity、owner、workspace、execution binding、lifecycle |
| CloudAgentTurn | 用户可见 turnId、client message id、状态、Task/Artifact refs、projection cursor |
| Task Aggregate | accepted/queued/running/suspended/reconciling/terminal 与 retry/cancel Authority |
| CloudExecutionSpec | immutable prompt/context/Agent/Credential exact revision |
| Provider Run Journal | provider run/attempt、contiguous event cursor、canonical payload projection |
| Local Artifact | prompt/context/final output 的 verified bytes、manifest、retention、audit |

`CloudAgentTurn` 至少保存：

- threadId、turnId、clientUserMessageId、`origin = DurableTask { taskId } | LegacyImport { importId }`；
- owner actor/tenant/space 与 workspaceKey 的 metadata-only snapshot；
- execution binding id/revision；
- prompt Artifact ref；
- status、lastProviderSequence、primaryOutputArtifact ref、bounded additional output refs；
- safe errorCode/traceId；
- createdAt/updatedAt/completedAt。

`0051` 同时保存可重建的 `CloudAgentThreadSummaryProjection`（preview、updatedAt、lastTurnId、projection revision、metadata sync revision）。它是 CloudAgentTurn 的派生投影，不是消息 authority：

- projector 先提交 Turn/summary，再幂等同步现有 ThreadStore metadata；crash 后由 bounded recovery scan 重试。
- `thread/list`、`thread/search` 在执行原 ThreadStore query 前调用 bounded `ensure_summary_synced`；无法补齐时返回 retryable unavailable，不能先按 stale Core updatedAt分页再做 overlay，因为那会漏掉本应排在前面的 Cloud Thread。
- `thread/turns/list`、resume initial page 和 `thread/read` 对 Cloud Agent Thread统一读取 CloudAgentTurn，不从 Core rollout拼接。
- name/pin/archive 等现有 Thread metadata继续由原 ThreadStore拥有；Cloud projection只更新 preview/updatedAt，不覆盖用户命名。

唯一约束至少包含：

- `(threadId, clientUserMessageId)`，用于 reconnect/retry idempotency；
- 非空 `taskId`；
- `turnId`；
- 同一 Thread 最多一个 non-terminal Cloud Agent Turn。

### 3.3 原子创建

`turn/start` 的 authority 创建分两部分：

1. 先以稳定 idempotency key 创建 prompt/context Artifacts。完全相同重试返回 ExistingSame；失败不会产生 Task。孤立 Artifact 由 retention 清理，不构成执行权威。
2. State 单事务提交 queued Task genesis + `TaskAccepted` event/inbox/outbox、CloudExecutionSpec 和 CloudAgentTurn mapping。任一写入失败都不留下可执行半 Task。

禁止依次执行 `create task -> create spec -> create mapping -> accept task` 后依赖补偿；该顺序在 crash 下会留下 Created Task 或没有会话映射的 Run。

### 3.4 Provider Event Projection

新增 canonical bounded `ProviderRunEventProjectionRecord`，随 journal advance 同事务保存：

- eventId、sequence、eventType、payloadDigest、typed projection JSON；
- progress 只保存 bounded summary；
- completed 只保存 bounded output Artifact refs；
- failed 只保存 safe code、retryable、providerRunId、traceId；
- approval/tool-result payload 保留 typed metadata，但 W3-01 未支持时停止执行，不轮询制造无限 backoff。

Provider event idempotency digest必须包含 canonical payload，不再只包含 metadata。Task Worker event ID、journal duplicate check 和 projector cursor均使用同一 payload-bound digest。

### 3.5 Output Artifact

新增独立 `ProviderRunArtifactClient`，同时覆盖 context import 和 result read，不复用 Dynamic Tool Artifact 协议：

- `import_artifact` 使用 Provider Run start authority 和 deterministic idempotency key 调用 `PUT ./artifacts/{id}/revisions/{revision}`；校验 local Artifact body digest、media/sensitivity/retention/expiry，最大 64 KiB。
- CloudWorker 在 `runs:start` 前对每个 context Artifact 执行 idempotent import；全部确认 Created/ExistingSame 后才发送 start。upload outcome unknown 时重试同一 import identity，不跳过也不新建 Artifact。
- prompt 继续以 bounded inline text发送；只有 context refs 需要 Provider materialization。
- `read_artifact` 使用 Provider Run read authority调用 `POST ./artifacts:read`。

- request 只接受 completed event 中的 exact `ProviderArtifactRef`；
- 校验 response artifact id/revision、media type、sensitivity、content digest 和最大 64 KiB body；
- text/plain、text/markdown 必须 UTF-8；不记录 body 到 Debug/error/audit；
- 导入现有本地 Artifact Store，使用 task/turn/resource/trace correlation 和 deterministic idempotency key；
- 当前真实 Agent 场景要求恰好一个可显示的 primary Report/Text Artifact。其他合法 refs 持久关联但不伪造成聊天正文；不支持类型明确显示为附件或 capability unsupported。

只有本地 Artifact commit 成功后，CloudAgentTurn 才能进入 Completed。Task 已 terminal 但 Artifact 仍未完成导入时，Turn 保持 `finalizing`，并用 durable attempts/availableAt 做 bounded retry；重启后继续导入，不能先发空 completed。non-retryable corruption/not-found/retention expiry 最终把 Turn 标记为 `failed(resultUnavailable)` 并保留 Task completed 事实，不能无限 finalizing 或伪造正文。

## 4. 标准 Thread/Turn API 行为

### 4.1 `turn/start`

Cloud Agent 路由继续使用现有 v2 `turn/start` wire：

1. transport-derived RequestIdentity 授权 Thread owner。
2. 要求非空 `clientUserMessageId`；重复请求返回已存在的同一 Turn。
3. 第一版只接收一个非空文本输入；文件、图片、非文本 input 明确返回 capability unsupported，不能静默丢失。后续可通过同一 ExecutionSpec context Artifact seam 扩展，不新增聊天协议。
4. 对 Cloud Agent 不支持的 `turn/start` override/additionalContext 字段采用显式 allowlist；出现非默认值即返回 capability unsupported，不能静默忽略后继续执行。
5. 读取并验证 execution binding、Connection/Grant/Mapping/Resource/Credential 当前状态。
6. 构造 prompt Artifact 和 governed context Artifacts。
7. 原子创建 queued Single Task/ExecutionSpec/Turn mapping。
8. 返回标准 `TurnStartResponse { status: inProgress }`，并发送标准 turn/item notification。

不新增 `cloudAgent/start`、`task/start` 或第二套公开消息协议。通用 Task mutation 仍不暴露给 UI。

### 4.2 Context

Cloud Agent 历史上下文使用 W1-07 `GovernedContextFragment/Bundle`，不创建第二套无限 transcript：

- 当前用户输入作为独立 prompt，最多 10,000 chars。
- 历史只从同一 Thread 已完成且已验证的 DurableTask Turn/Artifact 构造；LegacyImport 历史只展示，不自动进入模型上下文；不读取旧 session file、UI cache 或 Provider raw event。
- 最多 8 fragments、总计最多约 4K tokens、单 fragment 128..900 approximate tokens；使用既有 deterministic middle truncation。
- provenance=User/Provider，trust=UntrustedData，audience=Single exact Conversation Workspace；Secret 和 absolute path 在 fragment 创建时拒绝。
- 每个 rendered fragment 作为不可变本地 Artifact 上传/绑定到本次 Provider Task；Provider 仍有 32 refs、单 ref 64 KiB、总计 256 KiB 的第二层硬上限。
- 第一版采用确定性 tail selection，不做模型生成 summary；被裁掉的旧会话仍可展示，但不假装已进入本次模型上下文。

### 4.3 Progress 与完成

- `runStarted/progress` 只映射为标准 in-progress/typing 状态，不在会话里插入“已启动执行”“执行完成”等系统气泡。
- final verified Artifact 映射为一个标准 agent message item；同一 provider event 重放使用 deterministic item id，不重复气泡。
- failed/cancelled 映射为 Turn error/status，不把 raw Provider response 展示给用户。
- `thread/read`、`thread/turns/list`、resume initial page 从 CloudAgentTurn + local Artifact 重建标准 Turn/Item；thread list/search/sidebar 从 summary projection更新；不读取 UI cache，不依赖进程内 Promise。

### 4.4 `turn/interrupt`

- 若 turnId 映射到 active Cloud Agent Task，Coordinator 用稳定 command/event id 提交 `CancelTask`；Task Authority 先持久化取消，再由 outbox/CloudWorker 请求 Provider cancel。
- 重复 interrupt 返回当前 terminal/cancelling 状态，不发送第二个语义 cancel。
- 非 Cloud Agent Turn 继续走原 Core interrupt。

### 4.5 其他 Thread 操作

- Provider v3 当前没有 steer/inject/compact/fork continuation 语义；Cloud Agent Thread 对 `turn/steer`、`thread/injectItems`、compact 和 fork 明确返回 capability unsupported，UI 隐藏对应 action。
- name/pin/list/read继续复用标准Thread lifecycle。第一切片的archive/unarchive/delete明确不可用：Cloud Turn正文与sidebar summary在State中，现有archive/unarchive仍要求Core rollout具备可提取的user event，不能把文件移动后再假装可恢复；未来启用前必须先实现State-only lifecycle并验证projection/Artifact retention原子边界。
- 未来支持 fork 时必须复制 immutable projection refs并建立新 execution authority；不能用空 Core rollout假装完成 fork。

### 4.6 已知失败与 retry

- transport timeout/unknown outcome 进入 reconciling，必须先 read/listEvents，不创建新 Task。
- Provider emitted known failed 进入 `Suspended(RetryDecision)` 后，由 Cloud Agent Authority 第一版确定性提交 `FailTask`；不自动消耗第二次模型成本。
- 用户重新发送产生新 Task；不会复用失败 Task 的 Attempt。未来若增加显式 retry，必须是新命名 API/command 和可见成本决定，不能偷偷自动重试。
- approvalRequired/toolResultRequired 当前 CloudWorker 不支持；目标 Agent/Provider 在 bind/start 前必须证明本场景不需要它们，否则 W3-01 Gate Red。

## 5. UI 原子切换

新 UI 行为：

- 云 Agent catalog/picker 使用 W2 Provider Resource API；选择结果先创建/解析 Agent Resource Binding，再把 exact binding 设置为 Thread execution binding。
- UI 可以保存 binding id 作为 opaque display/navigation hint，但服务端每次重新授权；raw agent id、browser access token 和 `agent-platform:agents:` 不再决定执行。
- `threadMessageActions` 不再有 Agent Platform 分支，完全复用普通 `startTurn/readThread/interruptTurn`。
- `appServer.ts` 删除 Agent Platform Run Promise、orphan buffer、special notification reducer 和 session methods。
- Cloud Agent 会话沿用主页无气泡/统一 composer 风格；进度用既有 typing/status，不展示后端 journal、runId 或执行流程。

兼容迁移：

- 旧 `agent-platform:agents:<id>` 只作为 migration hint。服务端必须通过 Provider Catalog/Mapping 找到唯一 active Agent binding；找不到或多义时只读并要求用户重新选择，不能猜测。
- 旧 local session file 由一次性 bounded importer 转为 `LegacyImport` CloudAgentTurn projection；相邻 user/assistant 消息按确定性规则配对，缺失对端时保留 error/partial 状态而不伪造响应。最大文件数、单文件、消息数和正文均有硬上限，路径固定在 server-owned legacy root 内并拒绝 symlink escape。
- importer 写入稳定 digest/journal，可 crash-retry；导入后新执行不再读旧文件。Gate 后删除旧 session processor/write path；原文件可在验证后由显式清理任务删除。
- 旧 `session/clear` 不保留。用户清理会话使用 Thread delete/new Thread 语义，不再直接清某个隐藏 JSON 文件。

E-01冻结契约：

- importer只接收server-owned `codexHome/agent-platform-sessions/<deploymentSha256>`，目标文件名由旧`userId\0threadId\0agentId`稳定哈希推导；不接受任意path、relative path或客户端声明的文件名。
- root与目标必须是regular non-symlink；canonical target必须是canonical root直接子项，打开前后metadata与Unix dev/inode必须一致。目录最多1000项、文件1..1,000,000 bytes、消息最多20、单条最多10000字符、总量最多10000 approximate tokens。
- 首次`0053_cloud_agent_legacy_import.sql` journal冻结source key/digest/bytes、target Thread、exact execution binding revision、Turn数量和`importedAt`。后续请求的wall clock不改变已冻结时间；source内容或mapping漂移返回Conflict。
- prompt/output Artifact在Turn提交前幂等写入，使用exact Conversation/Agent/Workspace correlation、Verified状态、UserManaged retention和稳定Audit/Trace identity。崩溃留下的未引用Artifact可由同一pending journal安全复用，不因新request trace产生冲突。
- 完整相邻user/assistant导入Completed Turn；仅最后一个孤立user导入Failed(`legacyResponseMissing`)。assistant-first、重复user、未知role或身份不匹配的文件整体拒绝，绝不合成缺失prompt/response。
- 所有LegacyImport Turn、ordinal mapping、journal completed与不覆盖更新summary在一个`BEGIN IMMEDIATE`事务提交；不创建Task，不进入未来模型上下文，并受全局Turn容量硬上限约束。

## 6. Feature Gate、切流与回滚

- 新增 `CREWON_DURABLE_CLOUD_AGENT_ENABLED`，默认关闭；它只控制新 Cloud Agent consumer，不替代 `CREWON_PROVIDER_CONTROL_ENABLED`。
- 任一开关关闭时，Cloud Agent entry 显示 unavailable；不得 fallback 到旧 chat。
- Harness/live smoke 期间旧生产 UI 不路由到新链。最终 cutover 提交同时：启用新 UI route、删除旧执行协议/processor/client分支、保留回滚 fence。
- cutover 前先发布一个兼容 fence 版本：它尚未创建新 Cloud Agent Thread，但已经识别opaque source `crewon_cloud_agent_provider_binding_v1`。它拒绝客户端创建该source，并对已存在source的内容、执行、binding、delete及archive/unarchive mutation fail-closed；list/read/name/git等不移动rollout的metadata lifecycle继续可用。该版本是唯一允许的 rollback target。
- cutover 版本才创建新 source Thread、启用新 UI并删除旧执行链。回滚到 fence 版本后，新 Thread 可列出/读取 metadata并重命名，但不能执行、移动/删除rollout或回到旧 Agent chat；不能回滚到更早、不认识 fence 的任意 binary。
- 回滚只允许回滚部署 artifact/container，不允许运行时 fallback 或反向搬运新 Task 到旧 session file。0049/0050/0051 additive schema 和新数据保留，重新前滚后继续恢复。

## 7. 删除清单

Gate 通过后的同一原子切换必须删除或改写：

- protocol 5 个 `agentPlatform/*` request 与 4 个 chat notification、generated schema/types 和 README 说明；
- `agent_platform_processor.rs`、其 stream/session/history/in-memory run records 与中心 dispatch；
- UI `runAgentPlatformChat`、read/clear session、cancel-by-thread、Promise maps、orphan events、special notification handling；
- `agentPlatformThreadHistory.ts` fake history 与 `threadMessageActions` 专用发送/取消分支；
- `agentPlatformAgentId` runtime authority、`agent-platform:agents:` production routing 和对应 tests；
- local session write/clear API 与部署期新写入。

这是协调发布的 breaking app-server change：删除前必须更新 schema/README、完成 external integration scan，并让 bundled UI 与 app-server 在同一 release artifact 中切换；不保留会执行旧链的 compatibility handler。

可以保留但必须证明与执行链独立：

- Provider/Agent catalog、marketplace browse/download、登录/logout 等纯资源管理能力；
- 通用标准 Thread/Turn、Provider Resource Session、Dynamic Tool、Artifact 和 Task runtime；
- bounded legacy importer，仅在迁移期编译/启用，完成后另行删除。

## 8. 安全与正确性不变量

1. 浏览器永不向 app-server 发送 Agent Platform access token；Secret 只从 server-owned Credential Store 获取。
2. actor/tenant/space、workspace、execution binding、Credential owner 均由服务端状态派生；client 值只作不可信 selector 并重新验证。
3. Task/ExecutionSpec/Turn mapping 原子创建；Task terminal 与 output Artifact import 分阶段但可恢复，不能返回假 completed。
4. Provider event payload、output refs 和 body digest 全部绑定 exact run/task/attempt/resource/credential revision。
5. 所有正文、events、refs、history import、context、poll、retry、并发和 cleanup 都有硬上限。
6. Progress/error/output 不包含 Secret、absolute path、raw provider body 或未验证 HTML。
7. 重启恢复只从 State/journal/Artifact 读取；UI memory、connection id 和 local Promise 不参与 authority。
8. 已知失败不自动 retry；unknown outcome 不立即重发；取消先持久化 Authority 再请求 Provider。
9. Cloud Agent Thread 不与 Core local Turn 混写；切换 Agent 创建新 Thread，避免双历史权威。
10. 删除旧链后 `rg`/dependency Harness 必须证明生产代码没有 old RPC、old session write 和 one-shot chat fallback。
11. rollback 只能指向已部署并验证的 fence 版本；任意更早 binary 都不是受支持的回滚路径。

## 9. 非目标

- 不在本 Wave 实现 Office/Workflow/Experts Strategy 或通用公开 Task API。
- 不支持 Cloud Agent Thread 与本地模型在同一 Thread 内切换。
- 不支持 Cloud Agent steer/inject/compact/fork；本 Wave必须显式拒绝并隐藏 action，不能返回假成功。
- 不把额外 Skill/MCP/Knowledge binding 自动导出给远端 Agent；该能力必须等待显式 Context Export/Secure Bridge设计与独立 Gate。
- 不实现 Provider approval/tool-result continuation、模型生成历史摘要或跨设备 Cloud Task Authority。
- 第一纵向场景不支持文件/图片 input；明确拒绝而不是静默丢弃。Artifact seam 保留给后续独立 capability slice。
- 不重构 Agent marketplace、download 或与执行无关的登录 UI。
- 不增加消息总线、第二数据库、通用 projector framework 或动态 Strategy Registry。

## 10. 停止条件

- Wave 2 完整 workspace Gate 未获授权或未 Green 时，不进入生产 cutover。
- output Artifact refs/payload 未 durable、`/artifacts:read` 未验证、Turn projection 未 restart-safe 时，不展示 completed。
- 任何 idempotency、authorization、restart/resume、cancel、credential revoke、event gap 或 duplicate bubble Harness 失败时，不删除旧链。
- 真实 Provider key/model smoke 未通过时，代码保持默认关闭；不得用 fake success 代替。
- 删除扫描仍发现 production old RPC/session/one-shot chat 或新链 failure fallback 时，Gate Red。
