# Worker 复用原任务服务的实际端口接线

同一套管理能力不能只共享服务名称。原组合锁记录 `crewon.tasks@1/@2` 的实现为 `crewon.desktop-task-core-binding.v1`；实际 Worker 必须取得与这些版本相符的原服务端口，才能恢复该图。本次没有删除原 edge、重写旧锁或创建另一份任务管理器。

## 实际实现

原 `DesktopPluginRuntime` 在实际 Task Core 存在时提供内部 `taskHostServices`，内容来自同一 `DesktopPluginTaskServiceBinding` 的原目录。它不是 HTTP、renderer 或插件 UI props 字段，不能通过 bootstrap JSON 请求这项能力。运行时关闭仍同步撤回原 binding，随后加入原 owners 的物理退出。

Worker 的显式 `compositionExecution` 接受可信部署传入的真实 `hostServices` registrations。配置捕获将实际实现与 metadata 一起冻结，并核对 service、API 版本、实现 ID 和 revision 与显式部署目录一致；accessor、重复项、只有声明没有实现以及目录版本冲突均拒绝。原执行注册、项目和 media 服务仍使用各自的实际 owner。

这些端口只提供给已核验原组合的执行实例。旧 v0 运行不因配置新服务获得额外端口。原组合锁、实际包、当前账号/profile/Run、原 provider 图与提交/观察资格仍沿用原核验路径。缺少实际端口的部署继续拒绝恢复，不能从保存的 JSON 自动构造实现。

原 binding 直接转发给原 Core 的私有 invocation router。提供服务不签发调用凭据；Worker 的实际 Node identity 与 UI 的实际 Node identity 分别绑定，不能通过同样的 plugin/version/digest 冒充另一个实例。原 UI 签发的有效调用引用不能在 Worker 端兑换，即使两者借用同一 Core。

## 来源归属核验

共享端口不能只靠相同的实现 ID 对接。非空 `hostServices` 现在必须携带原来源的同步 `hostServicesOwner` 资格检查；只有 metadata 的旧部署保持原行为。原 `DesktopPluginTaskServiceBinding.assertWorkerOwner` 检查实际 Core、原 Store 关联、live authority、Profile 所有权及账号/profile 范围，运行时内部提供绑定至这个实际实例的检查函数。

Worker 从已核验的持久 Run admission 和 scope 生成 actor/principal、tenant、space、profile 输入，不读取插件输入中的 owner。原 Native Worker authority 先核验，随后在原图准备、包授权的最后异步检查后、同步发布和缓存再次借用的末端复核来源。账号或 profile 不匹配拒绝；原 Control 关闭后，已缓存的 Worker 也不能继续借用旧服务图。来源检查返回异步 Promise 或任何非 `undefined` 值都拒绝，不能将未完成的检查当成批准。

这一步不签发 Task/UI/Run grant，不改变原 bridge 的实例引用判断，也不授权插件的项目列表、工作空间或产物访问。实际 Native 测试覆盖账号四字段和 scope 三字段拒绝、缓存撤回，以及来源在真实包授权 await 内关闭后不发布 Worker factory。启动准备撤回沿用原 composition activation failure 汇总，未放宽原 Native 撤权错误检查。

## 验证与交付边界

实际 Native Control、文件 SQLite、安装的 root/provider ESM 和实际 Worker resolver 在同一测试进程内接入上述原端口。原组合执行、同 epoch 恢复、禁用 provider 后观察原回执、重新打开 Control/Worker 和末端撤权通过；模型与 readiness peer 仍是明确命名的离线 fixture。

新增负例将仍有效的真实 UI invocation 暂停在原 Node 中，再从 Worker 的实际绑定端口兑换，原 bridge 拒绝 `plugin_invocation_owner_mismatch`；继续 UI 调用得到原重放回执，没有新增 Run。原 Control 关闭后，已借出的 Worker 任务端口拒绝 `desktop_plugin_task_service_unavailable`。没有传入原端口的对照部署仍报 `plugin_composition_host_service_conflict`，不会进入插件执行。

