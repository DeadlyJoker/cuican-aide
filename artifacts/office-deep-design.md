# CrewON 办公室深度设计 v1

> 状态（2026-07-15）：办公室可演示版本与 P0 Runtime 边界已经实现；内部演示与继续迭代为 **GO**，但当前超大工作树仍为 **NO-GO（不可作为单一 PR 整体落地）**。合并前必须按权威身份、消息调度、上下文生命周期和前端体验拆成可审查切片
> 范围：办公室创建、群聊 Composer、执行、Team Runtime、上下文、记忆与压缩
> 不包含：协作流、专家团的详细设计

## 0. 2026-07-15 实现复核

本轮已经把办公室从“旧资源库页面 + 普通单聊线程”的原型推进为可演示的 Team 群聊能力，并补齐此前终审中的主要 P0 边界：

- 主页单聊工作空间与 Team/Office 群聊工作空间使用独立状态。URL `cwd` 会先恢复为主页草稿工作空间，连接重建和历史任务加载不再用第一条历史线程覆盖它；显式“无工作空间”也能跨刷新保持。切换 Team 工作空间不会修改主页单聊的 `cwd`。
- Team 卡片直接打开新的 `OfficeWorkspaceView`。旧 Office Library 路由、旧侧栏入口和旧 bridge 已移除；遗留 `?view=office` 会带着原 `cwd` 迁移到新版 `#view-team`，并写入独立 `teamCwd`。删除办公室使用群聊自己的 `workspaceCwd`，完成后刷新 Team 列表并关闭房间。
- 主页与办公室复用领域无关的 `ComposerCore`，Office Adapter 负责成员 mention、消息身份、运行状态和失败保留草稿。Office 首条消息会先调用 `office/manager/ensure`，拿到 canonical manager 后再提交，不会再临时创建普通单聊线程。
- `office/create` 只创建 threadless canonical record。Manager runtime 只能由新增的 `office/manager/ensure` 创建或复用，source 固定为 `office_manager_runtime_v1`；普通 `thread/start`、`office/create` 和普通 `office/save` 都不能伪造或改绑 manager。并发 ensure 通过 record revision CAS 只保留一个 canonical runtime，失败方清理未提交 rollout。
- `office/message/submit` 使用 `(recordId, clientUserMessageId)` receipt 做消息幂等，按 manager 状态选择新 Run、精确 steer 或 FIFO queue。队列达到容量时只允许淘汰 terminal intent；全部为 active 时明确返回 queue-full，不再静默丢工作。
- 成员拥有服务端生成的稳定 `memberId` 和 Office-scoped runtime。mention 只接受 canonical `memberId`，文本 `@displayName` 仅在名称唯一且可精确解析时转换；模型 delegation 不能借兼容字段绕过显式 mention，成员删除或同名成员也不会把历史终态同步路由到另一个 runtime。
- Composer 的成员面板现在保留 `{memberId, agentId, displayText}` 选择态，并把 canonical mention 固化进可重试 outbox；重名成员会插入带职责的可见标签，排队或重试仍复用同一 `memberId`。输入框明确显示“群聊公开 · 主控接收/定向成员”，`@` 只改变执行路由，不制造私聊错觉。
- `office/message/submit` 现在由服务端把消息确定性分为 `conversation` 或 `task`，并把 intent 与 classifier version 固化进 canonical receipt；排队、重放、崩溃恢复和二进制升级不会重新解释同一消息。旧 `office/run` 始终保持 Task 语义。Conversation 使用独立的精简 prompt 与 `answer/responding → summarize/completed` loop，不创建任务、lease、委派、Automation、工具证据或长期记忆，也不会排入 scheduler；若活跃 conversation 收到明确工作且精确 turn 可 steer，则同一个 Run 原子升级为 Task，并采用新消息的标题、正文和 mention 路由。不可 steer 时新任务只进入 FIFO，不污染当前对话。
- 旧成员若只有 `agentId/threadId` 而没有 `memberId`，不会在读取时静默迁移，也不会继续伪装成可 `@`。成员面板会把同一 Agent 作为“升级成员身份”候选，用户显式确认后复用 `office/member/add` 的权威事务原地补齐稳定身份和 Office-scoped Runtime。
- Scheduler 的 receipt、lease、orphan recovery、workspace cursor 与容量都有持久边界。启动恢复最多记住 64 个唯一 CWD，并以固定峰值 8 并行恢复；某个处于 Waiting 的工作空间不再饿死后续工作空间，而每个 CWD 内仍保持“孤儿清理 → scheduler 恢复 → 再清理”的顺序。
- Office AdditionalContext 采用一个显式 scope、固定总预算和保守字节硬上限；完整渲染后的单 fragment（包含 key 与 envelope）最多 1,000 bytes，store value 最多 704 bytes。相同 snapshot 不重复注入，离开 scope 会写 tombstone。压缩使用只读 prepare + revision-guarded commit，恢复和 rollback 会从模型可见历史重建最后一个完整 scope snapshot，不依赖改写旧历史；legacy remote compact 的 InputText echo 会与带结构 provenance 的源历史精确去重。

当前结论分两层：

1. **可演示版本：GO。** 创建、进入群聊、首条消息、mention、执行状态、成员/任务侧栏、工作空间隔离和旧 UI 退场已经形成完整前端路径。
2. **单一大改动直接合并：NO-GO。** 当前 diff 远超 500–800 行 review 边界，必须拆分提交；协作流和专家团仍是后续功能，其中专家团继续属于单聊 Runtime，不得复用 Office 群聊工作空间状态。

剩余优化不是安全兜底的替代品，而是下一阶段的结构改进：把当前“长字符串再分片”的 Office context 改为稳定的语义片段，把服务端权威 contract 放入独立 Application/developer fragment，把 title、goal、task、memory 等不可信状态留在 Untrusted fragment；同时拆分稳定 contract、动态 state、routing 和 memory scope，减少一个动态字段变化导致整份快照 cache miss。结构化 JSON/章节还要按字段预算裁剪，避免全局 middle truncation 破坏语义；之后再补附件、Skill/MCP palette 和更完整的运行控制。

## 0A. 2026-07-15 最终审查增量

本轮在四路独立 review 后又关闭了几个真实缺口：

