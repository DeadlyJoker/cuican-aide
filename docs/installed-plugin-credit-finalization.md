# 已安装插件的积分结算决定

这一层把原个人预占、执行证据与最终账务决定放在同一事务中。它补充[积分生命周期边界](./installed-plugin-credit-lifecycle.md)，不提供用户余额、价格或默认退款规则，也不改变原前端、插件 SDK 或任务协议。

## 证据与权威

`PluginCreditSettlementStore` 从原 Run 定位读取付款主体、积分池、报价修订、预占、原任务回执与完整绑定。已经安装的任务还必须具有核验过的 v1 admission 和安装包 pin。旧 v0 任务仍可观察；这条新增路径不会把缺少安装证明的任务重新归类为可自动结算。原账本 API 和历史任务保持原行为。

证据同时包含同一 Run 的全部供应商 operation、Tool 回执、Step、Attempt 和 WorkItem/lease。每个集合最多 64 项，多一项即拒绝，不将截断视为空集合。原输入、供应商输出与凭据不进入权威投影；完整原记录的摘要参与证据比较，金额和付款主体来自原持久准入。

只有原 Run 已终结、工作项已完成、没有运行中的 Attempt、未决 mutation Tool 或未决供应商操作，才允许提交财务决定。过期 lease、Run completed、空 operation 集合或 dispatched 后的 canceled Tool，单独都不能证明可以释放资金。供应商生成失败也不会自行选择退款规则。

`PluginCreditSettlementService` 要求显式服务端权威。缺少权威时不读取、迁移或修改账务；权威可以明确返回 hold。权威在事务之外等待，决定必须绑定刚读取的证据摘要，提交前重新检查当前授权。UI 和模型不提供付款主体、实际收费金额或结算决定。关闭撤回新工作，并等待原权威请求和 Store 操作物理结束。

## 原子提交和重放

SQLite 使用同父连接的 `BEGIN IMMEDIATE`。PostgreSQL 使用同一个借用连接，按原个人账户锁、原 Run advisory 锁、工作项行锁及相关证据行锁的顺序重读事实。供应商 operation 的 CAS 更新没有原 Run advisory 锁，因此还必须锁住 operation 行；Attempt 检查沿用工作项先于 Attempt 的顺序。单连接池不能通过另一个公共 Store 方法重入事务。

财务提交再次计算证据摘要。事实变化返回 `evidence_changed`，尚未退场返回 `not_ready`，两者均保留原预占。实际扣费不得超过原报价。账户、reservation、账本流水与不可变最终决定共同提交；任何一步失败都回滚。决定冻结原付款主体、报价、准入和绑定摘要以及权威身份、修订和决定 ID。

相同决定返回原账务结果，不再次扣费或释放；不同决定冲突。已有 terminal reservation 却没有本协议决定时明确拒绝，不收编旧手动结算结果。结算之后原新 operation 准入因 reservation 不再为 reserved 而拒绝；读取原回执与保存迟到的真实结果继续原语义。确认 COMMIT 后发生关闭，仍返回已经提交的结果。

迁移单独、显式启用，仅增加 `plugin_credit_settlement_schema_version` 和 `plugin_credit_settlement_finalizations` 及不可变保护，原信用、扩展、安装、任务与事件版本不变。构造适配器不迁移、不授予权限、不资助账户。

## 当前交付边界

本阶段提供 Application 服务、共享证据校验与双库原子适配器。验证结果以[实施进度](./incremental-extension-progress.md)首节及实际日志为准；测试金额和权威均为具名夹具，不能作为生产扣费或退款。

原 Worker 的有界恢复扫描、独立财务部署授权与生命周期装配仍需后续接通；不会借用或领取原 SSE outbox。当前服务关闭会撤回尚未交给 Store 的新工作并等待已开始 Store promise；适配器的事务内 fence 来自父 Store 生命周期。下一阶段还需组合独立结算 owner 的同步撤回检查，不能把普通执行权限当作财务授权，也不能把逻辑超时当作 HTTP 或 Store 已物理结束。

真实个人身份、资金入账、价格和失败结算规则需要实际服务协议。Native Krea2 公网执行、同次完整 App 的保存→生成→显式查询→选用→重启、完整插件打包链路与实际企业 API 的 E5 门槛继续保留。
