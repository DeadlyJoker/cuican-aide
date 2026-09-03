# Run Execution Plan（运行时 Todo List）详细设计

状态：Approved for implementation  
目标版本：`crewon.run-plan.v0` / `run-plan-v1` SSE extension  
最后更新：2026-09-02

## 1. 目标

在当前会话的任务输入框上方提供一条可展开的运行进度胶囊，交互形态接近参考图：

- 收起态显示当前步骤、总步骤和当前 Run 的文件变更数。
- 展开态显示由 Agent 维护的结构化 Todo List，以及每项的真实状态。
- 状态在刷新、SSE 断线重连和 Runtime Worker 重试后仍可恢复。
- 单 Agent、Goal Run 与 Team 主 Agent 继续使用同一条主会话，不引入第二套会话模型。
- 旧客户端不会因为服务端新增事件而中断现有 SSE。

## 2. 概念边界

三个已有或新增概念必须保持独立：

| 概念               | 生命周期                      | 权威来源                            | UI                        |
| ------------------ | ----------------------------- | ----------------------------------- | ------------------------- |
| Thread Goal        | 跨多个 Run                    | Thread Goal aggregate               | 输入框上方 Goal bar       |
| Proposed Plan      | Plan 协作模式的一次性最终交付 | `plan.proposed` + ProposedPlan      | Transcript 中的 Plan 结果 |
| Run Execution Plan | 单个执行 Run 内实时更新       | Run aggregate 的 `run.plan.updated` | 进度胶囊与 Todo popover   |

Run Execution Plan 不是从 Assistant Markdown 推断出来的 Proposed Plan，也不改变 Goal 的完成语义。

## 3. 当前问题

当前 UI 的 `threadProgressSummary` 会解析 `ThreadItem.type === "plan"` 的文本，并跨整个 Thread 统计 `fileChange`：

- Plan 文本只在 Plan 协作模式结束时产生，不是执行过程中的实时状态。
- 正则解析 `- [completed]` 等文本容易被文案或格式变化破坏。
- Thread 级文件统计会把历史 Run 混入当前 Run。
- 进度胶囊不是可展开控件，无法检查步骤详情和阻塞状态。

因此，文本解析只能保留为旧数据兼容回退，不能继续作为新功能的权威路径。

## 4. 范围

### 4.1 本次首发范围

- Domain 中新增可验证、有限大小、按 Run 持久化的 Plan snapshot。
- Runtime Worker 提供 server-owned `update_plan` 工具。
- 工具更新、Run snapshot、Run event 与 outbox 使用现有 fenced Run transaction 提交。
- Control API 通过协商后的 SSE extension 发送完整 Plan snapshot。
- Control client 严格校验新增事件。
- UI 对活动 Run 实时投影，对最近一个终态 Run 有界回放恢复。
- 胶囊支持点击、Escape、外部点击关闭及键盘焦点恢复。
- 文件数仅统计该 Run 已投影的 file-change items；没有可信增删行数据时不展示 `+/-`。

### 4.2 明确不做

- 用户直接勾选或编辑 Agent 的执行步骤。
- 把 Proposed Plan 自动转成 Execution Plan。
- 从 Git 工作区总 diff 推断当前 Run 的增删行数。
- JSON Patch 增量协议；首发使用完整 bounded snapshot。
- 跨 Run 复用同一份执行 Plan。
- 将 Team worker 的内部 Plan 混入主会话；Team 模式只应展示主 Agent/manager 的 Plan。

### 4.3 端到端权威链路

```text
Agent update_plan tool call
        │
        ▼
Runtime Worker（server-owned tool；不进入 Tool Broker）
        │
        ▼
RunExecutionService（校验 Run / mode / lease / call identity）
        │
        ▼
commitLeasedRun（snapshot + event + outbox + idempotency receipt 原子提交）
        │
        ├── GET /runs/{runId}/plan ───────────┐
        │                                      │
        └── SSE run.plan.updated（显式协商）───┤
                                               ▼
                                  当前 Run 的 UI projection
                                               │
                                               ▼
                                  progress pill + todo popover
```