- 工作空间丢失的根因是 `cwd` URL 草稿恢复晚于线程历史恢复，历史首线程会抢写选择；同时 Team 只把单聊 `cwd` 当内存 fallback，没有立即规范化成 `teamCwd`。现在 URL 中显式 `cwd`（包括空值）优先，浏览器前进/后退会同步草稿并清除旧线程选择；Team 首次解析出的工作空间立即写回 `teamCwd`，群聊和单聊不再共享可变状态。
- 旧 threadless Office 缺少 `recordRevision` 时，strict read 会从原始持久化 bytes 派生稳定 revision。文件内容变化会改变 revision；第一次 manager ensure 成功后再写入正常随机 revision，因此旧 Office 能自愈，同时仍保留 CAS。
- 未提交 runtime repair 的清理会等待 thread writer 关闭、thread store 删除并物理删除 rollout；测试同时等待“loaded list 已卸载”和“rollout 不再可发现”，不再把中间态误判为最终态。
- AdditionalContext 的 P0 token 边界、opaque key 往返、active Office budget 和 legacy remote compact stale+fresh 重复注入已经修复。Office producer 同步使用 704-byte chunk，避免 core 安装时二次中段截断。
- Office 外部 mutation guard 不再把普通 pathless/remote thread 的空 CWD 送入 Office 文件查询；受保护 runtime source 仍然 fail-closed。Office 启动恢复只扫描本地 ThreadStore，scheduler state 不存在时只读路径不会创建目录或 lock，避免给非 Office / 非本地存储引入启动副作用。
- 内部 rollout 仍保留 `commandExecution` 供 Office evidence/recovery 使用，但 `thread/read`、turns list、resume/fork 等外部历史响应会在边界统一过滤它；实时 command execution 通知不受影响。

验证结果：前端全套 204 个文件、1,186 个用例通过，生产构建通过；app-server 项目级全套 1,174/1,174 通过；协议 234/234 通过；新增端到端覆盖 conversation 的最小 prompt、恶意 `officeUpdate` containment、memory/scheduler 隔离，以及 conversation 原地升级后精确 steer。`office_runtime_repair` 7/7、AdditionalContext 相关 46/46、compact 单元 20/20、legacy threadless manager provisioning、Office context hard-cap、服务端托管 member 自动派发、manager auto-replan、stale active-run 拒绝和 accepted-memory retrieval 测试均通过。core 项目级全套曾在高并发下运行到 2,495/2,729 通过，另外 234 条共同触发 10 秒事件超时；唯一可稳定复现的非超时断言已修复，受影响的 AdditionalContext、compact、session 与 runtime identity 测试随后以低并发定向通过。完整 Rust workspace suite 未运行，因为 `core/common/protocol` 的全量 workspace 测试按仓库约定需要用户明确授权。

落地结论仍然分层：

1. **本地可演示：GO。** 当前新版 Office、工作空间隔离、刷新恢复、旧深链迁移和核心执行链路可继续演示与迭代。
2. **当前工作树作为一个 PR：NO-GO。** 规模审查快照为 279 个文件、`+47,105 / -5,641`，总 churn **52,746 行**；排除生成协议/schema 与设计文档后仍约 **50,672 行**。此外 `.crewon` 下还有运行态数据库、rollout、lock 和 owner state，任何落地切片都必须明确排除。

仍未关闭、因此阻塞正式兼容性落地的事项：

- 旧客户端到新 app-server 的 manager binding 流程，以及新 UI 到旧 app-server 的 manager ensure 能力协商；
- legacy Automation binding 标识迁移、健康旧 Automation rollout 的 owner adoption，以及 legacy member runtime 的 owner registry 迁移；
- oversized/quarantined Office 的可见迁移方案，以及 owner registry 超过 256 records / 64 MiB 时的增量 bootstrap；
- 旧 rollout 中无结构 provenance 的 InputText AdditionalContext 迁移；
- Team workspace 与“创建后停留新版房间”的 mounted UI 集成测试、server-owned manager 的完整 message-submit 冷启动链路、精确 mention delegation 和 compaction/resume 的 agent integration tests。

最小落地顺序应为：① workspace URL/群聊单聊隔离；②共享 Composer；③ Context provenance、bounded store、compaction 三个独立切片；④ record identity/CAS/legacy migration；⑤ runtime registry、provenance guard、repair/recovery；⑥ Manager 与 Member 生命周期；⑦ Message Submit 的 validation、receipt、queue、dispatch；⑧ Automation/scheduler/run；⑨ Office Room UI adapter。每片把协议、handler、schema 和对应测试一起落地，并控制在 500–800 行 review 边界内。

## 0B. 原始 Review 决议与兼容原则

本设计经过 breaking change、模型上下文、测试和变更规模 review 后，确认目标架构成立，但不能直接整体替换当前 Office Runtime。实施必须遵守以下迁移约束：

1. 不原地改变现有 `office/create`、`office/message/send`、`office/run` 的必填字段、响应字段或完成语义。新能力使用可选字段、显式 `runtimeVersion` 或新增方法；旧字段继续返回。
2. 现有 version 1 Office、旧 rollout、Automation 中嵌入的 Office 快照和活跃 delegation 必须继续可读、可恢复；不能静默旋转仍在执行的 thread。
3. Office-scoped Session 采用双解析迁移：新 scoped session 优先，旧 `member.runtime.threadId` 次之，Agent Definition 的全局 `threadId` 只作为 legacy 最后回退。只给新招募成员或显式迁移的空闲成员创建 scoped session。
4. 新成员和 scoped repair 不得修改 Agent Definition 的 `threadId`；repair 只能重绑一个 Office 中精确匹配旧 thread 的 member、route 和未启动 delegation。旧 row 缺少 `agentId` 时，只有唯一 member owner 且 `member` 身份信号不冲突才允许推断，否则整次 fail closed。
5. 客户端仍会全量回写 `config`，因此 session registry、revision、checkpoint 和 scheduler authority 不能只依赖客户端可覆盖 JSON。迁移期继续投影兼容字段，服务端权威状态逐步迁到 sidecar/store，并引入 CAS/revision。
6. typed report 上线采用“typed 优先、旧 fenced JSON fallback”；两阶段 Supervisor 上线后仍保留旧 coarse Run status/turn 投影，新增阶段放在 `phase` 中。
7. 新 Context Policy 先兼容旧值：`taskOnly` 等价于 `isolated`，`sharedDigestWithRecent` 等价于 `forkLastN`。完成双读后再迁移持久化值。
8. AdditionalContext key 被清除时必须写显式 tombstone/cleared snapshot，不能只省略 key；后续 revision 必须声明 supersede 旧值。
9. 类型化上下文、单项和总 token 硬上限属于 M0 安全边界，必须早于共享 Composer 和新增 Office 流量。
10. “原子创建”按 durable saga 实现：带 idempotency key、`creating/ready/createFailed` 状态、补偿和重试；不假设 Office 文件与 thread rollout 能共享数据库事务。

首个落地切片只建设可独立证明安全的 repair 底座：repair 精确到一个 Office 文件和旧 thread，不再写 Agent Definition；任何成员 session 丢失 rollout 时都使用标准环境 base instructions、显式清空额外 developer override，并以只读权限 fail closed，不从客户端可覆盖的 Office JSON 或当前 Agent Definition 恢复安全配置。新招募隔离必须等稳定 `officeId/filePath + revision` 或服务端 session registry 先落地。

### 0.1 本轮 M0 落地边界

本轮已经实现并验证的不是完整 Office 产品，而是后续共享 Composer、创建向导和长期运行必须依赖的安全底座：

