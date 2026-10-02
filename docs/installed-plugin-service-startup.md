# 已安装插件的服务启动

当前生产 Control 支持显式启用已安装插件的 UI 目录、挂载及资源读取。它复用生产请求身份和现有 Web/BFF 会话，不创建账号、profile、权限 epoch 或积分余额。未配置时保留原页面和路由。

## 部署配置

生产启动使用已有 `CREWON_CONTROL_SECURITY_MODE=production`、数据库及身份配置，再提供以下变量：

| 变量                                               | 内容                                                           |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `CREWON_PLUGIN_UI_ENABLED`                         | 严格为 `1`；不配置或 `0` 关闭。关闭时不能残留其他插件 UI 配置  |
| `CREWON_PLUGIN_UI_INSTALL_ROOT`                    | 宿主拥有的绝对安装目录，包含已核验的不可变 `packages/<digest>` |
| `CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL` / `TOKEN` | 返回当前用户所属 profile 的 HTTPS 服务及服务凭据               |
| `CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL` / `TOKEN`  | 返回当前插件 UI 权限和稳定撤销 epoch 的 HTTPS 服务及服务凭据   |
| `CREWON_PLUGIN_UI_PUBLICATIONS_JSON`               | 宿主批准的包身份及 UI 文件子集，不自动公开 Node 文件           |
| `CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS`            | 可选；默认 2 秒，范围 1–30000 毫秒                             |

发布批准项包含完整 `packageDigest`、`pluginId`、`publisherId` 和 `publicAssets` 数组。所有路径必须属于对应安装包清单，且包含实际 UI 入口；批准项最多 32 个、每项最多 256 个文件，JSON 最多 128 KiB。配置中的摘要须来自实际包校验，不能填示例摘要来绕过身份核验。服务凭据通过部署秘密配置提供，不放进插件包、界面 props 或日志。

profile 服务接收服务端已验证的 `{ actor }`，返回 `{ tenantId, spaceId, profileId }`；租户和空间必须与当前 actor 一致。策略服务接收 `{ actor, action, resource }`，其中 action 为 `pluginUi:catalog`、`pluginUi:mount`、`pluginUi:asset` 或 `pluginUi:invoke`。允许返回 `{ outcome: "allow", authorityEpoch }`，拒绝返回 `{ outcome: "deny", reasonCode }`。epoch 由实际权限权威维护，同一权限域跨挂载、资源和动作保持稳定，并在撤销与重新授权时改变；不能使用请求 UUID 代替。

启动在共享 PostgreSQL pool 上显式迁移独立安装账本，不修改原任务、配置或积分 schema。只有部署批准且当前选择为 enabled 的包可以进入目录；每次请求重新核验身份、profile、包选择及权限。关闭服务会撤掉引用并取消尚未完成的权威请求。

## 执行边界

生产 main 尚未装配插件业务动作桥，动作明确返回 `plugin_ui_actions_unavailable`。服务端组合 API 可以接收真实 `PluginUiActionPort`，该端口必须进入原 Run、Tool、operation 和个人积分准入，不可直接从界面调用 ComfyUI。

PostgreSQL 安装账本另提供 profile owner：专用连接持有真实 session 锁，所有新安装写者遵守同一锁序；提交确认后才开放同步版本投影，旧回执不回退当前选择。拥有权不是权限，也不能瞬时证明尚未被客户端观察到的网络中断。Run 准入继续在自己的数据库事务内锁定实际选择行。

新内部 `createTaskFromPlugin` 路径通过原 Turn/Run 提交，显式 `migratePluginAdmissions()` 后，在同一事务保存独立包身份、profile、选择修订、调用者、权限 epoch、原 v0 binding 关联及真实个人报价。新生成缺少报价或存储准入能力时拒绝；已接受的重复请求返回原任务和原报价。v0 的摘要、回执和 HTTP 请求格式不变。SDK `crewon.tasks` API `1` 和 `PluginTaskActionBridge` 通过真实实例绑定的调用引用进入该路径，报价后通过必需的宿主 callback 复核当前插件准入；只有私有 `PluginUiCommittedTaskAuthority` 验证的原受理结果跳过提交后的当前选择 gate。SDK 任务桥的生产组合须同时注入 actions 与 committedTasks，SDK 本身不暴露句柄签发或核验能力。

该桥当前仅支持生成，包 ID 与原 extension ID 必须相同；尚无跨插件委托。生产 main 仍没有业务动作桥和真实报价的装配。SDK 执行工厂、Worker 按确切安装包执行及通用已安装业务物化已提供显式组合 API；生产 Worker main 的真实身份/包许可仍未接通，详见下节。同包专项已使用实际 HTTP 供应商夹具完成报告生成；它不代表在线企业 API 或真实生图计费已经接通。

Web 资产通过现有同源 BFF 读取；Electron 的 `file://` 资产代理、生产安装管理、Krea2/短剧独立包和第二个真实企业 API 尚未交付。安装账本与 UI 读取的通过不能替代这些验收。

