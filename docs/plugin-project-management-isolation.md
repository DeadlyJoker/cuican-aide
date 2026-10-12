# 同一套项目管理能力的隔离接线

用户已明确：插件项目独立管理归属，管理能力共用。中央保留原 Agent 对话与 composer，插件页面使用宿主右栏。本页确定后续实现顺序，不表示这些尚未接线的产品入口已完成。

## 复用与隔离

继续复用原 Workspace registry、CreativeProject、Thread、Run、Tool、产物 Store、账号与授权服务。插件得到由 Host 绑定归属的管理视图，沿用相同操作和响应，不建立另一套项目数据库、聊天组件或执行器。

“独立管理”指同一套管理能力中的归属隔离，不是每个插件复制一个管理系统。隔离在原服务和存储入口执行，右栏只投影该插件获准访问的项目与产物。即使插件绕过页面过滤直接调用接口，也不能跨归属读取或修改。

工作空间 namespace 的原 SQLite/PostgreSQL 读取接口也复用写入时的 metadata 归属核验：返回登记前，检查完整八字段和原项目 principal；列表连同用于判断下一页的行一起检查，发现不匹配或部分归属 schema 时拒绝整次读取，不返回目录 ID 或游标。SQLite 使用原连接的只读事务取得一致快照，不为读取占用 `BEGIN IMMEDIATE` 写锁；PostgreSQL 在原事务内复核。旧 legacy 分支保持原行为，仍不构成新项目授权。这是内部原 Store 的防护，不是允许插件提交 owner 的公开接口，也没有签发目录操作或 Agent 执行权限。

该读取补充与原 namespace、Conversation 绑定及 PostgreSQL 占用锁回归联合 **43 passed、0 failed、0 skipped**，使用任务专属 PostgreSQL 18.6 实例，随后停止并清理。Store 类型检查、架构边界和文档格式检查通过。SQLite 正例由真实 UI 创建 protected metadata；旧登记冲突与 PostgreSQL protected metadata 为命名持久 fixture。这些结果不替代真实 Native 目录、Web 或正式桌面验收。

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

原 namespace 写入与重放现在会在同一个 SQLite/PostgreSQL 事务中核对已有 protected metadata 的完整八字段归属和原项目 principal。当前 UI 安装来源与项目归属不一致时不写 namespace；部分 metadata schema 也不能退回 legacy。完整 schema 中没有该项目的 protected owner 时仍保留原 legacy 行为，这不授予新项目归属，也不证明 Native 目录或中央会话绑定已接通。SQLite 专项通过真实 UI 创建项目后绑定；PostgreSQL 专项使用原 Store 创建新项目及显式持久记录 fixture 检查相同事务边界，并非 PostgreSQL 的受保护创建资格已实现。

验证：新增 metadata/namespace 专项、原 namespace/会话边界和 SQLite 创建/内容专项联合 **67 passed、0 failed、0 skipped**，PostgreSQL 使用任务专属临时 18.6 实例；Store typecheck、架构边界与文档格式检查通过。测试实例随后停止并清理，未更新 Web 或正式 App。

后续已将同一 metadata 检查接到原 Conversation 写事务：protected 项目必须具有匹配完整归属和 workspaceId 的 namespace，缺失 namespace schema/记录或使用 null/其他 workspace 均拒绝。原安装、Host 授权、Thread 资格、receipt、重放与事务末端检查保持；legacy 分支没有被转换成新项目授权。SQLite/PostgreSQL 真实事务验证匹配项目继续提交原 Thread、binding 与 receipt，冷 Store 保留工作空间，分别变更 actor/profile/plugin/publisher 时拒绝且不留下 Thread 或 receipt。新增专项及原 namespace、Conversation 回归联合 **49 passed、0 failed、0 skipped**；metadata 记录在这个 Conversation 专项中由命名持久 fixture 提供，不能当成生产接管权限或 PostgreSQL qualified 创建证据。