- `workspace.recordId` 成为稳定记录身份，`workspace.recordRevision` 提供客户端 CAS；服务端 mutation 总是在锁内读取并修改最新记录。
- 删除使用持久 workspace identity tombstone 和 `active → deleting → deleted` 状态机；丢失删除响应或中途崩溃不会让旧保存请求复活 Office。
- member runtime repair 使用 exact record、old thread 和 agent identity；replacement 先 pending claim，Office 写入成功后才 active，失败会释放 claim 并清理 replacement。
- runtime owner registry 当前以 workspace/CWD 为所有权域；所有 Office start、interrupt、history 和 scheduler thread touch 还必须验证 thread 的创建 workspace，阻止跨 workspace 执行、取消或读取。提升到 `codex_home` 全局 registry 与显式 runtime retirement/GC 是独立后续阶段。
- Manager 请求和 member task 保持普通用户输入，UTF-8 硬上限为 900 bytes；超限在写入 Office 状态前显式拒绝，不做静默截断。Office 上下文按最多 6,300 bytes 分成 704-byte untrusted AdditionalContext values（当前最多 9 个 payload fragment），并用 `[cleared]` 显式覆盖旧片段；包含 envelope 的最终单项最多 1,000 bytes。
- accepted memory、共享摘要、memory index 和 Office record 均有硬上限；pending/rejected memory 不进入后续检索上下文。
- scheduler 使用稳定 `recordId` keyset 分页、持久复合游标和跨进程锁，不会永久只扫描前 24 个 Office 或前 256 个 target。
- turn 已启动但 Office started 状态写入失败时先立即 interrupt；interrupt 失败会写入最多 64 项的持久 orphan queue，在后续恢复或重启时重试。
- PC/Web UI 已改为消费服务端返回的 canonical Office config，不再把本地缓存 revision 拼到任意旧快照上绕过 CAS。
- 当前生产主页 `CommandWorkspace` 与真实 `OfficeWorkspaceView` 已共用领域无关的 `ComposerCore`：统一 form、受控 textarea、自动高度、IME 防误发、Enter/Shift+Enter/Cmd-Ctrl+Enter 意图、发送按钮和并发提交保护。Office 通过薄 Adapter 只暴露当前成员 `@` palette，并保持“发送成功后清空、失败保留草稿”；Core 不读取 Office record/runtime，也不替业务层清空输入。

仍未在本轮实现：完整三步创建 saga、旧 `AppConversationSurface` Composer 向共享 Core 的迁移、Office 附件与授权 Skill/MCP palette、运行中 steer/stop Adapter、typed `office_report`、两阶段 supervisor、独立 Run Checkpoint、runtime retirement/GC，以及 M1/M2/M3 的其余交互与调度能力。它们不能被当前 M0 状态字段、共享输入骨架或旧 fenced JSON fallback 冒充为已完成。

### 0.2 群聊 P0 containment 与后续边界

本轮 review 发现当前群聊链路仍把每条消息直接当成 `office/run`，而 core 的普通 `turn/start` 在已有 active turn 时会 steer 到旧 turn。若 app-server 仍先创建新 Run，就会产生同一真实 turn 对应多个 Office Run 的幽灵账本。当前已先完成以下止血：

- 服务端在任何 Office 状态写入前拒绝第二个 nonterminal manager Run，并返回带 `type=officeManagerRunActive`、`runId`、`turnId`、`status` 的 typed error data；陈旧客户端 config 也会先解析 canonical record 后拒绝。
- 整体取消不会因 manager 或某个 child 已 inactive 而提前退出；仍活跃的 member/verification 会继续收到 interrupt。若所有 target 都已 inactive，服务端直接把陈旧 Run 与可取消 child 收敛为 `interrupted`，避免永久停在 `canceling` 并锁死后续 Run。
- 新 `office/member/add` 不再把 Agent Definition 的全局 thread 当作 Office member runtime，也拒绝客户端注入 runtime thread binding；已有 legacy Office 仍可完成旧 route，但新招募在 Office-scoped provisioning saga 落地前会 fail closed。
- Manager 可见上下文不再暴露 member raw thread target；新 prompt 把 app-server scheduler 定义为唯一派发权威，并移除直接 `followup_task` / `send_message` / `spawn_agent` 指令和 routing output 示例字段。旧 rollout history 不重写，因此完整强制边界仍要求新的 manager runtime generation 与工具层门控。
- UI 的真实发送失败现在会继续向上抛出，Office draft 不会因为 action 内部吞错而被清空。

连续群聊的 P0 containment 已落地：`office/message/submit` 以 canonical receipt 在新 Run、精确 steer 和 FIFO queue 之间选择；对话不再自动进入任务看板，明确工作可在精确 active turn 上原地升级，Composer 同时提供“继续群聊/追加要求”和 Stop。现有 `office/message/send` 继续保持 legacy persistence 语义，`office/run` 继续表示显式 Task Run，不参与自然语言 intent 分类。仍待后续切片完成的是服务端权威 contract 与不可信状态的 context 分层、稳定/动态 scope 拆分，以及结构段预算裁剪。

### 0.3 历史终审落地 Gate（2026-07-13，已由 0A 更新）

当前工作树不能作为一个 PR 或一个提交落地。仅 tracked diff 已超过 1.6 万行，加上新增文件约 2.4 万行，远超非机械改动 500–800 行的 review 边界。终审确认以下问题仍会阻塞安全发布：

1. Manager 的 scheduler-only 仍是 untrusted prompt 约束，没有工具层 capability gate；历史高优先级指令仍可能直接调用多智能体工具绕过 app-server。
2. 模型产生的 `verificationChecks[].automationId` 尚未绑定服务器可信 allowlist，可把任意同 workspace Automation 提升为自动执行目标。
3. delegation 与 verification child dispatch 没有 durable receipt；进程在 `turn/start` 后、canonical `mark_started` 前崩溃会在 lease 到期后重复执行。
4. auto-dispatch intent 的 live/recovery 路径没有统一 `queue → claim(leaseId) → dispatch → CAS commit`，stale worker 也没有 lease ownership 校验。
5. scheduler `index.lock` 依赖临时文件 `Drop` 删除，进程崩溃会留下永久锁；必须改为 advisory lock 或可证明安全的 stale reclaim。
6. whole-run cancel 的 target snapshot 与 barrier mutation 不原子，新 child 可能只被标成 `canceling` 而没有被 interrupt；interrupt 失败也没有 durable retry queue。
7. protected runtime guard 当前只对已加载 thread fail closed；unload 后的 delete/rollback/compact/fork 以及 `thread/fork.path` 仍能绕过。权威判断必须来自 thread store + rollout SessionMeta + runtime owner registry，而不是只信可伪造的 `threadSource`。
8. legacy Office 仍可能复用普通 Agent/global thread；新架构必须把 Agent 仅作为 profile/template，显式创建并登记 Office-scoped runtime。
9. AdditionalContext 虽已具备 scoped merge 与 compaction 硬上限，但没有 scope deactivate/tombstone、active-owner priority 和 rollback 后 store 重建；离开 Office 后旧 manager context 仍可能继续重放。
10. CAS rolling upgrade 只解决了新 UI 对旧 server 的响应回退；旧 UI 不回传 `recordRevision` 时，新 server 的第二次保存仍会被判 stale。

