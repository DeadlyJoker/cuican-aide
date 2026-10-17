# SQLite / PostgreSQL Workflow 部署接线

当前能力位于 SQLite 的 `createStandaloneControlApi` / `createStandaloneRuntimeWorker`、PostgreSQL 的对应工厂及两端 standalone Main。可信宿主通过 `workflow` 配置显式装配既有持久调度器；默认不自动授权或启用。Control 前端 Workflow 已采用后台执行，Team 尚未迁移；production 请求级身份与策略、桌面自动配置和安装版验收仍未完成。

## Main 入口

先通过原 Release CLI 发布真实 AgentVersion/部署物并激活 Release，再把上文所述配置保存为 JSON。Control 和 Worker 均使用同一个环境变量：

```bash
export CREWON_WORKFLOW_DEPLOYMENT_CONFIG_PATH=/absolute/path/workflow.json
```

JSON 的形状与下方 `workflow` 对象一致，不包含 TypeScript 的 `satisfies`。保留各进程原有数据库、模型、身份和 Artifact 配置。该入口只接受 `CREWON_CONTROL_SECURITY_MODE=standalone`，并明确配置 `CREWON_CONTROL_DATABASE_URL` 或 SQLite 的 `CREWON_CONTROL_DB_PATH`。production 或未指定数据库时，在读取配置文件前拒绝，不默默忽略声明。SQLite 继续使用原 Release CLI 和运行时绑定，不会因填写允许列表自动创建 AgentVersion。

文件必须是当前用户拥有的私有普通文件，路径为规范绝对路径，不能使用软/硬链接；文件权限不能开放给组或其他用户，推荐 `0600`。读取使用同一文件描述符，并核对读取前后的身份、尺寸及时间元数据，最多 256 KiB，严格解码 UTF-8。这个私有文件入口目前支持 POSIX，Windows 显式配置会拒绝。两个进程各自在启动时捕获一次并冻结，不热重载；策略变更应协调重启两端。

生产模式原本使用请求级身份及外部授权，当前静态 issuer 不能代替它。后续需要按生产身份和审批授权边界接入，不通过 ambient 配置降级成 standalone。

## 客户端能力发现

`GET /api/v1/capabilities/workflow-execution-v1` 要求原有身份认证并返回 `Cache-Control: no-store`。正式 SDK 为 `getWorkflowExecutionCapability()`：

```json
{ "version": "v1", "admission": true, "snapshots": true, "humanGates": true }
```

三个标记分别表示本实例是否装配入库、快照和人工门服务。未启用执行的 PostgreSQL 实例仍可能提供快照，因此不能只看一个接口是否存在。标记不包含配置、身份或授权信息，也不证明 Worker 在线、发布就绪、请求获准或集群所有节点已升级。实际启动仍执行原鉴权、发布策略和幂等校验。

客户端按具体操作检查所需能力；查询失败或响应未知版本不能当成执行许可。请求一旦可能已被后台受理，就应按原键和回执恢复，不能切换到前端重新执行。SDK 验证响应形状、1 KiB 字节预算和取消，不自动重试或选择执行引擎。

## 定义目录与前端切换边界

`GET /api/v1/workflow-catalog` 和 SDK `listWorkflowVersionCatalog({ cursor, limit })` 提供跨 Workflow 身份的不可变版本摘要目录，不依赖隐藏 Thread 标题。默认及最大页长为 20，按 Workflow ID、版本 ID 的 UTF-8 顺序续读；复用现有版本游标，不改变原 `workflow-versions?workflowId=...` 接口。要求当前 `workflowVersion:list` 及每条版本的 read 权限；失败时不返回部分页面，响应为 `no-store`。