原三参 Conversation 调用仍使用 legacy 项目读取。新增显式 `metadataFromPluginUi` 路径只支持 createConversation、listConversations、openConversation：先核对真实注册 UI 调用和原独立 Conversation Host pin/selection/package，再签发有界的原 `loadProject` 读取视图。UI 没有 CreativeProject transaction 时不伪造它；原 `project.execute` Host pin 也不改写，来源仅匹配双方完整身份、安装快照和当前生命周期，不授予项目创建、Run 或 Tool 权限。原项目 read/write 策略和 Conversation 写事务继续分别检查。缺少绑定读取能力的 Store 明确拒绝；普通入口不回退读取 protected 项目。Control 的内部 `projectOwnership` 为显式选择，默认生产配置尚未开启。

这个 UI 创建入口的内部回执键使用七字段稳定归属、已有 projectId、实际入口和外部 key 的版本化摘要，原请求摘要及当前安装检查不变。两项目相同外部 key 不再冲突，同项目重试不分配新 ID，更改内容仍由原 Store 拒绝。旧普通入口和 Run 回执不改写；稳定键不意味着跨安装版本可无条件回放，原升级/refreshSource 规则仍需保留并接通。

新增真实 PluginUI/Application/SQLite 专项 **7 passed、0 failed、0 skipped**：创建、打开、列表、重放、冷 Thread 读取、同外部键项目隔离、改变内容冲突、独立项目策略、跨插件、复制/过期来源、Host pin 漂移与关闭、拒绝 stage 借用读取资格及缺少读取端口时拒绝 fallback。新增入口在原 Host 最后一次异步检查之后重新检查独立项目 write 策略；准备 Thread 后撤权时，Thread、binding 与 receipt 均不落库。包验证与 Host callback、持久 metadata 在该专项中使用命名 fixture，任务端口明确禁止调用；这些证据不证明真实 Native 分配或模型执行。最新会话、关联、模型选择和 Store 联合回归 **26 passed、0 failed、20 skipped（PostgreSQL）**；此前包含其他项目专项的联合回归 **59 passed、15 skipped（PostgreSQL）**，原 Native 回归 **4 passed、1 skipped（PostgreSQL production）**；本轮未运行 PostgreSQL 新读取模式。Application/Store/Control typecheck、架构边界与文档格式检查通过。

后续补充实际 `ProjectConversationControlOwner` 专项：真实本地包清单、业务 manifest 与安装行进入原请求 owner、UI 注册、Control 资格签发及原 Application/SQLite 事务，验证创建、打开、列表、同键重放，以及身份撤回、策略撤回、包字节摘要变化和 Control 关闭后拒绝。包恢复后重放仍返回原 binding。该专项与原 Native 创建、关联及升级回归联合 **5 passed、0 failed、0 skipped**，Control typecheck 通过。身份和策略仍为命名本地 fixture，metadata 归属也是显式持久 fixture；包复制只准备测试安装目录，没有绕过生产安装权限的新 API。该专项不是 HTTP、Native 目录分配、受保护 metadata 创建或模型执行的完整证明，默认产品配置仍未启用新读取模式。

原可信部署配置的 `conversations.projectOwnership: "plugin-project-v1"` 现已增量接入 Desktop v2/v3 合同、原 CreativeProject composition 及 Desktop/production Conversation composer，保持不填该项的旧序列化与旧入口行为。该项仅选择已有三个 UI metadata 方法的原绑定读取视图，不开放项目创建、接管、目录分配或 Run/Tool。未知/显式 undefined/继承/getter 配置拒绝；批准的准确包和独立策略仍保留。后端缺少原 `bindProjectReads` 时在准备 Conversation 服务、启动其安装/Conversation 迁移前拒绝；PostgreSQL 目前属于不支持的新模式，旧部署可继续使用原路径。没有自动迁移 metadata owner 或 namespace。

原可信部署配置的 `pluginUi.creationOwnership: "plugin-project-v1"` 现已接到 Desktop v2/v3、原 CreativeProject composition 和原 metadata UI runtime，交给已有 `PluginCreativeProjectActionOwner` 的创建、绑定读取与修改路径。不填该项时旧序列化与行为保持；其他 service 的 publications 不能带这个字段。准确包批准和独立项目策略继续检查；缺少原 owned-creation/read adapter 时拒绝。仍要求显式 caller-owned metadata owner 迁移，不在普通启动或 UI 操作中迁移、回填或接管项目。该模式不授权 Foundation、Native 目录分配或 Run/Tool，PostgreSQL 的新 owned-creation adapter 尚未实现。