本轮已经验证并可保留为后续小切片基础的修复包括：manager durable dispatch receipt、可信 delegation route 覆盖、900-byte 输入边界、verification 6,300-byte 总 context 上限与 1,000-byte rendered-item 硬边界、取消两阶段收敛、loaded member/automation runtime 的外部 mutation guard、固定服务器拥有的 automation runtime developer contract、scoped AdditionalContext merge/有界 compaction、共享 Composer，以及 boxed request future 对 4 MiB 栈 canary 的修复。

推荐按以下依赖顺序拆分落地，每一阶段独立 review、迁移和集成测试：

```text
record identity + CAS
  → workspace/runtime authority + crash-safe lock
  → protected runtime provenance/capability gate
  → manager receipt + lifecycle
  → cancel barrier + durable cancel retry
  → child receipts + claimed auto-dispatch intents
  → trusted automation bindings
  → semantic context fragments + scope lifecycle
  → Office message/steer group-chat endpoint
  → shared Composer/UI
```

在前六个后端阶段完成前，不应宣称 Team Runtime、自动派发或群聊执行已经具备 exactly-once、可恢复或强隔离语义。

## 1. 结论

办公室应该被定义为一个长期存在的协作空间，而不是一个带成员列表的聊天线程，也不是每条消息都启动一次多 Agent 工作流。

核心模型：

```text
Office Definition（长期配置）
  ├─ Office Manager Session（办公室主会话，唯一）
  ├─ Office Member Sessions（按办公室隔离的成员私有会话）
  ├─ Office Runs（一次次可追踪执行）
  │    ├─ Delegations（成员子任务）
  │    ├─ Verification（验证）
  │    └─ Artifacts / Evidence（产物与证据）
  └─ Office Memory（经审核的长期记忆）
```

必须坚持以下边界：

1. 用户始终在办公室主会话中交流；成员私有 transcript 不直接拼进主会话。
2. 主控模型负责理解、计划和提出委派意图，app-server 是唯一真正启动、重试、取消和恢复成员执行的调度权威。
3. Agent 是可复用定义；招募进办公室后必须创建 `(officeId, memberId)` 作用域的 Runtime Session，不能直接复用 Agent 在其他办公室或资源库里的全局线程。
4. Office JSON 是有界的共享状态账本，不是聊天记录、模型上下文或运行事件仓库。
5. 群聊 Composer 与主页共用 UI 组件和输入行为，但由 Office Composer Adapter 提供不同的目标、上下文、运行状态和发送语义。
6. 上下文压缩按主控线程、成员线程分别发生；办公室共享状态通过结构化 checkpoint 恢复，不能依赖压缩摘要记住任务状态。

## 2. 产品语义

### 2.1 办公室是什么

办公室解决的是持续协作问题：一组稳定角色围绕长期目标反复接收消息、形成任务、分工、验证并沉淀结果。

办公室包含：

- 一个明确目标和工作边界；
- 一个主控 Agent；
- 0–8 个已招募成员；
- 一个绑定工作空间；
- 一套派发、审批、外部动作和上下文策略；
- 多次相互独立但可连续理解的 Office Run；
- 经用户审核的长期记忆。

办公室不等于：

- Scene：日常办公、生码、设计创意仍然决定任务契约，办公室决定执行组织方式；
- Workflow：办公室允许开放式协作，不要求所有工作预先进入固定节点；
- Expert Team：办公室公开成员和过程，专家团只暴露组长；
- 普通群聊：消息可能触发真实执行、审批、产物和验证。

### 2.2 四类办公室消息

主控应先对消息分类，但不要求用户选择模式：

| 类型 | 示例 | 系统行为 |
| --- | --- | --- |
| 对话 | “现在做到哪了？” | 回答或汇总，不创建任务 |
| 背景补充 | “客户要求周五前完成” | 更新当前 Run 或形成待确认记忆 |
| 执行请求 | “把风险清单补齐并验证” | 创建或推进 Office Run |
| 控制指令 | “暂停这个任务”“让审阅 Agent 重做” | 映射到取消、重试、转派或 steer |

消息分类只是主控的理解结果。真正的状态变化必须由服务端接受类型化命令后发生，不能仅靠回复文本或 fenced JSON。

## 3. 页面与交互

### 3.1 办公室列表

每个办公室卡片显示：

- 名称、目标摘要、绑定工作空间；
- 主控与成员头像；
- `空闲 / 执行中 / 等待确认 / 有阻塞 / 配置异常`；
- 当前 Run 的一句话状态；
- 最近更新时间。

卡片主动作是“进入办公室”。创建、复制、归档和删除放在次级菜单中。

### 3.2 办公室详情

建议保持一个主会话，不在“群聊”和“运行台”之间切走整个页面：

```text
┌ 办公室标题 / 工作空间 / 状态 / 设置 ───────────────────────┐
│ 成员栏        主会话 transcript                 当前工作面板 │
│ - 主控        - 用户消息                        - Run 状态   │
│ - 成员        - 主控答复                        - 任务       │
│ - 在线状态    - 委派/工具/审批折叠事件           - 委派       │
│ - 上下文预览  - 产物卡片                        - 验证/风险  │
│               [共享 Composer，固定在底部]        - 产物       │
└────────────────────────────────────────────────────────────┘
```

“活动”和“记忆”仍可作为右侧面板或二级页，但不能让用户为了查看运行状态离开主会话。发送消息后自动跳到 Activity 会破坏对话连续性，不建议保留。

### 3.3 与主页共用 Composer

共享的是组件骨架和基础交互，不是把主页所有控制原样搬进办公室。

建议组件结构：

```ts
<Composer
  adapter={officeComposerAdapter}
  value={draft}
  runtimeState={officeRuntimeState}
  context={officeComposerContext}
/>
```

共享能力：

- 自适应高度、草稿、快捷发送、停止按钮；
- `+` 添加文件、文件夹、知识库和其他真实上下文；
- `@` mention palette；
- `/` Skill、MCP、App palette；
- 附件 chips、连接状态、错误和重试；
- Escape、重复触发、选择和点击外部关闭 palette；
- 运行中 steer/stop 的视觉行为。

Office Adapter 改变：

- 工作空间固定为办公室绑定空间，Composer 内只显示，不允许临时偷偷切换；切换必须进入办公室设置并创建配置 revision。
- 执行主体固定为办公室，不再显示主页的 Agent/Team 选择器。
- Scene 可以从消息意图自动解析；若产品需要显式选择，应该作为当前 Run 的场景，而不是办公室永久属性。
- Goal/Plan 不应直接复用主页语义。办公室已有长期目标；Plan 应表现为“先给办公室计划，确认后执行”的本次消息意图。
- `@成员` 必须生成结构化 mention `{memberId, agentId, displayText}`，不能只在字符串里高亮。

