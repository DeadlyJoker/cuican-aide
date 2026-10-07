# 共享媒体生成命令

2026-10-07。接续[原媒体 Run](./project-media-generation-run-protocol.md)和[Worker 执行](./project-media-worker-composition-protocol.md)。目标是让同一短剧插件的页面和 Agent 使用相同输入、执行意图和任务，而不是分别创建供应商请求。

## 模块边界决定

素材读取、冻结、准备、输入资格和结果候选原来位于 Runtime Worker 内。Control 的宿主命令也需要这些能力，不能通过生产依赖导入另一个 app。因此将这些实现提取到私有 TypeScript 包 `@crewon/media-runtime`；包依赖既有 Application、Store、Artifacts 和 Domain，使用现有 Node/pnpm 工具链，不增加执行器、数据库或构建体系。

原 Worker 文件保留明确的公共重导出，确保 `instanceof`、私有状态和既有调用者使用同一个类身份。网络地址审查、固定 DNS 地址的传输、PNG 校验和受控上传均复用原实现，不复制两份。原模型、Tool、Run 调度与恢复继续属于 Worker；共享包负责素材和原任务创建前的协调。宿主原界面、SDK 与已发布插件包不受此次提取影响。

## 创建与恢复

`ProjectMediaGenerationCommands.generate` 接收逻辑业务选择：项目、保存的输入版本、预期最新版本、执行意图、原会话及修订、幂等键。Actor、profile、安装包、执行批准和服务地址由可信宿主提供，不能由这些参数替代。宿主 admission resolver 必须在素材 I/O 前核验原会话/工作空间、项目和当前部署权限。

首先沿原 TaskCore 的同一幂等键算法查找受理记录。已有记录时恢复原媒体关联，核验所有业务选择与原命令摘要，再走原 TaskCore 回执；不重新准备素材、不重新读取供应商字节。输入后来追加版本不会改变原任务。参数、会话或原会话修订改变时拒绝复用回执。页面和 Agent 对同一步骤应传入同一个持久执行意图和原请求键；单纯分别产生随机键不能当作步骤去重。

新执行先检查独立 `projectMedia:generate` 权限，再通过原素材 journal 准备并核验实际参考，最后由原 TaskCore 事务受理 Run。素材未知或被拒绝时不创建 Run。明确生成另一个候选才使用新的执行意图；SQL 的原唯一占用仍禁止同一意图产生第二个任务。

关闭服务会停止新调用并撤销待处理调用，但等待实际 I/O 和任务创建退场。原事务已成功提交时保留已知成功结果。共享服务只借用父存储及准备器，不关闭其他 owner 的资源。

## 产品接入范围

Control 已增加可选的请求运行时和有界 HTTP 生成入口，默认不注册。Native Main 的独立生成声明、Settings 准备与 Short27 页面生成动作已接入；HTTP 与页面共用持久请求，详见[对话侧媒体请求恢复](./project-media-generation-http-recovery.md)。Agent 对话的生成控件、模型自动执行工具和候选采用仍待接入。后续查询与候选投影不能把原内部 Run/候选记录原样返回模型；候选采用需独立校验预期版本，不能用供应商任务成功代替采用。

真实外部生图、正式桌面双入口接力以及后续结构化分镜、视频、声音和成片仍需分别验收；积分继续后置。

## 原 Control Core 的存储和生命周期

Control Core 新增可选内部配置 `projectMediaGenerationStorage: { version: "crewon.project-media-generation-storage.v1" }`，只准备该 Core 实际使用的媒体任务受理适配器。省略时保留原行为，即使同一父数据库已存在相关表，也不能把另一个适配器的准备状态当作本 Core 已启用。旧版本、额外字段和访问器在取得存储适配器前拒绝。素材输入权限、素材 I/O、生成授权和页面动作仍各自独立；该配置不授予这些能力，也没有自动写入 Native Main 设置。