目录读取复用原定义表，不迁移、不注册 Thread、不认领或推进任务。Store 每页至多解码 8 MiB 定义、单份仍为 Domain 原 2 MiB 上限；先选有界身份页再读取定义，并在数据库传回前过滤字节预算。每份定义只在 Store 校验并提取摘要，Application/Control 不传递或重复解码整份定义。HTTP/SDK 响应预算为 1 MiB，只返回身份、摘要、名称、描述和创建时间。超过定义页预算时应使用更小页长读取，不能截断定义或伪造摘要。

Control 前端现已使用有界目录、根 Run 查询、后台提交、订阅恢复和审批意见；简单 prompt 与通用 JSON schema 均按冻结定义处理。旧 renderer 执行记录只读，不重发旧任务。不得为恢复新任务再增加隐藏 Thread/Message 注册表，也不能逐个扫描所有普通会话拼根任务目录。新 Workflow 子 Thread 按持久 `workflow_node_children` 归属从普通会话目录及搜索中过滤，不按标题或伪造 fork 字段判断；任务中的授权详情读取仍可用。

## 根任务查询与恢复边界

`GET /api/v1/workflow-runs` 和正式 SDK `listWorkflowRuns()` 提供当前租户、空间内的 Workflow 根 Run 摘要。必须指定 `workflowVersionId`，可选 `threadId`；默认及最大页长为 20。示例：

```typescript
const page = await client.listWorkflowRuns({
  workflowVersionId,
  threadId,
  limit: 20,
});
const next = page.nextCursor
  ? await client.listWorkflowRuns({
      workflowVersionId,
      threadId,
      limit: 20,
      cursor: page.nextCursor,
    })
  : null;
```

游标绑定版本及 Thread 筛选，按不可变的创建时间（毫秒）及 Run ID 的 UTF-8 字节顺序倒序续读，不能按更新时间跨页：旧任务晚完成不应挤到新任务之前。每次请求是独立的一致只读快照，不是整个翻页过程的长事务；重新刷新首页才能发现新任务。游标只是读取位置，不授予权限，也不是入库回执或完成证明。目录中没有某条记录不能证明提交失败；未知写入仍按原幂等键和回执恢复，不匹配最近时间或相同输入后另起任务。

查询复用原入库记录定位根身份，使用现有租户/Run 索引取公开摘要，不枚举普通 Thread/Run，不解码或返回模型、工具和完整 DAG 正文，也不认领、推进任务或安装执行表。每条摘要上限 64 KiB，HTTP/SDK 整页上限 1 MiB；超预算应缩小页长，不能截断记录。候选读取仍随该租户已入库的 Workflow 根任务数量增长，不保证任意历史规模下恒定查询耗时；当前不新增索引、迁移或目录注册表。

请求检查当前版本 read 和 Thread 范围 read 权限；指定 Thread 时还检查线程范围 Run read，返回前检查每条 Thread/Run 及当前范围权限。任一拒绝均拒绝整页，不返回部分结果。响应为 `no-store`，只包含已有公开 Run 形状与 `nextCursor`。节点、人工门及冻结输出应通过已知根 ID 的 `getWorkflowRunSnapshot()` 读取，流式进度及终态继续使用原 Run SSE。

该只读服务装配于 standalone SQLite / PostgreSQL Control；不依赖启用调度配置。未安装入库 schema 时返回空页，部分或不支持的 schema 会拒绝；不据此判断 Worker 是否在线。未装配服务的其他宿主返回 503，不静默降级到 renderer 执行；现有执行能力响应字段保持原状。SQLite 在短同步事务中捕获快照，异步授权在事务外完成，响应前再次校验捕获的身份。production 请求级身份和桌面自动策略配置仍需后续接线。

## 配置与已有运行时的关系

Control 和 Worker 使用相同的 `WorkflowDeploymentConfiguration`：

