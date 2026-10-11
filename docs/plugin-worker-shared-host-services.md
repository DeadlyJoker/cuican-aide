# Worker 复用原任务服务的实际端口接线

同一套管理能力不能只共享服务名称。原组合锁记录 `crewon.tasks@1/@2` 的实现为 `crewon.desktop-task-core-binding.v1`；实际 Worker 必须取得与这些版本相符的原服务端口，才能恢复该图。本次没有删除原 edge、重写旧锁或创建另一份任务管理器。

## 实际实现

原 `DesktopPluginRuntime` 在实际 Task Core 存在时提供内部 `taskHostServices`，内容来自同一 `DesktopPluginTaskServiceBinding` 的原目录。它不是 HTTP、renderer 或插件 UI props 字段，不能通过 bootstrap JSON 请求这项能力。运行时关闭仍同步撤回原 binding，随后加入原 owners 的物理退出。

Worker 的显式 `compositionExecution` 接受可信部署传入的真实 `hostServices` registrations。配置捕获将实际实现与 metadata 一起冻结，并核对 service、API 版本、实现 ID 和 revision 与显式部署目录一致；accessor、重复项、只有声明没有实现以及目录版本冲突均拒绝。原执行注册、项目和 media 服务仍使用各自的实际 owner。

这些端口只提供给已核验原组合的执行实例。旧 v0 运行不因配置新服务获得额外端口。原组合锁、实际包、当前账号/profile/Run、原 provider 图与提交/观察资格仍沿用原核验路径。缺少实际端口的部署继续拒绝恢复，不能从保存的 JSON 自动构造实现。

原 binding 直接转发给原 Core 的私有 invocation router。提供服务不签发调用凭据；Worker 的实际 Node identity 与 UI 的实际 Node identity 分别绑定，不能通过同样的 plugin/version/digest 冒充另一个实例。原 UI 签发的有效调用引用不能在 Worker 端兑换，即使两者借用同一 Core。

## 验证与交付边界

实际 Native Control、文件 SQLite、安装的 root/provider ESM 和实际 Worker resolver 在同一测试进程内接入上述原端口。原组合执行、同 epoch 恢复、禁用 provider 后观察原回执、重新打开 Control/Worker 和末端撤权通过；模型与 readiness peer 仍是明确命名的离线 fixture。

新增负例将仍有效的真实 UI invocation 暂停在原 Node 中，再从 Worker 的实际绑定端口兑换，原 bridge 拒绝 `plugin_invocation_owner_mismatch`；继续 UI 调用得到原重放回执，没有新增 Run。原 Control 关闭后，已借出的 Worker 任务端口拒绝 `desktop_plugin_task_service_unavailable`。没有传入原端口的对照部署仍报 `plugin_composition_host_service_conflict`，不会进入插件执行。

这证明可信同进程部署可以复用原管理器，未证明正式桌面的 Control/Worker 跨进程连接已完成。正式 Native Worker 的默认配置仍只发行 execution registry；本次没有改为依赖另一个应用目录、引入额外 runtime，或把本地测试参数写入生产配置。下一步需在原私有进程 transport 中传递宿主签发的实例资格与服务目录，并保留来源、scope、生命周期、取消、撤权和重开核验；不能直接跨进程复制 UI 引用来代替资格。

插件项目归属的新创建交易、统一产物权限、工作空间和中央 Agent 的产品接线仍按[同一套管理能力的隔离方案](./plugin-project-management-isolation.md)继续。本次不更新 Web 或正式桌面，也不将这些专项测试称为完整基础建设验收。

本轮专项证据位于 `output/plugin-foundation/shared-host-services-20261012/`：Worker 13 个文件 78/78、Control/Host 5 个文件 27/27，零跳过。Worker 组包含实际 SQLite/PostgreSQL 的原查询 host、组合查询 resolver 和执行生命周期；自有 PostgreSQL 仅用于测试。本次没有修改 schema 或产物存储，不能用这些检查证明所有项目访问已隔离。