共享命令现在保留真正 `ExtensionTaskApplicationService` 实例上由 Core 安装的不可改写方法包装。此前直接调用类原型，会绕过 Core 对进行中任务的跟踪，导致关闭操作可能在实际任务还未退出时返回。新入口沿原包装受理，关闭等待物理任务退场；可修改的方法替换或访问器不被接受。未被宿主包装的原 Application 实例仍使用原类方法。

实际 SQLite/PostgreSQL 集成覆盖同一 Core 的创建与回执恢复、默认未启用、无效会话和关闭等待。该测试只借用原父数据库、请求身份和任务服务，部署/PDP及网络仍为具名夹具。恢复旧原型调用可稳定复现提前关闭，回归日志保存在 `output/extensions/checks/media-control-lifetime-20261007/original-bypass-regression.log`。本轮相关检查43项全通过，Control/Worker/共享包类型检查及7个桌面运行时组件构建通过。

这一步证明共享命令能经过原 Core。后续项目会话授权解析器的实现见下节；正式 Native 执行声明、页面/Agent 入口和候选采用继续实施，不能将这里的 Core 测试当作新生成按钮已经开放。

## 项目会话中的媒体任务

`InstalledProjectMediaGenerationAdmissions` 从实际已启用媒体受理存储的 Core 借用原请求身份、父数据库、安装目录、发布范围和权限回调。首次准备并不会授予素材权限。每次请求读取真实项目会话绑定，核对项目、完整 Actor、profile、Thread 所有者和工作空间；同时核对当前安装选择、完整包字节及媒体提交/观察工具声明。只有原 Core 允许的当前发布包才能产生生成受理依据，插件或模型不能提交安装 pin。

共享命令的私有 resolver 现在返回安装 pin、可选项目会话快照与三个实时检查回调。普通独立任务使用 `conversation: null`，既有低层素材资格器保持兼容；项目会话宿主必须提供真实快照。准备素材前后、任务预检和原事务会调用相应检查。事务回调只检查权限与请求生命周期；数据库行检查由原 Turn 的同一连接执行，不在回调中另借连接读取项目或安装信息。恢复保留原受理 pin，同时重新授权当前请求和当前安装，不把历史身份当成当前执行许可。

原 Turn 以前会正确拒绝没有阶段凭据的项目会话，旧的普通会话生图测试未覆盖这一点。现在增加专用媒体会话检查：在原事务中锁定并核对真实绑定、项目所有者、Thread 原始记录及索引、工作空间和绑定标记。只有提供合法媒体资格且快照与当前记录一致时，才通过这个专用分支；缺少快照仍走原 `project_stage_admission_required` 拒绝路径。撤销、换项目或过期快照无法用回调返回“允许”绕过 SQL 校验。既有 Run/媒体关联记录格式保持不变，这里约束的是任务受理；已受理 Run 的后续执行仍由原 Worker 权限和取消机制管理。

Thread 预期修订继续由原 TaskCore 在查找回执之后核验，避免并发重试刚好撞上已提交的新修订而被提前拒绝。两次入口使用同一请求与执行意图时，提交和重放得到同一个 Run；更改原请求修订则仍被拒绝，且不重新读取或上传素材。

双库的真实已安装 Short21.0.1、原 Core、身份、绑定写入器和事务验证了 T10/D18 创建、回执恢复、并发、错误项目/普通会话、撤销安装权限与准备期间撤销绑定。另用独立仍允许的具名 PDP 直接调用真实 TaskCore，确认无资格和已撤销快照分别被原 Store 拒绝，不能靠上层回调掩盖。原 Worker 在项目绑定会话中经过持久调度继续运行，T10/D18 都只提交一次并产生原项目候选。全部模型、PDP和供应商响应仍明确为具名夹具。

相关检查 **117/117** 通过、零跳过，包括原项目会话关联和文字阶段回归；Application、Store、共享包、Control和Worker类型检查通过。证据：`output/extensions/checks/media-project-admission-20261007/`。初始测试的只读包清理及错误包装断言问题已修正，没有放宽实际安装权限或事务检查。下一步把此解析器与原请求范围内的素材服务一同装配进正式 Native Main，再发布有界生成/查询/候选入口供页面和 Agent 使用；当前仍没有新增可见生成按钮。

