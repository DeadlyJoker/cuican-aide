# CrewON 基础能力与插件体系当前状态

日期：2026-10-11。目标仍是先稳定基础能力，完成可独立开发、安装和恢复的插件体系，再恢复业务插件建设。本页更新交付判断；[2026-10-09 审计](./dsh-plugin-foundation-review-20261009.md)保留各次历史版本、验收结果和限制。

基础建设审计基线为 `53debe063`；下述本轮模型与会话修复在其后提交。正式 `/Applications/CrewON.app` 已更新为 `0.1.69`。新增改动来自 `85986ee06` 及此前相关提交；候选保留已安装 `0.1.68` 的五个宿主源文件，经 ASAR/source map 逐字节核对，仅在其中增加运行时合同 v3 变更。这些已发行的基础文件并非干净 Git HEAD，候选身份按实际文件与摘要记录，不能只用源码 SHA 冒充完整构建身份。22 个受审查源文件、21 个前端/宿主产物和八个运行时文件均核验一致，正式安装包也与候选一致。详见[候选核验](../output/plugin-foundation/gateway-root-cause-20261011/candidate-0.1.69-verification.json)、[正式安装核验](../output/plugin-foundation/gateway-root-cause-20261011/installed-0.1.69-verification.json)。当前正式 profile 有效业务插件为 0，历史包、任务和产物保留。不能把源码、临时数据库验收、真实 Web 与正式桌面四种证据互相替代。

正式 App 更新后的原 admin 登录、工作/任务/助理/日程/资源入口、既有工作空间、会话和历史回复均可见，没有短剧、Krea2 或出行插件入口。真实桌面新会话先用 `gpt-6-astra` 完成 40 行，再在同一会话切换 `gpt-6.1-sol` 完成短回复，两次均一次调用、零重试、唯一最终消息。正常退出重开后，原账号、同一会话、两份产物与 `gpt-6.1-sol` 选择恢复，模型调用仍各一次，没有重新生成。没有据此宣称工作空间全部操作、设置、所有模型或异常网络已验收。

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
| F2 公开能力与配置装配   | SDK 服务契约、严格配置和元数据装配已有；正式宿主服务身份、公开就绪诊断与组合查询仍有缺口             |
| F3 资源与依赖协调       | 资源、组合锁、协调和原图执行核心已有；正式宿主自动实例协调与执行配置尚未接通                         |
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

- **完成证据：** [公开 SDK](../packages/plugin-sdk/src/sdk-types.ts)已有声明式服务/API 版本访问、可选服务、资源、Node/UI 入口与主题输入；宿主强制身份、声明和版本检查。Native 基础身份独立于插件文件，原严格批准解析未放宽。真实安装选择提交后已有组合元数据同步，元数据发布失败不会伪装成选择回滚，见[协调核心与元数据同步](./plugin-composition-coordinator.md)。
- **缺口：** [正式安装 profile](../apps/control-api/src/desktop-plugin-installation-profile.ts)的 NodeHost 服务集合仍为空，[元数据 owner](../apps/control-api/src/desktop-plugin-composition-metadata-owner.ts)也声明空宿主 Node 服务；UI 可用不能冒充 Node 服务实现。`compositionState` 仅供内部读取，`published` 不表示服务就绪。组合 v1 的查询路径仍明确拒绝；开发者所需的服务定义/提供者/消费者目录与行为兼容说明尚不完整。
- **放行条件：** 显式适配真实宿主 Node 服务身份、实现修订及批准；服务契约与消费规则可独立验证，损坏业务配置只撤回其贡献。以有界、无凭据的公开状态区分已安装、已启用、等待依赖、就绪与失败；组合查询有兼容决定和覆盖后才开放。

### F3：实例资源、依赖协调与原任务组合

