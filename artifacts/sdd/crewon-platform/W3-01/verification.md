# W3-01 Verification

状态：Discovery/详细设计 Green；Wave A-E scoped Green；Wave F 的F-01 hermetic Gate Green、F-02 Partial，F-04 readiness audit完成但 live execution仍 Red。真实WebSocket纵向Harness已覆盖标准start/progress/duplicate/disconnect、app-server restart、Provider暂时不可用后同Run恢复、verified final Artifact与标准Thread结果，以及幂等标准取消；异常矩阵由同一temporary State/Fake Provider测试金字塔覆盖。生产Gate仍 Red：两个生产开关未启用，完整workspace test尚未获授权，真实Provider key/model/AgentVersion fixture不可用，真实Provider live smoke、全量Bazel lint编译与最终发布/rollback复验尚未完成，不构成生产切流。

## 1. 已确认事实

### 产品与 Strategy

- 共同设计明确 Durable Cloud Agent 是 Task Runtime 首批消费者；`StrategyKind::Single` 表示需要持久恢复的 Durable Single Task。
- 当前 Task Runtime 只有 exhaustive `Single | Office`，没有 CloudAgent variant，也没有动态 Strategy Registry；W3-01 不新增。
- 普通本地单聊仍走 Core Thread/Turn；只有 Thread execution binding 为 Agent 的专用 Cloud Agent Thread 进入 Task Runtime。

### 旧生产链 inventory

- 历史inventory为5个`agentPlatform/*`执行request、4个chat notification、SSE/in-memory run/local session write、UI Promise/orphan/fake Turn和raw agentId/thread source authority；E-03至E-05已原子删除这些执行调用点。
- `agent_platform_processor`现在只保留`agentPlatform/auth`和`agentPlatform/agent/info`，用于账号登录与resource-management metadata；它不启动Provider Run、不写会话、不投影Turn。
- 一次性legacy importer仍可只读server-owned `agent-platform-sessions`固定目录，用于E-01迁移；生产新链没有写入、清理或恢复旧session的API。
- `scripts/verify-w3-01-cloud-agent-cutover.sh`取代旧44调用点静态数字，直接扫描当前production source/generated schema并执行allowlist检查。

### 新链已具备的底座

- Task State/Runtime、CloudWorker、Provider supervisor、Provider v3 Durable Run、Workspace/Identity/Credential/Resource/Artifact/Audit/Governed Context、Thread Execution Context 均已有 scoped/Harness evidence。
- W2-08 hermetic vertical 已证明真实 request processors + temporary State + production RS256 Provider client + Fake Provider 的 connect/read/list/bind -> Thread authority -> dynamic result 链。
- `CREWON_PROVIDER_CONTROL_ENABLED` 与独立 `CREWON_DURABLE_CLOUD_AGENT_ENABLED` 均默认关闭；后者只有在 Provider Control runtime 已准备时才允许启用，不复用或绕过 Provider Gate。

## 2. Discovery 中发现的 blocker

| Blocker | 当前证据 | 必须完成的 Gate |
| --- | --- | --- |
| 无 Cloud Agent consumer bridge | 标准`turn/start`、Single Authority、Provider supervisor、durable projector、notification/read/resume/cancel/capability已连通，独立Gate默认关闭 | Wave E UI唯一链路与旧链原子删除、完整E2E完成后才允许启用 |
| execution target 隐式 | exact `executionBinding` 只接受 active ProviderManaged/Provider Agent；首个 durable Task/Turn 后由数据库事实锁定 | 已完成；后续每次 Provider I/O仍须重验 authority |
| Provider result refs 丢失 | completed exact refs已进入payload-bound durable projection，并投影为verified标准Item/read | 已完成 |
| journal 不绑定完整 payload | canonical payload digest已绑定event hash、duplicate和projector cursor | 已完成 |
| Rust 无 Run Artifact transfer | typed context import与`/artifacts:read`、逐次authority重验及verified local importer已接Worker/projector | 已完成；hermetic纵向已验证Provider在`runs:start`前接收context Artifact |
| 无 restart-safe chat projection | CloudAgentTurn status/cursor/final output已durable；standard notification/read/list/resume均由该事实恢复 | 已完成；UI切流仍属Wave E |
| Thread list/sidebar仍依赖 Core rollout | summary revision与ThreadStore preview/updatedAt同事务同步；list/search前bounded补偿；Cloud Thread读与排序不再被stale rollout覆盖 | 已完成；UI唯一链路仍属Wave E |
| known failure无消费者决定 | Cloud Agent Single Authority确定性`FailTask`，标准projection返回safe TurnError；unknown只reconcile；queued cancel直接从Task terminal投影 | 已完成；unknown/gap不会被错误终结 |
| Core rollout跨存储去重不可原子 | Core record API为 crate-private，SQLite/JSONL无共同事务 | Cloud Agent专用 State projection，不混写 Core Turn |