## 验证说明

使用实际 SQLite/PostgreSQL、加密素材、原 TaskCore、完整已安装 Short21.0.1 和真实 Worker 验证 T10/D18；模型流、部署审查及供应商网络响应使用具名夹具。覆盖原键冷恢复、手动追加输入后恢复旧任务、两个入口并发、外来批准、字段注入、权限拒绝及关闭等待物理 I/O。新入口测试主动缩短每次唤醒的边界数量，确认原 Run 经过真实持久调度继续完成，而不是重建 Run。

并行执行时，初始验收将原调度器 `run_execution_yield` 误当失败。按原5秒预算及1毫秒重排继续同一个 Run，最多8次；其他错误和不同 Run 立即失败。没有修改生产调度预算或放宽最终完成、提交次数和候选来源断言。最初夹具变量重名及该调度假设的失败日志均保留。

12个提取模块与原实现逐字节一致，13个旧模块导出与共享模块的对象/类身份相同；生成资格器只增加显式新执行的准备入口。原宿主 UI、SDK、Short26及历史完整包、已验收与用户 App保持。证据位于 `output/extensions/checks/shared-media-commands-20261007/`；这里不把具名网络夹具当成真实生图或用户桌面已经更新。

## 请求运行时与 HTTP 协议

`InstalledProjectMediaGenerationRuntime.prepare` 只借用真实、已显式准备媒体受理存储的 Core。宿主配置单独声明 profile、工作流审核、元数据/生成 PDP、来源校验器和实际素材工厂。工厂收到同一个父 Store；它只拥有自己创建的资源。元数据配置不隐式授予上传或生成权限。

每次请求通过原 `InstalledPluginRequestOwner` 重新解析身份和 profile，并用独立异步上下文保存此次逻辑命令与实时项目受理凭据。素材元数据只能读取或校验本次输入，不能借入口写入其他项目；生成 PDP 校验确切执行意图。提供给素材工厂的 `assertCurrent` 会读取当前绑定和安装包；`assertTransactionCurrent` 只做原请求/PDP及生命周期检查。`projectMaterial:prepare` 的回调也会在 SQL 事务中执行，必须使用后者，不能再次借用数据库连接。字节读取、冻结、上传与观察的独立权限仍由实际素材服务检查。

在 `buildControlApi` 显式传入 `projectMediaGenerations` 才注册：

```text
POST /api/v1/creative-projects/:projectId/media-generations
Idempotency-Key: <原执行请求键>
```

请求体为 `mediaInputId`、`inputRevision`、`expectedInputRevision`、`executionId`、`threadId`、`expectedThreadRevision`，不接受 query、身份、安装 pin、URL、工作流正文或素材字节。沿用原认证和 CSRF 校验。新 contracts 子路径为 `@crewon/contracts/project-media-generations`，不修改冻结 SDK。请求最多 2 KiB；超限沿用原 Control 的验证错误封装。

返回 `committed` 或 `replayed`、项目/输入/执行意图、原 Run ID、原 Thread ID 和受理修订；这些表示受理而非生成完成。不公开内部关联、部署配置或供应商地址。提交成功后唤醒原 outbox，唤醒失败由原扫描恢复。保持原请求键重试时恢复同一个 Run，参数变化报冲突；新候选需要明确的新执行意图。

最多允许16个本地在途调用。HTTP 断线撤销当前准备；关闭运行时拒绝新调用、等待实际准备和任务提交退出，再释放工厂资源，不关闭借用的 Core/Store。请求结果未知时仍按原执行意图恢复，不能无条件生成新的键重投。SQLite/PostgreSQL 用例覆盖实际 HTTP 断线后重试、两个请求并发收敛、跨项目上下文隔离、PDP/CSRF拒绝、撤销绑定、关闭等待和工厂失败清理。供应商、部署/PDP仍为具名夹具，正式 Main 和插件按钮没有因此自动启用。