权威只沿这条链路单向流动。UI 不从 Assistant 文本反推状态，Runtime 也不读取 UI 本地状态作为下一次 revision 的依据。

## 5. 领域模型

```ts
type RunPlanStatus =
  | "pending"
  | "inProgress"
  | "completed"
  | "blocked"
  | "canceled";

type RunPlanItem = Readonly<{
  itemId: string;
  title: string;
  status: RunPlanStatus;
}>;

type RunPlan = Readonly<{
  schemaVersion: "crewon.run-plan.v0";
  planId: string; // 首发与 runId 相同，天然稳定且无需额外 ID 写入
  revision: number; // 只在内容真实变化时递增
  explanation: string | null;
  items: readonly RunPlanItem[];
  createdAt: string;
  updatedAt: string;
}>;
```

`RunState.plan` 的有效类型为 `RunPlan | null`。为保持现有 idempotency receipt 与旧 snapshot 的 exact-shape 兼容，没有创建过 Plan 的 JSON 可以省略该字段；所有 reader 必须用 `state.plan ?? null` 归一为 `null`。一旦出现 Plan，后续 snapshot 始终保留该字段。

### 5.1 不变量与上限

- 1–32 个 item。
- `itemId` 在 Plan 内唯一，匹配 `[a-z0-9][a-z0-9._-]{0,63}`。
- `title` trim 后非空，最多 256 个 Unicode code point、1024 bytes。
- `explanation` 为 `null` 或 trim 后 1–1000 个 code point。
- 整个 canonical snapshot 小于 10,000 bytes，满足模型可见 fragment 上限。
- 同一 revision 最多一个 `inProgress`。
- `revision` 必须从 1 开始严格递增；首次创建时 `createdAt === updatedAt`，后续更新保留 `createdAt`，且 `updatedAt` 等于事件时间。
- Plan update 只允许在 `running + default collaborationMode + turn purpose` 的 Run 上发生。
- Run 终态不自动伪造步骤状态；未完成、blocked 或 canceled 状态按事实保留。
- 相同 explanation/items 的更新为 no-op，不新增 revision 和事件。

允许 Agent 在新证据出现时增加、删除、重排或重写步骤。历史不会被改写，因为每个真实变化都追加一个完整 snapshot 事件。

## 6. Runtime 工具

工具名：`update_plan`，由 Runtime Worker 拥有，不进入外部 Tool Broker，也不触发审批。

```json
{
  "explanation": "完成协议后开始接 UI",
  "items": [
    { "id": "design", "title": "完成详细设计", "status": "completed" },
    {
      "id": "protocol",
      "title": "实现持久化与事件协议",
      "status": "in_progress"
    },
    { "id": "ui", "title": "接入进度胶囊与弹层", "status": "pending" }
  ]
}
```

工具边界：

- 输入使用 `pending | in_progress | completed | blocked | canceled`；进入 Domain 时映射为 camelCase。
- 工具按 `serial` 执行。模型无需传 Run revision；当前 Work Item lease 与 Run `expectedRevision` 是写入 fence，避免把内部并发控制暴露给模型。
- 幂等键由 `runId + workItemId + segmentId + callId` 派生。同一 call 重放返回原提交；相同 callId 的不同输入 fail closed。
- 无效输入返回 bounded structured tool error，不修改 Run；有效 no-op 返回当前 Plan。
- 工具输出包含 revision、当前 snapshot、完成数和总数，便于下一轮模型保持稳定 item ID。
- 简单单步任务可以不建 Plan；多步实现、调查、迁移和跨模块任务应先建 Plan，再在步骤状态变化时更新。
- 每次最多一个 `in_progress`。开始新步骤前先完成/阻塞/取消上一项。
- Plan 模式只生成 Proposed Plan，因此不暴露 `update_plan`。

## 7. 持久化与事件

新增 durable event：

