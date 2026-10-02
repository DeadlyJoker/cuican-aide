# 增量扩展子系统实施进度

目标：按 [实施方案](./incremental-extension-subsystem-plan.md) 推进。状态：进行中，不能据此认为完整插件子系统已经交付。

当前用户要求优先跑通调用流程，再细化插件产品形态。第一个真实场景已确定为用户提供的 ComfyUI Krea2 文生图工作流，生成全部由外部服务完成。

## 2026-10-02：短剧项目与输入修订基础

继续工作台方案 S0 的领域与内部应用步骤，新增项目、不可变需求修订、概念图元数据及不可变描述修订。个人归属由服务端当前账号派生，审计 actor 与 owner principal 分开；纯规则检查租户、空间、归属、显式预期项目版本，以及资产自己的预期元数据版本。改名保留原输入摘要，相同描述也可显式追加新版本；归档拒绝新的需求和概念图修订，保留历史读取、重命名及恢复。

输入复制后校验精确字段和版本，拒绝 getter、异常原型、未知字段、非法 Unicode 和失真的摘要。标题/名称限制 160 个 Unicode 字符，需求限制 8KiB UTF-8，描述沿现有 Krea2 的 2,000 个 UTF-16 单元；修订使用安全整数，耗尽时拒绝。概念图输入绑定确切需求编号和内容摘要，不保存外部 URL 或假装已有图片。版本编号承担顺序，墙上时钟回拨不阻止合法保存。

新增内部 Application 服务、本人范围 Store 和必需的当前访问策略端口。创建项目和首版需求只发出一次原子存储配方；其他命令要求事务复核存储归属、版本和保存的需求，并和幂等回执共同提交。请求摘要绑定完整当前账号、审计 actor、命令种类和严格输入，不含随机 ID 或时钟。丢回复重试保留原项目/修订，并发晚重放接受原 ID；新的成功提交必须返回完整原准备记录。命令提交前、历史或回执读取后重新授权，授权失败不返回数据。

读取按本人范围分页，最多 50 项，返回的身份、版本、摘要和页游标再次核验；未来修订、错误归属、重复或过量条目均拒绝。项目按更新时间及 ID 倒序，资产 ID 使用稳定 Unicode scalar / UTF-8 二进制顺序，需求和描述修订按编号升序。当前没有默认放行策略或生产装配，没有安装真实项目 Store；生成、查询及选用继续留待实际 Run/operation 接线，不能用先创建任务再补项目关联的两个写入替代原子事务。

Domain 全量 184/184、Application 全量 220/220，无失败或跳过。新增领域 13 项及应用 25 项专项覆盖归属、CAS、归档、旧修订、重放、命令/账号快照、保存前及读取后的撤权、坏存储返回、合法大输入和 Unicode 分页。应用测试使用明确的内存夹具，其一次原子发布及版本检查不作为 SQLite/PostgreSQL 事务验收。18 个 packages 及 Control、Worker 类型检查、入口边界、仓库文档和新增源码格式通过；本轮未修改 Worker 执行、公共 HTTP、Renderer 或实际 Store，未重复这些层的全量行为测试。

日志为 `output/extensions/checks/creative-project-*.log`。下一步是实际双库项目存储，再把项目生成关联加入原任务及积分冻结事务，随后接 HTTP/BFF/Client 和正式页面。当前预览仍是内存演示，不持久保存、不实际扣费；S0 完整闭环、原生产身份协议和第二个实际企业 API 门槛均未据此完成，目标保持进行中。

## 2026-10-02：个人积分与生成任务原子准入

在上一阶段账本基础上接入可选的服务端报价端口，付款人从平台当前账号取得。报价冻结与用户消息、model history、Run、不可变插件绑定、账务关联及任务回执在原 SQLite/PostgreSQL 事务内提交。余额不足、报价不可用或配置了报价却没有积分迁移时拒绝新任务；绑定、关联或回执写入失败均回滚积分和任务，不留下半个任务。

任务和报价摘要绑定账户、插件、原请求、Run、价格修订及额度。并发重试保留原 Run 和报价，不再次冻结；同 actor 换 principal 不能使用原付款回执。已受理任务查询和事件游标续读不重复冻结原生成费。服务端未配置报价的旧任务保留原行为，不读取积分表；旧 Store 适配器未声明支持时拒绝收费准入。公共任务请求仍拒绝客户端传入额度、付款人等未知字段。

新增关联表由宿主显式增量迁移，原核心版本、SQLite user_version 及既有积分账本版本保持不变，关联记录禁止修改和删除。不自动发放余额，不安装生产价格策略，也未接入充值、公共积分 API 或任务终态自动结算。单价、计费单位及失败处理仍待用户明确，页面预览继续不实际扣费。冻结保留不等于已结算扣款；当前测试的报价和余额都是具名夹具。

双库准入专项 32/32、无跳过，覆盖并发、余额不足、三处写入失败回滚、账户隔离、报价变化及错误、报价期间撤权、重开、查询、旧路径零积分 SQL、孤立冻结、迁移兼容及关联不可变。Domain 全量 171/171、Application 全量 195/195；既有任务/配置/Control 路由回归 28/28。真实 Kernel/Worker 与 SQLite 恢复专项 3/3：供应商夹具受理后模拟进程丢失，停用并重开数据库，恢复原 Run 和输出，付费变体保持一次报价、一次冻结、一次供应商 POST，未自动结算。本项没有重复在线生图或完整界面/SSE 验收。

最终带自有临时 PostgreSQL 的 Store 全量 1,305 通过、0 失败，1 项原有无数据库环境提示测试按原条件跳过。18 个 packages、Control、Worker 类型检查及 TypeScript 入口边界通过，仓库文档和新增源码格式通过。检查后关闭全部数据库连接，正常停止并删除自有临时 PostgreSQL，已有页面预览继续保留。

日志位于 `output/extensions/checks/extension-credit-*.log`。本轮只接内部事务和兼容端口，生产权威当前身份协议及原 E5 的第二个实际企业 API 仍待接入；短剧 S0 项目代码、充值和价格结算产品流程没有据此交付，目标保持进行中。

## 2026-10-02：所有用户可用与个人独立积分基础

按用户补充的规则，短剧插件面向所有用户，生成消耗个人独立积分，不增加企业或角色使用白名单。平台账号仍用于识别使用者及其账户；开放使用不开放其他用户数据或服务配置权限。首轮按插件专用积分池建模，不擅自决定与原账户合并、单价、计费单位、失败退还或充值方案。

新增 Domain 账户/冻结记录、Application 内部账本端口及 SQLite/PostgreSQL 存储，账户按 tenant / principal / pool 隔离。额度使用有界整数字符串精确计算，支持入账、冻结报价、部分结算和释放未结算冻结；账户、回执、冻结及不可变流水同事务提交。相同幂等键返回原记录，修改请求摘要、插件、价格修订或报价会拒绝。不同插件共用同一池时按账户加锁，不能并发超扣；分页有界，重新打开数据库保留原账。

迁移由宿主显式调用，新增表采用独立版本，保留原核心 schema / SQLite user_version；不自动发放余额，也不复用模型供应商余额或 thread/goal 模型预算作为个人钱包。连接由原宿主持有。另修复 PostgreSQL 提交期间关闭的竞态：数据库已确认 COMMIT 后保留成功结果；提交前关闭仍回滚。

该阶段尚未接入 Run 准入、充值、公共积分 API 或生产装配；后续内部原子准入见上节。冻结必须与原任务创建共同提交，不能先独立冻结再创建 Run。查询与重连不重复扣取原生成费，是否另有查询或模型费用须按明确规则；供应商受理未核实、失败、取消及已结算退款不能混成“释放冻结”。页面只说明规则，交互预览仍不实际扣费。

验证记录在 `output/extensions/checks/plugin-credit-*.log`：账本 Domain 全量 166/166、Application 195/195；带自有临时 PostgreSQL 的 Store 全量 1,271 通过、1 项无数据库环境提示测试按原条件跳过、0 失败。积分双库专项 18/18，包含真实 SQLite 八个独立 Node 进程的并发余额保护、流水写失败的全事务回滚、重放、隔离、重新打开与原核心迁移兼容。提交关闭修复另有真实 PostgreSQL COMMIT / INSERT 屏障回归 2/2。18 个 packages 类型检查和 TypeScript 入口边界通过；提交关闭修复后的专项覆盖不冒充完整多用户扣费流程。

最终 Domain、双库积分及提交关闭专项合计 37/37，无跳过，Store 最终类型检查通过；独立复核确认修复与金额/数据库规则保持一致。页面既有快照更新后 1/1、UI lint（含 Electron）、UI build、仓库格式和新增文件格式通过。实际浏览器确认项目概览及概念图生成入口的使用规则，截图为 `output/extensions/short-drama-preview/credits-overview-desktop.png` 和 `credits-concept.png`；本轮仅核对新增文案，沿用此前响应式与完整交互证据。临时 PostgreSQL 在连接全部释放后已正常停止，页面预览继续保留。

## 2026-10-02：短剧工作台交互预览

按用户“先看到页面”的要求，提交 `58dff7a69` 增加[独立页面预览](../artifacts/short-drama-workbench-preview/README.md)，沿用 CrewON 的设计约定，包含项目列表、项目概览和概念图详情。可体验新建、归档/恢复、需求修订、概念图新版本、模拟提交/查询/选用及记录弹窗。归档后阻止新的创作，仍保留历史和已提交任务查询；旧需求和概念图版本不会被覆盖。

预览仅使用当前页面内存，不调用外部模型或 ComfyUI，不提供项目持久化，也没有改动现有首页、聊天和团队入口。已有 Krea2 测试图片的原字节副本明确标注为画面示意，模拟查询不生成新图片。本项完成页面展示，不能替代 E3 的真实调用证据、S0 的项目闭环或 E5 的第二业务复用。

实际浏览器验证了上述交互、原生弹窗 Escape 与焦点恢复、1440×1000 / 1440×700 / 390×844 布局；桌面和窄屏无横向溢出，低高度下主要动作可用。截图保存在 `output/extensions/short-drama-preview/`。初始界面快照 1/1、相关四文件 47/47 通过，归档修正后原快照未更新仍 1/1 通过；UI lint（含 Electron 类型）、build、入口边界、仓库格式及新增文件格式通过。日志为 `output/short-drama-preview-*.log`。本轮没有重复后端或旧 UI 全量测试，既有七项 UI 基线失败的记录仍保留。

