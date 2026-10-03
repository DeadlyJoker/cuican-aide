# Native 插件历史读取与选用接线

本阶段复用现有 `StandaloneIdentity`、安装审批、文件 profile ownership、SQLite 与原应用服务，接通 Native 私有 approval/bootstrap v2、Main 项目配置、历史结果读取、图片选用和仅选用动作的持久恢复。真实 Main 已在同一文件 SQLite 上完成两次启动、原选用回执恢复及显式重放。原账户、设置页、侧栏和全局样式未修改，完整增量插件目标仍在进行中。

## 接入与权限

Native 固定私有文件 `plugin-approvals.json` 现支持 `crewon.desktop-plugin-approval.v2`，由原 Native factory 核验并生成 `crewon.desktop-plugin-bootstrap.v2`。新增 `projects` 使用 `crewon.desktop-project-history.v1`，只承载数据：元数据、历史读取、选用的独立 publication、原 ComfyUI 结果的确切版本/manifest/implementation 身份，以及仅选用动作的恢复批准。字段白名单、版本、数组及字节限额、重复项和 getter 均严格校验；文件继续要求当前 Native owner、私有权限和无链接，完整 approval 字节继续参与原 authority epoch。它不能携带 renderer 身份、授权回调、供应商地址、凭据、报价、钱包或生成/查询执行配置。

Main 在加载原私有 bootstrap 后，通过 `composeDesktopProjectStartup` 装配原项目服务、纯 ComfyUI 结果 verifier 和恢复配置。项目授权由宿主创建，精确绑定实际 LocalActor 的 principal/actor/tenant/space 及当前配置的 tenant/space，只开放已配置能力所需的项目动作；它不创建云端权限、资金或执行权威。`createStandaloneControlApiWithPlugins` 在打开 SQLite 前纯校验全部 source grant 和恢复配置；Native runtime 在读取 registry 前再次核对恢复批准。没有把 Production 配置文件导入 Standalone。

元数据 `pluginUi`、历史读取 `generationReadUi`、选用 `selectionUi` 与恢复 `uiRecovery` 分别核对 Native public package approval 和确切 pluginId/packageDigest/contributionId。批准其中一项不隐含批准另一项。历史读取必须显式配置 `generationReads`；选用必须另有 `resultSelections`、已有生成历史和可信 verifier；恢复 publication 必须匹配独立的 `selectionUi`，动作只能是 `crewon.project-generation-selections.v1.selectConceptImage`。只有实际业务 owner、声明的对应服务和实际恢复端口均可用，才发布服务可用性。

历史读取先复核真实 HTTP session、loopback、Origin、CSRF、当前 actor/profile 和文件所有权，再核对持久 Run、原 binding、原安装准入中的 principal/actor/profile、原 package digest/publisher/version。原 namespace 必须来自当前批准来源或同 profile 的安装历史。原应用服务继续核对项目权限、原提交回执、个人积分预留归属和 business activation；撤销后拒绝读取。禁用或卸载包的历史可以保留，不需重新执行旧包。

历史授权只允许读取原生成 Run。它不能提交新任务、执行供应商查询、授权配置写入、获取报价或产生新的个人积分预留。历史查询 Run 仍需其独立查询归属接线，不借本阶段的生成历史授权。生成历史 schema 必须已经存在，历史读取启动只验证读取条件，不建立付费执行链路。

## SQLite 选用恢复

显式批准恢复后，Native 使用父 SQLite 的真实 `pluginUiIntentJournalStore`、独立 migration 和持久 control realm，借用实际配置 runtime 的 `InstalledPluginRequestOwner`，并接入原 `PluginUiRecoveryApplicationService`。现有 recovery GET/stage 和业务 action 路由传入原真实 HTTP 请求作用域；读取和写入继续检查 session、loopback、Origin、mutation CSRF、actor、当前 profile ownership、source lease 与独立 publication。

stage 只保存完整原请求；cold hydrate 只读 journal，不提交业务、不确认图片，也不以当前选用指针替代原回执。显式重试仍使用原 key、完整输入、原 package/contribution 与旧 CAS，由原选用 Application 重新校验并提交或重放其真实回执。已 accepted 的 journal 保留首次已确认回执和派发计数，不被业务重放的 `replayed` 回复覆盖。同一未知请求不能通过替换输入、key 或 CAS 被覆盖；切换 source 版本不能借旧 publication 重试，返回原批准版本后仍需显式重试。确认 journal 失败只记录诊断并保留 UNKNOWN，不改变已经提交的业务结果；之后仅显式原请求重试能通过真实回执完成确认。