兼容性：新增可选宿主依赖、独立协议和路由；旧的媒体输入/文字阶段权限、持久格式和页面/SDK不变。Agent 文字计划的委托不被当作生图授权，后续 Agent 生图需专用的当前权限和执行作用域。相关证据：`output/extensions/checks/media-generation-runtime-20261007/`。

## Control 与 Worker 的实际素材装配

`@crewon/media-runtime/project-media-material-runtime` 提供 `createProjectMediaMaterialRuntime`。它接收宿主借出的真实 SQLite/PostgreSQL 父存储、配置服务、profile 与各用途授权端口，装配原项目/资产来源服务、安装读取、目标解析、字节读取、冻结、上传、输入校验和同库 journal。默认网络路径继续使用原固定地址传输；启动本身不读取供应商字节、不上传，也不受理 Run。

宿主给出档案ID、目录、密钥ID和密钥字节；工厂在异步迁移前复制密钥，结束初始化时清零临时副本。内部使用原 `FilesystemProjectMaterialArchive`，只写加密源字节，保留原文件权限和目录身份校验。调用方先等待自己正在处理的命令/Worker任务结束，再关闭工厂；关闭会撤销该工厂的能力并清零内部档案密钥，保留持久数据，借用的父数据库和配置服务继续由原 owner 管理。

项目读取、素材输入、字节读取、冻结、准备、上传和观察各自检查原授权，不相互替代。准备回调沿原事务要求只检查外部PDP/活动状态。重复的工作流可以共用同一目标包身份，但同一包摘要的身份字段矛盾时拒绝装配。工厂不接受替身父存储或伪装的配置服务。

ComfyUI参考文件解码器从 Worker 原样移入 `@crewon/media-runtime/comfyui-project-reference-material-adapter`，旧 Worker导出保留相同函数身份。它继续只接受审核过的原配置身份及其确切 `/view` 输出引用，不能把UI提供的任意URL变为素材来源。通用工厂接收可信宿主选择的纯解码器，便于原ComfyUI实现复用；测试中的具名来源解码器和供应商响应不能当作真实ComfyUI验收。

Control HTTP与原Worker集成用例都改用这套实际工厂。专项验证T10/D18、档案加密、逐用途拒绝、密钥快照、关闭以及真实父数据库冷重开；冷恢复使用原准备记录和原加密数据，不重新捕获来源或上传。独立Native生成声明、私有档案配置与工作流执行审核仍须同时接到正式Control和Worker；本模块不会自动启用新的桌面或Agent入口。证据：`output/extensions/checks/shared-material-runtime-20261007/`。

## Native Worker 的独立生成装配

2026-10-07：原桌面项目执行配置增加可选 `mediaGenerations`，版本为 `crewon.desktop-project-media-generations.v1`，只接受已有项目会话和媒体工作流审核所对应的 `workbench` publication。旧素材读写、阶段工具和文字计划声明均不推导此项授权。当前 Settings 仍只写入原素材输入声明；本项独立生成声明尚未从产品设置开放。

原 Worker Main 现在等待异步宿主准备：从完整校验的实际安装包读取 T10、D18 图文件，核对包身份、Manifest/实现摘要、工作流摘要及固定提示词/图片输入节点，再提供原媒体执行配置。准备阶段不导入插件 Node/UI 入口、不调用模型或供应商；后续执行继续由原 Run、安装选择、实时文件权限和网络准入负责。旧同步工厂保留旧配置行为，遇到新媒体生成声明时要求走异步准备，避免忽略声明后启动一个缺少媒体能力的 Worker。

素材存储使用原宿主环境的 artifact 根目录和密钥文件引用。通过带用途与 profile 的 HKDF 派生独立加密密钥，档案位于 artifact 根目录的同级 `*-project-materials/<profile 摘要>`；临时密钥在实际档案复制后清零。Control 后续使用同一函数可以读取同一份加密档案，当前已验证同 profile 跨实例一致、跨 profile 隔离，不能据此声称 Native Control 已接入。

首次启用使用空白的媒体存储时，原 Control Core 和 Worker 的独立媒体准备先迁移素材日志，再创建依赖它的生成表。已有项目、资产等基础 schema 仍必须由原宿主提供；损坏历史不会被当作空库覆盖。