Native HTTP 专项现已升级为真实受保护项目首次创建：原配置解析、bootstrap、安装、启用、真实 mount 和原 Application/SQLite 保存 project、initial brief、owner 与 receipt，不再人工插入 metadata owner。两个真实安装插件使用同一个外部创建 key 得到不同项目，列表仅返回各自项目，跨插件详情拒绝，更改创建内容仍报原幂等冲突，原项目与会话在重开后同键重放。切回旧 Conversation 配置仍拒绝 protected 项目；数据库保留两个独立 owned metadata 项目、一个 legacy 项目、一个原 Thread/binding/Conversation receipt、零 Run。安装和启动预检允许加载原 Node 包，metadata 操作没有额外 Node 加载。namespace 的 workspaceId 仍是独立测试库中的显式 fixture，尚未创建真实 Native 目录。Web 浏览器交互、真实 Native 分配、实际 Agent 执行和正式桌面仍未验收。新合同、配置、原 Control/Native 和 SQLite owned 创建/读写联合回归 **80 passed、0 failed、0 skipped**；Contracts/Control typecheck、架构边界和格式检查通过。

原 `setState` 与 `refreshSource` 现也通过同一 `projectOwnership` 配置接入真实 UI 资格和原绑定读取视图，继续调用原 Conversation Store、版本 CAS 和提交事务，未增加第二套会话管理器。真实 UI 输入只指定已有项目、会话、预期版本和外部 key，Host 来源不能借用读取资格启动 Run。撤销、恢复与来源刷新分别使用实际 action 的稳定回执范围，同项目重试回放，两个项目或两个方法使用相同外部 key 不冲突；旧入口及旧回执不改写。独立项目 write 策略在原 Host 最后一次异步事务检查后再检查，撤权时新 binding 和 receipt 均不落库。为保持原编排文件有界，原变更配方提取到内部 `project-conversation-binding-change.ts`，legacy 与 qualified 调用共用这份配方。

新增真实 installed HTTP 撤销、恢复、当前来源刷新、冷重开回放和跨插件拒绝，保存一个原 Thread、一个 binding、四个原操作回执、零 Run，切回 legacy 配置后三个受保护写入口仍拒绝。UI/Application/SQLite 专项还覆盖同键跨项目及跨方法隔离、版本冲突、回放时项目策略拒绝、关闭 Host、最后 Host 事务 await 后撤权且不提交新记录。namespace 仍是显式持久 fixture，没有 Native 目录分配。上述专项与原 Native 关联/升级、Application Stage 和 SQLite/PostgreSQL Conversation 回归联合 **34 passed、0 failed、0 skipped**；Application/Store/Control 类型检查、边界与格式检查通过。PostgreSQL 18.6 测试实例随后停止清理；新 protected UI 模式仍仅有 SQLite adapter，原 legacy 升级测试不能替代受保护项目跨版本升级或正式 Web/桌面验收。

getBinding、association、stage 源读取及生成 Run/Tool 的新归属视图、PostgreSQL 绑定读取、Native 目录与项目/对话的完整产品绑定和真实 Web 闭环仍需接线。Native 目录注册、namespace 与 Conversation 不是整体原子提交，中央 Agent 执行与正式桌面仍未验收。

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

namespace 登记与原 Conversation 写入目前是独立事务；原 Conversation 在自己的事务内复核 namespace，再写入 Thread、binding 与 receipt。Native 文件系统提交、metadata 创建、namespace 登记和 Conversation SQL 是不同阶段：保存各自回执，失败明确恢复同一 ID，不声称跨进程整体原子性。Native registered 不代表 SQL 已提交，更不代表 Agent 执行已授权。打开项目只读状态，不自动恢复失败分配或重发外部操作。

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

原 CreativeProject 的 SQLite 内容与概念素材/版本写入已增量接通，仍复用原 Store、事务与独立 write 策略。[具体范围与证据](./plugin-project-owned-content-mutations.md)。其他产物服务、后端及正式产品闭环未完成。

2026-10-12 补充：Standalone 启动组合可显式接收私有 Native 工作空间观察端，经过 Desktop 组合传给原 Conversation 服务；登记仍使用同一个 Parent SqliteRunStore。它是进程内依赖，不增加插件配置 JSON、SDK 或公开 HTTP 字段。缺省不启用；legacy 项目、继承字段、访问器和非函数在数据库获取前拒绝。安装包 HTTP 回归证明真实 UI 创建的 protected 项目准备资格能到达观察端，缺少目标或观察端失败不会新增 Thread、绑定、回执或 Run。此处观察端为明确不可用的测试依赖，尚不证明正式 Main 票据签发、真实目录分配或 Web/桌面闭环。