## 生命周期与兼容

Web 和 Native 共用历史 action owner，但保留各自真实身份入口。共享 owner 借用实际 `InstalledPluginRequestOwner`，关闭自身不关闭宿主的请求 owner；Native 总装配继续负责关闭它所持有的配置和安装 owner。

普通读取和 stage 在返回前重新验证身份、profile、source lease 和当前权限；关闭期间的迟到 JSON/ACK 拒绝返回，已经持久化的 prepared 原请求仍保留。真实选用 COMMIT 后仍通过原 Application 的 opaque committed outcome 返回已接受结果，journal 依据该原 owner 的证明确认；此后不再补会误拒已提交结果的当前权限检查。关闭同步撤回本地可用性并等待实际请求 Promise 和 journal 确认，Native 总装配随后串行关闭父 SQLite。共享恢复模块不关闭借用的 requests 或父数据库。重放沿用原 key、完整输入和旧 CAS，当前选用单独读取。

v1 approval/bootstrap 保持原精确格式和行为，v1 中添加 `projects` 仍拒绝；只有 v2 承载新增私有数据。未配置项目时不获取项目 adapter，未配置恢复时不获取、读取或迁移 journal schema，也不注册 recovery 路由。Native 固定 opt-in 文件缺失时仍只有原缺失检查，不分配 profile、安装目录或 bootstrap。此次复用现有公共 HTTP、事件、SDK、恢复 journal 及业务记录协议，新增版本仅用于 Native 私有 approval/bootstrap 数据；生成与供应商查询执行配置仍拒绝。

## 验证范围

- 新私有项目 contract **16/16**，全量 contracts **373/373**，零失败、零跳过。
- Electron v1/v2 bootstrap **51/51**：原格式、实际 Native factory、私有文件和 profile、冻结批准、approval epoch、漂移拒绝及无 opt-in 分配边界。
- Native 历史/选用/恢复/startup **38/38**，既有 Native 配置/审批/安装/activation/runtime **36/36**，零失败、零跳过。覆盖真实安装字节和 SQLite、独立 grants、请求身份与 profile、原 key/输入/CAS 的 cold hydrate/重放、版本切换、迟到 GET/stage、物理 close、opaque COMMIT 与确认失败后的 UNKNOWN；只有实际 owner 可满足其 mandatory 声明。
- 既有 Electron 配置、管理、UI lifetime 和 Control runtime **44/44**，零失败、零跳过。Electron Host 构建通过；没有重建 renderer、SDK 或独立短剧发行包。
- 原 `main.ts` 的物理重启集成 **1/1、零跳过**：真实私有 bootstrap、同一文件 SQLite、原 HTTP 路由、历史结果读取、第二张图片选用、accepted 冷读取与显式原 key 重放。两轮 Main 的 token、epoch 和 mount 改变，旧会话/旧挂载及错误 CSRF 被拒绝；选用和恢复记录各保持一条，没有新 Run、资金预留或 provider transport，两轮子进程和监听端口均实际关闭。
- Control API 与 Electron Host 类型检查、TypeScript boundary、license 和格式检查通过。当前日志及源码/保护文件摘要位于 `output/extensions/checks/native-project-startup-*-20261004.*`。

既有生产历史读取、选用、HTTP dispatch 与恢复组合 **35/35**，读取/选用/上下文装配 **26/26** 的隔离 PostgreSQL/SQLite 证据继续保留，其日志位于 `output/extensions/checks/native-project-history-*-20261004.*`。它们与本轮 Native 证据分别成立，不替代 Main 或 packaged Electron 验收。

新增用例的源 UI 包经过真实文件安装与摘要校验；原付费历史的 target 包身份、资金和供应商结果明确为具名夹具。Main 集成夹具调用真实 Standalone Main，但 bootstrap/审批数据及历史身份、资金、provider 仍为具名夹具；它不启动 packaged Electron、正式 Main/preload/App 全链路、Worker 或付费 provider。上述证据不证明真实 Native 付费执行、在线 ComfyUI、模型、报价或结算。

## 下一步

继续正式 Native/打包版完整 App 的验收。当前恢复只覆盖选用，不补齐生成或供应商查询的 mandatory 执行 owner。缺失真实 owner 时继续拒绝启用，短剧 8/9/10 不因历史和选用恢复接上而启用，也不将不可用能力标记为 ready。

Native 付费生成/查询、真实个人钱包与定价及结算、生成/查询 Worker、完整在线 S0、打包版完整流程及 E5 第二个真实企业 API 均未完成，继续按[原实施方案](./incremental-extension-subsystem-plan.md)验收。
