# F04 详细设计与 C04 兼容契约

## 源码事实

- `packages/domain/src/automation.ts`：v0、不可变 revision=1、严格字段验证、9,999 字节 instruction；固定 AgentVersion。
- `packages/application/src/automation-application-service.ts`：保存和运行授权、路由解析、服务端 instruction、原子 invocation 和 receipt；同 key 重放先于可变 thread 校验。
- `packages/store/src/automation-store-validation-common.ts`：Store 从 definition 重算 instruction 并校验摘要；不可放宽为信任客户端文字。
- `apps/control-api/src/automation-scheduler.ts`：跨租户有界分页；每 occurrence 稳定 idempotency key；latest occurrence 补执行；调用原 application service。保留可靠性维护逻辑。
- `packages/contracts/src/control-api-contract.ts` 及 `packages/contracts/openapi/`：公开请求严格解析；修改须同时更新 schema、generated 和测试。
- `apps/crewon-ui/src/components/app/automationCreateDraft.ts`：现有表单 draft；`lib/skill/skillDetailActions.ts` 的本地 Skill 文件详情不提供可信激活身份，不能把这些文件视为 C02 激活版本。

## 数据与兼容方案

保留 `crewon.automation.v0` 原形、序列化和 instruction。新增 `crewon.automation.v1`（revision 仍为不可变业务 revision=1），以显式 skill binding 保存 C02 调用配置及服务端解析出的有界执行快照。新 v1 的 prompt 仅保留人类可读任务摘要；不承载 JSON 或身份权威。v0 不接受新增字段，v1 必须具有完整 binding。v0 老客户端可继续读/写 v0；旧服务拒绝 v1 而不是误跑 prompt；降级前暂停 v1 执行，不能把它转换成 v0。

C02 消费端口在 application 层，输入 actor、用途（save/execute）、固定调用配置、已解析 RunRoute；输出精确固定身份、AgentVersion 和有界 instruction，或稳定失败。端口默认缺失即 `automation_skill_unavailable`。保存由服务端生成执行快照；执行时重新解析并比较身份、指令和 AgentVersion，防止静默漂移。具体 C02/C03 字段以 owner 首轮契约为准；在确认前只写兼容与消费端测试，禁止复制 Skill 权威实现。

HTTP 在现有 create 请求中新增可区分 Skill invocation 输入，客户端没有 instruction 写入字段。projection 返回固定绑定供详情/历史显示。SQLite/Postgres definition JSON 保存完整 v1；现有 schedule 索引只依赖共有 schedule/executionMode/身份字段，不新建 scheduler 表。所有 definition 摘要包含 binding，receipt、Run origin 与 history 继续通过同一 definitionDigest 绑定。Store 必须从持久定义重新验证/渲染，不信任调用端传入的 instruction。

## 执行与授权

先执行现有 automation、thread、run 授权；首次保存/首次 invocation 调用 C02。receipt 重放保留历史结果，不重新创建 Run，也不依据现时 Skill 版本改写历史。准入失败时无 invocation 副作用；已排队后的撤权与恢复必须由 F03 的真实运行时加载准入共同覆盖，application 准入不能冒称解决所有执行时竞态。

运行结果继续回到 definition.threadId，保留现有取消、流式消息与通知。重试同一幂等 key 仅重放 receipt；取消或执行结果未知后不自动创建新的手动 key。scheduler 已有下一正常 occurrence 语义保持不变；外部效果判定由现有运行时权限与工具回执负责。

## 失败与恢复

| 失败                | 恢复动作                                         |
| ------------------- | ------------------------------------------------ |
| 端口/Skill/版本缺失 | 恢复依赖或选择可用激活版本创建新日程             |
| 未激活/撤权         | 确认激活或重新授权后重试                         |
| 摘要/执行快照变化   | 检查版本完整性，不能自动升级                     |
| 参数错误            | 按声明 schema 修正，创建新绑定                   |
| 工作空间/工具离线   | 重新连接后由既有 scheduler 补执行最新 occurrence |
| 目标不可写          | 选择已授权交付目标                               |
| 预算不足            | 调整现有预算后重试                               |
| 执行结果未知/取消   | 查看原 Run 的工具效果与结果，不能盲目重跑        |

