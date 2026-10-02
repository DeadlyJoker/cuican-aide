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

该桥当前仅支持生成，包 ID 与原 extension ID 必须相同；尚无跨插件委托。生产 main 仍没有业务动作桥和真实报价的装配。SDK 执行工厂及 Worker 按确切安装包借用执行实例已通过显式组合 API 实现，生产 Worker main 的真实身份/包许可及通用已安装业务物化仍未接通，详见下节。当前 Node 动作到任务准入的测试没有执行外部生成 API。

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

生产部署仍需装配真实身份与包许可端口、通用已安装业务包的 Agent 物化、业务动作桥及真实报价/积分结算。当前查询任务的 `source != null` 明确拒绝，历史依赖闭包、Krea2/短剧独立包、Electron 资产代理及真实 API 验收继续待完成。不能以静态自授权、预览账号或测试证明补齐这些生产边界。
