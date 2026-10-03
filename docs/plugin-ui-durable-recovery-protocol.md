# 已安装插件原请求持久恢复协议

日期：2026-10-04。状态：协议、SQL 日志、网页/桌面 renderer 宿主及正式 Production Main 启动配置已实现。独立短剧 9.0.0 已在原完整 Web App、Main/BFF 和全新浏览器 profile 中验证三类冷恢复、实际选用提交及进程重启后的原键重放；生成/查询仅 stage 与 hydrate，未执行其业务动作。Standalone/Native 通过独立私有审批 v2 接通选用恢复，不接收 Production 配置或付费生成/查询权限。完整 App 在线生成及打包版流程仍未验收，不代表 S0 已完成。当前证据见[实施进度](./incremental-extension-progress.md)。

## 协议边界

新能力声明为 `crewon.plugin-ui-recovery@1`。它保存原请求及已经验证的回执，不负责执行模型、供应商请求或积分事务。旧安装包没有这个声明时继续使用原流程，不增加恢复读取或注册请求。新声明仍需要真实宿主服务组装、当前挂载、身份、档案、PDP 和批准的包/贡献/动作；声明和恢复提示都不能授予执行权限。

不改变原项目生成、查询和选用动作。注册只接受以下三个原 `{ action, input }`，包括原始幂等键、保存引用和全部 CAS：

| 原动作                                                        | 原执行结果                                |
| ------------------------------------------------------------- | ----------------------------------------- |
| `crewon.project-generations.v1.generateConcept`               | 原 Thread / Turn / Run 与插件积分准入回执 |
| `crewon.project-generation-queries.v1.queryConceptGeneration` | 原操作的独立查询 Turn / Run 回执          |
| `crewon.project-generation-selections.v1.selectConceptImage`  | 原 operation/resultIndex 的不可变选用回执 |

不接受客户端的账户、来源 pin、付款人、URL、phase、receipt 或新的请求键。准备 Thread 的原 `createThread` 不属于这三个动作；本阶段不能据此声称所有创建请求都已支持进程重启恢复。

## HTTP 与客户端

`GET /api/v1/plugins/ui/mounts/:mountRef/recovery` 不接收查询参数或请求体，返回该实际挂载 family 中每个动作的一条提示，优先未确认请求，否则取最新终态，最多三条。提示包含原 public source pin、原请求、记录 revision、`prepared/dispatched/accepted/refused`、派发次数、可能派发标记、匹配原请求的回执、retryable 和 reasonCode，不暴露账户或档案权威。旧包/档案的未知请求可以保留在提示中，不能替换为新来源重试。

`POST` 同一路径注册原请求，返回 `created/replayed` 和持久记录。这个 ACK 表示请求已保存，不表示任务或选用已提交。客户端严格配对原 key、CAS 和索引，使用原鉴权/Origin/CSRF/取消传输，GET 和 POST 响应均限制为 60 KiB，原请求限制为 24 KiB。网页代理仅允许这个确切 GET/POST 路径，不跟随重定向。

实际执行顺序必须是：注册请求并确认 SQL ACK，再调用原动作。注册网络结果不明或响应无效时，不调用原业务。晚到的注册只能留下提示，不能自动执行。原业务服务在执行前再次检查真实当前授权，并将派发次数持久提交；缺少注册时拒绝执行。相同原请求的显式重试可以重新注册并沿原动作重放，不能自动生成新键。

## 存储、归属与迁移

存储是原 Control 数据库中的三个独立表及显式版本标记，使用原 SQLite 或 PostgreSQL 连接。factory 默认关闭，不自动迁移。realm UUID 在显式迁移时生成并持久保存；账户归属为 realm、真实 tenant、space 和 principal。浏览器的用户 ID、临时端口、Origin 或 token 不作为持久账户命名空间。

原完整 admission pin 包括 actor、profile、包、贡献和动作。原幂等命名空间保留这些字段，不用新身份或新包替换；epoch 和 selection revision 保留审计，不能制造新的业务幂等身份。生成和查询的宿主恢复继续要求原完整 public source pin；图片选用保留同包重新启用后的既有五字段匹配规则。

