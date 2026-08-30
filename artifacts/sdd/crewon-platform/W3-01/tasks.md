# W3-01 Tasks 与执行提示词

## 0. Gate

- [x] D0-01 旧链调用点和 authority 盘点。
- [x] D0-02 新链缺口、终态 API、rollback fence 冻结。
- [ ] G0-01 用户授权并通过 Wave 2 full workspace `just test`。
- [ ] G0-02 真实 Provider key/model 可用且不进入仓库、日志、Task/Artifact metadata。2026-07-25 本地 readiness 审计为 Red：8000 的 Provider/Identity production composition 未启用，数据库中 active AgentVersion、verified personal model key、active NewAPI binding 均为 0；需用隔离测试 fixture 补齐，不能修改日常 8000 数据来伪造条件。

## Wave A：Provider 结果可持久恢复

- [x] A-01 `ProviderRunEventProjectionRecord`、payload digest、bounds 与 `0049_provider_run_event_projection.sql` Harness。
- [x] A-02A journal advance + event projection 原子提交与 legacy `NULL/NULL` compatibility fence。
- [x] A-02B bounded event projection read/recovery API，供 projector restart 后连续读取。
- [x] A-03 Worker event/idempotency identity 绑定 canonical payload。
- [x] A-04 `ProviderRunArtifactClient` context import + result read typed contract 与 Agent Platform Artifact contract Harness。
- [x] A-05 verified Run output Artifact importer + Artifact/Audit correlation。
- [x] A-06 approval/tool-result unsupported stop semantics，禁止无限 poll/backoff。

执行提示词：

```text
执行 W3-01 Wave A。先读 W3-01 spec/plan/verification、W2-03/W2-07/W2-08 verification，以及 Provider v3 run/artifact contract。

Harness-first：证明相同 metadata 但不同 outputArtifacts 必须 conflict；progress/failure/completed typed payload 在 State 重启后仍可读；context Artifact 必须以稳定 idempotency key 上传成功后才能 runs:start；upload unknown outcome 重试同一 identity；artifact read 校验 exact ref、header、digest、media type、UTF-8 和 64 KiB bound；body 不出现在 Debug/error/audit。

实现 additive migration 和窄 State record/runtime；journal advance 与 projection 同事务。新增独立 ProviderRunArtifactClient，不把 artifact read 塞进 unrelated dynamic artifact client。CloudWorker idempotency digest 必须包含 canonical payload。unsupported approval/tool-result 必须进入显式 stop，不允许 supervisor 无限退避。

不得修改 Cloud Agent UI/旧执行链，不得生产切流，不得 fallback。运行相关 state/provider/app-server scoped tests；若改 protocol/schema按规则生成。记录所有未验证边界。
```

## Wave B：Thread execution authority

- [x] B-01 `executionBinding` State model、canonical hash、`0050_thread_execution_binding.sql` 与 restart tests。
- [x] B-02 app-server v2 params/projection/schema 与 exact Agent binding validation。
- [x] B-03 既有 start/resume/fork/update/delete Thread Execution Context lifecycle 接入 exact binding projection 与 owner/workspace guards；Cloud fork/steer 等能力语义仍由 D-07 显式收口。
- [x] B-04A 已有 Core Turn 的 Thread 拒绝选择 Cloud Agent；带 `executionBinding` 的 Thread 拒绝误走本地 Core Turn 路由。
- [x] B-04B 首个 durable Cloud Task 创建后 `executionBinding` immutable；由 Wave C 原子 CloudAgentTurn/Task 外键事实锁定，禁止以 UI、Core rollout 或内存状态代替。
- [x] B-05 Provider Agent picker -> Resource Binding -> execution binding UI preparation；未切发送链，Agent 不进入 `+` 资源标签。

执行提示词：

```text
执行 W3-01 Wave B。目标是让 Thread 持有显式 exact Agent execution binding，而不是从 resource set/raw agentId/threadSource 猜测。

先写 Harness：binding 不在 resourceBindings、非 Agent、revision drift、revoke、cross-owner、已有 Core Turn、首 Cloud Task 后换 Agent全部 fail-closed。使用 `0050_thread_execution_binding.sql`，不改 0048。协议 optional request field遵守 v2 nullable 规则，wire camelCase，生成 schema并验证 breaking compatibility。

中心 thread lifecycle 只传 prepared authority；规则放新模块。UI 只准备绑定选择，不删除旧 send path，避免 Gate 未 Green 时半切流。不得读取 root path、Secret 或 browser token。
```

当前结论：Wave B 的 durable authority、协议/schema、生命周期防混写、UI 选择准备和首个 durable Cloud Task 后 binding 锁定均已完成。Cloud-bound `turn/start` 已有 default-off 的 Task Runtime 创建路由；读取、结果投影、取消和旧链删除仍未完成，因此生产开关保持关闭。