PostgreSQL 原 Parent 现在也提供冻结的 Native 登记端口，共用原 pool、schema、占用锁和 namespace 写事务。新增调用只消费真实存活的观察引用，不接收 owner 或 workspaceId；提交前复核安装选择、protected metadata 完整归属、原项目 principal 和 active 状态，重放保留首次 createdAt。PostgreSQL 原 CreativeProject Store 增加绑定读取入口，复用原查询并在原事务中检查安装、归属和请求目标；本次会话来源只授予 loadProject，不能借用它读取需求或其他方法，未实现的 protected 管理视图明确拒绝，不能掉回 legacy。

专项使用真实 PostgreSQL 单连接池和 genuine UI 生命周期，验证登记后原 Thread 创建、重放、复制与调用结束后的引用拒绝，以及四种持久归属不匹配。实际 INSERT 返回后撤销独立项目 policy 或 Host，原事务回滚；SQL 触发器在登记后归档项目时，namespace 与触发器修改一起回滚。Native 响应、初始 metadata 和包发现为命名 fixture，这些是原 SQL/会话服务证据，不是正式 Main、Web、桌面或供应商执行验收。没有启用业务插件或更新正式 App。

相关 SQL、锁、旧读取快照与会话回归 73/73，加上 PostgreSQL genuine CreativeProject UI 的项目、需求及需求历史读取专项 1/1，共 74 项通过，无跳过。读取专项验证方法隔离和调用结束后的原/复制引用拒绝；初始 protected metadata 与包发现仍为命名 fixture，未证明 PostgreSQL 首次 UI 创建归属。Store/Control 类型检查、架构边界与格式检查通过。测试 PostgreSQL 为任务专属临时实例，验收后停止并清理。

受保护 Conversation UI 的 getBinding 现在与其他 metadata 操作共用真实调用的项目视图，沿用原 Store 绑定读取和原 Thread 检查。调用仅含原 threadId；绑定所属 actor、profile、plugin、publisher 与当前来源必须匹配，版本与包摘要不作为稳定归属。返回前再复核独立项目 read 策略；不存在绑定的空结果也复核当前 Host 资格。原默认调用仍使用原 legacy reader，不以 UI 资格替代中央鉴权 GET 的接线。

本轮 28/28 回归、零跳过，覆盖真实安装包 HTTP 的读取、跨插件拒绝、冷启动取得当前 revision，以及 SQLite/PostgreSQL genuine UI 的缺失绑定、复制上下文拒绝、项目/页面策略拒绝和 Thread 读取后撤权。关联与 Stage 的原路径回归保留，详情读取没有额外 Thread 或 Run。初始持久归属、包发现及 Host 策略部分测试仍为命名 fixture；结果不证明正式 Main 授权、完整 Web/桌面验收或目标全部完成。

PostgreSQL protected 读取视图现已覆盖原八个项目读取方法，补齐项目列表、概念素材列表/详情和版本列表/详情。所有入口使用原查询和解码器，检查真实调用允许的方法及 projectId、assetId、briefRevision、assetRevision；绑定视图本身不扩大调用资格。列表按完整稳定归属在 SQL 排序与 LIMIT 前过滤，并复核用于判断下一页的记录；额外较新的其他插件和 legacy 项目不占本插件页数，异常 lookahead 记录不发布游标。查询实现从原高频 Store 拆出到 focused module，保留原连接和生命周期，未增加管理系统或迁移流程。

八方法、混合归属分页、详情目标篡改和异常 lookahead 使用真实 PostgreSQL/genuine UI 验证；额外项目的首次创建与归属记录、包发现和 Host 策略为明确 fixture。此专项与原项目 Store/legacy 访问回归 59/59，Native 登记/绑定/旧读取快照另组 22/22（其中一项读取专项重叠），均零跳过；不能相加为整仓验收。Main 授权与正式 Web/桌面接线仍待完成。