### 3.4 发送语义

#### 办公室空闲

- 普通发送：进入主控线程，由主控判断回答、更新背景还是提出 Run。
- `@成员`：仍先进入办公室控制面；服务端创建 directed delegation 或将消息交给该成员的 Office-scoped Session，同时把事件写回主控账本。
- 明确附件和 `/Skill`：作为类型化输入发送，不展开成一大段用户文本。

#### 主控 Run 正在执行

Composer 主动作变为“追加要求”，不是并发创建第二个主控 Run。

- 普通消息：使用现有 turn steer 能力追加给当前主控 turn；
- “停止”：取消当前 Run，并级联取消活跃成员和验证 turn；
- 新的独立目标：进入队列，显示“将在当前任务结束后开始”，用户也可以选择“停止当前并开始新任务”。

同一办公室主控线程同时最多一个 active manager turn。否则同一 transcript、任务账本和调度器会出现竞争写入。

#### 只有成员子任务在执行

- 普通消息发给主控，形成控制事件；主控可以等待、转派或补充计划；
- `@正在执行的成员` 可作为明确 follow-up 发送到该成员 turn，但必须同时记录到 Office event ledger，并让主控看见这次干预；
- `@空闲成员` 创建新的人工派发请求，是否立即并行取决于并发、权限和风险策略。

### 3.5 Transcript 展示

主 transcript 只展示用户可理解的办公室事件：

- 用户/主控消息；
- “已委派给 X”及任务摘要；
- 成员结果摘要和证据卡片；
- 审批请求；
- 产物；
- 阻塞、取消、重试和恢复；
- 验证结果。

不把成员完整思考、完整工具日志或私有 transcript 混进群聊。需要排障时通过“查看成员运行”打开独立详情。

## 4. 创建办公室

### 4.1 当前创建方式的问题

当前 `office/create` 只接收 `cwd/title/subtitle/threadId/goal`，前端点击创建后会立刻生成一个默认名称的空办公室，再单独招募成员。这样会产生：

- 没有主控和成员也已保存的半成品办公室；
- Office 记录、主线程和成员 Runtime 分多步创建，失败时难以回滚；
- 用户还没完成配置就出现真实后端对象；
- 无法在创建时校验 Team Runtime、权限和成员上下文隔离。

### 4.2 创建流程

采用三步渐进式创建，前两步保持本地草稿，最后一步原子提交。

#### 第一步：定义办公室

- 名称；
- 一句话目标；
- 绑定工作空间；
- 可选模板：产品交付、代码审查、设计交付、会议准备、空白。

工作空间是必选项。首版不支持“无工作空间”的办公室，因为成员文件权限、产物和验证都需要稳定边界。

#### 第二步：组建团队

- 选择主控 Agent；
- 招募 0–8 个已保存 Agent；
- 为成员设置办公室内角色；
- 检查能力重复、缺失能力和权限冲突；
- 显示每位成员会获得的 Context Policy 预览。

主控必须存在。允许创建只有主控的办公室，后续再招募成员。

#### 第三步：运行规则

- 自动派发：关闭 / 仅低风险 / 允许到中风险；
- 最大并行成员数，默认 2，硬上限 4；
- 外部动作：草稿 / 每次确认；
- 成员上下文策略：由系统推荐，允许逐成员调整；
- 长期记忆：默认“候选需审核”；
- 完成后检查与摘要策略。

提交前执行 dry-run validation：

- Agent 定义存在；
- 每个 Agent 的模型、Skill、MCP 和权限可用；
- 工作空间可访问；
- 主控和成员权限不超过办公室上限；
- Team Runtime 可用；
- 成员 Session 可以创建；
- 自动派发规则没有绕过审批。

### 4.3 原子创建

不能给现有 `office/create` 增加可选幂等字段或偷偷改变它的完成语义。旧服务端可能忽略未知字段并返回“成功”，实际却只创建无线程 Office。新增 v2 saga API：

```ts
type OfficeCreationCommitParams = {
  cwd: string;
  idempotencyKey: string;
  runtimeVersion: "managerV1";
  title: string;
  subtitle?: string | null;
  goal?: string | null;
};

type OfficeCreationCommitResponse = {
  filePath: string;
  config: OfficeConfig;
  managerThreadId: string;
};

type OfficeCreationReadParams = {
  cwd: string;
  idempotencyKey: string;
};

type OfficeCreationSnapshot = {
  runtimeVersion: "managerV1";
  status: "pending" | "managerThreadCreated" | "committed" | "compensationPending";
  managerThreadId: string | null;
  office: OfficeRecord | null;
  lastError: string | null;
};
```

首阶段 `managerV1` 只原子创建 Manager Session 与 ready Office；主控 Agent、成员和运行策略在后续 `teamV1` 中加入，避免一个巨型提交同时承担能力校验、全团队创建与逆序补偿。

权威 saga 状态保存在 `$CODEX_HOME/office-creations/<sha256(idempotencyKey)>.state`，而不是 Office JSON。状态文件只保存 key hash、cwd、规范化请求 fingerprint、runtime version、状态、manager thread id、Office identity/path、截断错误和时间戳；单文件与目录数量都必须有硬上限。`office/list` 永远看不到 `creating` 半成品。

服务端创建顺序：

1. 校验 cwd、幂等 key、`managerV1`、title/subtitle/goal，并计算请求 fingerprint；
2. 获取 key hash 对应的跨进程锁；同 key 不同 fingerprint 直接冲突；
3. 读取或创建 saga state；已 committed 时按保存的 record identity 返回 canonical Office；
4. 创建持久 Manager Session。thread source 使用可恢复标签 `office_manager_runtime_v1:<keyHash>`，解决“线程已创建但 state 尚未写入”崩溃窗口；
5. 确认 Manager rollout durable 后写入 `managerThreadCreated` state；
6. 使用 `OfficeWriteIntent::Create` 一次写入带 `workspace.threadId` 的最终 Office；
7. 将 Office record identity/path 写入 committed state，再返回成功；
8. Office 写入报错时先按 thread id 重读 Office。只有明确不存在才删除 Manager Session；读取不确定或删除失败进入 `compensationPending`，重试期间禁止创建第二个线程。

新 UI 遇到 `office/creation/commit` method-not-found 必须 fail closed 并提示升级后端，不能退回 `office/save`。`office/creation/read` 用于提交响应丢失后的结果查询；同一个 committed key 即使 Office 后来被删除，也不能自动复活记录。

## 5. Team Runtime

### 5.1 合理的部分

现有方向中以下决策是合理的：

- 复用现有 thread/turn、权限、审批、沙箱和事件流；
- 编排逻辑留在 app-server，不在 `crewon-core` 复制第二套 Agent Loop；
- Office Run、Delegation、Verification 有明确 id 和持久化状态；
- 成员私有 transcript 与 Office 共享账本分离；
- 后端拥有恢复、幂等 claim、取消和重试；
- 长期记忆只有 accepted 项可进入后续上下文；
- 产物和证据存引用、hash 与 provenance，不把完整内容塞进 Office JSON。

