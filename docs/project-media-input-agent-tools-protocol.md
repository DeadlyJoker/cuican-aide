# Agent 媒体输入工具：共享记录与执行恢复

2026-10-06。已实现独立宿主服务 owner、原 Worker dispatch 核验及 SQLite/PostgreSQL 写入资格。**Short23 已注册同包 Node 工具，Worker 生产装配与真实 Agent/Worker 调用已验证；原 Composer 入口尚未接通**，不代表用户 App 已能调用。接续[原会话阶段范围](./project-media-input-agent-stage-protocol.md)，产品目标见[双入口交互](./short-drama-product-experience.md)。

## 用户行为

Agent 和手动页面使用同一份 T10/D18 生成输入：项目、业务项、需求/剧本来源、确切参考、提示词和输入版本。Agent 保存后，用户可以在工作台继续修改；重新恢复原工具只能取回该工具已保存的版本，不能覆盖用户后来修改的版本。新的修改必须明确引用当前输入版本。

输入准备不启动上传或生成，不自动采用图片。已确认输入由后续生成命令执行；每项任务依次保留输入、实际运行、候选和采用记录。这个分离同样用于后续镜头、视频和配音阶段，不能用一次生图代表整个短剧流程。

## 可选 Node 服务

`crewon.project-media-input-tools` API `1` 是独立宿主服务。它不扩展冻结的 SDK execution v1，也不新增独立插件包。Short23 同包工具 `media_input` 使用固定参数 `{method, requestJson}`，包含独立便携类型、严格解码器、声明和 Node 注册。模型参数中的 `requestJson` 保留原 manifest 单字段 9999 字节上限；工具输出仍为 8192 字节。缺少可选宿主服务时明确拒绝，不降为自由生图。

| 方法         | 作用                                       | 范围                                        |
| ------------ | ------------------------------------------ | ------------------------------------------- |
| `getContext` | 获取原任务的项目、会话、工作空间和来源范围 | 空请求；身份来自宿主，不让模型猜项目        |
| `getOptions` | 返回本任务固定的工作流与配置修订           | 只是任务目录，不宣称当前供应商就绪          |
| `listInputs` | 查看项目的已保存输入                       | 每页最多 4 项，不返回提示词正文             |
| `getInput`   | 查看最新或指定输入版本的元数据             | 不返回私有传输证据或供应商路径              |
| `readPrompt` | 按确切输入版本分段读取提示词               | 按 Unicode 码点续读，每段正文至多 2048 字节 |
| `saveInput`  | 创建输入或追加修订                         | 冻结阶段匹配、已采用来源检查及版本并发控制  |

工具输出按实际 `{resultJson}` 外层 JSON 计算，总计不超过 8192 字节，包含转义膨胀。写入前先证明元数据回执可容纳，写成功后不回传整份提示词。模型不能传入幂等键、服务地址、凭据、安装目标或执行权限。

当前一个工具包含这些子方法，因此声明保守使用 `project.media-input.write`、`mutation` 和 `reconcilable`；只读页面权限不会隐含授权它。服务部署资格、当前用户、项目权限和共享媒体输入服务本身的权限分别检查。

## 同一原执行与同一事务

`ProjectMediaInputToolsServiceOwner` 只接受由原 Worker 为真实工具回执签发、仍存活的 dispatch。复制命令对象、替换参数、跨 Run/项目、过期租约或缺失独立服务资格均拒绝。它核对原阶段记录、任务摘要和当前项目会话关联，绑定修订也必须相同；关闭时等待进行中的物理调用结束，迟到读取结果被拒绝。

保存携带独立 `crewon.project-media-input-run-commit.v1` 资格，包含原 Run、Tool receipt、队列租约、原始参数、任务阶段及确切安装。目标来自真实安装，幂等键来自原 Run/工具回执/执行/动作身份。共享 Application 接受这个可选宿主资格；原手动页面调用方式保持兼容。

SQLite/PostgreSQL 在保存输入使用的同一连接内，写入前和 COMMIT 前检查原安装、Run、Tool/attempt/step、队列租约、任务 admission、阶段记录及会话绑定。输入、修订和回执原子保存。事务内外部授权检查不再借父库连接。

提交前关闭或撤权时全部回滚；实际 COMMIT 成功后收到关闭仍返回已知成功。工具结果未知时，更换原队列的真实租约和 attempt 后可恢复原回执，旧租约写入失败。这不会重启生图或提交第二个供应商请求。

## 验证及待接线