这些 blocker 是 W3-01 的实现内容，不允许用 UI local state、额外 one-shot call 或“先完成后补 Artifact”规避。

## 3. 目标 Harness 矩阵

| 场景 | 预期 |
| --- | --- |
| duplicate `turn/start` | 同 clientUserMessageId 返回同 turnId/taskId，无第二 Provider start |
| concurrent start same Thread | 只有一个 active Turn，另一个稳定 conflict/busy |
| app-server crash after Task atomic create | 重启从 outbox启动同 Task |
| crash after Provider start before journal advance | read/listEvents恢复，不重发 semantic start |
| duplicate Provider event | 同 payload ExistingSame，不重复 Task event/Turn item |
| same metadata, changed payload | conflict/invalid response，不能覆盖 output refs |
| cursor gap/out-of-order | stop/reconcile，不能跳过 |
| completed output artifact | exact read/header/digest/body验证后 local commit，才完成 Turn |
| artifact read/import crash | Turn保持 finalizing，重启继续，最终一次完成 |
| artifact permanently missing/corrupt | bounded retry后 Turn failed(resultUnavailable)，Task completed事实保留 |
| disconnect before notification | reconnect/thread read返回 durable结果 |
| sidebar/list after restart | preview/updatedAt/排序与最后 Cloud Turn一致，不显示空会话 |
| cancel repeated | 一个 Authority CancelTask/Provider cancel identity |
| known failed | Task由消费者显式 fail，无自动 retry |
| unknown outcome | reconcile原 Run，无新 Task/Run |
| credential/grant/resource revoke | 下一 I/O fail-closed，不复用旧 authorization |
| cross-owner/thread/workspace | unauthorized，无 metadata泄露 |
| progress | 仅 status/typing，无聊天系统气泡 |
| legacy import crash | digest journal可重跑，不重复 turns |
| old API scan | production source 0 callpoints，failure 0 fallback |

## 4. Release Gate

### Gate A：Provider result durability

- [x] typed event projection record/migration、canonical bounds、task binding、Debug redaction Green。
- [x] journal advance 与 projection 同事务提交；legacy `NULL/NULL` compatibility 与 partial-row rejection Green。
- [x] payload-bound idempotency/conflict Green。
- [x] bounded event projection read/recovery API 与 restart exact payload replay Green。
- [x] context Artifact idempotent import 与 `/artifacts:read` typed contract、64 KiB/digest/media/UTF-8/time/security Green。
- [x] local Artifact import idempotency、restart recovery、Task/Turn/Agent/Trace Audit correlation与retention Green。

### Gate B：Thread/Turn authority

- [x] exact Agent execution binding与 owner/workspace/revision/revoke Green。
- [x] 已有 Core history不能附加 Cloud Agent；Cloud-bound Thread不能误走本地 Core Turn route。
- [x] 首个 durable Cloud Task后换 Agent被拒绝；以原子 CloudAgentTurn/Task mapping和数据库外键为事实来源。
- [x] atomic queued Task/accepted event/outbox/spec/turn mapping late-failure rollback Harness Green。
- [x] prompt/context immutable Artifact、GovernedContext预算/audience、body redaction与不读取旧 session/raw Provider body Green；生产路由当前不派生历史 fragment。
- [x] 第一切片仅接受一个 plain text input；Skill/MCP/Knowledge/附件/图片与所有 per-turn override被稳定拒绝，不发生隐式跨服务导出。

### Gate C：Recovery projection

- [x] success/progress/finalizing/known-failure子状态机、cursor gap stop与Artifact crash recovery Green。
- [x] success/progress/finalizing/failure/cancel可见状态收口Green；unknown outcome保持同一Run reconciling，gap停止且不推进cursor，两者不伪造terminal。
- [x] notification丢失与app-server/State重启后可由standard read/list/resume恢复，不依赖连接内存。
- [x] hermetic Provider重新连接先返回503、随后以同一providerRunId和cursor继续并完成；真实Provider进程重启仍归F-04 live smoke。
- [x] standard thread/read/Turn/Item只有一个durable结果，无Cloud fake/local-only state。
- [x] `thread/turns/list`与resume initial page在重启后一致。
- [x] thread list/search/sidebar summary在重启后一致。
- [x] backend对Cloud execution binding下steer/inject/compact/fork明确拒绝，且在既有Thread解析之后执行以保持Core错误兼容。
- [x] UI标准链路与snapshot已隐藏Cloud Thread不支持的mutation action，backend同时fail-closed。
- [x] unsupported approval/tool-result先持久化exact event/cursor再进入suspended stop，supervision不再返回该run，无无限轮询/退避。