错误 code 不包含正文、凭据或本地路径。保存失败通过现有 HTTP 错误返回；运行前状态应在原日程详情可解释。当前 scheduler 仅有全局 lastFailureCode；新增每日程状态的必要最小读接口设计须在实现前补充，不能用新轮询回路规避。

## UI 与设计输入

遵守 `.codex/skills/crewon-design-reference/SKILL.md` 和 `crewon-command-design-regression/SKILL.md`；沿用日程页和表单，固定版本摘要 + 声明参数字段 + 授权交付目标，不为本地文件详情捏造激活状态。入口消费 F03 的 activated version 数据，依赖未接通时保留明确不可用状态。现有首页结构和执行目标保持。

## 测试与自检

R01 → 既有 domain/application/contracts/store/scheduler 兼容基线；R02–R04 → C02 合约夹具 + 域和 HTTP 拒绝测试；R05–R07 → 真实 in-memory/SQLite store + scheduler/Run 取消恢复回归；R08 → 表单组件/快照和浏览器；R09 → 边界/资源限制测试及 evidence 分级。实测未完成项目不标通过。

自检：仅一条 scheduler 链；调用配置不藏 prompt；无客户端权威指令；v0 摘要不变；依赖 owner 不重造；不碰原始目录、可靠性维护或共享基线 worktree；不 push/发布/回合 main。

## S1 补充：周期日期与客户端能力协商

协调评审要求动态日期进入首版。C02 仍只接受具体标量。C04 在定义中保存固定版本快照、literal 参数以及显式 `parameterBindings`：参数名 → `runDate` / `previousWeekStart` / `previousWeekEnd`，仅 ISO 日期字符串；上一完整周按日程时区、周一至周日。无任意表达式或模型算日期。首次保存按 nextRunAt 解析校验；每次触发按 scheduler 的 occurrence 解析。内部 run command 带 scheduledFor；手动运行使用服务端 now。invocation binding 保存该时间与具体 `skillInvocation`（版本、已解析参数、工具和目标），Store 从 definition+scheduledFor 确定性解析参数/渲染 instruction，receipt 重放复用同一值。固定 SkillVersion 内容不变，日期变更不视作方法漂移。未知回执重试先查 receipt，不能重算成另一日。

新增客户端请求头 `x-crewon-automation-version: 1` 明确支持 Skill 日程。旧 list 请求仅返回 v0，在 Store 查询中先按 v0 过滤再 LIMIT，游标使用过滤后页末项；内存、SQLite、Postgres 保持相同排序和分页语义，避免中间 v1 页造成空页或丢失后续 v0。旧 get/run-now 若身份指向 v1，在执行前返回明确升级错误；旧客户端不接收新增字段，不让一条 v1 破坏整个列表。新客户端请求头获取混合列表。旧 create 原样；Skill create 必须携带支持声明。此能力头只影响表示/兼容，不能授予执行权限。

## S2 补充：每日程可恢复状态

v1 HTTP 表示增加 `skillReadiness: {state: "ready" | "blocked", code: string | null}`；它是当前执行前检查，不是一次已发生的失败 Run。list/get 在既有刷新请求内按有界页依次调用只读准入检查：重新加载绑定、授权、解析现时日期参数、解析现有 route、调用 C02 execute。准入无存储副作用，不另建 scheduler 或轮询。缺依赖/撤权/参数/目标/预算错误返回稳定 code，卡片据此展示具体恢复动作；运行仍再次准入，ready 不是持久权限票据。执行后结果和取消继续走原 Run/history；排队后撤权/未知外部结果属 runtime gate 和 F05 真实执行验收边界，不能由 readiness 冒称覆盖。

能力头必须由 ControlApiClient 经 Web BFF 允许列表透传至 Control；测试分别验证新头保留与旧客户端无头兼容。skillReadiness 为动态读模型，不参与 definitionDigest 或 sameAutomation 固定绑定比较；Run identity 和历史摘要不变。

## C05 运行时消费端口

