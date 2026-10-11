# CrewON 基础能力与插件体系当前状态

日期：2026-10-11。目标仍是先稳定基础能力，完成可独立开发、安装和恢复的插件体系，再恢复业务插件建设。本页更新交付判断；[2026-10-09 审计](./dsh-plugin-foundation-review-20261009.md)保留各次历史版本、验收结果和限制。

2026-10-12 后续源码修正纯服务 provider 缺少 UI publication 时导致原插件目录整页拒绝的问题。仍复用原目录、安装和任务管理，只过滤经过真实字节/来源核验且没有 UI 的包，不给服务包授予 UI 权限。最终 UI/Host/Control 265/265、零跳过，类型与边界检查通过；未部署 Web 或正式桌面，详见[纯服务目录过滤](./plugin-node-catalog-exclusion.md)。

基础建设审计基线为 `53debe063`；下述本轮模型与会话修复在其后提交。正式 `/Applications/CrewON.app` 已更新为 `0.1.70`。它保留已核验 `0.1.69` 的生产闭包，仅同步 `8b7da48ed` 的 HTTP 拒绝分类修复与 UI 包版本；本轮新增插件目录库和可选状态路由未进入正式候选。22 个受审查源文件、21 个前端/宿主产物、八个运行时文件及 1818 个生产闭包文件均核验，五个已发行 Native 宿主源逐字保持；正式 ASAR 和运行时与候选一致。详见[候选核验](../output/plugin-foundation/gateway-root-cause-20261011/candidate-0.1.70-verification.json)、[正式安装核验](../output/plugin-foundation/gateway-root-cause-20261011/installed-0.1.70-verification.json)。当前正式 profile 有效业务插件为 0，历史包、任务和产物保留。这些已发行的基础文件并非干净 Git HEAD，候选身份按实际文件与摘要记录，不能只用源码 SHA 冒充完整构建身份，也不能把源码、临时数据库验收、真实 Web 与正式桌面四种证据互相替代。

下述 F2/F3 的实际状态 owner、自动实例协调、插件右栏与项目 namespace 是当前权威源码工作区的后续增量。它们已有各自的源码、临时数据库和组件验证；未进入上述 `0.1.70` 正式 App。独立源码 Web 预览也不能替代正式包或真实插件全生命周期验收。

源码 `52009d93a` 另解除了一处已复现的 F1 等待：已确定的 HTTP/协议错误不再等待响应体取消 promise，错误内容超过原 64 KiB 上限后也按原 null 分类立即交付。原 HTTP 分类、Retry-After、采样预算、取消和私有记账优先级保留；POST 400/404/429 未超上限的诊断内容读取仍等待原 EOF/idle，历史外部断流也未定因。真实适配器与 Kernel 专项、完整回归通过，但这一增量尚未更新 Web 或桌面，见[错误与清理分离](./model-http-error-cleanup.md)。

本次 `0.1.70` 更新先通过真实 Web UI 的本机 HTTP 400 故障注入，再恢复实际网关，顺序完成 `gpt-6.1-sol` 和 `gpt-6-astra` 两次调用。故障注入证明明确拒绝不会因错误内容挂起被改成可重试超时；真实网关成功样本各一次调用、零重试。桌面随后用原 admin、原工作空间和会话完成真实 `gpt-6.1-sol` 短回复，7.504 秒、首段 5.884 秒、一次调用、零重试。正常退出重开后原账号、旧 40 行产物、新回复和模型选择恢复，同一 Run 未重新生成。本轮未重复桌面长输出或并行测试。证据与范围见[HTTP 拒绝及 Web/桌面验收](./model-http-rejection-retry.md)。首次外部断流仍未定因，不能用本次成功将其销账。

上一版 `0.1.69` 正式 App 验收中，原 admin 登录、工作/任务/助理/日程/资源入口、既有工作空间、会话和历史回复均可见，没有短剧、Krea2 或出行插件入口。真实桌面新会话先用 `gpt-6-astra` 完成 40 行，再在同一会话切换 `gpt-6.1-sol` 完成短回复，两次均一次调用、零重试、唯一最终消息。正常退出重开后，原账号、同一会话、两份产物与 `gpt-6.1-sol` 选择恢复，模型调用仍各一次，没有重新生成。其独立[候选](../output/plugin-foundation/gateway-root-cause-20261011/candidate-0.1.69-verification.json)与[安装](../output/plugin-foundation/gateway-root-cause-20261011/installed-0.1.69-verification.json)证据保留。没有据此宣称工作空间全部操作、设置、所有模型或异常网络已验收。

## DSH 研究核验及采用范围