## 2026-10-03：Worker 已安装执行组合 API

`createStandaloneRuntimeWorker` 与 `createPostgresRuntimeWorker` 支持可选 `installedPluginExecution`，由可信宿主传入以下字段。它是程序化组合配置，当前没有对应的生产 main 环境变量接线；上文 `CREWON_PLUGIN_UI_*` 变量只启用 Control 的 UI 服务，不能据此启动 Worker 插件执行。

| 字段               | 宿主责任                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| `installRoot`      | 宿主拥有的绝对安装根，包含实际核验的不可变包                           |
| `authorization`    | 原授权端口，逐次检查当前 actor 的 Run 执行与扩展运行/查询权限          |
| `resolveActor`     | 根据持久化任务所有者解析当前真实 actor，不能使用固定预览身份           |
| `authorizePackage` | 核验当前发布者与确切包许可，可异步等待实际权限权威；业务清单不构成许可 |
| `maximumRuntimes`  | 可选整数 1–32，默认 32；仍有资源或未完成清理的实例占用容量             |

组合在打开 Store 前捕获配置值和方法身份，非绝对安装根、缺少必需方法或无效容量提前拒绝；与显式 `installedPluginRuntimeResolver` 并用也拒绝。迁移后，组合使用自己的实际 Run、扩展和安装 Store 构造并拥有真实上下文读取器与 resolver。该 owner 在 Worker 停止准入后、Store 关闭前释放；构造后的启动失败也回收，重复关闭不会重复清理。

执行链为：原持久化 v1 任务 → 原 Agent 实际物化证明 → 原摘要安装包 → 真实 Node lease → `crewon.execution` API `1` SDK 工厂 → 工具适配器及 router → 原 Worker。router 保留完整宿主工具目录，只覆盖业务清单确认的插件工具，分别保留原物理 owner 的回执、确认及清理职责；有 v1 来源却缺 owner、物化证明或匹配目录时明确拒绝，不回退到旧工具或最新包。历史冷加载沿用原 admission 的包摘要，不改变另一宿主的当前选择；必需的外部服务依赖因尚无持久化依赖闭包而拒绝。

每次 dispatch 重新核验当前安装选择、扩展激活、真实 actor 和包许可；停用拒绝新的 dispatch，原 `reconcilable` 回执观察与取消仍使用 `observe`，可能重新派发的 `replaySafe reconcile` 使用 `submit`。sandbox 上下文来自实际持久化 Run 和原受理回执核验后的 canonical `toolPermissionMode`，不接受修改后的调用方副本。Node setup 后的异步 `beforeCommit` gate 再核验当前权限；发布者许可等待前后也读取当前选择及身份，不能沿用最初授权。

实例仍有物理调用或未确认完成回执时保持缓存，warm 借用授权失败不会关闭它。闲置退休须有实际 `canRetire() === true`，可选 `close` 缺失也不能推断资源已消失。Host 启动清理失败通过私有 WeakMap 保留真实错误对应的失败 owner，仿造或包装错误无效；resolver 将该 owner 留在有界隔离项中，不重复 setup、不释放容量，显式关闭继续报告失败。正常清理成功的启动失败仍释放容量。

已确认 resolver 32/32、实际 SQLite/PostgreSQL composition 26/26、router 11/11、Host 全量 135/135、Worker 双库全量 1,323/1,323，均零失败、零跳过。真实安装执行专项通过 composition helper 构造 resolver 并接原 Worker，使用真实数据库、不可变文件和 Node ESM；模型、外部供应商、身份、包许可与报价为具名夹具。它没有验收完整生产 main、真实积分结算或在线生图 API。

生产部署仍需装配真实身份与包许可端口、下面的通用业务物化 API、业务动作桥及真实报价/积分结算。当前查询任务的 `source != null` 明确拒绝，历史依赖闭包、Krea2/短剧独立包、Electron 资产代理及真实 API 验收继续待完成。不能以静态自授权、预览账号或测试证明补齐这些生产边界。

## 2026-10-03：通用已安装业务物化 API

以下 API 从 `@crewon/runtime-worker` 的包入口导出，供真实宿主组合使用；没有新增自动启用的环境变量，也不替换旧 ComfyUI v0 配置或默认 Agent。

