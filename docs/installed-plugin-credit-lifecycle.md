# 已安装插件的个人积分与供应商提交

当前原任务准入已经保存实际请求主体的个人付款人、积分池、价格修订和报价，并在原 Turn/Run 事务中预占。账号切换、包升级或新报价不得替换已提交任务的付款人和价格。已有账本提供幂等结算与释放；新增[原子结算决定](./installed-plugin-credit-finalization.md)以完整执行证据和显式权威绑定实际账务。线上资金入账、业务结算规则和 Worker 自动协调器仍未接通。

## 新供应商操作的准入

`ExternalOperationStore.reserveExternalOperation` 的 `created` 只许可一次提交；`existing` 是原回执的观察结果，不许可重发。调用方使用宿主构造的 tenant、Run 和 binding digest，模型与 iframe 不能提供付款人。

对已有收费 admission 的 Run，新操作在同一个真实数据库事务中读取并核对：

- 原收费 admission、任务回执和完整 binding，以及原 Run 的租户、空间、线程、发起 actor 和执行路由。
- 原个人账户和 reservation，保持原报价身份，且 reservation 仍为 `reserved`。
- 原 Run 为 `running`，没有取消请求，没有终态时间。

SQLite 使用原 `BEGIN IMMEDIATE`。PostgreSQL 使用原个人账户锁，再使用原 `run:<tenantId>:<runId>` advisory lock 和实际行锁；顺序与收费 Turn 准入一致。持锁后重新读取不可变 admission 与所有相关事实，避免等待期间失去预占或运行许可。调用方更换 binding digest 不会让收费 Run 变成免费操作。

旧操作回执优先进行准确重放，已取消或结算也能查询该回执。供应商响应的 `advanceExternalOperation` 保留原义，真实收到的结果可以在晚取消、过期或撤权后继续保存。历史未收费操作不新增积分或 Run 表；部分、未知版本或遗失的收费链接拒绝新提交。

这道事务边界只约束**新操作的登记**。已登记的请求仍可能在随后取消时被供应商受理；数据库锁不会跨越网络请求，也不承诺供应商撤销或退款。释放预占前必须核对这类已登记的操作。

## 后续结算边界

`Run completed` 不能代表供应商生成成功。ComfyUI 的工具完成可能只表示请求已提交；`submitting`、`submitted`、`queued`、`running`、`unknownOutcome` 都不能推导为可退款。

后续协调器必须读取保存的付款人、价格修订、原 Run、完整有界供应商操作和原 mutation Tool 回执、Attempt/lease。专业报告插件也可能通过自己的 Tool 直接请求供应商，不能因 external-operation 集合为空就认定没有副作用。权威价格规则应明确决定保留预占、实际扣费或释放；前端和模型不得传入结算金额。

最终账务提交需要与新操作登记共享个人账户与 Run 锁，在同一事务中重核证据、修改账本并保存不可变决定。远程权威等待位于事务外，证据变化则丢弃旧决定。恢复扫描必须有界，并由原 Worker 生命周期持有，不能另抢原 SSE outbox。

Native 的真实用户执行身份仍需独立的 account-bound profile 和请求会话 owner；固定本机管理 actor 不是线上付款身份。原 UI、用户栏和设置不属于这一步的可变范围。