```ts
type RunPlanUpdatedEvent = RunEventBase &
  Readonly<{
    type: "run.plan.updated";
    data: Readonly<{
      callId: string;
      plan: RunPlan;
    }>;
  }>;
```

写入顺序：

1. Provider 的 `tool.requested(update_plan)` 已先成为 durable Run event。
2. Runtime Worker 校验输入并构造下一 Plan snapshot。
3. 通过现有 `commitLeasedRun` 原子提交：Run event、Run snapshot、outbox 和幂等 receipt。
4. Runtime Worker 追加 `tool.completed(update_plan)`，供模型历史恢复。
5. 若步骤 3 后、步骤 4 前崩溃，重试命中相同幂等 receipt，不重复递增 Plan revision。

Plan 是 Run aggregate 的一部分，不新增数据库表。SQLite/PostgreSQL/InMemory Store 已以 JSON snapshot/event 持久化，历史 snapshot 仅需缺省字段归一化。

## 8. SSE 与向后兼容

现有 control-client 对 event type 和 data key 都做严格校验。直接向默认流加入新事件会让旧客户端报协议错误，因此采用显式 query capability：

```http
GET /api/v1/runs/{runId}/events?view=transcript&extensions=run-plan-v1
```

- 新 UI 显式请求该 extension；control-client 只有在请求 extension 时才允许并校验 `run.plan.updated`。
- 旧客户端不发送 query；新服务端继续推进内部 cursor，但过滤 Plan 事件，不改变其可见协议。
- durable event 内的 `callId` 只用于服务端审计和幂等关联；公开事件仅投影 `{ plan }`，避免泄漏模型工具调用身份。
- 当前旧服务端只读取 `view`、忽略其他 query；因此新客户端连接旧服务端时仍可收到核心流，只是没有 Plan 事件。
- SSE `id` 继续使用 durable Run sequence；断线后 `Last-Event-ID` 回放仍以 Run event log 为唯一权威。
- `client`、`audit`、`transcript` 三种 view 都必须先协商 extension 才返回新增事件，避免旧的严格 audit/transcript client 被破坏。

首发不把 Plan 加到 `RunView`，也不修改既有 GET Run response shape，从而避免旧 `parseRunView` 的 exact-key 校验失败。新增独立快照接口：

```http
GET /api/v1/runs/{runId}/plan

200 OK
{
  "runId": "run-123",
  "eventSequence": 17,
  "plan": { "schemaVersion": "crewon.run-plan.v0", "...": "..." }
}
```

无 Plan 时返回 `plan: null`，而不是 404。`eventSequence` 是读取同一 Run snapshot 时的 `lastSequence`，用于判断 hydration 新旧；它不能直接推进 transcript/tool 主流的 cursor，否则会跳过尚未 hydrate 的其他 Run 事件。活动 Run 仍从主流自身的 sequence 0 回放恢复；终态 UI 通过快照恢复最近一个 Turn Run。

## 9. UI 状态投影

UI 保存以下轻量状态，不把它写回 Thread transcript：

```ts
type ThreadRunPlanProjection = Readonly<{
  threadId: string;
  runId: string;
  plan: RunPlanView | null;
}>;
```

状态规则：

- 新 Run 被 adopt/start 时，先以 `{runId, plan: null}` 替换该 Thread 的旧 Plan，杜绝跨 Run 泄漏。
- 收到 `run.plan.updated` 时，仅当 event sequence 更新且 runId 仍为当前 Run 才覆盖。
- SSE 重连从最后 sequence 继续；重复事件为 no-op。
- 打开含活动 Run 的 Thread 时先读取 Plan snapshot，同时让主流从自身 sequence 0 回放；以 Plan revision 去重，不用 snapshot watermark 跳过主流事件。
- 打开只有终态 Run 的 Thread 时，只读取最近一个 Turn Run 的 Plan snapshot。
- 新 Run 从未调用 `update_plan` 时不显示旧 Plan 胶囊。
- rollback/delete/authority reset 时清理相关投影。

