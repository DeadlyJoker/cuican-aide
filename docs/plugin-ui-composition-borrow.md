# UI 操作借用原插件组合

本增量沿用原 `PluginTaskActionBridge`、`PluginCompositionCoordinator`、安装 ledger、UI mount、Task Application、Run 和计费事务。没有增加管理器、数据库或第二个 NodeHost。它是 Host 内部接线能力，尚未接入正式产品的 UI action owner，也不等于 Web 或桌面验收。

## 原实例的借用与撤回

`actionsFromComposition` 只从实际协调器借用当前 graph 的实例。调用者提供由原 profile owner 验证的当前 Node graph digest；读取此值不能触发同步、激活或补救。实际协调器检查 tenant、space、profile、authority epoch、当前 graph、包版本和实例身份。缺失、过期或待发布的 graph 直接拒绝，不切回原单包 host。

异步授权和 graph 读取完成后才同步取得 lease。业务派发、任务交接和普通结果返回前再次同步借用当前实例，比较最初取得的实际 identity 对象，并立即释放检查 lease。提供者撤下导致消费者不可用；同一个包重新 setup 产生的新 identity 也不能替旧调用提交。已确认的任务 COMMIT 继续返回原 durable receipt，不做后置撤销。

Task Application 在最后的异步授权与内容校验完成后签发内部 opaque 检查对象。原 SQLite/PostgreSQL Turn 事务在实际写入之后、COMMIT 之前同步消费它，再次检查原实例。对象仅存在于宿主内存，不能由 JSON、HTTP 或插件参数伪造；它绑定完整 actor、安装 pin、实际 admission 和 Run binding，只能拒绝提交，不能替代原授权、计费或租约。旧的仅提供异步 `assertCurrent` 的宿主接口保持兼容。

这采用[DSH 与 Cordis 研究](dsh-plugin-foundation-review-20261009.md)中的依赖与实例生命周期约束，保留 CrewON 原协议、授权和事务边界。受保护项目资格仍由原 Host/Run 证明，graph 和安装状态本身不能授予项目访问权。

## 实际验证与产品缺口

2026-10-12 的 Host 增量 `actionsFromBorrower` 已支持原 Profile 返回的真实 lease 与物理释放句柄。它验证 NodeHost 私有签发记录，拒绝复制、已释放或带额外字段/getter 的借用句柄；同步末端检查仍从同一 owner 重新借用并比较实际 identity。成功、拒绝、provider 撤下及已确认 COMMIT 返回均释放原句柄，不只释放其中的 raw lease。该能力不启动、同步或修复实例，没有新的 manager 或 SDK/HTTP 数据形状。

固定 Node 24.19.0 的七文件专项 57/57、零跳过，其中新增十项：九项通过真实安装模块、原 UI Application、原任务/计费服务和 SQLite 验证物理释放、授权撤回、实际 INSERT 后拒绝 COMMIT 及保留 durable receipt；另一项通过真实 Native `DesktopPluginInstallationRuntime`、文件型 profile claim、已安装消费者/提供者与实际 UI mount 验证同一共享服务、一次 setup、调用中停用 provider、以及关闭等待正常结束。Host/Control 类型检查和边界检查通过。这是服务链与 SQLite 证据，不是正式 TaskOwner、Worker、浏览器或桌面验收；本次未运行 PostgreSQL。

测试使用真正安装的提供者和消费者包、原安装/选择/组合 ledger、原 UI Application、真实协调器、原 Task Application 和计费事务。覆盖服务消费、生成任务、v2 查询及回放、提供者撤回、同包重新 setup、异步末端撤回、原 COMMIT 回执保留，以及缺失 graph、外部 profile/epoch 和伪协调器拒绝。原单包 action API 保留兼容。

固定 Node.js 24.19.0、真实 SQLite 与自有 PostgreSQL 18.6：Host 七文件回归 63/63、零跳过，其中新组合测试 18/18。四项通过真实 UI 操作，在原 generation/query admission INSERT 已成功之后撤下实际 provider，确认整个提交回滚、没有新任务或额外扣费；这些负例修复前曾失败。Task Application/Store 的独立回归 207/207、零跳过，另覆盖 opaque 对象伪造、异步 active 拒绝、旧 Host 兼容与已确认回执重放。组间重叠，不相加。它们是原服务链与数据库行为证据，尚未在正式产品页面操作。

当前 `InstalledPluginTaskActionOwner` 仍按包创建单独 NodeHost。下一步产品接线需要：

1. 原 Task Core 提供唯一、作用域受控的 bridge，服务注册和 UI action 共用它；不把每个 action bridge 的 invocation map 混用。
2. 原 Profile 的[只读实例借用](plugin-profile-node-borrow.md)及 Bridge 物理释放适配已接线并验证，UI-only 节点的公开 metadata digest 不代替私有 Node graph digest。正式 owner 接入继续保持原 claim/head/全部 selection 的同步检查及物理借用 join；业务调用不持有管理队列。
3. 移除该路径的单包 setup；保留原安装批准、文件核验、PDP、scope/epoch、mount 和任务回执检查。启动装配必须先完成原 Task Core 与 profile service 的绑定，再开放调用入口。
4. 实际 Web 验证安装、启用、UI/Agent 调用、停用提供者、恢复、升级/回滚、卸载和冷启动；通过后再更新正式桌面。

本轮不安装业务插件、不改变中央 Agent 对话框或基础 UI、不部署、不开放新项目归属 writer。原管理入口隔离的范围和剩余路径分别见[已接线入口](plugin-project-legacy-access.md)与[剩余清单](plugin-project-isolation-remaining-entrypoints.md)。