每个账户最多 32 条记录。新增请求只能淘汰最早的 accepted/refused，不能丢弃未确认请求。同一 kind/plugin/contribution 的未确认请求阻止新 key，跨窗口、档案或包版本也不能绕过。相同 key 的请求体必须完全一致。记录序号来自账户 SQL 锁，不能依赖客户端时间排序。

注册与派发分别在同库事务内锁实际已安装 pin，并在 COMMIT 前复验调用存活和当前授权。PostgreSQL 复用借出的连接，支持 maxPoolSize=1，不在事务内再借连接；payload verifier 为同步纯函数，不调用网络或 SQL。身份与策略仍使用既有外部 authority fence，不能借恢复提示跳过当前检查。SQLite 在同步写事务前完成异步检查，并在 COMMIT 前保留同步 active fence。不完整或未知 schema 是错误，不能伪装为空记录。

## 正式 Production Main 接线

原 `apps/control-api/src/main.ts` 通过可选 `CREWON_PROJECT_COMPOSITION_CONFIG_PATH` 加载项目与恢复的部署数据。未配置时不读取新文件或创建项目服务；原默认启动保持。该路径仅支持 Production PostgreSQL，Standalone 明确拒绝。原 UI、[安装管理](./installed-plugin-service-startup.md)、[任务/配置启动](./installed-plugin-task-startup.md)及 BFF/身份/PDP 配置继续独立提供。

文件必须使用绝对规范路径，是当前 OS 用户拥有的非空普通文件，只有一个硬链接且没有组/其他用户权限。路径不能经过符号链接；文件不超过 64 KiB，必须是有效 UTF-8 JSON。读取前后核验原 inode、内容大小、权限和纳秒时间，文件替换或未知字段导致启动失败。macOS 的 `/var` 别名需要先转换为真实 `/private/var` 路径。

顶层只接受 `schemaVersion: "crewon.production-project-composition.v1"` 和以下可选字段，复用原配置结构：

| 字段                | 含义                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `pluginUi`          | 项目元数据动作批准的包/贡献列表                                    |
| `pluginGenerations` | 原生成的 source→target 包/贡献/动作映射                            |
| `pluginQueries`     | 原查询的 source→target 映射；必须配置 `generationReads`            |
| `generationReads`   | `version: "crewon.project-generation-read.v1"`                     |
| `generationReadUi`  | 原读取动作批准的包/贡献列表；必须配置 `generationReads`            |
| `resultSelections`  | 原选用版本、`adapter: "comfyui-krea2"` 和真实业务身份 `identities` |
| `selectionUi`       | 原选用动作批准的包/贡献列表；必须配置 `resultSelections`           |
| `uiRecovery`        | 原恢复版本及包/贡献/三种原动作列表                                 |

`identities` 中的每项只有 `pluginVersion`、`manifestDigest` 和 `implementationDigest`，来自已核验的实际 Krea2 业务包。选用复用原纯图片验证器；此文件不接受供应商 URL、执行代码、授权端口、账户、付款人、钱包或报价。原供应商地址仍从原持久化业务配置核验。

每个恢复动作必须有同一完整 source publication 的生成、查询或选用 owner 配置。读取能力必须有实际 task/configuration reader；完整生成/查询仍需要真实任务配置和批准的 UI publication。缺失这些依赖在打开业务数据库前拒绝。Main 注入与其他原 Application 服务相同的真实 `DynamicPolicyAuthorization`，不会根据部署 JSON 授权用户。

可选 `CREWON_CONTROL_DATABASE_MAX_POOL_SIZE` 仅接受 Production 下的规范十进制 `1`–`64`。缺省保持原 Pool 默认值；Standalone、前导零、空白、指数或越界值拒绝。它传给原 PostgreSQL Store，不创建第二个数据库或执行循环。

## Native Main 接线

Native 使用固定私有 `plugin-approvals.json` 的 v2 项目配置，经原 Electron factory 校验并生成 v2 bootstrap，再由原 Main 在 Standalone SQLite 分支装配。v1 继续保持原字段和行为。审批只承载有界数据；项目元数据、历史读取、图片选用和选用恢复分别批准确切包与 contribution，不能相互借用权限。`uiRecovery` 仅允许原 `selectConceptImage` 动作，缺少同源 selection owner 时在数据库和 registry 初始化前拒绝。