```typescript
const workflow = {
  schemaVersion: "crewon.workflow-deployment.v1",
  issuer: trustedControlActor,
  route: existingWorkerRoute,
  allowedAgentVersionIds: [
    existingWorkerRoute.agentVersionId,
    producerAgentVersionId,
    verifierAgentVersionId,
  ],
  maximumParallelNodes: 2,
  humanGates: [
    { approvalPolicyId: "review-policy", approver: trustedReviewer },
  ],
} satisfies WorkflowDeploymentConfiguration;

const control = await createPostgresControlApi({
  ...existingPostgresControlConfig,
  workflow,
});
const worker = await createPostgresRuntimeWorker({
  ...existingPostgresWorkerConfig,
  workflow,
});
```

示例中的已有配置必须已经具备真实发布的 AgentVersion、部署记录、激活 Release 和相应的运行时工厂。多 AgentVersion 的资产、部署和实际 Runtime 必须一起提供，单独填写允许列表不会安装或授权这些 Agent。这里复用现有 Run/Tool 执行引擎，不启动另一套执行运行时。

配置由宿主在首次异步操作之前校验并复制冻结，不能由请求正文或模型输出指定。Control 的 issuer 必须与真实宿主 Actor 完全相同；Worker 的租户和完整 route 必须匹配自己的执行配置。允许列表最多 65 项，包含根 Agent；节点并发为 1–4；审批策略最多 64 项，审批人属于同一租户和空间。

节点 Agent/Verifier 必须使用与根任务相同的 authority、runtimeGeneration、policySnapshot 和 workspace。资产通过现有 AgentVersion 编译器验证摘要，部署记录与资产、发布物逐项绑定。不同权限或工作区的执行不能借这份配置跨界调度。

## 新任务、恢复与审批

- 新任务校验当前激活 Release 中的根 Agent 和全部节点 Agent、实际保留部署以及已配置审批策略。新根 Run 的 issuer 在同一入库事务中再校验；失败回滚 Run、队列、输入与回执。
- PostgreSQL 校验与入库期间持有现有 Release 发布锁的共享模式，真实发布切换使用同一租户键的独占模式；SQLite 在同一 BEGIN IMMEDIATE 写事务中读取并提交，Release 激活不能插入校验后的写入窗口。
- 已入库任务按冻结 WorkflowVersion、输入和保留部署继续执行。切换默认 Release 不重写旧任务；当前宿主允许列表、执行路由及审批策略仍约束后续执行。
- 同键恢复先读取原入库回执，不重新创建任务，也不因当前默认 Release 切换而重发模型请求。只读快照与终态 SSE 仍使用现有协议。
- 审批同时绑定 Actor、principal、租户、空间、根 Run、冻结定义和策略。客户端不能指定审批人或替换输入。当前审批人改变后，旧身份不能读取或决定该门。
- 用户获准取消根任务时，停止仍可收敛已撤销执行权限的任务；不要求重新授予模型执行权限。移除调度配置会停用调度能力，已有任务应先通过仍运行的调度器完成或取消收敛。

未配置时，两种数据库的 Workflow 定义发布仍可使用，执行启动返回能力不可用；根目录为空时不安装执行表或启动调度器。SQLite 使用同一配置形状和共享纯策略，但写事务中的 Release、资产、部署及审批校验全部在原连接同步执行，不在 BEGIN IMMEDIATE 内等待 Promise。连续 Worker Main 明确持有进程生命周期，空闲或停在人工门时不会依赖 PG socket 保持存活；关闭先停止任务，再释放资源与存储。

SQLite 显式部署创建独立的 `workflow_deployment_identity` v1 表，存储数据库身份，不修改既有 Run/消息/模型历史。恢复上下文绑定该身份和配置：同库重开保持不变，同路径替换数据库生成新身份，未来版本或损坏证据拒绝启动，不覆盖修复。该身份不是用户授权。

## SQLite 显式装配

同一份受信 `workflow` 配置可传入 SQLite 工厂；复用现有发布、模型和资源配置：

```typescript
const control = createStandaloneControlApi({
  ...existingStandaloneControlConfig,
  workflow,
});
const worker = await createStandaloneRuntimeWorker({
  ...existingStandaloneWorkerConfig,
  workflow,
});
```