1. 用 `loadInstalledPluginBusinessRegistration` 指定实际安装根、完整包身份/摘要及当前元数据读取许可。它通过 Host 读取已核验的 `businessManifestPath`，返回由实际读取过程持有的注册对象。读取上限 128 KiB，不导入插件代码；对象复制后不能作为工厂的部署输入。
2. 用 `compileInstalledPluginAgentVersion` 传入实际基础 AgentVersion，显式指定新的 Agent ID、runtime generation 和 policy snapshot。插件增加自己的工具和任务指令，原模型、基础工具、资源及执行参数继续由宿主决定；字段使用业务清单 schema，模型工具目录会去除 Workflow 的 null 约束哨兵。
3. 用 `createInstalledPluginAgentVersionRuntimeFactory` 提供完整 tenant/space/profile、实际注册、配置、基础 AgentVersion 及其原部署、派生版本和宿主资源创建端口。端口返回值转移真实 transport/tool owner，工具目录必须与基础版本完全相同。工厂产生独立 v1 物化摘要；`deploymentBindings(tenantId)` 与派生版本通过原发布流程加入 additional versions/deployments，不改变默认 Agent。
4. 用 `InstalledPluginExtensionHost` 配合实际 `StoreBackedAgentVersionRuntimeResolver`、安装 Store、部署 Store、当前身份/profile、原授权和包许可端口，交给原配置与激活用例。该 Host 是固定 profile 的资源 owner，必须由组合关闭。配置校验不启动 Node；就绪检查核验实际物化、完整工具目录和 Node 实例上的 SDK 工厂注册。`maximumPackages` 为 1–32，默认 32，包含 pending 与清理失败项。
5. 已安装新任务必须走原 `createTaskFromPlugin`，在同一原 Turn/Run 事务锁定包、选择和个人报价。该 Host 的 `taskAdmissionMode` 要求 installed 准入；直接使用旧公开 v0 接口创建新安装式任务会在 readiness、报价和 Run 准备前拒绝。历史回执重放与旧宿主 v0 路径保持兼容。Worker 仍使用上一节的 `installedPluginExecution` owner 执行确切包。

这些调用不签发账号、包信任、报价、余额或凭据。非空 credential bindings 因没有真实租用服务而拒绝；必需的外部 Node 服务因没有历史依赖闭包而拒绝。同一包的 UI 动作与 Worker 执行组合已通过下述仓外 SDK 示例和双库专项；生产 main、实际身份与计费装配仍待验收。

## 2026-10-03：同包可选服务与 Control 动作 owner

公开 SDK 的 `services.getOptional` 是可选的增量方法。包须在 `requires` 中明确将对应服务声明为 optional，才能读取为 `undefined`；未声明、请求不同 API、把必需依赖当成可选、绑定失败或实例已清理仍然拒绝。原 `get` 保持原语义，旧 SDK 上下文仍满足类型契约；使用新方法的包必须自行检测旧宿主并明确拒绝加载。

一个包可以同时声明可选的 `crewon.tasks` 与 `crewon.execution`：Control 动作宿主只提供真实任务服务，Worker 只提供真实执行注册。包始终提供自己声明的动作服务，缺少任务服务时动作明确拒绝；缺少实际执行工厂时 Worker readiness 拒绝。不会为通过 setup 制造任务端口或空执行工厂。

Control 内部 `InstalledPluginTaskActionOwner` 接收真实任务服务、原提交回执权威、安装 Store、当前 actor/profile/UI 权限、包许可及安装根。它懒加载实际 Node 包，有界缓存按 profile、包 ID 和完整摘要区分。每次动作重新核验实际调用证明、当前身份、数据库选择、完整安装字节与许可；setup 等待后再次检查，再发布实际 Node 服务。同步选择投影只来自成功的实际 Store 读取，缓存不绑定首次 actor 或选择修订。

程序化 `ProductionPluginUiConfig.ownedTaskActions` 将该实际 owner 的 actions 和 committedTasks 成对转交，拒绝同形对象及与原独立端口混用。原端口和未配置的只读模式保持可用；`close()` 现在返回 Promise，立即撤回 UI，等待实际 setup、动作及 Node disposer 后再关闭数据库。启动或关闭清理失败继续报告并保留失败所有权，不能算释放容量。生产 main 没有新增自授权、默认价格或环境变量自动启用该 owner。

仓外开发模板见 [专业报告插件示例](../examples/plugins/professional-report/README.md)。它只依赖实际 SDK tarball，严格 TypeScript 编译后交付自含的 Node/UI ESM、业务清单和包描述；删除开发目录及 SDK 依赖后，安装器仍能校验并运行 v1/v2。原页面不被模板覆盖。Worker 正式 `pnpm test` 先串行构建这两个仓外版本，再启动消费者测试；不要与会重建 SDK dist 的其他命令并行。直接运行同包专项时必须提供 `CREWON_TEST_BUSINESS_PLUGIN_V1_DIR`、`CREWON_TEST_BUSINESS_PLUGIN_V2_DIR`；PostgreSQL 项另需实际 `CREWON_TEST_POSTGRES_URL`，不得将缺包解释为通过。

测试预构建阶段从官方 registry 安装模板固定的开发工具，关闭安装脚本；首次运行需要 registry 可达或有完整缓存。SDK 本身来自本地 tarball，消费者运行前已删除实际开发目录及依赖。

同包专项用实际 renderer loader 和安装 UI 字节，在 DOM 按钮提交后经过真实本机 HTTP、原付费 Turn/Run 事务及 owned Worker。供应商是明确标注的 HTTP/SQLite 夹具，模型、身份、包许可及报价仍为夹具；供应商数据库与 Worker 连接重开不等于跨操作系统进程的生产验收。积分目前仅验证原预留事务，单次价格和失败退款规则仍须产品确认后装配真实报价与结算。