正式 RuntimeSupervisor 的 Control 子进程启动此前只有标准输入/输出管道，缺少 Native 客户端要求的 Node IPC。现在按真实 Control 入口路径添加私有 parent channel，保持其他子进程的原 stdio；没有绑定 Main 目录分配器、签发项目票据或增加 renderer IPC。两个真实 supervisor 启动路径（有/无 provider）能在 Control 构建并关闭原 Native workspace client，Worker/发行命令无此通道，退出清理与原基础回归 20/20、零跳过。Electron 类型、架构边界检查通过。这项传输接线不能证明项目授权或正式 App 已更新。

另只读核对当前正式 desktop profile：原 plugin_profile_selections 有三条 uninstalled、零 enabled，未改写历史或账号。Mac 当前锁屏，因此本轮不以数据库状态代替正式页面验收。源码工作区仍有其他未提交启动改动，以上测试基于当前工作区；本次只提交 stdio 接线及对应测试，不打包或发布这些其他改动。

Main 内部现在能从真实 Native authority 派生项目完整归属，通过只读连接调用原 metadata fence、项目解码器和 installation Store，核验 protected owner、active 状态及当前批准的包/selection revision。原数据库不迁移；路径、文件身份、Native owner/批准及短生命周期在复核时仍有效。Main 内部状态引用有私有成员资格，复制对象不能兑换；该持久事实资格不是 UI、Task 或 Node 权限。新 prepareForProject 只接受同一个 Main owner 的实际引用，发行票据、分配前、实际目录提交后均复核原状态；旧可信 Main prepare 仍保留为内部兼容原语，不能用于新的产品授权接线。

与真实 ChildProcess 的原桥接/客户端/Scoped 调用回归合组 68/68、零跳过：匹配项目可分配且普通活动 workspace 不变；其他插件归属、票据后归档、同包停用再启用导致 revision 变化被拒绝。实际 registry 提交后归档时不发布成功，已提交目录保留，没有宣称与 SQL 原子回滚。原项目和安装写入器真实执行，初始 protected owner 为明确持久 fixture；本轮尚未把真实 Control UI/write 调用接到这个 Main 状态发行器，也未启用新的生产分配入口、更新 Web 或正式 App。

私有 Control/Main 链路进一步接通：新增独立 preparation IPC schema，消息仅标识 projectId 与包的四字段身份，不传 owner、root 或 UI/Task 授权。Control 原客户端的 observePreparedProject 必须先消费实际存活的 UI 项目准备引用并复核独立 write 策略，再向其真正的父进程请求票据；Main 从自己固定的原数据库和 Native 批准派生状态，使用 prepareForProject，不能拿消息身份当 UI 资格。回应之后 Control 再检查当前来源，并沿用原分配、观察、namespace 与 Conversation 配方。两种请求共享原有并发、发送期限、取消、断连和清理机制，不增加自动重试。Main 依赖绑定的可信 Control 进程；该内部协议不宣称隔离同进程恶意代码或把序列化标识变成 live grant。

真实 Node 子进程与 Main 使用同一个任务专属原 SQLite 文件：genuine UI→自动请求票据→实际 Main 目录/registry→原 namespace→原 Thread 正例通过，不再由测试人工转发票据；复制引用和独立 write 撤回均拒绝且无目录、namespace、Thread。身份/PDP、包发现及初始 protected owner 为明确 fixture，未把它当作真实用户安装、HTTP 或供应商执行。相关桥接/客户端/分配回归 70/70，加私有契约 3/3，零跳过。正式 RuntimeSupervisor 创建桥接 owner、Control main 生命周期组合及真实 Web 验收仍待接线，未更新正式 App。

后续启动源码已接线：原 Native installed 完成对象在 Main 私有 registry 绑定真实 authority，不增加可序列化 DTO。RuntimeSupervisor 使用 Main 传入的原 LocalWorkspaceAuthority，为当前实际 Control child 创建桥接，先跟踪 child 再装配；会话失效同步 withdraw，停止过程在原 child 和安装启动工作收尾后 join 桥接，再清理 owner/files。没有另建 workspace manager，也不授予 copied runtime 对象能力。