### Gate D：Atomic cutover

- [x] legacy importer bounded/symlink-safe/idempotent。
- [x] UI standard path、E-06 snapshots、统一lint与production build Green；四个测试夹具误写experimental `ConfigRequirements`字段的问题已按标准v2类型最小修复。
- [x] old protocol/processor/session/Promise/fake Turn/raw agentId authority删除。
- [x] marketplace/catalog/login/Agent metadata等保留能力与执行链解耦；raw目录ID只作为display/navigation identity。
- [x] no dual-write/no fallback scan Green。
- [x] fence compatibility代码与Harness Green，且本版本不能创建保留source；archive/unarchive也因State-only Cloud Turn不可安全恢复而fail-closed。
- [x] fence binary artifact已隔离部署并完成同SHA read-only rollback演练；cutover rollback只指向该artifact。

### Gate E：Repository 与 live

- [x] State、Provider adapter、app-server protocol、app-server、相关 Core、UI scoped tests Green。
- [x] schema/dependency/breaking/security/context/change-size review Green。
- [ ] Bazel hermetic argument-comment入口编译 Green；当前由Apple SDK 26.4固定下载URL 403外部阻断，source wrapper同规则已Green。
- [ ] Wave 2 full workspace `just test` 经用户授权 Green。
- [x] W3-01 hermetic vertical Green。
- [ ] 真实测试 key/model smoke + app-server/Provider restart Green。
- [x] pre-cutover binary artifact部署与read-only fence rollback演练 Green；最终cutover bundle前仍需复核相同SHA artifact可取用。
- [x] scoped fix 后 final fmt；按规则未在fix/fmt后重跑测试。

## 5. 当前未授权/未验证边界

1. 完整 workspace `just test` 尚未获得用户授权；因此 Wave 2 release Gate仍 Red，W3-01 production cutover不得开始。
2. 真实部署 key、测试模型和 Agent binding尚未做 live smoke；不能把 Fake Provider结果当真实产品证据。2026-07-25 对当前本地栈做了只读审计：5175、8000、8010、8011均在监听，8000工作目录为`agent-platform/backend`且`/api/v1/health`为200，但`/provider/v3/openapi.json`和`/identity/v1/openapi.json`均为404；进程未注入对应production变量。本地SQLite中active agents为11、api-enabled agents为1，但active AgentVersion、verified personal model key、active NewAPI binding均为0，无法形成真实可发现且可执行的Provider Agent。
3. Provider Agent已按设计进入 execution target selector，未进入 `+` palette或 composer tag；首次选择会创建新authority Thread，已绑定Thread才允许继续发送。Cloud completed snapshot和全量UI tests Green；本机浏览器已验证断开App Server时不展示假Provider Agent/假办公室，办公室页面无“运行台”“执行流程”“后端记录”残留。真实Provider Agent发送和live final交互仍归F-04。
4. `ProviderRunArtifactClient`、context pre-start import、local output importer、CloudAgentTurn prompt/context materializer、projector finalizing/completed/cancelled、标准Thread notification/read/list/resume/interrupt及sidebar metadata已通过hermetic纵向与异常矩阵验证；旧backend执行链已删除。真实Provider key/model与live restart仍未验证，因此不能把hermetic结果当生产live证据。
5. F-01后的首次`just test -p crewon-app-server`执行1165项并全部通过、1项configured skip。argument-comment机械修复后的复验为1163 passed、2个Unix强制关停用例在高并发两轮超时；两项随后分别以`--retries 0`独立运行均Green。另有personal schedule、Office auto-dispatch、in-process session-source和model verification四项在包级运行首轮波动、第二轮通过。Cloud Agent纵向两项均首轮Green。Provider adapter 64/64、protocol 248/248、Artifact 10/10、State 234/234、ThreadStore 81/81 Green。完整workspace Gate仍未获得用户授权。
6. F-02复验UI完整`pnpm test`为222 files/1269 tests Green，`pnpm lint`与`pnpm build` Green；新增Cloud final-result与办公室恢复态snapshot已审阅。四个settings测试夹具曾把experimental `allowedApprovalsReviewers/hooks/network`写入标准`ConfigRequirements`，现已移除，未改变production逻辑。
7. E-02b只验证本地隔离binary artifact、真实WebSocket transport与同SHA重启rollback；没有部署远端container，也没有真实Provider key/model，因此不改变production/live Gate为Red的结论。
8. `just bazel-lock-update`与`just bazel-lock-check` Green；Bazel分析发现并修复policy fixture重复`compile_data`，并为`crewon-login`、`crewon-otel`、`crewon-protocol`、`crewon-tools`增加兼容alias以同时保留旧target并满足Cargo依赖映射。全仓及app-server scoped argument-comment Bazel编译仍在下载hermetic Apple macOS SDK 26.4时收到固定URL 403；2026-07-25再次执行`just bazel-argument-comment-lint`，分析到588 targets后仍由同一Apple URL返回403，确认不是瞬时本地编译失败。本机只有SDK 26.0，因此未用本机路径破坏可复现性。改走仓库官方source wrapper，按CI固定安装`cargo-dylint/dylint-link 5.0.0`，并因pinned nightly 1.92早于`sqlx 0.9`声明的Rust 1.94使用Cargo `--ignore-rust-version`实测；依赖和app-server全部实际编译成功。首次发现49个文件290项参数注释错误，machine-applicable fix后`crewon-app-server --all-targets`严格lint exit 0。Bazel入口本身仍保持未验证。