## 2026-10-02：同一次界面到真实宿主的闭环与短剧产品方案

新增 Happy DOM 集成沿生产 `BusinessExtensionController` / `ControlApiClient` / `ControlThreadRuntime` / `Transcript` 的同一次操作调用实际 Node 24 release、Worker、Control 与 SQLite。独立源码副本离线安装并 stage 七包，先从界面保存配置，确认未部署的 Agent 不能启用，再由明确的 Native 发布步骤读取该修订准备插件，返回界面启用、生图并查询。发布是操作者准备步骤，不能把保存服务地址当成已部署。

重复执行发现并修复新会话接纳的时序问题：Runtime 在 adoption 完成前发布 Thread，原界面 scope cleanup 会取消自身动作，造成任务成功但未打开会话。现在只保留同一 client、插件、epoch、pending/receipt 与 signal 下，正在接纳的已核验新 Thread 迁移；另一个 Thread、换身份或关闭仍取消，受理回执还必须归属原请求的 Thread。它不授予新的执行权限。

### 本轮证据

- 同一条界面流程核对配置 revision/digest 和八字段目标、准入后打开原会话、正常 Transcript 的真实 Agent 输出、同会话第二个查询 Run，以及核验后的 `/view` 结果引用。模型 POST 4 次、ComfyUI POST 1 次、history GET 1 次；供应商为本地 HTTP / HTTPS 夹具，本轮没有再次调用在线模型或真实 ComfyUI。
- 传输故障只截断实际 Control SSE 的第一个完整带 ID 帧，没有合成事件。生产 Runtime 自动用确切 `Last-Event-ID` 重连，输出不重复。刷新、关闭重开及新 Runtime 从空 turns 恢复服务端历史和结果，均不增加模型或供应商请求。证据保存在 `output/extensions/business-extension-real-ui-evidence.json`，包括实际配置/目标、断点游标及自有进程和临时目录清理状态。
- 新会话接纳、配置/表单及 Runtime 专项 3 文件 55/55，通过八项新增确定性回归；随后上述实际界面单项 1/1 通过。原 Native 独立双构建升级单项 1/1 再次通过，模型/Comfy 计数仍为 7/2/1，具名测试夹具选项的默认行为未改变。日志为 `output/business-extension-adoption-scope-regression.log`、`business-extension-real-ui-owned-processes-final.log` 和 `business-extension-real-ui-native-default.log`。
- 启动与重启登记六个实际 release/Worker/Control 子进程，全部收到 close 事件后才删除临时目录；最终证据为 registered/closed 6、live 0、目录不存在，原生 spawn 观察已恢复。隔离副本仅为本地供应商网络测试增加专用接线；本轮产品逻辑只修改 Renderer，七个运行入口的正式实现指纹仍为 `sha256:71b252ebdecbb2ac425a2fe1761e61d5c7833816d8f523a49215d0bc4050af8e`，不能把副本中的测试摘要当作正式构建摘要。
- UI 最终全量以单 Worker 执行，排除已分别通过的上述两项实际构建：436 文件、3,032 项，3,025 通过、7 失败。七项名称与断言均与界面阶段已核验的变更前基线一致，无新增失败；快照的三项 obsolete 也来自该基线，未更新或删除原断言。一次额外历史宿主耗时失败在独立 35/35 和本次全量均通过，未放宽期限。日志为 `output/extensions/checks/workbench-ui-full-final.log`，基线对照为 `workbench-ui-baseline-comparison-final.json`。UI lint（含 Electron）、build、入口边界与仓库格式通过；未改动后端产品代码，没有重复全量 packages / Worker / Control。

在 [shuohao-skills / Reelbench 参考结论](./short-drama-workbench-reference.md)之上完成[短剧工作台产品方案](./short-drama-workbench-product-plan.md)。明确 S0 项目/需求修订/概念图，后续剧本、资产、分镜和视频的 API 门槛；将创作修订、Run 和外部 operation 分开，复用现有准入、事务、审批和 SSE。新项目服务及真实项目界面仍是后续实施设计；上述独立预览不反向扩大原 E0–E5 范围。

Krea2 的供应商链接没有声明 TTL 或永久有效承诺；终态查询返回已存结果，不刷新失效 URL。受理不明时按保存标识查询也不保证能找回被服务忽略的客户端 ID，无法核验时保留未知状态，不自动再次提交收费请求。

**剩余：** 原计划中的生产权威当前身份协议及第二个实际企业 API 信息仍待提供；当前显式 standalone 装配不能替代生产多用户身份核验。任意 workspace/MCP/cloud 的完整历史冻结、S0 项目代码及视频/配音/成片均属于后续扩展，不是原首期的新增必交付项。目标保持进行中。

## 2026-10-02：保留旧插件配置的打包版升级

在实际 Native release 之前增加独立输入准备。只对显式开启、固定桌面 owner / release publisher、固定 standalone SQLite 的打包版检查当前七个安装包，并严格匹配唯一完整旧 capsule。操作者路径要求完整原字节身份、所有配置快照及投影后的完整 bindings 一致；保存路径要求固定路径和 pins 一致。共享纯绑定解析器与专用 Node 身份端口复用 Worker 原配方，保持已有 capsule ID 和绑定解析行为。

旧归档、全部原发布资产/部署和当前精确 Provider 凭据都匹配后，只移除本次 release / Worker 环境中的两个旧插件路径。新版先提供目录及默认能力，现有历史管理再启动原 Worker 接入旧查询；持久配置、旧资产、部署、activation 和 capsule 不改写。当前默认发布仍沿原路径运行，新构建的插件生成仍需显式准备新配置。使用前再次核对文件、数据库及当前凭据，准备阶段有 20 秒期限与启动取消；缺失、多匹配、篡改、partial、身份或凭据不匹配均保留原严格发布行为，不重试发布或猜测旧文件。source、关闭与目录配置不执行该检查。

### 本轮证据

- 两份独立源码离线安装并实际 stage 七包，B 的真实 Control 变更产生新身份。删掉 A 的源码、依赖和安装资源后，直接保留 A 原桌面配置及操作者输入启动 B，不再手动清空配置。当前 Worker 没有旧插件输入，默认任务完成；自动旧宿主按原八字段目标与配置 revision 完成查询和 SSE 游标恢复。配置、原三份输入、capsule 原字节，以及旧 configuration / activation / deployment / source Run binding 均保持不变。随后显式准备 B 的新配置，新生成成功；历史退出只替换 Control，当前 Worker PID 保持不变。
- 上述实际 Native 测试 1/1，无跳过；模型 POST 7 次、ComfyUI 生成 POST 2 次、history GET 1 次，旧查询与重连没有新增生成 POST。供应商仍为本地 HTTPS / TLS 夹具，没有再次调用在线模型或真实 ComfyUI；测试副本的网络夹具不修改生产策略，不能据此声称视频、配音或成片链路已验收。临时源码、服务与进程均已清理。
- 升级准备专项 52/52，连同既有历史输入 94/94，覆盖两种输入匹配、歧义、固定完整身份、当前七包、所有原发布资产/部署、精确凭据异步变化、重新核验、请求快照、取消和期限。共享 Node 端口专项 19/19，包含精确七包边界、原身份配方兼容及合法超过 64KiB 的完整绑定；Worker 绑定解析与既有恢复输入/发布兼容专项 67/67。单元归档端口不执行旧包，实际跨构建执行由上一项证明。
- 18 个 packages 类型检查及全量测试通过，AgentVersion 143/143、Contracts 135/135、Application 195/195、Store 857 通过 / 191 环境跳过；Worker 全量 957 通过 / 198 环境跳过，Control 287 通过 / 9 环境跳过，0 失败。环境跳过不计为实际数据库验收。Electron 全量单 Worker 执行 29 文件 350/350，另行执行上述独立 Native 1/1，合计 30 文件 351 项全部通过。
- Worker / Control 类型检查、UI lint（含 Electron）、Electron host 构建、TypeScript 入口边界及精确依赖边界通过；stage 专项 5/5，正式七包全部语法与整套身份核验通过。最终源码指纹 `sha256:71b252ebdecbb2ac425a2fe1761e61d5c7833816d8f523a49215d0bc4050af8e`。本轮未修改 Renderer 或重跑 UI 全量，既有七项基线失败仍见界面阶段。

检查日志为 `output/extensions/checks/native-current-upgrade-*.log`、`desktop-current-upgrade-*.log` 及 `current-upgrade-*.log`。此项只衔接能够严格核验的旧配置；原文件已删除且配置只剩无法反查的原路径时不自动恢复。workspace/MCP/cloud 完整冻结、生产权威身份协议与第二个实际企业 API 仍待后续实现。短剧继续依据 [shuohao-skills / Reelbench 参考结论](./short-drama-workbench-reference.md)细化项目、阶段成果、资产修订与 Agent 外部 API 编排，目标保持进行中。

## 2026-10-02：打包版自动历史宿主与跨构建查询

当前 Control / Worker 正常就绪后，原生桌面开始后台选择完整恢复记录。固定目录最多 64 条记录，严格验证 complete marker、所有文件与原 scope.v1 七包归档，排除本次当前记录，按固定 ID 选择最多四个可恢复宿主，每宿主最多 32 个完整目标。残缺、篡改、缺失发布资产或当前精确凭据不可用均不补记录、不删除归档，也不改为当前新目标。

历史 Worker 使用保存的非秘密有效 bootstrap、固定绑定路径及原代码；启动环境由白名单构造，不继承 ambient 模型或秘密配置。当前 Provider Store 每次联合核对原 providerId、完整 endpoint 及凭据要求，再解析当前可用秘密。完整原 release 的 bundle、所有 base/profile/model variant/plugin 资产和部署由独立只读 SQLite 端口读取并逐项验证，不迁移、不重新发布、不切换默认 Agent。实际旧宿主返回的 manifest 与配置共同重算 materialization，完整 owner、登记和八字段 readiness 全部通过后才向 Control 提供 peer。

Supervisor 分开维护当前健康与所有子进程。历史启动失败仅报告不可用；历史 peer 加入或退出通过受控替换 Control 更新，当前 Worker 保持运行，原 SSE 按游标恢复。停止会尝试所有自有进程，终止失败保留句柄，避免重复启动；历史进程退出不反复拉起，下一次整体启动重新选择。源代码模式及插件关闭保持原路径。