本阶段到达 Worker 装配，尚未完成 Native Control 工厂、Settings 生成审批、页面按钮与 Agent 生成入口。旧 App、已发布 Short26 包和 SDK 不变；正式双入口与真实供应商生成需继续验收。

## Native Control 的生成装配

2026-10-07：原 Native Control 现在读取同一独立 `mediaGenerations` 声明，在原 TaskCore 上准备生成存储、`InstalledProjectMediaGenerationRuntime` 和实际素材工厂。`createStandaloneControlApiWithPlugins` 把这个真实 owner 传入原 `buildControlApi`，注册现有生成 HTTP 协议；旧素材输入声明不会创建生成 owner 或注册生成路由。

Main 从原 artifact 配置快照传入目录、密钥文件与密钥ID引用，使用与 Worker 相同的 profile 派生方式和加密档案位置。密钥不进入插件、HTTP 或 bootstrap 数据。生成运行时关闭会等待自己的调用并释放自己的档案，原父数据库仍由宿主关闭。冷重开使用同一档案目录，保留项目数据。

Control 对每次素材读取、冻结、准备、上传和观察同时校验原请求/项目受理范围与 Native 文件授权。上传和观察从原配置服务读取确切修订，并匹配审核包身份、批准来源及对应 `/upload/image`、`/view` 路径；事务中的准备只调用提交时权限与生命周期检查。生成授权保持独立，不能由媒体输入写权限或文字阶段委托代替。

装配测试暴露并修复启动投影遗漏：新的 Native 生成声明必须从通用项目数据配置剥离，交由专用 Native owner 消费，否则通用严格配置解析器会拒绝启动。既有项目配置和持久格式不变。

新增用例覆盖真实私有批准文件、完整 Short26 包、原 SQLite、实际素材工厂、原 standalone/HTTP 装配、身份与CSRF、外来字段、缺失会话绑定、授权撤销、关闭重开及无效密钥。standalone 路径经过实际本地 HTTP peer，catalog 内容是具名测试数据。此处没有构造已采用参考图，也没有宣称 Native 已受理成功生成；完整原 Core/素材/Worker 的双数据库生成回归仍使用既有具名网络和模型端口。证据：`output/extensions/checks/native-media-control-20261007/`。

Settings 尚未发布这项独立批准，页面和 Agent 尚未接通生成入口，用户 App 未更新。下一步验证具备真实绑定与已采用素材的 Native 受理路径，再接入设置和双入口；其后继续候选采用、结构化分镜、视频、声音与成片。完整八阶段目标保持 ACTIVE。

## Native 已采用素材的成功路径

2026-10-07：使用完整 Short26 包及原安装、启用、UI recovery、项目、结果选用、资产参考采用和会话服务，已验证 T10/D18 输入从原 HTTP 进入共享素材工厂并受理到项目原会话。供应商边界使用具名 DNS/HTTP 响应及来源任务结果；项目、版本、安装批准、素材资格、加密归档、上传日志、原 Run 和幂等回执均走实际实现。来源任务与媒体任务分别保留，工作空间绑定不变。

修复素材输入安装读取的预授权：原 `getPackage` 首次只携带包摘要，Native 现在允许审核列表内的确切摘要在该 profile 中预读，后续仍校验真实插件身份。空摘要列表、外来包/插件/profile 不因此取得读取权。没有新增公共协议或持久格式。Native 归属检查对同一不可变配置对象省去重复 JSON 比较，但没有缓存批准文件校验或放宽撤销。

同键重复提交及原数据库冷重开返回同一 Run，不重复源图读取或上传；同键改变执行意图冲突。缺少读取/上传路径批准，以及实际上传边界撤销 Native 权限，均不能新增媒体 Run。五个新流程测试与 46 项 Native 相关回归全部通过，证据位于 `output/extensions/checks/native-media-flow-20261007/`。

