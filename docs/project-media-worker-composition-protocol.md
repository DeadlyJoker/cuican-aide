# 已安装短剧插件的真实 Worker 媒体执行

2026-10-06。这一项接通已确认媒体 Run、实际已安装 Agent 工厂和原 RuntimeWorker 工具执行循环。完整八阶段和双入口的产品契约见[编排规格](./short-drama-orchestration-spec.md)，交付范围见[实施进度](./incremental-extension-progress.md)。

## 宿主装配

原 `InstalledPluginExecutionConfig` 增加可选的内部 `projectMedia` 配置。没有这一字段时保留原插件路径；启用必须同时具备原 `executionIo`。这不是插件、模型、HTTP 请求或页面可以传入的配置，也不修改 SDK。

可信宿主提供明确的材料工厂、元数据权限、提交/观察权限及固定执行审查。工厂收到真实父 Store 和取消信号，返回实际 `ProjectMediaMaterialPreparer` 与只关闭其自有资源的 `close`。父 Store 借用；工厂失败时负责清理尚未交出的资源。

原 standalone 组合入口现在等待媒体准备，然后拥有实际解析器。准备显式迁移媒体关联和原 external operation 扩展；原 Control 侧输入、源材料和准备记录必须已经存在，缺失或损坏拒绝启动。这不会从安装回执推造业务状态或自动生成历史。

父 Store 每次创建的 external operation adapter 有独立的媒体启用状态，因此准备只取得并迁移一个原生实例，同一实例供 Run 上下文、媒体边界及受控 IO 使用。准备回执由内部 WeakMap 关联实际父 Store、扩展 adapter、不可变配置和材料服务；复制回执、更换 Store/adapter 或配置身份均不能替代准备。

配置按自有数据字段读取，拒绝 accessor、Proxy、额外字段及非法审查。首次捕获固定方法和审查；重复传入同一原对象得到同一捕获身份，后续修改不改变已准备 owner。关闭后不能用该准备回执新建解析器。

## 原执行与恢复

实际已安装 Agent 工厂从完整包的业务清单编译 AgentVersion，保留原模型和基础工具。原 Worker 从真实队列领取已准入媒体 Run，读取真实安装/配置/执行版本，签发实际 Tool receipt 和一次性 dispatch 权限，调用安装包的 Node 工厂及媒体工具。

`media_submit` 和 `media_observe` 的模型参数均为空对象。模型不能提供提示词、路径、工作流、项目或 Run ID。真实媒体边界从原接受关联读取固定输入和材料；首次提交沿原供应商占用及受控 IO，观察只读原操作。供应商受理不等于成果成功，Worker Run 完成也不等于项目采用。

供应商响应后、Tool receipt 提交前中断时，冷恢复沿原实际 receipt 和 operation 继续观察；不重新提交，不重新准备源材料，也不按新的输入 head 重写旧请求。当前禁止新提交仍可在独立观察权限下恢复原任务。

解析器关闭先禁止新借用并等待实际借用、调用及 Node/IO owner 退场，再关闭材料工厂交出的资源；父 Store 最后由原组合生命周期关闭。等待供应商物理请求期间，不得提前释放材料 owner。失败准备会关闭已返回的 owner，原父 Store 保持可用。

## 完整包兼容修正

原冻结 Short21.0.0 的媒体工具描述与业务清单不同。原 Worker 对完整工具目录做逐字段比较，因此实际执行前拒绝该包。此前 handler 检查只核对工具名称，不能作为完整 Worker 验收。

新的 Short21.0.1 从业务清单取得媒体工具描述，保留原严格目录检查。沿原完整包构建流程和冻结 SDK tar 独立构建；包内 `ui.mjs` 复用 Short21.0.0 的完整原字节并重新生成文件摘要清单。原完整包、SDK、宿主 UI 源码和已冻结 App 保持。

新包：`output/extensions/installable-plugins/short-drama-media-worker-20261006/short-drama/21.0.1`。

摘要：`sha256:fc7e827cb5f84bbb9d4b6d9ba2a8787c6cc1b428bef75b7fe3a28ec3019a2aa2`。

## 验证边界

新增双库检查使用实际文件安装、业务注册、AgentVersion 发布/工厂、原 TaskCore、队列、RuntimeWorker、工具回执、原生 SQL、加密 PNG 材料及结果候选。T10 输出节点129、D18输出节点17经过真实 Worker 执行，随后由显式宿主调用原结果发布服务，核对原项目/执行/Run/输入修订；这里尚未安装自动发布协调器。

模型流、权限/部署审查、DNS及供应商响应为具名夹具。新增检查没有调用私有 Tool 回执签发 helper，没有执行新的真实远端生成或图片 GET。关闭重开是真实本地 owner/数据库的冷恢复，不冒称跨操作系统进程或正式桌面联合验收。

下一项是可信 Main 中的共享媒体命令与结果发布协调，再接原 Agent 和手动工作台的同一入口。媒体候选采用、结构化分镜、视频、声音、剪辑交付及有限跨阶段自动执行继续按既有顺序实施。用户 App 未更新，积分继续后置，完整目标 ACTIVE。

证据：`output/extensions/checks/project-media-worker-composition-20261006/`。完整回归中磁盘耗尽造成 PostgreSQL 崩溃的一轮单独保留，不能计作通过；后续分批运行同一完整文件清单，只调整自有测试实例的 WAL 容量和文件并发，不改变事务持久性或产品断言。

## 共享宿主命令（2026-10-07）

素材与候选实现现已提取到私有 `@crewon/media-runtime`，原 Worker 路径重导出同一实现。新增[共享生成命令](./shared-project-media-commands.md)将实际素材准备、原输入资格、原 TaskCore 受理和已接受请求恢复连接在一起；页面与 Agent 的宿主适配器将复用它。该命令尚未装配到正式 Control/Main 的公开入口，候选采用和可见按钮继续接线。