Main 使用同一个私有配置文件和同一个 `CREWON_CONTROL_DB_PATH`。这提供显式 standalone SQLite 执行能力，不代表桌面安装器已经自动发布/激活 Workflow Agent 或生成授权文件；不能默认把全部已激活 Agent 视为允许调度。

## 活动任务期间重新打开 Store

真实双会话测试发现，启动重复执行已经安装的触发器、约束、生成列和索引 DDL，会请求与 Worker 写入冲突的表锁并形成死锁。现在在这些 DDL 前检查 PostgreSQL catalog；健康结构不重建，缺失结构仍按原迁移安装，原本具有修复语义的触发器仍检查结构与启用状态并修复。

不改变 schema 版本、队列语义或已有数据，也不跳过旧版本迁移。回归在另一连接持有活动表的 ROW EXCLUSIVE 锁时重新打开 Store，要求无 DDL 锁等待；另验证健康触发器 OID 不变、被禁用触发器修复后继续保留 Outbox 去重和终态进度清理行为。

## 现有 UI Verifier 的业务语义

带有完整冻结 `verification-contract:v1` 指令的独立 Verifier，在持久 Worker 路径也使用原 UI 的判定规则。结构化输出仍必须符合该节点原有 JSON schema；已有 UI 定义的结果 schema 对应信封为 `{ "result": "...\nVERDICT: PASS" }`。指令中的独立 verdict 行约束应用于 `result` 文本，子任务准备增加明确的传输说明，不改写冻结定义或已有模型历史。

模型 Run 完成后，父调度器再次判定业务结果：精确的一行 PASS 才能完成；FAIL、缺失、重复、缩进或非规范 verdict 均失败。失败节点不发布成功输出摘要，父任务不制造成功回复；实际模型原文仍保存在子 Run 的规范历史中供检查。重开后结算原子任务，不重新采样。普通没有声明这个文本协议的结构化 Verifier 保留原 schema 语义，不猜测任意 JSON 字段的含义。

前后端使用 Domain 的同一纯函数，renderer 从 `@crewon/domain/workflow-verification` 子入口引用，避免导入总入口的 Node 类型和其他领域实现。保留原前端导出的标记及全部旧指令字节；不修改 HTTP、事件、表结构或旧任务数据。若保留记录把一个明确 FAIL 的 v1 结果标为 completed，即使其摘要及结算指纹相符，也不能当作有效完成权威继续推进；读取拒绝该不一致，不自动重写历史或补发任务。

## 审批意见与原子回执

显式装配 Workflow 的 standalone PostgreSQL Control 现在同时提供意见服务。`GET /api/v1/capabilities/workflow-reviews-v1` 返回 `{ "version": "v1", "available": true }`，要求原认证并返回 `no-store`。这是独立的接口支持标记，不能从旧 `humanGates` 标记推断；不证明权限、Worker 在线或整个集群已经升级。没有装配时标记为 false，实际意见接口返回 503。

使用 `GET` 和 `POST /api/v1/workflow-runs/:runId/nodes/:nodeId/gates/:gateRequestId/review-v1` 读取或提交意见，正式 SDK 分别为 `getWorkflowHumanGateReview()`、`reviewWorkflowHumanGate()`；能力查询为 `getWorkflowReviewCapability()`。提交示例：

```typescript
await client.reviewWorkflowHumanGate(locator, {
  inputDigest: gate.authority.inputDigest,
  decision: "approved",
  comment: "核对完成，批准。",
});
```

意见必须明确提供 string 或 null，最多 4096 UTF-8 字节；拒绝不完整 Unicode 和 PostgreSQL JSONB 无法保存的 NUL。保留空白、换行和原文，null 与空字符串不同；正文预算为 32 KiB，包含 JSON 转义开销，响应仍为 128 KiB。默认仅保存审批元数据，不替换冻结节点输入或输出。向下游模型传递意见必须按下一节显式选择；旧请求和旧记录不自动改变语义。