## 6. 本切片实现与证据

| 项目 | 证据 | 结论 |
| --- | --- | --- |
| State projection record | 八类 Provider event 的 strict typed canonical JSON；16 KiB record、32 output refs、字段 bounds、task exact binding、SHA-256、unknown field拒绝、Debug redaction | Green |
| Migration/atomicity | `0049_provider_run_event_projection.sql`；payload/projection同事务随 journal cursor推进；partial pair trigger拒绝 | Green |
| Idempotency | event canonical hash v2包含 payload digest；同 metadata/不同 payload返回 Conflict；legacy NULL projection不会被静默判定 Duplicate | Green |
| CloudWorker mapping | current Provider payload exhaustive mapping；未来 non-exhaustive variant fail-closed `Unsupported`；completed exact output refs不再丢失 | Green |
| Event recovery page | 以 local journal key查询同一 SQLite snapshot；limit 1..100；sequence连续、journal tail、event hash、payload digest和typed projection重验；restart exact replay | Green |
| Provider Artifact transfer | import复用 exact Run Start authority；read复用 exact Run Read authority；task/ref/header/media/UTF-8/SHA-256/64 KiB/expiry窗口验证；body Debug redacted；unknown outcome不重试 | Green |
| Local output import | verified content携带 exact read authority；稳定source/import identity；local Artifact creation Audit绑定Task/Run/Attempt，metadata-only association Audit绑定Thread/Turn；两者绑定exact Agent/Trace；durable observedAt允许30秒时钟偏差，Provider task/session retention按v3固定7日窗口导入，restart重复为ExistingSame，正文不进metadata/error | Green |
| Unsupported input stop | approvalRequired -> ApprovalRequired suspension；toolResultRequired和无本地提交authority的toolResultAccepted -> ProviderPaused suspension；Task fact先提交、journal typed projection/cursor随后推进，页内后续事件不越过stop；due supervision排除suspended status | Green |
| Execution binding State | optional exact binding必须属于排序后的resource set；active exact revision、owner/workspace、Agent kind、ProviderManaged mode和Provider execution location逐次重验；v1/v2 hash domain兼容；migration FK/cascade与restart恢复 | Green |
| Execution binding protocol | v2 update只接收server-owned `executionBindingId`，response投影exact id/revision；stable/experimental schema已生成且schema fixtures一致 | Green |
| Mixed history/binding guard | 已有真实 Core Turn history拒绝附加Cloud Agent；Cloud-bound Thread只在独立Gate开启时走durable coordinator，关闭或失败均不回退Core；首Cloud Task后exact binding不可替换 | Green |
| UI authority preparation | Provider Agent位于execution target selector；选择后bind exact ResourceRef并提交binding id；Agent不进入`+` palette/tag，`provider-agent:*`不映射raw agent id | Green；发送链未切换 |
| CloudAgentTurn durable model | `0051_cloud_agent_turns.sql`；DurableTask/LegacyImport显式origin；client identity、Task和单Thread active Turn唯一约束；bounded outputs/status/hash/Debug redaction | Green |
| Atomic create与binding lock | queued Task genesis、accepted event/outbox、immutable ExecutionSpec、Turn和summary同一`BEGIN IMMEDIATE`事务；late Turn insert失败全部回滚；首Turn外键锁定exact binding | Green |
| TOCTOU authority fence | atomic create事务内再次重验Thread context、exact Resource Binding、connection、active unexpired Grant及匹配source revision的fresh identity；revoke后duplicate不返回旧成功 | Green |
| Prompt/context Artifact | prompt和GovernedContext fragments以每client/role稳定identity提交verified WorkspaceSensitive Artifact，内容变化形成Conflict而非无界新Artifact；同client replay复用原createdAt；invalid prompt/cross-audience不产生Artifact | Green；历史retrieval和Provider pre-start upload尚未接 |
| Standard start coordinator | 标准`turn/start`在exact Agent binding下创建真实`StrategyKind::Single` Task；deterministic ids；same replay恢复同Turn/Task，changed replay conflict，同Thread并发busy | Green；只创建，不负责Wave D结果投影 |
| Capability/Gate | 一个非空plain text且无override；其余输入fail-closed；Cloud flag默认关闭且要求Provider Control runtime；无binding仍走Core，Cloud错误不fallback | Green |
| Single consumer Authority | CloudAgentTurn join限定消费者；enqueue创建一次7日bounded lease/fenced claim与dispatch；stable command receipt支持commit后/source-delivery前restart；known failed/cancelled只FailTask且不ScheduleRetry；unknown仍reconcile；Office Task不被消费 | Green |
| Durable Turn projector | `0052_cloud_agent_turn_projection.sql`保存exact completed event correlation、bounded attempts/availableAt和terminal audit；projector按journal contiguous sequence推进Turn cursor，gap/corrupt projection停住；known failure等待Single Authority先终结Task，避免旧Task未终结就释放Thread | Green；不产生客户端气泡或内存Promise |
| Output finalizing | completed先原子进入`finalizing`，每个Artifact read前重验current binding/connection/grant/identity，exact ref/header/digest/body验证后幂等导入local Artifact；只有一个text Report/File可成为primary，全部提交后Turn与refs同事务完成；永久失败/五次transient失败转`resultUnavailable`，不返回空completed | Green |
| Projector recovery Harness | 连续runStarted/progress/completed、restart duplicate、local import commit后故障、永久结果缺失、known failure authority ordering、durable cursor gap；queued Task cancellation无Provider journal仍可投影且restart exactly-once | Green；unknown/gap保留非terminal事实，不发明结果 |
| Standard notification | deterministic `{turnId}:user`/`{turnId}:assistant`；只发送标准Turn/Item/status；progress无系统气泡；terminal queue只传metadata，每个连接fresh identity重验owner与exact revision | Green；queued cancel durable commit后发送一次metadata notice，queue丢失由durable read恢复 |
| Standard read/list/resume | State page limit 1..100与stable anchor；full read最多512 Turns；Artifact最多64 KiB且重验available/Manifest authority/media/byteLen/SHA-256；cold/running resume均替换Core history projection | Green |
| Summary metadata atomicity | pending summary按`(updatedAt, threadId)`稳定分页且单次最多100；exact Turn/Artifact生成1024-byte bounded preview；summary revision CAS、Thread preview/updatedAt与sync ack同一`BEGIN IMMEDIATE`事务；较旧Cloud event只更新preview不倒退updatedAt；缺失Thread metadata整笔回滚 | Green |
| ThreadStore query authority | Cloud summary存在时list统一使用已backfill的SQLite索引形成单一cursor序；search在分页前合并SQLite title/preview与rollout content、按Thread去重并保留metadata时间；read/read-by-path保留Cloud-owned preview/updatedAt；name/git等非移动metadata所有权不变；Cloud第一切片archive/unarchive/delete fail-closed | Green |
| Summary recovery Harness | queued prompt、completed verified output、restart pending recovery、CAS stale/idempotent、stale rollout reconcile、Core preview/touch guard、normal list ordering、metadata-only search与content/metadata dedupe | Green |
| Standard interrupt Authority | exact Cloud Turn/Task/owner/workspace/binding重验；stable command/event/outbox；Authority先提交CancelTask；重复/并发/restart复用Inbox；completion race为terminal no-op；revoke后owner仍可本地取消；cross-owner拒绝；Cloud错误不fallback；空turnId与非Cloud继续Core | Green；queued cancel由Task terminal投影标准cancelled Turn并发送一次metadata notice |
| Superseded outbox fence | queued cancel无claim；claim commit/source ack之间取消仍按receipt确认source；terminal Task跳过旧dispatch/reconcile外部副作用；只有Cancelled Task的当前cancelAttempt继续Provider交付 | Green |
| Cloud Thread unsupported operations | fork在解析真实source Thread后校验；compact/inject/steer在既有load/参数边界后、任何Core mutation前校验exact execution binding；Cloud fail-closed，no-binding Core通过 | Green；非法Core thread id仍保留既有error code/message优先级 |
| Legacy importer | `0053` pending/completed journal；固定root与derived filename；canonical/direct-child/symlink/inode guards；1000 files/1MB/20 messages/10k chars/10k tokens；stable UserManaged Artifact/Audit/Trace；atomic Turn batch与capacity fence | Green；State restart/late-failure 2/2，source/importer 3/3；尾部孤立user为明确failed，乱序不伪造 |
| Rollback source fence | 保留source `crewon_cloud_agent_provider_binding_v1`；本版本拒绝start/fork创建；已存在source拒绝内容/执行/binding/delete/archive/unarchive mutation，list/read/name等非移动metadata保留 | 代码Harness 2/2 Green；artifact SHA `3c4d3028d8a8aebc072baa3b4d9e7adac4b82765b70ebe4a4a434b84e5d71cc9`经真实WebSocket部署与同SHA二次启动rollback Green；普通Thread create/delete对照Green |
| Fence artifact Harness | `scripts/verify-w3-01-fence-artifact.py`使用临时canonical `CREWON_HOME`、随机loopback端口、server-owned State/rollout夹具与无Provider Secret环境；验证creation fence、read/list/name、五类mutation和普通Thread对照 | Green；不污染真实`.crewon`会话，不访问Provider，不把临时Thread/正文写入仓库 |
| E-03 UI standard actions | Provider Agent首次发送创建exact binding Thread；后续统一`turn/start`/`thread/read`/`turn/interrupt`；production scan无旧chat/session/run Promise/orphan/fake Turn调用点 | Green；本机浏览器已验证断线时fail-closed且无假数据 |
| E-04 backend deletion | 删除5个旧RPC、4个notification、SSE/Run/session模块、中心dispatch与generated schema；auth/Agent metadata独立保留；legacy importer改用私有migration wire struct | Green；这是协调发布的breaking API删除，不提供会执行旧链的compatibility handler |
| E-05 authority deletion | 删除`agentPlatformAgentId`、raw thread source helper、Platform direct picker与自动配置同步；云执行只认`provider-agent:*` + exact Resource Binding；raw目录ID仅资源卡片展示 | Green；云目录手动保存不携带raw remote agentId，不能形成隐式远端执行authority |
| E-06 UI snapshot | `CommandThreadRoom` Cloud completed fixture显示共享主页transcript/composer语义和普通user/agent message；无old RPC、runId或系统执行气泡；英文header使用locale label | Green；snapshot已直接审阅 |
| E-07 dependency scan | `scripts/verify-w3-01-cloud-agent-cutover.sh`扫描old RPC/types/UI authority/Promise/fallback、模块存在性、raw marker和legacy session allowlist，并确认Provider Resource Binding调用点 | Green |
| F-01 hermetic vertical | 真实WebSocket app-server、temporary State、RS256 Principal Session/Provider signing、Fake identity source/Fake Provider；标准workspace/provider/resource/thread/binding/turn RPC；duplicate start只创建一次Run；断线与app-server restart后同providerRunId续读；Provider fresh connect先503再恢复；最终一个verified Agent message；重复interrupt只产生一次Provider cancel | Green；请求body不含Principal token或private key；progress/系统执行文本不进入聊天气泡 |
| F-01异常矩阵 | CloudWorker 13/13、cancel coordinator 5/5、Turn projector 6/6、execution resolver 4/4、grant authority 2/2、Provider event 5/5、Run client 4/4、Artifact 3/3 | Green；覆盖duplicate event/replay、unauthorized/cross-owner、credential revoke、cursor gap、known failure、unknown outcome、cancel race与Artifact digest corruption |
| F-04 live readiness | 真实本地进程/端口/health只读审计；8000为Agent Platform backend，Permission/Billing分别为8010/8011；Provider/Identity mount均404；数据库无active AgentVersion、verified personal key或active NewAPI binding | Readiness Red；必须用隔离测试key/model/AgentVersion与production composition启动，不改日常8000数据、不以local model stub替代真实模型证据 |
| Scoped tests | `crewon-artifact` 10/10；`crewon-state` 234/234；`crewon-thread-store` 81/81；Provider adapter 64/64；app-server protocol 248/248；app-server首次1165/1165；参数注释修复后包级1163通过、2个Unix强制关停时序项独立无重试Green；UI 222 files/1269 tests、lint与production build | Scoped Rust/UI/schema Green；包级并发时序波动已隔离记录；完整workspace/live Gate仍 Red |
| UI live visual | localhost真实React页面；App Server断开时自动恢复卡片不使用演示数据；“运行台”“执行流程”“后端记录”计数均为0；“任务协作”与群聊`@`语义可见；不可用执行目标保持disabled | Green；真实Provider Agent发送仍归F-04 |
| Bazel与lint | schema重新生成且protocol fixture 248/248；Bazel lock update/check；cutover scan；`git diff --check`；兼容alias query；source argument-comment lint覆盖app-server all-targets并从290项修复到0 | Partial；lint规则Green，但Apple SDK固定下载URL返回403，Bazel入口编译未完成 |
| Scoped finish | `just fix -p crewon-app-server-protocol`、`just fix -p crewon-app-server`、`just fix -p crewon-app-server-client`与最终`just fmt` | Green；Office predicate、Projector测试辅助实现和新E2E Harness的lint提示均已修复，最终app-server scoped fix无warning退出0；按仓库规则fmt后未重跑测试 |
| Size review | CloudAgentTurn State事务482 LoC，authority重验76 LoC；Artifact materializer321 LoC；app-server coordinator当前504 LoC；workspace authority模块507 LoC；replay fence52 LoC；Single Authority约470 LoC；cancel coordinator约335 LoC、独立Harness约345 LoC；D-07 cancellation projection160 LoC + Harness205 LoC；legacy State runtime422 LoC + record186 LoC；legacy source250 LoC + importer368 LoC + Artifact materializer149 LoC；source fence49 LoC；Thread execution runtime419 LoC；Turn projector484 LoC；State page runtime92 LoC + record59 LoC；Thread projector462 LoC + Artifact projector147 LoC；summary runtime196 LoC + record87 LoC；Thread search merge328 LoC；metadata projector175 LoC + message-processor sync29 LoC；platform dispatch约435 LoC + validation约130 LoC + notification188 LoC；未向core堆业务逻辑 | Green；两个504/507 LoC模块只略高于约500目标且分别保持一个原子协调/Workspace authority内聚边界，人工抽出数行会降低可读性；均远低于800硬拆分线，中心processor只保留窄guard调用 |