### 5.2 当前不合理的部分

#### 双重调度权威

当前主控 prompt 允许模型直接调用 `followup_task`、`send_message` 或 `spawn_agent`，同时模型又输出 `officeUpdate.delegations`，后端 scheduler 也会 dispatch。两条路径可能重复执行、产生不同状态来源，并让审批、恢复和幂等难以统一。

修正：

- Office 主控默认不直接获得通用 multi-agent mutation tools；
- 主控输出类型化 `DelegationIntent`；
- app-server Resolver 校验成员、任务边界、风险、权限、并发与重复项；
- scheduler 唯一负责创建 member turn；
- 对活跃成员的 follow-up 也走 Office control API，而不是模型自由调用通用工具；
- Office MVP 禁止匿名 `spawn_agent`。如果未来支持临时专家，必须成为显式、有生命周期和预算的 `ephemeralMember`。

#### 通过 fenced JSON 更新核心状态

从最终回复解析 `officeUpdate` 适合作为早期原型，不适合作为长期控制协议：格式容易漂移，模型文本可能被上下文诱导，部分解析会造成状态不一致。

修正：使用类型化 model output 或专用内部工具：

```ts
office_report({
  runId,
  plan,
  delegationIntents,
  taskUpdates,
  acceptance,
  verification,
  evidence,
  risks,
  artifacts,
  memoryCandidates,
});
```

该工具只写“建议和报告”，不直接启动子 Agent、写外部系统或批准自己。app-server reducer 校验后写入共享账本。

#### 成员 Runtime 线程作用域

当前从保存的 Agent config 解析 `runtime.threadId`，有把同一个 Agent 的长期线程跨办公室复用的风险。这会导致办公室 A 的私有历史影响办公室 B，破坏隔离，也让删除、恢复和权限变更难以解释。

修正：

- Agent Definition 仅提供 persona、模型、Skill/MCP 和权限上限；
- 招募时创建 `OfficeMemberSession { officeId, memberId, agentDefinitionId, threadId }`；
- 同一 Agent 被两个办公室招募时拥有两个不同 member thread；
- 成员离开办公室后 session 归档，不复用给其他办公室；
- Agent Definition 更新不静默修改运行中的办公室，通过 revision 提示用户应用更新。

首个可落地 provisioning 切片不新造 runtime 系统，而是复用现有 repair transaction、owner registry 和未提交 thread discard：

1. `(workspace.recordId, agentId)` 是幂等与所有权 key，并通过 hash 后的跨进程文件锁串行化；
2. 保存 Agent 的 `threadId` 只作为 legacy source/provenance，不作为执行 target，也不 fork 或复制其 transcript；
3. 服务端创建新的空白、持久、read-only Office member thread；
4. 在同一事务中 pending-claim owner、CAS 写入最新 Office、activate claim；revision 冲突或写入失败时删除新 thread；
5. 新 binding 投影 `runtime.threadId`、`sessionScope=office`、`runtimeVersion=2`、`repairSourceThreadId=<agent source thread>`；
6. 相同 Agent 重复加入同一 Office 返回已有 scoped runtime；加入不同 Office 必须创建不同 thread；
7. 客户端提供的 `member.threadId` 或 `member.runtime.threadId` 始终拒绝。

该首阶段只承诺隔离、所有权和可执行路由。Agent model、权限 profile、MCP/Skill allowlist 与 definition digest 的精确继承属于下一阶段，不能宣称已经具备完整 Agent capability parity。

### 5.3 Runtime 状态机

```text
OfficeRun
  queued
    → framing
    → waitingForApproval
    → dispatching
    → running
    → verifying
    → summarizing
    → completed
  任意活动态 → canceling → interrupted
  任意活动态 → blocked / failed
```

Delegation 单独维护：

```text
proposed → approved/autoApproved → queued → running
        → completed / failed / interrupted / skipped
```

主控 turn 不应该在启动成员后马上被当作整个 Run 的最终完成。推荐两阶段 supervisor：

1. Manager planning turn 产出 plan 和 delegation intents；
2. Scheduler 执行成员 turn；
3. 全部必要成员完成后，启动 manager synthesis turn；
4. 必要时执行 verification；
5. Manager finalization 输出用户结论。

这样 Run 完成条件由服务端状态机决定，而不是“主控第一次回复完成”。

### 5.4 并发与冲突

- 同一办公室最多一个 active manager phase；
- 默认同时运行 2 个成员，硬上限 4；
- 同一成员同一时间只执行一个 delegation；
- 生码任务默认不允许两个成员写同一工作树；必须分配 worktree 或文件 ownership；
- 外部发送、共享写入、push、publish 和 destructive action 均不能自动执行；
- 重试创建新 attempt，保留原 attempt，不覆盖历史；
- scheduler 的 claim key 至少包含 `(officeId, runId, delegationIntentId, attempt)`。

## 6. 上下文管理

### 6.1 五层上下文

每次主控推理只装配与当前决策有关的五层上下文：

1. Office Identity：名称、目标、工作空间、主控身份和权限上限；
2. Active Run Checkpoint：当前目标、验收、未完成任务、活跃委派、阻塞与下一步；
3. Recent Conversation：最近少量用户/主控消息；
4. Retrieved Memory：与当前请求相关且已接受的长期记忆；
5. Explicit Context：用户本次添加的文件、知识库、Skill/MCP 和产物引用。

成员上下文只包含：

- 成员 Agent Definition 的有界 profile；
- Delegation Contract：目标、输出格式、验收、权限、截止条件；
- 与该任务相关的 Office Run digest；
- 允许的 accepted shared/member memory；
- 明确附件和证据引用；
- 成员自己的 Office-scoped thread history。

不包含：其他成员 transcript、完整主控历史、整个 Office JSON、所有历史 Run。

### 6.2 Context Policy

将当前策略收敛为三个语义清晰的选项：

| 策略 | 注入内容 | 适用情况 |
| --- | --- | --- |
| `taskOnly` | 任务合同、附件、允许的记忆 | 外部专家、敏感隔离 |
| `sharedDigest` | taskOnly + 当前 Run 结构化摘要 | 默认 |
| `sharedDigestWithRecent` | sharedDigest + 最多 4 条相关办公室消息 | 需要理解近因对话 |

不使用 `forkLastN` 命名，因为实际没有 fork 主控线程历史；名称必须反映真实语义。

### 6.3 Token 预算

当前实现主要用字符数上限，不能可靠代表 token 数。需要在送入模型前使用目标模型 tokenizer 做最终裁剪。

推荐单次 Office 专有注入预算：

| 层 | 推荐上限 |
| --- | ---: |
| Office Identity | 600 tokens |
| Active Run Checkpoint | 1,000 tokens |
| Recent Conversation | 800 tokens |
| Retrieved Memory | 800 tokens |
| Explicit Context metadata | 600 tokens |
| Office 专有总预算 | 3,800 tokens |