DeepSeek Harness 官方仓库确实引用 Cordis 论文 **A Programming Paradigm for Spatiotemporal Composability**，arXiv:2608.25512v1。它是动态组合的机制研究，不是 DSH 性能测评。[官方仓库](https://github.com/deepseek-ai/deepseek-harness)、[论文版本](https://arxiv.org/abs/2608.25512v1)。

论文 §5.3 的 Koishi 案例报告生态应用情况，并非受控的性能或开发效率对照；不能据此宣称 CrewON 会更快。§5–6 还限制了保证范围：资源清理由作者正确实现，外部已发生的操作不能凭卸载逆转，依赖访问约束不等于恶意代码沙箱，独立包版本仍需兼容治理。[论文全文](https://arxiv.org/pdf/2608.25512v1)。

可采用的工程机制是带所有者的注册与清理、版本化服务依赖、依赖撤下后清理消费者、依赖恢复后重新准备，以及明确的组合身份。DSH 的 bundle/profile 是应用分发与装配机制；不能把“所有部分可组合”解释为普通业务插件可随意改宿主账号、授权、导航和聊天。[固定提交的架构](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md)、[服务依赖](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/user/develop/framework/service.md)。

CrewON 继续使用现有 Node、Run、Tool、Store 与 SSE 路径。业务插件的可变范围仍是声明的服务、工具、Skill、内容区页面和局部贡献；主题由宿主传入，基础 shell、身份和政策由宿主保持。Skill 提供任务方法，不能替代服务授权、事务与执行幂等。此范围见[插件可变边界](./plugin-variability-boundary.md)；[早期能力方案](./agent-capability-plugins.md)是历史设计，不能作为当前实现清单。

## F0–F5 的完成证据、缺口与放行条件

| 阶段                    | 当前判断                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| F0 卸载与基础基线       | 当前正式 profile 已卸载业务插件，历史保留；正式冷启动、原账号和真实聊天已验收，其他基础行为待补齐    |
| F1 基础聊天与启动可靠性 | 新默认 Standard 已通过真实 Web 并行、输出中刷新与继续发送；历史外部首次断流仍未定因                  |
| F2 公开能力与配置装配   | 源码状态 owner 已绑定原 Profile 队列和实际身份，standalone withPlugins 路由已接；正式包尚未同步      |
| F3 资源与依赖协调       | 源码 Profile 自动协调复用唯一 NodeHost；Native 原图执行已显式接线，必需服务的 UI 发任务路径待接通    |
| F4 独立开发协议与工具   | tools/SDK tarball、仓外初始化/编译/校验及最小服务模板已有实证；完整开发场景与兼容验收未完成          |
| F5 可插拔闭环           | 独立模板的真实 SQLite 生命周期及测试模型组合路径已验收；正式产品、真实外部恢复和分布式路径未全部验收 |

### F0：卸载业务插件，保留基本能力与数据

- **完成证据：** 三个历史业务插件保持卸载，当前正式 App 未显示其入口；admin、既有工作空间和历史会话仍可见。实际 Control Main 的零插件冷启动回归保留认证边界、历史与卸载状态，记录于[历史审计](./dsh-plugin-foundation-review-20261009.md)。
- **缺口：** 正式 Electron 冷启动、原账号、零插件真实聊天已有本轮验收；Main 的其他回归仍使用临时 SQLite，不能替代工作空间全部操作、设置与其他基础入口的行为验收。
- **放行条件：** 正式 App 用原登录与历史完成冷启动、工作空间/会话切换、基础设置及零插件聊天；保留原数据和未知外部回执，不重复派发历史任务。

### F1：基础聊天、模型目录与启动可靠性

- **完成证据：** 已实现零插件/无模型时基础 Control 启动、明确凭据拒绝时停止复用旧模型目录、插件准备失败的有条件隔离，以及直接增量输出与流式空白字符消费修复。此前四次真实 Web 运行覆盖 60 行、100 行输出期间刷新及两会话并行；每次一个模型调用、零重试、收到显式终态，刷新未重新生成。本轮另有 Standard 请求的 `gpt-6.1-sol` 与 `gpt-6-astra` 两个真实并行调用，各一次调用、零重试、唯一完整 24 行结果，用时 22.363 与 35.449 秒。首次刷新发现 B 跳到 A 的路由缺陷，已通过读取当前页面 URL 修复；修复后的 B 刷新保留原会话与结果。原登录与历史保留。详见[历史 Web 与网关证据](../output/plugin-foundation/gateway-root-cause-20261011/analysis.md)、[请求与响应补充证据](../output/plugin-foundation/gateway-root-cause-20261011/request-response-findings.md)。
- **缺口：** 本轮成功样本不能覆盖所有模型、附件、停止、失败和网络状态。历史外部断流未复现、未确定首次故障位置；当前网关原生 Responses GET 返回 `Invalid URL` 404，不能宣称具备已完成结果取回能力。生产 `storeResponses=false` 没有发 GET；历史整轮重发发生在流空闲超时后的 sampling retry，不能把 GET 404 写成其触发源。正式包虽已覆盖当前两个模型、冷启动与保存恢复，临时断网、停止和失败恢复仍需补齐真实验收。
- **放行条件：** 对正式包补齐基础行为验收，失败按同一 request ID、私有调用时间线与协议终态定位；验证临时断网、重连、停止和失败恢复不会重复生成或串会话。未定因的旧故障继续保留，不能用成功次数将其销账。

### F2：公开能力契约与配置装配

- **完成证据：** [公开 SDK](../packages/plugin-sdk/src/sdk-types.ts)已有声明式服务/API 版本访问、可选服务、资源、Node/UI 入口与主题输入；宿主强制身份、声明和版本检查。Native 基础身份独立于插件文件，原严格批准解析未放宽。真实安装选择提交后已有组合元数据同步，元数据发布失败不会伪装成选择回滚，见[协调核心与元数据同步](./plugin-composition-coordinator.md)。本轮 `2fd79e6ce` 提交了[真实 Node 服务目录库与核心身份适配器](./plugin-node-host-services.md)：同一不可变目录提供实现、元数据和协调注册项；`crewon.execution` v1 与 `crewon.tasks` v1/v2 只接受真实实现所有者，保留原租约、调用身份与每次授权。覆盖真实安装后的 ESM setup、租约清理、SQLite 任务回执及授权撤回，使用临时 profile。`8d51e4e60` 提交了[可选组合状态协议与路由](./plugin-composition-status-protocol.md)：严格 DTO 分开元数据发布与实际 Node 状态，沿原身份入口鉴权，分页至多 50 项、响应至多 64 KiB，不返回凭据或内部异常；OpenAPI 和生成类型同步，覆盖状态约束、分页、无 owner 的 404、身份与故障边界。两项是已实现的库与可选传输能力，不是正式产品接通的证据。
- **本次源码接线：** [安装 Profile](../apps/control-api/src/desktop-plugin-installation-profile.ts)由[专用 owner](../apps/control-api/src/desktop-plugin-execution-service-owner.ts)持有实际 execution Registry，NodeHost 实现与元数据发布共用一次捕获的服务目录。关闭或失去所有权同步撤销注册；没有全局 tasks 服务，也没有据此批准业务任务。此前实际 Application/SQLite 集成与相关回归 70/70、[纯状态投影](../apps/control-api/src/desktop-plugin-composition-status-owner.ts)专项 6/6 的证据保留。后续源码已把 `PluginCompositionStatusControlService` 绑定原 Profile 操作队列、当前 actor/epoch、真实 SQLite claim 与生命周期；[standalone 装配](../apps/control-api/src/standalone-composition.ts)仅在 `withPlugins` 准备出实际 owner 后接入 `GET /api/v1/plugins/composition/status`，未配置时仍返回 `404 route_not_found`。状态读取沿原身份入口授权，不运行 setup、不协调实例、不复活冷启动代码；只有精确的当前 accepting 实例才为 ready，cold、UI-only 与 retained 仍为 unobserved，清理失败如实呈现。实际路由、身份、撤权、分页和 owner 丢失的行为见[状态集成测试](../apps/control-api/src/desktop-plugin-composition-status.integration.test.ts)。这些未进入 `0.1.70` 正式包。
- **缺口：** 状态 owner 的源码绑定已完成，正式包尚未包含这次接线。`compositionState` 仍是内部元数据观察，`published` 不表示服务就绪；UI 可用不能冒充 Node 服务实现。状态协议不授予任务执行权限。F3 的 Native 原图执行已在源码显式接通；必需服务的 UI 发任务、F5 的正式产品闭环仍未完成，不能由状态路由或临时数据库测试替代。
- **放行条件：** 基于已绑定的同一宿主 owner、服务目录、实现身份和当前批准，完成 F3 正式任务执行适配；服务获取与每次调用继续执行原授权。Web 验收通过后再核验候选和正式包，覆盖服务消费、批准撤回、配置失败、跨账号拒绝及实际就绪/清理状态。原组合任务查询仍需正式执行装配和独立兼容验收后才开放。

### F3：实例资源、依赖协调与原任务组合

- **完成证据：** [运行期资源](./plugin-runtime-resources-protocol.md)、[依赖规划](./plugin-dependency-reconciliation-design.md)、[协调核心](./plugin-composition-coordinator.md)、[组合锁与原 Run 引用](./plugin-run-composition-binding.md)、[跨包执行](./plugin-execution-composition.md)均已有实现。它们保留旧借用及原依赖，受影响实例先撤权再清理，原任务恢复逐节点重新授权；不会按今天的 head 替换旧 Run。
- **本次源码能力：** [组合协调器](../packages/plugin-host/src/plugin-composition-coordinator.ts)可以创建唯一安装 adapter，共享它拥有的 NodeHost；此前相关 PluginHost 全包 394/394、类型检查证据保留。当前[实际 Profile](../apps/control-api/src/desktop-plugin-installation-profile.ts)已由原操作队列串行持有协调器及唯一安装 adapter，[实例 owner](../apps/control-api/src/desktop-plugin-instance-composition-owner.ts)在真实选择提交后自动协调受影响实例，复用已接受实例，不重复 setup。撤下提供者先同步撤权再等待元数据与清理，消费者恢复使用当前真实提供者；有 accepting 消费者的热升级仍明确拒绝，需先停用再升级。准备与发布前校验实际 Store head、选择、scope/epoch、批准、准备身份与提供者对象；关闭等待未完成准备和队列，丢失 Native 权威或 SQLite claim 即撤权。完整原存储图保留 UI-only 节点，Node 观察使用私有投影，不把 UI-only 当激活失败；读状态、读图或重放旧回执不会恢复代码。实际路径覆盖见[实例协调集成测试](../apps/control-api/src/desktop-plugin-instance-composition.integration.test.ts)。[Task Core](../apps/control-api/src/installed-plugin-task-runtime-core.ts)的可选严格 `compositionPolicy` 从同一实际 Store 读取原图，读前后核对 owner/scope/epoch；历史锁保留原 epoch，省略 policy 仍为 v0。此前 Core/Native/desktop/read 专项 38/38、Application 原组合专项 3/3 证据保留，没有自动迁移、发布或重新签发旧收据。
- **Native 源码接线：** `cbc506fc7` 把真实 Native Task Core policy 与 [Worker 原图执行](../apps/runtime-worker/src/plugins/installed-plugin-native-worker-composition.ts)接到同一份严格 v3 可选声明。真实 scope、包批准与 epoch 来自当前 Native owner；执行、服务发布与消费末端再次校验，旧 epoch 只能在当前权限下观察原图，不能重新执行。实际 SQLite、安装包、Task Core、编译 Agent 和 Worker 的 A→B 调用及冷恢复已有行为验证；模型和 peer 是明确的离线替身，不能作为真实外部验收。兼容约束与证据见[Native 显式启用](./desktop-plugin-composition-opt-in.md)。
- **缺口：** 正式 `0.1.70` 尚未包含自动协调和 Native 原图接线，现有正式配置也没有开启声明。正式 Native/个人积分 Runtime 的普通 UI task action 已在后续源码接到唯一原 Core bridge 与原 Profile，共享服务与 UI invocation、启动绑定、实际撤回/冷恢复和旧回执重放的十一文件回归 89/89、零跳过，见[原任务绑定](./plugin-shared-task-core-binding.md)。专用项目 generation/query/historical-query owner 仍有包 Host；mandatory 业务服务与 Worker 的完整生命周期/ABI 接线仍未完成。项目与媒体服务缺少真实版本化 Node 元数据时仍拒绝；查询和 Store 的 source guards 保留，不能靠删除拒绝条件开放旧任务。
- **放行条件：** 复用现有 Profile/Coordinator 的唯一真实 owner，完成必需服务的 UI task action 借用及真实服务元数据。覆盖依赖升级/撤回/恢复、准备中撤权、清理失败、旧 Run 观察及冷恢复；新旧图各用原实例，失败不伪报就绪。声明必须在支持它的 Main、Control、Worker 一同升级后启用，先完成 Web 验收再更新正式包。

### F4：仓外独立开发与分发

- **完成证据：** [tools](../packages/plugin-tools/README.md)复用原包核验器，提供 `init` 与 `check`；[SDK](../packages/plugin-sdk/README.md)与 tools 真实 tarball 可离线装入仓外项目。[分发测试](../packages/plugin-tools/test/distribution.test.mjs)覆盖初始化、TypeScript 编译、独立 ESM 包检查和实际宿主加载；删除作者目录后已安装包仍可运行，不依赖宿主源码或另一套运行时。
- **缺口：** 当前[最小模板](../examples/plugins/minimal)是 Node 服务模板，不能代替 UI、Agent 执行和跨插件消费的完整开发体验。本地 tarball 不等于注册表发布或可信签名，包检查也不等于授权、依赖可用或持续可信。
- **放行条件：** 独立作者按公开文档完成声明、构建、安装和故障定位，不改宿主源码；对 UI/Agent/跨包场景补充模板或明确契约示例，公布实际支持的版本与兼容覆盖。每次安装和执行仍重新核验包与授权。

### F5：正式产品的可插拔闭环

- **完成证据：** [独立模板生命周期测试](../packages/plugin-tools/test/installed-template-lifecycle.mjs)使用真实 tarball、仓外包、原 Application/Store/Host 路径，完成 SQLite 安装、启用、升级、回滚、停用、再启用、卸载及数据库重开；旧包和借用保留。另有原 Application 任务签发、Worker 测试模型流及原图冷装配证据，见[执行装配](./plugin-execution-composition.md)。这些已实现能力不再列作“尚无实现”。
- **缺口：** 生命周期数据库与身份是临时测试环境，模型 transport 是测试适配器；不能算用户正式 App 的安装/授权/UI、真实外部模型恢复、组合查询或 PostgreSQL 分布式管理验收。F2 状态 owner、F3 Profile 自动协调和 Native 原图执行已在源码绑定，正式 `0.1.70` 尚未包含；必需服务的 UI 发任务、项目工作空间产品接线与正式安装闭环仍缺失，F5 不能判定交付。既有环境条件跳过项也不算通过。
- **放行条件：** 在正式产品入口以最小验收插件完成全生命周期，核验登录、当前批准、就绪状态、调用、取消、升级后的原任务恢复、失败回滚和冷启动；涉及分布式路径时使用真实 PostgreSQL 验证事务与并发。通过后才恢复业务插件，不重提状态未知的 ComfyUI 操作。

## 本轮源码的页面与项目工作空间边界

插件页面现在复用 `AppCommandShellRoute` 唯一的右侧 `CommandWorkspaceCapabilityDrawer`，保留中间原 Agent 会话、输入草稿、模型、资源、权限、发送/停止与流式能力。宿主通过 portal 调整展示位置，不给插件账号、导航、HTTP client 或全局主题权限，原挂载授权与清理路径保留。关闭插件恢复先前工具状态；正常宽度由原 grid 动态分配，小窗上下排列，短窗口允许外层滚动而不裁剪插件底部。空目录不恢复业务入口。组件/样式覆盖与限制见[右栏宿主边界](./plugin-panel-host-boundary.md)。这项源码完成不等于正式 App 已交付，也不等于真实业务插件已验收。

插件项目仍使用同一套宿主 Workspace/Thread 能力。新增[持久 namespace 与事务隔离](./plugin-project-workspace-isolation.md)按真实账号、profile、插件、发布者与项目绑定不透明 workspaceId，原普通 create/fork 和项目 binding 写入使用同事务 fence；归属不随包升级变动，也不能收养旧会话占用的空间。后续已堵住空/普通 workspace、关联已有会话及第二个已安装插件冒领同一项目的绕行；同账号/profile/project 预留锁与 workspace 锁共同保护首次 namespace 创建和所有 binding 写入，历史不重新归属。[原 Native 分配器](./plugin-project-workspace-native-allocation.md)已能创建可信项目目录并向原 v2 registry 非激活追加，保持当前文件读取与活动 workspace，支持稳定 ID、实际进程 CAS、排他 lease 和明确恢复。两部分尚未产品接线，中央 Agent/Node provisioning、旧 CreativeProject 查询的插件范围和文件面板仍缺失。不能仅凭 namespace 或 Native registered 宣称 SQL 已提交、中央会话已绑定、全部项目查询已隔离或用户已经拥有执行权限。

后续只读审计确认，旧 metadata 与产物的 principal 范围、两条项目创建路径及 UI receipt 仍有插件隔离缺口。workspace namespace 不能充当 metadata 创建归属证明。按[同一套项目管理的隔离接线](./plugin-project-management-isolation.md)先建立新项目的明确归属与完整读写/replay fence，再接原目录分配和 Conversation；旧项目不收编，公开 v0 形状不变。这是已确定的实施顺序，尚未接线或发布新项目创建和管理协议。

源码 `154d7f4b7` 已补齐原库的 metadata owner 存储基础，复用现有 SQL migration/inspection 基础和 domain 八字段解析：独立 sidecar 的唯一占用键对齐真实 tenant/space/project，外键核对原 stored principal，JSON 与列逐字段一致，owner/marker 不可变，部分 schema、shadow 与未知版本拒绝。新增 SQLite duplicate-insert fence 阻止默认 recursive_triggers=0 下的 REPLACE 绕过；保留名称被无关索引占用时也不会误判为完全缺席。迁移使用原 caller-owned 连接和事务，不回填旧 metadata、brief 或 receipt。模块没有 writer/adoption、公开导出或生产自动迁移，尚未保护所有旧 CRUD/产物/replay；原创建交易和绑定管理视图仍需接线。

2026-10-12 源码增量 `41abbb1fe`、`743574a24`、`3de28fbdf` 已接线原 CreativeProject 元数据、Foundation 和公开 Asset Store 的普通入口隔离：分页在 SQL 内过滤，回放检查实际保存项目，SQLite 使用同一快照，PG 使用原同连接 READ COMMITTED 事务与迁移共享锁，新增等待后仍执行原最终授权和实际租约检查。旧项目和历史保持；未开放 owner writer、未自动迁移、未更新 Web 或桌面。各组真实两数据库回归及其他产物/关联入口的剩余范围见[原管理入口隔离](./plugin-project-legacy-access.md)，不能据此宣称全量插件项目闭环。

同日 `bb9081d8d`、`a7d8d2836` 继续复用原 Text v1、SourceUpload、Foundation 和 Run，覆盖公开文本读写/保存回执、实际上传关联、来源复制与保存指针、Run facts/admission/required digest 及冷恢复。原显式 DDL 迁移使用原锁与验证器；部分 owner 不阻止独立迁移，也不被修复，数据访问仍拒绝。所有新增 SQL 均置于最后原完整 qualification 与真实物理租约检查之前。最终 Text/Core 380/380、来源 Store 212/212、Control 56/56，root 另复跑受影响 Asset 64/64，实际 SQLite 与自有 PG 18.6、零跳过；组间有重叠，不相加。Store/Control 类型、boundary 与格式检查通过。Control 是临时原库 mounted 协议集成，不能代替产品 Web；未部署、更新正式桌面、恢复业务插件或开放 protected owner writer。结构化 v2、计划/journal、共享 generator、其他关联与冷回放继续按[剩余清单](./plugin-project-isolation-remaining-entrypoints.md)实施。

随后 `991cac2ed`、`29cfd7d98`、`1a4a6ca2c` 继续在原管理器中完成独立大纲 v2、Text Plan/journal、共享 Asset、独立 recovery、media input/result/material 与真实 stage admission 的普通入口隔离。Store 分组 80/80、89/89、141/141，Control 分组 9/9、11/11、26/26，原任务聚合兼容 63/63，均使用真实 SQLite/PG、零跳过；组间重叠。还修复实际 PG 单连接回执授权再次借连接造成的死锁。原计划两个需要安装目录的额外 fixture 仍明确跳过。剩余外部 MediaOperation、generation/query/historical 保存关联、concept selection、Conversation 与 positive owner 创建接线仍未完成，不能宣称全量项目隔离。范围与本地 SQL 性能观察见[原管理入口隔离](./plugin-project-legacy-access.md)。

`e92ef1900`、`d09b62bc0` 增加原 Task Core 在 COMMIT 前的同步负向检查，并让原 UI action bridge 借用同一真实组合实例。真正安装的 provider/consumer、原 UI Application/Task Application/ledger/计费链已验证 SQLite 与 PG 在实际 INSERT 之后撤下 provider 会整体回滚；确认 COMMIT 后仍保留原回执。Task Core 回归 207/207、Host 回归 63/63，零跳过，组间重叠。类型、边界和格式检查通过。它完成的是 Host API 与原服务链接线；正式 `InstalledPluginTaskActionOwner` 的单包实例仍需接入 Profile 唯一组合，并解决原 Task Core 启动依赖，不能当作产品 Web 或桌面验收。见[UI 借用共享组合](./plugin-ui-composition-borrow.md)。

以上联合增量已通过最终 Store/Application/PluginHost/Control 类型检查、boundary、`pnpm format` 与 diff 检查。当前证据保存在 [共享管理隔离回归](../output/plugin-foundation/shared-management-isolation-20261012/shared-composition-host.log)及同目录分组日志，Task Core 与 v2 原始证据在 `output/plugin-foundation/structured-outline-v2-isolation-20261012/`。自有 PG fixture 已正常停止并删除，未操作产品数据库、Web 服务或正式 App。

`97f159882` 在原 Desktop Profile/安装 runtime 增加[只读实例借用](./plugin-profile-node-borrow.md)，同步证明真实 Native owner、文件 claim、完整保存 head/enabled selections 和私有 Node 投影，再取得同一实际实例。借用不占管理队列，不触发 setup、同步或冷恢复；关闭同步撤回新借用，等待实际 lease 释放后再清理原 Node/claim，未改变低层 NodeHost 对遗留 live lease 的原拒绝。固定 Node 24、原生产构造函数与真实文件型 SQLite，七文件 61/61、零跳过；Control 类型、boundary、format 和 diff 通过。原 close 的实际 `plugin_host_has_live_leases` 负例修复后等待成功；[当前回归证据](../output/plugin-foundation/profile-node-borrow-20261012/control-regression.log)。这仍是 Host 内部接线，不包含 PG、真实 Web/桌面或 Worker 任务执行；正式 UI TaskOwner 尚未改用共享实例。

源码 `6246494ee` 增加[私有 Native 分配桥](./plugin-project-workspace-native-bridge.md)，继续调用同一个原 allocator 和 registry。真实 Native policy/owner、指定 IPC 子进程、epoch/generation 和一次性有界票据共同约束空目录分配，撤回及断开后停止，原活动工作空间保持；不接受 caller owner、路径或恢复动作。实际 Node IPC 测试子进程已验证，但生产 Main/Control 尚未启动该桥，也未把票据当作项目 metadata、SQL 或 Agent 授权。这一步只完成私有 transport，不能宣称项目创建闭环。

本轮源码验证使用 Node 24.19.0，证据分别限定为：

- **Control 专项：** 100 项通过，4 项 PostgreSQL 条件跳过；覆盖实际 owner 状态路由、Profile 自动实例协调及相关原路径，不能当成真实 PG 验收。
- **原 Native 任务与激活专项：** 16/16 通过，原批准、保留版本与任务回执路径保持；未因此开放组合 v1 执行。
- **UI 专项：** 9 文件、60/60 通过，`tsc -b --noEmit` 和生产构建通过；后续先补行为断言再精确更新 4 个历史快照，完整 CommandWorkspace 20 文件、186/186 通过，账号/session-client fixture 专项 28/28 通过。未修改生产 UI，构建哈希相同；仍不能代替正式产品验收。
- **Namespace/原 Store 联合组：** 最终限定八文件 276/276、20 suites、零失败、零跳过，包含真实 SQLite 与 PostgreSQL Run/Thread conformance、Conversation/schema、namespace 与实际等锁回归。任务自有 PG 18.6 已停止并删除，没有连接原数据库或改变产品服务；这些证据覆盖此前条件跳过的相关路径，不表示 CI 已配置 PG。
- **Native 分配专项：** 原实际文件与配置六文件 93/93、零跳过，新 allocator 47/47；Electron noemit、boundary、format 通过。覆盖真子进程 CAS/排他、活动读取并行、SIGKILL 恢复、registry 缺失及替换/链接 lease 保留。Native 到 SQL/中央 Agent 尚未接通，不能当成完整项目执行验收。
- **Native 原图执行专项：** Worker 联合组 138 项、137 通过、1 项 PG 条件跳过，聚焦组 11/11；Control 与 Contracts 筛选组 26/26，三者类型检查及 boundary 通过。覆盖真实 Native 声明、原图 A→B、同 epoch 恢复、旧 epoch 观察、owner 撤回以及最终 provider actor await 后 Native pin 失效。独立只读复核通过；root 另复跑 authority 六项。组间重叠，未部署或调用外部模型。
- **错误清理专项：** Node 24 的真实 DirectResponsesTransport 与 Kernel 17/17、Responses 全包 296/296、Kernel 全包 62/62；root 独立复跑两个全包通过。覆盖永久 pending cancel、原重试次数和 Retry-After、取消与记账优先级、reader lock 及异步拒绝。这是本地原生 Response/ReadableStream 的协议行为证据，未使用外部模型或产品 Web，不能据此定位网关/渠道或声明部署完成。
- **Native 私有桥专项：** Node 24 的五文件 148/148（新 bridge 46/46）、零跳过；root 另选原业务激活/可选插件/bootstrap 的五文件兼容组 93/93，Electron 类型检查通过。独立只读复核无必须修项。覆盖真实进程、IPC、Native 原发行者及目录/registry，测试清理等待真实进程退出和自有管道关闭；组间重叠，不相加，不是生产 Control 或 Web 产品验收。
- **Metadata 归属存储专项：** Node 24 新模块 43/43、原 CreativeProject/Foundation/WorkspaceNamespace 三文件 91/91，实际 SQLite 与自有 PG 18.6、零跳过。root 另独立复跑新模块与原 CreativeProject 两文件 69/69 及 Store types，通过；组间重叠。独立复核的两个 SQLite 必须修项均先有失败负例，再修复通过；PG 原连接事务边界只读复核通过。任务自有 PG 已停止并删除，不接原产品数据库。这些是约束与兼容证据，原 SQL insert 是明确的 constraint fixture，不能当成真实 Host 新项目授权或产品隔离闭环。

这些筛选组包含已有回归，UI 窄组也与完整筛选重叠；它们与本页历史的 70/70、38/38、3/3 等记录不能相加为整仓测试数。临时 SQLite、组件测试、源码预览和正式 `0.1.70` 的历史 Web/桌面模型证据仍分别记账，不能互相替代。

## 下一步的实施顺序

1. 继续 F1 的基础故障定位与正式包行为验收，稳定账号、模型、会话和流式恢复。
2. 以已完成的 Profile 服务 owner、实际状态路由和自动协调为基础，复核原权威、撤权与清理；继续保持 UI port 与 Node 实现的边界，不将状态读取变为隐式激活。
3. 在已显式接线的 Native 原图执行上补齐必需 provider 的 UI task action；将原宿主 Workspace allocator、中央 Agent/Node 与持久 namespace 接通，按实际插件/项目归属隔离文件、会话及项目查询。
4. 先在 Web 验收原 Agent 会话、插件右栏、任务执行、工作空间隔离和失败恢复，再核验桌面候选及正式包；公开诊断只反映真实观察，确保用户理解“保存了什么、现在能做什么”。
5. 用最小插件完成正式产品与必要分布式验收，再恢复业务插件建设。

本轮另修复了模型与基础接线缺口：合法终态的用量在非法尾部导致失败时保留为私有记账证据，不释放公共完成、不保存成功答案、不重发模型；未配置插件 UI 的宿主通过原已鉴权错误协议明确返回 `plugin_ui_not_configured`，前端仅对此停止自动轮询，普通失败仍可重试；网关的显式请求格式配置不再被覆盖，保存、恢复、版本编译、多模型绑定及桌面历史材料校验共用真实配置字段。未显式配置的普通 Responses 请求默认 Standard，不再仅凭第三方域名推断 Lite；显式与历史 Lite 保留。Standard 请求与网关响应兼容分离，空终态输出使用已校验的流内容，非空冲突、缺终态与非法尾部仍拒绝。顺序多消息的完成事件按各自索引校验，仍保留既有 Kernel 的顺序输出合同，未增加交错输出支持。未增加 storage、GET 恢复或 WebSocket 能力。

最终 Web 放行使用源码 `b9f3d61d3` 和新的不可变版本 `local-web-default-standard-20261011`，没有请求格式环境覆盖。`gpt-6.1-sol`、`gpt-6-astra` 的两会话真实并行各产生唯一 40 行结果，各一次调用、零重试，调用重叠 42.326 秒；首段分别为 2.970 与 2.843 秒，总运行分别为 42.727 与 42.704 秒。B 在仍执行、已有 8 条内容时刷新，恢复为同一 B 会话与 `gpt-6-astra`，继续增长到 38 条再完整结束，没有重新请求模型。刷新后的下一条消息用时 4.508 秒，仍是一次调用、零重试。新任务和已有会话点击后，在约 0.17–0.18 秒的 UI 观察中已显示用户消息与“发送中”，不等待任务启动。模型选择按实际接受的会话回执保存，不从其他会话猜测。原 admin 登录保留。详见[最终 Web 回执](../output/plugin-foundation/gateway-root-cause-20261011/web-default-standard-acceptance.json)。这些通过证明当前请求和消费路径可用，不能代替旧外部首次断流的根因证据。

兼容范围：旧客户端保持 404 行为，旧服务的通用 404 不会被当成空目录；配置变化、换账号和手动刷新均重新检查。私有记账证据只关联内存中的实际错误对象，没有增加序列化错误字段、公共模型事件或上下文片段。请求格式使用已有 Standard/Lite 枚举，没有新增 Bootstrap 字段；旧 Lite 和 1024 配置精确恢复保持，新保存的第三方 Standard 配置需要完整的新版本读取，旧二进制会拒绝该组合，不能拿新配置直接降级运行。

正式桌面是在上述真实 Web 放行后更新，先核对候选与正式文件摘要，再验收真实模型与冷恢复。桌面 `gpt-6-astra` 的 40 行运行用时 41.471 秒、首段 2.545 秒；`gpt-6.1-sol` 的短回复运行用时 4.007 秒、首段 3.252 秒，两次均一次调用、零重试。任务未结束时已可见增量内容。回执见[正式桌面验收](../output/plugin-foundation/gateway-root-cause-20261011/desktop-0.1.69-acceptance.json)。桌面运行时合同升级为 v3，为新 Standard 资产分配新版本身份，旧 Lite 资产不被改写；真实 SQLite 编译/发布与历史恢复专项 50/50、现有身份专项 16/16 通过。Responses 最终全包 268/268、相关会话与模型选择 199 项回归、边界检查和 UI/Worker 类型检查通过；这些范围重叠，不相加为整仓测试数。未运行整仓库测试、重新启用业务插件或修改网关、渠道、Cloudflare 配置。历史外部首次断流仍未定因，不能以本轮成功样本将其销账。