历史 peer 更新后的新 Control 如果活着但无法就绪，会尝试一次恢复不带历史 peer 的原 Control 配置，保留当前 Worker。相同失败 peer 集合不重复拆除已恢复的 Control，集合变化后才允许再试。终止失败不启动重复进程；恢复后的 Control 仍不就绪时，保留监督与句柄并明确报告不可用，不假装恢复成功。

恢复 metadata 的序列化使用已严格解析的 DTO 与实际发布 plan，分别受 128KiB / 256KiB 文件边界限制，修复合法大配置误用插件 64KiB canonical JSON 上限的问题。插件身份、materialization 与 complete marker 的 canonical 协议不变；已有完整记录继续复用原字节，partial 字节冲突明确报告不支持，不覆盖第一次保存内容。

### 本轮证据

- 两份独立源码分别离线 pnpm 安装并 stage 七个实际包，第二份只增加真实 Control 输出以产生新的源码与 bundle 身份。真实 Native Supervisor 发布旧/新版本，自动启动保存的旧 Worker；删除旧源码和旧安装资源后，旧查询仍使用原八字段目标和原配置 revision，当前公共目录只有新构建。历史进程退出后当前 Worker PID 保持不变；已有查询 SSE 两次游标重连取得相同输出，新的旧查询被拒绝而已有结果仍可读取，当前新生成与默认 Agent 继续可用。模型 POST 7 次、ComfyUI 生成 POST 2 次、history GET 1 次；旧查询和重连均未增加生成 POST。两份 capsule 原字节保持不变。
- 上述集成只在独立测试副本中设置测试 HTTPS DNS / CA，仍保留 TLS、实际 HTTP、数据库、Agent 和工具链。供应商使用本地确定性夹具，不修改生产出站策略，没有再次调用在线模型或真实 ComfyUI；不能把它作为真实视频、配音或供应商网络策略验收。
- inventory / 严格启动输入 / 实际材料核验、当前/历史生命周期、只读 SQLite 与实际发布 CLI 均有边界回归。18 个 packages 全量测试及类型检查通过，包含 Contracts 135、AgentVersion 124、Application 195、Store 857 通过 / 191 环境跳过；Worker 最终全量 957 通过 / 198 环境跳过，Control 287 通过 / 9 环境跳过，0 失败。只读数据库专项 7/7、实际七包 release 专项 11/11，stage 专项 5/5；跳过的 PostgreSQL 项不计为实际验收。
- 最终 Electron 全量按单 Worker 执行 28 个文件、298/298，另行执行上述独立双构建 Native 1/1，均无失败或跳过；原独立双构建归档测试 1/1 通过。当前/历史进程专项覆盖真实 ENOENT、四宿主、超时、立即退出、停止失败、取消、peer 更新、Control 活着但未就绪后的单次恢复及失败集合去重。先前默认并发运行时遇到测试夹具修订及既有短期限超时，最终稳定代码以该单 Worker 全量结果为准，未放宽既有期限或删断言。
- Worker / Control 类型检查、UI lint（含 Electron）、Electron host 构建、边界及仓库格式检查通过。实际 Electron 的 Node 24.18.1 能加载 `node:sqlite`，独立只读端口仅在 Native 使用，Renderer 禁止导入 Store 的边界仍保留。正式七包通过语法与整套摘要核验，最终源码指纹为 `sha256:10703afb7aa03bd5a1972230a69d1d243ad93f462085f40c3603ea67a36c5d78`。所有自有夹具目录、测试服务与子进程已清理。

详细证据保存在 `output/extensions/checks/native-history-*.log`、`native-historical-manager-*.log` 与 `desktop-historical-inputs-*.log`。本轮没有修改 Renderer 或重跑 UI 全量，其已有七项基线失败仍见前面的界面阶段。

**剩余：** 自动历史恢复以当前安装宿主先正常启动为前提；升级后需显式为新构建准备匹配配置，当前旧配置的自动迁移尚未实现。workspace/MCP/cloud 的完整冻结、生产权威身份协议与第二个实际企业 API 仍按原计划推进。短剧继续依据 [shuohao-skills / Reelbench 参考结论](./short-drama-workbench-reference.md)组织项目、阶段成果及资产修订；Krea2 只证明文生图，参考图、视频、配音和成片未接入，目标保持进行中。

## 2026-10-02：原生恢复输入与当前凭据查询

打包版桌面已接入非秘密恢复输入的实际生产路径。首次发布前，在 `extension-recoveries/<capsuleId>` 准备固定 snapshot 路径与插件 bindings，assets 保持原字节；仍调用现有授权发布入口。成功后核对真实 SQLite 发布记录，保存有效 bootstrap 参数、完整基础 bindings 与真实 release。当前 Worker 启动并通过完整 owner、插件登记、配置摘要和八字段目标挑战后，最后提交 `manifest.json`。候选交接使用固定文件与每次独立尝试身份；候选和残缺目录都不代表恢复已完成。

存储只接受有界普通 JSON 文件、固定名称和无符号链接的路径，独占写入、文件同步、同字节复用；完整记录不覆盖或追加。文件准备与提交共用锁，避免完成标记发布后仍追加文件。并发修改、未知字段、缺失/篡改文件、容量与异步输入变化均有实际文件系统测试。已有原路径发布的目标不搬迁；已经保存的发布目标则必须核对全套文件与原完整部署后复用，不能因本次 default/catalog 或 workspace 不支持新恢复记录而改回原操作者路径。

恢复资格与当前启动分开。相同模型地址的 Provider ID 或凭据要求变化可以使恢复候选不可用，原发布的固定路径仍保留；完整模型地址改变或旧固定 slot 缺少当前凭据时，当前宿主不装配旧插件，当前默认 Agent 和目录宿主继续运行。原记录及数据库目标不变，不把新服务密钥发送到旧服务。未启用与源代码运行维持原路径；首次仅恢复层不支持的合法操作者符号链接或可选存储容量不足，也不阻断原发布。

Provider Store 新增独立的当前凭据查询：每次严格重读当前目录，联合核对 providerId、完整基础地址和派生 Responses 地址；同地址轮换取最新可用秘密，删除、地址变化或不可用明确拒绝。明确匿名与凭据缺失分别处理，不回落到 active Provider 或草稿凭据。秘密不进入恢复记录、JSON 序列化或检查输出。此模块尚未由自动历史宿主消费。

### 本轮证据

- 真实 Native source / packaged 两种路径均通过。packaged 使用现有 stage 构建七个实际生产包并运行实际 release、Worker、Control；验证发布、真正就绪后标记、插件/默认任务、SSE 游标续读、current catalog/Provider ID/workspace 变化后的旧文件保护。换到第二个真实 loopback 模型夹具后，旧插件不可用但默认任务完成，新密钥只到新服务，原服务请求数量不变。显式改选保存的文件并删除操作者输入后当前执行仍可用；删除安装资源后归档仍可核验。模型为本地文本夹具，没有新增真实模型或 ComfyUI 生图请求，也未证明自动跨构建旧宿主恢复。
- 实际七包 release CLI / SQLite 专项 10/10，包含未完成候选、已有完整记录、partial metadata 冲突、篡改拒绝、容量降级、workspace/Provider 漂移、固定 slot 缺凭据及合法符号链接。input/request/既有 release-input 专项 52/52；bootstrap/transport/release 23/23、Contracts 严格启动输入 6/6。
- 恢复存储实际文件系统专项 29/29、固定启动交接 13/13，包含真实并发写入/提交屏障、完成后不可追加、原子替换与重开、UTF-8、硬链接/符号链接和旧尝试拒绝。Native helper 33/33 使用真实本地 private HTTP 与文件系统、窄模拟归档 lookup，只证明协议与边界；实际构建身份由上一项真实 Native 集成证明。Provider 新旧专项 54/54。
- Worker 全量 955 通过 / 198 环境跳过，Control 287 通过 / 9 环境跳过，0 失败；Electron 全量 24 个文件、205/205，包含上述真实进程流程。全部 packages 类型检查、Worker/Control 类型检查、UI lint、Electron host 构建、正式七包 stage 与仓库格式检查通过。正式源码指纹为 `sha256:48d0f375bdec60da1f4762803bbc144d62a6af970957000cb4f74bb905d3e597`。本轮未修改 renderer 或重跑 UI 全量，其已有七项基线失败仍见前文界面阶段。详细检查记录为 `output/extensions/checks/recovery-*.log`、`extension-recovery-*.log` 和 `native-recovery-helper-*.log`。
- 包依赖边界清单补齐了精确 Node 子入口及已存在的进程关闭端口，仍禁止 AgentVersion 编译器/index 引入 Node、恢复专用依赖或这些 Node 模块。隔离源码基线 `9a25d341a` 的 12 项边界测试为 7 通过/5 失败，本轮新依赖登记前为 6 通过/6 失败；修正后新增负向覆盖，14/14 通过，test-contracts 全量 20/20。普通 package 回归均为 0 失败，其中 AgentVersion 114/114、Application 195/195、Store 850 通过/191 环境跳过；未把跳过的 PostgreSQL 项计为实际验证。基线、修正和回归证据为 `recovery-package-boundary-*`、`recovery-test-contracts-full.log` 及 `recovery-product-packages-final.log`，隔离目录已清理。

**剩余：** 自动选择恢复记录、清洗环境并注入当前精确凭据、原生旧 Worker 生命周期与历史 peer 更新、完整跨构建产品验收仍按[实施顺序](./native-extension-recovery-plan.md)推进。源代码模式不自动保存构建或恢复输入，任意 workspace/MCP/cloud 场景不声称支持自动恢复；生产权威身份协议及第二个实际企业 API 仍待原先提出的信息。短剧继续按 [shuohao-skills / Reelbench 参考结论](./short-drama-workbench-reference.md)组织阶段、资产修订和 Agent 外部 API 编排；目标保持进行中。

## 2026-10-02：精确历史查询与准备目标隔离

Control 新增独立 query host 端口。已有原任务通过当前权限与完整持久化身份校验后，才能从受信 private peers 恢复其插件四项身份，并要求实际 readiness 与原任务完整 target 一致。同实现的多个已准备 Agent 可以作为候选，当前新 Agent 的 ready 不能替代旧目标。配置、激活、新生成、当前运行时读取和公有目录始终接当前宿主；历史 catalog 不进入公有目录。已有结果投影继续从持久化 operation 读取，宿主离线不会把读取变为一次外部生成。