决定、意见、Gate Step、节点输出、执行状态、拒绝后的兄弟取消及唤醒使用原审批事务提交。意见复用 `idempotency_receipts`，scope 为 `workflow-human-gate-review.v1`，键摘要绑定 tenant/Run/节点/门请求；回执包含原四字段决定与意见并校验指纹。读取先限制数据库传回的 JSON 字节，再校验其与规范决定一致。不新增表、不改变原决定 JSON 或 schema 版本。

同一 Actor、输入、决定和意见重放原时间及结果，不新增唤醒；改意见、改决定或改输入返回 409，撤销当前审批权限后读和重放均拒绝。SDK 不自动重试写入；应答丢失后通过同一门身份读取或由调用者显式重放原请求。不要改意见重试或切换到 renderer 重新执行。

原无意见接口及旧决定仍保持原格式。若旧决定没有意见回执，新接口返回 `workflow_gate_review_not_recorded_conflict`，不虚构“无意见”，也不事后添加意见；丢失回执同样不能悄悄恢复。历史决定仍可通过原门读取接口查看；旧 renderer 的审批意见仍从原消息记录读取。旧接口对已经提交的新决定进行相等重放时不会改动意见。

SQLite 与 PostgreSQL 的意见保存及恢复均已接入显式 standalone 部署；Control 前端已展示意见并切换后台执行。旧 renderer 消息不重写，历史只读；审批仍须原子保存意见和决定，不能先写普通消息再批准或默默丢弃意见。

## 显式向后代节点传递审批意见

`GET /api/v1/capabilities/workflow-review-context-v1` 和 SDK `getWorkflowReviewContextCapability()` 使用原认证及 `no-store`，返回同样的 `{ "version": "v1", "available": true }` 形状。这个独立标记表示本 Control 支持意见上下文，不能从旧 reviews 能力推断，也不证明 Worker 或整个集群已升级。未装配意见服务时返回 false。客户端应先查能力，再显式提交：

```typescript
await client.reviewWorkflowHumanGate(locator, {
  inputDigest: gate.authority.inputDigest,
  decision: "approved",
  comment: "保留已核对的数据，草稿中注明适用条件。",
  commentContext: "descendants-v1",
});
```

`commentContext` 是新增的可选请求字段，唯一值为 `descendants-v1`。省略时，旧请求体、响应和 metadata-only 行为保持原状；意见及决定的现有回执 JSON 不增加字段。显式模式在同一事务的新 v2 scheduler wake 中绑定节点、门请求及意见回执指纹，不增加表、索引、迁移或另一个意见注册表。相同决定、意见与模式重放原结果；同一门已决定后换模式返回 409，不能把历史元数据事后升级成模型上下文。原无意见决定接口的相等重放不会更改已选模式。

必须先协调升级 Control 和所有执行该队列的 Worker，再让客户端使用此字段；旧 Worker 拒绝 v2 wake，不会按旧语义忽略意见。已有 v1 队列及旧任务保持原格式，不批量重写。意见查询仍返回原决定和原文，不能仅凭相同的 GET 响应推断某次未知写入选了哪种模式；应按原门身份重放包含原模式的完整请求，或读取已完成的规范子任务历史，不换模式、换意见或转到 renderer 重新执行。

调度器只将已批准且显式选择上下文的 DAG 祖先门传给新建后代 Agent/Verifier，顺序来自冻结的 executionOrder。兄弟分支、尚未决定或被拒绝的门、旧 metadata-only 记录均不贡献模型意见；汇合节点可以收到多个祖先门的意见。注入内容只有冻结门标题和意见原文，作为有界任务数据，不发送审批身份/时钟，不替换 input/output schema、节点值或执行权限。已开始或完成的子任务不改写历史、不补发模型请求。