`resolveAutomationSkillForRun({store,digester}, actor, runId)` 从已持久 Run.origin.binding 和对应 AutomationDefinition 读取并交叉校验 scope/thread/agentVersion/definitionDigest/routeDigest/instructionDigest，校验 scheduledFor 与已冻结的具体 skillInvocation，并直接返回持久的 C02 spec。返回 null 表示非Skill日程；已损坏或不可读绑定 fail closed。无新映射表，不能接受模型传来的Skill身份。此读端口只证明调用身份，F03 `ensureRunSkillAllowed` 和 C05 工具执行时仍重新验证当前撤权/授权范围。

## Skill 权威与 SQLite 提交的原子边界

F03 standalone 宿主注入真实 SkillService 和上述 Run resolver。SQLite 在新 v1 日程保存、首次 invocation 的 `BEGIN IMMEDIATE` 事务内重新检查同库 Skill 的 owner、激活/禁用状态、固定版本及摘要；校验位于任何业务写入之前。校验复用 F03 Store 的行解码器，同时检查 JSON 与索引 revision/content_digest 一致，再复用同一 `requireSqliteSkillVersion` 供直接 Skill Turn 与 Automation 使用。缺表、缺版本或摘要不一致都拒绝，不能通过可选开关、缺表推断或端口夹具降级。

已提交 receipt 在状态检查前恢复，因此事后禁用不破坏历史、不生成第二个 Run；新 Run 已提交后，实际工具动作仍必须经过 F03/C05 的逐次授权。本期生产 Skill 权威仅支持同库 SQLite。PostgreSQL 可继续读取已有定义和恢复 receipt，但新的 v1 保存/执行明确返回 `automation_skill_backend_unsupported`；memory 用例只证明协议/行为，不证明持久授权的并发保证。

## 复用与自研边界（用户新增约束评审）

| 领域             | 采用的成熟能力                                                                                                                                   | 候选与取舍                                                                                                                   | 必要 C04 适配                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 调度、幂等、恢复 | 仓库现有 AutomationScheduler、SQLite/Postgres 原子 receipt、Run/队列、日历组件                                                                   | 不引入 cron/BullMQ/第二 scheduler；日程更新和队列权威必须保持单源                                                            | scheduler 仅透传既有 occurrence；定义/Run增加固定绑定                         |
| 时区和日期       | Node 24 自带 ICU/ECMA Intl.DateTimeFormat + UTC 日历日期运算                                                                                     | 查到 dayjs 仅为传递依赖；未发现应用直接使用 luxon/date-fns/Temporal。三个有限日期规则无需增加日期引擎，避免改变现有 DST 策略 | 将已确认 occurrence 转日程本地日期，再计算周一至周日；不解析自然语言/表达式   |
| UI 与可访问交互  | React 19、既有 ModalDialog/Button、原生 input/select、仓库 CommandScheduleCalendar；现有 radix-ui 1.6.7 工具链                                   | 不另建表单/日历系统；只新增既有参数控件和值来源选择                                                                          | 固定版本和目标展示、类型保持、日期规则和错误恢复文案                          |
| Schema 与传输    | C02/C03 权威 parser/renderer；现有 OpenAPI + openapi-typescript 7.13.0、Fastify 5.11.0/AJV 8.20.0 传输工具链、既有严格 request/response 解析惯例 | zod/AJV 为传递依赖，F04不将其当未声明的直接依赖；不另造通用 schema 引擎或改变旧 v0 parser 语义                               | wire parser仅验证新增 C04结构/字节上限；声明参数/激活/权限仍由C02/C03唯一验证 |

F04 自身无新增包或 lockfile 变更；合入的 F03 `3b6900e61` 已将其权威 C02 校验改为直接依赖 Zod 4.4.3/js-yaml 4.3.0，保留原 canonical Markdown，F04 继续消费同一 API。复用包版本来自仓库锁文件；许可沿用现有 scripts/check-\*-licenses 检查，实际结果见 evidence。时区兼容验证覆盖沪/洛跨日、纽约 DST 重复小时、跨年上一完整周，以及现有 scheduler 的夏令时/离线最新 occurrence；这些证明有限规则，不承诺任意表达式或另一套时区调度算法。