## Wave C：CloudAgentTurnCoordinator

- [x] C-01 CloudAgentTurn record、DurableTask/LegacyImport origin、Task mapping、unique/idempotency model 与 `0051_cloud_agent_turns.sql`。
- [x] C-02 prompt/context Artifact builder，复用 GovernedContext 预算与 audience。
- [x] C-03 State atomic create：queued Task + accepted event/outbox + ExecutionSpec + Turn mapping，并在同一事务内重验 connection/grant/identity authority。
- [x] C-04 standard `turn/start` Agent route、duplicate clientUserMessageId response 与独立 default-off consumer Gate。
- [x] C-05 单 Thread active Turn 串行化与 text-only capability guard。
- [x] C-06 Cloud Agent Single consumer Authority：`EnqueueAttempt -> ClaimAttempt`，known failure/cancelled -> deterministic `FailTask`；unknown outcome只保留reconcile，不自动重试。

执行提示词：

```text
执行 W3-01 Wave C。新增窄 cloud_agent_turn 模块；不要把业务逻辑堆到 message_processor.rs、turn_processor.rs 或 crewon-core。

先用 crash-point Harness 证明 artifact 创建、Task/spec/mapping/accept 任一点失败都不会产生可执行半 Task；重复 (threadId, clientUserMessageId) 返回同一 Turn/Task；同 Thread 两个 start 只有一个 active authority。

prompt/context 必须是 immutable Artifact refs。历史只用同 Thread verified turns，通过现有 GovernedContextFragment/Bundle，最多 8 fragments、约 4K tokens；不读 UI cache/旧 session/raw Provider body。State 用单事务写 queued Task + accepted event/outbox + spec + mapping。

`turn/start` wire不新增第二套 API；Agent execution binding走 coordinator，无 binding走原 Core，失败绝不 fallback。第一切片只接一个文本 input，文件/图片/额外 Skill/MCP/Knowledge tag和不支持的 override返回稳定 capability error，不能隐式跨服务导出。known Provider failure由消费者 Authority fail task，不自动重试。
```

当前结论：Wave C与Wave D的D-01至D-07已完成。相同 `(threadId, clientUserMessageId)` 稳定恢复同一 Turn/Task；变更后的 replay、并发 active Turn、权限撤销后的 duplicate 均 fail-closed。Cloud Agent专属Single Authority只消费由CloudAgentTurn映射出来的`enqueueAttempt`与`awaitRetryDecision`：前者创建一次fenced Worker claim并投递dispatch，后者确定性FailTask；commit后、source-delivery前崩溃依靠Inbox receipt恢复。bounded projector只消费durable Provider projection，completed先进入durable finalizing，verified local Artifact提交后才原子完成Turn，失败不会制造空completed。标准notification使用deterministic Turn/Item ID和metadata-only terminal notice；每个接收连接都以fresh identity重新授权并读取exact durable revision。`thread/read`、`thread/turns/list`和resume已统一从CloudAgentTurn + verified local Artifact恢复。Cloud summary revision与ThreadStore preview/updatedAt在同一SQLite事务提交，`thread/list`/`thread/search`查询前做bounded补偿，restart后sidebar不再回退到stale rollout metadata。标准`turn/interrupt`先提交stable `CancelTask`，queued cancel由Task terminal事实直接投影标准cancelled Turn，不依赖不存在的Provider journal；重复、并发、restart与terminal race均不产生第二语义取消。known failure等待Single Authority，unknown/gap保留同一Run并停止推进，绝不伪造terminal。Cloud execution binding下的steer/inject/compact/fork明确拒绝，无binding Core路径保持原行为。当前仍不能启用生产切流，因为Wave E旧链原子删除、UI唯一链路、Wave F E2E/full workspace/live Gate尚未完成。

## Wave D：Projector、read/resume/cancel

- [x] D-01 CloudAgentTurn projector cursor/state machine 与 restart Harness。
- [x] D-02 completed Artifact read/import/durable finalizing/completed/resultUnavailable 原子边界。
- [x] D-03 standard Turn/Item notifications，deterministic IDs，progress 无系统气泡。
- [x] D-04 `thread/read`/`thread/turns/list`/resume 标准投影与 connection-independent recovery。
- [x] D-05 thread list/search/sidebar summary + ThreadStore metadata幂等同步和 restart recovery。
- [x] D-06 `turn/interrupt` -> stable `CancelTask`，重复/并发/restart取消幂等，terminal race与Provider cancel identity受Harness保护，非Cloud/Core startup路径不变。
- [x] D-07 steer/inject/compact/fork capability guard；revoke/gap/unknown/failure/cancel可见状态收口，不为unknown/gap伪造terminal。