这证明可信同进程部署可以复用原管理器，未证明正式桌面的 Control/Worker 跨进程连接已完成。正式 Native Worker 的默认配置仍只发行 execution registry；本次没有改为依赖另一个应用目录、引入额外 runtime，或把本地测试参数写入生产配置。下一步需在原私有进程 transport 中传递宿主签发的实例资格与服务目录，并保留来源、scope、生命周期、取消、撤权和重开核验；不能直接跨进程复制 UI 引用来代替资格。

现有 `/private/v1/installed-plugins` 连接提供 catalog、configuration、readiness、candidate preparation 及原查询预检，属于 Control 到 Worker 的元数据请求。其协议没有反向任务执行或实际实例发行操作。不能因为连接已认证，就用这个 metadata 通道接受任务或把 actor/profile DTO 当成调用授权。后续反向接线须先从原 Store 核验 Run/原锁归属、绑定实际 Worker 生命周期和实例，再进入同一个管理器；UI 引用的跨实例负例仍必须成立。本次没有新增反向监听端口或开放 Task RPC。

## 原记录资格来源

`DesktopPluginWorkerRunSource` 仅由持有实际 Task Core binding 的原 Control runtime 构造，借用同一个 SQLite Store，读取已提交 admission、回执、Run、查询来源操作和原组合锁。原 Worker 的回执/Run/组合校验移至 Application 共享，Worker 原入口保留别名和原错误语义；查询操作通过原 Store 的 `externalOperationStore()` 读取。来源从原 admission 得到账号、principal、profile、插件和 publisher，不接受调用方填写归属。

来源只签发 Host 内部的不可序列化记录引用，最多保留 64 个、有效期 30 秒，同时最多允许 64 个未完成读取。每次验证重新读取原记录并复核 live owner；复制/JSON 引用、来源关闭、取消、过期或记录变化均不能取得有效结果。关闭同步撤回引用并等待自己的未完成读取，不关闭借用的共享 Store，也不创建 Run。

这项资格只证明原存储记录及来源归属，不是 Node、Task、当前 Run-read 或 Tool 授权，不能直接暴露为插件 RPC。真实 Worker 实例发行、publisher/plugin/project 范围、每次调用权限和跨进程生命周期仍须在正式 transport 接线中核验。Native SQLite 正例覆盖生成与查询共同读取原锁、旧引用在重开后无效、取消和关闭不发布记录、并发与保留数量上限；移出的原 Worker 回执/Run/组合路径共同回归 54/54、零跳过。Application、Control、Worker 类型和边界检查另行核验；这不是 Web/桌面产品闭环验收。

插件项目归属的新创建交易、统一产物权限、工作空间和中央 Agent 的产品接线仍按[同一套管理能力的隔离方案](./plugin-project-management-isolation.md)继续。本次不更新 Web 或正式桌面，也不将这些专项测试称为完整基础建设验收。

本轮专项证据位于 `output/plugin-foundation/shared-host-services-20261012/`：Worker 13 个文件 78/78、Control/Host 5 个文件 27/27，零跳过。Worker 组包含实际 SQLite/PostgreSQL 的原查询 host、组合查询 resolver 和执行生命周期；自有 PostgreSQL 仅用于测试。本次没有修改 schema 或产物存储，不能用这些检查证明所有项目访问已隔离。

来源归属接线的后续证据位于 `output/plugin-foundation/shared-host-owner-20261012/`：相同回归范围新增来源与撤权负例后 Worker 81/81、Control/Host 27/27、零跳过，Control/Worker 类型检查通过；实际 PostgreSQL 仍覆盖原查询与执行生命周期。来源隔离的 Native 正负例使用原文件 SQLite/Core。高频 orchestration 的公开类型和缓存状态已提取到独立模块，原类型导出位置兼容。没有更新正式 App 或声称跨进程调用已通过。