Control main 在实际 Native 与显式 owned Conversation 配置同时存在时创建原客户端和观察端，传到原 Standalone composer；preClose 与启动失败均关闭客户端。legacy、非 Native 的 metadata-only owned 路径保持原启动，不根据父通道存在猜测权限。Native producer/真实 child/lifetime、原 supervisor/financial environment/parent channel 回归 38/38；Control 默认兼容与原 installed HTTP 2/2，均零跳过，Electron/Control 类型及边界通过。工作区仍有其他未提交启动改动，测试基于当前工作区，不能当作正式打包身份。完整正式启动到真实 UI/目录/Thread/Agent 的验收以及业务插件生命周期、Web 和 App 放行仍未完成。

### 工作空间目标查询：原管理服务的只读扩展

按用户确认，继续使用同一套项目、工作空间、会话和文件管理能力，以归属隔离数据与权限。插件不能通过填写 owner 或目录路径获得自己的工作空间，也不能复制管理系统。新增独立协议 `crewon.project-workspace-target@1` 的 `resolveTarget`，仅接受 `{ projectId }`，返回 `{ projectId, workspaceId }`。它复用原 Conversation Host owner、真实安装声明、原 UI invocation、原项目 Store 的归属绑定视图及独立项目读取策略；不创建目录、namespace、Thread 或 Run，不授予写入或执行权限。

只有实际 Native provisioning 与显式 `plugin-project-v1` 同时接线的 Desktop Control 发布该能力；旧 Conversation v1 和 metadata-only 部署不推断或宣布支持。声明这一新服务是新增兼容性要求，旧客户端请求与 `workspaceId: null` 的语义不变；不自动改写调用目标。查询结果是归属派生的不透明标识，创建对话时仍独立检查当前安装、项目写策略、Native 观察、namespace 和 Thread 事务。查询不是可缓存的权限凭证。

独立插件在原 UI SDK 的 `ui` 入口使用 `resolvePluginProjectWorkspaceTarget(services, { projectId }, { signal })`，再将返回的 `workspaceId` 交给原创建会话操作。SDK 只调用已有挂载的 `services.invoke` 一次，验证精确输入和关联结果，不启动另一个 transport、不自动重试。插件包须声明 `crewon.project-conversations@1` 与 `crewon.project-workspace-target@1`；宿主实际不支持时不能通过声明获得能力。

本轮真实安装包/Control 来源测试覆盖已声明、未声明和非 Native 模式；原 SQLite 的 genuine UI 覆盖 actor/profile/plugin/publisher 归属不匹配、复制 context、独立读取撤权及 UI 撤权。原 installed HTTP 覆盖查询目标、拒绝另一个插件的已存在项目，并将实际查询结果传给原会话创建入口；Native observer 明确为不可用 fixture，该失败被正确保留，不能当作目录或 Agent 执行通过。测试没有增加目录、namespace、Thread 或 Run。完整用户 Web 操作、正式启动到真实 Native 分配和中央 Agent 的闭环仍待验收，未更新桌面包。

验证结果：上述来源/安装/HTTP/归属/协议专项 32/32，SDK 完整构建与测试 91/91，均零跳过；22 个 packages 类型检查、Control 类型检查、TypeScript 边界及仓库格式检查通过。PostgreSQL 生产集成另一次运行因无测试数据库跳过，不作为通过证据；本轮未验证 PostgreSQL 新目标查询或真实用户 Web/桌面操作。工作区仍有其他未提交 UI/启动改动，保留且不纳入本次提交。

### 显式归属模式的真实启动初始化与 HTTP→目录→Thread 联合验收

联合接线发现：配置已经声明 `creationOwnership` / owned Conversation，但原启动没有初始化 metadata / namespace schema，首次真实 UI 创建项目返回 `creative_project_service_unavailable`；已有 installed HTTP 专项手工建表，不能证明这一启动缺口已闭合。现由原 `prepareCreativeProjects` 在明确启用归属模式且原项目 schema 初始化后，调用原 Parent 的 `migratePluginProjectOwnership`。未配置 / legacy 模式保持原路径。SQLite 使用原父连接，PostgreSQL 使用原父 pool、原 namespace 迁移锁和事务；沿用已有两个独立 schema 迁移函数，不增加管理系统或主 schema 版本，不插入归属、接管、目录、Thread 或 Run。任一 schema 不合法则回滚本次初始化，保留已有错误 schema，不能隐式修复。