任何单个注入片段不得超过 1,000 tokens；超过时按 P0 处理并要求人工评审。文件正文不直接塞入统一摘要，应通过文件/产物引用按需读取。硬上限必须低于 10K tokens。

M0 的实际落地先使用更容易在 app-server 边界严格执行的 UTF-8 byte cap：普通 manager/member 输入最多 900 bytes，超限在任何 Office 状态写入前显式拒绝；Office typed context 合计最多 6,300 bytes，按 704-byte value 分片（当前最多 9 个 payload fragment），包含 key 与 envelope 的完整 rendered item 最多 1,000 bytes。这个保守 byte cap 同时提供单项 `<=1,000 tokens` 的硬边界，总量也显著低于 10K tokens。后续按模型 tokenizer 做 3,800-token 预算时，应收紧或重分配这些 byte cap，不能在其上再叠加一套无界 token 注入。

### 6.4 权限与 Contextual Fragment

当前 Office 运行把长篇平台合同、成员路由、任务和用户消息拼成同一个普通 `UserInput::Text`。这会：

- 每轮重复稳定规则，持续增长历史；
- 频繁改变 prompt 前缀，降低缓存命中；
- 把平台规则、服务端解析状态和用户文本放在同一权限层；
- 让用户或附件内容影响路由和状态协议。

目标架构应收敛为语义化片段：

```rust
struct OfficeIdentityContext { /* stable, revisioned */ }
struct OfficeRunCheckpointContext { /* bounded, latest snapshot */ }
struct OfficeMemberTaskContext { /* bounded delegation contract */ }
```

M0 复用 core 已有、实现了 `ContextualUserFragment` 的 `AdditionalContextUserFragment`，通过固定 key 和 untrusted kind 发送有界快照；没有向膨胀的 `crewon-core` 新增 Office 专用类型。未来如果 identity、checkpoint 和 member contract 需要不同生命周期或权限语义，再把它们拆成独立 fragment struct。用户输入始终保持纯 `UserInput`；文件名、消息、Agent 描述和记忆内容不能被提升为 developer/platform 指令。

更新采用完整 snapshot 上的 upsert，并保留其他功能已有的 AdditionalContext key。建议 key：

- `crewon.office.identity.v1`：办公室身份，仅 revision 改变时更新；
- `crewon.office.run.v1`：当前 Run checkpoint，值变化时更新；
- `crewon.office.member_task.v1`：成员当前任务，member turn 使用；

不得创建 `crewon.office.run.<revision>` 这类无限增长 key。

## 7. 上下文压缩

### 7.1 压缩的对象

分别压缩：

- Office Manager Thread：用户与主控的长期对话；
- 每个 Office Member Thread：该成员在该办公室内的私有执行历史；
- Verification/Automation Thread：各自独立。

不压缩：

- Office Definition；
- 当前 Run 的结构化状态；
- Delegation ledger；
- 审批、产物 provenance 和证据 hash；
- accepted memory records。

这些属于可恢复状态，应该保存在数据库/账本中，而不是依赖模型摘要。

### 7.2 压缩时机

- 使用现有线程 token window 自动压缩；
- Run 完成时生成一个结构化 Run Checkpoint；
- 主线程接近压缩阈值时，先确保最新 checkpoint 和引用已持久化，再运行通用压缩；
- 成员线程独立达到阈值时独立压缩，不影响主控或其他成员；
- Office 配置 revision 变化不触发历史重写，只更新 identity fragment。

### 7.3 Run Checkpoint

每次 Run 结束保存：

```ts
type OfficeRunCheckpoint = {
  runId: string;
  requestSummary: string;
  outcome: "completed" | "blocked" | "failed" | "interrupted";
  decisions: BoundedDecision[];
  openTasks: BoundedTaskRef[];
  artifacts: ArtifactRef[];
  evidence: EvidenceRef[];
  risks: BoundedRisk[];
  memoryCandidateIds: string[];
  sourceTurnIds: string[];
};
```

Checkpoint 是服务端 reducer 从真实事件和类型化报告中生成的，不让模型自由决定全部事实。模型可以提供摘要候选，服务端负责绑定 provenance 和裁剪。

### 7.4 压缩后的恢复

恢复办公室时：

1. 读取 Office Definition 与最新 revision；
2. 读取 active/last Run checkpoint；
3. 恢复主控 thread 的压缩后历史；
4. upsert 最新 identity/run context fragments；
5. 只在需要派发时加载目标成员 session；
6. 检查 scheduler intent、活跃 turn 和审批状态；
7. UI 从 Office event/state API 恢复，不从 transcript 猜状态。

通用 thread compaction 可以继续使用，但必须满足：

- 不重写旧历史；
- 不把成员私有结果全文写进主控摘要；
- 不丢失未决审批、活跃委派和产物引用；
- 不把 pending/rejected memory 当作事实；
- 压缩前后结构化 Run 状态完全一致。

## 8. 记忆设计

现有“模型产生候选、用户审核、只有 accepted 可检索”的方向合理，应继续保留。

记忆与压缩必须分开：

- 压缩摘要用于维持同一 thread 的局部连贯性；
- Office Memory 用于跨 Run 长期复用；
- Run Checkpoint 用于状态恢复和审计；
- Artifact/Evidence store 用于保存可验证事实。

建议记忆写入规则：

- `decision`：已确认且未来会影响工作；
- `preference`：用户或团队稳定偏好；
- `fact`：有来源且预计长期有效；
- `lesson`：失败或复盘形成的稳定经验；
- `runSummary` 默认不进入长期记忆，除非用户明确接受；
- 任务状态、临时阻塞和一次性结果不应成为长期记忆。

检索结果必须展示“为什么被选中”、来源 Run/Turn、状态和最后使用时间。用户可以撤回 accepted，撤回后下一轮不得再注入。

## 9. API 与事件建议

建议把 Office 控制面拆成稳定资源：

- `office/create`：保留 legacy threadless 创建语义；
- `office/creation/commit|read`：幂等、可恢复的 Manager Runtime 创建 saga；
- `office/read`、`office/list`、`office/update`；
- `office/message/send`：保留 legacy persistence 语义；
- `office/message/submit`：统一群聊执行入口，服务端决定 start/steer/queue；
- `office/run/read`、`office/run/list`、`office/run/cancel`；
- `office/delegation/approve|cancel|retry|steer`；
- `office/member/add|remove|update|context/preview`；
- `office/memory/list|decide`；
- `office/artifact/read`；
- `office/events/list`：恢复 UI 的办公室级事件，不要求客户端拼 thread events。

长期目标是让新统一消息入口返回明确、不可伪造的投递结果。不能给旧 `OfficeMessageSendResponse` 增加一个看似可用但旧服务端不会执行的 action；新方法使用显式 tagged union：