测试使用真实原 Thread/Turn/Run、队列、Tool receipt、SQLite 文件及正常持久性配置的 PostgreSQL。覆盖 T10/D18 保存、工作台服务读取与手动追加修订、冷连接恢复、Unicode 提示词分段、独立权限、提交前回滚、提交后成功保留及更换真实租约后恢复。宿主服务测试的 PDP、声明及供应商来源历史使用具名夹具。新增 Short23 检查通过真实安装器与 PluginNodeHost 加载完整包，使用真实 manifest、Node 注册与执行策略，跨原 SQL 读写及冷重开；dispatch 签发和 PDP 仍为具名测试边界，没有运行真实模型、原 Worker resolver、Composer 或新 ComfyUI 请求。

日志与核验位于 `output/extensions/checks/project-media-input-agent-tool-20261006/`。SDK、原完整插件包及 App 保持冻结。

同包工具与 Worker 生产装配已完成。下一步补齐媒体输入阶段的原项目/剧本/资产有界读取，再连接原 Composer 发起阶段任务，完成“对话保存 → 插件页面编辑 → 对话继续”的界面联合验收。未部署独立服务时仍保留 `installed_plugin_media_input_stage_runtime_unavailable`。之后继续实际生成/查询/候选采用、结构化分镜和跨阶段执行；完整八阶段目标仍 ACTIVE。

## Short23 完整插件包

`crewon.short-drama` 版本 `23.0.0` 在原 23 项工具上新增一项 `media_input`，未拆分工作流包，未修改原 UI 源码或 SDK。完整包位于 `output/extensions/installable-plugins/short-drama-media-input-agent-20261006/short-drama/23.0.0`。构建使用原冻结 SDK tar，包内仅含独立 Node/UI 产物和自身依赖。

包内 320 项回归（含原页面快照）通过；安装调用与原服务/事务检查 33 项、宿主与便携解码器 10 项通过，均无跳过。实际包调用覆盖 T10/D18、原输入保存、最新/历史读取、手动追加修订、提示词分段、ACK 保留、插件冷重开恢复、缺少服务拒绝、未提交任务的保守取消、关闭等待和迟到读取拒绝。它证明安装包到共享服务这一段，不代替原 Agent 流式和页面联合验收。证据在 `output/extensions/checks/project-media-input-agent-package-20261006/`。

## 原 Worker 装配与真实调度

原 `InstalledPluginExecutionConfig` 新增可选 `projectMediaInputs`，版本 `crewon.project-media-input-tools.v1`。可信部署方通过同步 `createInputs({ store })` 在组合工厂的实际父库上创建共享媒体输入应用服务，配置项目 PDP 和独立 `authorizeService`；该工厂只组合元数据服务，不拥有第二套运行时或异步资源。它不自动迁移来源、不推断 UI 授权，也不从插件参数取得权限。

原 Run reader 读取必需摘要及不可变阶段，核验配置修订、任务、安装、会话、工作空间与原回执一致；宿主私有快照不可复制。只有这样的阶段能得到输入准备 owner。原文字/资产 owner 仍服务原任务；即使同时部署普通项目工具，媒体输入任务也不能借它创建项目、改写剧本或生成图片。当前装配只开放六个 `media_input` 方法；阶段协议预留的原文字/资产读取尚待独立接线，不能据此宣称已可自动发现全部素材。

服务 owner 纳入原安装包借用、dispatch、retirement 和关闭链。每次执行仍由实际 Worker 的原队列租约和 Tool 回执签发资格；事务中的外部检查只调用部署 PDP/包策略/身份解析，不嵌套借用父库连接。关闭先撤销服务并等待实际调用结束，再释放包。

新增验证使用完整冻结 Short23、实际 AgentVersion 编译与安装包工厂、原 RuntimeWorker、双库队列和 Tool/Run 事件。具名模型连续调用六个方法，再发出两段流式回复；保存后可由原手动服务追加修订。保存成功而 Tool ACK 丢失后，关闭全部旧 Worker/插件 owner、冷开原数据库和新 Worker，返回原修订且保留新的手动 head。缺失部署、独立拒绝、跨项目、生成、普通项目写入均不能保存；关闭能等待被挂起的服务调用。模型、PDP 与已有参考来源为明确夹具，未调用真实模型或供应商，也未从用户 Composer 操作。

证据：`output/extensions/checks/project-media-input-worker-20261006/`。原 SDK、Short23 和更早完整包、正式 App 保持冻结。