## 6.1 F-02 final review audit（2026-07-25）

- **Model-visible context**：`GovernedContextFragment`实现`ContextualUserFragment`；单fragment硬上限900 tokens、单bundle硬上限4000 tokens、最多8片、Memory最多6片，Secret sensitivity拒绝进入模型。Cloud Turn持久化immutable Artifact，不重写既有history，也不把Provider body或credential注入Context。
- **Breaking surfaces**：没有修改CLI参数或`ConfigToml`；新增production能力全部使用独立环境变量且默认`false`。`thread/start`/resume/fork新增execution context字段均标记experimental并从stable request/response schema过滤。旧`agentPlatform/chat|session|run/cancel`是计划内原子删除，UI与app-server-client同版本删除；rollback只允许识别保留source的read-only fence artifact，不存在旧执行fallback。
- **Security**：Provider endpoint执行scheme、DNS全地址分类、metadata/loopback、same-origin redirect和DNS pinning检查；production只接受public HTTPS，loopback HTTP仅限显式development模式。私钥文件必须绝对路径、regular file、非symlink、打开前后同inode，Unix private文件拒绝group/other权限；key/token/identity/正文Debug均脱敏或不实现Debug，授权每次Provider I/O重新签发并重验。
- **Test coverage**：Agent逻辑变化由真实WebSocket integration Harness覆盖；Task/Run/Artifact/identity/cancel/restart/gap/corruption由独立sibling test文件覆盖。UI标准Thread/Turn路径、Provider picker、断线恢复和无fake数据均有snapshot/behavior tests；没有把产品行为只留给unit helper。
- **Change size**：非机械实现按A-F与review unit拆分；生产高复杂模块约500 LoC，生成schema和测试fixture不计入单个逻辑单元。当前工作树仍不应一次性作为一个不可审大提交落地，应按文档中的review staging顺序提交。
- **Static verdict**：`verify-w3-01-cloud-agent-cutover.sh`全部Green；old RPC/type/UI authority、legacy writer、Cloud failure fallback为0。当前没有新增P0/P1/P2 finding；剩余Gate是Bazel外部下载、授权后的full workspace test和真实Provider fixture/live smoke。