执行提示词：

```text
执行 W3-01 Wave D。先写完全可重启 projector Harness：连续 progress、completed、duplicate、cursor gap、artifact read失败、导入成功后崩溃、notification前后断线、cancel与credential revoke。

projector只消费 durable Provider event projection；按 contiguous sequence推进 durable cursor。completed 必须先验证并导入本地 Artifact，Turn在此之前为 durable finalizing，不能返回空 completed；transient failure按 durable schedule重试，corrupt/not-found/expiry等 non-retryable情况终结为 resultUnavailable，不能无限等待。item/turn ID由 task/turn/provider event稳定派生，重复投影不重复气泡。

对客户端只发送标准 Turn/Item/status notification；progress是typing/status，不写“已启动执行”等聊天气泡。thread/read、thread/turns/list和resume initial page只从 CloudAgentTurn + local Artifact恢复；sidebar preview/updatedAt/search排序必须由summary projection与ThreadStore同步，不能出现空会话假状态。turn/interrupt先提交 Authority CancelTask，再由既有 outbox/CloudWorker取消 Provider。steer/inject/compact/fork显式拒绝并在UI隐藏。
```

## Wave E：Legacy、UI 与旧链原子删除

- [x] E-01 bounded legacy session importer、digest journal、symlink/path guards。
- [x] E-02a rollback fence compatibility实现：识别保留 source，禁止内容/执行/binding/delete/archive/unarchive mutation且本版本不创建该 source。
- [x] E-02b 单独构建并验证 fence binary artifact；cutover rollback只允许指向已验证 SHA artifact。
- [x] E-03 UI 标准 start/read/interrupt cutover，删除 fake Turn/Promise/orphan event。
- [x] E-04 删除 old app-server RPC/notifications/processor/local session write/center dispatch。
- [x] E-05 删除 raw agentId production routing，保留并注明独立 resource-management能力。
- [x] E-06 UI snapshot：统一主页风格、无系统执行气泡、真实 final result。
- [x] E-07 rg/dependency Harness 证明 old execution callpoints/fallback 为零。

执行提示词：

