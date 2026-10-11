# 同一套项目管理能力的隔离接线

用户已明确：插件项目独立管理归属，管理能力共用。中央保留原 Agent 对话与 composer，插件页面使用宿主右栏。本页确定后续实现顺序，不表示这些尚未接线的产品入口已完成。

## 复用与隔离

继续复用原 Workspace registry、CreativeProject、Thread、Run、Tool、产物 Store、账号与授权服务。插件得到由 Host 绑定归属的管理视图，沿用相同操作和响应，不建立另一套项目数据库、聊天组件或执行器。

“独立管理”指同一套管理能力中的归属隔离，不是每个插件复制一个管理系统。隔离在原服务和存储入口执行，右栏只投影该插件获准访问的项目与产物。即使插件绕过页面过滤直接调用接口，也不能跨归属读取或修改。

| 管理对象 | 继续复用                                  | 隔离边界                                                               |
| -------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| 项目     | 原创建、列表、详情、归档与恢复            | Host 绑定完整归属，SQL 分页前过滤；详情和写入再次校验                  |
| 工作空间 | 原目录分配、registry 与文件访问           | 每个插件项目绑定自己的目录；插件不能自选别人的 root 或 workspaceId     |
| 会话     | 原 Thread、聊天输入框、模型选择与流式执行 | 同一项目可以有多个会话；绑定由原服务确认，打开右栏不迁移当前会话       |
| 任务     | 原 Run、队列、取消、查询与恢复            | 当前实际调用资格加持久项目归属；共享执行服务不授予其他插件的任务访问权 |
| 产物     | 原文本、素材、版本与生成结果服务          | 列表、详情、写入、历史和幂等回放使用相同归属检查                       |

用户明确选择“在此项目中开始对话”时，宿主才沿用原会话创建流程确认项目工作空间。已有会话属于其他项目时不静默改绑，改为打开该项目已有对话或创建新对话。切换右栏项目本身只是查看，不改变中央会话的执行范围。

稳定归属是 tenant、space、principal、actor、profile、plugin、publisher、project 八字段。版本、包摘要、selection revision 和授权 epoch 属于当前调用资格，升级不搬迁项目，卸载不删除旧任务与产物。请求和插件不能自报归属；目录与 workspaceId 由原宿主分配。

打开或关闭右栏不重新派发任务，也不替换中央对话。查看项目产物与选择项目对话是明确操作；切换项目不改写原 Thread 的 workspace 或历史。宿主负责所有布局、主题和会话状态。

任务服务也共用原管理器与运行实例。同一个 `crewon.tasks` 服务目录按各原 Bridge 私有签发的 invocation reference 分派，普通任务、项目生成、项目查询分别保留原提交资格；不存在由插件指定 owner 的通用入口。引用只能选择原 Bridge，不能代替 source publication、实际实例 identity、当前安装授权或事务末端复核。项目生成借用原 Profile 已启动的实际实例，不能在每次操作中另行 setup。

2026-10-12 的接线曾在 Domain 的 `plugin_query_composition_unsupported` 处失败。现已补齐原组合锁继承、SQLite/PostgreSQL 实际源 Run 核验及 Worker 原依赖图恢复，Control 的 Native 项目测试通过生成、查询、重放和重开，未放宽普通生成校验。这个测试的 Worker 元数据预检使用离线 peer，不能证明真实 Worker 执行成功：当时真实 Native Worker 回归有三项失败，原因是原组合锁记录的共享任务服务尚未在 Worker 接线；后续同进程接线及正式跨进程缺口见下节。当前查询许可、原 operation、配置和目标继续独立验证；不得使用当前 head 重新解释历史，也不得把查询资格变成生成资格。范围与剩余交付项见[组合查询协议](./plugin-query-composition-inheritance.md)。本次仍未部署 Web 或桌面。

## 已核实的缺口

原 CreativeProject 的可选 SQLite 只读绑定视图已接通八个原读取方法，完整归属在分页前过滤，保留原独立项目策略和宿主生命周期检查。详见[实现与证据边界](./plugin-project-owned-reads.md)。生产尚未启用，完整修改、Foundation/PostgreSQL 和 Web/桌面仍未完成。

后续已实现原 CreativeProject 的可选 SQLite 受保护创建与回放：项目、initial brief、完整 owner 和范围回执在同一个原交易提交，保留独立项目策略和实际安装核验。默认与生产配置未启用；Foundation、PostgreSQL、完整 CRUD 和真实 Web/桌面仍未接通。[当前实现及边界](./plugin-project-owned-creation.md)。下文保留此前基础阶段和未完成项，不能据此把两入口都视为已完成。