为避免正确准入的旧查询被新宿主抢走，Worker 的队列 scope 增加最多 32 个完整准备目标。ID 清单来自同一次严格绑定读取，八字段目标由编译资产及发布部署取得；实际工厂和数据库发布验证通过后才启动。SQLite / PostgreSQL 在 pending 和 expired 两分支的 LIMIT 前匹配目标，显式空集合不领取插件任务，普通任务仍由 current 模式处理；历史模式不领取普通任务。旧三字段调度接口保留原行为，执行权仍由实际 runtime acquire、不可变 Run 绑定及当前权限决定。

七个生产入口现在共用完整生产源码闭包的指纹，包括 Control、Worker、Device Gateway、递归私有依赖、本地 MCP 入口和三个执行模块。Control 单独变更也产生新实现身份，解决同一源码构建摘要对应不同七包归档集合的问题。实际复现还发现隐式 tsconfig 的 class-field 或 paths 设置能在不改变指纹时改变包字节和行为，现有 stage 因此固定显式编译设置并取消隐式配置发现；固定设置与原七包在同一源码身份下逐字节一致。stage 的历史范围标记升级为 scope.v1；旧 schema v0 与 scope.v0 归档仍按原字节校验、保留和选择，但人工启动入口在执行前拒绝不能证明准备目标隔离的旧包。没有重写旧 sidecar 或自动降级。配置步骤和兼容限制见[进程启动说明](./extension-process-startup.md)。

### 验证范围

- 历史查询实际集成与既有组合/正式进程集成共 4/4 通过。真实 SQLite、已发布 AgentVersion、实际 Worker 工厂、鉴权 private HTTP 和 Control HTTP/SSE 证明同一实现的两个不同准备目标：current 先 wake 返回 idle，旧查询仍 pending、lease epoch 为 0；historical 随后完成。SSE 从游标 1 两次重连取得相同输出，当前新生成与默认 Agent 保持可用。该单项使用本地模型和 Comfy 夹具，模型 8 次、生成 POST 2 次、history GET 2 次；旧查询没有增加生成 POST，没有调用真实供应商。
- 队列范围、租约栅栏及公平顺序在真实 SQLite / 临时 PostgreSQL 专项 31/31 通过，无跳过。覆盖同实现不同 Agent/同 Agent 不同 materialization、空集合、全部 target 字段、参数绑定、JSON null、expired、并发及异步快照。临时 PostgreSQL 仅开放 Unix socket，结束后已停止并清理。日志为 `output/extensions/checks/prepared-target-scope-postgres.log`。
- query source / 授权事务专项 57/57，使用真实 SQLite 和明确的应用 host 夹具；不将该夹具当作实际 runtime readiness。私有路由与历史环境配置、既有 client/env 专项 31/31，覆盖多候选、摘要/owner 回显、离线拒替代、严格配置、重读、关闭取消及多 peer 清理失败。全量回归发现的清理错误传播问题已修复；原清理顺序与失败断言保留，只把测试辅助数据从严格 peer 配置中拆开。日志为 `application-query-host.log`、`control-host-router-focused.log` 和 `query-routing-cleanup-focused.log`。
- 两份完全独立的源码副本分别离线 pnpm 安装并核对工作区导入，B 只修改真实 Control 启动输出；两次现有 stage 生成不同指纹与 Control 包，两套完整七包可保留在同一个数据 root。删除两份源码及安装包后，仍能按两个精确摘要选中各自归档。没有手工指定虚假实现摘要或把副本工作区导入指向当前源码。它证明两套真实构建可并存，不单独证明跨构建的任务恢复或原生自动升级流程。
- 最终全量 Worker 895 通过 / 198 环境跳过，Control 287 通过 / 9 环境跳过，Application 195/195，均为 0 失败。AgentVersion 72/72、恢复启动器 5/5、stage 5/5（含隐式配置真实行为对照）、实际七包保留与资源替换后的消费验证 7/7、独立双构建 1/1。最终构建指纹为 `sha256:e3fc308c2b11d78c09717b8289dfa0c40947e197095fd56fe8cae4e5faffbb0a`；18 个 packages、Worker/Control 类型检查、UI lint、边界和仓库格式检查通过。日志为 `query-routing-*.log` 与 `fixed-tsconfig-final-*.log`；隐式配置复现与七包同身份字节对照另保存在 `implicit-tsconfig-proof.log`、`fixed-tsconfig-real-bundles-comparison.log`。本轮没有修改 UI 或重跑其全量，既有 7 项 UI 基线失败仍见前一界面阶段。所有自有测试服务、子进程和临时源码目录已清理。

**剩余：** 原生桌面仍仅监督当前宿主，自动保存非秘密恢复输入、当前同 endpoint 凭据解析、自动旧宿主生命周期与完整跨构建产品验收继续按[下一阶段实施顺序](./native-extension-recovery-plan.md)推进。该文档来自只读代码审计，不能当作已实现能力。生产权威身份协议及第二个实际企业 API 仍待已提出的信息；完整目标保持进行中。短剧产品形态继续按[参考结论](./short-drama-workbench-reference.md)后置，已验证的 Krea2 入口不声称支持参考图、视频或配音。

## 2026-10-02：原生启动、构建保留与历史任务领取

原生桌面的现有 `RuntimeSupervisor` 增加专用配置，默认关闭；明确开启时沿用桌面 standalone 的完整四字段身份。每次启动重读严格配置、清除环境中的插件及 bootstrap 覆盖、轮换私有 token。先运行原发布入口，再启动 Worker，并以有界鉴权目录挑战核对实际 origin 和完整 owner，最后启动 Control。取消、快速退出、就绪失败和终止失败均保留正确的子进程所有权，不能启动重复进程。配置形状与操作步骤见[进程启动说明](./extension-process-startup.md)。

任务领取新增可选执行范围。启用的插件 Worker 从自身已加载代码生成实际注册摘要，按租户和已保存配置的确切插件实现筛选 pending / expired 任务，筛选在各分支 LIMIT 前完成。`current` 允许原普通任务，`historical` 只领取对应实现的插件任务；其他实现保留未领取状态。默认未启用路径仍使用原三字段队列请求。调度筛选不授予执行权限。组合入口也在第一次异步存储访问前冻结插件值、路径清单和环境，避免在打开数据库期间修改配置绕过历史模式校验。

打包版桌面明确开启插件时，正式 release 根据实际加载包的自校验摘要，在原生数据目录保存完整七个运行包及 sidecar。归档不复制配置或秘密，发布不覆盖已有文件，以最后发布的 sidecar 作为完整标记；每次选择重新核对所有包字节。构建目录同时绑定源码构建摘要与整套文件身份摘要，单个 root 最多 64 个构建；残缺、篡改、并发容量和遗留锁均明确处理，不自动清理旧构建。

新 stage sidecar 为 v1，明确声明历史领取协议。v0 构建仍可校验和保留，但恢复启动入口拒绝它，避免旧 Worker 忽略历史模式而领取普通任务。新的人工恢复脚本只执行固定摘要归档中的 Worker，重新提供当前身份、凭据和原不可变插件文件，不执行 release 或替换默认 Agent。构建完整性与协议标记都不能替代可信发布者和当前授权。

### 验证范围

- 原生专项覆盖严格配置、环境隔离、凭据轮换、子进程取消/监督和终止失败，最终 5 个文件 28 项通过，包括既有真实子进程阻塞日志/重启专项。真实 Node 24 Supervisor 运行 release / Worker / Control，完成目录保存、拒绝提前激活、独立插件资产、配置重读重启、实际 ready、任务执行、SSE 游标重放及默认 Agent 对照。模型仅使用本地 HTTP 夹具，ComfyUI 和外部 operation 均为 0。
- 历史恢复使用真实 SQLite、实际注册摘要、编译发布工厂、鉴权 private host 和应用任务准入。供应商夹具受理后进入 retry，停用插件并重开 `historical` Worker，恢复同一绑定 Run，POST 总数仍为 1。普通任务与其他实现的持久化测试任务在该期间的租约行完全不变；随后 `current` 完成普通任务，其他实现继续未领取。该项及所在文件 15 通过、14 个既有 PostgreSQL 环境跳过；快照、scope、环境专项 24/24。
- 队列筛选在真实 PostgreSQL 专项 17/17，无跳过；Store 全量 1,185 通过、0 失败、1 个既有环境提示占位跳过。临时服务仅开放 Unix socket，结束后已停止并清理。日志及核验信息见 `output/extensions/checks/queue-scope-postgres-0c5133a9.evidence.json`。
- AgentVersion 全量 54/54，其中归档专项 38/38。Worker 构建保留专项 7/7，实际现有打包流程构建七个生产入口，通过真实 release 保留，再删除/替换当前安装资源。明确选择两个摘要后，真实归档 Worker 以历史模式启动、返回 idle，并通过鉴权 catalog / readiness；原插件输入文件字节不变，模型及 ComfyUI 请求均为 0。此消费测试不单独证明任务恢复，恢复由上一项独立验证。
- 人工启动入口 3/3，包含 v0 在执行前被拒绝、严格选择与旧文件篡改；独立 TypeScript 检查通过。Application 193/193；Worker 全量 895 通过、198 个环境跳过；Control 全量 270 通过、9 个环境跳过，均为 0 失败。18 个 packages 及 Control / Worker 类型检查、UI lint / 原生 host 构建、stage 4/4、实际七包构建/语法/身份核验、边界与格式检查通过。结果记录在 `output/extensions/checks/extension-native-*.log`、`native-final-*.log` 和 `archive-*.log`。

**剩余：** 本轮原生路径仍是现有单用户 standalone；生产权威的当前身份查询协议、自动旧宿主编排及跨构建查询路由、第二个实际企业 API 的复用尚未完成。原生仅监督当前安装宿主，历史入口由操作者单独在前台启动。源代码开发也不自动产生归档。短剧继续按[参考文档](./short-drama-workbench-reference.md)推进项目、阶段和资产形态，不把 Krea2 文生图扩大为参考图、视频或配音支持。

## 2026-10-02：BFF、客户端与最小生图界面

