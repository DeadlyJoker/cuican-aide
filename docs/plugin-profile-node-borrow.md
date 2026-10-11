# 原 Profile 借用当前插件实例

本增量在原 `DesktopPluginInstallationRuntime`、`DesktopInstallationProfile` 和 `DesktopPluginInstanceCompositionOwner` 内增加 Host 私有借用入口。继续使用同一个 SQLite profile claim、安装 ledger、服务目录和 `PluginCompositionCoordinator`，没有新数据库或实例管理器。该入口已在后续源码接入正式普通 UI TaskOwner，见[原 Task Core 启动绑定](plugin-shared-task-core-binding.md)，不能当成 Web/桌面交付。

## 当前状态与生命周期

实例 owner 只在原新 selection 成功同步实际 Node 图后保存私有投影。借用同步检查实际 Native actor/profile、仍持有的文件 claim、原数据库的完整 graph head、全部 enabled selection/package/publisher 与 Native source 批准，再使用私有 Node 图的 digest 取得实际 lease。UI-only 节点保留在原完整图中，不会被拿来替代 Node 图，也不会创建 Node 实例。

新的已提交 selection 在任何后续 await 前撤回旧投影；缺失、未观察、过期或损坏的证明直接拒绝。读取、借用及原 selection receipt replay 都不执行 setup、恢复或同步。安装一个未启用的包不使已有 enabled 图失效。原 Coordinator 仍负责拒绝 pending/失效的实例，提供者撤回仍沿原依赖关系停用消费者。

`borrowNode` 仅供原 Host 调用。调用者仍必须完成现有 identity、安装批准、包字节、PDP 和具体 UI/Run 授权；传入同步最终借用策略不能代替这些授权。它不接受用户的 owner、路径或恢复动作，没有 HTTP/SDK/持久数据形状变化，也不会创建 Task、Run 或扣费。后续 UI 任务接线必须继续核对完整 pin 和原 invocation。

返回值的 `lease` 是原 NodeHost 签发的真实对象，不复制身份或私有 brand；`release()` 同时释放该实际 lease 和原 Profile 的物理工作登记。Host 必须在 `finally` 调用返回对象的 `release()`，不能只释放其中的 `lease`。最多同时借用 128 个。业务不占管理队列；关闭先同步拒绝新借用、撤下实例，再等待实际借用释放和原 cleanup，最后释放 profile claim。原 NodeHost 对遗留 live lease 的拒绝行为不变。

## 验证与剩余接线

固定 Node 24.19.0，实际安装包、源文件、原 Native 配置、文件型 SQLite claim 与原生产构造函数：七个 Control 文件 61/61、零跳过，其中新增八项。覆盖共享服务对象与一次 setup、混合 UI 图、外国账号/profile/包/拒绝策略、冷启动/receipt 不恢复、provider 撤下与真实新 identity、Native 文件失效、实际 head 损坏、借用期间管理操作继续，以及关闭等待真实 lease 释放。关闭负例修复前实际返回 `plugin_host_has_live_leases`，修复后成功等待释放。损坏 head 使用自有数据库的明确负例，不是第二个获权 writer。

Control 类型检查通过。上述是原服务链与 SQLite 行为证据，不包含 PostgreSQL、外部模型、完整任务执行或真实浏览器验收。正式普通 TaskOwner 的共享 Bridge、tasks 1/2、原 Profile 借用、启动门禁与冷恢复已接线；后续十一文件回归 89/89、零跳过，见上述绑定文档。专用项目 owner、必需业务服务与 Worker 全流程仍需接线，再做 Web 验收，最后更新桌面。服务注册和 Worker 能力必须由真实实现提供，不能因 Control 有目录便推断 Worker 可执行。