后续 Worker 已支持可信部署注入原 Core 的真实端口，原 Native 组合测试在同进程实际共享 Core 时通过；保留缺少实现的拒绝对照与跨实例调用引用负例。正式 Control/Worker 跨进程接线仍未完成，不能将同进程回归当作生产验收。详见[实际端口接线](./plugin-worker-shared-host-services.md)。

`CreativeProjectOwnerScope` 目前只有 tenant、space、principal；metadata 主键是 tenant、space、projectId。`createdByActorId` 是历史作者，不是插件归属证明。UI 和 Worker 的实时安装、Run、Tool 与策略校验不能补上这项持久归属。

当前 workspace namespace 拒绝已有对话并保护工作空间与 binding，但不证明 metadata 由该插件首次创建。没有对话的旧项目仍可能有该 namespace。不能据此收编旧项目或宣称项目列表、brief、text、asset、历史结果均已隔离。

源码 `154d7f4b7` 已完成原库的 metadata owner 存储基础：显式 caller-owned 迁移、严格完整性检查、八字段记录与真实 stored principal 外键、不可变归属及 SQLite 替换写入保护。迁移不回填 legacy，模块没有 writer/adopt/upsert 或公开资格入口，也没有生产自动迁移。它只为下述原创建交易和绑定管理视图准备数据约束，不能证明现有 CRUD、产物与 replay 已隔离，更不能充当旧项目接管凭据。

metadata 与产物的若干 UI receipt 也缺少 profile、plugin 范围。同账号不同插件使用同一个外部幂等 key，可能命中旧 receipt；只检查写入或只过滤显示都不够。两个原创建入口都要覆盖：`CreativeProjectApplicationService.createProject` 和 `ProjectFoundationApplicationService.createProject`，后者也创建同一份 metadata 与 brief。

## 按顺序实施

### 1. 原项目交易中的明确归属

在原 SQL 事务追加不可变的 metadata 归属 sidecar，唯一占用键对齐真实 tenant、space、projectId，并校验 stored principal。新 project、initialBrief、完整 owner 和该 owner 的新 receipt 同事务首次提交。Host 签发 projectId，用户输入仅包含创作内容与外部幂等 key。

新协议只创建新归属。已有项目、旧 receipt 或历史没有同一协议证明时拒绝；不按名称、作者或已有 workspace namespace 推断归属。旧 metadata、Run 和 receipt 保持原样。新 sidecar 缺失或部分迁移时，新增 qualified 能力拒绝；完整旧版 schema 且新 schema 完全缺席时，旧入口维持旧行为。部分新 schema 不允许回退为 legacy。

真实 Control owner 可以复用当前请求、actor/profile、安装行、实际包字节、发布审批和 Native 现授权检查，但仍须独立检查 `creativeProject:create`。不能将 `project.execute` pin 改名当成旧 createProject 批准，不能构造假 UI invocation。

### 2. 同一套管理方法的绑定视图

Host 从真实 UI invocation 或原 Run/Tool qualification 签发内部访问资格，交给相同 Application/Store 的绑定视图。公开 v0 HTTP 和 CreativeProject JSON 不添加 owner 字段，不用全局可变 request context。

qualified 列表在 SQL 的排序、游标和 LIMIT 前按完整 owner 过滤；详情、历史、产物、写入和 replay 检查同一归属。普通 v0 入口继续管理 legacy 项目，但不能读取或修改新 protected 项目。必须同时覆盖 metadata、foundation/source/proposal、brief/text/outline、asset/reference、generation 与结果选择；不能只限制项目首页。

新 UI qualified 路径使用稳定的内部 receipt 范围，保留用户输入的外部 key。旧 Run 的 Tool 派生 key 不改写；每次 replay 返回前也要核对真实 owner。原安装、Run、Tool、revision、取消及事务末端授权检查继续保留。

创建回执的内部派生规则已实现为 Application 的 `derivePluginProjectCreationReceipt`：七字段稳定归属、原创建入口和外部 key 一同进入版本化摘要，输出不超过原 128 字符上限；请求内容摘要保持原值。因此两个插件或两个创建入口不会因相同外部 key 使用同一内部 key，同一范围内更改内容仍交由原 Store 报幂等冲突。新准备的 projectId 不加入键，否则服务端重试生成不同 ID 会失去回放身份。外部 key 在派生结果中保留；版本、包摘要和 epoch 不进入稳定范围，升级不会改键。这是数据派生，不是创建、接管或读取授权；目前已接入原 CreativeProject 的可选 SQLite 创建事务，并在读取原回执后核对实际 metadata owner；Foundation 和 PostgreSQL 仍未接入。legacy/Run receipt 不改写，不能仅凭这个可计算的 key 放行。