- **完成证据：** [运行期资源](./plugin-runtime-resources-protocol.md)、[依赖规划](./plugin-dependency-reconciliation-design.md)、[协调核心](./plugin-composition-coordinator.md)、[组合锁与原 Run 引用](./plugin-run-composition-binding.md)、[跨包执行](./plugin-execution-composition.md)均已有实现。它们保留旧借用及原依赖，受影响实例先撤权再清理，原任务恢复逐节点重新授权；不会按今天的 head 替换旧 Run。
- **缺口：** 生产安装选择目前只触发元数据同步，没有调用实例协调器。正式 [Control 任务运行装配](../apps/control-api/src/installed-plugin-task-runtime-core.ts)未配置 `pluginCompositions`，[Native Worker 装配](../apps/runtime-worker/src/plugins/installed-plugin-native-worker-composition.ts)未提供 `compositionExecution`。通用 [Worker 显式入口](../apps/runtime-worker/src/plugins/installed-plugin-runtime-composition.ts)已有该能力；未配置时 [resolver](../apps/runtime-worker/src/plugins/installed-plugin-runtime-resolver.ts)严格拒绝 v1，不能静默忽略原依赖。
- **放行条件：** 先完成 F2 的宿主身份与批准适配，再在真实 profile 生命周期接入现有协调器及正式任务/Worker 配置。覆盖依赖升级/撤回/恢复、准备中撤权、清理失败、旧 Run 观察及冷恢复；新旧图各用原实例，失败不伪报就绪。

### F4：仓外独立开发与分发

- **完成证据：** [tools](../packages/plugin-tools/README.md)复用原包核验器，提供 `init` 与 `check`；[SDK](../packages/plugin-sdk/README.md)与 tools 真实 tarball 可离线装入仓外项目。[分发测试](../packages/plugin-tools/test/distribution.test.mjs)覆盖初始化、TypeScript 编译、独立 ESM 包检查和实际宿主加载；删除作者目录后已安装包仍可运行，不依赖宿主源码或另一套运行时。
- **缺口：** 当前[最小模板](../examples/plugins/minimal)是 Node 服务模板，不能代替 UI、Agent 执行和跨插件消费的完整开发体验。本地 tarball 不等于注册表发布或可信签名，包检查也不等于授权、依赖可用或持续可信。
- **放行条件：** 独立作者按公开文档完成声明、构建、安装和故障定位，不改宿主源码；对 UI/Agent/跨包场景补充模板或明确契约示例，公布实际支持的版本与兼容覆盖。每次安装和执行仍重新核验包与授权。

### F5：正式产品的可插拔闭环

- **完成证据：** [独立模板生命周期测试](../packages/plugin-tools/test/installed-template-lifecycle.mjs)使用真实 tarball、仓外包、原 Application/Store/Host 路径，完成 SQLite 安装、启用、升级、回滚、停用、再启用、卸载及数据库重开；旧包和借用保留。另有原 Application 任务签发、Worker 测试模型流及原图冷装配证据，见[执行装配](./plugin-execution-composition.md)。这些已实现能力不再列作“尚无实现”。
- **缺口：** 生命周期数据库与身份是临时测试环境，模型 transport 是测试适配器；不能算用户正式 App 的安装/授权/UI、真实外部模型恢复、组合查询或 PostgreSQL 分布式管理验收。既有环境条件跳过项也不算通过。
- **放行条件：** 在正式产品入口以最小验收插件完成全生命周期，核验登录、当前批准、就绪状态、调用、取消、升级后的原任务恢复、失败回滚和冷启动；涉及分布式路径时使用真实 PostgreSQL 验证事务与并发。通过后才恢复业务插件，不重提状态未知的 ComfyUI 操作。

## 下一步的实施顺序

1. 继续 F1 的基础故障定位与正式包行为验收，稳定账号、模型、会话和流式恢复。
2. 为现有 Node 宿主服务建立真实实现身份与批准适配，不将 UI port 同名服务直接当作 Node 实现。
3. 将现有协调器接入安装 profile 的真实选择生命周期，再接正式任务签发与 Worker 原图执行。
4. 提供有界的依赖/就绪/清理失败诊断，确保用户理解“保存了什么、现在能做什么”。
5. 用最小插件完成正式产品与必要分布式验收，再恢复业务插件建设。