公共读取链路新增插件目录、精确配置/Agent 的实际就绪状态、某个插件 Run 的外部任务投影。目录只返回有界表单 schema 和显示资料，不返回模型指导、工具实现或执行权限。Control 同时校验本地发布资产/部署与 Worker 的真实装配证明；误接其他数据库的 Worker 不能仅凭 ready 回应使当前配置可用。

外部状态来自 SQLite / PostgreSQL 的持久化 operation。读取按 tenant、Run、不可变 binding 摘要隔离，最多返回 16 个 operation，并明确标识截断。查询 Run 只显示已绑定的原 operation，保留原生成 Run ID；当前身份必须具备两次 Run 的读取权限。停用后可以读取已有结果，撤销后拒绝缓存读取，并在异步存储返回后复查。配置、激活、绑定、Run 创建者和记录作用域不一致均拒绝。

只读 GET 不查询供应商、不创建任务、不重新提交生成。投影分别表达 Run 状态、供应商状态和观察时间；已结束的 Agent 调用不等于媒体生成成功。Krea2 图片引用必须与原配置的 HTTPS `/view` 地址及确切文件参数一致，拒绝其他来源、凭据、路径穿越和附加查询参数；图片仍是供应商的结果引用，不是永久资产托管。

BFF 在既有 session、Origin、CSRF 与可信身份转发边界内增加明确的插件路径、方法和查询校验，设置有限 JSON 回复、读取期限与取消。既有 Run SSE 继续原来的流式代理。客户端复用现有鉴权、取消、幂等键和错误分类，并校验服务端回显的配置、目标和 Run 身份。

最小界面已接入智能体页的“业务插件”入口，仅在 Control 宿主明确提供已支持的 Krea2 目录时显示。配置保存和启用分开，明确选择 Agent 并核对实际 readiness；未保存的地址修改、未就绪 Agent 或与激活目标不一致的选择均阻止新生成。查询与生成分别准入，重试保留最初意图、幂等键和已受理回执，不把查询错误恢复成一次生图。

创建任务与查询复用既有 Thread、Turn、权威历史及 SSE 恢复；服务端任务归属核对后打开原会话，不另建执行循环。关闭、切换身份/线程及取消会丢弃晚到响应；手动关闭弹窗恢复入口焦点，任务导航保留任务页焦点。结果读取最多取当前会话最近 8 个 Run，分别展示会话状态、外部状态、记录更新时间和供应商图片链接。先验证这一生图流程，再按[短剧参考](./short-drama-workbench-reference.md)细化项目、创作阶段及资产版本。当前不声称支持参考图、视频、配音或完整成片。

### 验证范围

- 新读接口 8 项行为测试通过，覆盖认证、严格查询、跨空间、缓存撤权、原 operation 归属、安全图片引用和本地部署不足。该用例使用合成宿主，验证权限与读取投影，不证明真实供应商生成。
- BFF 25 项测试通过，其中真实 BFF → Control HTTP 覆盖目录、配置、实际配置 revision、就绪、启用、任务幂等重试及持久化状态读取；供应商未被调用。Contracts 127 / Client 124 / Application 191 项全量通过。
- Control 全量以 4 个并发文件执行：270 通过、9 项环境相关跳过、0 失败。首次高并发回归的一项既有关闭进程测试因 5 秒就绪期限失败，随后独立 7 项关闭测试和上述全量均通过，没有扩大期限或削弱断言。
- Store 在真实 PostgreSQL 18 下全量 1,174 通过、0 失败、1 个环境提示占位跳过；实际数据库测试均执行，临时服务仅开放 Unix socket，结束后停止并清理。两后端外部查询专项 20 项全部通过。
- UI 专项 17 个文件、279 项全部通过，覆盖配置/激活、真实客户端接线、查询恢复意图、取消、焦点及原会话接纳。其中 10 项使用真实 HTTP/SSE 解码器，验证游标重连、重复事件去重、审批恢复、归属拒绝和关闭后丢弃缓冲事件；使用确定性供应商夹具，没有调用真实模型或 ComfyUI。
- UI 全量 426 个文件、2,786 项：2,779 通过、7 失败。七项均在变更前提交 `26b32df855da47a14a747c2e344dcf7a212b47f8` 的 UI 源码上复现，失败名称与断言一致，相关原测试未改动。该基线使用当前同一套依赖，不代表完整历史依赖环境；涉及 TranscriptWindow（4）、useControlThreadCatalog（1）、AppWorkspaceContent（1）、ControlCommandOfficeRoomAdapter（1）。证据在 `output/extensions/checks/ui-head-baseline-*.evidence.json`，最终全量日志为 `business-extension-ui-full-final.log`。
- 真实浏览器检查使用生产 React 组件、客户端及本地 HTTP 数据夹具：验证入口、就绪门槛、查询导航、桌面/低高度/390px 窄屏、弹窗无横向溢出、关闭焦点，以及原首页场景切换和目标/计划入口。该页面夹具不提供真实 Worker 或 SSE；SSE 行为由上述集成测试单独证明。UI lint（含 Electron）、build、边界及仓库格式检查通过。
- 全部 18 个 packages 类型检查、AgentVersion 16 项及 desktop stage 4 项测试通过；7 个实际 bundle 构建、语法和摘要验证通过。检查日志在 `output/extensions/checks/extension-read-*.log`、`final-plugin-*.log`、`external-query-postgres.log`。这些构建检查仍不代表原生启动身份或生产多用户后台身份已完成。

**剩余：** 生产可信身份、原生桌面启动协调、历史构建保留与第二个实际企业 API 的复用验证仍按原计划推进。最小 Web 入口只对应已验证的显式 standalone 装配，不能据此认为插件子系统或短剧工作台已全部交付。

## 2026-10-01：发布 CLI 与正式进程接线

现有发布 CLI、Worker main 和 Control main 已接受显式 standalone 插件配置。启用标记严格为 `1`；未设置或 `0` 保留原路径。Worker / Control 需要明确的完整身份及 private loopback peer，不依靠默认值补造插件身份。production 拒绝环境变量启用，native bootstrap 尚未接入这组身份端口，不能把本阶段当作生产多用户或原生桌面的插件交付。

先启动只提供目录及配置校验的 Worker host，再通过 Control 保存配置，解决“没有配置不能装配、没有宿主不能保存配置”的接入顺序。此阶段不会伪造 ready；未发布的插件版本仍不可激活。随后用明确 crewonKernel 版本编译独立插件资产，通过成对的补充绑定及资产文件接入原发布 CLI，重启 Worker 后才可取得实际工厂 readiness、激活和提交任务。

插件文件保持只读，与原模型/Agent 绑定文件分开。资产及绑定按版本 ID 一一对应，校验实际摘要、配置及实现身份、工具/指导、租户、默认版本保护、文件大小与 UTF-8；拒绝重复 ID、未知字段及文件别名绕过。CLI 在创建模型/工具资源前校验插件输入，先验证合并结果，再生成原绑定文件。未启用而保留完整路径时不读取或发布插件；部分配置及非精确启用标记仍会拒绝。

开发服务器启用插件时按实际 Worker Host ready 地址等待，再启动 Control；动态端口传递实际地址，固定端口核对地址。当前明确限制单 Worker，避免多个宿主争抢同一端口。启动失败、就绪超时、取消和 ready 后快速退出均有子进程清理/监督覆盖；原未启用的多 Worker 启动继续保持。步骤及配置边界见[进程启动说明](./extension-process-startup.md)。

### 验证范围

- 新集成实际运行 Node 24 的 release、Worker、Control 三个入口：基础发布 → 目录宿主 → 默认插件路由 404 → 保存配置且拒绝提前激活 → 编译并发布补充资产 → 关闭重启 → 激活、任务准入、SSE 输出及游标重连。另提交默认任务，验证原资产、默认 Agent、工具和现有 Turn 行为保持；三个 production 入口拒绝插件 opt-in，private token 不进入诊断。
- 该进程测试仅向本地模型 SSE 夹具发出 2 次请求，外部 operation 数量为 0；它证明正式启动、发布及准入，不冒充新的真实生图验收。此前真实模型/ComfyUI 生成，以及受理后中断/恢复证据继续保留。
- Worker 全量 877 通过、198 项环境相关跳过；Control 全量 262 通过、9 项环境相关跳过，均 0 失败。最后调整 CLI 前置校验后，发布及真实进程专项 22 项再次全部通过。新增及既有组合专项另在真实 PostgreSQL 18 / SQLite 上 29 项全部通过，无跳过；临时 PostgreSQL 仅开放 Unix socket，结束后已停止并清理。
- 开发脚本 15 项测试、两个模块类型检查、TypeScript 边界入口及仓库格式检查通过。桌面 stage 的 4 项测试及全部 7 个实际 bundle 构建/语法检查通过；只验证打包，不据此声称原生桌面插件身份及升级协调已实现。日志在 `output/extensions/checks/extension-process-*.log`、`extension-entry-postgres.log`。

**下一步：** 接通 BFF、客户端与最小配置/任务/结果界面，继续复用现有流式事件。生产可信身份、原生桌面启动协调、历史构建保留和第二个实际企业 API 仍未完成；短剧的完整产品形态继续遵循参考文档后置。

## 2026-10-01：实际发布工厂与显式组合入口

ComfyUI 已接入现有 AgentVersion 发布及运行工厂。`compileComfyAgentVersion` 从明确的 crewonKernel 版本编译独立插件版本，保留模型、已有工具及资源要求，追加确切插件指导和两个工具；拒绝替换默认版本、工具名冲突及 providerAgent。运行绑定新增可选 `extensionConfigPath`，没有该字段的旧配置保持原形状及原 materialization 摘要。

配置文件冻结完整配置修订和审批要求，工厂根据实际宿主登记校验实现摘要，并在真正构造工具 owner 后记录不可变装配证明。配置、审批、工具或指导变化均不能冒用已发布版本。读取发布元数据与构造工厂使用同一份复制后的绑定清单；新增绑定、跨租户绑定或覆盖默认 Agent 的文件漂移会被拒绝。

实现身份来自实际 Worker 生产源码、递归工作区依赖、锁文件和构建输入的指纹。现有桌面打包流程把同一指纹注入各入口，并写入每个 bundle 的独立文件摘要；加载进程核对磁盘与加载时身份，源码或构建文件变化后拒绝把新字节当作旧运行环境。该指纹只证明代码身份，不授予权限。保守指纹也覆盖宿主依赖变化：升级后须发布新配置/版本；旧任务需保留匹配的旧构建才能恢复。历史构建保留及升级切换流程仍待实现，本轮不声称已解决跨宿主升级的旧任务执行。