这是内部可信部署配置的 DDL 接线，没有新增 HTTP/SDK/renderer 迁移操作或 owner 字段。首次归属仍必须来自真实安装和 UI invocation，公开旧入口仍不能访问 protected 项目。新配置需要具有这一显式迁移端口的宿主；旧不完整组合不能被声明为可用。PostgreSQL 的初始化和旧会话兼容通过，不等于其新 qualified 项目首次创建及完整 Native 执行已支持。

新增联合专项使用真实包字节、真实 HTTP listener、真正的 Control 子进程、Main 原 Native authority/IPC、原文件系统 allocator/registry、原 Parent namespace 登记、原 workspace admission 和原 Thread。两个项目及归属均通过 installed UI 创建，没有手工插入 metadata 或 namespace；只读目标查询不分配目录。各项目的目录和 Thread 不同，同键重放不增加目录或 Thread，错误项目目标在分配前拒绝，原普通工作空间仍活动，普通 Thread API 不能借用 protected 项目目录。最终两个 metadata、两个 namespace、两个 Thread，零 Run；不把元数据会话建立当作 Agent 执行授权。

Actor、profile 批准、Native policy 及 standalone policy 为明确的测试配置，Control 通过原 standalone composer 接入真实 observer；它不是正式 RuntimeSupervisor/Main 生命周期、真实用户 Web 或模型/Tool/产物执行验收。SQLite/PostgreSQL 的幂等、旧项目全字段保留且不回填、坏 namespace 使新增 metadata DDL 回滚及 closed 生命周期，加原启动、installed HTTP 和生产 PG pool1 冷兼容专项 15/15；原 admission/配置/Control 来源回归 13/13，均零跳过。Store/Control 类型、边界通过。专属 PostgreSQL 已停止清理。业务插件与正式 App 保持原状态；现有 Web 是此前已启动的基线，未据此宣称新插件功能已在该页面开放。

### 原中央对话与阶段执行的项目读取接线

发现另一个真实缺口：创建隔离项目和 Thread 后，原 `startProjectTurn` / `startStage` 的项目与需求准备仍调用普通 Store，受保护项目会按原隔离规则拒绝读取。现在由原 Control 执行签发在真实安装包的 `project.execute` Node action 与 submit 授权通过后登记进程私有来源；原 authenticated request owner、当前 actor/profile、安装、Host 生命周期和精确阶段请求共同取得原 Store 的只读绑定视图。中央对话、HTTP 阶段执行和真实 UI 阶段操作均复用这一路径，不伪造 UI invocation，不增加公开 owner、路径或可序列化权限字段。未配置归属模式保持原读取方式，未知模式拒绝。

绑定视图仅支持当前请求的项目与需求读取；实际阶段仍经过原 binding、Thread、revision、Task admission。执行权限保留原 Host 检查，并在最后 Host await 后检查独立项目写策略；读取准备完成后撤销写权限也不能抵达任务提交边界。源码拆出原阶段来源 recipe，未另建项目或工作空间管理系统。

真实 Control + verified Node package + 原 SQLite 专项验证三个入口抵达明确的任务准备边界，并拒绝错误项目、Host 撤权和来源准备后的独立写撤权；Task peer 明确为 unavailable fixture，任务 sink 在准备后主动失败，因此不证明 Run/Worker/模型执行。与原 genuine UI、Native、HTTP/目录/Thread、普通阶段与模型选择回归合计 30 个测试通过；另 14 个需要外部插件目录或 PostgreSQL 的测试跳过，不计通过。Application/Control 类型及架构边界通过。正式桌面只读确认 admin 和历史会话可见，未重打包；用户正在操作桌面，未干预其页面。受保护大纲来源、Worker/Tool/产物及真实用户 Web 的完整闭环仍待接线验收。

追加验证直接使用原 ExtensionTaskApplicationService、原 SQL Task/Run writers 和 genuine UI 创建的隔离项目会话：受保护需求可准备并提交原阶段 Run，冷建 Application 后同键重放返回相同 Run 与完整 admission；复制 read scope 或改变实际请求在准入前拒绝。1/1 通过。安装快照、可信后台执行 authority 与 unmetered policy 为明确的本地 fixture，不是真实 Control→Worker→模型闭环；未访问模型网关，未安装业务插件，未更新桌面。该结果将后续验收边界推进到 Worker、Tool 与产物，并不替代它们。