每个后代子任务的意见上下文合计上限为 16 KiB，包含 JSON 转义、标题及说明开销；仍计入原 64 KiB 子任务提示总预算，并沿用每个分片最多 9999 UTF-8 字节的切分。批准事务先检查新增意见对后代的总预算；超限返回 400 `workflow_review_context_limit`，决定、输出、回执和唤醒全部回滚，门保持可审批，用户可缩短意见重试。子任务创建时将上下文、消息摘要、初始模型历史与调用指纹一同冻结；重启和 scheduler 重放不重新注入。

上述批准预检针对意见部分；实际 instruction/schema/input 与意见组成的完整初始用户提示仍在子任务创建时检查，64 KiB 不代表整个模型上下文或供应商限制。若完整提示超限，原子交接会创建已有协议的失败子 Run（run.created 后紧接 retryable:false 的 run.failed），不创建该子任务的执行队列、模型历史或助手回复，并在写入父子归属后同事务发布父任务唤醒。节点保留 workflow_child_prompt_limit 或 workflow_review_context_limit，父任务沿原失败、兄弟取消和结算流程收敛；未知副作用未确认时继续等待恢复，明确的用户取消可以使根任务收敛为 canceled。只识别这两个本地准备预算错误，授权、租约、存储损坏及其他未知错误保持原处理。没有新表、迁移或 HTTP/事件形状变化，正常子任务提交和请求指纹保持原字节；原纯准备函数仍在分配 ID 前拒绝超限。

读取意见上下文时，每个 DAG 至多一批查询原意见回执，数据库传回前限制每份 JSON 字节，最多 64 门。v2 wake 必须与原门身份及精确回执指纹一致；丢失、损坏，或替换为自身 hash 正确的另一份意见仍拒绝，不降级成“无意见”、不自动修复。当前端迁移后采用此模式，才能保留旧 renderer 审批意见参与后续模型任务的业务语义；本批没有切换 UI。

## 验证范围

集成测试使用本机独立 PostgreSQL、正式 Control/Worker 工厂、实际 AgentVersion 编译器与 Release 激活、真实 HTTP/SDK/SSE 和现有授权实现。覆盖单槽跨人工审批与重启恢复、双会话模型调用重叠与各自结果回流、发布切换互斥、入库拒绝原子回滚、审批身份变更和撤权后取消。

另有真实进程验证：原 Release CLI 发布生产者和独立 Verifier，原 Control Main 通过 HTTP 入库后关闭，原 Worker Main 的两个槽继续执行到人工门；重启 Control/Worker 后，以相同键恢复入库、审批、完成，并从各自 transcript 与终态 SSE 读取最终结果。所有进程只注入命名 fixture 环境，不继承调用者凭据。

模型响应来自明确的本机 HTTP SSE fixture，未调用真实供应商，也未验收安装版账号和可见 UI。后续需要 Workflow 前端接管及旧执行链退役，再让 Team 复用同一父子任务机制；生产请求级授权、桌面自动策略配置、资源隔离、生命周期收敛和自主子 Agent 限额仍是后续阶段。

## 未知提交恢复的请求绑定

`GET /api/v1/capabilities/workflow-recovery-context-v1` 返回严格的 `{ version: "v1", contextId }`，不缓存，SDK 响应上限 1 KiB。`contextId: null` 表示未装配该恢复边界；有效值是 71 字符的 SHA-256 比较标识，绑定实际请求 Actor 的 tenant/space/actor/principal、捕获的完整 Workflow 部署策略和存储 namespace。它不是凭据、授权、Worker 健康检查或提交回执，不进入模型上下文。执行策略和标识在第一次异步迁移前从同一份配置捕获，宿主后来改动原对象不会让两者漂移。

SDK 的 `WorkflowMutationRequestOptions.workflowRecoveryContext` 会同时携带 `x-crewon-workflow-context` 并选择独立版本化写入口：