Control 通过新的有界、鉴权 loopback 协议取得目录和实时 readiness。Worker 从当前可信身份再次核对完整 principal/actor/tenant/space 与权限，再通过执行 Run 的同一个 resolver 实际 acquire/release。只有配置、实现、部署、路由和真实工具装配全部匹配才返回 ready；持久化部署记录或工具名称不能单独证明可运行。HTTP 关闭与超时保留物理在途工作，直到归还实际运行时租约。

Worker 的 SQLite/PostgreSQL 组合接受显式 `extensionRuntime`，在拥有数据库后等待插件迁移并构造工厂；两个子 Store 复用父连接和生命周期，父关闭后拒绝调用。Control 新增异步 `createStandaloneControlApiWithExtensions`，PostgreSQL 的异步组合增加可选 Worker 接线，复用现有配置及任务用例。旧同步 Control 组合与默认聊天继续保持原行为；没有显式接线时插件路由仍为 404。

### 验证范围

- 新组合集成使用真实 Control HTTP 任务入口、完整配置保存/启停、实际 AgentVersion 发布、真实 Worker 工厂和 SQLite 存储。外部受理后在工具回执前中断，停用插件、关闭并重建 Worker 和 Control，再恢复同一 Run，取得两个工具完成事件与图片 URL 流式输出。通过真正的 Control SSE 和 `Last-Event-ID` 两次重连，取得相同的旧游标后事件；生成 POST 总数为 1。默认 Agent 的摘要、指导和工具保持原状。
- 该组合测试的模型是本地 HTTP SSE 夹具，ComfyUI/DNS 是确定性夹具；实际发布和装配身份均由本次宿主代码生成，没有合成 readiness 或实现摘要。此前真实模型/ComfyUI 图片证据继续保留，本轮未重复调用真实生成。
- 全量回归：Worker 857 通过、195 项环境相关跳过；Control 253 通过、9 项环境相关跳过；Contracts 115 通过；AgentVersion 16 通过，均为 0 失败。另在真实 PostgreSQL 18 执行新增双库组合 22 项与 Control 组合 9 项，全部通过；这补齐了本轮新增 PostgreSQL 路径，未将其他既有环境跳过计作验收。
- 真实 PostgreSQL 的 Store 全量：1,167 通过、0 失败，1 个环境提示占位跳过，实际数据库行为测试均执行。临时服务全程仅开放 Unix socket，检查后已停止并清除数据。
- 五个模块类型检查、TypeScript 边界入口及 `pnpm format` 通过。桌面 stage 的 4 项测试和全部 7 个实际生产入口打包/语法检查通过，共同源码指纹与每入口文件摘要已写入 sidecar。日志为 `output/extensions/checks/extension-composition-*.log`、`extension-private-host-tests.log`、`extension-store-full-postgres.log` 和 `extension-control-composition-postgres.log`。

**下一步：** 组合入口已经接通；进程启动参数、现有发布 CLI 与桌面/服务器启动协调尚未启用这组入口。生产多用户后台身份查询仍需可信宿主端口，不能从 actorId 推造 principal。继续补正式启动接线，再连接 BFF、客户端及最小界面；短剧工作台的详细产品形态保持后置。

## 2026-10-01：用户输入原子准入与可选任务 HTTP 入口

新增 `ExtensionTaskApplicationService`，先检查插件执行/查询、线程写入和 Run 创建权限，再通过现有 Turn 用例准备用户消息、模型历史和 Run。SQLite 与 PostgreSQL 将这些记录、插件绑定、outbox、队列、Turn 回执及插件任务回执放入同一次事务。绑定写入失败时全部回滚；并发重复请求和数据库重开后只返回原任务。

生成任务使用当前启用配置，绑定摘要覆盖真正提交给 Agent 的用户内容。查询任务必须证明原 Run 的当前读取权限和 operation 归属，沿用原配置及执行版本；插件停用后仍可查询，撤销拒绝新查询。激活状态在提交事务中再次比较 revision，配置切换与准入竞争不会产生半个任务。已有活跃 Thread Goal 的线程拒绝插件准入，保留原目标、历史及 Run。

Control 新增可选 `POST /api/v1/extensions/:pluginId/tasks`，严格区分生成输入与原任务查询，要求 `Idempotency-Key`，复用当前身份及错误边界。请求不能指定租户、空间、实现摘要、Agent 或配置修订；响应只返回已提交的线程、消息、Run 与配置修订标识。后续结果继续经现有 Run/事件接口读取。默认组合没有安装这些服务，插件路由仍返回 404；正式生产装配尚未完成。

任务回执新增 `crewon.extension-turn-admission.v0` 标识，复用现有表。旧 Run-only 回执仍可由旧读取入口重放；Turn 入口拒绝将缺少用户消息的旧回执当作新任务成功。没有批量迁移历史，也没有改变默认 Agent。

### 验证范围

- 双库存储专项覆盖并发、重开、绑定失败完整回滚、用户内容摘要与历史一致、停用/撤销后的回执重放及旧回执兼容。
- Application 双库行为测试覆盖权限、配置竞争、原任务读取权限、目标保护、客户端身份注入和幂等冲突。HTTP 覆盖鉴权、未知参数、输入上限、同空间归属、并发重放、查询归属，以及 outbox 唤醒失败不撤销已提交任务。
- 原有 Kernel / Worker 恢复集成现在通过上述正式任务用例提交真实用户消息与绑定，验证受理后中断、停用、数据库重开、流式输出和游标续读；生成 POST 仍为 1。模型与 HTTP 为确定性夹具，宿主部署为合成数据，不据此声称生产组合或真实发布装配已验收。
- 全量回归：Contracts 110 通过；Application 191 通过；Control 236 通过、8 项环境相关跳过；Worker 808 通过、184 项环境相关跳过。真实 PostgreSQL 18 的 Store 全量为 1,161 通过、0 失败，另跳过 1 个“缺少数据库环境”的提示占位测试，实际数据库行为测试已执行。临时数据库仅开放 Unix socket，结束后已停止并清理。
- 五个模块的类型检查、TypeScript 边界入口及仓库格式检查通过，日志在 `output/extensions/checks/extension-turn-*.log`。真实模型与 ComfyUI 的此前证据继续保留，本轮没有再次生成图片。

**下一步：** 将经过验证的宿主实现身份、精确配置和模型路由纳入发布/运行装配，并实际安装配置及任务服务。随后连接 BFF、客户端和最小界面；短剧工作台的详细产品设计仍后置。

## 2026-10-01：按持久化绑定执行 ComfyUI 工具

新增 `BoundComfyToolRuntime`，供一个不可变 AgentVersion 的多个 Run 共用。每次执行都从 Store 读取本 Run 的插件绑定、配置修订和真实 Run 身份；运行时拒绝不同配置、实现登记、执行路由或没有插件绑定的任务。配置改版后，已准入任务继续使用原地址和配置。

通过 `CurrentExtensionExecutionAuthorization` 从宿主重新解析当前身份，检查本 Run 执行权和插件权限；关联查询还检查原 Run 的读取权。实际 HTTP 请求在 DNS 校验后、传输前再次检查当前权限、插件启用/撤销状态和提交租约。普通停用不阻止既有提交的恢复与获授权查询；撤销也阻止返回工具缓存结果。

另起的查询 Run 只能读取持久化关联的原 operation；它不能重新提交生图，也不能用任意 operation ID 查询供应商。共享运行时关闭会终止所属请求并等待在途工作退出。生图 manifest 和工具目录已增加到源码，模型描述明确说明关联查询的范围。

### 验证范围

- 新增 10 项 Worker 适配器行为测试，使用真实 SQLite 配置、激活、Run 绑定和外部回执，覆盖并发隔离、配置变更、重新打开、停用/撤销、查询归属、DNS 期间撤权及运行时关闭。
- 新增 4 项 Application 当前身份/权限测试，覆盖身份变更、原任务读取权限、无效来源、取消和异步期间的调用方修改。
- 新增现有 Kernel / Worker 的集成测试：受理后、工具回执写入前中断；停用插件后关闭并重新打开 Run Store，重建运行时并恢复。取得 2 条工具完成事件、图片 URL 的流式输出、持久化助手消息，以及旧游标之后的事件；生成 POST 总数为 1。
- 上述新增测试的模型、DNS 和 ComfyUI 传输为确定性夹具，部署标识为合成测试数据。它们验证共享运行时的绑定与恢复行为，不代替真实发布工厂和正式入口验收；此前真实模型与 ComfyUI 证据仍见后文，本轮未重复生成图片。
- Application 全量：191 通过；Worker 全量：808 通过、184 项环境相关跳过、0 失败。两者类型检查、TypeScript 边界入口检查与 `pnpm format` 通过。日志为 `output/extensions/checks/bound-*.log`。

用户新增的短剧参考已整理在[短剧工作台参考结论](./short-drama-workbench-reference.md)。当前 Krea2 仍只承诺文生图；参考图、视频及配音接入留待实际 API 验证。产品形态后置的顺序保持不变。

**下一步仍需正式装配。** 当前新增运行时尚未挂入生产组合入口：需将宿主构建的真实实现标识、模型路由和配置绑定纳入 AgentVersion 发布/装配。用户输入、Run 与插件绑定的一次事务准入现已完成，见上节；配置到结果的实际组合入口、通用 BFF/客户端和 UI 的完整流程尚未完成，目标继续进行中。

## 2026-09-30：真实 ComfyUI 链路验证

在隔离分支 `codex/incremental-extensions` 开发，原工作目录的未提交改动保持原状。

### 已验证事实

- 用户提供 `T01-Krea2文生图超强写实质感 (2).json` 及无鉴权的 HTTPS ComfyUI 服务地址。
- 只读检查返回 ComfyUI `0.37.0`；工作流所需的 11 个节点类型可用，UNet、CLIP、VAE 和 LoRA 模型名称均存在于该服务。
- 实际运行：提示词 → `POST /prompt` → `GET /history/:id` / `GET /queue` → `GET /view`，成功取得 PNG 图片并验证文件签名、尺寸和摘要。
- 单张、1MP 档、原工作流的 8 steps 与固定 seed；测试内容为窗边陶瓷茶壶。返回图片为 768×1368、1,313,769 bytes。
- 再运行诊断脚本的 `--resume`，通过已有任务编号取得同一张图片，没有走提交分支。