### Review staging

| Review unit | 内容 | 依赖与边界 |
| --- | --- | --- |
| A-02B | State event page record/runtime/restart Harness | 可独立先落；不依赖 Provider HTTP client |
| A-04 import | context request model、PUT headers/path、idempotency/unknown outcome Harness | 依赖既有 Run authority；不接 CloudWorker start |
| A-04 read | exact ArtifactRef POST、response header/body/digest验证 Harness | 依赖共同 Artifact model；不接 local importer/projector |
| A-04 read authority hardening | verified content同时绑定exact Agent/task read authority，防止跨Agent内容混配 | additive internal domain hardening；不改wire |
| A-05a | verified local Artifact commit + Task creation Audit + Turn association Audit | coordinator/identity生产实现约542 LoC；不接projector，不切Thread/Turn生产链 |
| A-05b | restart/idempotency/cross-task/expiry/conflict/redaction Harness | 281 LoC；必须与A-05a同一合并批次进入主线，但独立review以保持单元低于800行 |
| A-06 | approval/tool-result exact projection、Task suspension、page stop与supervision exclusion | 不新增approval/tool执行能力；不修改公开API或Provider wire |
| B-01 | State record/runtime/migration/restart Harness | 独立 durable authority；不接Cloud Turn consumer |
| B-02/B-03 | v2 protocol/schema、adapter/runtime与生命周期fail-closed guards | 中心processor只做窄调用；Cloud fork/interrupt/steer语义不在本单元伪实现 |
| B-05 | UI Provider Agent target + exact binding preparation + snapshot | 不改`+` palette，不切send/history/cancel |
| C-01/C-03 | `0051` model + State atomic Task/spec/Turn bundle + restart/rollback Harness | durable事实与authority重验；不做UI投影 |
| C-02 | prompt/context Artifact materializer + audience/idempotency Harness | 不读取旧session，不接Provider upload |
| C-04/C-05 | private coordinator + standard `turn/start`窄路由 + default-off Gate | 不新增公开Task API，不做read/cancel/final notifications |
| C-06 | Cloud Agent authority outbox filter + deterministic claim/fail consumer + restart Harness | 不消费Office/Workflow；不决定retry；不做Turn投影 |
| D-01 | typed projection decode + bounded candidate/event cursor + restart/gap Harness | 只消费durable journal projection；不发notification，不读Provider raw event |
| D-02a | durable finalization State/migration + CAS transitions | Task completed事实、Turn finalizing/completed/resultUnavailable与Artifact refs原子收口 |
| D-02b | per-I/O authority reader + verified importer composition + crash Harness | 不缓存authorization，不返回empty completed；生产Gate继续关闭 |
| D-03 | metadata-only terminal notice + per-connection authorization + standard lifecycle | 不持久化通知、不广播未授权正文；durable projection是恢复事实 |
| D-04a | bounded State Turn page + stable cursor/restart Harness | 独立read primitive；不修改ThreadStore/sidebar metadata |
| D-04b | standard thread projector + verified Artifact reader + read/list/resume窄接线 | Core Thread保持原路径；Cloud path不合并双历史、不重放Core token usage |
| D-05a | bounded summary candidate/CAS + Thread metadata atomic commit/restart Harness | 只拥有preview/updatedAt；name/archive/git等仍由ThreadStore原API拥有 |
| D-05b | Local ThreadStore read/list/search authority与merge pagination Harness | Cloud存在时list使用SQLite单一总序；search在分页前双源合并；JSONL只保留history replay职责 |
| D-05c | `turn/start`/terminal best-effort sync + `thread/list`/`thread/search` strict bounded ensure | best-effort失败不伪造成功；查询前无法补齐则返回unavailable，不返回stale page |
| D-06 | stable CancelTask coordinator + standard `turn/interrupt`窄路由 + terminal supersession fence | Authority先落账；重复/并发/restart和terminal race幂等；Provider cancel沿既有Outbox/CloudWorker；Core path不变；不提前实现D-07 |
| D-07a | Task-cancelled fact -> Turn cancelled + summary CAS projection/restart Harness | 无Provider journal也可收敛；exact Task映射；不改变unknown/gap语义 |
| D-07b | Cloud execution binding fork/compact/inject/steer capability guard | 既有Thread解析后、Core mutation前校验；无binding Core错误与行为兼容 |
| E-01a | `0053` journal + atomic LegacyImport Turn batch + restart/late-failure Harness | 不读文件、不接UI；冻结时间与digest，防止半批历史 |
| E-01b | fixed-root source reader + UserManaged Artifact materializer + crash/restart Harness | 不接受任意path；不创建Task；不自动注入模型上下文 |
| E-02a | reserved Thread source compatibility fence | 只识别/拒绝，不创建source；archive/unarchive随文件移动一并fail-closed |
| E-02b | immutable fence binary artifact + isolated WebSocket rollback Harness | SHA固定；普通Thread对照；不访问真实Provider或用户会话 |