`threadProgressSummary` 的旧文本解析仅为历史 Proposed Plan 回退。存在结构化 Run Plan 时，步骤进度完全来自结构化 snapshot；文件数按 `turn.id === runId` 限定。

## 10. 交互与视觉

位置保持设计基线：Goal bar 与 Plan 胶囊均位于会话 composer 卡片上方，Goal 和 Plan 不合并。

收起态：

- 有结构化 Plan 时为 `<button>`；没有可展开内容的旧回退仍为只读 status。
- 文案为 `第 n / m 步` / `Step n of m`。
- Run 内有可信 file-change item 时附加 `· N 个文件已更改`。
- Run 活动时显示旋转进度图标；终态保留最后状态但不旋转。

展开态：

- 非模态 popover 向上展开，避免遮挡输入框。
- 使用有序列表保留 Agent 的步骤顺序。
- completed、in progress、pending、blocked、canceled 使用不同图标和辅助文本，不只依赖颜色。
- explanation 有值时作为简短标题/说明；内容按纯文本渲染。
- 提供 `role="progressbar"` 的完成数语义和独立的 polite live summary。

关闭规则：

- 再次点击 trigger。
- Escape，并把焦点还给 trigger。
- pointer interaction outside。
- Thread/Run 切换或组件卸载。

窄屏时 popover 最大宽度不超过 composer；低高度视口限制列表高度并允许内部滚动。遵循 `prefers-reduced-motion`，除活动 spinner 外不增加必要性不足的动效。

## 11. 文件变更统计

首发只展示当前 Run 中已投影 `fileChange` item 的去重文件数。以下做法明确禁止：

- 使用整个工作区 `git diff`，因为会混入用户在 Run 前已有的改动。
- 把 Thread 所有历史 turn 的文件累加到当前 Run。
- 在没有 preimage/patch ledger 的情况下估算 `+/-`。

后续若要展示精确 `+271 -730`，需在第一次写文件前保存 preimage digest/内容引用，并以 Run-owned change ledger 计算净 diff；该 ledger 还需覆盖回滚、重复写、rename 和 binary 文件。

## 12. 安全与资源控制

- Plan 为 metadata-only，不授予新的文件、网络或外部系统能力。
- 所有字符串在 Domain 边界校验大小；Tool output、event frame 与 UI 列表均有上限。
- UI 不渲染 Markdown/HTML，不执行 Plan 内容。
- tenant/run/thread 身份继续由现有 Run authority 决定；模型不能指定这些字段。
- event/outbox 仍受 Work Item lease、Run revision、tenant 和 idempotency fence 保护。
- Team worker 的 Plan 不应由 UI 聚合；只有主 Run 的订阅可以更新主会话投影。

## 13. 可观测性

首发记录/复用以下可观测信号：

- `run.plan.updated` event count 与 snapshot bytes。
- tool invalid/no-op/committed/replayed disposition。
- UI SSE protocol errors、history hydration timeout。
- Plan 首次出现耗时、revision 数量、terminal Run 的未完成 item 数。

不记录 title/explanation 明文到新增 metric label 或 log field，避免高基数与敏感内容泄漏。

## 14. 实施任务

### Phase A — 本次完整垂直切片

- [x] A1. 新增 Domain RunPlan 类型、解析/验证、reducer event 和 legacy snapshot 的有效 `null` 归一化。
- [x] A2. 新增 application `update_plan` 纯 evaluator 与 fenced/idempotent Run commit。
- [x] A3. Runtime Worker 注册 server-owned tool，处理冲突、混合 batch、重放和 tool completion。
- [x] A4. Control API 提供独立 Plan snapshot，并使用 `run-plan-v1` query capability 保护旧客户端 SSE。
- [x] A5. 更新 OpenAPI、生成类型和 control-client 严格 SSE parser。
- [x] A6. UI 新增 Run Plan projection、活动流更新及最近终态 Run hydration。
- [x] A7. 将进度胶囊升级为可访问的 trigger + Todo popover，并将文件数限制到当前 Run。
- [x] A8. 补齐 domain/application/runtime/control/client/UI 测试与视觉快照。
- [x] A9. 运行边界检查、相关 typecheck/test、UI build 和浏览器回归。