| 证据                        | 值                                                                 |
| --------------------------- | ------------------------------------------------------------------ |
| 外部任务编号                | `da7b2922-e9a1-4dda-9020-528bfbe197d0`                             |
| 图片 SHA-256                | `6a508e9a7344c05f80ded26cda9987155f3de82fade55ad45f924d1d9131bd6d` |
| 输入工作流规范 JSON SHA-256 | `3dfa5d5cade0e1dddf1e4d200dc9d0f6c7162960e18569fe39ec6539ead83b66` |
| 本地回执                    | `output/extensions/comfyui/first-image/receipt.json`               |
| 本地图片                    | `output/extensions/comfyui/first-image/image-1.png`                |
| 只读检查记录                | `output/extensions/comfyui/preflight.json`                         |

生成数据保存在当前工作树的 `output/extensions/`，不纳入 Git。上面的实际调用验证了外部 API 链路；尚未证明 CrewON 产品内的 Agent、审批和 Run 恢复链路已接通。

### 工作流与协议边界

- 当前工作流的 KSampler 直接引用节点 `55`，节点 `87` 的 LoRA 未接入输出路径。此次保持原连线，没有自动修改出图行为。
- 提交工具完成只能表示外部服务已受理，不能表示图片已经生成。观察状态分别表达 queued、running、succeeded、failed 和 unknownOutcome。
- ComfyUI 接受任务关联 ID 不代表支持持久化幂等提交。官方 [server.py](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py) 的提交路径会入队；因此适配器不自动重发 POST。历史与队列均找不到任务时保留未知结果，不推断为可再次提交。
- 当前不暴露全局 interrupt 或清空队列，避免影响同一服务上的其他任务。定向取消需独立验证后再接入。

## 已增加的代码

| 模块                                                                      | 实施范围                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [ComfyApi](../apps/runtime-worker/src/extensions/comfyui-api.ts)          | 提交、按任务查询、真实完成判断和受限结果引用；HTTP、授权和持久化通过宿主边界注入                            |
| [诊断脚本](../scripts/comfyui-flow-smoke.mjs)                             | 有界真实调用、请求前保存提交状态、任务回执、显式 resume、PNG 读取；不是生产网络适配器或后台调度器           |
| [插件声明](../packages/domain/src/extension-manifest.ts)                  | 严格版本与字段、有界指令、凭据槽声明、工具策略、输入与配置校验；复用已有 Workflow 的有界 schema 子集        |
| [静态注册表](../apps/runtime-worker/src/extensions/extension-registry.ts) | 注册失败隔离、重复版本/工具冲突拒绝、精确实现摘要匹配、保留多个历史版本；只注册元数据，不代表获授权或可执行 |

复用的 Workflow schema 是现有宿主内部子集，不直接当作标准 JSON Schema 传给模型；实际装配工具时仍需转换和契约验证。首个提交没有增加公共 HTTP 路由、持久化业务表或修改旧 Agent 版本；后续持久化进展见下节。

新增行为测试覆盖：声明与输入越界、越权字段、mutation 不得声明安全重放、静态注册冲突、适配器缺失/变更、已提交与已完成区分、提交响应丢失不重发、未知任务、错误结果和图片路径校验。测试中的 `example.video` 是合成夹具，不是对用户暴露的可用服务。

### 本轮验证结果

- Domain 全量测试：145 通过。
- Runtime Worker 全量测试：783 通过、184 项环境相关测试跳过、0 失败；不据此声称跳过的数据库/环境路径已经验收。
- Domain、Runtime Worker 类型检查通过；`pnpm crewon:boundary:check`、`pnpm format`、新增代码格式和本地文档链接检查通过。
- 包依赖边界测试：8 通过、4 失败。已在原工作目录复现同样 4 项失败，相关文件对 HEAD 无修改；原因是既有 `process-lifecycle` 包及其 Control/Worker/Device 使用尚未登记到边界清单。本轮未放宽检查或修改这些既有文件。基线复现日志位于 `output/extensions/checks/baseline-package-boundaries.log`。

## 阶段状态与下一步

| 阶段                 | 当前证据                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- |
| E0 接入验证          | 真实 ComfyUI API 与独立发布的 crewonKernel 模型路径已通过；产品准入接线见 E2                |
| E1 契约与注册        | 声明、静态登记、真实 readiness 和 standalone 正式进程入口已实现；生产可信身份待接线         |
| E2 配置与绑定        | 双库原子准入、发布、原生 standalone、打包版旧配置升级与自动历史宿主已验证；生产身份仍待接通 |
| E3 Agent / Tool 闭环 | 实际模型生图/恢复已验证；独立双构建证明自动原包查询、当前 Worker 隔离及 SSE 恢复            |
| E4 最小 Web 界面     | 已接通 BFF、客户端、配置/启用/任务/结果及原会话恢复；仅显式 standalone 装配                 |
| E5 第二业务          | 尚未接入实际企业 API；短剧产品方案及交互预览已完成，仍不能代替第二个真实业务 API 的复用验收 |

继续顺序：取得生产身份服务权威协议后接通后台当前身份，再验证第二个实际业务 API 的复用；同时在已验证的最小生图链路上细化短剧项目及资产工作台，workspace/MCP/cloud 的冻结另行补齐。这个过程保留现有聊天和团队路径。

## 2026-09-30：配置修订与 Run 原子绑定存储

新增配置、激活和 Run 绑定的版本化记录及 SQLite / PostgreSQL 实现，作为正式接入的存储基础，尚未提供产品入口。

- 配置修订不可变，摘要覆盖空间、插件版本、实现摘要、非秘密参数和凭据引用；保存使用预期 revision 与按 actor 隔离的幂等回执。参数上限 16KiB，复制并冻结记录，拒绝未知字段、未知版本、重复凭据槽及摘要不一致。
- 激活状态独立于配置保存。启用要求已发布的 AgentVersion 与部署记录匹配，声明的执行主体必须为 crewonKernel；存储核对内容摘要、materialization 摘要、authority、policy 和 workspace。此检查只证明持久化身份，不能代替宿主对真实运行时、工具实现与权限的检查。
- 插件绑定、既有 Run 事件/快照、outbox、执行队列及请求回执在同一事务内提交。通过注入绑定写入失败，验证所有任务写入完整回滚，清除故障后同一请求可正常提交。
- 重复请求在配置切换、停用或撤销后仍返回原有 Run，不创建新任务；新请求必须使用当前启用的配置。幂等结果读取本身不授予再次访问外部 API 的权限。
- 独立查询 Run 必须关联同空间、同插件的原生成 Run、绑定摘要及已保存 operation；停用后可沿原配置准入查询，撤销后拒绝新查询。实际外部调用时的实时撤销校验仍需接入 Worker。
- 新迁移由宿主显式调用，带独立 schema 版本，不要求旧任务批量迁移；普通 Run 创建不产生插件绑定。SQLite 复用现有同步提交事务，PostgreSQL 复用现有 Run 提交及队列事务。

### 检查与剩余边界

- Domain / Application / Store 全量测试分别为 **149 / 187 / 763 通过，0 失败**；Store 另有 171 项环境相关测试跳过。
- 在实际 SQLite 文件与临时 PostgreSQL 18 中执行新增配置/绑定契约和既有外部回执专项：**35 通过，0 跳过**。覆盖独立连接并发、配置冲突、重复请求、回滚、重新打开、旧任务兼容和跨空间隔离。临时 PostgreSQL 只开放 Unix socket，运行后停止并清理。
- 三个包及 Runtime Worker 的类型检查通过；Worker 的 ComfyUI 与注册表专项 **27 通过，0 跳过**，包含现有流式执行和中断恢复集成。TypeScript 边界入口及仓库格式检查通过。日志位于 `output/extensions/checks/extension-config-regression.log`、`extension-storage-sqlite-postgres.log` 和 `extension-worker-regression.log`。

下一步是 Application 授权与配置用例、可信目录/运行时就绪检查、AgentVersion 装配，以及 Worker 从持久化 Run 绑定选择工具实例。当前存储接口仅供已授权的宿主用例调用，不是公共 API；不能单凭保存激活记录就声称插件已经可用。产品页面和详细产品形态仍未展开。

## 2026-09-30：配置授权用例与 Control 协议

本阶段把前述存储接入独立的 Application 配置用例，并提供显式装配时才注册的 Control 路由。

- 新增 `extension:read/configure/activate/run/query` 权限动作与空间内插件资源。生产权限适配器仍向既有策略服务逐次请求判定，独立模式仅接受当前配置的 actor / principal / tenant / space；没有新增隐式授权或匿名入口。
- 配置保存从可信目录取得声明和实现摘要，验证插件配置 schema、参数大小、凭据槽与引用，再交给宿主做适配器特定校验。请求不能自带 tenant、space、实现摘要、执行路由或秘密值字段。
- 启用必须显式选择 AgentVersion，校验配置绑定的精确实现和必需凭据，向宿主请求就绪判定，再由存储事务复核部署身份。不会修改默认模型、发布新 Agent 或启动 Run。停用/撤销不依赖失效的插件目录和运行时继续在线。
- actor 与命令在首次异步调用前复制。所有读写和幂等重放先检查当前权限；配置和激活的重复请求可从持久化回执返回。旧启用请求在随后停用后重试，只返回原回执，不执行重新启用。
- 新增 OpenAPI、生成类型、严格请求解析和 `GET/PUT /api/v1/extensions/:pluginId/configuration`、`GET/PUT /api/v1/extensions/:pluginId/activation`。PUT 要求 `Idempotency-Key`；配置 GET 可选择精确 revision，省略时返回最新保存修订。保存与激活分别表达。
- Control 组合入口增加可选配置服务；没有显式注入时不注册上述路由。既有入口的默认行为有独立回归验证。

### 当前验证范围

- Contracts **109 通过**，Application **187 通过**，Store **770 通过 / 178 环境相关跳过**，Control API **233 通过 / 8 环境相关跳过**，均为 0 失败；随后新增的默认不注册路由用例单独通过。
- 实际 SQLite 与临时 PostgreSQL 的配置授权、配置/Run 绑定、外部回执专项共 **49 通过，0 跳过**。HTTP 层覆盖认证、空间隔离、未知字段、幂等冲突、查询 revision、激活及撤权后拒绝重放。
- Contracts / Application / Store / Control / Worker 类型检查通过，OpenAPI 生成检查与既有协议兼容检查通过。Worker 注册表与跨进程恢复集成 **6 通过**；本轮未再次发起生图。
- 检查日志为 `output/extensions/checks/extension-control-regression.log`、`extension-control-typecheck.log` 和 `extension-control-postgres.log`。