本轮另修复了模型与基础接线缺口：合法终态的用量在非法尾部导致失败时保留为私有记账证据，不释放公共完成、不保存成功答案、不重发模型；未配置插件 UI 的宿主通过原已鉴权错误协议明确返回 `plugin_ui_not_configured`，前端仅对此停止自动轮询，普通失败仍可重试；网关的显式请求格式配置不再被覆盖，保存、恢复、版本编译、多模型绑定及桌面历史材料校验共用真实配置字段。未显式配置的普通 Responses 请求默认 Standard，不再仅凭第三方域名推断 Lite；显式与历史 Lite 保留。Standard 请求与网关响应兼容分离，空终态输出使用已校验的流内容，非空冲突、缺终态与非法尾部仍拒绝。顺序多消息的完成事件按各自索引校验，仍保留既有 Kernel 的顺序输出合同，未增加交错输出支持。未增加 storage、GET 恢复或 WebSocket 能力。

最终 Web 放行使用源码 `b9f3d61d3` 和新的不可变版本 `local-web-default-standard-20261011`，没有请求格式环境覆盖。`gpt-6.1-sol`、`gpt-6-astra` 的两会话真实并行各产生唯一 40 行结果，各一次调用、零重试，调用重叠 42.326 秒；首段分别为 2.970 与 2.843 秒，总运行分别为 42.727 与 42.704 秒。B 在仍执行、已有 8 条内容时刷新，恢复为同一 B 会话与 `gpt-6-astra`，继续增长到 38 条再完整结束，没有重新请求模型。刷新后的下一条消息用时 4.508 秒，仍是一次调用、零重试。新任务和已有会话点击后，在约 0.17–0.18 秒的 UI 观察中已显示用户消息与“发送中”，不等待任务启动。模型选择按实际接受的会话回执保存，不从其他会话猜测。原 admin 登录保留。详见[最终 Web 回执](../output/plugin-foundation/gateway-root-cause-20261011/web-default-standard-acceptance.json)。这些通过证明当前请求和消费路径可用，不能代替旧外部首次断流的根因证据。

兼容范围：旧客户端保持 404 行为，旧服务的通用 404 不会被当成空目录；配置变化、换账号和手动刷新均重新检查。私有记账证据只关联内存中的实际错误对象，没有增加序列化错误字段、公共模型事件或上下文片段。请求格式使用已有 Standard/Lite 枚举，没有新增 Bootstrap 字段；旧 Lite 和 1024 配置精确恢复保持，新保存的第三方 Standard 配置需要完整的新版本读取，旧二进制会拒绝该组合，不能拿新配置直接降级运行。

正式桌面是在上述真实 Web 放行后更新，先核对候选与正式文件摘要，再验收真实模型与冷恢复。桌面 `gpt-6-astra` 的 40 行运行用时 41.471 秒、首段 2.545 秒；`gpt-6.1-sol` 的短回复运行用时 4.007 秒、首段 3.252 秒，两次均一次调用、零重试。任务未结束时已可见增量内容。回执见[正式桌面验收](../output/plugin-foundation/gateway-root-cause-20261011/desktop-0.1.69-acceptance.json)。桌面运行时合同升级为 v3，为新 Standard 资产分配新版本身份，旧 Lite 资产不被改写；真实 SQLite 编译/发布与历史恢复专项 50/50、现有身份专项 16/16 通过。Responses 最终全包 268/268、相关会话与模型选择 199 项回归、边界检查和 UI/Worker 类型检查通过；这些范围重叠，不相加为整仓测试数。未运行整仓库测试、重新启用业务插件或修改网关、渠道、Cloudflare 配置。历史外部首次断流仍未定因，不能以本轮成功样本将其销账。