```ts
type OfficeMessageSubmitParams = {
  cwd: string;
  config: OfficeConfig;
  message: OfficeMessage;
  text: string;
  locale?: "zh" | "en" | null;
  threadId?: string | null;
  clientUserMessageId: string;
};

type OfficeMessageSubmitResponse = {
  filePath: string;
  config: OfficeConfig;
  receiptId: string;
  delivery:
    | { type: "started"; runId: string; threadId: string; turn: Turn }
    | { type: "steered"; runId: string; threadId: string; turnId: string }
    | { type: "queued"; runId: string; threadId: string; turnId: string; position: number };
};
```

receipt 由服务端权威 sidecar 持久化，主键是 `(recordId, clientUserMessageId)` 并带 payload hash。单条消息 900 bytes；单 active Run 最多 8 次 steer、合计 7,200 bytes；单 Office pending queue 最多 8 条；workspace receipt 最多 256 条；sidecar 最多 512 KiB。相同 id 不同 payload 冲突，队列满返回 typed error，不能静默丢弃旧消息。Office-scoped steer 必须校验 canonical thread/turn、expected turn id 和 workspace；terminal 后一次只 claim 最老的一条 queued receipt，保持唯一 manager turn。

通知使用增量事件，读取 API 返回 snapshot：

- `office/message/created`；
- `office/run/updated`；
- `office/delegation/updated`；
- `office/approval/requested`；
- `office/artifact/updated`；
- `office/memory/candidateCreated`；
- `office/config/updated`。

客户端不拥有调度状态，不通过本地 reducer 猜 child turn 是否完成。

## 10. MVP 顺序

### M0a：兼容底座

1. repair target 使用 `(office filePath, old threadId)`，不能只按全局 threadId 猜 Office；
2. repair 只更新精确匹配的 member、route 和未启动 delegation，不修改 Agent Definition；
3. 所有 missing-rollout member repair 保留标准环境 base instructions、显式清空额外 developer override，并使用只读权限 fail closed；不信任客户端可覆盖的 runtime 投影或当前 Agent Definition；
4. 单个 CWD 的自动 repair 最多接受 16 个候选，超过上限时整轮 fail closed；候选物化和 thread ID 长度都有硬上限，大规模迁移留给具备 registry/CAS 的后续阶段；
5. 仍可加载或仍在执行的 legacy thread 保持原绑定，不做静默迁移；
6. repair 保存失败时归档 replacement thread，避免留下不可见孤儿会话；
7. 保持 version 1 record、现有 RPC、通知、fenced reducer 和 coarse Run status 不变。

### M0b：模型与上下文安全边界

1. 定义稳定 Office/Member identity、服务端 session registry 和 config revision/CAS；
2. 新招募成员通过权威 Office identity 创建 Office-scoped durable thread，并把兼容投影写入 `member.runtime.threadId`；
3. scoped session 在服务端 registry 固化创建时的模型、权限和有界 instructions，repair 不从客户端 Office JSON 恢复安全配置；
4. 用户消息保持纯 UserInput，增加有界 Office ContextualUserFragment；
5. 每个 fragment 不超过 1K tokens，Office 专有总预算不超过 3.8K tokens；
6. Manager 禁用直接 multi-agent mutation tools，app-server 成为唯一 dispatch 权威；
7. 增加 typed `office_report`，保持旧 fenced parser 只读 fallback；
8. 修复 Memory identity、最低相关度门槛和 accepted memory 撤回语义；
9. 为已有 Office 提供显式、幂等的 manager/member session migration，而不是 read/list 时静默重写。

### M1：创建与共享 Composer

1. 已完成首片：提取领域无关 `ComposerCore`，当前主页与真实 Office 复用输入、IME、快捷键、自动高度、发送与重复提交保护；
2. 已完成首片：Office Adapter 提供当前办公室成员 `@` palette，并保持成功清空、失败保留草稿；palette 选择使用结构化 canonical memberId，群聊 outbox 在排队和重试间保持完全相同的路由；
3. 下一切片：新增 `office/message/submit` receipt、Office-scoped steer 与有界 queue；active 时 Composer 显示“追加要求 + Stop”，不创建第二个 Run；
4. 随后把附件、Office 授权范围内的 `/` Skill/MCP 和旧 `AppConversationSurface` 迁入同一 Core；
5. 通过 `office/creation/commit|read` durable saga 创建 `managerV1`，新 UI 删除 legacy save fallback；
6. 通过独立 provisioning saga 创建 Office-scoped member sessions，再扩展 `teamV1` dry-run validation；
7. 主会话内展示 Run、审批、成员结果和产物。

### M2：Checkpoint 与压缩恢复

1. 保存 Run Checkpoint；
2. 增加显式 context tombstone 和 revision supersede 语义；
3. 验证 manager/member 独立压缩、恢复和 fork；
4. 增加“成员将看到什么”的审计 UI；
5. 验证撤回 memory、成员/路由变化在压缩后不会由旧合成 prompt 重新出现。

### M3：可靠调度

1. 两阶段 supervisor；
2. 并发、worktree/file ownership 和冲突策略；
3. durable scheduler worker；
4. 后台运行和自动化；
5. 完整 telemetry 与成本预算。

## 11. 必测行为

1. 创建办公室失败时不会留下可执行的半成品；
2. 同一个 Agent 加入两个办公室时获得不同 member thread，历史不串联；
3. 同一办公室不会并发启动两个 manager turn；
4. 运行中普通消息会 steer 或排队，不会偷偷创建竞争 Run；
5. `@成员` 使用结构化 memberId，重名成员不会误路由；
6. 模型重复报告同一 delegation intent 不会重复启动；
7. 模型不能通过文本伪造已批准、已验证或已执行；
8. manager/member 的 context manifest 均有 token 硬上限，任何单项不超过 1K tokens；
9. pending/rejected memory 不进入 prompt；撤回 accepted 后立即停止检索；
10. 主线程压缩后 Office 目标、当前 Run、审批、委派、产物和证据不丢失；
11. 成员线程压缩不会把其他办公室信息带入当前办公室；
12. app-server 重启后可从 snapshot、event ledger、thread history 和 scheduler intent 恢复；
13. 外部动作和高风险操作始终经过对应 Gate；
14. UI 可以预览每个成员实际会收到的有界上下文。

## 12. 对当前实现的最终判断

现有 Team Runtime 的基础方向是合理的：复用 thread/turn、把 Office 编排留在 app-server、保存有界共享账本、成员私有历史分离、支持恢复/取消/重试/审批和记忆审核。

但在进入正式办公室产品前必须修正四个结构性问题：

1. 普通 UserInput 中重复注入整套 Office prompt；
2. 模型直接多 Agent 工具与服务端 scheduler 的双重调度；
3. fenced JSON 承担核心状态协议；
4. Agent runtime thread 可能跨办公室复用。

这四项不修，UI 做得越深入，后面迁移的运行状态和上下文历史越多。建议先完成 M0，再做创建页和共享 Composer 的生产实现。