这一步仅验收受理路径。当前完整 T10/D18 测试场景分别约 51/133 秒，CPU 采样显示本地反复文件校验与数据比较开销，尚未满足产品交互的耗时要求。下一步先减少重复校验并保留实时撤销与归属测试，再开放 Settings 声明及页面/Agent 共用生成入口；不把延长测试超时当作性能修复。真实供应商输出、候选采用和后续生产阶段仍待验收。

## Native 同步归属检查的开销

2026-10-07：原 Native 操作先完成实际请求身份/profile 解析，再在异步返回后检查所有借用 owner；排队和解析参数不提前重复遍历完整 owner。一次同步只读归属核验内，对同一已签发不可变配置的文件检查合并为首次验证及返回前的复核。两次都执行原实际字节、文件身份和目录校验；其他归属与生命周期断言照常执行。作用域在返回或抛错时立即清除，异步验证函数被拒绝；没有 TTL、跨请求权限缓存或跳过真实文件内容读取。

原身份层仍保留完整归属检查，因此实际 profile 被新实例接管时，既有配置读写及回执重试继续返回原 403 和 `installed_plugin_request_authority_unavailable`。同字节批准文件替换、bootstrap 改写、异步期间撤销/关闭、上传中撤销、原会话绑定和冷重开回执均通过实际用例。

相同完整场景由 T10 51.4 秒降至 22.3 秒，D18 132.6 秒降至 57.7 秒。55 项相关检查全部通过，证据位于 `output/extensions/checks/native-media-latency-20261007/`。这仍是具名供应商边界的集成测试；不声称真实生图、页面/Agent 入口、用户 App 或最终交互性能已完成。接下来开放显式生成声明及可取消、可恢复的共用入口，并持续验证长素材准备的体验。

## Settings 的独立生成许可

2026-10-07：原本机执行准备预览增加可选 `mediaGenerationPreparation`，明确 `generate-from-adopted-references` 用途、已审核的工作流摘要、额外的 `POST /upload/image` 和当前是否已获批准。Main 从完整校验的包、原媒体输入 profile、实际 `media_submit` / `media_observe` 工具和固定输入节点取得能力；不导入插件代码、不访问供应商。没有这些能力的旧包仍按原形状准备。

Renderer 使用原设置 Switch，新增许可默认关闭；未勾选时省略 `approveMediaGenerations`。勾选只提交原预览 ID 和 `approveMediaGenerations: true`，不能携带路径、工作流或权限。Main 将选择保存在自己的预览 claim 中，提交前按原规则复核包、配置、文件和 owner。素材读写声明不推导新许可，旧历史查询同意仍独立。

原网络策略只允许从相同包、相同保存地址、相同四条基础路径明确增加上传路径；其他策略冲突不会被修复或覆盖。第二步在已有素材输入与会话声明上合成独立 `mediaGenerations`。已经批准的同包重复准备显示当前状态并保留权限；取消未提交预览或会话变化会清除新的勾选，原确认回执恢复不会再调用确认。设置准备不会启用插件、发起模型任务或上传素材。

兼容性：使用原本机 v1 IPC 的可选字段，不修改冻结 SDK、现有插件完整包和数据库格式；旧确认请求不会增加生成权限。新增与相关 126 项回归、UI/Electron 类型与构建、原挂载主题回归及浏览器模拟配置检查通过。实际 Main 的新许可到供应商生成、页面/Agent 执行入口和用户 App 更新仍待后续验收，不能用本轮设置组件检查代替。

### 插件页面与原 HTTP 共用生成命令（2026-10-07）

`crewon.project-media-generations@1` 是独立可选宿主服务，UI action 为 `crewon.project-media-generations.v1.generate`。已安装插件必须声明此服务，Native 必须存在独立的 `projects.mediaGenerations` 精确包/贡献点发布，真实挂载、当前身份、项目会话和素材权限必须同时有效。仅有素材读写能力不会启用生成入口。旧包无需升级 SDK；未来包可以通过原 `services.invoke` 使用协议。