### Phase B — 后续增强

- [ ] B1. Team manager Plan 的显式主/子 Run 归属协议。
- [ ] B2. Run-owned file change ledger 和准确的增删行统计。
- [ ] B3. Plan telemetry dashboard、灰度开关与异常 revision 告警。
- [ ] B4. 若完整 snapshot 的平均大小/频率成为瓶颈，再评估 RFC 6902 patch；保留周期性完整 checkpoint。

### Phase A 验证记录（2026-09-02）

- Domain、Application、Store、Contracts、Control Client、Control API 与 Runtime Worker 的 typecheck 均通过；OpenAPI generated check 与架构边界检查通过。
- 非 UI 全量测试：1,161 pass、55 个环境条件测试 skip、0 fail。
- UI 全量测试：329 个测试文件、2,062 项通过；UI lint 与 production build 通过。
- 真实组件浏览器回归覆盖收起/展开、Escape 焦点恢复、外部点击、360px 窄屏、320px 低高度滚动与暗色主题。
- 当前机器为 Node 22，低于仓库固定的 Node 24，因此命令有 engine warning；未配置 `CREWON_TEST_POSTGRES_URL`，PostgreSQL conformance 未在本机重跑。

## 15. 测试矩阵与验收标准

### Domain / Store

- 创建、推进、阻塞、取消、重排和完成 Plan。
- 空 Plan、重复 ID、超长文本、非法 status、多个 in-progress、超过 snapshot bytes 均 fail closed。
- 相同 snapshot no-op；revision 跳跃/回退拒绝。
- 历史 Run snapshot 无 `plan` 时恢复为 `null`。
- SQLite/PostgreSQL/InMemory replay 后 snapshot 一致。

### Runtime

- 默认 Turn 暴露 `update_plan`；Plan collaboration 与非 Turn Run 不暴露。
- 外部工具重名冲突时永久失败，不允许覆盖 server-owned tool。
- valid、invalid、no-op、crash-after-plan-commit 四条路径有行为测试。
- SSE 中 Plan event 一定先于对应 `tool.completed`。

### Contract / SSE

- 无 extension query 看不到 `run.plan.updated`，其他 sequence 事件继续到达。
- 有 extension query 时 client/audit/transcript 均能严格解析。
- `Last-Event-ID` 在 Plan event 前、等于 Plan event、Plan event 后三种游标均不重复丢失可见状态。
- 新 client + 旧 server、旧 client + 新 server 均保持旧功能可用。

### UI

- 新 Run 清除旧 Run Plan；重复/乱序 event 不覆盖新 snapshot。
- active、completed、blocked、canceled 图标和文案正确。
- trigger 的 `aria-expanded/controls/haspopup` 正确；Escape/外部点击/重复 trigger 关闭。
- Thread 切换关闭 popover；回到 Thread 能恢复最近 Plan。
- current Run 文件数不包含历史 turn。
- 360px 宽、低高度视口不裁切主要 composer 控件；reduced-motion 下可用。

### 交付门槛

```bash
pnpm crewon:boundary:check
pnpm --filter @crewon/domain typecheck
pnpm --filter @crewon/domain test
pnpm --filter @crewon/application typecheck
pnpm --filter @crewon/application test
pnpm --filter @crewon/store typecheck
pnpm --filter @crewon/store test
pnpm --filter @crewon/contracts generate:check
pnpm --filter @crewon/contracts test
pnpm --filter @crewon/control-client test
pnpm --filter @crewon/control-api typecheck
pnpm --filter @crewon/control-api test
pnpm --filter @crewon/runtime-worker typecheck
pnpm --filter @crewon/runtime-worker test
pnpm --filter @crewon/ui test -- CommandWorkspace
pnpm --filter @crewon/ui build
pnpm format
```

浏览器必须检查 `/#view-command`：活动更新、终态保留、Thread 切换、Escape/外部点击、窄屏和低高度布局。