当前工作树包含上述连续开发单元，但 review/land 不应打成一个超过 800 行的非机械提交。

## 7. 当前结论

W3-01 Wave A已完成Provider结果持久恢复底座；Wave B已完成Thread exact Agent authority与binding锁定；Wave C已完成CloudAgentTurn/Task/ExecutionSpec原子事实、immutable prompt/context Artifact、标准`turn/start`私有协调路由、串行化、capability/default-off Gate，以及Cloud Agent专属Single Authority。Wave D的D-01至D-07已完成bounded durable projector、verified output finalizing、标准notification、connection-independent read/list/resume、restart-safe sidebar同步、Authority-first取消与Cloud capability fail-closed。Wave E的E-01至E-07已完成bounded importer、rollback fence artifact、UI标准链路、旧backend协议/processor/session删除、raw authority删除、Cloud final-result snapshot和repository cutover scan；不存在双写、旧执行fallback或浏览器token作为执行authority。

下一安全开发Gate是F-03与F-04：Bazel入口已再次确认受Apple SDK固定下载URL 403外部阻断，source lint本身Green；需要取得用户授权运行full workspace `just test`，并提供或隔离配置真实测试Provider key/model/active AgentVersion后执行live restart smoke。日常8000服务不会为测试被污染，两个production Gate在F-02至F-05完成前继续默认关闭。
