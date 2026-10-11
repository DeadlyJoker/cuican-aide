# 原 Task Core 与原插件实例的启动绑定

2026-10-12 的源码增量把正式 `DesktopPluginRuntime` 的普通 UI 任务路径接到原 `InstalledPluginTaskRuntimeCore` 和原 Profile/Coordinator。Native 无积分任务与独立报价的个人积分任务均使用同一条接线。没有新管理队列、数据库、实例管理器、Task 或 Run；尚未部署 Web 或桌面。

## 固定服务目录与唯一任务桥

`DesktopPluginTaskServiceBinding` 是 Host 内部转接线，只持有真实 configuration、registry、authority、SQLite parent、installation 和 Task Core 的引用。固定的 `crewon.tasks` v1/v2 目录声明自己的 adapter 实现身份，绑定前不能取得端口、启用依赖它的 Node 包或发布准备好的实例，optional 声明同样受门禁。纯安装仍可进行。Core、安装 runtime 和 binding 都须是原生产构造函数签发的真实对象；结构复制、字段 getter 和其他 parent 不能替代它们。

原普通 TaskOwner 在这一装配模式中只持有一个 Bridge，v1/v2 服务与所有普通 UI action 共用其 invocation map。包缓存只保存已验证的当前 descriptor、selection 和包，不执行 import/setup。动作借用原 Profile 的实际实例和物理释放句柄，保留原 actor、源批准、包字节、PDP、UI mount、任务 pin、报价、计费、提交前撤权检查和 durable receipt。关闭先同步拒绝新调用，再由原 Owner 和 Profile 等待真实调用与资源清理。

任务 UI 政策 epoch 与 Native 组合 epoch 是独立批准的版本。前者仍由原 Bridge/PDP 核验，后者仍由原 Profile/claim/current graph 核验，不能用字符串相等替代两个原授权检查。

## 显式启动与冷恢复

原 Runtime 完成真实 Task Core、Node 服务和 UI 服务绑定后，才在原生命周期中显式启动 Profile 恢复、元数据发布和实例协调。恢复后台进行，Runtime 不等待任意 Node setup；任务 action 只等待这次实际启动 promise，并在等待后重新检查原 invocation 和全部授权，不在 action 中触发 import/setup。Root/原 Profile 关闭仍等待实际恢复和清理。真实阻塞消费者 setup 时，Runtime 返回且原 authenticated configuration 读取仍成功；任务 action 则等待实际恢复，释放后重放原回执。此证据不等于完整账号页或 UI catalog 验收。原恢复模块抽出到 `desktop-plugin-profile-recovery.ts`，继续使用原 operation 对象、Native 复核、包核验、发布 stamp、依赖身份和 cleanup。读取状态、借用及重放 selection 回执仍不恢复代码。零启用插件不执行该恢复。

恢复按精确 service/API version 查找实现，允许实际同时存在的 tasks v1/v2。已有的可选 provider 也先于 consumer 恢复；缺失的可选 provider 不被发明出来，必需 provider 缺失和依赖环仍拒绝。没有改变已保存的 selection 或历史任务回执来适配新目录。

## 实际证据与剩余范围

Node 24.19.0、真实文件型 SQLite、原生产构造函数及本地命名离线 peer：十一文件 89/89、零跳过；Control 类型检查、边界检查通过。五项新测试覆盖 tasks v1/v2 未绑定时的 mandatory/optional Node 选择拒绝、getter 伪 Core 拒绝，以及正式 Native 普通任务的共享服务对象、一次 setup、提供者撤回/恢复、关闭、重开与旧 receipt 重放。该正例的纯 provider 真实消费必需的 tasks v2；消费者真实消费同一 provider 与 tasks v1，重放不额外 setup、不新增 Run。旧回归同时验证独立个人报价/积分、任务政策拒绝、旧 UI epoch 拒绝及关闭期间已确认 COMMIT 的原回执。

证据：[Control 回归](../output/plugin-foundation/shared-task-binding-20261012/control-regression.log)、[类型检查](../output/plugin-foundation/shared-task-binding-20261012/control-types.log)、[边界](../output/plugin-foundation/shared-task-binding-20261012/boundary.log)。这不是完整 Worker、外部模型、供应商、浏览器或桌面执行证据；本次没有运行 PostgreSQL。

仍未完成的范围：

1. 专用 project generation/query/historical-query owner 仍有自己的包 Host，需要接原项目能力与共享实例，同时保留独立项目批准。普通 TaskOwner 的完成不能替代这些入口。
   原三个 ExecutionBridge 的 Host-only 借用通道现已有 32 项 Host 与 31 项原 SQLite Owner 回归；正式 Owner 尚未接入，尤其历史旧包仍须原 Run/composition 证明，见[项目执行借用](./plugin-project-execution-borrower.md)。
2. 当前业务执行 registration 仍拒绝 execution 之外的 mandatory 服务，不能删除这一限制冒充执行 Host 已实现依赖。本次消费者保持已有 optional 声明；它在 setup 中读取真实已启用 provider。适配必需服务与 Worker 的真实服务目录、恢复和执行，仍需完整接线与行为验证。
3. 没有原 Native Profile owner 的 generic/Standalone Task Core 保持原兼容路径，不能接受 JSON 伪造共享 binding 或自动获得 Native 借用权。
4. 正式产品的安装、启用、UI/Agent 任务、升级/回滚、停用、恢复、卸载和完整执行先在 Web 验收，再更新桌面。当前业务插件保持卸载，本增量不改变宿主 UI。
   随后已修正纯 Node provider 缺少 UI publication 导致目录整页拒绝的问题：只排除真实核验的纯服务包，保留原 UI 权限，最终混合目录与任务回归 265/265、零跳过。范围及证据见[目录过滤](./plugin-node-catalog-exclusion.md)。它仍不能替代上述完整 Web 与 Worker 验收。