```text
执行 W3-01 Wave E，前置是 Wave A-D E2E 全 Green。先生成删除清单和 legacy fixtures，不要提前删旧链。

legacy importer只读 server-owned固定目录，canonicalize并拒绝 symlink escape；文件数、文件大小、消息数、正文长度都有硬上限；stable digest支持crash retry。导入 Turn 使用 LegacyImport origin、没有伪造 Task，也不自动进入未来模型上下文。导入完成后新链不再读取/写入旧 session。

E-01实现说明：文件名只由旧`userId/threadId/agentId`三元组SHA-256推导，不接受客户端路径；目录最多1000项、文件最多1MB、消息最多20条、正文最多10000字符且总上下文最多10000 approximate tokens。journal先冻结source digest、exact binding、Turn数量与`importedAt`，Artifact使用UserManaged retention和稳定identity；Turn批次、journal mapping与summary同事务提交。完整user/assistant相邻配对；仅尾部孤立user导入为`failed/legacyResponseMissing`，任意assistant-first或乱序文件整体拒绝，不伪造prompt或response。

E-02a实现说明：保留source固定为`crewon_cloud_agent_provider_binding_v1`。兼容版本拒绝客户端在`thread/start`/`thread/fork`创建该source；已存在source只允许list/read/name/git等不移动rollout的metadata lifecycle，拒绝turn start/steer/inject/interrupt、settings、realtime、review、fork、compact、rollback、shell、Guardian approval、background terminal mutation、execution binding update、delete及archive/unarchive。真实binary演练发现Cloud标准Turn可仅存在State，而现有unarchive依赖Core rollout user event，因此文件移动必须fail-closed，不能保留一个表面可逆、实际不可恢复的操作。

E-02b实现说明：构建artifact `3c4d3028d8a8aebc072baa3b4d9e7adac4b82765b70ebe4a4a434b84e5d71cc9`，通过`verify-w3-01-fence-artifact.py`在临时`CREWON_HOME`和随机WebSocket端口完成部署、future-source夹具、普通Thread对照与同SHA二次启动rollback。reserved Thread的read/list/name Green；turn/start、fork、delete、archive、unarchive稳定`-32600`；普通Thread create/delete Green。该证据只解除E-02b，不等于生产cutover或真实Provider live smoke。

E-03实现说明：UI已删除`runAgentPlatformChat`、旧session read、专用cancel、Run Promise、orphan notification缓存、fake Agent Turn和`agentPlatformThreadHistory`恢复。Provider Agent只通过Resource Binding准备Thread Execution Context；当已有普通Thread时，首次选择Provider Agent会强制创建新authority Thread，避免未绑定Thread误走Core。后续发送、读取和停止只调用标准`turn/start`、`thread/read`和`turn/interrupt`。旧`agentPlatformAgentId`入口在创建Thread前fail-closed且不产生本地Turn，等待E-05删除目录标记本身。UI全量222 files/1269 tests、统一lint与Vite production build Green；四个夹具误写experimental `ConfigRequirements`字段的问题已按标准v2契约最小修复。localhost浏览器走查确认断线恢复态无假数据，办公室不展示运行台、执行流程或后端记录。

E-04实现说明：app-server v2已删除旧chat/start/cancel/session read/session clear共5个RPC和4个chat notification，生成的JSON Schema/TypeScript类型同步移除。`agent_platform_processor`仅保留账号验证和Agent metadata查询；SSE stream、in-memory run、connection cancellation、local session write/clear模块与中心dispatch均删除。一次性legacy importer继续只读固定目录，并使用私有bounded migration wire struct，不依赖公开旧协议。`crewon-app-server-protocol` 248/248、processor focused 7/7、`crewon-app-server` 1163/1163 Green；`crewon-app-server-client`相关notification分类1/1 Green，全包仍有一个与本切片无关的shutdown时序失败，已记录为未验证边界。

E-05实现说明：删除`ThreadRuntimeSettings.agentPlatformAgentId`、旧thread source转换函数、scene中的Platform raw target、Cloud Agent配置自动同步和对应测试。在线Agent执行目标现在只由`provider-agent:*` opaque value定位exact Provider Resource，CommandWorkspace再通过Resource Binding建立Thread authority；资源目录仍可使用`agent-platform:agents:*`作为display/navigation id，但不会进入send、thread create或本地Agent execution target。用户从云目录保存配置时不再携带raw remote agentId，形成普通本地副本而不是隐式云路由。

E-06/E-07实现说明：新增Cloud Agent completed Thread snapshot，确认标准主页`CommandThreadRoom`、共享composer、普通user/agent message、无runId/系统执行气泡，并修正英文会话页头使用本地化label。`scripts/verify-w3-01-cloud-agent-cutover.sh`扫描旧RPC/types/UI Promise/fake history/raw authority/fallback，限制legacy session目录只出现在bounded importer，并证明raw Agent marker仅保留在资源目录卡片；Harness Green。

切流前先部署 fence 版本：它识别新 Thread source并拒绝 mutation，但不创建新 source，是唯一 rollback target。同一 cutover release再删除 UI special send/history/cancel、appServer Run Promise/orphan events、agentPlatform chat notifications、app-server old processor/RPC/local session write 和 raw agentId authority。保留 marketplace/catalog/login等独立能力时必须用调用图证明不进入执行链。

UI 使用同一标准 Thread/Turn组件，progress不生成系统气泡，final verified Artifact显示为普通 agent message。更新并审阅 snapshots；rg测试证明 old RPC、one-shot chat、fake Turn、Run Promise、failure fallback为零。
```

## Wave F：Release Gate

- [x] F-01 hermetic vertical E2E 全场景 Green。
- [ ] F-02 scoped Rust/UI tests、snapshots/lint/build、schema、Bazel、diff scan Green（source argument-comment lint已覆盖app-server all-targets并Green；仅hermetic Apple SDK下载403仍阻断Bazel入口）。
- [ ] F-03 full workspace `just test` 经授权 Green。
- [ ] F-04 真实 Provider live smoke，包含 app-server/Provider restart（前置环境审计已完成；真实 key/model/AgentVersion fixture 待提供或隔离配置）。
- [ ] F-05 deployment enablement、binary rollback/read-only fence、清理证据。
- [ ] F-06 scoped fix、final fmt、verification 结论。

执行提示词：

```text
执行 W3-01 Wave F。完全 hermetic E2E 必须覆盖成功、progress、disconnect、duplicate start/event、app-server restart、Provider restart、cancel、unauthorized、credential revoke、cursor gap、known failure、unknown outcome、artifact corruption。

按仓库规则运行 scoped tests；common/core/protocol变更后的完整 workspace just test必须先获得用户授权。live smoke使用测试 key/model，Secret不落盘不输出；start后分别重启 app-server和Provider，确认同 providerRunId续读、Task terminal、一个 final Artifact、thread/read一个结果。

最终发布不存在旧执行 fallback。回滚只能用已验证的 fence binary/container，不能回滚到更早、不认识新 source 的版本；新 Cloud Agent Thread在 fence版本下只允许read/list和不移动rollout的metadata，不反向写旧 session，也不archive/unarchive/delete。完成 scoped fix后最后 just fmt，之后不重跑测试；verification逐项列证据和未验证边界。
```