| SDK 操作                | 带恢复绑定的入口                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| startWorkflowRun        | POST /api/v1/workflow-runs:admit-v1                                                          |
| decideWorkflowHumanGate | POST /api/v1/workflow-runs/{runId}/nodes/{nodeId}/gates/{gateRequestId}/decisions-guarded-v1 |
| reviewWorkflowHumanGate | POST /api/v1/workflow-runs/{runId}/nodes/{nodeId}/gates/{gateRequestId}/review-guarded-v1    |
| cancelRun               | POST /api/v1/runs/{runId}:cancel-guarded-v1                                                  |

这些入口强制要求比较标识，仍使用原业务服务、权限检查、body、幂等键/门回执和响应。取消仍按目标 Run 的原权限和取消语义处理；比较标识不授予目标访问权。缺失、畸形或重复值返回 400，当前 Actor/配置不匹配返回 409，未装配返回 503，均在本次业务 mutation/replay 之前拒绝。Web BFF 明确转发该标识，浏览器身份、CSRF 与服务凭据替换保持原边界；中间层丢掉标识也会被版本化入口拒绝。

仅增加请求头不能防止旧节点忽略新语义。带绑定的 SDK 因而使用上述专用入口；旧节点返回不支持，不会进入旧 mutation。SDK 在发送前只捕获一次比较值，保证选路和请求头一致。省略新选项的旧调用继续沿原 URL；升级节点也会核对旧 URL 上显式提供的标识，但这不是混合版本下的恢复保证。能力 GET 不证明整个集群升级，不能据它在写失败后降级到 renderer 或旧 URL。

未知写入恢复仍以原业务回执为准。前端集成必须在首次发送前保留原比较标识、完整不可变 body 和原幂等键/门身份，恢复时核验当前上下文并回放同一请求，不换键、不猜最新任务、不因目录没有记录或某次 400/404/409/503 就判定原请求未入库。重启后相同配置的标识稳定；配置变化时保留原意图和未知状态，不能把新标识覆盖到旧意图后自动重发。标识使用可信逻辑 authorityId 与 namespace，不是物理数据库指纹；独立部署须使用独立逻辑权威身份。

Control 前端已实现意图持久化和后台执行权切换，接入有界目录、已知根快照、流恢复、通用 input schema 和旧记录只读边界。子 Thread 已按持久父子权威退出普通目录；production 请求级 Workflow 策略和桌面自动配置仍未完成；显式意见上下文须保持 Control/Worker 协调升级要求。

## 子任务目录与只读快照

普通 `listThreads` / Thread catalog 在游标与 LIMIT 前排除已持久关联的 Workflow 子 Thread。同名普通会话、主会话、明确授权的子 Thread 详情及其历史仍可读取；新子任务的 `forkedFromThreadId` 保持原来的 null，不伪装成历史 fork。不增加目录注册表或读取时执行推进。关闭 Workflow 执行配置、子任务完成或归档后，归属仍存在并继续过滤。

SQLite 在同步短读事务中检查归属表并读取页面；已有调用者事务仍由调用者提交或回滚。PostgreSQL 对同一次目录读取使用 repeatable-read 只读事务，避免首次安装执行表和新建 Thread 恰好发生在表发现与分页查询之间。每页是独立快照；不是整个翻页过程的长事务。

目录只核对既有归属表的版本、字段和身份约束，不要求唤醒触发器健康，也不逐个加载子 Run、模型历史或节点输入。每次 Store 页面读取的 PG Workflow 归属检查使用固定至多两次有界 metadata 查询（不代表整次 HTTP 搜索只有两次 SQL）；SQLite 的相关排除仍使用现有可见页索引和 child Thread 唯一索引。部分/未来归属 schema 和遗留的孤立唤醒标记拒绝读取，不通过修复、推断标题或省略过滤继续返回。执行调度继续使用原完整 schema / wake 校验，目录可读不代表任务可执行。