页面 action 与 `ControlApiClient.projectMediaGenerations.generate` 使用相同的逻辑请求：`projectId`、`mediaInputId`、`inputRevision`、`expectedInputRevision`、`executionId`、`threadId`、`expectedThreadRevision`、`idempotencyKey`。页面不能提交工作流图、供应商地址、材料凭据或权限。原 Core 重新解析安装和项目会话，经独立素材准备后交给原 TaskCore 创建 Run。调用方必须保留完整请求；重试不能换执行 ID、幂等键或线程版本。

UI 生命周期校验覆盖读取、上传前后和数据库提交。事务中的校验不再读取同一连接，避免单连接 PostgreSQL 死锁。已提交结果经私有、单次消费的任务回执投影返回；晚到的 UI 撤销不会将已知提交改写成普通失败。关闭 UI owner 中止并等待它的准备工作，但不关闭共用的 HTTP runtime。两个入口同时提交相同请求时，仍复用一个原 Run。

HTTP 客户端沿用身份、CSRF、手动重定向和有界响应协议，单次尝试最长 90 秒，不自动重试。此期限仅适用于新客户端命令；通用插件 UI 的默认超时不变。下一步页面需展示准备、取消、恢复状态，并持久保存请求；当前不把此接口测试称为可见页面、真实 Agent 自动执行或冷启动 UI 恢复验收。主题和布局没有扩展到插件外部，宿主侧栏、设置和全局样式未改动。

### Short27 可见生成与原请求恢复（2026-10-07）

Short27 在已有“参考与分镜探索”页面增加生成、停止等待、恢复原请求、明确重试及打开项目会话。先保存当前确认输入，插件再检查当前宿主会话确实绑定这个项目，随后提交完整的原命令。准备期间锁住输入编辑及保存；脏输入、过期来源、历史输入或其他项目会话不能发起新的生成。停止等待不等于已受理任务被取消，页面会保留请求并要求恢复状态。

新页面继续使用冻结的 SDK 0.1.0 和通用 `services.invoke`，可选声明 `crewon.project-media-generations@1`。宿主 Web/Native 都先通过原 recovery 服务持久保存精确请求，再调用同一 Core。准备请求维持原有短超时，只有媒体生成操作允许最长 90 秒并显示等待/恢复操作；两层均不自动重试。读取通过 `crewon.project-media-generations.v1.getRecovery` 返回有界 `{intent}`，恢复及冷挂载本身不执行生成，已受理回执不再发起业务请求。

持久兼容性：新增 action 复用原 `generation` 意图类别及其未决请求互斥约束，不修改 SQL schema；未决概念图或媒体请求均不能被同一插件贡献点的新生成键覆盖。原 `crewon.plugin-ui-recovery.v1.getRecovery` 仍只返回旧三种 action，保持冻结 SDK 的解析格式；媒体记录只由新服务读取。新 action 扩展了持久 payload 的合法集合，因此写入媒体意图后的数据库不能直接交给不认识该 action 的旧宿主。应保留兼容宿主处理完原请求，不能通过降级或删除意图清除不确定结果。

UI 主题范围遵循[插件边界](./plugin-variability-boundary.md#ui-主题接入约定)：颜色从宿主传入，新增面板仅复用插件现有组件类，没有修改全局 CSS、宿主侧栏、账户、设置或工作空间布局。主题更新保留输入和受理状态，不创建任务。

证据位于 `output/extensions/checks/short27-media-generation-ui-20261007/`。独立完整包 337 项测试通过；SQLite/PostgreSQL 及旧接口相关回归 120 项通过；新 Web/Native transport 10 项通过；完整安装的 Short27 T10/D18 Native 用例 2 项通过。原项目、安装授权、会话绑定、素材档案和 Run 使用实际实现，供应商与浏览器展示数据明确使用测试响应，本轮没有向外部供应商生成，也没有替换用户 App。

浏览器检查了 1440×900、640×900、1440×520 和深色主题下的真实包模块，操作区可达，窄屏没有页面横向溢出。UI 全量运行有 39 项在修改前 HEAD 可复现的既有失败，另有一项并行耗时超时，单独复查 4/4 通过；完整记录保存在证据目录，不能称全量 UI 已通过。Agent 媒体自动执行、输出候选采用和后续视频/声音/成片仍待完成。
