# 项目任务的共享实例执行通道

2026-10-12。普通 TaskOwner 已接原 Profile，但项目 generation、query、historical-query 三个 Owner 仍为每次调用建立自己的 Node Host。不能仅把它们的 `crewon.tasks` 服务改名后接普通任务桥：它们拥有不同的原 invocation、publication、项目关联、原 Run 与提交权限。

本轮在原三个 Project ExecutionBridge 中增加 Host-only `executeFromBorrower`，复用原执行算法和原 invocation map。它捕获真实源 UI capability、原目标 pin、publication、saved command、事务与提交回调；只把目标实例获取和物理释放换成 Host 提供的共享借用。原 `execute(NodeHost, input)` 保持旧获取/释放路径，未修改 SDK、HTTP、数据库、任务/Run 或项目管理器。

新内部借用通道只接受实际 NodeHost 签发且未释放的 lease；结构复制、额外字段、getter 与已释放 lease 都拒绝。异常返回仍调用捕获的物理 release，不执行 getter。持有目标后，原 source/current/transaction 的 active fence 会同步再借用并比对同一真实 identity，因此替换或撤回实例不能靠旧引用提交。每次复核也释放实际 handle。确认提交后的原 durable result 优先规则继续保留，历史查询 Bridge 的原 pending/close join 也未被丢弃。

测试：Host 四文件 32/32、零跳过。新正例使用真实安装器、预构建包字节、NodeHost 和 lease，连续生成/重放只 setup 一次，所有实际借用数与释放数相等，关闭只 dispose 一次。它的 Application 回执使用明确的内存 fixture，不能作为真实 SQL admission 或 Native Profile 接线证据。新负例覆盖提交前撤回、复制/释放/额外字段/getter handle，三个执行 Bridge 都拒绝未签发的 lease；旧执行权限、saved command、CAS、源关闭、过期、忽略 promise、提交后错误和最终回执测试保留。

原三个 Control Owner 的 SQLite 专项 31/31、零跳过，验证原真实文件库、付费任务、项目关联与历史查询路径未回归。本次显式按 SQLite 名称筛选，未运行 PostgreSQL；这些 Owner 尚未调用新共享通道。Host/Control 类型、边界与格式检查通过。证据：[Host](../output/plugin-foundation/shared-task-binding-20261012/project-borrower-regression.log)、[原 SQLite Owner](../output/plugin-foundation/shared-task-binding-20261012/project-borrower-control-sqlite.log)、[Host 类型](../output/plugin-foundation/shared-task-binding-20261012/project-borrower-types.log)、[Control 类型](../output/plugin-foundation/shared-task-binding-20261012/project-borrower-control-types.log)。最初实际行为断言通过但只读安装目录的测试清理失败，已修正测试目录清理并移除该次生成的残留，再完整复跑。

下一步必须完成正式接线，不能据此宣布项目共享实例完成：

1. 原 Core/三个 Owner 的项目执行桥须长期绑定到同一个真实 task 服务目录，按各自真实 opaque invocation 路由，避免给普通任务引用附加项目提交权。保留原项目/源/目标审批和最大并发限制。
2. 普通生成和当前查询借用原 Profile 的当前实例，并由原 Profile/Owner 负责启动等待、撤权和关闭物理 join，不能在请求中 import/setup。
3. 历史查询可能指向原 Run 的旧包。目前 Profile 只借用当前 graph；必须补原历史 composition/Run lock 的实际证明与恢复路径，不能把历史 pin 当当前 selection，或用传入 JSON 取得旧版本执行权。
4. Worker 的必需服务、完整项目隔离与 Web 安装/升级/回滚/恢复/卸载闭环仍待验收。正式业务插件保持卸载；本次没有部署 Web、更新桌面或测试外部模型。