**仍未完成生产插件启用。** 这些用例与 HTTP 测试使用明确标注的合成宿主就绪判定，证明授权和事务语义，不证明真实运行时可以装配。下一步需要实现 ComfyUI 的生产宿主校验、精确配置对应的 AgentVersion 装配、Worker 按 Run 绑定解析与实时撤销检查，再接插件任务创建和实际输入。BFF / 客户端与产品界面尚未接入，产品形态继续后置。

## 2026-09-30：持久化 Tool 执行与 Worker 恢复

遵循“先跑通流程”的要求，新增实现集中在执行链，未增加插件页面或重构原聊天、团队入口。

- `ExternalOperationStore` 以 tenant、Run 和不可变绑定摘要隔离回执，保存执行身份、输入摘要、提交前关联 ID、服务端任务 ID、观察状态及有界结果引用；记录带 `crewon.external-operation.v0` 版本。
- SQLite 和 PostgreSQL 均通过唯一键争抢首次提交权。已有回执不重新获得提交权，执行身份变更拒绝复用；状态更新使用 revision 比较，终态不得回退。未知版本或损坏回执拒绝读取。
- `ComfyToolRuntime` 使用宿主的 ActionIntent、执行租约和审批凭据校验。提交前持久化；响应丢失和重启只查询，永不自动重发 POST。工具受理回执与生图完成状态分开表达，最终结果仅在 observe 成功时返回。
- 两个工具分别接收提示词和本 Run 的 operationId；模型不能提供服务地址、任意工作流、其他 Run 或文件路径。复用用户的 Krea2 图，固定本阶段验证用的单张、1MP、8 steps，保留原 LoRA 未连接状态。
- `ProductionComfyHttp` 复用现有 DNS 审核与地址固定传输，只访问宿主配置的 HTTPS 服务和明确允许的端点，限制响应体与超时，不跟随重定向，不注入凭据，不开放全局取消。
- 新迁移只在插件宿主显式调用时创建附加表；尚未接入通用 Control 配置、AgentVersion 发布和 Run 创建事务，不能据此认为已有产品入口已启用该能力。

### 当前证据

1. 真实服务：通过生产 HTTP 适配器查询首张图片任务，取得 `succeeded` 和 1 个图片引用。记录在 `output/extensions/comfyui/production-http-observation.json`；本轮没有再次生成图片。
2. 存储：在临时 PostgreSQL 18 和实际 SQLite 文件上运行同一套行为测试，覆盖独立连接争抢、重新打开、过期 revision、租户/Run/配置隔离、身份冲突及有界结果。临时数据库只开放 Unix socket，测试结束后已停止并清理。
3. 工具：覆盖提交前已有数据库回执、响应丢失、并发查询与受理回写竞争、服务端返回不同任务 ID、审批、租约过期、未知历史和终态缓存；POST 次数由测试明确断言。
4. 现有 CrewON 执行链：`comfyui-worker.integration.test.ts` 使用真实 Kernel、RuntimeWorker、SQLite 队列、ActionIntent 和 Tool 回执，在外部受理后/Worker 回执提交前模拟进程退出，再重新打开数据库恢复。最终两次工具调用完成、一次外部提交、流式文本携带图片 URL，事件游标续读也能取得结果。**该测试的模型和 ComfyUI HTTP 为确定性夹具，不是已完成真实模型的端到端验收。**

### 本阶段检查

- Application 回归：187 通过；Store 回归：751 通过、160 项环境相关测试跳过。
- Runtime Worker 完整回归：797 通过、184 项环境相关测试跳过、0 失败。
- 新增存储专项在真实 SQLite/PostgreSQL 上：13 通过、0 跳过；没有把全库测试中跳过的 PostgreSQL 项目算作已验证。
- Application、Store、Runtime Worker 类型检查、TypeScript 边界入口检查和仓库格式检查通过。详细日志保留在 `output/extensions/checks/`。
- 既有包依赖边界清单的 4 项基线失败仍见前节，本阶段未改动该清单。

### 接下来的接线

当前 Comfy 工具实例按 Run 隔离，而生产 AgentVersion runtime 由多个 Run 共享。应先增加宿主从持久化 Run 绑定解析插件版本/配置的适配层，再将其纳入 AgentVersion materialization 摘要和组合工厂；不能直接把一个 Run 的工具实例挂给所有 Run。

剩余工作包括配置快照、激活权限、Run 创建时的原子关联、注册声明与可执行适配器一致性、实际模型路由调用，以及跨模型流恢复的验证。产品形态细化仍放在真实流程验收之后。

## 2026-09-30：真实模型经 CrewON Worker 生图与跨进程恢复

实际执行了“用户描述 → 真实模型工具调用 → CrewON Worker → ComfyUI → 图片链接返回”。配置模型为 `gpt-5.5`，复用已有开发环境的 Responses 路由与凭据配置；没有复制或输出密钥，也没有修改原开发数据库和默认 Agent。

### 执行证据

- 在 `output/extensions/comfyui/real-agent/control.sqlite` 中通过现有发布流程发布并激活独立 AgentVersion，然后通过现有 Thread / Run 用例创建任务。
- 第一个 Node 进程中，真实模型自行请求 `crewon_comfyui_krea2__submit`。ComfyUI 受理并保存外部回执后，通过 Worker 的测试钩子在宿主工具回执提交前中断本次执行。
- 第二个 Node 进程用 `--resume` 打开同一数据库、同一 Run 和同一 AgentVersion，恢复既有提交回执。真实模型继续调用 `crewon_comfyui_krea2__observe`，取得成功结果，并以 Markdown 图片链接结束任务。
- HTTP 调用审计累计只有 **1 个 POST /prompt**。最终 Run 为 completed，外部操作为 succeeded；没有重新生成。
- 图片 GET 返回 200，PNG 签名、768×1368 尺寸和 SHA-256 已验证，目视内容为窗边木桌上的白色陶瓷茶壶与绿叶，符合输入描述。
- 以第一个进程结束时的事件游标 6 续读，取得后续 121 条事件，最后序号 127，包含恢复后的工具结果和模型流式输出。

| 项目                    | 值                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Run                     | `5e7d22c9-4629-4984-a37a-5c6b36a4e2a4`                                              |
| AgentVersion            | `comfy-agent-5e7d22c9-4629-4984-a37a-5c6b36a4e2a4`                                  |
| AgentVersion 内容摘要   | `sha256:b39e429cac880bc260ae0ef723ed084afc21ea094aa3faedde0cbb96ca617588`           |
| 外部任务                | `0e46520c-fe54-1065-e1a9-cdab63f63bd1`                                              |
| 图片 bytes              | `1267632`                                                                           |
| 图片 SHA-256            | `0878b563bf13885745d89ad1e46841ecda8bb321db2131771940cc23a5a149fe`                  |
| 首次/恢复证据           | `output/extensions/comfyui/real-agent/first-evidence.json`、`resumed-evidence.json` |
| 请求审计/文件与事件核验 | 同目录 `comfy-http.jsonl`、`verification.json`                                      |
| 图片                    | 同目录 `image-1.png`                                                                |

### 复现真实 Agent 流程

新增 [真实 Agent 联调脚本](../scripts/comfyui-agent-flow-smoke.mjs)，使用 Node.js 24，调用现有发布、线程、Run、Worker 和 DirectResponsesTransport。它不是第二套 Agent 引擎，也不是正式的插件配置/任务准入 API。

```sh
node --experimental-strip-types scripts/comfyui-agent-flow-smoke.mjs \
  --output-dir output/extensions/comfyui/new-agent-run \
  --base-url 'https://YOUR-COMFYUI-SERVICE/' \
  --model-endpoint 'https://YOUR-MODEL-PROVIDER/v1/responses' \
  --model-id 'YOUR-MODEL' \
  --api-key-environment CREWON_MODEL_API_KEY \
  --env-file '/absolute/path/to/your/local.env' \
  --pause-after-submit \
  --prompt '请生成一张写实照片：清晨窗边木桌上的白色陶瓷茶壶和绿叶。'

node --experimental-strip-types scripts/comfyui-agent-flow-smoke.mjs \
  --output-dir output/extensions/comfyui/new-agent-run \
  --env-file '/absolute/path/to/your/local.env' --resume
```

默认 request profile 为现有开发服务所用的 `responsesLite`；标准 Responses 服务可显式传 `--request-profile standard`。首次运行目录中已有快照或数据库时拒绝再次创建；resume 拒绝传入新提示词或替换模型/服务参数，并验证保存快照和适配器源码摘要。对应的重复启动、参数替换和实现漂移防护已实测拒绝，HTTP 审计没有新增请求。完成后的第三次 resume 返回已保存结果；127 条事件、消息及外部回执均未改变，未产生新的生成提交，证据为同目录 `replay-evidence.json`。

**完成范围：真实调用流程与跨进程恢复已经验证。** 当前仍在隔离的诊断环境：固定一个 Run 的宿主绑定写在诊断快照中，尚未替代 E2 要求的工作空间配置、启停/撤销、Run 原子绑定和生产组合工厂，也尚未从产品界面发起。完整目标保持进行中。

### 复现诊断

使用 Node.js 24 和 pnpm 10。首次调用必须显式提供服务地址、工作流和输出目录；脚本不读取隐式凭据，不重试生成请求。

```sh
node --experimental-strip-types scripts/comfyui-flow-smoke.mjs \
  --base-url 'https://YOUR-COMFYUI-SERVICE/' \
  --workflow '/absolute/path/to/workflow.json' \
  --output-dir output/extensions/comfyui/new-run \
  --prompt 'A photorealistic ceramic teapot beside a sunlit window.' \
  --megapixels 1

node --experimental-strip-types scripts/comfyui-flow-smoke.mjs \
  --output-dir output/extensions/comfyui/new-run --resume
```

诊断使用的是本次 Krea2 工作流的固定输入节点，不是支持任意 ComfyUI 工作流的导入器。输出目录已有回执时拒绝重新提交，必须显式 resume 或为新任务选择新目录。