实际恢复 owner 借用原请求 owner 与 SQLite，不接管其生命周期。真实 session、Origin、CSRF、当前 actor/profile、source lease 和局部授权仍逐次核验；关闭等待物理调用与确认事务结束，原业务已验证的 COMMIT 保留成功。默认关闭时不获取恢复 adapter 或迁移 schema。具体私有协议、兼容测试与验收边界见[Native 接线](./native-plugin-history-integration.md)。

## 未知结果与确认

新 Host 首次 ready 之前必须完整读取并恢复三个 lane。恢复加载失败时保持不可用，不用空 intent 掩盖错误。冷恢复的 prepared/dispatched 都显示 UNKNOWN，保留原输入和原 key，没有自动业务 POST。所有 lane 先校验、全部写入宿主快照，再通知页面，避免历史 accepted 覆盖另一个未确认请求的来源。

短剧 9.0.0 的显式原请求重试使用独立实时屏障：同一保存来源、确切 Host 请求且 retryable 的 UNKNOWN 可以逐一重放，仍保留原 key 和旧 CAS。任何实际业务写请求未结束、pending、来源恢复或冲突、元数据写入、编辑和未就绪都会阻止重试；回执已到但物理请求仍在途时也不能并发重试另一通道。新生成、查询、选用及元数据写入继续使用原锁。归档或后来增加的元数据版本不会替换原请求；当前授权仍由真实挂载与后端逐次核验。

accepted 只能由原业务服务已经验证的、不透明提交事实确认，不能由浏览器写入。回执一旦确认不得回退；重放的 disposition 可以不同，但逻辑回执必须一致。图片的原回执与当前选用指针分开，当前状态仍需要单独读取。

refused 只用于图片选用第一次真实派发的四类明确提交前 CAS 冲突：项目 revision、素材 revision、operation revision、选用 revision。持久派发次数必须仍为一，且没有 accepted 或并发重试。已有 UNKNOWN 的重试、普通网络错误、生成和查询错误都不能据此宣称未提交。

原业务 COMMIT 与本阶段恢复记录确认属于两个事务。确认存储失败不能把已验证的业务成功改成失败；保留原成功回执并记录诊断，冷读取可能仍显示 UNKNOWN，需要显式使用原请求重放核验。因此本阶段不声称跨这两个事务的原子确认，也不能用存储层冷读取测试代替完整 Host / Control / App 重启验收。

## 验收范围

实际 9.0.0 发布 ESM **78/78**、原 UI 窄回归 **21/21**及原完整 Web App 联合用例 **1/1、零跳过**通过，各组不相加。联合用例确认首次生成 stage 的 SQL ACK 丢失后无业务 invoke、ready 前三个 UNKNOWN 完整恢复且无自动 mutation、实际 selection owner 提交成功但独立 journal 确认失败、Main/BFF/browser 重启后显式原 key 重放。原回执 revision 1 与独立 GET 的较新当前指针 revision 2 分开保留，未回退当前选择；effects 的记录数量和具名 wallet 不变，Thread 基线 2 保持 2。原账号菜单和设置页可见，原 App 源、正式资产及共享 CSS 保持一致。证据见 `output/extensions/checks/plugin-ui-recovery-full-app-ui9-browser-20261004/full-app-parent-proof.json`。

该联合用例的生成/查询只 stage 与 hydrate，选用使用具名原付费历史和图片结果，没有 Worker、模型、供应商或生产资金调用。零工具 catalog 仅证明原 App 只读连接。后续仍需原完整及打包 App 的真实 Krea2 保存、生成、查询与选用链路及实际企业 API 验收；此结果不等于 Native、S0 或 E5 已完成。账户/来源变化、并发、配额和 schema 等专项的既有验证范围分别见实施进度，不能由本次单一完整 App 用例推定全部覆盖。

真实个人身份、插件钱包、价格权威和第二个企业 API 仍按[实施方案](./incremental-extension-subsystem-plan.md)完成，不能使用具名测试夹具冒充生产资金或生产身份。
