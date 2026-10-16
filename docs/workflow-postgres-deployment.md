# PostgreSQL Workflow 部署接线

当前能力位于 `createPostgresControlApi` 和 `createPostgresRuntimeWorker` 工厂。可信宿主可以通过 `workflow` 配置显式装配既有持久调度器；默认不装配。命令行环境变量入口和前端 Workflow/Team 迁移尚未完成，不能将这份工厂接线说明视为产品已上线。

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

## 验证范围

集成测试使用本机独立 PostgreSQL、正式 Control/Worker 工厂、实际 AgentVersion 编译器与 Release 激活、真实 HTTP/SDK/SSE 和现有授权实现。覆盖单槽跨人工审批与重启恢复、双会话模型调用重叠与各自结果回流、发布切换互斥、入库拒绝原子回滚、审批身份变更和撤权后取消。

模型传输为显式合成流，未调用真实供应商，也未验收安装版账号和可见 UI。后续需要补齐产品配置入口、Workflow 前端接管及旧执行链退役，再让 Team 复用同一父子任务机制。资源隔离、生命周期收敛和自主子 Agent 限额仍是后续阶段。
