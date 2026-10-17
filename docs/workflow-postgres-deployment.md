# PostgreSQL Workflow 部署接线

当前能力位于 `createPostgresControlApi` 和 `createPostgresRuntimeWorker` 工厂，并已接入两端的 standalone PostgreSQL Main。可信宿主可以通过 `workflow` 配置显式装配既有持久调度器；默认不装配。生产模式的请求级身份接线和前端 Workflow/Team 迁移尚未完成，不能据此宣称整套产品已经上线。

## Main 入口

先通过原 Release CLI 发布真实 AgentVersion/部署物并激活 Release，再把上文所述配置保存为 JSON。Control 和 Worker 均使用同一个环境变量：

```bash
export CREWON_WORKFLOW_DEPLOYMENT_CONFIG_PATH=/absolute/path/workflow.json
```

JSON 的形状与下方 `workflow` 对象一致，不包含 TypeScript 的 `satisfies`。保留各进程原有数据库、模型、身份和 Artifact 配置。该入口只接受 `CREWON_CONTROL_SECURITY_MODE=standalone` 且配置 PostgreSQL URL 的模式；production 和 SQLite 在读取文件及分配资源前拒绝，不会默默忽略声明的配置。

文件必须是当前用户拥有的私有普通文件，路径为规范绝对路径，不能使用软/硬链接；文件权限不能开放给组或其他用户，推荐 `0600`。读取使用同一文件描述符，并核对读取前后的身份、尺寸及时间元数据，最多 256 KiB，严格解码 UTF-8。这个私有文件入口目前支持 POSIX，Windows 显式配置会拒绝。两个进程各自在启动时捕获一次并冻结，不热重载；策略变更应协调重启两端。

生产模式原本使用请求级身份及外部授权，当前静态 issuer 不能代替它。后续需要按生产身份和审批授权边界接入，不通过 ambient 配置降级成 standalone。

## 客户端能力发现

`GET /api/v1/capabilities/workflow-execution-v1` 要求原有身份认证并返回 `Cache-Control: no-store`。正式 SDK 为 `getWorkflowExecutionCapability()`：

```json
{ "version": "v1", "admission": true, "snapshots": true, "humanGates": true }
```

三个标记分别表示本实例是否装配入库、快照和人工门服务。未启用执行的 PostgreSQL 实例仍可能提供快照，因此不能只看一个接口是否存在。标记不包含配置、身份或授权信息，也不证明 Worker 在线、发布就绪、请求获准或集群所有节点已升级。实际启动仍执行原鉴权、发布策略和幂等校验。

客户端按具体操作检查所需能力；查询失败或响应未知版本不能当成执行许可。请求一旦可能已被后台受理，就应按原键和回执恢复，不能切换到前端重新执行。SDK 验证响应形状、1 KiB 字节预算和取消，不自动重试或选择执行引擎。

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
- 校验与入库期间持有现有 Release 发布锁的共享模式。真实发布切换使用同一租户键的独占模式，避免校验完旧发布后把任务写入新发布窗口。
- 已入库任务按冻结 WorkflowVersion、输入和保留部署继续执行。切换默认 Release 不重写旧任务；当前宿主允许列表、执行路由及审批策略仍约束后续执行。
- 同键恢复先读取原入库回执，不重新创建任务，也不因当前默认 Release 切换而重发模型请求。只读快照与终态 SSE 仍使用现有协议。
- 审批同时绑定 Actor、principal、租户、空间、根 Run、冻结定义和策略。客户端不能指定审批人或替换输入。当前审批人改变后，旧身份不能读取或决定该门。
- 用户获准取消根任务时，停止仍可收敛已撤销执行权限的任务；不要求重新授予模型执行权限。移除调度配置会停用调度能力，已有任务应先通过仍运行的调度器完成或取消收敛。

未配置时，PostgreSQL 的 Workflow 定义发布仍可使用；执行启动返回能力不可用。该路径仅初始化定义表，不安装执行表或启动调度器。SQLite 显式传入这份 PostgreSQL 部署配置会拒绝启动，并释放已接管的资源。

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

意见必须明确提供 string 或 null，最多 4096 UTF-8 字节；拒绝不完整 Unicode 和 PostgreSQL JSONB 无法保存的 NUL。保留空白、换行和原文，null 与空字符串不同；正文预算为 32 KiB，包含 JSON 转义开销，响应仍为 128 KiB。意见作为审批元数据保存，不替换冻结节点输入或输出，也尚未作为下游模型上下文注入。

决定、意见、Gate Step、节点输出、执行状态、拒绝后的兄弟取消及唤醒使用原审批事务提交。意见复用 `idempotency_receipts`，scope 为 `workflow-human-gate-review.v1`，键摘要绑定 tenant/Run/节点/门请求；回执包含原四字段决定与意见并校验指纹。读取先限制数据库传回的 JSON 字节，再校验其与规范决定一致。不新增表、不改变原决定 JSON 或 schema 版本。

同一 Actor、输入、决定和意见重放原时间及结果，不新增唤醒；改意见、改决定或改输入返回 409，撤销当前审批权限后读和重放均拒绝。SDK 不自动重试写入；应答丢失后通过同一门身份读取或由调用者显式重放原请求。不要改意见重试或切换到 renderer 重新执行。

原无意见接口及旧决定仍保持原格式。若旧决定没有意见回执，新接口返回 `workflow_gate_review_not_recorded_conflict`，不虚构“无意见”，也不事后添加意见；丢失回执同样不能悄悄恢复。历史决定仍可通过原门读取接口查看；旧 renderer 的审批意见仍从原消息记录读取。旧接口对已经提交的新决定进行相等重放时不会改动意见。

SQLite Store 同样实现原子保存与恢复，但 SQLite/桌面部署入口尚未接线。前端执行权仍未迁移，旧 renderer 消息不被重写；后续适配须明确历史读取和新任务写入边界，并验证意见展示及原有业务语义，不能先写普通消息再批准或默默丢弃意见。

## 验证范围

集成测试使用本机独立 PostgreSQL、正式 Control/Worker 工厂、实际 AgentVersion 编译器与 Release 激活、真实 HTTP/SDK/SSE 和现有授权实现。覆盖单槽跨人工审批与重启恢复、双会话模型调用重叠与各自结果回流、发布切换互斥、入库拒绝原子回滚、审批身份变更和撤权后取消。

另有真实进程验证：原 Release CLI 发布生产者和独立 Verifier，原 Control Main 通过 HTTP 入库后关闭，原 Worker Main 的两个槽继续执行到人工门；重启 Control/Worker 后，以相同键恢复入库、审批、完成，并从各自 transcript 与终态 SSE 读取最终结果。所有进程只注入命名 fixture 环境，不继承调用者凭据。

模型响应来自明确的本机 HTTP SSE fixture，未调用真实供应商，也未验收安装版账号和可见 UI。后续需要 Workflow 前端接管及旧执行链退役，再让 Team 复用同一父子任务机制；生产请求级授权、SQLite/桌面策略入口、资源隔离、生命周期收敛和自主子 Agent 限额仍是后续阶段。