Application 已补内部 `PluginProjectCreationScope` 来源引用。私有发行器先核对原 UI invocation 的实际 membership，再分别捕获 CreativeProject 和 Foundation 的原创建 pin、安装快照与生命周期检查；入口不匹配、普通读取、复制 context/引用和调用结束均拒绝。公开消费者只能核验已发行对象或从这个对象派生回执，不能填写 owner；引用不包含 projectId，未签发创建、接管或项目读取权限。原 Application 的 `creativeProject:create`、Host publication、同连接安装检查和事务末端撤权仍必须执行，SQL 回放也须独立核对 sidecar。来源与派生测试走真实 Application/PluginUI 服务上的命名内存 fixture；新增原 SQLite 创建/回放专项覆盖真实安装和项目 Store。二者都不能证明 Native、PostgreSQL 或 Web 已接通；生产 dispatcher 尚未启用这个引用。

### 3. 原工作空间与项目对话

metadata 归属明确后，原 Native allocator 创建目录并非激活追加原 registry，保持当前 workspace 和活动读取。Main 与 Control 使用私有、真实子进程绑定的分配桥，不增加 renderer 分配 API；准备票据不接受 caller root、workspaceId 或 actor。

随后原 Conversation 事务一次写入 namespace、Thread、binding 与 receipt。Native 文件系统提交、metadata 创建和 Conversation SQL 是不同阶段：保存各自回执，失败明确恢复同一 ID，不声称跨进程整体原子性。Native registered 不代表 SQL 已提交，更不代表 Agent 执行已授权。打开项目只读状态，不自动恢复失败分配或重发外部操作。

### 4. 中央 Agent 与正式交付

中央对话继续走原 admission、Run、Tool 和流式路径。插件工具通过实际 Host 资格访问上述绑定视图；普通聊天不自动得到项目写权限。右栏只显示有意义的项目阶段与产物，复用中央 composer、模型和资源能力。

用最小验收插件在 Web 覆盖真实安装、授权、项目创建、对话执行、产物读写、跨归属拒绝与恢复。通过后再核对桌面候选和正式包。业务插件仍保持卸载。

上述第 1 步的存储基础和第 3 步的独立 Native 分配/私有 transport 已有源码与专项证据。2026-10-12 已提交原 CreativeProject、Foundation、公开 Asset/Text v1 Store，以及 SourceUpload、保存来源与原 Foundation Run 冷恢复的普通入口负向隔离，复用同一数据库与事务，保护实际保存回执，并保留原最终授权与租约检查。原显式 DDL 迁移保持独立，不因不完整的可选 owner 被拦截或自动修复它，数据访问继续严格拒绝。详见[已接线范围与回归](./plugin-project-legacy-access.md)。Foundation/PostgreSQL 新创建原交易、其他产物与关联入口、完整管理方法 fence、Main/Control 产品接线和第 4 步真实 Web 闭环仍未完成。具体交付范围见[整体状态](./plugin-foundation-status-20261011.md)。

## 最小验收范围

- 同账号逐项改变 actor、profile、plugin、publisher，列表、详情、历史、修改、归档与 replay 均拒绝串归属；旧 legacy 项目保持原行为。
- 夹杂其他归属项目时，SQL 分页与游标正确；两个新建入口完整写入归属，旧无对话项目仍不能接管。
- 两插件同外部 UI key 独立提交，同 owner 重试返回原回执；升级不改归属，旧 Run key 和历史不变。
- SQLite 与 PostgreSQL 实际事务覆盖占用冲突、等待锁后撤权、最后异步检查后撤权与回滚；拒绝部分 schema 和歧义。
- 真实 Control/Main 子进程断开、撤权与票据超时不产生新分配；原活动 workspace 和文件读取保持。
- 至少真实 installed UI→metadata 与 Worker→产物两条路径做跨插件负例，再验证中央会话和右栏；不以 facade 或离线模型测试替代产品验收。

当前实现和证据分别见[namespace 事务](./plugin-project-workspace-isolation.md)、[原 Native 分配](./plugin-project-workspace-native-allocation.md)、[右栏边界](./plugin-panel-host-boundary.md)、[整体状态](./plugin-foundation-status-20261011.md)。本页未开放新业务 capability、未迁移原项目或更新正式 App。

原 SQLite 的受保护改名、归档与恢复已增量接通，具体边界见[metadata 修改](./plugin-project-owned-metadata-mutations.md)。其他写入与生产交付尚未完成。
