# 已保存生成的原操作查询 UI 协议

日期：2026-10-04。查询复用原 Agent、Turn、Run、任务准入与 operation；插件只增加功能模块。原普通任务、生成输入、六字段回执、共享样式及用户栏/设置行为保持兼容。

## 独立能力

业务包可声明 `crewon.project-generation-queries@1`，唯一动作是 `crewon.project-generation-queries.v1.queryConceptGeneration`。SDK 提供 `createPluginProjectGenerationQueryClient(services).queryConceptGeneration(input, options?)`。构造客户端不会探测、启用、提交或自动重试。

请求严格包含：

```json
{
  "reference": {
    "projectId": "saved-project",
    "assetId": "saved-concept",
    "assetRevision": 2
  },
  "operationId": "00000000-0000-4000-8000-000000000123",
  "threadId": "existing-thread",
  "expectedThreadRevision": 5,
  "idempotencyKey": "one-explicit-query"
}
```

请求和响应各限 24 KiB。operation 必须是规范小写 UUID；线程 revision 必须允许安全地加一。查询引用历史输入，不使用当前项目或资产元数据 CAS。请求不能指定 sourceRunId、执行包、目标、配置、描述、身份、付款人或价格。改名、归档和保存新输入后，仍可在当前权限允许时查询旧修订的原操作。

响应保持 `disposition / threadId / threadRevision / runId / messageId / configurationRevision` 六字段，`runId` 是本次查询 Run。响应线程和下一 revision 必须匹配原请求；原生图 Run 和项目生成关联保持不变。查询没有新增生图积分预留或生成槽位。

## 宿主装配与事务

部署必须显式提供 `creativeProjects.pluginQueries.publications`，固定业务 UI 包、摘要、贡献和独立查询执行包、摘要、贡献、动作。实际 generation reader、原 Task owner、同一 issuer 和真实安装选用必须同时存在。元数据、只读或生成批准不会自动授予查询；默认关闭。optional 声明允许模块保留，required 声明要求真正装配的 owner，结构模拟对象不能取得它的权限。

Control 从当前用户授权的不可变项目生成关联反查原付费 Run，再核验确切 operation、保存配置与目标。当前查询包可更新，实际观察继续使用原配置；原供应商观察规则不改变。执行 Node 桥只允许当前一次捕获的 `crewon.tasks@2.queryTask`，沿原 Task Application 创建查询 Turn，不建立第二套执行循环。

`crewon.project-query-link.v1` 与查询 publication migration 显式启用。查询侧记录、原查询准入、绑定、Turn 和回执在原事务内提交。两个当前安装 pin 在同一借用 SQL client 上锁定，适配单连接 PostgreSQL；事务内外部权限检查不另借连接，最后保留同步生效检查。提交后 issuer 只核验不可变提交证据，迟到的页面关闭、撤权或元数据更新不会把已接受的回执改成拒绝。查询不把旧生成关联改成新查询 Run。

## 页面恢复与导航

声明该协议的模块可获得可选 `data.projectGenerationQueryContext`，版本为 `crewon.project-generation-query-host-context.v1`，包含 `phase / thread / threadReady / intent`，完整 JSON 限 24 KiB。phase 为 idle、loading、ready、uncertain 或 error。宿主只读取已有会话，包括原生成控件显式准备的会话；查询上下文不会创建会话。

独立账户 journal 保留完整原查询输入、当前业务包 pin、pending / uncertain / accepted / refused、retryable 与原回执。它与生成 journal 隔离，各自最多 32 项、16 个物理动作。同一模块未确认查询禁止新键、新来源或新 operation；物理请求结束且 pin 一致后才能显式重试原意图。已接受后，用户可以用新键和认证读取的新线程 CAS 再次查询同一 operation。

取消等待或关闭模块不表示供应商取消。已发送后任何无法核实的失败保持 UNKNOWN，晚回执仍被原账户观察；账号切换同步撤回并清空旧记录。同账号重开保留原意图。新的查询 Turn 接受后，生成控件重新读取线程 CAS。

“打开查询任务”先读取已保存的原生成，从其任务投影取得执行 pluginId，再核对查询 Run、sourceRunId、thread 和历史 configuration revision，沿原 runtime adopt/navigation。业务 UI pluginId 不用作执行任务的归属。

这些内存恢复记录不承诺完整应用进程重启后的 UNKNOWN 恢复。确切图片选用、完整 App/packaged App 在线 Krea2、真实个人插件钱包与价格权威、第二个企业 API 仍需后续验收。

## 验证范围

Contracts 26/26、SDK 27/27、Domain 37/37、Application 145/145、Store 双库新旧 190/190、Host 111/111、Control 新 36/36 与原回归 150/150、原 Worker 查询 16/16，均零跳过。UI 原生成、查询、设置、侧栏等 220/220 与原业务模块 10/10 通过；新增四个查询控件快照，原快照与共享样式保持不变。相关类型、UI lint/build、boundary、格式与 diff 检查通过。各组存在重叠，不相加，也不代表原全量 UI 九项失败已经修复。

独立短剧 6.0.0 从实际 SDK tarball 构建，发布 ESM 新旧 DOM 55/55 通过；实际安装包沿注册 mount/assets HTTP、真实 Node B、同 SQL/issuer 的 DOM 查询与 UNKNOWN 同键恢复两库 2/2 通过。该专项的原付费 A 历史由原 Task Application 和 Node A 安装 pin 建立；身份、PDP、Peer 和资金是具名夹具，没有在线模型、Worker 或供应商调用。证据见 `output/extensions/checks/project-query-ui-proof-20261004.json`。
