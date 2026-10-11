# 查询保留原生成 Run 的组合锁

2026-10-12。插件共用原 Task、Project、Profile、Node Host、Turn、Run 与数据库。共享目录按各原 Bridge 的私有 invocation reference 分派，不向普通任务授予项目提交资格。原 Native generation/query Owner 长期持有各自 Bridge，借用同一 Profile 的实际 Node 实例；请求不另行 import/setup。本文只记录本轮已验证的源码增量，不代表项目工作空间、完整管理隔离或 Web/桌面交付完成。

## 原因与协议

原生成任务可以保存 `crewon.extension-run-binding.v1` 组合锁，但查询始终创建 v0 binding；Domain、Store 和 Worker 还明确拒绝组合查询。不能仅去掉 Domain guard，也不能把测试的组合模式关掉。

查询现在保留原源 Run 的 binding 版本；原 v1 查询必须复制原生成 binding 中的整个 composition reference。Domain 同时校验版本相等、profile/epoch/revision/lockDigest 完全相等、原生成 admission、原 Run 与 operation、原配置和完整执行目标。源 v1→查询 v0 的降级，以及源 v0→查询 v1 的人为加锁仍拒绝。当前查询 actor、principal、action、epoch、选中包与回执独立验证，不以原生成许可替代当前许可。

SQLite/PostgreSQL 的原 Turn 提交交易先核验当前查询安装许可、实际原 admission/funding/operation，再由专用内部查询分支读取同库保存的源 binding，重新验证完整链接，并读取该 binding 引用的不可变原 lock。查询不读取或提交当前 head，不要求旧 provider 仍处于当前 enabled graph。原生成分支继续校验当前 head、全部 enabled selections 与准确包 pin；普通 Run 写入口没有获得查询分支。没有新增数据库或迁移，没有新增公开 HTTP、SDK 或持久 DTO 字段；v0 和原 v1 generation 行为保留。

Worker 的实际 Run reader 先校验原持久查询与源 Run，再用原 source admission 核对原 graph 的 epoch 与 root 包，保留当前查询 admission 的执行身份。恢复图的 expected epoch 来自这份已验证的原 lock，不能用当前查询 epoch 重写它。每个实际 provider 仍经过原 package byte、安装记录、发布者批准、当前读取权限与 live owner 范围检查。查询图准备、发布与借用使用 observe 目的；原 tool 授权仍拒绝查询调用 mutation 操作。读取旧图不等于保留被撤回 owner 的执行权。

原 installed query host 只有在部署显式提供实际 composition store 时接受 v1 源。它先读取原 Run 与 operation，再验证原 lock、当前账号/profile/读取权限和 live owner，随后检查原实际包和 runtime readiness。未配置该能力仍在加载私有包前拒绝；不会伪造新 Run、派发 Tool 或调用模型来证明 ready。

## 验证与边界

后续已接入可信同进程部署的原 Core 实际端口，原 Native Worker 执行/恢复三项失败在该接线下通过，未删除原锁声明。真实 UI 引用跨 Worker 实例兑换仍拒绝，原来源关闭后端口同步撤回。下文保留此前的失败证据；正式跨进程目录发行仍未完成，详见[Worker 共享宿主服务](./plugin-worker-shared-host-services.md)。

- 原 Native UI→Project Owner→共享 Profile→实际 Node→原 Application→真实文件 SQLite：生成、查询、重复请求与关闭重开。每个生命周期只 setup 一次，真实 Run 为两个，重放不新增。源 Run 仍运行时查询使用独立 Thread，保留原单 Thread 仅一个活动 Run 的规则。元数据 readiness 使用明确命名的离线 peer；不是生产 Worker/模型或完整 Web 证据。
- Domain 拒绝升级/降级和每个原 lock 字段的替换，查询 admission 不能成为生成 admission。
- SQLite/PostgreSQL 两包组合：禁用旧依赖并创建新 head 后提交查询，保留原 lock；并发重放和物理连接重开不额外收费。真实数据库的 binding 故意损坏后，读回拒绝。模型及供应商未调用。
- 实际 Worker resolver 从真实安装包恢复旧 provider 图，scope 撤回后拒绝再次获取；查询调用生成 Tool 在插件 execute 前拒绝，退出清理实际 runtime、root 与 provider。该正例的查询元数据预检为明确 fixture，不能当作业务工作流查询已执行。
- 实际 installed query host 在原包升级后核验原 v1 源和原包 readiness，未创建 Tool runtime；账号读取撤回或 live owner 撤回后拒绝。它覆盖实际包预检，不能代替 provider 服务目录完整发行。

证据位于 `output/plugin-foundation/shared-task-binding-20261012/`。本轮自有 PostgreSQL 仅用于测试，未操作产品数据。Domain/Application/Store 组 142/142、Control/Host 组 121/121，均零跳过。Worker 组 87/90、零跳过，三项原 Native 组合执行测试失败：一项发现原 lock 还包括共享任务服务 v1/v2，另两项在物理恢复时报告 `plugin_composition_host_service_conflict`。共享任务服务元数据生产者在本轮以前的 HEAD 已存在；这是现已复现的正式目录接线缺口，不能把它视作环境问题或修改期望来销账。本轮新增 Native、Store、Worker resolver 和真实 query host 的正例均通过，不代表完整 Worker 回归通过。

下一步必须将同一真实任务服务的 scope 与调用资格接到 Worker 的实际宿主目录：原 lock 中 `crewon.tasks@1/@2` 对应 `crewon.desktop-task-core-binding.v1`，但 `openInstalledPluginCompositionRuntime` 当前只收到原 execution registry 以及已配置的项目/media 端口。不能从 lock 的 JSON 自行制造 task grant，不能冒用源 UI invocation，也不能删掉原 edge/hostService 让旧图变成另一张图。需要实际管理服务实现、真实 UI/Run/Tool 调用资格的边界和目录版本一起审查；跨进程 delegate 必须有明确发行、撤权、取消及物理退出责任。

Domain/Application/Store/Control/Worker 类型检查、boundary、`pnpm format` 和 diff 检查通过。原 Native 测试的锁元数据断言现明确核对执行服务和原 Task Core 的 v1/v2 服务，未移除任一声明；独立复跑 2/5，通过的仍是 legacy 与末端撤权负例，实际 Worker 执行/恢复三项仍失败。新证据 `query-native-service-gap.log` 保留这些失败，不以本轮正例替代。

仍需：历史 Project Owner 的旧实例借用与实际原锁资格；Worker 对必需业务服务的完整目录发行；metadata ownership 新创建交易与所有产物访问的统一 scope fence；Main/Control 工作空间与中央 Agent 的真实接线；Web 插件安装、升级、回滚、恢复、卸载及真实聊天/产物闭环。业务插件继续保持卸载，以上验证没有更新正式 App。
