# 已确认媒体输入与原 Tool IO

2026-10-06。宿主内部真实 Tool IO 接线已实现；安装包的实际媒体 handler、Main、项目结果回写及 Agent/手动页面还需联合接线。此项不宣称八阶段自动制作、正式桌面媒体入口或新的远端生成已交付。

## 放进同一条执行链

沿用[阶段执行契约](./short-drama-stage-execution-contract.md)与[双入口规格](./short-drama-orchestration-spec.md)：Agent 和手动入口使用相同项目输入、执行意图、TaskCore/Run、候选和采用指针；包内工作流只负责渲染及解释供应商结果。Krea2、T10、D18 和后续视频/声音/合成都属于同一个短剧插件。

实际 `InstalledPluginRuntimeResolver` 对短剧 `media.generate` admission 要求显式提供真实 `ProjectMediaRunContext`、已经启用[候选占用协议](./project-media-operation-protocol.md)的原 native operation store，以及宿主部署审查的工作流模板。媒体依赖必须复用原 IO 配置中的同一个 operation 实例，并绑定同一个原 InstalledPluginRunContext；没有依赖或受控网络配置时拒绝运行。普通插件、原概念图及历史通用 operation 继续使用原路径，不自动取得媒体服务。

为控制高频模块规模，把原网络 owner 构造和工具声明检查抽到独立模块，保留原包/配置/PDP/批准重核与资源退场。新私有边界使用真实类、原型方法和原快照 WeakMap，不把 DTO、副本、实例方法替换或自报版本当作执行资格。

## 插件输入服务

新增具名 Host Service `crewon.project-media-execution@1`，利用原 Node setup/service hook；冻结 SDK 的源代码、dist、tar 和公共 IO 形状不变。setup 只能取得服务，不能读取确认输入或获得派发资格。`readInput({command})` 必须位于原 Worker dispatch/checked alias 的实际 IO invocation 内，逐次核身份、独立用途、媒体读取及原接受历史。

尚无占用时，返回 `new`、原输入引用、确认提示词、确切工作流及已核目标素材路径。读取过程通过实际素材服务重核当前输入 head、当前采用来源及原目标字节，期间撤权、关闭或取消拒绝返回。

已有占用时，返回 `existing`、原引用/工作流及原 operation；不返回新提示词，不重新准备、读取源图、上传或核当前参考字节。不同 Tool 请求键仍能通过原 SDK `load` 和受控 GET 查询这个原 operation。失败、成功或受理未知均保留原占用；明确新候选须经新的业务执行意图和 Run 准入。

宿主服务生命周期属于实际 resolver entry 和 IO owner；它不绑死到第一次 acquire 的临时 signal。单次调用仍使用自己的原 Worker signal、owner 关闭信号和原超时。退场会取消并等待已经启动的实际检查/HTTP，而不是让它们成为后台游离操作。

## 核对实际渲染图

模板、完整模板摘要、提示词槽、逐角色图像槽和输出节点由部署审查固定到确切包/manifest/implementation 身份。模板存为独立冻结副本；需要唯一匹配，不能使用最新工作流或另外一个包的模板作为 fallback。

插件仍自行渲染图，宿主用纯校验器构造期望值并比较完整请求摘要。目前 T10/D18 只允许改变：

- 已确认提示词的指定槽。
- 原 operation 对应的输出前缀 `crewon-<operationId>`。
- 按已确认角色顺序取得的原目标图像槽，使用明确的 `[output]` 标记。
- 原 operation 的 `prompt_id`、`client_id` 和相关 ID。

原模型选择、种子、连接、关闭标志、负面提示及其余输入保持模板值；额外节点、替代文件或其他提示词在原 operation 领取前被拒绝。模板支持当前两个经过审查的图，不是任意图导入器。原适配器的提示词上限为2000字符，过长输入拒绝执行，不截断或扩大旧协议限制。

ComfyUI 素材协议保存的 service origin 带根路径 `/`，受控 JSON IO 使用标准 URL origin。比较时规范为同一 origin；不能因此忽略确切安装配置、目标修订或已核素材身份。

## 第一次发送与原请求观察

第一次 `reserve` 在实际 invocation 内核完整图、当前字节和独立 submit 用途，再调用原 native reservation 事务。原 operation 和候选占用共同提交。只有此次实际 `created` 能取得一次性 dispatchRef；它在任何 await 前消耗，失败不续发。

POST 前再次核 operation 和确认输入；DNS 之后重新核原网络授权、PDP、Run/包/配置、原占用及完整提交和目标字节。最后一个检查 await 之后再核原 Worker 派发资格。submit 只接受 `extension.image.generate`；observe 接受对应 generate/read 能力且仍需独立观察许可。

已有或未知记录只能沿原 operation 观察。按不同 Tool 键直接 reserve 第二条记录会被实际 native 占用拒绝；运行时仅把已有媒体槽的图像生成重放分类为 observe，不把项目编辑等其他 mutation 降级为观察。

实际收到的供应商响应可在晚到撤权或取消后保存原证据。此时 `advance` 只核原 dispatch 身份、实际响应证据、不可变候选/operation 身份和原 CAS，不发新网络，也不要求再次取得新 submit 许可。供应商响应丢失时保留 submitting/原 ID，不能靠新 Tool 键重发。

## 验证和后续

检查使用真实 TaskCore/Run、原队列领取和 leased start、SQLite/PostgreSQL、实际采用参考、加密 PNG 归档、准备 journal，以及原 IO owner 和 Worker 私有 dispatch/alias proof。安装目标元数据、publisher/PDP/部署审查、DNS/供应商响应及工具回执签发为具名夹具；工具回执签发不是完整 RuntimeWorker 循环验收。

独立核验冻结 Short20.0.2 完整包后，调用其实际导出的纯 T10/D18 渲染适配器与宿主校验器对照。这个包不是测试 Run 中的具名安装目标，也没有执行新包 setup/实际媒体 handler；不能据此宣称安装插件全链路通过。

覆盖原提交/状态推进、不同键查询、完整图篡改、提交前/后 DNS 字节和用途变化、原 Worker 取消、受理未知、双库与归档冷重开、晚到证据保存、无资格的 setup/命令副本、错误原 reader、缺少媒体依赖/网络、IO 关闭等待，以及其他 mutation 的原权限。相关回归 **303/303** 通过，零失败/取消/跳过；新增29项为其中子集，各轮不重复累加。Application/Store/Runtime-worker/Control类型、架构边界、TS/仓库格式以及冻结SDK/完整包/App文件核验通过。相关日志、失败修复和 owned PostgreSQL 正常退场记录见 `output/extensions/checks/project-media-execution-io-20261006/`；验证汇总以其中 `verification.json` 为准。

首轮发现合法素材 origin 与标准 IO origin 比较失败，已修正产品代码。测试的总 operation 行数包含已有来源任务，现按原基线核新增记录；未删除旧记录或放宽幂等保护。首轮明确结束自有测试子进程，不算完整通过；随后92/93的原审查输出解析错误与类型检查失败保留，在具体审查模板中构造合法字段但错误的输出类验证拒绝。最终303项通过，三轮自有PostgreSQL正常停止并按目录身份清理，运行均已结束。

下一项在新短剧版本实现实际媒体 handler 的 new/existing 分支与原查询适配器，再把真实结果核验、候选回写/采用、Main 组合和双入口接在同一业务命令上。随后接结构化分镜和有界跨阶段计划，完整目标保持 ACTIVE。原前端、冻结 SDK、完整插件包和用户 App 保持；积分继续后置。
