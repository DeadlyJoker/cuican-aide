# 增量扩展子系统实施进度

目标：按 [实施方案](./incremental-extension-subsystem-plan.md) 推进。状态：**ACTIVE，进行中**。已完成统一短剧包、原 Settings 执行准备、共享大纲/剧本、真实 Agent 工具、手动编辑/采用/锁定、文字请求冷恢复、项目对话/单阶段执行，以及 Short17 有界持久文字计划。Short18 已完成隔离正式桌面联合验收；Short19.0.1 的共享角色/场景/道具已通过0.1.18隔离正式桌面安装、执行准备、连续操作和冷读取验收，原 Agent 资产阶段已有源码及独立包集成覆盖。参考图工作流、分镜、视频、声音和成片随后实施。积分后置；完整短剧流程尚未交付。

[协同设计](./short-drama-agent-workflow-design.md)明确各环节由 AI 创作、确定性检查与适配工作流配合，不以生图代替整个流程。正式桌面0.1.15已正常升级，原账户、四个工作空间和数据完整保留；Short16已安装但暂未激活。原 Short11 UI 仍负责一条独立 Krea1 的未知结果查询；Short18 的独立历史查询协议已补齐源代码与真实双库验证，待正式桌面联合验收后再切换。原生成不改输入或重新提交。

历史章节保留当时的验收范围和剩余工作；当前状态与最新验收范围以首节为准。

## 2026-10-06：Short19.0.1 与正式桌面0.1.18联合验收

新候选App由冻结源码 `23a0e3fc6f9a6f40130c8751041fa36bbd7773c9` 构建，版本0.1.18，asar摘要 `899744b74763dc7f10c9ff2f55c138558ef7a1f9f00f04276c2327aa2e82704a`。实际Main为isPackaged，未使用强制打包标志。原账号菜单→设置→工具与扩展完成独立19.0.1目录导入、安装、占位参数配置、启用和两阶段执行准备。此前0.1.17拒绝补丁版本的失败保留；新包按真实协议声明接受，19.0.1包和SDK不重写。四份宿主编译CSS与冻结旧包逐字节一致，未增加前端样式变更。

Root CUA在真实模块建立“雨夜修复师”、需求v1及一个实际关联Thread；从项目进入原对话，可选择“角色、场景与道具 / 角色 / 仅依据需求”。未发送模型任务。角色实际保存v1→采用v1→锁定→追加v2候选；场景保存v1→采用v1→锁定，共七次业务写入，全部沿原页面暖成功路径核对、ACK并读回空待确认记录，没有额外点击恢复/确认。真实数据库为两项资产、三个不可变设定修订、七个原请求回执；角色当前采用v1且锁定，v2仅候选，场景采用v1且锁定。

两次均通过自有App正常退出，物理等待全部自有子进程，完整私有备份后读取原SQLite；随后冷启动同一资料。CUA读取项目及关联对话、角色两版历史和确切v1内容、场景内容/锁定；查看期间模块稳定保留。冷阶段业务行摘要全部相同，七个原回执仍已确认，原Thread和workspace绑定一致。独立验证又从两份完整备份读取相同原业务记录，并保存备份树清单；无强制进程终止，自有临时资料已清理。

正式包、生命周期、原数据库和实际截图证明位于 `output/extensions/checks/native-short19patch-compatible-formal-package-20261006/`；主核验是 `root-final-verification.json`，runner保持只负责实际Main身份/生命周期与只读事实，页面动作仅由Root CUA完成。首次runner在App启动前因旧变量名引用中止的原证明保留，修正后本次退出0。模型目录GET五次，模型/媒体POST为0，未产生Run、文字计划、参考版本或生成记录。原用户0.1.15 App、旧0.1.16/0.1.17完整包、SDK源/dist及两份冻结tar、旧19包均复核保持；用户profile未被本次验收操作。候选未签名发布或升级用户App，此段不宣称实际模型推理、参考素材生成或完整成片通过。

当前验收收束了安装兼容与连续资产操作。下一实现优先把原普通对话中的项目建议衔接到真实项目/当前Thread关联和执行范围，再为已采用设定提供同包概念输入衔接；随后接入经过实际素材校验的T10/D18、分镜、视频、声音和合成。既有大纲/剧本计划、资产单阶段权限和工作空间规则继续复用。完整目标保持ACTIVE，积分后置。

## 2026-10-06：独立插件发行版本兼容修复

以冻结正式0.1.17 App和独立Short19.0.1包启动全新的具名隔离资料，通过原账号菜单与Settings完成导入、安装、配置及启用。实际预览执行准备失败；源码核对发现本机准备写死12.0.0–19.0.0发行版本，19.0.1不在其中。此次没有创建项目或资产，不能声明资产连续操作或冷重开通过。正常退出并物理等待全部自有子进程，完整私有备份保留，原用户App/profile与未知Krea任务未动；模型/媒体POST为0。失败与生命周期证据位于 `output/extensions/checks/native-short19patch-formal-package-20261006/`。

现在源码按既有服务协议及工具声明检查本机短剧执行兼容性，发行版本仅作为确切安装身份的一部分。媒体基础服务、项目对话上下文和资产工具分别检查完整声明；已知服务的未支持API版本、缺失上下文或资产工具拒绝准备，未知可选声明不产生任何额外权限。来源、发布者、完整包摘要、配置修订、批准、两次停止/准备/重启及原历史绑定继续核验。增加真实安装资料的19.0.1和不同发行号兼容、缺少服务/工具与协议不匹配拒绝、修补版两阶段批准等行为测试。

七个相关Main/批准/导入测试文件最终 **151/151，零跳过**，Electron类型及Host构建、边界、仓库格式通过；正式包重建及新的桌面联合验收尚待完成。日志和源码证明位于 `output/extensions/checks/plugin-execution-contract-20261006/`。首次汇总检查在诊断shell的umask077下出现五项原目录权限断言失败（146通过），原日志保留；恢复测试原本的umask022后通过，未修改权限断言或业务代码。新增未知必需服务负例曾在夹具建立时就被原安装读取器拒绝，已把预期移到真实拒绝边界，并确保失败夹具关闭和清理。设计同步明确同一项目的两个入口、八阶段产物、多工作流和实施顺序，原全局CSS、SDK和短剧发行包本轮不变。完整目标继续ACTIVE。

## 2026-10-06：Short19.0.1 连续资产操作与产品衔接

按完整[协同设计](./short-drama-agent-workflow-design.md)补齐原对话到制作、手动与Agent接续、阶段完成口径，以及媒体执行保持已确认输入的规则。设计仍为同一个短剧包的八阶段流程；当前原聊天建议到项目/计划还有操作衔接，资产到生图尚无直接绑定，分镜及后续仍待落地。接下来先完成隔离正式桌面验收，再优先收束原对话里的项目与执行入口，随后连通真实参考素材工作流。

独立补丁19.0.1让五项资产操作的暖成功回执自动读回核对并确认记录已清空；保存、采用、锁定可以连续操作，候选不会因此自动采用。读回、ACK或后续GET失败仍保留已成功业务写，挡住新写；冷启动和恢复读取不自动执行或确认。Controller保持798行，抽取成果读取与暖确认模块；宿主、SDK、公开服务及全局CSS未改，旧19.0.0包保留。

冻结SDK0.1.0仓外独立UI/Node严格构建及完整portable **262/262**、专项 **29/29**，均零跳过，两组有重叠不求和；真实发行ESM DOM覆盖连续保存→采用→锁定及原页面快照。SDK源、dist、tar和冻结正式0.1.17 App字节保持；Node发行字节仅嵌入业务版本由19.0.0改为19.0.1。边界、格式及diff检查通过，不声明原全宿主UI套件通过。

发行包位于 `output/extensions/installable-plugins/short-drama-assets-warm-confirmation-20261006/short-drama/19.0.1`，摘要 `sha256:dd7176bd1362ab1761c638b9808a6caf15e64f738b6fc46eb1ed4dcbd69f9d55`。证明位于 `output/extensions/checks/project-assets-warm-confirmation-20261006/`。首次仓外安装被父workspace接管、导致缺node_modules的构建失败已保留；明确独立安装后严格构建通过。发行核验初次错误要求Node字节全同，实际唯一差异为内嵌业务版本，已更正并记录。没有启动正式验收App、改用户profile或提交模型/媒体请求；旧安装身份的未确认记录不能由新包身份借用。

当前Comfy四次只读GET均200，T10/D18的26类节点及所需模型枚举存在，两份图与原快照相同；T10正向143、空负向133已按原采样器连线核对。核心LoadImage支持显式output注解，为同服务复用提供待验证路径；D18自定义节点部署来源未证实。下一媒体接入需要真实已选参考、目标配置、素材可读性及必要传输记录，不能把静态节点检查当作生成验收。完整目标继续ACTIVE，积分后置。

## 2026-10-06：Short19 共享资产与原 Agent 资产阶段

一个短剧包新增角色、场景、道具设定与参考候选，手动页和原 Agent 对话共用真实资产记录。候选不自动选用；锁定保留当前选用但允许继续探索。来源冻结需求及可选剧本修订，服务器检查剧本对大纲的实际依赖。概念参考只提交真实当前选择的 locator，由服务器解析并验证原图像结果；没有真正验证器时拒绝参考写入。

原 Composer 在真正具备新能力的项目会话增加资产阶段，沿原 Turn/Run/Worker/Node 保存候选，支持原流式展示和受理后的只读恢复。独立 stage marker 与五项可选服务不扩张旧四阶段、SDK0.1.0或文字计划权限。真实项目写PDP在报价前、报价后和最终事务内检查。新业务清单 v1最多24工具，保留原15工具并新增6个；v0仍最多16个，混合版本拒绝。详见[资产协议](./plugin-project-assets-protocol.md)。

独立冻结SDK包构建/UI与Node严格类型及完整portable **241/241**，含新页面DOM快照、手动候选、锁定、原请求冷恢复和原界面兼容。真实 Store新 **26/26**、旧 **97/97**；公开/兼容 **95/95**；Production **28/28**及真正HTTPS/PG单连接冷journal **1/1**；Worker/Application **41/41**、Main **46/46**；原host Composer/恢复 **27/27**；真实Control HTTP两库 **8/8**，均零skip，各组有重叠，不求和。

最终独立19包经真实安装→原TaskCore→Kernel/Worker→实际Node→Store双库 **2/2**，包含真实报价等待期撤项目写权限拒Run/资金预留、恢复同原请求、真实候选COMMIT后丢Tool回执、Worker/Node关闭后需求变更和原键冷恢复、保持唯一候选及原Run/源摘要、流式delta与持久事件游标重连。这是具名模型/服务夹具，不是用户模型推理或公网供应商调用；事件游标验证不冒充实际HTTP SSE全链路。

独立包在 `output/extensions/installable-plugins/short-drama-assets-20261006/short-drama/19.0.0`，真实摘要 `sha256:df11183ff0f7606bdb8ea692a80b6ec76f422d9b38c10fb924fe9ec53bd2792b`。证据在 `output/extensions/checks/project-assets-20261006/`。UI/Electron lint、六层package类型、Control/Worker类型、UI build、boundary、format通过；宿主未改全局CSS。一次误用 `pnpm test --` 执行全UI，结果41失败、4517通过、51跳过，保留为未通过检查，不声明全UI绿。正式桌面19包联合验收尚待实施，用户现有App/Profile和未知Krea operation未改；T10/D18素材输入、分镜、视频、声音和成片仍在后续范围。目标保持ACTIVE。

## 2026-10-06：Short18 原聊天项目建议与历史生图查询

原普通 Agent 聊天增加服务器提供的能力发现及项目建议工具，不创建另一套聊天或模型运行时。实际 Main 批准的当前插件来源、普通 Run/Thread/claim 及安装状态决定工具是否可用。建议保存在原工具完成事件中，经原 GET、SSE 和 Last-Event-ID 重连读取；完整输出有独立 8 KiB 上限。卡片核对真实 Run、Thread 和 call，仅由用户点击打开确切安装模块。查看建议只预填需求；明确保存后仅为该项目预填文字计划，仍需选择真实项目对话并确认开始。取消后手动新项目不继承旧建议。

独立 `crewon.project-planning-drafts@1` 与 `crewon.project-historical-queries@1` 都是显式可选服务；冻结 SDK0.1.0、原导航、账户、全局 CSS 和旧恢复协议不变。历史查询由服务器从原 generation/Run/admission/operation/配置解析完整旧目标，Main 另批准 GET-only 历史查询。新 namespace 不借旧六类动作资格；新旧查询未知时互斥，同键重试保留原正文，新的 UI intent 明确限当前会话。缺少历史目标不阻断基础聊天或同包文字服务。协议见[原聊天项目建议](./plugin-project-planning-protocol.md)。

原普通 Kernel、SQLite、真实 Control HTTP/SSE 与冷读取及实际 Main bootstrap/Native metadata 专项，新旧 **33/33**；独立最终候选包 **229/229**，Contracts **510/510**，原 command 布局与新建议 UI **145/145**，均零跳过。UI build/lint、边界、格式通过；编译的四份 CSS 与实际桌面0.1.15逐字节一致。全 UI 没有声明通过；一次误执行的无筛选 UI 检查已中断，其已有架构基线失败另记在私有证据中。

独立历史查询 Domain **3/3**、Application新旧 **35/35**、Host **26/26**、Store新旧 **84/84**、Control顺序 **96/96**，以及真实冻结 Krea1→实际 HTTP→原 Worker queryHost/Node/Kernel 双库 **2/2**，均零跳过。组间有重复，不相加。真实双库检查损坏/缺失历史 marker、原键重放、旧协议兼容及单连接事务，实际查询不增加生成 POST、资金预留或工作流提交。身份、模型和供应商是具名夹具，物理 peer HTTP 的 handler 属测试所有者；未以此声称正式 LoadedRelease/Main/公网 S0 完成。原自有 PG52349 已正常退出并清理。

真实 Main/Settings 新旧 **97/97**、Native parser **8/8**、独立历史 UI 与原 query/recovery/mount/account兼容 **186/186**，均零跳过。普通插件未声明或历史目标缺失时保持原基础行为。

正式0.1.16包已由冻结源码 `f4b8e5ff6` 构建，asar 摘要为 `58d69d3d12f69d686606274b8beef2d9503fdf9157d267c25339b23984f711d4`，四份编译 CSS 与原0.1.15相同。独立模块 CUA 已核建议预填、取消无写入、历史查询未知时仅原键重试，以及真实640宽/520高和深色布局；这类夹具不代替实际 Main 授权验收。

隔离的正式桌面 CUA 已通过原账号入口、Settings 导入/安装/配置/准备/启用18，以及真实项目、需求、项目对话及工作空间绑定。没有旧 Krea 目标时，Main 正确只准备工作台自身能力，不授予历史查询。手动大纲保存/采用/锁定与第一集剧本保存/采用共五次命令已持久，剧本尚未锁定；模型、媒体和新 Run 为0。正常退出后完整备份并冷启动同一资料，项目与会话读取保持。验收脚本曾错误要求两份文稿都已锁定，原失败日志保留并明确是断言范围错误，未补写业务状态。

初始正式包验收同时复现了目录刷新失败后模块自动退回原对话的问题，因此该包未通过导航或冷重开视觉验收。源码已定位“目录刷新错误撤目录→清选中模块”的路径，实际错误码尚未确认。修复将导航保留与当前调用授权分离，失败时撤真实挂载和调用、在模块位置显示不可用；有效删除/停用、身份或会话范围变化仍撤回导航。真实用户App/Profile和原未知 Krea operation 本阶段保持原样。完整目标继续 ACTIVE。

导航修复随后提交为 `2608e68c1`，相关18个测试套件 **169/169**、Renderer/Electron严格类型、UI build/lint、边界、格式通过；正常目录的 DOM 及原四份编译 CSS 保持。旧故障正式 App 完整冻结保留，修复包仍为未发布的0.1.16候选，asar 摘要 `17c23a9ea3980cd9dbd5da5f4cbdc48719a60fd3d29603a0577c79e97e4db51e`，短剧18包不重写。

修复包从同一真实自有资料的完整备份冷启动，不重装或补写业务状态。CUA 实际读回已采用并锁定的大纲、已采用但未锁定的第一集剧本及确切台词/来源，保存了含原侧栏和工作空间会话的实际截图；间隔20,956ms的两个样本均保持原模块和成果，整个查看期间未再自动退回对话。真实 Main 会话通过原 Control 客户端连续三次只读目录，均1页HTTP200、严格校验成功且确切18摘要一致，耗时137.2/120.9/169.2ms，业务命令数量不增。这不解释旧错误类型，也不代替历史目标可用时的正式批准、真实 Agent 推理、供应商生成或完整成片验收。

## 2026-10-06：Short17 有界持久文字计划

原插件概览增加文字执行计划，用户选择实际关联对话、起点/终点、集数及手动或自动选用。原大纲/剧本编辑页继续采用和锁定同一份成果；默认保存候选后等待明确采用与继续。自动模式仅在来源、选用、head和锁定均未变化时采用本步骤确切成果。最多16集、18步骤、并发1。已准入任务与输入不重写，暂停/修改剩余计划、停止和冷重开均使用服务端实际计划。

独立 `crewon.project-text-plans@1` 提供八种有界动作，真实 UI invocation 产生独立计划委托。Native 每次派发仍核当前 Main 准备、完整安装来源和真实请求 owner，沿原 TaskCore/Run/Worker/Node 工具执行；原 Control 扫描及 outbox 观察实际结果和终态。Remote 未显式提供委托能力时明确暂停。原 SDK、导航、左右栏、用户栏及全局 CSS 不变。详见[文字计划协议](./plugin-project-text-plans-protocol.md)。

实际已安装最终17包、真实 Native 私有身份与原 Core 验证 **1/1**：同键及冷重开保持唯一 Run；实际 Control→Worker→安装 Node→Tool/业务提交→终态→冷重开连续产出大纲和两集剧本 **1/1**，验证原 HTTP Run、SSE/Last-Event-ID重连与固定原回执。模型为明确无网络 transport，不等同实际用户模型或供应商验收。新旧 UI 外置冻结 SDK 严格构建及 **216/216**，Contracts **499/499**，原 Control Runtime **37/37**，组合 **20/20**，桌面批准 **9/9**。各组覆盖有重叠，不相加。

真实双库 Store 新计划 **40/40**、原兼容 **90/90**；Core **41/41**、实际双库单连接生命周期 **10/10**；Application独立owner兼容 **39/39**、Worker新旧 **47/47**。这些已完成检查均零跳过，类型、边界、UI lint、格式和 diff 通过。真实 Chrome 验证宽/窄/低高度/深色及同键重试与冷只读五种场景，页面数据是明确 public DTO 夹具。旧回执或迟到读取不会回退当前 revision；已证明未提交的来源/关联/剩余范围冲突允许刷新后重新确认。手动编辑保留，不被剩余默认值刷新覆盖。

最终17包位于 `output/extensions/installable-plugins/short-drama-text-plans-20261006/short-drama/17.0.0`，摘要 `sha256:e4e4d30ba054df0dc9a41d8abcbd9183a149c02efabedd8ee387f5df1d807f2b`；专项证明位于 `output/extensions/checks/project-text-plan-20261006/` 和 `project-text-plan-stage-20261006/`。新计划未增加本地 intent journal，不能声称任意未确认本地写入跨 App 重启自动恢复。自有应用、Worker/Node、浏览器、连接池和PG52348已正常退出，旧包及原未知 Krea Run/operation 保留。

正式冻结16桌面隔离验收通过原 Settings 安装/配置/准备/启用、文本保存/采用/锁定、实际项目对话与两次冷重开；模型/媒体请求为0。实际用户App从0.1.14正常升级到0.1.15前，对完整userdata和旧App做离线字节/模式/符号链接校验备份。保留Short11/Krea1选择，16仅停用安装；这不代表实际用户已经切到16或17，更不代表在线短剧已完成。接下来先处理原普通对话的项目/计划确认入口与历史查询兼容，再接参考资产、多工作流、分镜、视频、声音和合成；目标继续 ACTIVE。

## 2026-10-06：Short16 项目对话与单阶段 Agent

项目概览增加“与 Agent 创作”，明确创建或进入实际关联 Thread，工作空间来自宿主当前创建选择。原聊天 Composer 增加讨论、需求、大纲、分集剧本的阶段选择和项目刷新；插件正文编辑页保留小型对话入口。两端共用需求、大纲、剧本及历史。没有另建聊天页面或项目数据，原导航、左右栏、账户、设置和全局 CSS 保持原样。

独立公开 `crewon.project-conversations@1` 提供七种有界动作，`crewon.project-context@1` 让真实 Worker 命令读取当前固定范围。继续使用冻结 SDK0.1.0，插件自持 portable 与严格 codec 并固定摘要。真正 Thread/关联/回执、真正 Turn/Run/队列/阶段准入分别在父 Store 的同一个提交连接保存；重试沿原请求返回原 Run 和来源。讨论只读；需求追加当前需求修订；大纲和剧本保存候选，采用与锁定仍由工作台明确操作。阶段 Run 不允许跨项目、自动选用或提交媒体，新范围缺失或损坏不能降级为历史无范围任务。协议和限制见[项目对话说明](./plugin-project-conversations-protocol.md)。

真实已安装最终 Short16 包、原 Kernel/Worker 和两库验证通过：大纲候选写入后丢失工具回执，冷重开沿原任务恢复而不重复保存；流式内容持久化并按原事件游标重读；手动采用和修改剧本后，后续 Run 读取同一项目的新版本。原 Control HTTP 在 Native SQLite 和 Remote PostgreSQL 各验证实际 Node 声明、原 Task/Run/阶段提交、同键重放、原 GET/SSE 与重连。模型为明确无网络夹具；这些检查不等于实际用户模型或在线媒体已验收。

冻结 SDK 仓外严格 UI/Node 编译、独立发行包 **192/192**，真实双库 Store 专项 **25/25**、旧 Store **155/155**；Contracts **479/479**，原 Kernel/阶段/旧收费兼容 **10/10**，Application 新报价兼容 **30/30**，均零跳过。组间有重复，不相加。九种真实 Chrome 场景覆盖项目对话、文字编辑、低高度、窄屏、深色与原文字冷恢复；页面数据是公开 DTO 夹具，浏览器和服务已关闭。最终源码、发行包和各组证明位于 `output/extensions/checks/project-conversation-stage-20261006/`。

Control 实际阶段 HTTP **2/2**、元数据 **2/2**、缺新报价能力拒绝 **1/1**；Renderer/原 Runtime/Setup **168/168**，新旧报价、BFF、客户端及 PluginHost **41/41**，均零跳过。类型、边界、UI lint、格式和 diff 通过。自有应用与连接池全部退出，PG52835 的9个捕获进程、socket、PID文件和自有目录已物理退场。PluginHost 既有类型脚本曾间接重建忽略的 SDK dist；公开 SDK 源码、冻结 tarball 与发行包字节未变，后续使用直接类型检查。该事实与最终宿主源码 SHA 见 `output/extensions/checks/project-conversations-20261006/backend-verification.json`。

最终包为 `crewon.short-drama@16.0.0`，摘要 `sha256:536aed576dd9ac7080ce030e819a8de8d0ca773139ca0e180f05591161608b8c`，位于 `output/extensions/installable-plugins/short-drama-project-conversations-20261006/short-drama/16.0.0`。旧包不改写，原未知 Krea 任务不重新提交。单阶段已接通，跨阶段委托、原普通对话从想法创建项目、角色/分镜/视频/声音/合成和实际 App 联合验收继续实施；积分产品后置，目标保持 ACTIVE。

## 2026-10-06：Short15 已发送文字请求的持久冷恢复

新增独立 `crewon.project-text-recovery@1` 和公开 portable/严格 codec，保留 SDK0.1.0、原十种文字动作及已发行 Short1–14 的字节。宿主显式开启后，四类写入先保存完整原输入与原键；真实业务回执与 accepted journal 在同一 SQLite/PostgreSQL 提交连接原子落库。确定拒绝必须同时证明原回执不存在并建立迟到提交防护；未知响应仍保留 pending。实际普通 HTTP 与已准入 Run/Tool 的同键别名不能读取或写入另一个 UI 来源的保留请求。

重开插件只读取当前项目的一条原请求。pending 恢复完整稿件并等待明确同键重试；accepted 读取确切已保存版本，不重新保存；refused 保留草稿，经明确确认后才能建立新请求。ACK 丢失仍保持业务成功，迟到的旧项目或冲突读取不能覆盖新项目与新版本。未发送草稿不持久保存，停用重启/升级后的新安装选择不自动迁移旧来源 journal。协议与预算见[文字恢复说明](./plugin-project-text-recovery-protocol.md)。

最终检查：Contracts **471/471**、Application **649/649**；新 journal/alias 真实 SQLite 与 PostgreSQL **26/26**、原 Store 兼容 **39/39**、Domain **3/3**；Control/Native 原 HTTP **78/78**、桌面批准 **7/7**；独立发行包 **177/177**，均零跳过。各组范围有重叠，不相加。仓外冻结 SDK 严格 UI/Node 编译、完整 UI lint、边界和格式通过。自有数据库、应用与连接池已关闭，PG55483 全部捕获进程和自有目录已物理退场。最终证据位于 `output/extensions/checks/project-text-recovery-20261006/`，双库证明另见 `project-text-ui-intent-store-proof-20261006.json`。

本轮只完成文字协作恢复，不代表实际桌面或在线生图已验收；原用户 App/profile、网络与原未知 Krea Run/operation 未修改。继续接通原对话页的项目绑定与每轮真实 Agent 准入，随后推进资产、分镜、视频、声音和合成；积分后置，目标保持 ACTIVE。

## 2026-10-05：Short14 手动文字工作台与独立 UI 文本协议

Short14 在原插件模块内接通“大纲”和“剧本”：手动编辑结构化正文、保存候选、分页历史、打开旧内容、明确采用、锁定/解锁，并读取当前真实需求和已采用大纲作为来源。保存不自动采用；上游需求或大纲采用变化时保留正文和原引用，由共享服务返回过期原因。使用新来源须明确保存新候选，版本冲突保留草稿并先读取当前状态。原宿主导航、账户入口、左右栏和全局 CSS 未改，新增样式仅限定在插件自己的模块节点。

新增独立 `crewon.project-texts@1`，十个动作通过原 UI invocation 调用；公开入口 `@crewon/contracts/project-texts-ui` 提供无 import portable 文件和严格 public codec，示例携带字节一致副本与预构建 codec，构建固定 SHA-256。原 SDK0.1.0 tarball 与 v1 形状保持冻结，不借宿主私有源码。详见[插件 UI 文本协议](./plugin-project-texts-ui-protocol.md)。新动作输入和响应最多60 KiB，旧动作/未知版本仍24 KiB；长历史只裁整条记录并保留确切继续游标。

四类写入由实际 UI invocation WeakMap 签发独立 textUi 事务资格，核完整主体、八字段安装身份、原 action/input、真实 selection/package 和当前项目权限。复制调用对象、旧六动作资格或伪造 Run 不能授权文本写入。SQLite 在同步写事务最后复核当前资格与安装；PostgreSQL 同一个提交连接锁住实际安装选择，事务外部 PDP/配置档回调不重借池。真实 COMMIT 回执可在迟到关闭后返回，普通读取与重放仍要求当前权限。手动编辑不进入 Node peer，也不创建 Run、资金记录、外部 operation 或供应商请求。

未知文本写入在同一次挂载保留原输入与原键，只由明确“重试原请求”重放；已确认写入不会因随后读取失败而退回未知。已确认历史和显式同键复播已做冷重开验证。**未完成文本 intent journal 尚未接入持久冷恢复**，不能用这些已确认数据的读取证明未确认请求或未保存草稿能跨应用重启恢复。

本轮检查：Contracts全量 **462/462**、新 owner/旧调用链 **76/76**；真实双库 text 资格 **15/15**、旧 Application **33/33**、旧 Store **74/74**；Control/Native 组合 **120/120**、production PostgreSQL `maxPoolSize:1` 原 HTTP **1/1**、审批/Loader UI **31/31**，均零跳过。各组有重叠，不求和。类型、边界、格式通过；独立 Short14 使用冻结 SDK tarball 严格编译和构建已通过，独立发行包全套 **166/166、零跳过**（原155项、新8项 DOM 与3项 controller 专项）。证据位于 `output/extensions/checks/project-text-ui-20261005/`。

四个视口已用真实 Chrome 捕获并退出；页面数据来自明确的公共 DTO fixture，只证明发行包 DOM/布局，不提供生产身份、SQL 或实际模型证明。Control/SQLite/PG 的安装、挂载、十方法、四写、同键与冷读取另由真实实现验证；所有自有应用、连接池和 TLS 夹具已关闭。实际用户 App/profile、网络和原未知 Krea Run/operation 未改。

本轮是手动文字协作里程碑，不是完整交付。后续继续持久文本 intent 恢复、项目对话/工作空间绑定、真正的阶段 Agent 启动与委托、角色/分镜/视频/声音/合成工作流，以及正式打包与实际桌面验收。积分后置，目标保持 ACTIVE。

## 2026-10-05：真实 Agent 项目工具与 Short13 同包执行

新增独立 `crewon.project-tools@1` 服务，Short13 同包提供项目/需求、大纲、剧本、历史、分段正文、采用和锁定12个工具，保留原 Krea2 两预设。公开协议是无宿主实现依赖的单文件，示例在仓外用原 SDK0.1.0 tarball独立严格编译和打包；SDK v1、原 Short12 和宿主/短剧 UI源码保持不变。协议见[项目工具说明](./plugin-project-tools-protocol.md)。

Node setup只获得服务对象，业务调用必须是当前Worker真实派发的命令对象、signal和租约；模型不能提供actor或幂等键。主体现查实际Run创建者；每次检查当前项目权限、原准入和确切包/工具，写事务在实际SQLite/PG提交连接核真实Run、Tool receipt/inputDigest/actionDigest、step/attempt/currentclaim、配置/目标与完整安装选择。旧UI六动作资格不扩权。撤回后拒绝新调用，关闭等待在途业务实际退出。

保存只回显头与修订元数据；正文按确切不可变修订和摘要，每页1024 Unicode码点读取。结果包括resultJson包装最多8192 UTF-8字节。冷取消不把无法证明未写入的操作报成取消成功；项目与媒体结果轮转扫描，limit1也不饿死旧媒体回执。

真实已安装 Short13 + 原Kernel + Worker + SQLite/隔离PG集成 **4/4、零跳过**：用户想法→项目需求→大纲候选/采用→剧本候选/采用→读取正文；手动业务命令改台词并采用后，重开Worker的新Run读到同一新版本；流式delta实际持久化，按事件游标重读；真实COMMIT后丢Tool回执并关闭Worker，冷重开沿同一原receipt/newclaim恢复，只有一个项目/需求版本。模型为明确无网络测试夹具，Run/Node包/资格/派发/数据库与恢复均是真实实现，不代表供应商或实际用户对话已经验收。

最终检查：独立 Short13 **155/155**；新旧 Application 组合 **58/58**、真实双库 Store **74/74**、Worker owner **20/20**、原派发/I/O兼容 **31/31**、Worker组合与旧执行链 **82/82**、PluginHost **56/56**；Control公开路由 **24/24**；Contracts全量 **454/454**。这些组含重复覆盖，不叠加成独立测试总数。所有列出测试零跳过；Application、Store、Contracts、Worker、Control与PluginHost类型检查、边界、生成契约和格式通过。证据位于 `output/extensions/checks/project-tools-agent-20261005/`；仅为本次测试新建的PG实例已物理停止并删除自有数据。1,344个原SDK/宿主UI/短剧UI源文件相对前一已验收提交保持字节一致；原Short12浏览器包与Short13除三条SDK安装路径注释外全部字节相同。

本轮首期服务只为真实已获准的插件任务Run启用；普通聊天admission=null分支维持原行为。Node已声明`project.execute`任务动作，但原对话能力发现、项目绑定/启动入口和工作台大纲/剧本编辑页仍需下一阶段接入。阶段计划/委托、角色设定、分镜、视频、声音、合成也仍在方案范围内，不能用一次生图或工具集成冒称全链路交付。实际App/profile没有替换，也没有触发媒体或模型网络请求。目标继续进行。

## 2026-10-05：共享大纲与分集剧本底座

新增独立的 `ProjectTextApplicationService`、不可变内容修订、成果头 CAS、独立选用和锁定。大纲与每集剧本拥有稳定身份；保存候选不会自动换掉选用版本。剧本可以引用确切大纲修订，也可以以 `outline: null` 导入已有剧本。需求或大纲选择变化时保留旧成果，并在读取中明确返回过期原因。协议细节见[共享成果协议](./project-text-artifact-protocol.md)。

SQLite 与 PostgreSQL 适配器借用实际父 Store 的连接及生命周期，使用独立文本表与回执账本。PostgreSQL 与原项目归档/需求写入共用项目锁，单连接事务不再次借池；SQLite 写事务保持同步。写入前复核实际所有权、归档状态、确切需求/大纲依赖与成果修订；撤权检查在事务提交前生效，确认提交后不因迟到撤回把结果改报为未提交。

新增十条 Control 路由、严格 DTO、专用客户端和原 BFF 有界运输，全部使用原身份与项目权限链。组合配置只有显式提供 `textArtifacts: { version: "crewon.project-text.v1" }` 才迁移并注册；旧配置不隐式启用。实体按 `/text-artifacts/items/:artifactId` 定位，避免成果 ID 与逻辑 `outline`/`scripts` 路由冲突。历史分页只裁剪完整记录，使用实际最后返回修订继续读取。

真实 SQLite/隔离 PostgreSQL 18 流程测试 **6/6、零跳过**：三集大纲→首集剧本→手动改对白→选用→旧 CAS 拒绝覆盖→探索候选→上游变化标过期→锁定→关闭重开保存历史；同键并发两个服务只得到一个持久身份。双库 Store 专项 **16/16、零跳过**，覆盖真实归档锁等待、事务回滚、腐败拒绝和丢失回执恢复。模型内容由明确测试数据提供，这些不是实际 Agent 或真实模型创作验收。

原宿主 UI、SDK v1、Krea 和 Short12 包保持未改。63 个原 SDK/Krea/全局样式文件和 33 个短剧 UI 文件摘要一致；原 OpenAPI 的 85 条路径、256 个 schema 及其他既有定义逐项保持相同。新阶段服务明确拒绝旧 UI 六类动作的事务资格，不能借用旧 invocation 或伪造 Run 准入。验证记录保存在 `output/extensions/checks/project-text-foundation-20261005/`。

最终检查：新增专项 **76/76**、原项目/概念选择回归 **185/185**，均零跳过；Contracts 全量 **453/453**、客户端全量 **199/199**、BFF 全量 **70/70**。七个受影响包/应用类型检查、生成契约、仓库边界和格式检查通过。没有重跑全 UI 或全运行时测试；本轮没有 UI 或 Agent 行为变更，也没有把这些检查扩写为完整产品验收。

**下一步是实际入口接线。** 通过新的具名宿主服务和真实 Run/工具调用身份，让 Agent 读取项目、保存大纲/剧本，并让插件工作台手动编辑、比较、选用和锁定同一数据。当前没有发布新版文本 Agent、修改默认 Agent、重建 Short12 或更新实际 App；完整的“用户想法→Agent 创作→手动修改→Agent 继续”仍未验收。

## 2026-10-05：统一短剧包与原 Settings 执行准备

参考 [shuohao-skills](https://github.com/eternityspring/shuohao-skills) 和 [Reelbench](https://reelbench.79px.com/)，创作阶段继续按大纲、角色/美术/剧本、分镜组织；各阶段产物归入同一个短剧项目。`crewon.short-drama` 12.0.0 已将原 UI 与 T01 Krea2 生图、T04 三视图执行适配器合并为一个可安装包，未新增独立预设插件。大纲、锚点派生、分镜、视频和配音仍是后续产品阶段，不能由 T04 文本三视图推断人物一致性已经实现。

接线审计发现 Settings 原来只有导入、安装、保存配置和启用选择，执行依赖预写的私有 policy，项目执行审批 helper 没有生产调用。现在在原参数面板增加明确的本机执行准备：Main 读取确切安装包和已保存配置，展示服务地址及四类受控请求；用户确认后，沿原 Supervisor 队列两次物理停止、准备和重启，追加私有执行策略，再用真实 prepared entry 组合同包项目 v3 映射。最后按新 epoch 的完整包、配置和 target 核验准备结果。保存参数、Node 来源信任均不能隐式授予执行或网络权限。

原启用选择保持，准备不创建生成任务；已启用的选择仍由原启动恢复逻辑处理。两阶段的提交事实分别保存，重启失败返回需要重启，不把政策提交解释为执行就绪。原 Settings 自身重挂通过有界 Main 回执和公共票据恢复；外部会话变化撤回旧票据，未知结果只读取原状态，不再次确认。旧 Web/旧 preload 缺少新可选能力时保持原页面，所有原 CSS 和短剧包 UI 不变。

本次准备入口暂只支持已核验的 `example.publisher` / `crewon.short-drama` 12.0.0 同包协议。已有 Krea 策略、网络授权及项目映射逐项保留；已有 Short 服务地址授权冲突时拒绝替换，不能借新的准备修改旧请求绑定。通用安装、服务和 Node action 协议继续保留，任意第三方能力的授权产品入口仍需按其真实声明扩展。用户桌面安装尚未替换，积分继续后置；本机准备不证明供应商连通或在线 S0 已完成。

最终相关 Host/IPC/设置/旧桥组合 **15 文件、172/172、零跳过**，类型、UI/Host 构建、format 与 boundary 通过。正式编译 Main/preload/file 页面、实际 Native/Control/Worker 和独立 userData 验收 **1/1、零跳过**：初始只有 metadata-v2 且无 policy，从原用户栏进入设置，安装停用的真实 Short12，保存参数 revision 1，提前发生真实 owner 通知后再预览与明确许可，沿原流程两次物理停止/启动，返回完整核验的 prepared/ready/mappingCommitted 回执。来源下线后实际冷重开仍读取同一安装/配置/policy/v3，内存回执为 null，不制造旧成功。全部自有进程已物理退场，无强制遗留；5 张桌面、低高度、窄宽和暖/冷截图确认原设置布局及可滚动到主要动作，无横向溢出。

证据位于 `output/extensions/checks/short-drama-native-execution-setup-20261005/native-execution-setup-proof.json` 及同目录退场 JSON/PNG。SQLite 保持 disabled、selection revision 1，activation/Run/任务/生成/operation 全零；只允许本地具名模型目录 GET（5 次），无模型 POST，生成地址为 `.invalid`，未调用供应商。这是正式源码 Main 的隔离验收，不等同已安装的用户 `.app`、启用后的完整生图或在线 S0。真实用户 App 仍为 0.1.14。

专项前两次发现合法 `credentialKind:none` 启动接线缺失：Main 不应声明必须含密钥的 private probe，且应按现有协议显式产生 `CREWON_MODEL_CREDENTIAL_REQUIRED=0`。现只修 Main producer，原 Worker/Control 校验不放宽。随后两次失败来自新 DOM driver 误用共用 class 选中来源导入区；依据真实按钮 label/disabled 诊断限定「插件管理」区后通过，未改产品按钮或延长超时。历史失败证据保留，不以它代替最终成功。

全量 UI 已运行：**4,406 通过、26 失败、51 跳过**，不能称全量绿色。8 个来源权限断言受本轮 shell umask 077 影响，022 窄跑 **63/63**；soak 的五秒并行超时窄跑 **4/4**。其余17个在提交版源码中已存在：11个 UI/Thread 行为失败以隔离 `git archive HEAD` 同例复现，设置积分GET/架构扫描2项旧失配，以及旧 Native执行/升级/业务流4项以完整隔离 HEAD 同例复现。未删除测试、改快照或放宽断言；旧严格 Thread schema 的 workspaceId 兼容问题及其他基线失败仍需单独修复。范围分别记录于 `native-execution-setup-narrow-final-20261005.log`、`native-execution-setup-ui-full-20261005.log`、`native-execution-setup-ui-baseline-comparison-20261005.json` 和 `native-execution-setup-failure-classification-20261005.json`，各专项有重叠，不求和。

## 2026-10-05：SSH 服务核验与既有代理的原任务读取

用户提供 SSH 连接信息及双 `u` 地址后，已实际登录其 ComfyUI 实例，只读确认原服务在 `127.0.0.1:6006` 运行，版本为 0.38.0。原单 `u` 地址 `https://u564342-7908818e1ac4.westd.seetacloud.com:8443/` 的 `/system_stats` 返回真实 ComfyUI JSON；新双 `u` 地址虽返回 200，但内容是 HTML，不能作为 ComfyUI JSON API。保留原 config1 的单 `u` canonical URL，没有改旧 Run 的不可变配置或 prepared target。证据 `comfy-ssh-readonly-verification-20261005.json`；SSH 已正常退出，任务未保存用户密码。

本机现有 `127.0.0.1:7890` 代理下，原单 `u` 地址的 health、确切 `/history/4263a1da-d6fe-eac4-aaec-f05a1e4f7485` 及 `/queue` 均可读取 JSON，HTTPS 证书及主机名验证保持，没有跟随重定向。原任务在当前历史中未找到，运行与待执行队列均为空；SSH 服务本地查询和本机代理查询一致。这不是“历史上从未提交”的证明，不据此再次生图、补写 provider ID 或变更原 operation。代理读取证据 `comfy-existing-proxy-original-read-20261005.json`。

实际用户库随后只读核对 `native-original-readonly-after-ssh-20261005-2026-10-05T08-43-56-799Z.json`：原 Run 仍 reconciling，唯一 operation 仍 submitting、providerOperationId 为 null、结果为空，query/selection/result link 均为零；config1 地址仍与原绑定精确一致。现有 Krea 包在已保留 operation 下只会按原 correlation UUID GET 历史与队列，匹配后经原 CAS 恢复，不再次获得 POST capability。更改最新配置只创建新 revision，不能重定向原 Run；不以改地址绕过原配置/target 绑定。

上述新证据证明服务可用及既有代理的只读接口连通，没有把代理接入生产插件 transport，也没有修改本机 DNS、系统代理、TLS 或私有地址策略。此前连接方式选择已结合这些实测结果明确为「使用本机现有系统代理」或「为该域名恢复真实 DNS」，仍待用户回答；不把预选项、经过时间或 SSH 凭据视为这项连接方式选择。桌面保持 0.1.14。完整 Native 在线 S0 和第二个实际企业 API 仍未完成，积分继续后置。

## 2026-10-05：插件页面连续使用与 0.1.14 桌面交付

原插件页面持有五分钟绝对租约，GET 权限验证不会续期；此前实际页面显示暂时不可用，但没有捕获其错误码。现在补齐[有限租约续期](./plugin-ui-lease-renewal.md)：新增显式 POST renew，保留原 v1 lease 与只读 GET；同一 actor、profile、epoch、启用选择、包字节、入口和公开资源必须重新核对。只更新原 owner 的期限，每次最多五分钟；关闭、过期、撤权、换包或旧期限冲突不能复活。Native 使用原 Main 会话、frame/sender gate 和 binding，资源地址与权限保持；旧桥缺少可选 renew 时保持原行为。

宿主在剩余一分钟时续期，先排空已经开始的真实操作，再同步更新资源代理、加载器和回执 owner；同一模块实例及 DOM 不重建，不重新导入或 hydrate，也不发送新的生成请求。审查修复了两处问题：撤回后业务入口必须拒绝缺失 owner；原 stage 已派发、等待者取消但 ACK 晚到时，原稳定 owner 仍可受理回执，续期本身不丢失该 ACK。五秒动作预算、原回执与生成幂等规则不变。

最终 Renderer 十文件 **122/122、零跳过**，包含原挂载快照、五分钟后动作、原草稿与迟到 stage 回执；日志 `plugin-ui-renewal-renderer-final-20261005.log`。Contracts **440/440**、Client **192/192**，新 Application/实际 HTTP/BFF 续期组合 **13/13**均零跳过；旧验证保持只读、旧期限 CAS、真实安装字节篡改、外国 owner 与撤权拒绝已覆盖。Native 三文件 **40/40、零跳过**，其中真实隐藏 Electron 专项沿原 preload、IPC 和资源代理访问测试 Control，续期后保持原 root/实例/资源地址，拒绝外国 frame，资源预算归零；`native-plugin-ui-renewal-electron-proof-20261005.json` 明确限定为测试窗口及测试 Control，不代替实际用户完整 App 或在线生图。类型、boundary 与完整桌面 pack 通过；各验证范围不相加。

实际 `/Applications/CrewON.app` 已安装 **0.1.14**。旧 Main/Control 正常退出并物理退场后，完整用户数据约 997M 与旧 0.1.13 App 均私有备份，原 profile 保留原位。`native-ui-renewal-install-20261005.json` 核验实际 asar、构建身份与七个 runtime bundle 与本轮构建一致，四个工作空间 registry 字节保持。独立旧/新 asar 比较确认 **全部四个 CSS 逐字节相同**；Renderer JS、Main/preload 因续期接线有意重建，不宣称整个 asar 相同。正常桌面入口已显示原 admin、四个工作空间及历史会话，进入同一「夜航 · 插件流程验收」后读取原需求 v1、概念输入 v1 与 accepted 回执；没有再次生成或点击供应商查询。

实际完整 App 在同一次进入中连续打开 **330.286 秒**，没有重入或重载，原项目、需求 v1、概念输入 v1、精确提示词和 accepted 回执均保持，没有暂时不可用画面；证据 `native-ui-renewal-continuity-final-20261005.json`、同名 AX 文本和截图。该证据证明实际页面跨过原五分钟期限仍可见；没有读取服务端私有 expiry，也没有向实际页面输入未保存草稿。草稿、DOM 和续期身份的确切语义由上述行为测试及真实 Electron 专项覆盖，不扩写为实际 App 中手工草稿验收。

独立最终实际只读核验 `native-upgrade-0.1.14-readonly-post-20261005-2026-10-04T20-03-25-819Z.json` 确认原 journal 仍 accepted、revision 11、attempt 9，原 ACK 与全部不可变身份保持；原 Run、operation、funding、committed receipt 和 generation link 各一，全局 Run 126，query 0。四个工作空间 registry、六个线程归属、五个 Web 服务及 primary Git 精确保持。原 WorkItem 的 Worker 重试计数自然继续演进，不宣称其可变状态静止。完成后实际 App 留在原任务页，截图 `native-0.1.14-reopened-task-final-20261005.png`。

最后仅 DNS 与原出站策略核对仍得到 `198.18.12.7`、private、`network_egress_denied`，证据 `native-ui-renewal-comfy-dns-20261005.json`；没有 HTTP、模型、供应商请求、策略绕过或网络修改。独立审查确认同一 Fake-IP 阻碍已连续至少三个目标续跑，原 DNS/系统代理选择尚未回复。本轮已授权的续期修复、实际交付与数据保留收尾全部完成，完整目标转为 **BLOCKED**。原 operation 仍 submitting、providerOperationId 为 null，Run reconciling，不能将 accepted 回执解释为外部图片成功。等待明确网络路径后仅核验原 operation、确切图片选用与冷恢复，不再次生成或手改记录；个人积分继续按用户要求后置，E5 第二个实际企业 API 仍待选定。

## 2026-10-05：Native 插件安装与工作空间回退修复

本机桌面已更新为 **0.1.13**，安装的 `app.asar` 和七个 runtime bundle 与 managed 源码构建一致，证据为 `output/extensions/checks/native-invocation-diagnostics-install-20261005.json`。0.1.12 的功能修复安装证据另保留在 `native-generation-funding-install-20261005.json`。两次更新前均正常退出，实际 App 进程物理退场；原安装包与完整 profile 已分别私有备份，原 profile 保留原位。原账号、设置、CSS、SDK、旧发行目录、primary 人类工作及五个用户 Web 服务均保留。实际 Native Settings 已安装并启用独立短剧 11.0.0 和 Krea2 1.0.0；用户提供的新 ComfyUI 地址已保存。项目「夜航 · 插件流程验收」的需求 v1 和概念输入 v1 已从同一实际用户库冷读取。

之前重打包使用的插件分支漏掉了历史工作空间修复 `0d073c3dc`、`98c51b79f`，导致多目录 registry 和会话执行目录回退。现恢复持久 `workspaceId`、v2 多目录配置、侧栏真实归组、首次发送和 Worker 按 Run → Thread → workspaceId 解析目录。实际 profile 从更新前完整备份恢复四个原空间 ID 和目录，六个已有绑定会话全部可解析；未重写旧会话。桌面实测打开 A/B 历史会话会跟随其所属目录，切换时五个运行 PID 保持，证据为 `workspace-binding-native-switch-20261005.json`。两目录实际文件工具/命令执行与重开测试及 source/packaged 进程检查分别提供自动化证据，不能代替真实外部生图。

积分按用户要求后置。本机使用显式 unmetered 准入，原计费路径继续严格校验，不创建钱包、赠款或零金额报价。实际页面准备检查暴露了来源 UI 包与目标执行包的权限用途混用：纯短剧 UI 包被要求具备 Node 提交授权。旧 0.1.10 的独立实际桌面进程复现相同 `project_generation_execution_package_denied`；现改为来源 `read`、目标 `submit`，执行授权仍只覆盖 Krea2。随后修复启用选择却缺失原业务 activation 的 `extension_access_revoked`：Native 启用和冷启动均接原业务激活接口，Source/packaged 各 **3/3**、设置接线 **44/44** 通过。不以空记录放行或手写 SQL 代替产品接线。

真实 0.1.11 页面沿已保存输入受理的唯一生成 Run 为 `R-SYNhSmWFe29SPwW8rHREftDBthKs-yOWffSOsJwr8`，保留唯一 generation/unmetered admission。Worker 无条件读取旧 creditAdmission 的 `extension_json_invalid` 和已提交回执的外层捕获问题均已修复，严格校验恰好一种资金模式，查询禁止新增资金证明。另修复业务 ID producer 与消费协议的偶发冲突：两个任务工厂为新的 32 字节随机 ID 增加固定 alnum 前缀；Worker 与 ActionIntent 仅兼容旧 43 字符首 `-`/`_` Run ID，返回原字节，其他身份规则不变。Source 与最终 packaged 原 HTTP stage/ACK → 实际 Worker beginRunAttempt 各 **1/1**，旧 ID 完整工具执行、错绑定拒绝及资金范围 **42/42**，原 Contracts **438/438**、Tool broker **50/50**；各范围不相加。实际原 receipt 的七项只读解析也通过。这些测试均不发送供应商请求。

0.1.12 实际重开后原 Run 已进入工具调用，持久原 operation 为 `4263a1da-d6fe-eac4-aaec-f05a1e4f7485`，目前 `submitting` revision 1、providerOperationId 为 null，Run 为 `reconciling`。本机系统代理启用 `127.0.0.1:7890`，系统 DNS 把实际 ComfyUI 域名解析为 Fake-IP `198.18.12.7`；原网络策略判为 private 并在 Pinned HTTP 发送前返回 `network_egress_denied`。插件 catch 将内层错误归为 unknownOutcome，持久记录不能证明历史 POST 是否已送达；不据此重新提交或手改 operation。已询问用户选择此域名真实 DNS 或系统代理支持，尚未改用户网络。0.1.12 排查时原请求实际 UI 回执为 UNKNOWN；后续 0.1.13 同键受理与正常冷读取见下文。实际计数仍为原 Run 一份、operation 一份、unmetered admission 一份，尚无 query/selection。原输入、配置、Run、请求均保留；在线原 operation 查询、确切图片选用及结果冷恢复未验收，不能称生图成功。

独立真实 Native 冷回执进程专项 **1/1**：真实 commit 与原 issuer 确认后，仅测试内丢失 ACK，HTTP 500 留下 dispatched journal 和唯一原 receipt；自有进程物理关闭后重新 Main preparation、新 epoch 和新 mount，GET 恢复保留原请求，同键 stage replay/POST action 返回 200，并把 journal 更新为 accepted。Run、receipt、funding 和项目 link 均仍一份，供应商 operation 为零；非 loopback 发送被测试拦截且未触发。此证据没有复现实际页面 UNKNOWN，不代替该页面或在线 S0。日志为 `native-generation-cold-ack-process-20261005.log`。

随后对实际 Native 原请求设置临时、不暂停执行的诊断点，捕获到 journal 的 `AbortError`，并确认 **5 秒 job timer 触发时 sent 与 businessSent 均为 true**。三个原 UI 同键重试后，原 journal 为 dispatched revision 8、attempt 7；原 Run、operation、unmetered admission 和项目 link 各一份，未创建第二个生成任务。临时诊断点、异常暂停及 Console 过滤均已清理，桌面回到原任务页。证据为 `native-original-ack-stage-logpoints-20261005.txt`、`native-original-ack-abort-logpoint-20261005.png` 和 `native-original-ack-live-counts-20261005.json`。这些记录证明页面预算取消了已开始的业务请求，**尚不能判定服务端哪个阶段耗时或实际业务响应是否已返回**。

原冷回执专项只增加既有 HTTP 阶段计时，仍 **1/1、零跳过**：warm generation action 2376.8ms，cold 同键 stage 210.7ms、完整 action 回执 1726.9ms，串行共 1937.6ms，未复现实际页面超过 5 秒。HTTP 20 秒测试预算、故障注入、授权、返回与生产行为均未改变；全部自有 runtime 子进程已物理退出，模型和供应商请求为零。类型、boundary 与格式检查通过，日志为 `native-generation-cold-ack-http-timing-20261005.log`。另以原 Main HTTP transport 与原 Renderer bridge fetch 对自有 loopback 服务只读检查 **7/7**，真实 Node headers/body/EOF 在 1–28ms 完成且预算归零，证据为 `native-desktop-http-eof-readonly-20261005.json`；未经过 Electron IPC 或 Chromium，不能代替实际页面链路。继续按这两种环境的差异定位，不据此增加生产超时。

补充隐藏 Electron 运输专项 **1/1、零跳过**：原 preload、真实 IPC、原 HTTP transport/reply、原 `installDesktopFetch` 的真实 Chromium 全局 fetch delegate 完成四种自有 loopback 响应，包括 JSON GET、自有 JSON POST 的 2244B 模拟 ACK、分片 UTF-8 和空 200。全部读到 EOF，耗时 2.6–43.6ms；POST 模拟 ACK 为 7.5ms。窗口始终未显示或聚焦，Main 和 Renderer 预算归零，所有自有进程、服务和 socket 物理退场，成功临时目录已清理。原 IPC 相关两文件回归 **36/36** 和 Host 类型检查通过；生产代码、实际 profile 和用户窗口未改。证据为 `native-desktop-http-electron-accepted-20261005/electron-http-results.json` 及该目录 retirement 文件。三条 IPC 注册为 test-owned，**未覆盖正式 Main 私有注册、Control 或实际生成请求**，不能据此断言实际超时已修复。遵循既有 Native 专项的显式入口，在 Node 24 下执行 `CREWON_TEST_ELECTRON_HTTP_EOF=1 pnpm --filter @crewon/ui exec vitest run electron/desktopHttp.electron.integration.test.ts`；可将 `CREWON_ELECTRON_HTTP_EOF_EVIDENCE_DIRECTORY` 指向新的自有绝对目录保留证据。默认普通 UI 套件不启动 Electron，默认未执行不计为专项通过。

只读调用链核查确认，同键回放核对原资金、完整 pin 与持久项目后直接返回原 receipt；ACK 对 Run 核对不可变绑定，不因 `submitting` operation 启动新生成或查询。真实 Krea 的 reserve/advance、Run reconciliation 和 Control journal 写事务内均为同步 SQL；供应商网络与异步权限等待在这些事务之间，未发现网络等待期间持有 SQLite 写锁。`busy_timeout=5000` 仍只是争用时的上限，没有实际锁等待证据。当时实际包没有服务端请求阶段日志，不能定位正式 Main/Control 的实际等待阶段；不把隔离测试通过扩为原任务 ACK 或完整在线 S0 验收。

随后实际原 UI 再同键重试一次，journal 为 dispatched revision 9、attempt 8。Renderer 运输 UUID `4ca85f81-e6e6-4061-abb3-39e0e3e40f6d` 的 stage SEND 与 `a638c6fe-275f-445d-af36-1c5f0f98d31c` 的 action SEND 相隔 458.6ms；在保留 Console 消息中筛选确切 action UUID，仅有 SEND，没有 HEADERS 或 READ。同期临时 HEADERS/READ 点能记录其他普通 action 的 200 与 EOF；不能把这些响应作为原生成 ACK。原 Run、operation、funding、committed receipt 和 generation link 仍各一份，未创建 query 或选图。证据为 `native-original-ack-uuid-headers-eof-20261005.txt`、`native-original-generation-readonly-20261005-2026-10-04T19-14-55-860Z.json`。诊断点及过滤已清除；按用户要求正常退出并重新打开实际桌面，回到任务页，截图 `native-desktop-reopened-task-page-20261005.png`。

正式 Main 三条运输 handler 没有额外异步等待，当前 Native 的包与项目权限检查也不等待 Main 弹窗或远端 PDP。实际 Short11 与 Krea 包的单次只读校验分别为 7.578ms 和 2.299ms，证据 `native-installed-package-io-baseline-20261005.json`。这只是当时缓存状态下的单次测量，不是耗时上限，也不排除重复复核或其他步骤。当前继续用默认关闭、显式 `CREWON_PLUGIN_INVOCATION_DIAGNOSTICS=1` 的 Control 阶段诊断定位；只记录安全请求编号、固定阶段、序号与耗时，不记录任意请求、提示词、凭据或错误文本，不改变授权、原请求预算和业务状态。

0.1.13 补充了上述有界诊断：每次生成请求最多 96 条、最多 32 个活动观察 scope，sink 失败或背压后静默停记；请求结束后晚到异步不再输出。生产显式开关与隔离工厂同实现，单元行为 **11/11、零跳过**；原安装/恢复 HTTP 两文件 **24/24**。原真实 Native 冷回执进程专项 **1/1、零跳过**同时验收启用后的 36 个阶段记录归属同一真实 Control PID/requestId，Node prepare、原 task commit、cleanup 和 route 返回均完成；完整冷 action 约 1752ms，模型和供应商发送为零，四个自有 runtime 子进程物理退场。日志 `native-plugin-invocation-diagnostics-unit-final-20261005.log`、`native-generation-invocation-phases-process-20261005.log`。Control 类型、原 UI/Host 构建、boundary、Node 24 格式及完整 pack 通过。

更新后的实际桌面未打开 DevTools，仅开启上述诊断；原 UI 同键重试一次返回 **“生成任务已受理”**。实际 Control PID 55434、请求 `req-4k` 完成 36 条阶段记录，route end 为 **3074.728ms**，原 task 回放完成、Node cleanup 0.266ms。证据 `native-original-generation-phase-trace-20261005.json`、`native-original-generation-phase-retry-ui-20261005.txt` 和 `native-original-generation-ack-accepted-20261005.png`。随后正常退出，诊断启动句柄退出码 0、所有实际 App 进程物理退场，再由正常桌面入口启动，临时开关不再传入；进入同一短剧模块仅冷读取原回执，仍显示已受理且没有重试按钮，证据 `native-original-generation-ack-cold-ui-20261005.txt`。这证明实际原 ACK 与冷读取已成功，不将一次成功解释为此前超时根因已确定，也不改变原 5 秒预算；外部 operation 仍待网络问题解决后核验。

独立实际只读复核 `native-upgrade-0.1.13-readonly-post-final-20261005-2026-10-04T19-31-38-936Z.json` 确认 journal 为 accepted revision 11、attempt 9；同键回执 disposition 为正常 replayed，其余原回执身份字段精确保持。原 generation、Run、operation、funding、committed receipt 和 link 未增加，原输入与绑定不变；四个工作空间、六个线程归属、五个用户 Web 服务及 primary 人类工作均保持。独立实际新旧 asar 比较 `native-0.1.13-shell-preservation-20261005.json` 覆盖页面、全部十二个 Renderer 资产（包括四个 CSS）、Main 与 preload，共十五个文件逐字节相同，missing/added/changed 均为空。

最终只解析实际 ComfyUI 域名并运行原出站策略，仍为 `198.18.12.7`、private、`network_egress_denied`，证据 `native-comfy-dns-egress-final-20261005.json`；没有 HTTP、模型或供应商调用，也没有改网络设置。此阻碍已连续多轮存在，原 DNS/代理选择仍待用户回复。最后检查发现短剧页面随后显示暂时不可用；仅从任务页重新进入即恢复原 accepted 回执与原提交中 operation，没有再次生成。源码的 mount 为绝对五分钟租约，validate 不续期；尚未捕获此次错误码，不能将这张画面定性为到期或超时。该本机模块生命周期问题不经过 ComfyUI，另行核对安全续租方案。实际桌面留在原任务页，截图 `native-0.1.13-reopened-task-final-20261005.png`。

旧预览网页 5730 仍使用原 3210/3211 后端进程，没有重启加载本轮后端修复；实际桌面有自己从当前安装包启动的 Control/Worker。不能以旧网页证明当前桌面绑定或插件执行结果。完整目标继续 ACTIVE，后置个人积分与用户选定的第二个企业 API 仍分别列为后续阶段。

## 2026-10-04：新 ComfyUI 地址与桌面代码同步

用户明确将积分后置，先确认可用，并要求基础功能保持原版一致。新的无鉴权 ComfyUI 地址为 `https://u564342-7908818e1ac4.westd.seetacloud.com:8443/`；实际 `/queue`、`/system_stats` 和工作流节点/模型读取成功。使用用户原 Krea2 API 工作流、明确的单张 1MP 验证输入，真实提交一次 POST，操作 `e90c0ad2-d1ae-4930-bd22-c31040691be3` 经 running 到 succeeded，取得 **768×1368 PNG**。图片与完整回执位于 `output/extensions/checks/comfyui-new-address-live-20261004/`；节点兼容检查为 `comfyui-krea2-new-service-object-info-20261004.json`。这是实际外部 API 流程验证，不冒称正式短剧插件、个人积分或完整 App 生成闭环已经验收。

本机 `/Applications/CrewON.app` 的真实版本原为 **0.1.7**，没有当前源码的完整构建身份。按用户要求，从当前 managed 源码重新构建 **0.1.8**，实际替换本机安装。发现并修复两处打包账号连接问题：Renderer 的相对代理路径在 packaged 页面错误退回本地 8000；新的有界 HTTP bridge 默认只接受 loopback，因此合法原账号服务 HTTPS 请求也被拒绝。现复用同一公开构建配置得到真实账号 backend，Main 仅额外允许该精确 HTTPS origin。其他远端、子域、端口及 URL 凭据继续拒绝，TLS、重定向拒绝及原传输预算保持。构建方式见[桌面交付说明](./desktop-release.md)。

最终实际完整 pack、八文件 **179/179** 回归、Renderer/Host 类型检查、boundary 和仓库格式检查通过。另以原 DesktopHttpTransport 对原账号服务公开 health 进行无凭据 GET，实际返回 200、流读取结束并释放全部预算。最终安装的 app.asar 及七个 Runtime bundle 均与本次生成的安装包字节一致；证据为 `output/extensions/checks/desktop-source-sync-install-current.json`。原包和完整原用户数据均保留在 gitignored 私有备份目录，错误启动阶段的数据也各自保留；最终启动前恢复原完整用户数据。

实际 Native 窗口已恢复原账号和历史会话，账号菜单可进入原十类设置；“工具与扩展”出现真实“选择本机插件目录”入口。原左右栏可打开和折叠，主内容随左栏展开重新占位，没有插件遮罩。最终截图为 `desktop-source-sync-original-shell-20261004.png`、`desktop-source-sync-sidebar-collapsed-20261004.png` 及 `desktop-source-sync-tools-20261004.png`。13 个原账号/设置/左右栏与样式文件、5 个原路由、60 个 SDK 源文件、冻结 SDK tarball、九个原发行包、生产映射、五个用户 Web 服务及 primary 人类工作均通过保留核对。没有改原界面 CSS、导航或基础功能实现。

本机此环境尚未开启插件管理，个人插件积分尚未接通；本轮没有添加信任、安装、启用插件，也没有新增 Agent 任务。桌面源码同步及真实外部 API 恢复已完成；完整插件目标仍有原先剩余工作，积分按用户要求后置，不把本轮验收扩大为完整目标完成。

## 2026-10-04：当前真实接入前置复核

在 `9373c8e8ea17dac4f2a70446e8837f65ce13a837` 当前源码上复核，独立短剧 11 的自动记录读取已经提交；上一目标回合完成实现、实际检查及提交，属于有进展。完整目标仍 ACTIVE。本轮未发现需要新增 Krea2 执行协议的代码缺陷，现有 Worker 已有真实网络授权、固定公开 HTTPS 传输和原 operation 查询；Native 专项的 metadata-only 拒绝是具名测试边界，不能据此声称正式执行缺少实现。

`2026-10-04T08:41:54Z` 重新实际 GET 用户给定 ComfyUI 的首页、`/queue`、`/system_stats`，三个接口均返回 **404**，TLS 校验开启、没有鉴权数据、POST 为零；证据为 `output/extensions/checks/comfyui-original-service-availability-20261004-goal-continuation.json`。当前无法沿该地址完成真实生图及同次完整 App S0；已请用户告知服务恢复或新地址。历史成功与具名图片记录均不替代此次在线状态。

个人积分的下一步是确认真实平台身份服务的部署和 Native 会话协议，然后为积分组件接独立的生产 Control/BFF 客户端。原 Web BFF 可从真实 Identity HttpOnly 会话获得 Control 专用令牌，再由原 Control 服务端验票及 PDP 核验本人；Native 当前 Node fetch 没有这份 Cookie，仍使用固定本机主体。平台 `/sso/client/crewon/token` 和 app-server principal ticket 没有已确认的 Control audience，不能直接挪用。PIM demo 代理校验登录后注入固定 Control 会话，也不是个人积分隔离。不能依靠 UI 的 `user.id`、用户名、JWT 解码或让用户手填 tenant/principal 构造钱包主体。原设置页及本机安装/运行客户端继续保留。

独立积分可以由现有可信服务器配置入账、报价、结算和失败规则，**第三方财务供应商不是用户要求或交付前置**。需要明确的是实际资金与规则的权威配置，测试 100/30/18 不作为生产默认值。E5 还需用户选定的实际企业 API；所有未来插件包、市场、签名公证和更多打包矩阵不追加为原首期门槛。已在会话中询问的积分配置与企业 API 信息仍待回复，不根据沉默生成配置或换票协议。本轮不新增夹具、不改产品代码、不替换用户安装、启动或生产映射，也未修改 primary 的人类工作。

## 2026-10-04：独立短剧 11.0.0 自动跟进原任务记录

在 `bbd0882135e86ae0c9b9041307cb524afddbd87f` 基线上，补齐[生成记录自动更新](./short-drama-generation-observation.md)：当前可见的冻结输入每次读取结束后等待两秒，最多六十次自动读取、墙钟两分钟，单读十秒超时。后台读取保留原图片 DOM，失败清空并停止；隐藏文档、离开输入、撤权或卸载撤回当前读取和定时器。普通窗口必须同时核对原 Run、所有可见 operation 和截断标记才能提前停止；查询回执属于独立 Run，开启完整有限窗口，不由原生成终态冒称查询已完成。重复提示、主题变化和重新可见不延长预算。

真实冷挂载先收到 accepted 查询、后 ready 时，原 #ready 门禁会丢掉观察意图；现无条件保留原回执，恢复确切来源时只兑现一次窗口。审查也确认公开 SDK abort 会提前结束等待，未必结束原 Host invoke；独立插件新增只读适配器，等待每次原 `services.invoke` promise 真正 settle 后再派发下一读，已撤回的排队请求不调用宿主。这个保证止于原 invoke 边界，不能宣称服务器 SQL 或供应商已取消。旧源码切源测试原本允许新读越过未结束的旧 invoke，现加强为等待旧调用、再读取新源且晚到旧图不能覆盖；没有移除迟到结果断言。

实际仓外目录使用冻结 SDK tarball、Node 24 与 pnpm 10 离线安装（ignore-workspace、ignore-scripts），严格 TypeScript 与 11.0.0 构建通过。完整独立套件 **119/119、零跳过**，含新增观察器/实际 UI **24 项**与真实 SDK 读取取消适配器 **7 项**；旧发行 ESM 行为保持，数字具有包含关系，不相加。原 CommandWorkspace 与短剧样式/快照三文件 **63/63**；原 UI build、Renderer/Host lint 和 boundary 通过。原 Control 记录读取 HTTP 单文件 **7/7**另行证明认证 GET，自动 UI action 继续原 invoke 传输，不宣称其底层都是 GET。所有自动生成、查询、选用与任务派发新增为零。

最初在仓内 ignored copy 运行安装被 pnpm 识别成整个 workspace，未安装独立 SDK，因此初次类型构建不计通过；转到真正仓外并显式 ignore-workspace 后严格编译成功，追踪锁文件与原来源保持。适配器接入后全量首次 **118 通过、1 失败**来自旧切源可越过未结束读取的断言；按上述行为加强原测试后最终 **119/119**。包核验首次使用相对目录被原 Host 拒绝，改用绝对目录后通过，没有放宽路径或格式校验。

新只读发行目录为 `output/extensions/installable-plugins/record-watch-ui11-short-drama-20261004/short-drama/11.0.0`。实际原 Host 文件核验八文件共 **2,212,346 字节**，packageDigest **sha256:45387d8661d6ffd40e4144d8dd8f4bea5d0bde419aa67b5f766cca619a8d1717**。旧 10.0.0 等九个发行包、60 个 SDK 源文件和冻结 tarball、原账户/设置/侧栏 CSS、0600 生产映射及五个用户服务保持；新包没有替换用户安装选择、批准、生产映射或启动配置。正式 Renderer 按原必需检查重建，不宣称旧构建资产字节保持。

真实浏览器加载新发行 ESM，未点击刷新，三条实际只读记录约每两秒自然从 queued/queued、running/running 到 completed/succeeded，终态后停止。第一次夹具漏传主题变量导致样式不完整；保留初次三条计时证据，从原设置页只读取得完整主题并按原 appearance.css 补充暗色 accent-ink 后，用同份已完成记录重挂补齐样式截图，新增第四次记录读取，不重置任务进度。具名元数据 SHA 保持，任务写入、供应商、财务和数据库写入新增均零，images 为零，不冒充图片下载。两次自有服务 PID95411/96830 均原 stop 后物理退出，54999 端口拒绝连接；最终证据为 `output/extensions/checks/short-drama-observation-browser-20261004/retired-proof.json`。原用户标签仍保持原 Settings，临时页已关闭。

本轮记录和图片引用检查使用具名夹具；浏览器实际新发行 ESM 的范围仅为原局部样式及有限自然状态刷新，不代表真实供应商图片。没有用户 ComfyUI 请求、生产充值、扣费或新部署。真实平台个人积分绑定/资金/价格/失败规则、Native Krea2 公网生成与当前原完整 App 在线 S0、用户选定实际企业 API 的 E5 仍未完成；所有未来插件包、市场与签名公证不追加为原首期前置。完整目标 ACTIVE。

## 2026-10-04：原设置中的独立插件积分查询

在 `93f4e811dbfb01ca4e378102771d748100de6984` 基线上接通[只读积分查询](./plugin-credit-read-settings.md)：原账本的本人账户/流水分页、独立 `pluginCredit:read` 权威、两条只读 HTTP 路由、原 BFF/认证客户端和「工具与扩展」卡片。读取不迁移、建账户或赠送积分；未配置与空账户分开，未知账户返回 404。所有金额为精确字符串，返回不包含身份、拨款或预占内部引用。

生产 Main 沿用真实 PDP，旧组合配置缺少新授权时只拒绝新积分读取；Standalone 保留原固定主体。独立审查发现 Native 固定本机会话不是平台个人账户，页面已明确标注本机账本与个人积分尚未接通；真实身份绑定仍未完成。原用户栏、设置导航、CommandWorkspace、左右侧栏与全局样式没有改造。

原双库写入/lifecycle与新读页验证 **50/50**、新 Application **14/14**、新 Contracts **11/11** 均零跳过通过；实际 HTTP+认证客户端核验真实入账/预留/结算后的精确金额与三条流水，读取前后账本保持。最终原 UI 七文件 **103/103**、Client 三文件 **30/30**、BFF 两文件 **25/25** 均零跳过；Control 五文件 **28 项通过、1 项原 PostgreSQL 冷管理测试因缺少该测试环境跳过**，没有把跳过计为通过。各组合按实际范围记录，不相加。UI 曾因 `pnpm test --` 误跑全量，已对本次 Vitest 主进程发送 SIGINT 并确认退出码 130；全量结果不计通过，随后使用 `pnpm exec vitest run` 按文件精确重跑。首轮 build/lint 的新增测试用了不存在的 general section，修为原 environment 后 UI 构建、Renderer/Host lint、Control/BFF 类型、boundary、源码格式和仓库格式均通过；没有修改产品来规避检查。

真实只读 Web 页面验收以 `output/extensions/checks/plugin-credit-ui-acceptance-20261004/acceptance-final.json` 为准：原常规/外观/工具导航往返，原外观工厂使用具名内存偏好，未写用户偏好。真实 SQLite 具名 grant100、reserve30、settle18 后显示 **82/0/18/100**，三条流水与预留修订的历史 **70/30** 分开；11 个实际 Fastify 请求全为 GET，其中五次积分读取均 200/no-store、十次政策检查。完整账本在读取前后及关闭后严格一致；DOM 证据不冒充完整浏览器网络统计。其它未部署的插件目录/偏好服务保持真实不可用，不伪造成功。

自有测试 PID79400、65478/65480 监听和 SQLite 消费者均已退出，专用 PG 也已物理退役并清理。保留核验 `plugin-credit-preservation-final-20261004.json` 确认 13 个原 UI/CSS 文件、五个原设置/App 路由、60 个 SDK 文件及冻结包、九个原发行插件、0600 生产映射、五个用户服务与 primary Git 工作状态保持。正式 Renderer 为新能力有意重建，不宣称旧构建资产字节不变。原用户标签仍保持设置页。

本轮只使用具名测试身份和资金，没有生产充值、扣费或请求用户 ComfyUI。真实个人身份/入账/价格/失败结算、Native Krea2 公网生成/原 operation 查询、同次原完整 App 在线 S0、全部插件打包链路及用户指定实际企业 API 的 E5 仍未完成，完整目标 ACTIVE。

## 2026-10-04：Native 目录导入、原安装启用与离线来源冷读取

在 `664c181f6d7751025831abf46143ad2453930e14` 基线上推进[本地插件来源导入](./native-local-plugin-source-import.md)。真实 `.app` 首次核验发现：Main 已提交来源，但自己的 runtime stop 导致原 Settings/AuthGate 子树卸载，App 返回后回执和设置位置丢失。Main 现仅在原文档内保留一个绑定精确 opaque previewId 与完整包身份的 pending/committed/failed 状态，添加可选 `readStatus` 和独立状态事件，兼容旧 v1 client。读取不竞争确认的 mutation flight、不重启、不重新审批；外部失效、导航、崩溃和关闭清除状态，晚到完成不能恢复已撤回状态。已提交回执先于 importer 清理保存，清理失败不改写为未提交。

Renderer 在组件外只保留同实际 preload client 与账号键的一张身份票据，原设置或 AuthGate 重挂后先订阅再读回，旧回执受 owner、票据与请求顺序检查。明确确认导致整个 App 重挂时，只恢复原「工具与扩展」一次；预览、普通浏览、旧 preload 或账号/owner 改变不触发该导航。原 runtime 访问与 AuthGate 仍在 stop 时撤回，未保持旧权限，也未修改全局 CSS、原账户菜单或 AuthGate。

第二次真实目录核验还发现原 installer 的 0555 来源副本与原 Control 注册器的 owner-only 目录约束冲突：审批已写入，目录仍不列出该来源。修复仅作用于 Main 自有且完整身份校验通过的 `plugin-import-sources/packages/<digest>` 根；nofollow 目录 fd 经 UID/dev/inode 与父目录复核后 `fchmod` 为 0500，随后再次核验路径、fd、父目录及最终包身份。实际安装副本保留原 0555，开发者目录不改权限或文件，原 installer 和 Control 私有目录检查未放宽。原 Core 的一项来源权限期望更新为 0500，另建独立目录验收文件；未扩展原 958 行测试文件。

最终 Host 六文件 **152/152**、UI 十九文件 **199/199**，均零跳过；范围分别记录，不求和。Host 组合含原来源注册器列出/解析、实际 SQLite 服务从导入来源安装且初始停用、开发字节/权限不变、Node 未执行、原 0555 未批准副本和失败 precommit 副本精确重试、fd 打开前替换/符号链接拒绝。UI 组合含票据 owner/账号撤回、状态读回顺序、旧能力兼容和原设置/侧栏。日志分别为 `output/extensions/checks/native-import-receipt-host-pipeline-final-20261004.log` 与 `output/extensions/checks/native-import-receipt-ui-shell-final-20261004.log`；这些窄回归不覆盖此前全量 UI 的全部失败。

首次真实 `.app` 的回执丢失、0555 来源不可见截图与记录保留，未通过修改运行中副本权限伪造验收。新增目录测试首次三项失败和 Host 类型错误来自服务回执层级与 macOS 只读目录 rename 故障设置；只修新测试的正确回执访问及测试自有副本故障设置，产品安全约束保持。最终目录专项与原 Core 两文件 **63/63** 已包含在上述 Host 组合，不能再相加。

真实 `.app` 专项的自有目录 `42EBFi` 已完成手动 CUA、真实 SQLite 和 OS 进程的暖/冷验收；这不是 Vitest「1/1」。从原用户栏进入设置，真实 macOS 选择器选择初始未批准的独立短剧 **1.0.0** 包。默认未勾选公开资源与信任，只选 `ui.mjs`、PNG 并明确确认 UI 信任；原 Main 自重启后恢复原设置页，显示已添加回执和两个实际来源。预览阶段原审批与安装记录未变，添加来源后追加精确审批但尚无安装记录。随后从原页面 Install，实际初始 Disabled、selection revision 1、安装回执 1；再明确 Enable，实际 Enabled、revision 2、回执 2。Back 后原侧栏加载真实插件页面与 PNG；开发文件摘要和权限保持。

暖 Main `7794` 经原退出操作自然 exit 0，原 Control `7948/20165` 物理退场。冷前仅在自有测试目录把选择来源与 Main 导入来源改名下线，恢复原 inode/权限且不改审批，独立 0555 安装副本保持。新 Main `58526` 使用同 app/asar/userData，自然 packaged 身份与 asar 摘要吻合；原侧栏从实际安装副本加载演示 UI 与真实 PNG。再次从原账户进入十类设置，Installed Enabled；Available 只列出在线保留来源，缺失的 1.0.0 来源不显示。上次 Main 的内存回执不跨进程恢复，冷启动没有自动再导入、安装或启用。暖/冷 records、approval、businessCounts 与审批摘要精确一致，选择 revision 2 和两个回执保持；冷 Main 也自然 exit 0，原 Control 退场记录保留。

最终统一证明为 `output/extensions/checks/native-local-import-packaged-accepted-20261004/accepted-proof.json`，对应 `output/extensions/checks/native-local-import-packaged-accepted-proof-20261004.log`。暖/冷审批 SHA、三表完整记录与业务计数严格一致，编译源码和最终正式 Renderer 文件摘要与打包证明吻合；专项五 PID `7794/7948/20165/58526/58575` 均 ESRCH，四次自有临时根已清理，九张最终截图留存。汇总脚本首次误用 `copiedRenderer` 字段，只读检查阶段失败且未清理；修正为 `rendererFiles` 后最终 exit 0，最终 boundary 也 exit 0。

证据目录为 `output/extensions/checks/native-local-import-packaged-accepted-20261004/`，包含 chooser、默认预览、回执恢复、原安装停用/启用、暖/冷模块与 PNG 截图，以及身份、来源下线、安装副本摘要、SQLite 与进程退出事实。Thread、Message、Run 和外部 operation 记录为 0；积分、任务准入及项目 schema 未建立，以 null 记录，不能称真实积分余额为 0。本轮没有生成，1.0.0 UI 包验证安装与页面交付，不代替短剧 9/10 的完整业务或真实资金验收。

最终保留审计 `output/extensions/checks/native-local-import-packaged-final-preservation-20261004.json` 的 SHA-256 为 `3c7d4f6d95d9c63644caaa3c54e0fc6855f318a078a29483359b74a1aee0a5f9`。本轮基线的 13 个受保护原 UI 文件（不含本轮 App 新增五行）、60 个 SDK 源文件及冻结 tarball、九个原发行包、0600 生产映射、五个原用户 PID 的命令/监听及 primary 人类工作保持。正式 Renderer 为新增能力有意重建，不沿用旧 15 资产字节未变的声明。

用户当前原 IAB `5730` 已实际通过账号菜单进入十类设置；`5719` 根地址是原 AuthGate 登录页，不能把两个服务视为同一个已登录页面。本轮不请求用户 ComfyUI 或生产财务服务；此前 ComfyUI 404 保持，未反复探测。真实个人身份/入账/价格/失败结算、Native Krea2 公网生成/原 operation 查询、同次原完整 App 在线 S0、全部插件打包链路及用户指定实际企业 API 的 E5 仍未完成，完整目标 ACTIVE。

## 2026-10-04：原设置页的 Native 本地插件来源入口

在 `a535e758a12665e4efc565643cb9d8d195d9f21c` 基线上补齐[本机目录导入](./native-local-plugin-source-import.md)。原 Settings 的「工具与扩展」新增可选 Native 能力；目录只由 Main 原生选择器提供，Renderer 只收到有界预览和一次性身份。原账号菜单、CommandWorkspace、侧栏、全局 CSS 和既有安装组件保持基线字节。实际 IAB 再次从原用户栏进入完整设置页；原折叠侧栏隐藏用户栏的行为未改。

用户明确选择包信任和 UI 公开文件后，Main 在自重启前同步锁定精确确认，避免原 Control client/管理会话更新导致组件卸载取消自己的请求。原 Supervisor 重启队列串行 stop、物理清退、复制与原审批 CAS、start。预览取消只释放尚未批准的预览；真实文档或外部会话失效仍 abort 并 join 完整 IPC，包括提交后的启动。私有复制与实际安装分离，保留原 v1/v2/v3 项目审批；不自动安装、启用、执行、报价或授予业务权限。提交后启动失败返回已添加且待重启；首次审批硬链接残留只在完整私有身份吻合时安全冷恢复，不推广未提交 staging。

最终核心/IPC/原 Bootstrap/Supervisor 组合 **5 文件、127/127、零跳过**；独立组件、原 Settings 和基础 CommandWorkspace **4 文件、82/82、零跳过**；原侧栏/CommandWorkspace 及旧 preload/Web 无能力回归 **16 文件、146/146、零跳过**，各组存在重叠，不求和。UI lint、抽取后的 Host 类型、原 Renderer/Host 构建与 boundary 通过。核心和私有文件模块分别保持约 600/400 行，不引入第二运行时或新构建系统。

末尾校正新回执的 `restartRequired` 与实际 `runtimeStatus`，启动成功为 false、已提交但启动失败为 true；UI 严格核验两者一致。旧固定 true 的 UI guard 在窄回归中确实拒绝两个成功回执，修正后 Main IPC/组件组合 **2 文件、32/32、零跳过**，UI lint、Host 和 Renderer 最终构建通过。该失败日志也保留，不把重启成功再表示为必须重启。

首次类型检查的测试字面量/变量初始化错误和新组件测试按钮定位错误已修复，日志保留。新增实际重启影响说明后，只更新该新组件预览快照对应的一行，最终再跑 **19/19**。首次 `pnpm test --` 实际误选全量：4,100 通过、10 失败、49 跳过，不称全量绿色；其中新组件的一项已在上述窄回归通过，七项旧 UI 基线失败见原界面阶段。另一个未修改的架构测试仍报告原 `AgentPlatformAuthGate.pim-generation.test.tsx` 引用；单 Worker 复核中原 soak 时限用例通过，架构项仍失败。未放宽旧断言、期限或删测试。当前阶段验证与保护记录位于 `output/extensions/checks/native-local-import-*.log/json`。

本阶段有意重建正式 Renderer 以包含新入口，不沿用上一阶段「15 资产字节未变」声明。原 SDK/冻结包、旧发行包、生产映射和用户服务继续保留，primary 人类工作未编辑。原 AuthGate 的首次未登录/无审批门槛保持：新 route 支持 Control catalogue 尚未连接，不等于首次签出完整 App 可达性。新版真正 `.app` 的目录选择→导入→原安装/启用→模块→冷启动路径尚未专项验收。

本轮未请求用户 ComfyUI 或生产财务服务；此前原 ComfyUI 404 事实保持，未反复探测。真实个人身份/入账/定价/失败规则、Native Krea2 公网生成/原 operation 查询、同次原完整 App 在线 S0、全部插件打包链路及用户指定实际企业 API 的 E5 仍未完成，完整目标 ACTIVE。

## 2026-10-04：实际财务 HTTPS、Worker Main 与原打包报告结算

在 `622d071fb0333fe9b9e83b6357e5535fd5406c9a` 基线上增加[实际 HTTPS 验收](./native-plugin-credit-https-verification.md)，本阶段只改 test/support 和说明。原 Main、独立 0600 财务文件与 token refs、原 fetch/TLS 和原 Store 结算服务保持；不新增产品权限开关或改原 PDP。具名 HTTPS helper 使用原测试 CA，严格 scope/epoch/字段与 body 上限，并实际等待 server、socket close 事件和 handler promise 退场。

实际 Worker Main 专项最终 **10/10、零跳过、退出码 0**，保留原六项 no-opt-in/配置/tenant 行为，增加 MCP 真启动后的 deny 与 held close、原 v1 paid 索引扫描/授权刷新/hold/settle18、撤权后不能复活、SIGTERM 中止真实挂起响应体。冷 Main 等待 existing finalization 读取后的第 4 次授权响应完成，原账与事件保持，没有第二次金额决定。Main 夹具由原 Store API 准备终态业务事实，未将其称为真实供应商执行。原配置/authority/coordinator/bootstrap 四文件回归 **78/78**，原 Native 环境/Supervisor/Source 报告三文件 **54/54**，均零跳过、退出码 0；各组范围单独记录，不求和。

真正 `.app` 专项最终 **1/1、零跳过、退出码 0**：原账号菜单→十类 Settings→原 professional 1.0.0 模块→真实 UI 提交→原 Agent/Tool/报告 HTTP adapter 完成。独立 HTTPS 只作一次明确 18 积分决定，绑定原 ready=true、完整 v1 pin、completed Run/工具/work items 与非 running attempts；持久决定等于真实 HTTP 响应，包含 decisionId。原账务三笔为 grant100/reserve30/settle18，钱包可用 **82**、预占 **0**、spent **18**，一次报价、两次具名模型请求、一次供应商 POST。

原 Main 12514 与冷 Main 14237 及 16 个原 runtime 子进程均物理消失，全部 18 个 PID 经 Root 复核 ESRCH，自有 userData 已清理。冷 owner 第 6 次授权响应完成，证明 `migrate:true` 下原 Service 已读 existing finalization；所有供应商 GET/POST/DELETE、执行/报价和原业务事实、回执及不可变决定保持。目录探测及财务授权可重新发生，实际共 137 次授权、1 次金额决定，不能声称全部 HTTP 为零。原 App 历史页面读取不扩为 report v1 表单恢复、实时 delta 或执行中断线重连。十一张最终原页面截图保留。

首次类型错误、Main 测试 HTTP 清退的 socket close 观察时序问题和打包测试暖/冷对象 prototype 比较失败全部保留。均只修测试类型、等待真实 close 事件及一致的完整快照；产品保护与行为不放宽。打包首轮已经走到暖结算和冷读取，但首次失败不计为通过。最终 Host/Worker 类型、boundary、license 和格式检查及保留摘要，以统一证据 `output/extensions/checks/native-financial-http-proof-20261004.json` 为准。

原 UI 14 文件、正式 Renderer 15 资产、SDK 60 源文件/冻结包、短剧8/9/10、0600 生产映射与用户五个服务保持；只在自有目录编译原 Host/runtime/.app，未重建正式前端或发行插件，primary 人类工作未改。当前 IAB 原账号菜单已实际打开设置页并保存 `settings-entry-visible-20261004.jpg`，未改偏好。原侧栏折叠时隐藏用户栏，展开后账号菜单仍可进入设置。

本阶段身份/PDP、模型、供应商、入账/报价/收费规则均为具名测试输入，不是生产个人积分、真实企业 API 或用户 ComfyUI；本轮用户 ComfyUI POST 为 0，未重复探测此前 404 状态。真实身份/入账/定价/失败规则及 HTTPS 财务服务、Native Krea2 公网生成/原 operation 查询、同次完整 App 在线 S0、全部插件打包链路和用户选定实际企业 API 的 E5 仍未完成，完整目标 ACTIVE。

## 2026-10-04：Native 财务环境隔离与原打包三类 prepared 恢复

在 `ce27cecf640535fb7729ef72551dbd3608033e30` 基线上补齐 [Native 财务环境投影](./native-plugin-credit-environment.md)。原 v1 0600 文件和明确 token refs 在启动时捕获；只有当前 Worker 注入捕获值，共享 runtime、目录探测、独立 management、工作区命令/Git 与 Windows 清退环境移除这些明确字段。最终 spawn 复核文件 pin，文件变化或 overlay 冲突永久撤回同 owner；没有 opt-in 时零财务文件读取，不猜测未声明 token。原 provider-null 入口不新增财务 Worker。该边界只限制被动环境继承，没有 watcher，也不抵御同 UID、可信 Node 或显式同名模型凭据选择。

财务投影、实际 Supervisor/目录子进程及管理入口组合 **66/66**；工作区实际 Node child 与原容量/清退回归 **33/33**（新专项 **7/7**）；原自动安装、activation、任务、项目和报告 Source 链路 **六文件、68/68**。均零跳过、实际退出码 0。Host 类型、boundary、格式和保留检查通过；初次类型检查的测试变量索引类型问题保留，后续仅补类型声明。分组按实际范围记录，不求和，不把 custom child 的环境测试当作财务 HTTPS 或生产结算验收。

[真实 `.app` 三类 prepared 恢复](./native-packaged-prepared-recovery.md)最终 **1/1、零跳过、退出码 0**：原账号→十类 Settings 安装/启用原短剧9，原表单保存项目/概念并用宿主按钮创建 Thread；原鉴权 ControlApiClient stage 三条真实 ACK，固定 selection revision 2。原 Main 与子进程物理退场后，新 Main 从原 recovery GET 在模块 ready 前读回完整 pin、原 request/key/CAS，实际页面显示三类 UNKNOWN。查询/选用 operation 明确不存在，receipt null、dispatch 0；冷启动所有业务写入增量为 0，原账务、Run、供应商操作及项目关联保持，报价 0、初始具名 100 积分保持。未声称三个业务按钮产生了 ACK、成功图片历史/选用或完整 S0。

前两次打包失败为测试 selector 范围及 DB JSON 读取方式，均仅修测试并保留首次日志/截图。最终七张原页面截图保留；自然打包身份、asar/runtime 摘要与实际子进程退场核验。自有测试目录编译原 Host/runtime 并复制正式 Renderer，未重建 SDK/冻结包、正式前端或发布插件包；14 个原 UI 文件、15 个正式资产、60 个 SDK 源文件、旧发行包8/9/10、0600 生产映射和用户五个进程保持。primary 人类工作未改。统一证据为 `output/extensions/checks/native-financial-isolation-proof-20261004.json`。

`2026-10-04T05:24:59.493Z` 对用户原 ComfyUI 首页、`/queue` 与 `/system_stats` 的真实只读 GET 均返回 404，TLS 校验开启，POST 为 0。本轮未提交用户生图任务或生产财务请求。真实个人身份/入账/价格/失败规则与 HTTPS 财务服务、Native Krea2 实际公网生成/原 operation 查询、同次原完整 App 在线 S0、全部插件打包恢复/执行和用户选定实际企业 API 的 E5 仍未完成，完整目标 ACTIVE。

## 2026-10-04：Worker 有界恢复与独立财务部署

在 `bde673948f6d07dfd6428ec8405294a0c15a6ec2` 基线上接通[Worker 插件积分结算](./installed-plugin-credit-worker.md)：明确 tenant/space/profile 的原安装 admission 索引分页、独立 0600 文件配置与 HTTPS 财务权威、后台单轮调度，以及父 Store 与财务 owner 的共同事务 fence。未配置时原 Worker 不访问结算 Store、不迁移、不新增财务请求；原用户栏、Settings、侧栏和样式保持。

每页最多 16 项，原 hold、未完成和已结算的槽均推进游标，不用终态/钱包/NOT EXISTS 过滤掩盖无界扫描。严格核验原 schema 和新增独立 marker/index，PG 校验四项内建 text_ops、C collation 及实际有效索引。预算与 HTTP 超时只撤权/abort，物理请求或 Store promise 未结束前不再扫描；所有 stop 先撤权，再 join 后关闭父存储。授权刷新保留旧到期约束，跨旧期限的同 epoch 响应不能恢复权限。

新协议、coordinator、真实 SQLite/独占 PostgreSQL 和 Worker 装配组合 **119/119、零跳过、退出码 0**（包含恢复专项 **41/41**、Worker 双库装配 **10/10**）。Application 完整回归 **568/568**。原原子结算与普通 Worker 的生命周期、Tool continuation、恢复和实际启动组合 **138/138、零跳过、退出码 0**，包含新增实际 Main **6/6**：无 opt-in 的真实 MCP 退场及无效文件/tenant mismatch 在资源和财务 HTTP 前拒绝。各组按实际范围记录，不求和；实际主进程的财务授权 deny-after-MCP 尚未专项验收。

具名原资金/价格经真实原准入与 Store，Worker 明确结算 18，并从同一持久 DB 的新 composition/新连接读回不可变决定，余额和事件不再改变。这是重新打开的 owner，不是 OS 崩溃重启。普通流式/Tool continuation 与真实 coordinator 的具名 Store scan 同时运行，关闭等待该 scan 真结束；PG 查询仍共享原池和锁，单连接池可使普通 Store 操作排队，不承诺所有配置下无数据库争用。

原账本/准入/派发兼容、类型、boundary、格式和保留结果以统一证据 `output/extensions/checks/credit-settlement-worker-proof-20261004.json` 为准。初次测试类型问题及 PG 启动失败保留；缩短 socket 路径后启动成功。首次未执行测试，不计入通过数。自有 PG 在消费者退场、后端归零后物理停止并清理；原递归 packages 类型脚本隐式重建 SDK 生成文件，SDK 源码/冻结包、正式 Renderer、旧独立发行包、生产映射和用户五个进程保留，primary 人类工作不改。

HTTP、身份、资金、金额和规则仍为具名测试边界，没有生产拨款、扣费或请求用户 ComfyUI。真实个人身份/入账/价格/失败结算、Native Krea2 实际公网生成查询、同次完整 App 在线 S0、全部插件打包恢复/执行链路及用户选定实际企业 API 的 E5 尚未完成，完整目标 ACTIVE。

## 2026-10-04：插件积分与原执行证据的原子结算

在 `db614763721c3a3839836b014b12ba6563de38e9` 基线上，新增[积分结算决定层](./installed-plugin-credit-finalization.md)：Application 显式权威服务、共享证据校验和 SQLite/PostgreSQL 原子适配器。原付款主体、报价、个人预占、任务回执、安装完整 pin、Run、Step、Attempt、WorkItem/lease、Tool 和供应商 operation 共同复核；每个集合最多 64 项，超限拒绝。终结 Run 或过期租约不能单独解冻。旧 v0 保持可读，这条新增自动路径不会结算缺少 v1 安装证明的记录。

实际收费或释放必须来自显式服务端决定，且绑定当前证据摘要。事务内重读证据，账户、预占、账本流水与不可变决定一起提交；相同决定重放、不同决定冲突。真实 PG 两向锁竞争已覆盖新供应商 reserve 与结算并行、operation CAS、原队列续租及关闭前回滚/确认 COMMIT 后返回成功。原表的同名 view、部分 schema、版本异常、缺失原准入、超过报价和决定插入失败均拒绝并保留账务；实际过期但仍 leased 的 SQLite 原工作项保持预占。

Application 完整测试 **568/568**（含新增服务专项 **6/6**），共享证据与 SQLite 专项 **35/35**，独立 PostgreSQL 18 专项 **14/14**，原账本/准入/派发及安装任务兼容回归 **222/222**，均零跳过、实际退出码 0；分组存在包含关系，不求和。全部 packages、Control 和 Worker 类型检查及 boundary 通过。自持 PG 只监听独占 Unix socket，测试消费者退出、后端归零后物理停止并清理。格式和保留结果及统一证据为 `output/extensions/checks/credit-settlement-proof-20261004.json`。

本轮未修改原 UI、用户栏/Settings、侧栏、公共样式、正式 Renderer 或既有插件发行包，未修改 primary 的人类工作或重启用户服务。递归 packages 类型检查沿原 plugin-host 脚本隐式重建 SDK 生成文件；SDK 源码、冻结 tarball、旧发行包和生产映射保持。所有资金、价格与权威均为具名测试夹具，未生产扣费或请求用户 ComfyUI。

本阶段尚未装配 Worker 自动恢复扫描、独立结算部署授权及事务内 owner 撤回 fence；当前服务只撤回尚未提交给 Store 的新工作，并等待已开始 Store promise 物理结束。后续将按明确授权范围有界扫描原安装 admission，独立管理财务生命周期，不借用 SSE outbox。真实身份/资金/价格/失败结算规则、Native Krea2 公网执行、同次完整 App 在线 S0、全部插件打包链路和用户选定企业 API 的 E5 仍未完成，目标 ACTIVE。

## 2026-10-04：原打包设置页安装短剧与项目输入冷读取

在 `70296ae86dbd452d0942f26d9829586b2e5d5eea` 基线上，真实 `.app` 的独立短剧 **9.0.0** 专项首次 **1/1、零跳过、退出码 0**。原账号菜单→十类设置→工具与扩展，实际安装原批准来源（初始停用）、明确启用，原侧栏加载该包 UI。通过原表单保存项目、需求和概念输入，然后关闭项目再读取；原 Main 物理退出后，新 Main 冷读取相同项目和概念。再从原 Settings 停用、撤下模块、卸载、原来源重装启用，全部业务身份、修订和元数据回执逐条保持。细节见[打包短剧项目验收](./native-packaged-projects-window.md)。

此专项复用原项目执行装配及实际 owner，没有修改必需 Host 服务或使用早期无依赖包代替短剧9。旧测试模型只在显式选项下接受有界、真实鉴权的目录 GET，默认 POST-only 保持；原 Main 实际目录探测与模型执行区分。沿用具名初始 100 积分夹具，余额和钱包记录保持，报价、Run/准入/预留、生成/查询/选用、Thread、recovery stage、模型执行与供应商请求增量均为 0。没有调用用户 ComfyUI、生产拨款或定价。

最终原 Source、报告、编译窗口和打包窗口组合 **九文件、36/36、零跳过、退出码 0**，包含本专项；Host 类型、boundary、格式与保留检查通过。统一证据为 `output/extensions/checks/native-packaged-projects-proof-20261004.json`。本阶段只修改 test/support 和说明，原前端、用户栏/Settings/两侧栏、全局 CSS、SDK/冻结包、正式资产、旧发行包、映射与用户服务继续保留；不碰 primary 人类修改，不宣称全部字节等于最初 `776484c57`。短剧项目输入保存/读取与安装生命周期是已验范围；打包版三类未确认请求恢复、在线 S0、Native Krea2 实际公网执行、真实钱包/资金/价格/结算、全部插件打包链路和用户选定企业 API 的 E5 仍未完成，目标 ACTIVE。

## 2026-10-04：真实打包应用的原入口与报告任务

在 `c499da519b8c12b74120b9f588feef133ee23063` 基线上，真实 macOS arm64 `CrewON.app` 专项首次 **1/1、零跳过、退出码 0**。原 builder 使用原 manifest/main、完整七项 runtime 和逐字节复制的正式 Renderer；实际 `.app` 原生可执行文件通过原 `--user-data-dir` 隔离目录启动，外部 inspector 核对自然 packaged 身份后加载观察器，没有入口 wrapper、开发 alias、窗口或 preload 替换。细节见[真正打包应用验收](./native-packaged-report-window.md)。

原用户栏进入十类 Settings、原模块创建任务并提交报告、原任务显示实际 assistant 文本和 completed Run；原 Main 物理退出后，新 Main 读取同一 Thread 和模块状态。实际 OS 祖先与精确 Resources/runtime argv 记录原 Control、Worker、release、模型目录和工作区 MCP；不回注被 packaged 过滤的 `NODE_OPTIONS` 或沿用开发版 import 观测。两次原目录分别探测，Thread SSE 返回 200/event-stream。脚本适配真实中英文页面，语言偏好和产品界面未修改。

一次报价、两次具名 Responses、一次供应商 POST 和原 completed 工具回执保持；钱包可用 70、预留 30、spent 0，仅为具名测试资金/价格。冷读取没有再次调用报告表单，不扩为 report v1 表单 durable recovery 或执行中断线重连。最终八文件组合实际 **34 通过、1 跳过、0 失败、退出码 0**；原项目恢复专项因缺少短剧目录环境被跳过，补齐环境后单独 **1/1、零跳过、退出码 0**。所选三十五项行为均实际覆盖，但不称组合零跳过。Host 类型、boundary、格式和保留检查通过；统一证明为 `output/extensions/checks/native-packaged-report-proof-20261004.json`。

本阶段仅新测试和说明，原 UI/账号/Settings/侧栏/全局 CSS、SDK/冻结包、正式 Renderer、旧独立发行包、生产映射与用户服务保持，不碰 primary 的人类修改。真实打包报告不等于签名、公证、安装发行或所有插件的打包链路。完整目标继续 ACTIVE：Native Krea2 实际公网生成/查询、可用 ComfyUI 的同次原完整 App S0、真实个人身份/资金/价格/结算和用户选定实际企业 API 的 E5 未完成；`createThread` 不在三类恢复内。本阶段没有请求用户原 ComfyUI。

## 2026-10-04：编译后 Native 原窗口提交报告任务与冷读取

在 `be4cebd39d7bb470b08645b1fd3a76faa172226e` 基线上，新增原编译后 Main、preload、BrowserWindow 和完整 App 的实际报告窗口专项。原 Control、Worker、release 与模型目录子进程编译到独占临时布局；正式 Renderer 逐字节复制，未重建。原 Main 创建窗口、会话、IPC、HTTP 和 Native UI 资产协议，原保留 professional 1.0.0 UI 从真实协议加载。原用户栏进入十类 Settings，再从原侧栏模块创建 Thread、刷新原上下文、提交报告、查看实际 assistant 文本和 completed Run。具体范围见[编译后原窗口验收](./native-compiled-report-window.md)。

父测试仅给实际 UI 生成的原 key 一次性绑定具名 PDP；原 Worker 仍核验真实保存的 paid receipt、admission、完整 pin、配置、profile、选择与 deployment。实际执行 Control/Worker 均加载原安装 Node 字节，只产生一次报价、两次 Responses 请求、一次供应商 POST 和 completed 工具回执。初始 100 与每次 30 是具名测试资金和价格，余额 70、预留 30、spent 0；报告的 ComfyUI operation 为 0，未验收真实收费或结算。

物理停止后新 Main 从原任务读回同一持久 Thread 文本，原模块刷新显示 completed，数据库事实、钱包及调用次数保持。冷阶段回执是 launcher 原回执定位，未再次调用报告 action；不声称 report v1 表单 durable recovery。两次 Main 的原目录探测分别产生实际增量，原 Thread SSE 均为 HTTP 200/event-stream；没有实时 delta、执行中断线或自动重连验收。

新窗口专项与原 Source/activation/IO 最终组合 **7 个文件、34/34、零跳过**，包含窗口专项 **1/1**，真实退出码为 0；Host 类型、boundary、格式和保留检查通过。统一证据为 `output/extensions/checks/native-compiled-report-proof-20261004.json`，保存十一张实际页面。修复前失败保留：新 driver ESM ready 死锁、初始 Source 与 Main 工具目录不一致、UI 上下文异步更新及冷阶段不应要求再次导入执行 action。产品冲突、许可和网络保护未放宽。

本阶段仅改测试和说明；以本阶段前一提交保留 UI、账号/Settings、侧栏、全局 CSS、正式资产、SDK、三个旧发行包、生产映射与用户服务，不对最初 `776484c57` 作全部字节一致声明，不碰 primary 的人类修改。开发路径 alias 指向实际 compiled `.mjs`，仍不是 packaged `.app`。完整目标继续 ACTIVE：Native Krea2 的实际公网生成/原 operation 查询、可用 ComfyUI 的同次原完整 App S0、真实个人身份/资金/价格/结算、打包完整链路与用户选定实际企业 API 的 E5 待完成；`createThread` 不在三类恢复内。本阶段没有请求用户原 ComfyUI。

## 2026-10-04：Native 独立报告的实际 Worker 执行与冷重放

在前一阶段 `77b3e2c693` 基线上，新增实际 Native Source 报告专项。保留的仓外 `example.professional` 1.0.0 实包经原安装/配置/启用、Source Supervisor、release CLI、FileIssued 私有任务配置、实际 Worker/Main、HTTP/ControlClient 和同一文件 SQLite 执行。Control 加载原 Node action，经原 Task Application 提交；Worker 加载原 execution factory，通过原 HTTPS Responses、Agent/Tool Broker 和报告包自身 HTTP adapter 完成一次具名供应商调用。原 metadata 默认和拒绝测试保持，没有产品执行开关、第二运行时、传输替换或人工 Run/admission/tool/supplier 结果记录。详细边界见[Native 报告执行](./native-installed-plugin-report-execution.md)。

新增显式具名存量请求 PDP，从原精确 receipt 主键核验已提交的 Turn/Run、完整 pin/命令摘要、binding、个人积分准入/预留、当前 profile/选择/activation、原配置和完整 Agent deployment；不同请求不能借用许可。身份、PDP、初始 100 个人积分、每次 30 积分报价、模型与供应商均为具名测试边界。第一项实际完成只产生一次供应商 POST、两次模型请求和一项 completed `ToolExecutionReceipt`，assistant 保存原报告；钱包余额 70、预留 30、spent 0，执行不代表结算。该报告不使用 ComfyUI external operation store，原 Run 的 operation 数量为 0。

第二项由客户端明确用不同 key 与 Thread 提交，形成独立准入及第二次报价，但 Worker 执行拒绝；原客户端显式取消，没有新增模型或供应商调用。物理停止后冷启动签发新 session/bootstrap epoch/activation digest；旧 session/mount 拒绝，当前 Main PDP 拒绝时原请求不能重放。重新允许后，同一原 key/input/旧 Thread CAS 返回同一原回执，Run、binding、admission、工具回执、消息和实际钱包保持，没有进一步供应商 POST、模型请求或报价。冷重放不把预留变为消费或退款。

SSE 验收仅在完成后读取实际持久事件、用 `afterSequence` 续读及冷重启后核对原事件；没有执行中断线、自动重连、DOM 或完整 App 验收。当前 Control/Worker PID 均实际导入安装包 Node；其他导入只允许属于已观测的本夹具 Main/Worker 子进程，包括前期消费者。不同 Thread 的拒绝任务保持原完成任务的消息事实不变；这些观测修正及修复前部分失败日志保留。

最终原 Source/activation/IO 与新增报告组合 **6 个文件、33/33、零跳过**通过，新增报告专项 **1/1**包含在组合内；原 Worker 旧/当前包执行及三类拒绝进程组合 **4/4、零跳过**通过。Host、Worker 类型、boundary 及保留检查通过，各组范围不同、不求和。统一证据为 `output/extensions/checks/native-report-execution-proof-20261004.json`。

原前端、用户栏/Settings、两侧栏、正式资产、SDK、生产映射及既有独立发行包保持；本阶段未重建前端或更新用户配置，保留检查不能替代账户/设置页面的实际可见性检查。没有请求用户原 ComfyUI。下文前一阶段的短剧三 epoch 用例仍是 Worker 拒绝、具名 operation 历史与选用 prepared 的原范围。完整目标继续 ACTIVE：Native Krea2 Worker 实际生成/查询、真实个人钱包/资金/价格/结算、可用 ComfyUI 的同次原完整 App 保存→生成→显式查询→选用→重启恢复 S0、编译后 Electron/打包 renderer 完整链路和用户选定的第二个实际企业 API 的 E5 仍待完成。`createThread` 仍不在三类 durable recovery 内。

## 2026-10-04：Native 生成、查询原回执跨真实 epoch 恢复

基于已提交的 `ee2fc065e`，生成和查询已接通独立历史 receipt 证明。生成查精确存量 admission，仅恢复已保存 execution epoch，原 task v1 摘要及项目 reference wrapper 保持且只包装一层；查询的可选精确 receipt reader 核验实际 query Turn/admission/binding、原付费来源 Turn/admission/积分准入/预留及 operation，再通过实际不可变 query link 恢复 source/execution 两个历史 epoch。其余完整 pin、selection revision、publication、原 reference/input、旧 CAS 和当前 PDP 保持精确；旧 adapter 没有历史 reader 时仍严格匹配 epoch。原回执、报价、预留和历史链接不改写。协议见[Native 项目执行](./native-project-execution-integration.md)与[持久恢复](./plugin-ui-durable-recovery-protocol.md)。

实际 Native Source Supervisor 专项 **1/1、零跳过**通过：保留的短剧 9.0.0 UI 与 Krea2 1.0.0 Node 实包经原 release CLI、实际 Worker/Main 子进程、FileIssued 私有 v3 文件、HTTP/ControlClient 和同一文件 SQLite 运行三次新 session/bootstrap/task epoch，并逐轮物理停止。第一轮实际保存项目和概念图；当前任务 PDP 拒绝时没有新 Run、积分副作用或报价，允许后原生成只产生一次 30 积分报价和预留，初始 100 积分是具名测试资金。Worker 执行授权实际被拒绝，没有供应商调用。

第一轮全部进程停止后，测试才通过原 Run reducer 将来源 Run 从 queued 推进为 running，并预留具名 operation 作为查询历史，不能把它当作模型或供应商完成。第二轮用原生成 key/input/旧 CAS 返回原回执，原不可变业务记录、wallet 和报价次数保持；随后显式查询创建独立 Turn/Run，不新增生成 admission、报价、积分预留或流水，Worker 拒绝后由原客户端显式取消查询。第三轮完整读回三 lane journal 的原请求/回执，原查询 key/input/旧 CAS 返回原回执；当前 PDP 撤权仍拒绝重放，旧 token/mountRef 拒绝。图片选用仅 prepared、派发次数 0、回执为空，没有实际选用提交。

Native authenticated invoke 的 recovery 请求范围改为外层，执行/历史读取/选用请求范围置于内层，传入外层实际 `currentSignal`；原 execution preparation 不再被 metadata 遮蔽。HTTP 与 owner/recovery 关闭取消继续传递，物理 Promise 和确认事务仍被等待；request-owner guard 保持，不增加原 opaque COMMIT 后的当前权限 fence。

最终 Application 专项与原兼容组合 **117/117**、实际 SQLite 与自持 PostgreSQL 18 专项 **106/106**、Control runtime 与实际 Native Main 组合 **68/68**、原及新增 Source/activation/IO 组合 **32/32**均通过、零跳过；上述三 epoch 专项包含在 Source 组合内，分组重叠、不相加。Application、Store、Control、Host 类型及 boundary/license 检查通过，自持 PostgreSQL 在全部消费者结束后已停止并物理 join、清理。本轮证据归档路径为 `output/extensions/checks/native-project-epoch-proof-20261004.json`，修复前失败与真实退出结果一并保留。

原 UI/用户栏/设置/两侧栏及公共样式、14 个 UI 源文件、15 个正式资产、60 个 SDK 文件、冻结 SDK tarball、生产映射和三个既有独立发行包的保留检查通过；原用户进程保持。本轮没有 renderer、在线付费完成或真实资金验收，也未更新用户配置。`createThread` 仍在三类恢复协议之外。完整目标继续 ACTIVE：Native Worker 实际执行、真实钱包/价格/结算、可用 ComfyUI 的同次完整 App 保存→生成→显式查询→选用→重启恢复 S0、编译后 Electron/打包完整 App 和 E5 第二个真实企业 API 仍待完成。

## 2026-10-04：Native 项目生成、查询与三类恢复装配

已新增独立私有 approval/bootstrap v3 与 `crewon.desktop-project-execution.v1`，把生成、显式查询和图片选用的 source/target/action 映射及三类恢复绑定实际 FileIssued bootstrap、task、activation、request owner 和 SQLite。原 v1/v2 与普通 Standalone 的付费映射拒绝保持；DTO、副本或布尔就绪端口不能替代实际 owner。协议见[Native 项目执行接线](./native-project-execution-integration.md)。

真实 Native factory 验证三类原请求暂存、读回及关闭重建后的保留，没有派发业务动作。首次实际 fresh schema 测试发现选用迁移早于生成 source schemas，已在显式生成加选用组合补齐实际迁移；随后修正 UI-only activation 的实际 Host 服务接线和公开 creator 的 HTTP 只读 adapter。没有开户、拨款或伪造 schema/服务就绪。原文件持续校验在既有权限和请求检查处执行，未新增 COMMIT 后失败检查。

当前实际组合及兼容回归 **107/107**、新实际 factory **12/12**、原 runtime/启动兼容 **56/56**、Contracts **402/402**、新旧 Electron bootstrap **56/56**、真实 Main **9/9**、原 Electron source/activation/IO **31/31**与 SQLite/自持 PostgreSQL 18 专项 **40/40**通过，均零跳过；各组重叠，不相加。Control、Contracts、Host 类型、boundary、license、格式与 diff 检查通过。统一证据为 `output/extensions/checks/native-project-execution-proof-20261004.json`，首次失败及修复后日志保留，未删改旧行为测试以通过检查。

原用户栏→设置已在实际页面再次打开；原 UI、侧栏、公共样式、正式资产、SDK、生产映射和旧发行包保持，用户进程保留。本轮仅实际 owner 关闭重建，未验收 generation/query 在真实 Source Supervisor session/bootstrap epoch 轮换后的业务回执重放。项目生成 wrapper 与查询双 pin 的历史证明、Native Worker 实际执行、真实钱包/价格/结算、可用 ComfyUI 的同次完整 App S0、编译后 Electron 完整 App 和 E5 仍待完成，完整目标 ACTIVE。

## 2026-10-04：Native v4 Electron source 私有任务签发与冷重启重放

Native v4 已接通 Electron source Supervisor、实际 release/Main/Worker 子进程和独立私有任务配置签发。任务权限来自显式配置的独立 authority，不借用模块激活权限，也不提供默认钱包或报价。协议见[Electron 私有任务签发](./native-installed-plugin-task-electron.md)。真实 source 进程专项 **3/3 通过、零跳过**；Worker 保持 metadata-only 边界，拒绝执行并显式取消，本轮不代表付费任务完成，也不代表 packaged App 或编译后 Electron 完整 App 验收。

Contracts **393/393**、新旧 Electron owner **46/46**、Native runtime 组合 **170/170**、普通 Application **44/44**、项目/查询 **59/59**通过。实际 SQLite 与自持 PostgreSQL 18 的 receipt/admission/Application 专项 **45/45 通过、零跳过**；Control、Store、Host 类型检查通过。旧 v3 启用/IO 回归沿原证据的 `task-context-20261003/krea2/1.0.0` 实包 **12/12、零跳过**通过。这些分组存在重叠，不能相加。初次错用没有声明所需 IO 服务的早期 Krea 包及其他修复前失败日志保留；未修改旧用例或扩大批准来通过检查。统一证据为 `output/extensions/checks/native-task-electron-proof-20261004.json`。

冷重启回执兼容仅通过精确存量主键和完整作用域查询历史 admission，恢复旧 authorityEpoch 后核验原 v1 fingerprint。selectionRevision、其余全部 pin、command、CAS 和当前 PDP 仍须精确匹配；原回执、报价与资金记录不变。首次事务中不同 epoch 的竞争仍严格冲突，后续显式使用原键重试才可核对已存回执，不放宽通用幂等摘要规则。

本轮未修改原 UI、Settings、两侧栏、资产、SDK、生产映射或既有独立插件发行包；原设置已再次在实际页面打开。Native 短剧生成/查询及三类恢复、真实钱包/价格/结算、可用 ComfyUI 的同次完整 App S0、编译后 Electron 完整 App 和 E5 尚未完成，完整目标继续 ACTIVE。

## 2026-10-04：Native Main 文件签发接线与独立任务读取

Standalone Main 已通过独立私有执行文件装配真实任务核心，公开 Standalone creator 在打开 SQLite 前要求实际 FileIssued/current；显式配置的身份、scope、root、epoch 和 activation publication 在 Artifact 分配前核验。原 HTTP task GET 的 Native 分支接独立任务 PDP，仍使用 configuration preparation；catalog/runtime 保留原 metadata 批准和拒绝，Native raw createTask 未开放。混合 reader 捕获原输入，在策略/存储 await 后重验 owner，不回退到其他 reader。协议见[Main 启动与读取](./native-installed-plugin-task-main.md)。

真实 Main **8/8**、新 startup/read **12/12**、两类文件 loader **39/39**通过，均零跳过。原 Native/history/recovery/core/HTTP 路由组合 **183 项通过、零失败**，另有一项既有 PostgreSQL creator 用例因未配置外部数据库跳过，本轮不宣称它已验收。分组重叠、不相加。通过实际安装 Node/UI、HTTPS、HTTP/ControlClient 和同一文件 SQLite，验证普通任务、七类持久副作用、一次明确个人测试积分预留、正常物理关闭与重启、真实 session/CSRF 轮换和原键/旧 CAS 重放。独立读拒绝、迟到文件撤权、profile lock 替换、无 opt-in 和显式 PG 冲突均保留原拒绝行为。旧权限预期和夹具 Origin/profile writer 已修正为实际接口，未扩大批准。较大并行回归暴露初次 file loader 对无关祖先目录元数据变化的误拒绝；叶文件完整 pin 和目录身份/权限继续核验，增加实际 fd 读取的确定性竞态覆盖。类型、boundary、license 和格式检查通过。统一证据为 `output/extensions/checks/native-task-main-proof-20261004.json`。

身份、五类 authority、peer readiness/deployment、100 个人测试积分和 30 积分报价为具名夹具，没有 Worker、模型、供应商或真实资金调用。原前端、用户栏、设置、两侧栏、正式资产、SDK/tarball、生产映射及短剧 8/9/10 包保持摘要；原用户进程保留，未更新用户配置、重建或再次请求原 ComfyUI。Electron 私有签发、Native 短剧生成/查询及三类恢复、真实钱包/价格/结算、可用 ComfyUI 的同次完整 App S0、打包全链路和 E5 仍待完成，完整目标继续进行。

## 2026-10-04：Native 独立任务执行配置与真实工厂

已增加独立 `crewon.desktop-installed-plugin-tasks.v1`、实际私有文件 loader 和 Native 任务 authority，严格绑定同一真实 configuration/request/activation owner、安装源和 SQLite。原启用审批不授予任务、UI、执行包、报价或资金权限；可信程序可以通过原 Native factory 提交已安装 Node action，沿原 Application/Turn/Run/个人积分事务执行。原键重放不重复预留，关闭等待真实物理调用，COMMIT 后保留原 opaque 回执。必需 Host 服务的 deferred 接线只跟随实际 private brand，布尔端口不能伪装就绪。具体协议与边界见[Native 任务执行接线](./native-installed-plugin-task-execution.md)。

新契约/loader **38/38**、完整 Contracts **388/388**、原 Native 配置/启用 **35/35**、独立 authority/真实 Native factory **27/27**、新/原必需 Host 窄组合 **42/42**、完整 Host **308/308**、原 Native history/recovery/core **65/65**和原 Standalone Main 两次实际启动 **1/1**通过，各组重叠、不相加，最终均零失败和零跳过。类型、boundary、license、格式和 diff 检查通过；原失败夹具日志保留，产品批准和事务条件未放宽。统一证据为 `output/extensions/checks/native-task-execution-proof-20261004.json`。

实际 factory 测试的身份/PDP、peer readiness、个人测试积分和报价为明确具名夹具，没有 Worker、模型、供应商或真实资金调用；原 Main 回归没有打开新任务配置。Main/Electron FileIssued opt-in、HTTP 任务读取的独立授权、Native 短剧生成/查询与三类恢复、真实资金/价格/结算、可用 ComfyUI 在线 S0、打包完整链路和 E5 尚未完成。原 UI/用户栏/设置/侧栏源码与正式资产、冻结 SDK tarball、生产映射及短剧 8/9/10 包摘要一致；Host 类型脚本曾隐式重建 SDK，但未改变 SDK 源码或冻结包。本轮未重建前端、未更新用户配置、未重新轮询原 ComfyUI，原用户服务保留，设置页再次实际打开。

## 2026-10-04：共享安装任务核心与 SQLite 执行机制

将原 Production 任务、生成和查询的实际 Application/owner 装配提取为共享核心，支持原 SQLite/PostgreSQL 并借用实际签发的 request owner；宿主显式提供 profile、授权和报价。Production 身份、严格配置、peer 与 HTTP authority 保留。核心不创建钱包、资金或身份，metadata-only 仍不能执行；关闭等待真实操作，迟到读取拒绝，真实 COMMIT 保留原 opaque 成功回执。Native Main 的执行 opt-in、生成/查询 owner 和三类恢复尚未接通，不能因共享机制完成而标记短剧可执行。协议与验证范围见[共享任务核心](./installed-plugin-task-runtime-core.md)。

新真实 SQLite **10/10**、原 requests **9/9**、查询前置装配 **5/5**、原实际短剧 5.0 ESM/PG metadata **12/12**和原 Production Main/Control/BFF/Worker 进程 **1/1**通过。既有双库组合首轮 **138 项通过**，一项旧 reader 前提缺失在 HEAD 也复现，补齐真实 metadata-only reader 后保留原错误和零 SQL/身份读取断言；首轮八项 ESM 跳过及默认组合两个 PG 跳过均已在后续实际专项执行，默认组合其余 **88 项通过**。组间有重叠，不相加，原失败/跳过日志保留。Control 类型、boundary、license 和格式检查通过；统一证据为 `output/extensions/checks/installed-task-core-proof-20261004.json`。

所有资金、定价、peer readiness 与供应商/模型响应仍为明确具名夹具，不是人类真实收费或 Native 在线执行。原前端、账户、设置、两侧栏、SDK、正式资产、生产映射与旧发行包摘要一致，当前用户设置页已实查仍可见；原服务保留。自有 PG 在全部测试消费者结束后正常停止并清理，旧进程 proof 恢复原字节。真实个人钱包/价格/结算、Native 付费入口及 Worker、可用供应商在线 S0、打包完整链路和 E5 继续按原目标实施；本轮没有再次调用原 ComfyUI 服务。

## 2026-10-04：Native 私有审批、Main 与选用恢复

原 Native factory 增加严格独立的 approval/bootstrap v2，`projects` 仅接受有界项目数据，v1 字段、序列化和无 opt-in 行为保持。Main 在原 Standalone SQLite 分支接入项目元数据、历史读取、图片选用与选用恢复，精确绑定实际 LocalActor 和本地 scope；每类 source publication 独立批准，纯预检先于 SQL/registry。恢复复用原 SQLite journal 和实际请求 owner，不授予生成、供应商查询、钱包或定价权限。原前端、账户、设置、两侧栏、共享 CSS、SDK 与旧独立发行包未修改，具体协议见[Native 接线](./native-plugin-history-integration.md)。

真实原 `main.ts` 集成 **1/1、零跳过**：同一文件 SQLite 上实际启动并物理停止两轮 Main，通过原 HTTP/ControlClient 读取真实已保存历史、选用第二张图片、保存 accepted 请求、冷重启读取原回执并显式原 key/输入/旧 CAS 重放。旧 mount/session 和错误 CSRF 拒绝，当前图片与原回执分别读取；accepted 日志保留首次 committed 回执及一次派发计数，业务原键重放仍返回 replayed。选用回执与 intent 各一条，effects 和具名 wallet 基线不变，没有新 Run、积分预留或 provider transport；两轮子进程及端口均实际关闭。

新私有 contract **16/16**、全 contracts **373/373**、原/新 Electron bootstrap **51/51**、Native startup/历史/选用/恢复 **38/38**、原 Native runtime/配置/安装/activation **36/36**、原 Electron runtime **44/44**通过，分组有重叠、不相加，均零失败、零跳过。Control API/Host 类型、Host 构建、boundary、license、格式与 diff 检查通过。原 HTTP 契约的路径冻结测试补齐此前已实现的 selection GET/PUT 路径，没有新增公共路由。Main 首轮夹具 Origin 被真实客户端拒绝，改用实际 loopback HTTP Origin；随后修正新测试对 accepted sticky 回执和计数的误解，产品协议和保护条件未放宽。统一证据为 `output/extensions/checks/native-project-startup-proof-20261004.json`。

Main 使用真实安装源字节、SQLite 和 HTTP，但审批、历史 target 身份、资金与 provider 结果为具名夹具，不是 packaged Electron/Main/preload/App 全链路或真实付费执行。未更新用户审批、安装选择、生产项目映射或收费配置。短剧 8/9/10 仍缺 Native mandatory 生成/查询 owner，不能因选用恢复接通而标记 ready。原服务保留；真实个人钱包/价格/结算、Native 付费生成/查询与 Worker、可用供应商的在线 S0、打包完整流程及 E5 第二个真实企业 API 继续按原目标验收。

原 ComfyUI 地址本轮只读重验：首页、`/queue` 和 `/system_stats` 仍返回 HTTP 404，没有生成 POST。证据为 `output/extensions/checks/comfyui-original-service-availability-20261004-native-startup.json`，不能把本轮 Main 历史/选用验证当作在线生成已跑通。

## 2026-10-04：Native 历史读取与选用的真实装配

已将原历史读取与选用 action owner 提取为共享核心，Native 使用实际 SQLite、`StandaloneIdentity`、安装审批和已绑定请求 owner；Web 保留原 Production 身份。显式项目读取配置增加独立的历史授权，核对持久 Run/binding、原安装准入和 principal/actor/profile/package。元数据、读取、选用批准独立，生成、供应商查询与资金权限仍未授予。原前端和 SDK 未修改。

新 Native **17/17**、既有 Native runtime **8/8**、其余 Native 边界 **39/39**通过；实际 SQLite/PostgreSQL 的生产历史/dispatch/恢复组合 **35/35**与装配 **26/26**通过，均零跳过。新增证据包含真实 HTTP 路由、冷重开、原 key 重放、实际版本切换、迟到读取拒绝和选用 COMMIT 后关闭保留成功。源 UI 文件与摘要真实验证；原历史 target 身份、余额和供应商结果为明确具名夹具，不扩大为 Native 在线付费验收。具体权限、兼容和验证范围见[接线说明](./native-plugin-history-integration.md)。

这些能力目前需要可信程序装配；Native Main/私有审批配置及恢复 journal 尚待接入。mandatory 恢复服务缺失时的实际拒绝启用测试通过，短剧 8/9/10 没有被伪装为可执行。本阶段不更新生产项目映射、用户安装选择或收费配置；真实身份/价格/结算、可用供应商、完整在线 S0、Native/打包全链路和 E5 仍未完成，完整目标保持进行中。

## 2026-10-04：独立短剧 10.0.0 不同来源原请求逐条恢复

已修复三类 UNKNOWN 分属不同保存输入时无法恢复的互锁。插件内新增最多三条原请求的“查看原输入”和“重试这条原请求”：查看只读，重放保留完整原请求和旧 CAS，剩余原请求不会自动切源。撤权、提示变化及迟到读取均撤回本地选择；新写与导航等到实际写调用结束才解锁。SDK 取消 UI 等待后，单次挂载内仍跟踪原 Host 写 Promise。具体范围见[逐条恢复说明](./short-drama-multi-source-recovery.md)。

52 文件仓外消费者的严格编译与自持构建通过，发行 ESM **88/88**、原插件组件 **21/21**、CommandWorkspace 窄回归 **139/139**，零失败、零跳过。真实 Host verifier 核验七个声明文件，10.0.0 packageDigest 为 `sha256:51f06e43aa10b2f4d062a53f85f6a7787660878177faf224545377a609820a8c`。独立浏览器夹具使用真实发行 ESM 和原应用公开主题，验证三条原请求分别精确重放一次及确认后的正常编辑；不扩大为完整 App、Native 或在线付费链路。原 App/账户/设置/侧栏保护文件、正式构建资产、插件 CSS、SDK 和旧发行包摘要一致。用户原设置页已实查，原服务保留。

此次未更新用户批准或生产项目映射，下面 9.0.0 配置与完整 Web App 证据保持其原范围。真实部署、个人钱包/定价、可用供应商、完整在线 S0、Native 和 E5 仍未完成，目标继续进行。

用户提供的原 ComfyUI 地址本轮只读重验：首页、`/queue` 和 `/system_stats` 仍返回 HTTP 404，没有生成 POST。证据为 `output/extensions/checks/comfyui-original-service-availability-20261004-ui10.json`；独立浏览器夹具不能替代该在线服务验收。

## 2026-10-04：实际短剧与 Krea2 包的生产项目配置

已从真实短剧 9.0.0 与 Krea2 2.0.0 交付包生成完整八项项目配置，固定 UI 来源、生成/查询目标、图片验证身份及三类原请求恢复。具体产物、身份与使用前提见[生产项目配置](./short-drama-production-deployment-review.md)。原 Host verifier、临时文件安装及公共业务 registration 前后复核通过，正式 Production 私有 loader 接受实际 `0600` 配置；同文件在 Standalone 被拒绝。临时安装根已清理，没有用户 profile/选择、Agent 发布、activation、数据库、Worker、模型、供应商或积分操作。

配置 SHA-256 为 `d4ee9463833a982a521e98639c94c4608a07c28d52dab0dd00ee726f15ccc83b`，证明为 `output/extensions/deployment-prep/short-drama9-krea2-20261004/verification.json`。14 个保护源文件、15 份正式 UI 资产、冻结 SDK 与旧短剧 8.0.0 包复核一致。动作名称是现有 Krea 适配器的明确部署选择，正式 owner 的运行时 action 检查继续保留；静态包和配置校验不证明执行就绪。

本轮用户原 ComfyUI 的首页、队列和系统状态再次实际返回 HTTP 404，只进行 GET；证据为 `output/extensions/checks/comfyui-original-service-availability-20261004-deployment-review.json`。真实身份/部署、个人积分资金/价格/结算、可用供应商服务、完整在线 S0、Native/打包版和 E5 仍未联合验收，完整目标继续进行。

## 2026-10-04：独立短剧 9.0.0 与原完整 Web App 重启恢复

9.0.0 修复同一保存来源的三类 UNKNOWN 原请求互锁：宿主允许重试时，用户可以显式重放确切原请求；实际在途请求、来源冲突、元数据写入和未就绪仍阻止重试，新写操作继续锁定。原 key、输入及全部旧 CAS 保留。新包在仓外使用冻结 SDK 离线严格编译、自持构建，发布 ESM **78/78** 通过；原 UI 四文件窄回归 **21/21** 通过。实际 Host verifier 核验七个声明文件，产物为 `output/extensions/installable-plugins/recovery-ui9-short-drama-20261004/short-drama/9.0.0`，packageDigest 为 `sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334`。旧 8.0.0 产物保持独立；原 App 的 14 个受保护源文件、15 份正式资产及 SDK 摘要均保持一致。

真实原 Web App、Production Main、BFF 和三个全新浏览器 profile 的联合用例 **1/1、零跳过**通过。沿原 index/AuthGate、账号菜单、设置页和真实安装挂载，cold hydrate 恢复三个原 UNKNOWN，业务 mutation POST 为零。用户明确重试原选用后，实际 installed selection owner 提交并返回 revision 1 回执；独立 journal 确认事务被故障触发器拒绝，原业务成功仍返回。另一次选用提交当前指针 revision 2 后，实际停止并重启 Main/BFF/browser，再显式使用原 key 重放：返回原 revision 1 回执，单独读取的当前选用仍为 revision 2。生成和查询仅完成真实 owner 的 stage 与 hydrate，未执行其业务动作。

证据为 `output/extensions/checks/plugin-ui-recovery-full-app-ui9-browser-20261004/full-app-parent-proof.json`，包含三次浏览器流程及设置截图、确切原请求/pin、stage ACK 时序、回执与独立当前指针、实际单连接池观测和清理终态。effects 的记录数量与具名 wallet 基线一致，Thread 数保持 2；这不是所有原付费历史字段的全量摘要验证。全部自有 Main/BFF/browser 已物理退休。上述分组范围不同，不相加为全量通过。

历史付费记录、图片结果、身份/PDP、余额与零工具 App catalog 均为具名夹具；catalog 仅用于原 App 的只读连接，不证明 Worker 部署或生成/查询执行就绪。本阶段没有在线 Worker、模型、供应商或真实资金调用，也未验收 Native/打包 App。完整 S0/E5、真实个人插件钱包与定价、既有 ComfyUI 404 问题的实际重验及第二个企业 API 仍待完成，完整目标继续进行。

## 2026-10-04：独立短剧 8.0.0 必需恢复声明与仓外产物

新包声明 `crewon.plugin-ui-recovery@1` 为必需服务，避免缺实际恢复端口的宿主先启用、再在模块 ready 前 hydrate 失败。模块复用原 Host 的三类上下文，无新增业务恢复调用；UI 源码、控制器和 CSS 未修改。旧 5/6/7 冻结产物及原 App/设置/侧栏继续保留。没有实际恢复服务的 Standalone/Native 当前不能启用 8.0.0。

Root 在新的仓外目录复制 49 个源文件，只将 SDK 依赖指向已验证的真实 tarball，使用 Node.js 24/pnpm 10 离线安装固定依赖；严格编译、自持构建及发布 ESM **67/67** 通过。完整独立产物为 `output/extensions/installable-plugins/recovery-ui-short-drama-20261004/short-drama/8.0.0`。实际 Host verifier 核验七个声明文件和清单，真实 packageDigest 为 `sha256:adbeaeba542f88daf1266543b3e423365e5300225e9c18ee66a932253dbe5562`；它包含清单/目录/文件身份，与单独清单 SHA256 不同。

原文件安装器在具名隔离根上确认 `installed` 和 `alreadyInstalled`，每次批准都核对确切包身份，再从实际安装字节复验；清理前恢复仅该夹具的目录权限，不改变原只读安装保护。没有创建用户 profile 的选择或 activation，没有 Worker、供应商、真实报价/积分操作。本阶段证据为 `output/extensions/checks/plugin-ui-recovery-ui8-proof-20261004.json`，实际 Main 三次恢复证据仍见下一节。

下一步使用此真实新包及确切摘要同步可信批准配置，联合原 Host、Production Main 和原完整 App 验证 ready 前恢复与三类原请求；ESM 和文件安装不是完整界面或在线生图验收。当前用户 3210/5730 仍运行原 Standalone，不直接改其启动模式或切换新包。真实个人钱包/价格权威、第二个实际企业 API、完整 S0/E5 继续待完成。

## 2026-10-04：正式 Production Main 配置与三次真实进程恢复

原 Main 已通过私有 `CREWON_PROJECT_COMPOSITION_CONFIG_PATH` 加载项目、生成/查询/选用及三类恢复批准，注入与原 Application 相同的真实动态 PDP。配置深冻结并核对每种原动作的完整 source publication；文件严格限制当前 OS 用户、单硬链接、私有权限、规范路径、64 KiB 和读取前后身份不变。未知身份、资金、URL 或代码字段拒绝。可选 `CREWON_CONTROL_DATABASE_MAX_POOL_SIZE=1` 传入原 Store，未配置保持旧默认；这两个新 opt-in 都拒绝 Standalone。缺少原 task/configuration reader 的历史读取配置现在在业务数据库打开前拒绝。原 App、用户栏、设置、两侧栏及共享 CSS 未修改。

真实原 `main.ts` 在同一隔离 PostgreSQL 上实际启动、正常停止并 join 三次，分别核验新 mount、旧 mount 失效、持久 realm/账户/完整原 pin，以及生成、查询和选用的原 key、CAS 和请求体。stage 的 SQL COMMIT 后丢失实际客户端 ACK，没有业务 invoke；冷读取仅 GET、不产生 Run 或费用。父 Store 和三个 Main 子进程均实际观测 `max=1`、`total<=1` 及成功 acquire，不能只凭父进程选项推定子进程池大小。

图片选用使用原 installed owner、实际核验的 Krea2 2.0.0 字节和不透明业务提交事实。SQL trigger 让独立的恢复确认事务失败后，HTTP 仍返回原真实成功，日志记录诊断；第三个进程读到原 UNKNOWN。显式使用原 key 重放核验后转为 accepted，返回原图片/回执且不覆盖另一次已提交的较新当前选用。生成与查询仅验证真实 owner 装配及三类暂存，没有执行 Worker、模型或供应商。

分组检查均零跳过，存在重叠、不相加：新配置/私有文件/pool **11/11**、实际 Main 负向启动 **4/4**、原环境/身份/PDP/项目 factory 兼容 **44/44**、真实三次 Main 恢复 **1/1**、旧 source registry **5/5**。类型、boundary、格式及 diff 检查通过。首次进程用例末尾失败来自只观察 Promise 而遗漏原 callback Pool.connect 的 acquire；随后新增 SQL audit 又遇到 pg 已解码的 JSONB 对象。两项只修观测夹具，保留全部实际池与 audit 断言；业务代码未为通过检查降级。统一证据为 `output/extensions/checks/production-main-recovery-proof-20261004.json`。

自有 PostgreSQL 49877 在全部消费者物理结束后检查 client backend 为 0，再正常停止；核验实际 PID 退出并删除准确数据/socket 目录。原用户完整 App 3210/5730 保持运行，设置页再次实际打开。测试身份/profile/PDP、原付费历史、图片结果和余额均为具名夹具，不代表生产身份或资金。

下一步发布声明必需恢复能力的新独立短剧包，并在原完整 App 中联合验收冷挂载、真实在线保存/生成/查询/选用和重启恢复。旧 5/6/7 包保留，缺恢复服务的 Standalone/Native 不切换到新包。原 `createThread` 仍不在三类日志内；多来源 UNKNOWN 的人工解冲突、真实个人插件钱包/价格权威、第二个实际企业 API、完整 S0/E5 仍未完成，完整目标继续进行。

## 2026-10-04：原请求持久恢复协议、SQL 日志与宿主接线

新增独立 `crewon.plugin-ui-recovery@1`，沿原 ControlClient、BFF、已安装挂载及业务动作保存生成、查询、图片选用的原请求。Host 首次 ready 前完整恢复三个通道；实际写动作先确认 stage 的 SQL ACK，再沿原业务 owner 执行。注册回复不明时不派发业务请求，冷恢复不自动提交，不换 key 或 CAS。旧插件没有声明时不增加恢复 I/O，原账户、设置、两侧栏、App 和共享样式本阶段没有修改。协议见[原请求持久恢复](./plugin-ui-durable-recovery-protocol.md)。

SQLite/PostgreSQL 日志复用原 Control 数据库和显式迁移，realm 持久保存；账户隔离使用真实 realm/tenant/space/principal，原完整 admission pin 保留。每账户最多 32 条记录，未确认请求不能淘汰；当前安装 pin、授权和调用活性在事务内复验，PostgreSQL 支持单连接池。accepted 只吸收原业务已经验证的不透明确认，图片第一次明确提交前 CAS 冲突才可能标记 refused。确认写入与原业务 COMMIT 仍是两个事务：确认失败记录固定诊断并返回原成功回执，冷恢复保留 UNKNOWN，需显式重放原请求，不能宣称原子恢复。

短剧控制器完整读取三通道后再恢复原保存输入，修复历史 accepted 来源覆盖另一来源 UNKNOWN 的竞态。多个不同来源 UNKNOWN 都保留并阻止重试；当前没有逐通道人工解冲突界面，不能宣称这类冲突已经可自助解决。此阶段不改既有 7.0.0 发布包；仓外新源码候选包只用于编译与发布 ESM 回归，尚未声明新恢复能力或替换实际安装。

审查发现原 SQL 规范化会抹掉字符串大小写和布尔分组，已改为触发器/函数严格保留字面量、括号及内部语句边界。两库通过实际 DDL 篡改证明大小写或 OR/AND 分组变化会使 schema 被拒绝，原 prepared 请求仍保留，不返回伪空记录。PostgreSQL 引擎输出的数值约束采用同值明确类型预期，仅为反序列化格式兼容，没有放宽保护规则。

分组检查通过，均零跳过，组间有重叠，不跨组求和：Contracts 新协议 **6/6**、ControlClient 全量 **177/177**、BFF 全量 **56/56**、Domain/实际双库日志 **30/30**、Application 新旧窄回归 **80/80**、Control 新旧窄回归 **43/43**、Host availability **11/11**、SDK 构建与分发 **57/57**、新 SDK 后 renderer/挂载回归 **167/167**、短剧来源与快照 **21/21**、原 CommandWorkspace/设置与样式 **153/153**。实际选用 owner、ControlClient、注册 HTTP 和同库 SQLite/单连接 PostgreSQL **14/14** 验证 stage 丢回复、关闭冷开、原 key 恢复、实际确认写失败及旧回执不覆盖新选择；该专项只覆盖真实选用业务 owner，未执行在线生成或查询 owner。SQL 专项另包含实际新 Node 进程读取三个原通道，不能代替完整 App 重启。

实际 SDK tarball 在仓外离线安装，公开恢复声明/类型严格编译及短剧候选包自持构建通过，发布 ESM **67/67**。相关类型、UI build/lint、boundary、格式及 diff 检查通过。统一证据为 `output/extensions/checks/plugin-ui-recovery-proof-20261004.json`，精确源码清单为 `plugin-ui-recovery-source-whitelist-20261004.json`。自有 PostgreSQL 61072 在全部消费者物理结束后正常停止，并核验准确进程、数据与 socket 目录清理；原完整 App 服务保留，实际设置页面已打开并确认正常加载。此前全量 UI 的九项失败与跳过记录仍保留，本阶段只声称限定回归通过。

当前实际装配仅支持显式 `createProductionPostgresControlApi({ uiRecovery })` 配置；正式 Main 尚未加载此配置或项目 owner，Standalone/Native 不支持付费生成/查询，不能把管理身份当作个人执行或付款权威。原 `createThread` 不在这三个日志动作内。身份/profile/PDP、原付费历史、钱包和报价使用具名夹具，不代表真实生产资金；本阶段无 Worker、模型、供应商调用或新增实际费用。下一步先接通正式启动配置与真实进程重启，再发布声明新能力的独立包并联合验收完整 App 在线保存/生成/查询/选用。真实个人插件钱包和价格权威、第二个实际企业 API、完整 S0/E5 仍未完成，完整目标保持进行中。

## 2026-10-04：独立短剧 7.0.0 图片选用与宿主恢复

独立短剧包在原概念图模块中增加确切图片的“选用这张图”、当前选用和需重新确认提示。控制器只通过公开 SDK 指定已保存输入、真实 operation revision、原始图片索引、元数据/选用 CAS 和原 key；当前指针单独 GET，不把旧命令回执作为当前图片。未知请求锁住编辑、切换、归档及新生成/查询/选用；首次明确冲突可以显式刷新真实版本后重新选择，已有 UNKNOWN 不换键。无选用 Host context 时保留原页面和旧快照。

通用宿主增加有界的独立账户 selection journal，复用原 Web/Native 客户端和已安装模块；不依赖任务线程或执行 runtime，不自动派发恢复请求。关闭 UI 后仍观察原物理回复，同包重新授权通过当前真实挂载显式重试，换包及换账户拒绝借用旧意图。公开恢复提示只包含原请求、状态及不可变回执，不携带当前指针或授权。协议见[图片选用协议](./project-generation-selection-protocol.md)。原 App、账号、设置、两侧栏、控件和共享 CSS 均未修改。

仓外消费者离线安装实际 SDK tarball，严格 TypeScript 编译及自持 ESM 构建通过；实际 7.0.0 新旧发布 ESM **67/67**、Host 与业务模块窄回归 **239/239**、原 CommandWorkspace/用户栏/设置窄回归 **145/145**，均零跳过。实际 7.0.0 ESM 的 DOM 点击沿真实 ControlClient、真实账户 journal、注册 HTTP 和同一 SQLite/单连接 PostgreSQL 验证 **8/8**，覆盖丢确认回复、关闭重开、原 key 显式重试、迟到确认、旧回执不覆盖新指针、输入过期、撤权和真实包替换；原 Production 专项 **6/6**。各组可能重叠，不跨组求和。UI build/lint、Control 类型、boundary、格式与 diff 检查通过。

独立产物为 `output/extensions/installable-plugins/selection-ui-short-drama-20261004/short-drama/7.0.0`，7 个固定摘要文件及 manifest 已校验，原 5.0.0/6.0.0 保留，插件原 CSS 摘要不变。统一证据为 `output/extensions/checks/project-selection-ui-proof-20261004.json`。首次 ESM 两项失败来自测试未退订已关闭 UI 和误要求 readiness 撤回后保留已隐藏 panel，仅修测试并加强重挂只读断言；首次实际双库两项失败来自测试遗漏原元数据 request 包装，仅修测试，发布业务字节未变。按 skill 的 `test -- CommandWorkspace` 未限制 Vitest 范围，意外执行全量 UI：**3847 通过、9 失败、39 跳过**，失败仍为此前记录的 TranscriptWindow/catalog、旧 shell/office 快照、协调依赖及 soak；正确指定过滤的窄回归通过，没有改动这些既有断言或声称全量 UI 已绿。

自有 PostgreSQL 62070 在全部实际消费者结束后停止，并核验进程、准确数据目录与独立 socket 目录清理；首次启动仅因 macOS socket 路径过长失败，改为自有短路径后使用同一隔离集群。原完整 App 服务保留，实际用户标签已再次打开原“常规”设置页，屏幕证据为 `account-settings-live-20261004/settings-verified.jpg`。

本阶段的原付费历史、身份/profile/PDP、积分和报价均为具名测试夹具，没有在线 Worker、模型或供应商调用，也没有新增 Run 或费用。完整目标继续进行：同一次完整 App 在线保存/生成/查询/选用、进程重启后的 UNKNOWN 持久恢复、真实个人插件钱包与价格权威、第二个企业 API、完整 S0/E5 仍未完成。下一步优先补原请求的持久恢复，再联合验收完整应用链路。

## 2026-10-04：确切图片选用服务与双库事务

新增独立 `crewon.project-generation-selections@1`、GET/PUT 公共服务和严格 SDK，用户只指定已保存输入、确切 operation/revision/resultIndex、元数据 CAS、独立选用 CAS 和原请求键。服务端核验原付费生成、配置、准入、任务回执及原始结果，再原子保存不可变 OperationResultLink、独立当前选用指针和不可变选用命令回执。旧 key 重放返回原回执，不覆盖较新的选择；修改创作输入后保留旧选用并标记需重新确认，项目重命名不使图片过期。细节见[图片选用协议](./project-generation-selection-protocol.md)。

HTTP 认证命令与已安装插件 UI 明确分支；实际 UI owner 在同一 SQL client 锁定真实安装 pin，读取历史只需原配置与 Run 读取范围，不要求新的执行 Peer、会话或积分预留。独立 schema 与部署批准默认关闭，未知或部分 schema 拒绝使用。选用不访问供应商，不创建 Turn/Run，不修改原元数据版本或原生成槽位。ComfyUI 的 URL 与输出目录检查保留在纯供应商适配器；通用层与公共客户端的显示文件名规则保持一致，避免存储提交成功后回执被拒绝。

分组检查零跳过，组间重叠，不跨组求和：新 Contracts 19/19；完整 SDK 54/54，含真实 tarball 仓外安装、严格编译和安装后 ESM 消费；Client/BFF 新旧窄组合 39/39；Domain/Store/实际 Application 双 SQL 新旧窄组合 241/241；Application 全部 514/514；Control/Host 新组合 45/45、原 Control 窄回归 105/105。实际 SQLite 和 PostgreSQL 单连接池验证包含二图切换、旧回执与新指针、历史输入、原付费证明破损、部分 schema、事务回滚、真实锁等待及 COMMIT 后撤权仍保留确认结果。相关类型、生成协议、boundary、格式和 diff 检查通过。一次 Host 类型脚本误触 SDK 重建造成并行 Control 类型检查缺声明，待构建物理结束后以直接 tsc 重跑 Control/Host，两项均通过；最终 SDK 由 Root 串行重新构建和打包。

统一证据为 `output/extensions/checks/project-selection-foundation-proof-20261004.json`，SDK 为 `output/extensions/checks/project-selection-sdk-pack-20261004/crewon-plugin-sdk-0.1.0.tgz`。自有 PostgreSQL 62261 在全部测试消费者物理结束后停止，并核验进程退出后删除准确临时目录。原完整 App 服务继续运行，主界面、账号、设置、侧栏与共享样式本阶段未修改。

此阶段尚未发布新的短剧包，也未接入页面“设为选用”控件或其丢回复恢复。实际权限、个人钱包、历史收费和 ProductionIdentity/profile/PDP 的测试使用具名夹具，不代表用户生产身份或资金。下一步是独立短剧控件与账户恢复接线；完整 App 在线生成、查询、选用及进程重启 UNKNOWN 恢复、真实个人插件钱包和价格权威、第二个企业 API、完整 S0 与 E5 门槛仍未完成。

## 2026-10-04：原操作查询协议与独立短剧 6.0.0

新增独立 `crewon.project-generation-queries@1`，严格只接受已保存输入三字段、确切 operation、原线程 CAS 和幂等键。实际 Control owner 从项目生成关联反查原付费历史；原 Query Task、独立当前执行包、历史配置与八字段目标保持原运行链路。查询侧记录与原 Turn/Run/绑定/回执在同一事务提交；两个当前安装 pin 在同一 SQL client 上锁定，支持单连接 PostgreSQL。原生成关联、积分预留、生成槽位及普通任务协议不变，部署批准与 schema 迁移默认关闭。细节见[原操作查询 UI 协议](./project-generation-query-ui-protocol.md)。

通用模块增加独立账户查询 journal 和只读查询上下文，复用原 Control transport 与 runtime 导航。UNKNOWN 保留确切原请求，未确认时不能换键；实际请求结束且 pin 匹配后才显式重试。生成与查询回执分开保存，接受查询后重新读取线程 CAS；账号变更同步撤回。查询上下文只读取已有会话，包括原生成控件准备的会话，不创建会话。原 App、用户栏、设置、两侧栏及共享 CSS 本阶段没有改动；仅新增查询控件快照，原快照字节保持不变。

短剧 6.0.0 在原模块和样式中增加每个确切 operation 的“查询原任务”按钮、查询受理状态、同键恢复及原保存源恢复；SDK 仓外 tarball 消费者严格编译，实际发布 ESM 新旧功能 55/55 通过。7 个固定摘要文件及 manifest 已独立校验，原 5.0.0 安装包保留。实际 6.0.0 ESM 的 DOM 点击进一步沿注册 mount/assets HTTP、原 RequestOwner/Peer、真实 Node 查询包 B、同一 SQL 与 issuer 验证新查询，以及丢确认回复、关闭重开、同键显式重试；SQLite 和单连接 PostgreSQL 2/2 通过。原付费 A 历史由原 Task Application 和真实 Node A 安装 pin 建立，该专项未执行旧 5.0.0 UI 生图，也没有在线模型、Worker 或供应商调用。

分组窄检查均零跳过，各组存在重叠，不跨组求和：Contracts 26/26、SDK 27/27、Domain 37/37、Application 145/145、双库 Store 新旧 190/190、Host 111/111、Control 新 36/36 和原回归 150/150、原 Worker 查询回归 16/16、原 UI/生成/查询/设置/侧栏 220/220、原业务模块 10/10、独立 ESM 55/55、实际 6.0.0 HTTP/Node/双库 ESM 2/2。相关类型、UI lint/build、boundary、格式和 diff 检查通过。旧 Host query fixture 的 queued Run 已按原 reducer 推进到实际 dispatch 所需的 running；没有放宽权限、积分或产品断言。原全量 UI 九项失败和此前跳过记录仍保留，此处没有声称全量 UI 已绿。

统一证据为 `output/extensions/checks/project-query-ui-proof-20261004.json`；独立产物为 `output/extensions/installable-plugins/query-ui-short-drama-20261004/short-drama/6.0.0`。自有 PG 60201 在全部消费者物理结束后正常停止并删除准确临时目录，原完整 App 服务保留。身份、PDP、Peer、付费历史与钱包是明确具名夹具，不冒充用户生产资金或在线供应商。

完整目标继续进行。下一步是确切 operation/resultIndex 的图片选用及持久关联；完整应用进程重启后的 UNKNOWN 持久恢复、正式 Main/full App/packaged App 在线 Krea2、真实个人身份/插件钱包/价格权威、第二个实际企业 API 和完整 S0 验收仍未完成。

## 2026-10-04：实际用户栏、设置与原本地服务恢复

在用户实际标签核验了原 AuthGate/App 中的账户菜单与设置入口，并打开“常规”设置读取实际后端数据。当前标签位于 5730 原完整应用；此前 5719 前端单独预览缺少配对 Control 会话，不作为完整设置后端验收。使用既有本地开发配置启动原 Control、Worker/provider probe 与 Vite 编排，没有复制或输出凭据，没有提交模型任务或改动用户偏好。原账户、菜单与设置路由保持原布局。

屏幕与服务证据见 `output/extensions/checks/account-settings-live-20261004/proof.json` 及 `settings.jpg`。这确认实际登录页面与本地设置服务已恢复，不代表生产 PIM 执行身份、插件钱包和价格权威已选定。原服务继续运行。

## 2026-10-04：项目生成上下文与独立短剧 5.0.0

新增独立 `crewon.project-generation-contexts@1` 就绪检查，并沿原安装 source→target owner、Task Application、issuer、profile/PDP 与真实安装 pin 核验保存来源、CAS、配置和当前执行连接。检查不创建会话、Run 或积分预留；原 generateConcept 输入、回执及普通任务协议保持兼容。已知 optional 协议允许只读模块安装，不把缺失的生成 owner 视为服务可用。细节见[生成上下文与恢复协议](./installed-plugin-generation-context-actions.md)。

通用模块宿主通过原 Control 客户端显式准备任务会话，通过账户范围 journal 保留确切 source pin、保存引用、线程 CAS 和原请求键。Web/Native 共用有界物理请求观察；关闭或超时后仍核对真实晚回执，已发送失败保留 UNKNOWN。换包时保留旧意图但禁止新 pin 重试，账号变更同步撤回。接受后通过保存来源核对原 Run/thread/configuration，再沿当前 runtime 打开原任务；不把业务 UI pluginId 当成执行包的归属。

短剧 5.0.0 在原模块内增加已保存输入的生成按钮和恢复状态，保留原共享样式。未知请求禁止编辑、切换、归档和换键提交；重开模块恢复原保存来源。已有生成的同一版本需保存新修订后才能再生成。实际 SDK tarball 的仓外消费者严格编译后，以删除源码/依赖的发布 ESM 验证公开协议；旧 4.0.0 产物保留。

分组检查均零跳过，不跨组求和：Contracts **318/318**、SDK **40/40**、Application **90/90**、Host **66/66**、Control **89/89**，后者包括实际 SQLite/单连接 PostgreSQL 和 TLS HTTP 就绪检查及原付费提交回归；独立发布 ESM **44/44**，业务模块 **10/10**。最终 UI 相关接线、journal、会话、原用户栏/设置及 CommandWorkspace 回归 **238/238**，UI lint/build、相关类型、boundary、格式与 diff 检查通过。新快照仅涉及模块生成控件和已保存输入提示；原 App、账号、设置、侧栏和共享 CSS 本阶段无改动。

用户当前 5719 根路径继续提供 `bb93f1b79` 恢复的原 AuthGate/App，显式预览只在 `/plugin-preview.html`。2026-10-04 浏览器 inventory 仍报旧预览标题且设备锁定，未核验用户标签的实际 DOM 或真实登录后设置；不能以源码和测试替代这项屏幕验证。Control `/session` 的 503 不直接移除用户栏：已有效登录的用户仍可显示原账户与设置，只有 AuthGate 的实际身份初始化失败才会替换整个 App。此前全量 UI 九项失败仍保留。

本阶段证据为 `output/extensions/checks/project-generation-context-ui-proof-20261004.json`，独立产物为 `output/extensions/installable-plugins/generation-ui-short-drama-20261004/short-drama/5.0.0`。自有 PG 55815 已正常停止并删除准确临时目录，既有 UI 服务保留。测试身份、定价与积分是明确夹具，未冒称生产人类账号或供应商调用。发布 ESM 与实际付费 HTTP/SQL 尚未作为同一次完整 App 生成链联合验收；内存 journal 不代表完整应用重启后的 UNKNOWN 持久恢复。

完整目标继续进行。下一步仍包括原 operation 显式查询、确切图片选用及原请求的持久恢复；正式 Main/full App/packaged App 在线 Krea2、真实个人身份/插件钱包/价格权威、第二个实际企业 API 和完整 S0 尚未完成。

## 2026-10-03：独立插件读取保存生成，短剧 4.0.0 冷挂载恢复

完成独立只读 `crewon.project-generation-reads@1` 的 Contracts、SDK、Host 与 Production Control 装配。唯一动作只接受保存项目、资产和输入修订，由原不可变关联查找原 Run；沿原 UI invoke 返回有界 JSON，不增加 Node 服务、任务回执类型或供应商循环。原 14 个元数据动作和唯一 generateConcept 保持兼容。协议细节见[保存生成只读 UI 协议](./project-generation-read-ui-protocol.md)。

只读 UI 使用独立部署批准 `creativeProjects.generationReadUi.publications`，固定真实业务包、摘要和贡献；元数据或付费生成批准不授予它。默认关闭，optional 声明只保留模块，不使读取自动可用。Production 在实际身份/profile 的 configuration-only scope 内读取，捕获的原 reader scope 在类型与运行时均拒绝 execution preparation；读取前后复验当前身份、来源、原任务和 UI invocation。撤回或关闭拒绝迟到 JSON，清理等待物理操作结束，不改变旧 Run 或积分。

短剧 4.0.0 在已有模块内增加已保存版本的生成记录，使用原样式显示原 Run、operation 状态和原始图片索引。编辑、换版本、换项目和关闭会撤回旧请求；不可用与没有关联分别显示。新包在仓外离线安装实际 SDK tarball、编译并自持 UI ESM；旧 3.0.0 产物和既有服务保留。实际 4.0.0 原字节经验证安装后，由 DOM 操作通过原 Host HTTP 读取真实 SQLite 的测试历史；两个不同的真实 mountRef 冷挂载恢复同一 Run、operationRevision 和 resultIndex，原 Run/积分账户不变，Node 与供应商 transport 调用为零。

本阶段分组检查通过，组间不求和：Contracts 全量 **311/311**；SDK 全量与公开 tarball 仓外分发 **36/36**；Host 新读取及原桥回归 **39/39**；Control 新实际双库及 Production factory/restart/default-off **16/16**，包含这些新检查的原 UI/task/metadata/request-owner/HTTP 回归共 **63/63**；独立 4.0.0 ESM DOM **26/26**；实际安装 4.0.0 → Host HTTP → SQLite 冷挂载 **1/1**；原账号/设置及两个业务模块窄测 **31/31**，均零跳过。原 UI 构建、lint、相关类型、boundary 和格式检查通过。模块快照仅更新 ConceptWorkbench 两个业务状态；共享 CSS、shell、账号/设置源码及这些快照本阶段无改动。

实际双库专项使用隔离本机 PostgreSQL 18.6 和真实 SQLite；身份、profile/PDP、定价及既有付费历史是具名夹具，不是人类生产身份或供应商调用。Production factory 首次失败来自新 fixture 未传隔离 schema，随后安装恢复 fixture 缺少 authority epoch；修正自有 fixture 后重跑通过，未改 schema 检查或产品授权。独立模块专项不能替代真实安装专项，两类证据分别保留。

用户栏和设置继续使用 `bb93f1b79` 恢复的 5719 原应用入口，预览仅在 `/plugin-preview.html`。当前浏览器标签读取/刷新仍超时，无新的真实登录屏幕验收。空响应的 Control `/session` 503 来自 Vite 缺少配对开发会话配置；PIM 登录不会解除该分支。原全应用开发编排会产生固定 standalone 身份，不能拿它冒充本人执行身份；真实既有 Native 或 Identity/BFF/Control 配置尚未提供，没有复制凭据或创建新身份。此前全量 UI 九项失败仍保留，未声称全量 UI 或真实设置后端已通过。

产物与日志位于 `output/extensions/installable-plugins/generation-read-short-drama-20261003/` 和 `output/extensions/checks/`，统一证据为 `project-generation-read-ui-proof-20261003.json`。本轮自有 PG 55814 已正常停止并删除准确临时目录，用户 UI 服务保留。下一步仍是生成控件、真实能力与原线程准备、原 operation 显式查询、确切结果选用和原会话导航。真实个人身份、插件钱包及价格权威仍等待原选择；正式 Main/full App 在线 Krea2、第二个实际企业 API 和完整 S0 尚未完成，完整目标继续进行。

## 2026-10-03：恢复当前地址的原应用入口，并接通保存生成的只读服务

用户继续报告用户栏和设置缺失。对照改造前 `776484c57` 后确认原入口组件仍在，但用户当前 5719 根路径仍加载独立短剧预览，绕过原 AuthGate 和 App。现已纠正这一个开发入口：5719 `/` 使用正常 Vite 配置和原 `index.html → main.tsx → AgentPlatformAuthGate → App`，原 PIM 代理正常；独立无账号设计预览仅在明确的 `/plugin-preview.html` 加载。原页面组件、CSS 和快照未改，5720 和 5730 服务保留。修复提交为 `bb93f1b79`。

实际 HTTP 核验 5719 根路径只加载 `main.tsx`，显式预览只加载 `preview.tsx`；真实未登录 `/auth/me` 为 401，企微配置为 200。用户栏/设置相关窄测 **44/44** 和原 UI 构建通过。浏览器当前标签绑定及刷新超时，没有声称当前用户标签已刷新或真实登录后设置已经在屏幕核验。Control 会话尚未接通，后台设置可用性不因恢复入口而自动完成；此前全量 UI 的九项失败记录仍保留。

同时完成此前已开始的[保存生成只读服务](./project-generation-read.md)：公共 GET 和客户端只接受保存源三字段，由服务端原不可变 link 派生任务，复用原任务授权与保存的 operation 观察。读取不触发供应商、Run 或积分操作；历史读取不比较当前 CAS，归档仍可按当前权限读取。独立只读 enable 只检查既有 schema，不启用写能力；默认关闭。

本阶段各命令分别通过：公共 Contracts **308/308**、原 ControlClient 全量 **165/165**、新 Application **14/14**、原 Application 读取回归 **44/44**、真实 SQLite/PG 新读取 **30/30**、原双库 Store 回归 **64/64**、Control/BFF/装配/原读取专项 **53/53**，均零跳过；不同命令中的重复回归不跨组求和。相关类型、生成一致性、格式及 boundary 检查通过。自有 PG 55813 已停止并删除准确自有临时目录；用户 UI 服务保留。证据在 `output/extensions/checks/project-generation-read-proof-20261003.json` 和 `original-account-settings-entry-restored-20261003/proof.json`。

SDK/Host 读取及短剧生成按钮、真实能力与原线程准备、显式 operation 查询、确切图片选用仍未接入。真实执行身份、个人插件钱包和价格权威仍等待用户原问题的选择；正式 Main/full App 在线 Krea2、第二个实际企业 API 及完整 S0 尚未完成。完整目标继续进行。

## 2026-10-03：跨插件项目生成的实际 Host / Control 调度

已实现明确批准的业务 UI source → 独立执行 target 映射及实际 `InstalledPluginProjectGenerationOwner`。业务包继续使用原 registered UI context，目标包使用实际安装身份、字节核验、当前策略、声明动作和真实 Node 借用。UI-only 生成依赖由实际 owner 的受信 Host availability 提供；未知声明、错误 source/digest/contribution、缺少装配或 owner 关闭继续拒绝，不伪造 Node 服务或隐式授予执行。原普通任务动作和宿主页面保留原路径。

Application 新显式 `createPublishedProjectTaskFromPlugin` 兼容旧内部生成。两端实际安装选择在原 SQLite/PG 事务中核验，PG 固定顺序 `FOR SHARE` 两端 selection/package，再沿原 client 取得项目互斥和积分锁；两端停用、卸载、换包与生成互斥。项目/输入/需求摘要、CAS、执行准入、原消息/history/Run/个人预留/增强回执/link 同事务提交。事务前的完整 UI current 与事务内的身份/profile/PDP、字节、active 检查分离，真实 `maxPoolSize: 1` 无嵌套池读取。默认路径不增加迁移或项目读取。

Control 构造验证 task owner、任务服务、原 issuer 的同一配对和 issuer 已批准的明确映射，避免先收费后发现回执能力不匹配。实际目标 Node 仍通过原任务 ABI 提交；原 issuer 读取真实保存的任务事实及历史项目关联后签发原 context 的一次 opaque 回执。确认 COMMIT 后的元数据后改、两端卸载、撤权、挂载/owner/runtime 关闭不把已确认受理改为重试。重放保留一个 Run、一次报价和一次原个人预留。

local management/standalone 不支持付费项目生成；新增明确配置捕获在打开 SQLite/PG 前拒绝 `pluginGenerations`，直接 composition 也拒绝，desktop 原保护保留。本机管理身份不能静默派生个人执行、付款、报价或资金权限。

生成协议保持 `crewon.project-generations@1`、唯一 `generateConcept`、四字段输入和原六字段任务受理回执；沿现有 UI actions HTTP 路由，不增加公共任务 shape、action kind 或供应商状态机。协议及事务边界见[项目生成 UI 协议](./project-generation-ui-protocol.md)和[内部关联](./project-generation-link.md)。

本阶段逐命令验收如下。每组均零跳过；原 issuer/任务回归在不同命令中可能重复，以下组别不跨组求和，也不与历史阶段计数合并。全部日志位于 `output/extensions/checks/`。

| 检查范围                                                            | 最终结果 | 日志                                                                     |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Application 两端资格、内部生成兼容和原回执回归                      | 95/95    | `project-generation-publication-application-20261003.log`                |
| 实际 SQLite/PG Store 与单连接 Application 提交                      | 20/20    | `project-generation-publication-store-20261003.log`                      |
| 实际 PG 两端选择锁，停用/卸载/换包先后竞争                          | 12/12    | `project-generation-publication-locks-20261003.log`                      |
| 原双库 Turn、付费、准入、metadata/link Store 回归                   | 162/162  | `project-generation-publication-store-regression-20261003.log`           |
| 实际安装的 source UI → target Node → paid Turn → original issuer    | 24/24    | `installed-plugin-project-generation-owner-final-20261003.log`           |
| 原实际 installed task owner 回归                                    | 21/21    | `installed-plugin-project-generation-owner-task-regression-20261003.log` |
| Production UI runtime/HTTP、真实 SQL 与 CA 验证的 HTTPS profile/PDP | 10/10    | `production-project-generation-ui-integration-20261003.log`              |
| 原 issuer 与明确 generation 配置/映射                               | 42/42    | `project-generation-configured-issuer-tests-20261003.log`                |
| Control composition 与原装配回归                                    | 47/47    | `project-generation-control-composition-tests-20261003.log`              |
| 最终 standalone 开库前拒绝、原 metadata/desktop/request 回归        | 30/30    | `project-generation-final-local-guard-tests-20261003.log`                |
| Host 映射、availability、execution bridge 与原 task bridge          | 52/52    | `project-generation-host-bridges-tests-20261003.log`                     |

实际 Control owner 与 HTTP 专项均使用真实 SQLite 和隔离的本机 PostgreSQL 18.6，PG 父 Store 为单连接池。Production UI 的 profile/PDP 经 TLS 1.3、实际 CA 及主机名校验；HTTP 由原 ProductionControlApiIdentity 的 BFF/session 测试身份和原 Fastify 路由解析，生成经过真正安装的 UI-only source 与原 Node 执行 fixture，没有制造 UI context 或事务回执。报价、充值和身份/profile/PDP 都是明确测试夹具，没有调用供应商，也不代表人类生产账号、钱包或正式结算。测试 TLS 端点随专项清理，PG 由本轮原所有者统一收尾，用户 5719/5720 预览未作为测试服务改动。

Application/Store/Host/Control 类型与相关文件格式检查通过；Control 最终类型证据为 `production-project-generation-ui-types-final-20261003.log`。早期专项失败分别为测试把命令键与原任务增强键视为同一层、把 loadReceipt 的 replayed disposition 视为初次 committed；修正断言后保留完整 key/digest、回执内容及收费校验。真实 PG 锁观测最初读取事务缓存的活动快照，改为每次清除观测快照后继续验证真实阻塞 PID；没有改动产品锁序。原失败日志保留。

下一步仍是独立短剧页面的生成按钮、真实能力状态与原线程准备、按项目/资产/输入读取原生成、原 operation 的显式查询、确切结果索引与选用保存。独立短剧 3.0.0 当前只交付项目/需求/概念输入保存和历史。本阶段没有完成这些 UI/查询/选用流程、人类身份钱包、正式 Main/full App/packaged Krea2 在线生成，也未验收完整 production runtime factory 或真实 HTTP disconnect request-owner 装配。旧默认路径不自动开启，原页面 shell 不改；完整目标继续进行。

当前用户栏/设置问题仍在核对，没有完成真实登录后的设置验收，Control 缺失会话的问题尚未修复；仅有菜单或设置组件代码不能证明用户当前页面已恢复。以下历史页面验收不替代这次实际页面问题的确认。

当前 5719 实际 HTML 仍加载 `artifacts/short-drama-workbench-preview/preview.tsx`，其 composition 把账号与 Control 客户端显式置空。已另在 `http://127.0.0.1:5730/` 启动正常原应用 `index.html → main.tsx → AgentPlatformAuthGate → App`，仅进程注入已有公开 PIM 地址。真实未登录 `/auth/me` 返回 401、企微配置接口返回 200，原登录页无 JavaScript 异常；没有使用伪造身份登录。原应用构建和用户栏/设置/CommandWorkspace 窄测 **153/153** 通过，源码、CSS、旧快照及两个旧预览均未改。证据见 `original-app-entry-20261003/proof.json`、`original-account-settings-ui-focused-tests-20261003.log` 与 `original-account-settings-ui-build-20261003.log`。

首次按脚本传入 `--` 未限制 Vitest 范围，意外执行全量 UI，结果 **3659 通过、9 失败、39 跳过**；失败涉及 TranscriptWindow、catalog paging、组件协调依赖、旧 shell/office 快照及 soak 时间采样。保留完整 `original-account-settings-ui-tests-20261003.log`，没有修改这些断言或声称全量通过。实际用户标签仍因 CDP focus 超时无法读取；真实登录后的账户、后台设置及完整插件目录仍待合法会话接通后验收。

## 2026-10-03：实际 Host 元数据分发与独立短剧项目保存

Native/Production 在原父 Store 上显式接入项目动作 owner，部署批准固定实际插件、包摘要和贡献。UI-only 包可以声明必须可用的 `crewon.creative-projects@1`；原安装启用、恢复和同步发布复验实际 owner，未知声明和关闭后的依赖继续拒绝。没有增加 Node 服务、执行 peer、公共 HTTP shape 或项目隔离 namespace；数据仍归 tenant/space/principal，默认未开启路径保持原行为。

生产 metadata 请求复用真实 HTTP 身份/profile owner，独立于任务准备。最终读取重新核对身份，未知项目动作不触发 Worker preparation；写入沿用每次 invocation 的提交前资格，确认 COMMIT 后通过独立、不可伪造的 committed-metadata 回执交付。原任务回执和普通 JSON 后置检查保留，两类 owner 不授予彼此权限，关闭等待物理操作结束后再关闭父 Store。

独立短剧 2.0.0 包在仓外安装实际 SDK tarball 并构建，自持 React、UI ESM、图片和许可；只依赖公开 SDK。实际激活后才传 `pluginUiReady=true`，默认读取真实项目，提供新建、需求版本、归档/恢复和冷挂载读取。草稿/主题更新不触发重复读取，冲突保留原文并要求确认，未知响应保留原键重试。服务不可用显示明确状态；原演示仅由可信预览显式开启，不冒充已保存数据。概念输入页面和生图仍待接线。

最终不重叠窄测 **259 通过、零跳过**：Application 78、Host 可用性/原安装恢复 45、Control 真实 SQLite/PostgreSQL 与原装配 53、原账号设置/模块与新 ready/UI 61、仓外编译 ESM 13、实际安装 UI→HTTP→SQLite 冷恢复 1、原 installed UI 双库回归 8。实际安装专项从 Host HTTP 读取并核验编译 ESM，再由 DOM 操作创建项目和两版需求；关闭真实 runtime，使用同数据库/安装根启动新实例并加载新模块，恢复同一记录。PG 使用实际隔离本机 18.6；身份/profile/PDP 是具名测试服务，不能据此宣称生产账户或正式 App 验收。运行期间没有供应商、生成 Run 或积分调用。

Application/Host/Control 类型、UI lint 与正式 build、boundary 和仓库格式检查通过。外部包首轮测试失败来自创建 fixture 的时间戳违反真实响应契约、必选依赖断言遗漏及冷挂载计数基线；只修测试并保留原文/CAS/恢复断言。新增安装 UI 测试的 DOM NodeList 类型改为 Array.from，未放宽 tsconfig。证明、失败日志、独立包位置及自有资源清理见 `output/extensions/checks/creative-project-host-proof-20261003.json`。

用户报告的原账号栏与设置仍从展开左栏后的左下账号菜单进入。5719 实际返回的当前 Vite 模块包含未登录 footer、真实设置状态切换及原设置组件；本轮 37 项该路径测试与构建通过。宿主 shell、CSS、原账号设置组件和旧快照没有改，5719/5720 原服务保留。Mac 锁屏且浏览器绑定超时，没有新的屏幕证据，也未声称用户当前标签已刷新；已询问消失的具体位置以继续定位。

下一步仍是概念输入页面、项目生成与原 Run/个人冻结同事务关联、已核验结果选用。真实用户执行身份/积分后端归属仍等待用户选择；正式 Main/full App/packaged Krea2 在线生成及历史查询、第二个实际企业 API 未完成。完整目标继续进行。

## 2026-10-03：项目动作协议、独立 SDK 与提交前资格

在上一阶段公共项目服务基础上，新增 14 个严格 metadata 动作及 `createPluginCreativeProjectClient(services)`，沿用原 UI invocation，不新增 Node action kind、HTTP shape 或数据库 schema。协议复用公开 DTO，输入最多 24KiB、响应最多 60KiB，不能传入账号、付款或凭据。SDK 实际 tarball 在仓外离线安装，纯 ES2022 contracts 与 DOM UI 独立编译，三个公开入口和 29 个自持声明通过验证；helper 固定实际 dispatcher/caller signal，取消后不交付迟到响应。细节见[插件项目动作协议](./installed-plugin-creative-project-actions.md)。

实际本次 invocation 可由可信 Host 捕获不可序列化的提交资格，六个 Application 写用例及四种 Store 提交显式传入可选 options；缺省公共路径保留原行为。Application 在授权、回执和业务读取后复验；SQLite 保持同步事务，PostgreSQL 在全部 SQL 后重验并紧邻 COMMIT 做同步检查。关闭、过期或已观察到的撤权拒绝尚未派发的提交，业务记录和回执整笔回滚；已确认 COMMIT 保留原成功回执。观察到动作 policy deny 只撤回这次 registration，恢复 allow 也不能恢复旧 guard；原 mount、asset 和 invoke 权限继续独立判断。该边界不保证远端策略与数据库全局原子性。

新增专项 **49/49**，合并 Contracts 全量 **288/288**、SDK 全量 **20/20**、原 Application 回归 **74/74**、新增 invocation/双库/API 资格 **26/26**、原双库项目 Store **26/26**、公共路由与原装配 **30/30**、原用户栏/设置/预览 **34/34**，不重叠合计 **498 通过、零跳过**。PostgreSQL 使用实际隔离的本机 18.6 集群，包含锁等待撤权、回执后的撤权回滚与已确认提交恢复；供应商、账号、充值、定价和结算未调用。测试以真实 SQLite 与实际 PluginUiApplicationService 验证，但不是正式包安装或生产用户的页面保存验收。

Contracts/SDK/Application/Store/Control 类型、生产与开发许可证、UI lint（含 Main 类型）、原 UI build、boundary 及仓库格式检查通过。SDK producer 独占构建和 pack，其他消费检查等待完成后执行。首次 SDK 分发失败来自新负向 fixture 的注释位置，修正位置并保留全部断言；一次原权限分离测试发现 blanket deny 撤回 mount 改变既有行为，已缩小为本次 invocation 撤回，原测试和快照均未改。日志与集群清理证据见 `output/extensions/checks/creative-project-invoke-proof-20261003.json`。

用户当前 5719 服务实际输出未登录账号页脚和原设置回调，入口是展开侧栏后的左下账号菜单。该独立预览未挂正式 AuthGate，因此没有真实用户名和在线设置数据；desktop/mac 参数不移除入口。定向 DOM/快照测试与原构建通过，Renderer、CSS、预览与旧 UI 快照本轮未改，5719/5720 原进程保留。当前电脑锁屏且浏览器绑定超时，未取得新的屏幕证据，也未声称当前标签已刷新或设置已在屏幕打开。

本轮完成协议与提交检查前置，尚未实现正式 Host dispatcher、UI-only 依赖可用性投影、激活 ready 或 committed-metadata 交付；原普通 JSON 后置 fence 仍可能拒绝已提交记录的页面响应，原幂等键恢复已验证。下一步按此顺序接 Host 和真实模块保存，再加入原 Run/个人冻结同事务的项目生成关联与已核验选用。真实用户执行身份及积分后端归属仍等待用户选择，正式 Main/full App/packaged Krea2 在线生成与历史查询、第二个实际企业 API 仍待完成。完整目标继续进行。

## 2026-10-03：短剧项目公共元数据与输入修订服务

项目、需求与概念图输入接通严格的公共 HTTP、ControlClient 和同源 BFF；14 个操作提供创建、重命名、归档/恢复、分页读取与不可变修订。公开投影省略 owner、tenant、space 和审计 actor，请求不接受这些字段。全部写入保留幂等回执及原事务，修改或追加使用明确预期版本；同键改输入、跨账号/空间、撤权和并发冲突均拒绝。服务没有生成、任意 URL 关联、选用或积分命令，读取历史不访问供应商。协议与接线边界见[项目公共服务](./creative-project-public-service.md)。

Standalone/Production 只在显式注入项目授权策略后迁移原父 Store 并注册路由，默认路径不触碰项目 schema。生产仍要求实际 ProductionControlApiIdentity；本机管理身份及测试策略不代表线上账号或付款身份。装配固定异步前的可信策略方法，保留当前撤权检查；启动失败与正常关闭共享原资源所有者，避免重复清理。原同步入口保持项目不可用，新增明确异步入口，不引入第二套运行时。当前 kind 只有 short-drama，数据归属不是 plugin/profile/package namespace，尚不能宣称任意插件的数据隔离已经完成。

单页最多 50 项、响应最多 60KiB；按完整记录和实际最后返回项裁剪分页，保存的需求文本不截断、历史不跳项。项目游标绑定列表状态，子列表 continuation 不宣称精确 hasMore。专用客户端默认 30 秒期限并固定 caller signal，取消或超时后不交付迟到结果；BFF 原目标路径检查、严格 query/方法、64KiB 请求、60KiB 正常/错误响应和 10 秒期限保持有界。原 HTTP/SSE、插件任务契约及其他路由的幂等限制未改。

新增专项 **66/66、零跳过**，含实际 SQLite/PostgreSQL HTTP 与冷恢复、可信可选装配、真实 BFF→Control→SQLite、契约及取消期限验证。合并 Contracts 全量 **277/277**、ControlClient 全量 **158/158**、BFF 全量 **48/48**、Control 装配与原默认运行回归 **41/41**，另计该组合未包含的双库项目 HTTP **14/14**，不重叠合计 **538 通过、零跳过**。PostgreSQL 使用本机隔离 18.6 集群；身份、授权和模型为具名测试服务，未接生产账号、充值、价格、结算或在线供应商。

Contracts/Client/Control/BFF 类型、生产与开发许可证、UI lint（含 Main 类型）、boundary 和仓库格式检查通过。Renderer、CSS、用户栏、设置及原快照均未改，原 5719/5720 预览进程保留；本轮没有启动 SDK producer、重新构建 Worker runtime 或声称 UI 全量通过。首次客户端/BFF 测试类型问题补齐明确类型；实际 HTTP 将重复幂等请求头合并成逗号列表，新增专用拒绝校验并保留原 400 断言。全量契约的准确路径清单新增十条路径，原断言与既有 API 语义保留。一次后续 HTTP 复验漏传 PostgreSQL 环境产生七个条件跳过，最终重新提供同一实际集群运行十四项，跳过记录不计完成。失败、范围和清理证据保留在 `output/extensions/checks/creative-project-public-proof-20261003.json` 及相关日志。

用户当前 5719 是没有真实账号数据的预览；原设置仍从展开侧栏的左下角账号菜单进入，不靠改样式恢复账户。当前浏览器连接超时，本轮没有声称新的屏幕核验。接下来把公共数据服务接入安装插件的 SDK/Host action 和模块内正式页面，再补原 Run/个人冻结同事务的项目生成关联及已核验结果选用。真实用户执行身份和积分后端归属仍等待用户选择；正式 Main/full App/packaged Krea2 在线生成及历史查询、第二个实际企业 API 仍未完成。完整目标继续进行。

## 2026-10-03：账号会话撤回与原用户栏核验

在接真实用户执行身份前，先修复已有登录会话的撤回边界。自动刷新、SSO 和开发登录共享一个真实在途操作槽，退出、显式登录和 PIM 变更同步撤回原 generation；实际 fetch/body 结束后才退休该槽。旧响应、401、网络和 body 错误不能覆盖新 token、清除新账号或使用新账号重试原请求。显式新登录不保留前一账号的 refresh token；退出后本页不会自动恢复登录。存储拒绝不会阻止内存撤回、PIM 清除或无凭据事件通知，也不会重新读入清理失败的旧凭据。

原 `/me` 与资源目录聚合持有同一实际会话，七个子请求及 `allSettled` 后重新检查，避免按 A 用户过滤 B 数据。登录、注册、企微交换、密码设置与用户读取在异步边界检查同一会话；生成企微授权 URL 的原只读行为保留。Web Control 的凭据查找、会话读取、后续 HTTP 和真实响应体消费均撤回旧会话，principal bootstrap/exchange 不能交付已撤回账号的 WebSocket 协议。初始 PIM `/me` 的旧消费端 catch 也不能清除后来替换的 PIM token。

这些 generation 只证明当前页面的会话生命周期，**不提供可信 actor、付款人、租户、空间或余额**。Native 本机管理 bootstrap 和固定管理 actor 保留原义。已有账号展示 DTO 不能推导执行身份；接现有平台或由 CrewON 新增身份与积分后端的选择仍等待用户答复，没有自行创建用户、资金、价格或权威服务。

153 项会话专项、187 项原 CommandWorkspace/用户栏/设置/预览回归，以及 140 项原插件任务上下文和 Thread streaming/replay 回归通过，不重叠合计 **480 通过、零跳过**。最后一组另复验 16 项已计入会话专项的行为，不重复计数。UI lint（含 Main 类型）、正式 UI build、boundary 和仓库格式检查通过；没有启动 SDK producer、重建 Worker runtime 或声称全量 UI 通过。新增测试使用真实 Response/ReadableStream、owner 与实际组件；供应商、生产账户和付款均未调用。初次失败为浏览器测试环境、相对代理 URL、同步重入监听清理和 React 提交等待夹具问题；已保留失败日志并修正自有测试。类型检查发现异构测试回调的 Promise 推断问题，补充明确的 unknown 类型。企微 URL 生成的提前撤回是新行为回归，已恢复原行为，原断言和旧快照未改。具体范围与日志见 `output/extensions/checks/account-session-proof-20261003.json`。

当前 5719 的用户栏和设置已实际打开核验：左侧栏展开后，从左下角“未登录 / 页面预览”账号菜单进入原设置页。没有修改 JSX 布局、CSS 或旧样式快照；预览不接账号和设置后端，设置数据不可用不代表页面被移除。更完整的旧目录复合动作和非 PIM UI 回调会话绑定仍需后续覆盖。本步骤不代表 Native 执行身份、线上积分结算、正式 App 的 Krea2 在线生成、短剧持久项目或第二个实际企业 API 已交付，完整目标继续进行。

## 2026-10-03：收费供应商新操作与原 Run、个人预占互斥

新增供应商操作在原父数据库事务中核对实际收费 admission、原任务回执、完整 binding、个人账户与冻结，以及当前 Run 的原 actor、空间、线程和执行路由。只有运行中、未取消、没有终态时间且冻结仍 reserved 才能登记新操作。SQLite 使用原 `BEGIN IMMEDIATE`；PostgreSQL 使用原个人账户锁，再使用原 Run advisory lock 和实际行锁，与原收费准入、取消、终态和账本操作保持互斥。调用方更换 binding digest、遗失收费链接、部分 schema 或未知版本均不能回退免费路径；两张收费 marker 都遗失时，原定价任务回执仍使新操作拒绝。历史真正未收费路径保持零积分迁移。

原操作准确重放不再授予提交许可；晚取消、撤权或结算后的查询和真实响应保存保留。原查询夹具现在先用原 Run 事件归约器提交 running，再登记保存的供应商证据；这些夹具不执行模型或供应商。数据库事务只保护新操作登记，已登记请求仍可能随后被供应商受理，不承诺撤销或退款。本轮没有增加自动结算。边界及后续账务证据要求见[积分生命周期说明](./installed-plugin-credit-lifecycle.md)。

新增专项 **49/49**（SQLite 28、真实 PostgreSQL 21），原 Store 积分/回执/历史查询 **102/102**，Worker 原 ComfyUI 与安装包查询/运行 **25/25**，Control 查询入口 **10/10**，实际 CLI/Worker/Control/BFF 进程 **5/5**，源码和运行包身份 **66/66**；不重叠合计 **257 通过、零跳过**。本次启用隔离的本机 PostgreSQL 18.6，实际验证取消先提交、新操作先提交，以及 settle/release 的原锁等待。生产进程专项运行真实 PostgreSQL，但权限、报价、资金和供应商仍是具名测试服务，不代表线上用户身份、资金或外部 API 已接通。

Application/Store/Worker/Control 类型、七入口桌面 runtime stage 与实际字节身份、生产许可证、boundary 和仓库格式检查通过。Renderer、CSS、用户栏、设置和旧 UI 快照未改，5719/5720 原预览进程保留；未运行共享 SDK producer，未重跑或声称全量 UI 通过。首次三项 SQLite 损坏测试被原外键拒绝，修复仅限自有测试连接的损坏设置，并恢复外键；PG 夹具的 UUID 默认参数补充 string 类型。审查发现的 PostgreSQL 免费路径提前返回已修复，并新增八项实际旧未定价/损坏 schema 检查，原断言全部保留。早期失败、最终范围和清理证据见 `output/extensions/checks/paid-dispatch-proof-20261003.json` 及对应日志。

下一步继续接独立真实用户执行身份和个人积分的权威资金、价格与结算。协调器还必须检查原 mutation Tool 回执和 Attempt/lease，不能用 external-operation 集合为空推导没有供应商副作用。正式 Main/full App/packaged Krea2 在线生成和历史查询、短剧持久项目与第二个实际企业 API 仍未完成；最近一次只读 ComfyUI 查询的 404 仍是历史证据，本轮没有重新查询或提交生成任务。完整目标继续进行。

## 2026-10-03：Native 显式模块启用与原业务激活

固定私有开启文件新增 v3，在 v2 的自动准备、原 CLI 发布和实际 Worker catalog 挑战之后，Main 才向本次 Control 签发私有激活输入。输入绑定完整包身份、保存配置、八字段部署目标、真实 loopback peer 和实际 Native profile；激活凭据与 Worker 既有权限引用分别捕获。v1/v2、未开启、全部候选受阻及 UI-only 路径保留原义。协议与限制见[Native 说明](./installed-plugin-native-runtime.md#显式启用与业务激活-v3)。

新的业务模块 enable 在准确 disabled revision 上调用真实 `prepareCandidate`，通过实际 Node 工厂借用与声明服务 IO 后，再准备本地 Node；实际 HTTPS `extension:activate` 决策在这些等待之后重新核验。写 selection/select receipt 前，同步检查进入原 SQLite 事务，使用同一父连接复核实际 profile 所有权、包、选择、latest 配置和完整部署。原 projection 在事务发布前仍不可读，新增的窄 ownership 检查只证明正在持有的真实锁。检查拒绝或意外返回 Promise 均回滚；重放不重新执行检查，回执不存函数。PostgreSQL 提供同样的可选同步端口，本轮条件用例仍未实际运行。

模块启用与业务 activation 继续分开。原 activation 用例保留授权、readiness、CAS 和幂等回执；已证明的错误目标或配置变化返回 409，未变化的普通 peer 故障仍保留原失败语义。Main 停止先撤回新工作，实际 HTTP/body 与子进程全部结束后才清理输入；清理核验原文件完整字节、inode、目录身份和子项，改写、替换或未知文件都保留并报错。没有新增固定输入监听、热重启、任务许可或付款许可。

实际 source Supervisor/CLI/Worker/Control/SQLite 新专项 **12/12、零跳过**，使用原 verifier 重新核验的两个独立实包。通过原 HTTP 完成专业包与 Krea2 的显式启用、业务激活、重放、停止和同库重启恢复；缺少 IO、私网配置、网络/包/激活权限撤回、真实配置及选择 CAS、部署丢失均拒绝旧操作。第三个真实 allow 决策的响应体被暂缓时，仅删除自有 SQLite 的准确 Krea2 部署，释放原正向字节后仍返回 target mismatch 409，selection 保持 disabled 且 select receipt 为零。真实 HTTPS body 等待中的停止等待实际 socket 与两消费子进程关闭，随后文件退休，并能重启同一停用配置。所有这些业务检查没有调用 factory.create、创建插件 Run、扣积分或请求生成；负向场景中的原普通 Agent 另行完成具名模型 Responses、原任务 HTTP/SSE 与同库 completed Run。

原 v1/v2、部分插件失效隔离、普通默认及物理关闭进程回归 **13/13、零跳过**。正式 Main/preload/file App 的原用户栏、十类设置、独立短剧 UI 安装与离线恢复、SQLite 业务首配和冷恢复 **2/2、零跳过**；这两项没有开启 v3 业务执行。截图与实际字节摘要位于 `native-activation-original-app-20261003/`。用户当前 5719 页面仍从左下角账号菜单进入原设置，相关 UI 专项 **91/91**；所有 Renderer、CSS 与旧快照保持本轮开始版本，5719/5720 原监听进程保留。

其余不重叠相关检查：Contracts 全量 **264/264**，桌面配置/owner/旧 Supervisor **208/208**，Control 新激活及原 Native/request/peer **73/73**，Application/Store **62 通过、17 个 PostgreSQL 条件跳过**。合计 **725 通过、17 个条件跳过**，不重复计入窄跑、诊断或首次失败后的复验。Contracts/Application/Store/Control/Worker 类型、UI lint/build、Main 构建、七入口 runtime stage 与字节身份、生产许可证、boundary 和仓库格式检查通过。未运行共享 SDK producer，未重跑或声称全量 UI 通过。

失败与修正记录保留：事务内原 profile snapshot 的 publication-pending fence 导致 500，新增只检查持有锁的接口并保留原 projection fence；错误目标与配置竞争的 private transport 错误需在 Native owner 核验真实事实后映射。部署晚变测试曾把排在自身 enable 后的 HTTP 读取作为等待条件，改为立即核对自有完整 SQLite 记录并释放响应；完整持久 selection 与公开 DTO 的比较补齐实际 scope、schema 与审计身份。多插件、重放和重启正例实际达到旧具名 authority 的 512 次记录预算；仅该新正例显式使用有界 2048 预算，所有旧例及另外十一例默认 512，产品 128 个并发槽和真实 10 秒期限未改。定位用的 Application/Worker 包装已移除。清理叶文件的遗漏补上真实文件系统拒删用例；旧 children 调用次序与夹具类型错误也已精确修正。详细范围、日志、实际包摘要、构建身份与物理清理记录见 `native-activation-proof-20261003.json`。

本步骤完成 Native 的显式启用和原业务激活接线，具名测试权限和模型不提供生产用户或付款身份。下一落地点为独立真实用户执行身份及个人积分准入与结算；正式 Main/full App/packaged Krea2 在线生成和历史查询、短剧持久项目与第二个实际企业 API 仍在原目标内。最近一次用户 ComfyUI 地址的只读查询仍为 404，本轮没有向该服务提交任务。完整目标继续进行。

## 2026-10-03：停用候选的真实 Node/IO 预检基础

Worker 私有 peer 增加独立 `prepareCandidate`，Control 提供对应内部客户端。实际 selection 必须保持 disabled 且准确匹配修订；同一父 Store 的 latest 配置、完整包身份与八字段部署目标必须匹配原发布。每次预检固定首次完整事实快照，跨权限、安装字节、Node setup 和 IO 等待反复校验。实际注册 factory 的最终借用之后同步返回，避免 peer 追加异步身份核验重新打开状态竞争窗口。普通 catalog/readiness 的 enabled 条件与历史 query 原义保留；旧 peer 拒绝新操作，不回退。协议与兼容说明见[任务启动文档](./installed-plugin-task-startup.md#disabled-candidate-preparation-on-the-private-peer)。

新 Worker 行为 **30/30**，合并原 Host/peer 回归后 **66 通过、2 个 PostgreSQL 条件跳过**；没有提供 PostgreSQL，不将这两项计为完成。覆盖真实安装 Node setup/factory borrow、同父 SQLite、Krea2 声明服务的实际 IO owner、latest 配置与准确选择修订、部署丢失、最终身份等待中的配置 CAS、撤权和取消后的物理清理。Contracts 全量 **252/252**（含 15 项新协议）；新客户端 **25/25**，原客户端 **18/18**。首次 40 项窄验的 15 项协议不再次计入合计。

真实 source Supervisor/CLI/Worker/Control/SQLite 新专项 **9/9、零跳过**，使用两个保留的独立实包，沿用原 HTTP 安装、首配和 v2 发布。专业包的旧 factory 兼容性不冒称 IO 可用；Krea2 实际 factory 借用和 IO 预检通过真实公共 IP DNS，缺少 IO、私网目标、网络/包撤权及真实配置/选择 CAS 均拒绝旧候选。保持停用选择，业务 activation、插件 Run/admission、供应商、外部操作和资金记录为零；每项原默认 Agent 另行完成真实 Responses、任务 HTTP/SSE 和同库 completed Run。真实 HTTPS IO body 挂起时停机撤回请求、等待 Worker 及 IO owner 终态后清理准备文件，并能按同一停用配置重启。原 v1、v2、单插件故障隔离与实际关闭进程回归 **13/13、零跳过**。

上述不重叠相关检查合计 **383 通过、2 个 PostgreSQL 条件跳过**。Contracts/Worker/Control 类型、UI lint/build、Main 构建、七入口 runtime stage、生产许可证、boundary 和格式检查通过。所有 Renderer、CSS、旧 UI 快照和原菜单/设置页面没有修改；5719 设置页仍可从左下角用户栏进入，截图 `original-settings-user-entry-current-20261003.jpg`。本轮没有启动共享 SDK producer，没有重跑或声称全量 UI 通过，也没有将 source 进程专项称为正式 Main/full App/packaged 执行。

首次失败记录保留：测试尝试覆盖同版本不可变部署，被真实 Store 拒绝后未释放 setup 栅栏；改为仅自有 SQLite 夹具的实际部署行丢失，并让栅栏与真实操作终态竞争、在 finally 中释放，全部拒绝与清理断言保留。旧自动准备快照要求 networkAuthority 为 null，新 Native 测试改用自有助手精确匹配实际网络及全部权限配置，旧 null 断言未改。UI lint 的数组推断错误补充显式类型。早期自有测试进程确认退出后仅清理两个固定 inode 的自有目录，最终夹具目录与实际子进程均已退休，用户 5719/5720 原进程保留。实际包再次通过原 verifier，记录和日志见 `native-candidate-proof-20261003.json`。

这是停用候选的后台基础，Main/Control 尚未把它接入显式启用和业务激活；预检不会调用业务 factory.create、创建收费 Run 或授予付款。当前用户 ComfyUI 地址的只读 `/`、`/queue`、`/system_stats` 均返回 404，没有提交生成请求，不能据此声称供应商在线或生成成功。下一落地点为 Native 显式启用前预检及原业务激活；独立真实用户执行身份、个人资金/价格/结算、正式 Main/full App/packaged Krea2 在线生成和历史查询、短剧持久项目与第二个实际企业 API 仍在原目标内，目标继续进行。

## 2026-10-03：Native 单插件准备故障与卸载隔离

Main 当前生成私有准备输入 v2，沿用同一个原 CLI、SQLite 与 HTTPS 权限核验。每个请求插件得到严格有界的 prepared/blocked 结果；卸载、未批准、缺少首配、业务配置不兼容、实际包字节不可用及读取权限撤回只阻止受影响候选。实际准备子集仍经原 v1 发布和 Worker/catalog 核验；全部受阻时不写 release，清除 installed/task/peer 及本次专用权限凭据，继续原普通默认发布和运行。身份、租户、profile、私有文件或未知权威协议错误仍整体拒绝。

prepared 结果逐项关联完整实际包身份、配置修订/摘要、批准要求和八字段目标，不能只匹配名称或数量。准备 CLI 重核发现竞争时移除受影响候选并有界重建；不承诺启动全程原子 latest 或隐式热更新。两个输出都原子不覆盖写入，失败只能删除自身 inode。即使全部受阻，Main 仍保留结果及输入所有者，等待实际默认子进程终态后才清理。旧准备输入 v1 及其整组拒绝行为保持原义。协议与复现入口见[桌面加载说明](./installed-plugin-native-runtime.md)。

新的真实 source Supervisor/CLI/Worker/Control/SQLite 专项 **7/7、零跳过**，日志 `native-installed-isolation-process-final-20261003.log`。通过实际 HTTP 卸载、未首配与 HTTPS 撤回包读取权限的三种场景，原默认 Agent 都完成真实 Responses 请求、原任务 HTTP/SSE 和同库 completed Run；每项只有一个普通 Run、一条 thread 和一次具名模型请求。真实独立 Krea2 包可准备和发布时，未首配的专业包单独 blocked，保留两个原停用选择；没有导入任一业务 Node，也没有模型或供应商请求。私有配置 0644、Native actor 与 profile 损坏在发布和正式子进程前拒绝。所有插件 task/admission/binding、供应商 IO、外部操作及资金记录为零；普通默认 Run 不作为插件执行证明。

原 v1/自动 v2/普通默认及物理关停进程回归 **6/6、零跳过**。Worker 新隔离、原准备与实际 CLI 前置拒绝 **37/37**；Contracts 全量 **237/237**；桌面配置与原/新自动 owner **101/101**；原 Supervisor、旧扩展、bootstrap、真实管道关闭和 installed children **88/88**。原 Worker 发布文档/loader/bindings/CLI/publication 回归 **50 通过、9 个 PostgreSQL 跳过**；未提供 PostgreSQL，不将这九项计为完成。正式 Main/preload/file App 原用户栏、设置导航、安装和业务配置冷恢复 **2/2、零跳过**，截图与证据位于 `output/extensions/checks/native-installed-isolation-original-app-20261003/`。相关检查合计 **528 通过、9 个 PostgreSQL 跳过**，不重复计入首次窄跑后又被 Contracts 全量覆盖的 27 项。

Contracts/Worker/Control 类型、UI lint/build、Main 构建、七入口 runtime stage、生产许可证、boundary 和格式检查通过。所有 Renderer、CSS、预览界面及旧快照保持开始版本；用户 5719 原页面已再次从左下角用户栏打开原设置页，最新截图为 `original-settings-user-entry-latest-20261003.jpg`。本轮没有启动共享 SDK producer，也没有重跑或声称全量 UI 通过；此前既有失败与 obsolete snapshot 仍按历史记录保留。

早期失败日志保留：新增错误类的参数属性被 Node 24 strip-only 拒绝，改为显式字段赋值；两项夹具类型错误补充明确类型。真实 Krea2 副本保留了源的 0755，触发 Native 私有来源检查；仅核验并调整自有副本为 0700，原实包与产品校验未改。启动失败时等待 catalog gate 的测试现与原启动异常终态竞争，保证立即进入原物理清理，原成功路径、超时及全部断言保留。早期超时残留在确认实际进程已结束后仅清理自有目录；最终相关进程和临时目录均为零，用户 5719/5720 服务保留，两个独立包再次核验原摘要。日志、计数和清理记录见 `native-installed-isolation-proof-20261003.json`。

该步骤完成准备阶段的单插件隔离。固定 v2 仍是明确操作者开启输入；具名权限与模型服务仍为测试服务。Native 实际 Node/IO 候选准备与激活、独立真实用户执行身份、个人资金/价格/结算、正式 Main/full App/packaged Krea2 在线生成和历史查询、短剧持久项目及第二个实际企业 API 仍未完成。下一落地点为真实候选 readiness 与激活，完整目标继续进行。

## 2026-10-03：Native 从保存配置和当前模型自动准备发布

同一固定私有开启文件增加 v2，列表中的安装包不再要求操作者逐项构造 source/derived 文档。Main 捕获实际模型、批准集合与持久 Native profile，建立自有私有输入目录，第一次运行原 `runtime-release` 只读取实际 SQLite selection/latest configuration、重新核验真实 HTTPS actor/profile/package/read-policy 及安装字节，生成原 v1 发布文档。输入错误和旧扩展冲突在默认工具构造前拒绝；原 issued 文件 pin 在正式准备前再次核对。Main 等待准备 CLI 物理关闭后，第二次原 CLI 才发布完整 default/source/derived bundle，无需前置普通默认发布。协议、边界与复现命令见[桌面加载说明](./installed-plugin-native-runtime.md)。

配置修订复用同一真实独立模型 source；derived 身份纳入实际 scope、包、完整配置和批准要求。凭据值、随机目录与临时文档路径不进入身份。较长合法 bootstrap 和 32 个实际安装条目保持既有 1 MiB 文档上限；新增有界 canonical recipe 保持旧小输入摘要顺序，避免误用通用扩展 JSON 的 64 KiB 上限。默认 Agent 的工具、工作区和模型目录继续由原发布路径编译，插件 source 不复用 shared 工具。

冻结后的真实 source Supervisor/CLI/Worker/Control/SQLite 验收 **6/6、零跳过**，日志 `native-installed-automatic-process-final-20261003.log`。原 Native HTTP 安装停用包和首配之后，实际 Agent 表为零即可自动准备和首次发布；交付来源离线仍从安装字节重建同一文档与 bundle。真实 PUT 保存 revision 2 不隐式重启，下次启动建立新 derived，旧资产、部署与原默认定义保留。撤回包读取权限则无新发布且不启动 Worker/Control。该组也回归原 v1 加载和普通默认进程。

一项新验收以真实 HTTPS proxy 转发、核验并暂缓原 actor 响应，没有构造 allow。第一个 preparation CLI 等待时实际 PID 存活，临时目录只有两输入、bindings 未写且发表表零行；stop 返回时该 CLI 已物理退出，随后自有输入与 bootstrap 清理，同一固定配置实际重新启动可 ready。另一项暂停原 private peer Response，证明实际 Worker 退出后仍等待 HTTP/body 挑战，才能撤掉三份准备文件及 bootstrap；并发 restart 等待原所有者退休。全程业务 Node、模型/供应商请求、Run 和资金记录为零。

本轮 Worker 新准备/实际 CLI 前置拒绝 **16/16**，桌面配置/owner **79/79**，原默认/旧扩展/bootstrap/物理关闭和 peer 检查 **94/94**。原 Worker 文档/loader/bindings/CLI/publication 回归 **43 通过、5 个 PostgreSQL 跳过**；没有 PostgreSQL 服务，不把这五项当作完成。正式 Main/preload/file App 原用户栏/设置/安装/配置冷恢复 **2/2、零跳过**，证明与截图位于 `output/extensions/checks/native-installed-automatic-original-app-20261003/`。UI lint/build、Worker/Control 类型、Main 构建、七入口 runtime stage、生产 license、boundary 和格式检查通过。本轮所有 Renderer、全局 CSS 和旧快照逐字节保持开始版本，用户预览的原设置入口也已实际再次打开。

原失败日志保留：首次 Worker 夹具以默认 text/plain 发送 JSON，被真实 authority parser 拒绝，随后只修夹具 Content-Type；类型检查也发现夹具环境的过窄推断，已显式使用环境 Record，未放宽产品协议。此前 UI 全量的八个既有失败及三个旧快照问题仍如下面历史章节记录；本轮没有重跑或声称全量 UI 通过，没有启动共享 SDK producer。

本轮相关检查合计 **240 通过、5 个 PostgreSQL 跳过**，范围和实际计数见 `native-installed-automatic-proof-20261003.json`。所有消费者结束后，具名夹具的临时目录与实际进程均为零；原独立专业包再次验证相同摘要，用户 5719/5720 预览继续监听，未清理或重启用户服务。

v2 仍是明确私有开启输入，具名权限服务仍是测试服务；安装及保存配置不隐式授予执行或付款。显式列表中已卸载或失效的插件当前拒绝这一开启模式，后续需完成单插件故障/卸载隔离，保持宿主原能力可用。Native 实际 Node/IO 候选准备与激活、独立真实用户执行身份、个人资金/价格/结算、正式 Main/full App/packaged Krea2 在线生成及历史查询、短剧持久项目与第二个实际企业 API 仍未完成。下一落地点是候选准备和宿主隔离，完整目标继续进行。

## 2026-10-03：Native 明确开启的安装包发布与 Worker 加载

Electron Main 增加固定私有 `desktop-installed-plugin-runtime.json` 开启输入，捕获当前实际模型、Native profile、批准 tuple、安装副本和完整操作者发布文档，沿用原 `runtime-release`、Worker 和 Control。新逻辑独立于旧扩展开启路径；未开启时保持原默认路径，无模型时仍提供原安装和配置管理。原用户栏、设置导航、页面组件、全局 CSS 和旧快照本轮未修改。输入、边界和复现命令见[桌面加载说明](./installed-plugin-native-runtime.md)。

Main 从实际 Worker 输出取得本次私有 loopback peer，用随机 token 挑战现有 v1 catalog，严格核对 requestId、完整 actor、profile、每项完整包身份、配置与执行目标；协议错误立即撤回。Control 不获得 installed task/peer 凭据或付款身份。停用包的空 catalog 只证明元数据加载，不能作为真实 Node/IO readiness。模块显式启用继续沿用原依赖规则，可选执行服务允许模块启用，但不授予业务执行。

实际 source Supervisor、原 Control/release/Worker 子进程和 SQLite 专项 **3/3、零跳过**：通过真实 Native HTTP 安装停用包并首配，构造操作者文档后由原 CLI 发布，完成真实 HTTPS 权限检查、私有握手及原 Control ready；交付来源离线后新 Supervisor 冷恢复同一配置和发布事实。撤回包读取权限时在发布处拒绝，不启动 Worker/Control且不改变数据库。全程业务 Node、模型、供应商、Run 和资金记录为零。模型与权限是具名测试服务，完整默认 bundle 来自先前一次普通默认启动；尚未自动从空库和原设置准备发布输入，也不是正式 Main 开启或 packaged App 执行证明。最终日志为 `native-installed-runtime-process-final-20261003.log`。

实际私有 HTTP 的原 Response 暂停交付时，stop/restart 等待物理挑战结束，保留 bootstrap 且不启动替代 children。即使实际 Worker PID 已消失，两个操作仍不能提前返回；释放原 Response 后停止和原 Control 重启完成。Native 子进程现在以实际 `close` 而非仅 `exitCode` 作为退休条件；真实 Node parent 退出但后代持有 stdout 的专项证明不提前删除其输入文件。退出不确定时继续保留所有者，不能用旧 PID 或文件推断已关停。

最终固定配置/运行 owner/peer 专项 **85/85**，原 default/legacy/bootstrap/关闭回归 **69/69**，原 Native 配置行为 **18/18**。正式 Main、原 preload、原 file App 的用户栏/设置/安装及业务配置冷恢复复验 **2/2、零跳过**，证明位于 `output/extensions/checks/native-installed-runtime-original-app-20261003/`；该复验没有开启 installed execution。UI lint/build、Main 构建、七入口 runtime stage、boundary 和生产许可证检查均通过。

早期误用 `pnpm test -- <files>` 实际跑了两次重叠的 UI 全量，分别为 **3473 通过、8 失败、5 跳过，共 3486 项**和 **3471 通过、10 失败、7 跳过，共 3488 项**，各有三个旧 obsolete snapshot，不能称全量通过。八个完整失败名、错误和首帧与前阶段相同；第二轮另有两项 localWorkspace 超时，随后正确隔离运行 **9/9**，不改写重叠全量结果。对照为 `native-installed-runtime-ui-early-baseline-comparison-20261003.json`，窄测试改用 `pnpm --filter @crewon/ui exec vitest run`。新实际测试最初误读安装 POST 回执形状，并将可选执行依赖误当作强依赖；按现有真实契约修正后通过，未修改产品依赖规则。只读安装副本的夹具清理失败也已修复，关停及实际 PID 结束后仅处理自有临时目录，保留原测试错误和失败日志。

下一落地点是从原设置的真实 selection/configuration 和当前模型自动编译发布，再接真实 Node/IO 候选准备和执行许可。个人资金/价格/结算、独立真实用户执行身份、Native/packaged 与完整 App 的 Krea2 在线生成和历史查询、短剧持久项目及第二个实际企业 API 仍未完成，完整目标继续进行。

## 2026-10-03：正式 Native 原设置与 SQLite 业务首配

正式 Electron Main、原 preload 和原 `dist/index.html → App` 已实际通过“用户栏 → 设置 → 工具与扩展”安装独立报告包并保存第一份业务参数。新 Main 进程在交付来源离线后打开同一 SQLite，原表单读回同一配置、修订 1 和回执，没有第二次 PUT。此次验收使用 Main 既有 source Control 子进程选项；不是 packaged `.app` 或在线供应商执行证明。实现、命令和范围见[桌面配置说明](./installed-plugin-native-configuration.md)。

Native 配置 owner 与原 HTTP 路由共用同一个真实 `StandaloneIdentity`，观察同一父 Store 的实际 SQLite profile 锁和文件标识。读取、新保存与旧回执之前均检查当前身份及权限；实际第二个 Control 接管替换 sidecar 后，旧所有者拒绝请求且不能破坏新所有者。真实协调器的结构复制、另一个 Store、相同值的另一权限实例或注册表在迁移前拒绝。凭据引用仍只读，非空引用不被当作已实现凭据租约。

原默认入口与旧 Worker 服务保留。Native 批准 ID 及实际安装账本保留的命名空间不能落入旧目录、任务、查询或旧回执，包括撤回全部批准和卸载后；同名命名空间启动拒绝。停用但仍选中的包可以配置。修复共享 Host 在停用状态换版本时误走 activation 准备的问题，仍验证新包字节与兼容性；启用继续走原生命周期及依赖校验，没有开放 Native 业务执行。

新的 `pnpm --filter @crewon/ui test:installed-plugin-native-configuration` 先串行构建正式 UI、七个桌面 runtime bundle 与 Main/preload，再通过唯一共享 SDK pack producer 在仓外构建两版报告包。实际删除开发源码、依赖和 SDK tarball 后才启动消费者，结果 **1/1、零跳过**。真实 HTTP PUT 含 Bearer、Origin、CSRF 和原请求键；SQLite 只有一份配置和配置回执，线程、Run、发布、activation 与外部操作记录均为零。无 provider 的事实来自实际凭据文件；网络计数明确只观察 Main fetch，不声称整个 Control/Renderer/SDK 零出站。日志为 `native-plugin-configuration-official-20261003.log`，证明和保存/重开截图位于 `output/extensions/checks/native-plugin-configuration-app-20261003/`。

最终配置行为 **18/18、零跳过**；共享 Host 全量 **209/209**；原 default/Native/legacy/source/shutdown 回归 **22 通过、6 项 PostgreSQL 条件跳过，共 28 项、零失败**。原正式 file App 与 Native 管理两项安装专项实际提供保留的短剧包及七入口 staged runtime，**2/2、零跳过**，日志为 `native-plugin-configuration-original-native-20261003.log`；该复验覆盖新增共享 tracker 的原调用方，不是 packaged `.app` 验收。Control/Host 类型、UI lint、boundary 与生产许可证检查通过。早期误用 Vitest 调用 Node 测试的空 suite 失败，以及 SDK 构建与 Control 类型检查重叠产生的声明读取失败日志保留；已用仓库实际 Node runner 及完成 SDK 生产后的类型检查复验，没有放宽断言。

按项目技能实际运行 UI 全量，**3387 通过、8 失败、5 跳过，共 3400 项**，另有三个旧 obsolete snapshot，不能称全量通过。全部八项完整失败名、错误及首帧和 obsolete 名称与上一阶段一致，证据为 `native-plugin-configuration-ui-baseline-comparison-20261003.json`。本次普通全量未注入实包环境，既有 Krea 两项及新 Native 一项条件跳过；原两项 Krea 随后使用实际保留包运行 **2/2、零跳过**，新 Native 由正式专项运行通过。这个跳过归因来自实际启动环境、源码条件和数量变化，compact 日志并未直接列出跳过名称。

原用户菜单、设置导航、首页/工作区组件、全局 CSS 和旧快照本轮均未修改。强杀后的测试清理现在等待真实子进程退场；仍将需要强杀视为生产关停失败，不用清理成功掩盖产品失败。测试 tracker 的实际正常退出与遗留子进程强杀退场另有独立 smoke 证据，不冒称产品关停验收。本次正式专项全部 Main/Control 子进程正常关闭，两个实际 Main PID 消失，消费者 userData 和 producer 临时产物已删除。5719 原进程继续运行；检查发现 5720 旧进程已经退出，已从保留的独立短剧包恢复新的预览进程，没有将旧 ready 文件或 PID 当作当前在线证据。清理及新预览的实际观察见 `native-plugin-configuration-owned-cleanup-final-20261003.log`。

下一落地点是 Native 明确开启的 installed release/Worker 组合，再接独立真实执行身份与付款准入。SQLite 的原发布、Worker 和任务存储基础已有；Main 当前固定本机管理身份并清理任务/peer 配置，不能给 `standalone-principal` 注入余额后冒充登录用户付费。正式 installed release 仍拒绝与旧扩展共用同 Worker，该边界保留。Native/packaged 的实际生成与历史查询、完整 App 的 Krea2 在线服务、真实账户/资金/价格/结算、短剧持久项目和第二个实际企业 API 仍未完成，目标继续进行。

## 2026-10-03：完整 Web App 的安装模块执行与冷恢复

正式 UI 构建的原 `index.html → main.tsx → AgentPlatformAuthGate → App` 已实际验收。原登录表单取得具名普通用户账号，原左下用户栏打开原设置导航，在“工具与扩展”读回真实安装包和配置；原 CSS 和设置 lazy CSS 实际加载。没有替换正式入口、注入 Control 客户端、Native 桥或改写宿主页面。完整专项及重复运行命令见[验收说明](./installed-plugin-full-app-acceptance.md)。

打开真实独立报告模块时 Thread/Run/预留/模型/供应商调用均为零；显式“创建任务”后只有一个 Thread。包内页面的一次动作经实际 BFF、production Control、Worker 和 PostgreSQL 创建一个原 Run，完整包身份、principal/actor/profile、配置修订 2 和个人预留持久化。实际报价 **30 测试积分**，预留 **一次**，供应商 **一次 POST**、模型 **两次 Responses**；报告包的原 ToolExecutionReceipt 为一条，SDK external operation 为零。

“打开任务”进入原任务页，实际 Run/Thread SSE 返回 200，原转录显示报告。Control、Worker 物理重启、新浏览器目录重新登录后，原侧栏恢复同一任务，模块读回已完成状态；Thread/Run/准入/绑定/预留/转录没有增加或被重写，供应商仍只有一次 POST。该证据证明实际流可打开、持久结果与冷恢复，不单独证明实时 delta 逐帧驱动 DOM，也不替代原运行时的重连/游标组件覆盖。

新增 `pnpm --filter @crewon/control-api test:installed-plugin-full-app` 先完成正式 UI 构建和唯一共享 SDK producer，在仓外构建两版报告包，实际删除开发源码/依赖/SDK 后才启动消费者，结果 **1/1、零跳过**。最终日志为 `installed-plugin-full-app-official-producer-consumer-sealed-20261003.log`；证明和十五张截图位于 `output/extensions/checks/installed-plugin-full-app-browser-sealed-20261003/`。首次三次失败分别为测试定位父/子 DOM 层级、空闲 SSE 的响应头等待及只读分页超过实际 16 项上限；均只修专项观测，原产品断言和旧快照没有放宽，失败日志保留。

UI lint、Control 类型、license 和仓库 boundary 通过。按项目技能运行原 UI 全量，**3389 通过、8 失败、2 跳过，共 3399 项**，另有三个旧 obsolete snapshot；不能称全量通过。完整失败名称、错误及首帧与前阶段相同，证据为 `installed-plugin-full-app-ui-baseline-comparison-sealed-20261003.json`。本轮新增的是独立验收入口和夹具，未修改原用户菜单、设置导航、页面组件、全局样式或旧快照。

实际七个正式产品子进程均以 0 退出，浏览器及子进程物理清理，独占 schema、连接、端口和临时目录检查通过；producer 临时产物在消费者结束后删除。Root 临时 PostgreSQL 的其他连接和剩余测试 schema 均为零，随后停机、确认 PID 消失、删除自有 root/socket 并重绑端口成功，记录为 `installed-plugin-full-app-owned-cleanup-sealed-20261003.log`。用户 5719/5720 预览继续保留，用户栏与原设置页已实际再次打开。

安装、选择、真实 HTTP 首配、唯一 CLI 发布和 activation 是明确的操作者前提，不是从空库安装到自动发布的产品闭环。身份、策略、资金/报价、模型和报告供应商均为具名测试服务，预留没有执行真实结算；专业报告夹具不替代 E5 第二个实际企业 API。正式 Native/Main/file/packaged 执行、完整 App 的 Krea2 原操作查询与在线生成、真实资金/价格/结算和短剧持久项目仍未完成。下一落地点是正式 Native 的 SQLite 业务首配，保留执行与付款的独立准入，目标继续进行。

## 2026-10-03：已安装模块的任务上下文与连续查询

原 `App` 通过通用宿主为声明 `crewon.tasks@1/@2` 的独立页面提供实际会话修订、至多八项公开任务和用户明确选择的生成操作。没有当前会话时，打开模块不创建 Thread/Run；点击通用“创建任务”后才使用原认证客户端创建目标并读取真实修订。新目标暂不切换 App 选择，业务草稿继续保留；点击“打开任务”才进入原会话。没有 Krea 名称专用的宿主分支，SDK、公开 HTTP 与持久形状没有改动，详见[任务上下文协议](./installed-plugin-ui-task-context.md)。

Web/Native 只观察当前客户端实际返回的完整六字段任务回执。同账号晚到 COMMIT 保存为有界恢复提示，模块重新读取实际任务、核对插件/会话/配置后才调用原 `ControlThreadRuntime.adoptExtensionTask`；原 Run、转录、SSE 和重连继续负责执行。缓存每账号至多三十二项、每插件八项，账号变更同步撤回清空，完整当前包 pin 才可作为当前模块接回。StrictMode 的同一所有者临时重挂不丢恢复提示，真实撤回仍失效。

同一客户端的元数据和创建请求共用一个实际物理槽及至多十六个等待者；取消和期限不提前释放尚未结束的 HTTP。排队期间退出或撤权后，创建 POST/确认 GET 在实际派发前再次拒绝，三项实际客户端回归覆盖这处竞态。已发送且结果未知的创建仍保留同一 body/key 重试。元数据暂时不可读时，同一所有者保留核验过的结果和来源、禁用新业务意图；真正切换会话、包或账号才撤回旧上下文。

Krea2 UI 确认受理后等待真实修订更新，再以新键连续生成或查询。未知结果锁定原请求和描述；查询始终引用用户选定的原 `sourceRunId/operationId`，不将查询 Run 当作生成来源。公开任务状态和 HTTPS 结果引用可见，不自动下载图片。独立 bundle 的真实 UI 单元专项 **18/18**，实际安装式 UI/Worker 的 SQLite/PostgreSQL 原查询重放、停用冷启动与 B 查询旧 A 专项 **6/6、零跳过**；原双库行为断言未改。两版当前产物位于 `output/extensions/installable-plugins/task-context-20261003/krea2/<version>`，不是已在用户生产 profile 启用的声明。

新的 `pnpm --filter @crewon/ui test:installed-plugin-task-context` 复用唯一 SDK producer，仓外构建后实际删除开发源码及依赖，再运行真实包/正式模块/原 typed 客户端/Runtime/SSE 的两项组件集成，**2/2、零跳过**。具名 HTTP 响应夹具覆盖显式创建、实际修订 1/2/3、连续原操作查询、`Last-Event-ID` 恢复及退出后的晚到 COMMIT；不是正式 Control server、真实 payer/provider 或 full App 验收。普通 UI 测试缺少包夹具时不运行这两项，空/坏目录硬失败；本轮专项和最终全量均实际提供包并运行。日志为 `installed-plugin-task-context-official-producer-consumer-final-20261003.log`。

最终通用接线与原任务流专项 **14 文件、106/106**，原工作区/Chrome/设置/样式/架构专项 **8 文件、114/114**。UI lint/build、boundary 通过。最终全 UI **3389 通过、8 失败、2 跳过，共 3399 项**，另有三个旧 obsolete snapshot；不能称全量通过。八项完整名称、错误及首帧仍与 `02b8856b4` 前阶段日志相同：TranscriptWindow 四项，线程目录/工作区/Office 各一项和 soak 超时；未修改这些旧失败或旧快照。日志为 `installed-plugin-task-context-{connected,original-ui,ui-full,ui-lint,ui-build}-frozen-20261003.log`，对比证据为 `installed-plugin-task-context-ui-baseline-comparison-final-20261003.json`。

原全局 CSS、用户菜单、设置导航和左右栏源文件逐字节保持本轮开始版本；新增样式仅通用任务控件的 CSS Module 和两份新快照。5719 浏览器实际再次进入原设置外观页，并验证 1280px 下左栏 232px、右工作台 480px，主内容占剩余 568px，不遮盖。证据为 `installed-plugin-task-context-original-shell-20261003.json` 和同前缀命令/工作台/设置截图。该页仍为离线预览，后端配置暂不可用，不能作为正式配置写入或在线生成证明。

全部实际消费者结束后，自有 PostgreSQL 核对其他连接和测试 schema 为零，停机、清除 PID/root/socket 并重新绑定端口；外部 producer 的开发目录及错误放置的自有 scratch 已删除，正式产物保留。记录为 `installed-plugin-task-context-owned-cleanup-final-20261003.log`；新增专项自身的 producer/consumer 临时目录也已清理。用户 5719/5720 服务继续保留。

本阶段补齐生产页面的通用接线与组件/双库验证。正式 Main/full App/packaged App 的实际生成与历史查询、真实身份/价格/资金及结算、短剧持久项目和第二个真实企业 API 仍未完成。用户 ComfyUI 地址的只读检查仍为 404，恢复地址与资金价格来源问题尚待确认；没有将夹具当作在线生成。下一落地点是完整 App 的实际任务路径，目标继续进行。

## 2026-10-03：原设置页中的通用已安装插件配置

原用户栏、设置导航、全局 CSS 和既有快照保持本轮开始时的版本。正式 `CommandSettingsRoute` 在已有“工具与扩展 → 已安装插件”卡片内增加“业务配置”，沿用原公共控件；没有新设置分类或插件专用宿主分支。仍选中的停用包可配置，卸载后入口撤下。旧的只接安装客户端的组件调用保持原 DOM，配置能力由正式设置组合显式传入。

表单先按真实选择摘要读取包版本，再匹配已认证目录的业务 schema。对象、数组、可选字段、字符串/枚举、数字/整数和布尔值均使用递归控件；未设置的可选字段惰性创建，不重复展开隐藏子树。UI 约束与原配置参数协议的 8192 JSON 节点/16 KiB 保持一致，合法稀疏数组、大值和原型形状属性名已有行为覆盖。新增纯 Domain `./workflow-schema` 入口使 Renderer 不引入 Node 类型。凭据槽或既有引用保持只读，不收集密钥或静默清空引用。

保存前后重核当前选择及包，沿用原 tenant/space 最新 revision；选择 B 时不把 A 的旧配置冒充 B 的配置。冲突保留草稿，结果未知时锁定草稿并保留同一 body/key 直接重试，成功后再次读取当前配置。账号或确切选择变化撤回晚到响应；其他插件的操作及选择未改变的安装回执不会清掉当前草稿。通知只是当前 typed 回执的本地刷新提示，不能授予权限。

实际 PostgreSQL/Chromium Web 设置专项 **1/1、零跳过**：真实 verifier/installer 字节与停用安装账本、生产 Control main/BFF main、具名 HTTPS 身份/profile/策略服务，原用户栏 → 原设置 → schema 表单完成一次真实 PUT，revision 1 和 actor 归属正确；设置关闭重挂、Control 物理重启及新浏览器均读回同一份配置。实际安装 Node ESM 导入为零，九张执行/发布/外部操作表零行，个人积分表不存在。六张最终截图使用正式构建的初始及设置 lazy CSS，另验证 **1280×640、860×640** 的表单和保存按钮可滚动到达、无横向溢出。日志为 `installed-plugin-configuration-ui-browser-layout-final-20261003.log`，最终证明与截图位于同名前缀目录。它覆盖原 Web 设置组件链，不冒充正式 Main/full App、packaged.app、真实企业登录或生成/收费验收。

最终原命令页/设置/插件组件专项 **22 文件、179/179**；Hook/schema/原安装与模块/架构专项 **6 文件、76/76**；Domain 全量 **203/203**。UI lint/build、全部 packages 与 Control 类型、七入口 runtime stage、仓库 boundary 及格式通过。全部消费者终态后才运行唯一 producer，packages 类型按 workspace-concurrency=1 串行执行。全 UI 按技能要求实际运行，**3338 通过、8 失败、2 跳过，共 3348 项**，另有 3 个 obsolete 快照；八项的名称、错误和断言位置与 `e898923cd` 的实际全量完全一致，没有新增失败。它们仍是 TranscriptWindow 四项、线程目录/工作区/Office 各一项和 soak 超时，不能称全量通过。另一个包依赖登记专项仍有三项既有失败，涉及本轮未改的 Host/Store/Control/Worker，未放宽清单。检查日志前缀为 `installed-plugin-configuration-`，位于 `output/extensions/checks/`。

所有专项消费者与自有 Control/BFF/Chromium/HTTPS 子进程已物理结束，测试 schema 和临时目录已清理。Root 的临时 PostgreSQL 在其他连接及测试 schema 均为零后停机，PID 已消失，自有 root/socket 已删除，端口可重新绑定；记录为 `installed-plugin-configuration-ui-postgres-owner-20261003.json` 与 `installed-plugin-configuration-postgres-cleanup-final-20261003.log`。用户现有 5719/5720 页面服务继续保留。

这完成已有真实安装上的原设置表单和持久配置路径。发布与启用仍显式执行；从空库安装到自动发布、完整 App 的真实任务上下文/生成和历史查询、凭据管理、真实积分资金/价格/结算、短剧持久项目与第二个实际企业 API 均未完成。ComfyUI 当前地址的首页、`/queue` 和 `/system_stats` 实测为 404，恢复地址问题仍待用户确认。目标继续进行。

## 2026-10-03：独立安装包的首次配置入口

已消除发布前首配依赖 Worker 的循环。生产 Control 可显式启用独立配置 owner，从真实安装账本的当前选择核验完整包和业务 JSON，提供原配置 schema，并通过原 HTTP 路由保存第一份配置；停用但仍选中的包也可配置。共享 Host 读取器不导入包的 Node/UI ESM、不分配工厂，不创建 Run、发布目标、报价或积分。完整任务 owner 复用这条元数据路径；启用及运行仍需要实际发布和 Worker 的原就绪核验。

首次保存先检查原 configure 权限与持久回执，只在没有回执时准备确切包版本；准备和验证后的权限再次核验。配置 GET、已受理配置/激活的回执重放不读取元数据，仍检查原权限和当前请求身份/profile。保存的配置及 activation 仍沿用原 v0 tenant/space 作用域。目录按当前选中包限制核验数量，卸载历史不占这一额度；历史扫描最多 32 页、每页 50 个命名空间，游标必须严格推进。关闭同步撤回能力，并等待实际元数据/网络工作完成后再关闭原 Store。

实际 PostgreSQL Control/BFF 子进程首配专项 **1/1、零跳过**：前置仅使用真实 verifier/installer 的不可变字节与安装账本，停用的两版包分别通过原 HTTP 保存 revision 1/2；换版并拒绝包读取后，原受理配置回执仍重放且没有新增包请求。此时没有 Worker、peer、release 或报价/资金服务，实际安装 ESM 导入为零，发布/activation/Run/operation 九表零行、个人积分表不存在，未发布启用返回 409。

随后由唯一真实 CLI 发布原 HTTP 配置，正式 Worker/Control/BFF 经原插件动作 HTTP 接口提交两版 Run；个人测试积分各预留 30、供应商共 2 次 POST、模型 5 次请求，幂等重放不追加预留，普通默认 Run 不含插件绑定。资金、报价、身份、模型和报告供应商均为具名夹具；两次预留仍未结算。所有测试子进程退出 0，独占 schema 与连接已清理。日志为 `installed-plugin-first-configuration-process-first-20261003.log`，证明为 `installed-plugin-tasks-process-proof-20261003.json`（v2）。

最终 Worker 全量 **1652/1652、零跳过**；Control 全量 **478 通过、1 项 Linux 进程用例在 macOS 跳过，共 479 项、零失败**，包含修改后的首次 HTTP 配置进程链。Application 全量 **343/343**、共享 Host 全量 **205/205**。新旧 Control 窄专项 **37/37**覆盖实际包、持久首配、当前身份/版本、物理关闭、卸载历史及明确容量；共享 Host 迁移专项 **14/14**及原读取/编译/物化回归 **54/54**也通过。

Native 环境隔离 **10/10**、原命令页/设置/预览 **17 文件、153/153**、UI lint/build、全部 packages/Control/Worker 类型、七入口桌面 runtime stage、仓库 boundary 与格式检查通过。SDK 构建在消费者启动前完成；Worker 及所有 Control/Host 检查都已实际结束后才再次构建 SDK。本轮没有修改页面组件、CSS、设置导航或旧快照；Native 仅额外清理生产配置 owner 的环境变量。日志前缀为 `installed-config-`，位于 `output/extensions/checks/`。上一节记录的全 UI 失败不能因此称为全量已通过，七入口构建也不冒充 packaged.app 插件业务验收。

本轮临时 PostgreSQL 清理前其他连接及测试 schema 为零；实际进程已退出，自有 root/socket 已删除，端口可重新绑定，记录为 `installed-config-postgres-owner-20261003.json` 和 `installed-config-postgres-cleanup-final-20261003.log`。用户现有 5719/5720 页面服务继续保留。

部署文件、严格权限及操作顺序见[任务服务启动](./installed-plugin-task-startup.md#control-configuration-before-publication)。这完成的是已有真实安装账本上的首次 HTTP 配置；完整产品配置 UI、用户从空库安装到自动发布、真实资金/价格/结算、正式付费历史查询进程验收、短剧项目持久化及在线生成、ComfyUI 当前服务与第二个真实企业 API 仍需继续落地。目标保持进行中。

## 2026-10-03：已安装插件任务的正式 Control/Worker 连接

已安装插件的业务动作现在可从原 BFF 会话进入正式 PostgreSQL Control，再由私有 Worker peer 核验实际安装包、配置与完整目标，最后走原 Application 的个人积分预留及 Run 事务。未配置时保留原默认 Agent、身份缓存及扩展路径；新旧执行装配不能混用。原宿主页面、CSS、设置布局与既有快照没有改动，Native 管理进程仅额外清理执行 peer 和任务配置的环境变量。

私有协议包含 catalog、配置校验、生成 readiness 及历史查询的两个操作。Control 为每个真实 HTTP 请求捕获作用域，关键等待前后重新核验当前会话主体与 profile，不接受页面传入的主体或保存 principal 作为授权。实际包的六字段身份与完整八字段目标逐项匹配，历史查询在 Worker 的同一父 Store 重读原 Run、个人预留、回执与外部操作；缺少原版本的真实物化时返回不可用，不替换为最新版本。目录允许明确配置与激活准备，不等于执行就绪。

配置、包许可与报价通过严格私有文件和明确的 HTTPS 权威接入；没有默认积分、充值或价格。逻辑超时不释放仍在进行的物理操作容量，关闭先撤回资格，再等待网络、请求与真实 Node Host 清理，最后关闭原 Store。部署及当前限额见[任务服务启动](./installed-plugin-task-startup.md)。

真实 PostgreSQL 的唯一 `release-main` 发布、正式 Worker/Control/BFF 子进程与原公开 HTTP 路径专项 **1/1**：两版页面动作各创建一个原 Run 并预留 **30 测试积分**，完整包与目标绑定持久化；同键重试没有第二次预留，缺报价创建 Run 为零，COMMIT 后 UI 撤权仍返回真实受理回执并拒绝下一次动作。两版供应商各 **1 次 POST**，模型共 **5 次请求**；普通默认 Agent 仍执行。所有正式子进程退出 0，独占 schema 清理为零。证据为 `installed-plugin-tasks-process-final-20261003.log` 和 `installed-plugin-tasks-process-proof-20261003.json`。

该进程证据明确依赖操作者预存的真实配置修订。发布 loader 在 Worker 启动前校验这些修订，因此首次安装后从页面建立第一份配置的准备入口仍缺失，不能把本轮 HTTP 配置读取与激活称为首次配置闭环。资金、报价、身份、模型和报告供应商均为具名测试夹具；未验收在线收费、完整历史查询子进程、积分结算或真实企业 API。

最终 Worker 全量 **1652/1652，零失败、零跳过**；Control 全量 **463 通过，1 项 Linux 进程用例在 macOS 跳过，共 464 项**；Contracts 全量 **210/210**。全部 packages、Control、Worker 类型检查、UI lint/build、Native 环境隔离 **10/10**、七入口桌面 runtime stage 与仓库 boundary 通过。SDK producer 完成后才启动本轮 Worker/Control 消费者。日志前缀为 `installed-peer-`，位于 `output/extensions/checks/`；这些构建不冒充 packaged.app 的插件业务验收。

原 CommandWorkspace、设置路由及预览专项 **17 文件、153/153**，保留既有快照。项目技能的 `pnpm --filter @crewon/ui test -- CommandWorkspace` 实际执行为 `vitest run -- CommandWorkspace`，没有筛选测试，运行了全 UI；真实结果为 **3277 通过、8 失败、2 缺少独立原生环境的用例跳过，共 3287 项**，不能称 UI 全量为绿。失败仍为原 TranscriptWindow 4 项、useControlThreadCatalog、AppWorkspaceContent、ControlCommandOfficeRoomAdapter 各 1 项及并行 soak 超时；soak 隔离 **4/4**。全量日志为 `installed-peer-ui-full-final-20261003.log`；随后使用明确的 `pnpm exec vitest run` 筛选专项，日志为 `installed-peer-command-settings-final-20261003.log` 与 `installed-peer-ui-soak-isolated-20261003.log`。没有更新或删除旧快照以使检查通过。

本轮测试 PostgreSQL 清理前其他连接为零、剩余测试 schema 为零，实际进程已退出，自有 root/socket 已删除，端口可重新绑定；记录为 `installed-peer-postgres-owner-20261003.json` 和 `installed-peer-postgres-cleanup-20261003.log`。用户现有 5719/5720 页面服务继续保留。

5719 当前版本再次从左下角用户栏进入原设置页并打开外观；截图为 `output/extensions/short-drama-preview/ui-settings-recovery/settings-visible-recheck-20261003.jpg`。该页面为离线预览，依赖后端的常规配置显示不可用；用户原标签连接超时，实际点通的是新标签，不能称原标签已刷新。

下一步仍按原目标补齐首次配置准备、真实资金及价格规则与结算、短剧项目持久化和在线生成、ComfyUI 当前服务及第二个实际企业 API。完整目标保持进行中。

## 2026-10-03：独立安装包的正式发布 CLI

原 `release-main` 现在可显式消费严格的已安装插件配置和发布文档。新路径要求明确的 OS 发布操作者，包读取许可与原 Application 的发布/部署许可分别核验；未配置时沿用原 CLI/default Agent。实际包元数据在模型或数据库构造之前读取，发布前再次核验真实安装账本、原配置修订、实际字节和当前读取许可。

原模型来源与派生 Agent 必须位于 main 将加载的同一完整部署集合，全文候选和版本冲突直接拒绝。通过现有 Application 发布不可变资产，随后只激活最终 bundle 一次；没有先激活原模型再切换插件的临时状态。原模型来源缺少实际 bindings 时不会凭空补造部署。发布与安装/启用、用户准入和积分分别处理。

原 profile/model-catalog 分支保留。新路径的生成 manifest 纳入明确的 source bindings，先暂存本次私有文件，再于真实 COMMIT 后核对原文件及当前 active bundle。旧 A 回执在 B 激活后重放只返回真实历史结果和不可用核验，不回写 B 的绑定文件；并发改写、撤权及晚关闭不掩盖已提交的 activation。资产发布、最终 activation 及文件发布并非跨系统单事务。关闭依次等待真实发布、文件、release 和权威操作，再关闭同一父 Store。

真实发布与 loader 双库专项 **30/30**，严格 CLI 输入 **11/11**，实际 CLI→Worker 子进程 **16/16**，文件/发布生命周期双库专项 **18/18**，均零失败、零跳过。子进程 setup 只准备真实安装、配置和内存编译文档；全部 Agent/部署/bundle 由唯一实际 CLI 发布。SQLite 验证两版完整 Run pin、供应商 **2 次 POST**和 default 兼容；另一个 PostgreSQL 子进程验证首次发布、重放、metadata 启动及原 default Run。身份、模型、供应商、资金额度和报价仍为具名夹具，不是在线收费验收。

最终 `pnpm --filter @crewon/runtime-worker test --test-concurrency=4` **1641/1641，零失败、零跳过**，使用本轮实际临时 PostgreSQL；唯一 SDK producer 完成后才运行消费者，Krea2 的 v1/v2 明确使用同轮仓外包。Worker 类型检查、最终七入口桌面 runtime stage、仓库 boundary 和改动文件格式均通过。日志为 `installed-release-worker-full-final-20261003.log`、`installed-release-process-first-20261003.log`、`installed-plugin-release-publication-20261003.log`、`installed-release-cli-composition-20261003.log`、`installed-release-cli-input-20261003.log`，位于 `output/extensions/checks/`。全部测试 child/server/temp 已关闭；本轮 PG 清理前其他连接及测试 schema 为零，实际进程已退出、root/socket 已删除、端口可重新绑定，记录为 `installed-release-postgres-owner-20261003.json`。七入口构建不冒充 packaged.app 的插件业务验收。

部署说明见[发布 CLI](./installed-plugin-release-publication.md)。Worker 启动仍不自行发布或发放积分。Control 正式业务动作与 readiness/query 桥、真实当前身份与独立积分资金/报价/结算、短剧项目持久化和在线生成、ComfyUI 当前可用性及第二个实际企业 API 仍未完成；目标保持进行中。本轮没有修改宿主页面、CSS、设置布局或既有快照。

## 2026-10-03：已安装插件的正式 Worker 执行入口

新增独立的 `crewon.installed-plugin-worker.v1` 部署配置与 `crewon.installed-plugin-release.v1` 发布文档。未配置时保留原 Worker/default Agent；定义为空、未知字段、错误权限或不完整权威配置在建库前拒绝。Native 管理启动清理该执行配置，不把本机安装许可当成用户执行或积分权限。配置、HTTPS 私有协议与当前部署限制见[Worker 部署说明](./installed-plugin-worker-deployment.md)。

实际安装包读取后，复用原 Agent 编译器和 runtime-binding 物化器，核对完整包/publisher/version/digest、profile、配置、原模型部署与派生目标。实际父 Store 迁移后再次核验原及派生 Agent 的已发布资产、部署、配置修订及安装账本；原完整激活 release 的核验仍保留。新路径与旧固定扩展宿主不能混用，未知版本不回退到其他 factory。每次创建重验实际字节与当前读取权限。

后台执行从当前 HTTPS 权威重新解析原 Run owner 的完整 actor，并另行检查 Application 策略、精确包/profile/purpose 许可及可选网络服务。保存的 principal、本机管理批准及包清单都不授予权限。权限响应不缓存；逻辑取消和超时仍保留实际 HTTP/创建容量，关闭同步撤回新操作，再等待物理操作和晚到实际资源转交，最后关闭数据库。

实际 SQLite/PostgreSQL 发布/加载及文件专项 **18/18**、实际父 Store 生命周期 **4/4**；严格配置、网络和策略协议及 HTTP 物理关闭专项 **29/29**。正式 source 子进程 **12/12**：保留无配置默认启动、非法配置建库前拒绝、真实 Krea2 两版的 metadata-only 启动与 HTTPS 超时关闭；专业报告的实际 production-mode Worker 使用测试端真实 Application 原子受理的两版 Run，旧任务执行 v1、新任务执行 v2、default 保持原功能。原 Run 的完整 package/principal/target pin 不变，供应商仅 **2 次 POST**；策略撤销、当前主体错配及包许可撤销均无模型或供应商派发。身份、模型、供应商、资金和报价均明确为测试夹具，不是线上收费或真实企业 API 验收。

最终 `pnpm --filter @crewon/runtime-worker test --test-concurrency=4` 使用本轮实际临时 PostgreSQL、先完成唯一 SDK producer 再启动消费者，**1584/1584，零跳过、零失败**。Worker 类型检查、原 runtime-binding 专项、Native 环境隔离 **10/10**、Native 类型、七入口桌面 runtime stage、Electron Host 构建、仓库 boundary 与全部改动源/文档格式已通过。日志为 `installed-worker-full-final-20261003.log`、`installed-worker-process-production-sealed-20261003.log`、`installed-plugin-release-loader-20261003.log`、`installed-plugin-worker-authority-lifetime-20261003.log`、`installed-worker-authority-unit-final-20261003.log`；全部位于 `output/extensions/checks/`。测试子进程、临时目录和本轮 PostgreSQL/socket 均已实际关闭清理；清理前其他连接及剩余测试 schema 为零，记录为 `installed-worker-postgres-owner-20261003.json`。本轮没有修改宿主 CSS、页面组件、设置布局或既有快照。

本节对应 `83eb61df1` 阶段，当时发布通过既有授权 `AgentVersionReleaseApplicationService` 预先完成，CLI 尚不消费新文档；该缺口现见首节。Worker 启动仍不自动发布、发放积分或生成报价。Control 的正式任务动作/当前调用者与报价服务、真实独立积分资金来源/结算、短剧正式生成与持久项目、用户 ComfyUI 当前服务可用性及 E5 的第二个真实企业接口仍需继续接通。目标保持进行中。

## 2026-10-03：桌面 SQLite 安装启动与本机管理

桌面 Native 从自身 `userData/control-runtime-v1` 读取明确的私有批准文件，派生真实本机 actor、持久 profile 与每次会话的 bootstrap。未配置批准时保留原启动路径，不扫描插件目录或创建插件 schema。批准文件与生成 bootstrap 拒绝链接、公开权限、超限字节及读取过程中的文件替换；原企业账号、PIM 身份和默认模型没有被本机管理许可替代。

SQLite 安装账本新增实际文件锁 owner。每个完整 profile 的独立 SQLite 连接持有保留锁，普通安装写者取得相同锁；主账本仍使用短事务，原 Worker 写入不会因 profile owner 长期阻塞。选择在实际 COMMIT 后从当前持久行投影，回滚、旧回执与关闭后排队的提交不能重新发布旧实例。父 Store 先同步撤回资格，再等待实际 owner 关闭，最后关闭主数据库。

没有模型凭据时，存在真实批准的桌面会话仅启动 Control 管理服务；live 可用与 Agent ready 分开。可选 Native 访问通知让原 App 打开本机管理，账号上下文仍为空；原左下角用户栏显示“本机管理”，沿用原菜单和设置路由。原菜单增加仅在实际本机管理中显示的“登录企业账号”，进入原登录页；返回本机管理必须仍持有当前 Native 许可。旧桥、Web 与缺少本机批准的路径保持原企业登录行为。会话失效立即撤回许可并清除旧 Control 客户端，晚到响应不能恢复旧目录。本轮没有修改 CSS、原设置导航或既有快照。

独立安装副本与原下载目录的可用性分开。批准 tuple 仍由明确配置提供；缺失、损坏或不安全的来源不出现在可安装列表，新的 install/resolve 必须重新核验实际字节。冷启动及显式启用已安装副本核验副本完整字节、当前批准和服务依赖；撤销批准后业务与资产访问仍拒绝，元数据读取、停用和卸载仍可用于修复。恢复来源需要显式 resolve/install 或重新打开服务，列表不轮询磁盘。

实际 SQLite owner 专项 **28/28**、原 Run Store **172/172**；Native bootstrap **29/29**，启动/撤回专项 **64/64**，原用户栏/设置与本机许可相关 UI **143/143**。登录入口、返回、撤回和原账号路径最后专项 **6 文件、112/112**。关闭与来源可用性实际 SQLite/PostgreSQL 专项 **36/36**，私有 bootstrap 最终回归 **11/11**，均零失败、零跳过。Control 类型、所有 packages 类型、正式 UI/Host 构建、UI lint 与七入口 runtime stage 已通过。

最终 Electron 实际进程验收 **2 文件、2/2**：组件链使用最后七入口 bundle，完整 App 使用正式 `dist-electron/main.mjs` 和 `file://dist/index.html`、原 preload/IPC 与实际 source Control 子进程。两次 App 均通过原账号菜单进入原企业登录页，再凭当前 Native 许可返回本机管理；原 Control 模式实际显示的 **10 个设置分类**逐个导航成功。安装初始停用、显式启用后从实际安装目录加载短剧 ESM 与 PNG；移走原下载目录后，新 App 进程保持同 profile，从安装副本冷恢复，新的来源列表为空。live 为 200、Agent ready 为 503，外部 POST 为 0，12 张实际任务/Agent/发布相关表记录为 0；子进程与临时 profile 均已清理。初次截图采集曾早于绘制完成，现测试等待实际绘制后再采集，重跑仍 **2/2**。最终视觉证据为 `desktop-plugin-native-final-visual-green-20261003.log` 和 `formal-file-app-final-visual-20261003/formal-file-app-proof.json`，同目录保留实际截图。这里没有验收 packaged.app、真实企业在线登录、收费或在线生成。

最终 Control 全量 **422 通过、1 项 Linux 进程用例在 macOS 跳过，共 423 项**；Store 全量连接真实 PostgreSQL，**1,457 通过、1 项“未配置 URL”的占位用例跳过，共 1,458 项**，均零失败。来源可用性改变后，旧组合测试仍要求损坏下载目录在打开数据库前阻断所有管理，这一旧契约在首次全量运行失败并保留日志；改为明确验证身份及配置仍在数据库打开前拒绝，并增加真实生产 PostgreSQL 冷管理、拒绝新安装及零变更代码导入的回归，专项 **4/4** 后重新执行上述全量。没有删除实际身份或包校验边界。日志为 `desktop-plugin-control-full-final-after-availability-20261003.log`、`desktop-plugin-store-full-final-20261003.log` 和 `plugin-production-composition-availability-20261003.log`。

最后按技能要求执行完整 UI 检查，提供真实独立包和 runtime 环境以运行新增原生用例，结果为 **3,279 通过、8 未通过，共 3,287 项**，不能称全量 UI 为绿。失败为既有 TranscriptWindow 4 项、useControlThreadCatalog、AppWorkspaceContent、ControlCommandOfficeRoomAdapter 各 1 项，以及全量并行时的 soak 超时；soak 最后隔离运行 **4/4**，不能改写全量结果。旧断言、快照和全量规则保持。日志为 `desktop-plugin-ui-full-final-20261003.log` 与 `desktop-plugin-ui-soak-isolated-20261003.log`；绘制等待的最后测试夹具修订另由前述实际进程专项验证，没有把这轮全量称为修订后重跑结果。仓库格式及其余 53 个变更文件格式通过；`sqlite-run-store.ts` 的既有全文件格式问题在不含本轮改动的 `6216895c2` 同样存在，保留原高频文件无关格式，证据为 `desktop-plugin-source-format-baseline-20261003.{json,log}`。临时 PostgreSQL 在实际连接数为 0、仅剩 public schema 后正常停止并删除自有目录与 socket，日志为 `desktop-plugin-postgres-cleanup-20261003.log`。

5719 的实际浏览器再次从左下角用户菜单进入原设置页并打开外观，11 个预览分类可见，截图为 `output/extensions/short-drama-preview/ui-settings-recovery/settings-final-20261003.png`。该预览未连接设置服务；服务端配置显示不可用，设备外观偏好可读，不能称为正式设置读写全部恢复。

生产身份服务部署、Worker main 的真实独立包许可与业务桥、报价及独立积分结算、短剧项目持久化与在线生成、第二个真实企业 API 仍未完成。本轮只读访问用户 ComfyUI 地址的 `/` 和 `/queue` 均返回 HTTP 404，未提交新生图；证据为 `comfy-endpoint-{root,connectivity}-20261003.log`。完整目标保持进行中。

## 2026-10-03：原设置页与安装管理

原用户栏的“设置”入口与 11 个设置分类保留。本轮再次从 5719 左下角账号菜单实际进入原设置页，外观页正常显示；这是离线页面预览，依赖后端的配置仍明确提示不可用。正式 App 切到设置时卸载主内容模块，插件没有改写全局导航、账号菜单或设置样式。

正式“工具与扩展”新增局部插件管理组件，通过原 Control 客户端及 BFF 按页读取实际批准来源、安装选择和包版本。首次安装保持停用；安装升级包不切换当前版本，显式版本选择用于升级或回滚。启停与卸载使用当前选择修订和幂等键，未知结果保留原请求重试，成功回执后重新读取当前目录。切换账号、退出页面及过期响应不能重新显示旧目录；选择变化立即撤掉旧模块并重新核验目录。新增行为与状态快照不修改原页面快照。

生产 PostgreSQL Control 的来源注册表、安装 runtime、main 环境变量及关闭顺序已经接线，配置详见 [服务启动](./installed-plugin-service-startup.md)。来源批准核验真实包字节和确切身份，路径不发送给界面。当前安装 Host 使用真实账本的 profile owner 和 Node Host，但没有注入任务、执行或计费服务；缺少必需服务时拒绝启用。选择提交后的可选 `prepareCommit` 保持旧端口兼容，重新核验当前权限和准备实例后同步发布；失败保留已提交选择并返回运行状态待确认。

真实 PostgreSQL runtime 专项 **12/12**，生产组合和账本重开 **3/3**；涵盖最终授权等待时 profile 切换、提交后撤权、实际连接丢失、关闭等待物理请求，以及依赖故障、旧批准撤销、包损坏后的管理修复。Control 全量 **398 通过、1 项 Linux 进程用例在 macOS 跳过，共 399 项**；Application **333/333**、Contracts **184/184**、客户端 **141/141**、BFF **38/38**。源码冻结后的 UI 与原生跨进程回归 **21 文件、188/188**，旧设置展示另 **9/9**，UI lint/build、所有 packages 类型及 Control/Worker 类型、架构与格式检查通过。主日志为 `plugin-installation-control-full-final-20261003.log`、`plugin-installation-native-ui-final-20261003.log` 和 `plugin-production-installation-runtime-20261003.log`。外部身份与策略是具名夹具，未验收真实生产权威服务部署。

未宣称全量 UI 为绿：全量检查曾发现新增测试组织的架构违规，现已通过移动集成测试修复，规则与旧快照未改。最后全量日志 `plugin-installation-ui-full-final-20261003.log` 记录 **3,224 通过、10 未通过**，包含 7 个既有失败、soak 并行超时及源码尚在修改时的 2 个原生进程一致性失败。源码冻结后原生进程专项已通过；soak 隔离检查 **4/4**，既有失败仍未改动。

桌面安装 bootstrap、实际生产身份服务部署、Worker main 的包许可及业务桥、真实报价与积分结算、短剧正式生成和持久化仍待完成。不能把本轮管理界面、真实数据库联调或具名权限夹具当作这些能力已经可用。

## 2026-10-03：执行服务准入与独立短剧页面包

公开 SDK 执行工厂增加可选 `requiredServices`，支持严格的 `externalOperations`/`jsonHttp` 声明。Host 从真实已安装工厂捕获不可变声明，并在业务 `create` 前核验实际端口；旧未声明工厂保持兼容。Krea2 独立包声明两项服务，不再依赖业务创建后才发现宿主缺少 IO。

实际 `InstalledPluginExtensionHost` 与历史 `InstalledPluginQueryHost` 在返回就绪前调用可信部署的预检。`executionIo.resolveReadinessNetwork` 接收真实包、profile、配置、完整目标和 submit/observe 用途，不创造 Run、命令、operation 或调用 HTTP。缺 owner、配置、预检、持久操作端口、批准路径或公共 HTTPS DNS 时拒绝；等待后再次核验当前权限、部署和真实 Node 工厂。历史查询还修复了等待后未重新核验原 AgentVersion 读取权限的问题。最终调用者授权等待期间撤回真实 Node 工厂的竞态也已修复：所有异步 gate 完成后才做最后工厂核验，再同步返回；现代声明与旧包两项真实 ESM 回归先在旧源码复现错误 ready，修复后通过。

Worker 程序化组合借出 `pluginExecutionReadiness`，从父 Store 和已捕获的 IO 配置构造真实 owner，并将同一端口交给历史查询 Host。外部配置/任务 Host 可借入该端口，必须先关闭自己再关闭 Worker。超时和逻辑取消不释放尚未物理结束的 callback/DNS 槽，Worker 关闭等待它们结束后才关闭 Store。

新 `examples/plugins/short-drama` 只依赖公开 SDK/UI、React/ReactDOM 和原 lucide 版本。原业务 CSS、图标、6 份其他业务文件及 PNG 保持原样，页面作为 UI-only 的 `crewon.short-drama/workbench` 安装；没有 Node、任务或计费服务。主题投影补齐原控件、间距、圆角、阴影与代码字体变量，共 39 个受支持名称，不改变宿主全局样式。卸载关闭 dialog、通知定时器和自身 DOM，重开明确重置内存演示数据。

官方 producer 已用唯一 SDK tarball 在仓外严格构建专业报告、Krea2 和短剧各两版本，实际删除开发目录及依赖后再运行消费者。短剧真实 SQLite/PostgreSQL 安装、资产读取、通用 loader、交互、主题、卸载/重开及升级/停用专项 **8/8**；包内实际 ESM 行为 **7/7**。Krea、原业务和 query composition 双库专项 **30/30**，包含服务撤回或私有 DNS 时在报价/个人预留之前拒绝。SDK 分发 **8/8**、Host 全量 **202/202**、正式 Worker 双库全量 **1,521/1,521，零跳过**；Control 全量 **374 通过、1 项 Linux 进程用例在 macOS 跳过，共 375 项**，均零失败。readiness、关闭与原 Agent 权限专项也已通过。全量日志为 `readiness-short-drama-worker-final-full-20261003.log`、`required-services-control-full-20261003.log`，短剧专项为 `short-drama-installed-ui-integration.log`；其余日志前缀 `required-services-*`、`plugin-io-readiness-*`。原 5719 用户栏已实际点击进入原 11 类设置，外观页可用。最终相关 UI **22 文件、231/231**、UI lint（含 Electron 类型）与 UI build 均通过，日志为 `installed-short-drama-final-ui-{tests,lint,build}-20261003.log`；这一窄跑不改写历史全量 UI 的失败记录。

[已安装短剧预览](../artifacts/installed-short-drama-preview/README.md) 在 5720 使用真实 SQLite 安装、原 Control 身份/CSRF 路由及正式 UI loader，通过浏览器原生动态 import 加载实际 `ui.mjs` 和 PNG。首次浏览器暴露 Vite 开发模式注入精确 `?import` 与正式资产空查询契约冲突；正式 UI Vite 代理和夹具共用有界路径归一化，仅移除合法已安装 JS 资产的精确空标记，51 项边界测试通过，额外及非空查询仍由正式路由拒绝，没有弱化生产协议。

实际浏览器已验证项目、概念图与生成记录展示、新建内存项目、原用户菜单及设置、退出重开重置、原生 dialog 随退出清理。设置和离开模块时服务端 active mounts 均为 0，重开为 1；原左栏展开占 232px、右工作台占 480px，1280px 窗口主内容宽度依次为 1280、1048、568px，没有遮挡。HTTP proof 核验 JS/PNG 摘要、Origin/CSRF/私有资产和关闭边界；浏览器后实际账本 Run、thread、message 均为 0，未创建积分表。证据为 `installed-short-drama-preview-http-20261003.json`、`installed-short-drama-browser-{leave,settings,final}-proof-20261003.json` 及 `output/extensions/short-drama-preview/ui-settings-recovery/` 截图。这里使用具名本机预览身份，不能当作生产登录或在线生成验收。

新预构建目录 `output/extensions/installable-plugins/readiness-short-drama-20261003/{krea2,short-drama}/<version>` 已通过实际包 verifier 重新核验四个完整复制目录，摘要见父级 `verification.json`。Krea2 每版本 7 文件、51,614 字节；短剧每版本 8 文件、1,949,650 字节。这是待安装交付物，不能冒称在用户生产 profile 已启用。短剧 UI-only 独立包已完成实包安装验收，当前仍为页面演示，没有真实保存项目、生成视频、扣费或跨插件委托。生产 main 的身份/包许可/动作桥、真实价格与失败退款/积分结算、安装管理页面、在线 Krea2 和第二个真实企业 API 仍未完成，目标保持进行中。

## 2026-10-03：独立 Krea2 包、宿主 IO 与历史查询

`examples/plugins/comfyui-krea2` 只依赖公开 SDK 和 Node 标准库，提供 Node 动作、执行工厂及独立 UI。已在仓外实际安装 SDK tarball、严格编译并构建 1.0.0/2.0.0；1.0.0 包内测试 12/12。固定单张 1MP 工作流沿用原已验证配置；上传文件的 4MP 差异有明确来源记录，没有隐含增加成本。原内置 ComfyUI v0 实现和摘要保留。

两版本预构建交付目录为 `output/extensions/installable-plugins/krea2-20261003/<version>`，实际 Host 重新核验各 7 文件、51,538 字节，完整摘要记录于同目录父级 `verification.json`。删除原仓外开发目录及依赖后，交付 1.0.0 bundle 再次通过 12/12。此目录是待安装产物，不冒称已在用户生产 profile 启用。

执行工厂的可选宿主 IO 端口从实际 Worker 派发 claim、原 Run 和实际 Store 取得权限。只有持久新建 operation 才发一次性 POST 凭证；方法、路径及请求内容必须与预留摘要一致，重开和已存在记录只观察。HTTP 使用既有 DNS、固定地址、TLS 及请求限额，真正发送前重新检查当前权限。实际受理响应允许在迟到撤权或取消后保存原本地证据；新 IO 仍拒绝。关闭等待真实委托、HTTP 和 Store CAS。

SDK `crewon.tasks@2` 增加引用式历史查询，API 1 保留。独立 `crewon.plugin-query-task-admission.v1` 保存当前查询调用者和原生成包/配置/完整目标/operation；查询沿用原包，不新增报价或个人积分预留。当前 UI pin 与原执行来源分别核验。当前用户必须仍具有来源读取、目标线程及查询权限；停用后的原任务观察不能变成新 POST。

已确认实际双库 Krea Worker 6/6、原业务 Worker 8/8；历史查询、实际安装 Host 与 Store 专项 35/35，真实 Control 动作 owner 双库 6/6，v0/v1 与 Worker 兼容 123/123。IO owner 13/13 是真实 SQLite 账本加私有派发单元夹具；网络与实际固定 TLS 29/29。它们不能替代 UI→查询全链或生产线上生成验收。日志前缀为 `krea2-worker-integration-*`、`installed-query-*`、`krea2-plugin-io-*`。

原用户栏、设置及工作区相关 18 文件/154 项通过，UI build 通过；本阶段未改宿主页面样式。5719 仍是离线预览，设置入口在左下角用户菜单，依赖后端的设置未连接。

程序化查询/IO 启动组合已接通真实父 Store。Worker 双库启动/关闭 12/12，Control 借用端口 4/4，实际 runtime lease 关闭顺序另 2/2；QueryHost 先等待查询结束，再关闭 resolver 和 Store。新增同包实际 UI→HTTP→tasks@2→付费生成/历史查询→冷 Worker/IO 的双库 6/6，含真实新版 B UI 查询原包 A、查询 COMMIT 后回执丢失重放及停用后的 GET 观察；新 UI、旧 Krea 与旧业务的组合专项 20/20。每个场景仅一次 POST、一次原结果 GET，一次报价和个人预留，实际结果投影含图片信息；供应商/model/身份/价格仍为明确夹具。UI 目前展示任务回执与来源，未把测试结果投影冒称完整生图产品界面。

还修复历史包干净加载失败被永久缓存的问题：清理成功后恢复当前许可可在同一 Host 重试；真实清理失败仍保留原 owner 和隔离槽。真实安装 ESM/SQLite 生命周期 2/2，日志 `installed-query-host-lifecycle-20261003.log`。

标准 Worker 测试现在先串行打包 SDK，在仓外构建专业报告与 Krea 的 1.0.0/2.0.0，删除实际开发目录及 SDK 依赖后才启动消费者。最终 Worker 双库全量 **1,484/1,484**，SDK 分发 **8/8**、Domain **202/202**、Application **328/328**、Host **185/185**。Control **374 通过、1 跳过**：跳过依赖 Linux 进程检查的用例；Store **1,440 通过、1 跳过**：已配置 PostgreSQL 时跳过“未配置 URL”的占位用例，真实 PostgreSQL 行为均运行。没有失败。日志为 `krea2-{worker,control}-full-dualstore-20261003.log` 与 `krea2-{sdk,domain,application,store,plugin-host}-full-20261003.log`。相关类型、生产许可证、入口边界和格式检查通过。

本节记录当时的验收；通用必需 IO 声明、就绪门槛和短剧独立演示包已在上节补齐。生产 main 的身份、包许可及动作桥、真实价格/失败退款与积分结算、安装管理和第二个真实企业 API 尚未完成。生产 Krea 必须装配真实 `executionIo` 与预检，不能据安装成功自动开放收费。当前 ComfyUI 服务地址不可用的在线验收也仍待处理；没有把供应商夹具当成真实生成结果。

## 2026-10-03：Electron 已安装插件资产通道

桌面 `file://` 页面现在可通过可选的 `pluginUiAssets` v1 桥加载已安装的受信模块；缺少能力的旧桥继续拒绝桌面加载，Web 同源路径保持。主进程捕获实际 Control 会话、进程 owner 与会话 generation，核对完整原挂载 lease 后，只发布随机引用下的批准文件。新资产接口不接受或返回账号、token 或任意代理 URL；旧 bootstrap 的凭据行为不变。

真实 Electron Session 在读取前核验所属窗口和当前 mainFrame，拒绝其他窗口、内嵌 View、子 frame 与旧会话。每次读取重新检查权限及完整 lease，核对长度、SHA256 和 MIME；整个读取与后置权限检查共同占用有限字节预算。退出和会话替换先同步撤回入口，再等待实际读取、取消与远端挂载清理。实际旧 Control 子进程终止后，仅可退休已结束且没有未知本地 reader 的 owner；清理失败继续占用容量。

原生专项及相关回归 **8 文件、71/71** 通过，零跳过。Electron **43.4.1** 实际安装夹具加载入口与相对 chunk，四类非法请求和外来 IPC 均拒绝，清理后资源计数全零；真实 RuntimeSupervisor/Node HTTP 子进程覆盖慢清理、Control 崩溃自动重启及终止后的清理重试。证据为 `output/extensions/checks/desktop-plugin-ui-tests-20261003.log`、`desktop-plugin-ui-native-proof-20261003.json`。临时安装、数据库和子进程均清理。

原工作区、预览设置入口、设置路由与原设置快照专项 **23 文件、180/180**；UI lint、UI build、Electron host build、架构边界和格式检查通过。全量 UI 实际为 **3,156 通过、8 失败**，不能声称全量通过；独立只读核对确认八项失败的完整名称、首行错误及断言位置均与实际 `git archive` 历史版本 `2d753e8f5` 相同，基线证据为 `short-drama-host-ui-head-baseline-six-suites.{json,log}`，当前精确日志为 `desktop-plugin-ui-command-workspace-20261003.log`。正确的窄跑日志为 `desktop-plugin-ui-original-shell-settings-20261003.log`。

本轮没有修改宿主 CSS、主题或原组件 DOM。用户栏的设置入口已在本节当时的预览实际点击打开，各设置分类存在；当前预览没有后端连接，常规页显示设置暂不可用。本轮新短剧包的浏览器核验见首节待办；最新用户栏/设置反馈已在 5719 新标签实际进入原设置页，证据见首节。`trustedModule` 仍是与 Renderer 同权的受信代码，已导入的 ESM 不能卸载；该通道不是安全沙箱，也不等于生产安装产品验收。独立 Krea2 包及短剧 UI-only 包已在后续阶段交付；生产安装管理、main 身份/业务动作桥、实际报价与结算、短剧正式生成和项目持久化、在线 API 继续待完成，完整目标保持进行中。

原 ComfyUI 服务地址当前只读探测的 `/system_stats` 和 `/queue` 均返回 404；没有提交新生图。证据为 `output/extensions/checks/krea2-service-availability-20261003.json`。后续在线验收等待服务恢复或新的可用地址，独立积分的实际价格及失败结算规则仍待用户确定。

## 2026-10-03：已安装插件的终态回执维护

原 Worker 的全局回执维护现在轮流借用原工具 owner 与已安装插件 owner。安装侧只扫描有界缓存中真正已准入、已发布的 SDK 实例，不读取新 Run、不加载包，也不请求外部执行权限。维护借用纳入原 users 计数；本地 ACK 继续由原 Store 核验完整持久回执，不能由插件自报成功。没有安装维护端口时保留原路径。

任务已完成但本地 ACK 中断时，闲置维护仍可核验原落盘回执并清理实际插件实例，即使安装选择停用、调用者或发布者许可已撤销。没有重新请求模型、供应商、报价或新任务。空扫描、缺少实际 `canRetire() === true`、尚有物理调用和清理失败均不会释放容量；维护读尚未结束时，关闭仍等待借用和实际 Node 生命周期。

新专项 **13/13**，包含既有回执、资源、安装 resolver、报告运行时与同包双库回归共 **96/96**。正式 Worker 入口重新用 pnpm **10.33.0** 构建仓外双版本包，删除开发目录后执行 SQLite/PostgreSQL 全量 **1,417/1,417**，零失败、零跳过。Worker 类型、生产许可证和架构边界通过。日志为 `output/extensions/checks/plugin-installed-maintenance-20261003{,-regression,-worker-types}.log`、`plugin-installed-maintenance-worker-full-20261003.log`。模板新增固定 `packageManager`，仓外构建也使用仓库规定的工具版本。

这补齐在进程实际资源上的 COMMIT→ACK 维修，不代表生产身份、报价、结算或真实企业 API 已接通。Krea2/短剧独立包、桌面资产通道、生产安装管理及主进程装配仍需继续实施；完整目标保持进行中。

## 2026-10-03：仓外 SDK 单包页面、任务与执行链

公开 SDK 新增可选的 `services.getOptional`。只有包明确声明为 optional 且实际依赖不存在时才返回 `undefined`；未声明、API 不同、必需依赖误用、失效实例及绑定失败仍拒绝。原 `get` 与旧 SDK 上下文类型保持兼容。NodeHost 的服务读取拆入独立模块，沿用真实实例捕获的依赖、绑定缓存及清理周期，不跟随当前注册表重新解释旧包。

新增 [仓外专业报告模板](../examples/plugins/professional-report/README.md)：复制到仓库外，只依赖实际 SDK tarball，严格 TypeScript 编译自含 Node/UI ESM、业务清单与包描述。同包可选声明任务和执行服务，Control 只提供真实任务桥，Worker 只提供真实执行注册；缺少服务时对应能力明确不可用。安装前构建实际 v1/v2 并删除开发项目及 SDK 依赖，随后只交付完整预构建目录；没有借用宿主源码或开发项目的 node_modules。

单包集成与原业务回归在 SQLite/PostgreSQL 上 **12/12** 通过。实际 renderer loader 读取安装包 UI 字节，由真实 DOM 按钮经本机 HTTP、UI Application、任务桥、个人积分预留事务进入原 Run 和 owned Worker。模拟已提交后的响应丢失，页面重试原冻结输入与幂等键，只取得原 Run、原报价和一次预留。默认 Agent 同时完成普通任务。原页面正常关闭后，供应商 HTTP/SQLite 与 Worker 连接重开，再安装 v2 并停用；新挂载拒绝，旧任务仍由 v1 原包 GET 查询原结果，供应商 POST 总数为一。

Control 新增内部 `InstalledPluginTaskActionOwner`，拥有真实懒加载 Node 服务与任务桥，逐次检查当前 actor/profile/UI epoch、数据库选择、包许可和完整安装字节。setup 等待后再次复核；缓存不捕获首次 actor 或选择修订。生产组合可成对转交该实际 owner 的动作与原提交回执权威，拒绝同形对象与独立端口混用。关闭立即撤掉 UI 准入，并等待实际 setup、任务及 disposer 后再关数据库；失败清理保留所有权和容量，不假称释放。

公开 SDK 仓外分发专项 **8/8** 通过，同包双库专项、Worker 类型及生产许可证、架构边界通过。精确日志为 `output/extensions/checks/plugin-optional-sdk-distribution-20261003.log`、`plugin-single-package-ui-worker-dual.log`。Worker 正式测试入口现在先串行构建双版本仓外示例，再启动消费者；重建 SDK dist 的命令不能与消费者测试并行。

独立审查还发现报告模板的两个实际生命周期问题：串行工具批次仍会在逐项 ACK 前完成多个调用，单份本地结果会覆盖前一执行；非 2xx 响应若保留未结束的 body，则逻辑调用结束后仍有 HTTP 流。模板改为按执行身份保留最多 32 份结果，提供原协议严格字段的有界查询及带游标的 scoped 扫描，并逐项核验完整 intent、状态和供应商回执后 ACK。错误响应先取消实际 body，每次传输最终 abort 自身控制器。实际安装包和 SDK 工厂的 HTTP 专项 **7/7** 已验证这些资源与回执行为；它不代表已接通 installed resolver 的全局终态 idle 维修。

最终 Host 全量 **173/173**、Control 全量 **364 通过 / 1 项 Linux 专项在 macOS 跳过**、正式 Worker 测试入口双库全量 **1,404/1,404**，均零失败；Control 新 owner 与原生产组合专项 **36/36**。SDK/Host/Control/Worker 类型、冻结 lockfile 安装、生产许可证、架构边界及仓库和新增源码格式检查通过。首次正式入口仅在预构建阶段因外部开发工具的镜像离线元数据缺失失败，没有启动消费者；改为从官方 registry 正常安装模板的固定开发工具，关闭安装脚本后重新构建，最终全量日志为 `output/extensions/checks/plugin-single-package-{host-full,control-full,worker-full-final}-20261003.log`。SDK tarball 仍来自本地实际发布构建；开发目录在启动消费者前已删除。

**边界：** 本轮未修改现有 UI 组件或 CSS。报告供应商为明确的 HTTP/SQLite 夹具，模型、身份、包许可和报价也为夹具；连接与数据库重开不等于跨操作系统进程或在线企业 API 验收。积分只验证原预留事务，实际价格、失败退款和结算尚未接通。生产 main 的当前身份/发布者许可接线、Krea2/短剧独立包迁移、Electron 资产代理和第二个真实企业 API 继续待完成，完整目标保持进行中。

## 2026-10-03：通用已安装业务清单、Agent 物化与任务准入

业务声明现在可以从实际安装包的 `businessManifestPath` 读取，不再要求 ComfyUI 的 `baseUrl` 或固定工具名。读取逐项核验完整包文件、身份、摘要、目录边界和当前元数据许可；有界 JSON 读取不导入 Node/UI，也不调用外部服务。Worker 仅接受该读取过程取得的实际注册对象；复制的注册声明不获得部署权威。新的实现摘要使用明确的 v1 配方绑定完整包摘要与实际 Node 入口，不重新解释旧内置插件的 v0 摘要。

通用编译在真实基础 AgentVersion 上增加声明的工具和任务指令，保留原模型、资源、基础工具及顺序，拒绝工具名和 Agent ID 冲突。新的程序化工厂同时核验完整 profile、原基础部署、配置、派生版本和实际基础工具 owner，并将它们纳入独立物化摘要。宿主工具仍由原 owner 执行；插件工具的元数据占位实例明确拒绝执行，只有原 Run 的 SDK resolver 才能替换它。实际运行对象另保留完整 profile 的私有构造证明，跨 profile 的任务不能复用该物化。

`InstalledPluginExtensionHost` 使用真实 StoreBacked resolver、部署、物化证明及安装包的实际 SDK 工厂注册判断就绪，不以清单、目录或占位工具代替可执行性。配置校验不启动插件；就绪检查借用并释放工厂注册，不创建虚构 Run 或工具实例。当前身份、profile、选择、包许可及异步 setup 后的复核仍是宿主职责。启动中、正常缓存及失败清理的资源共同占用有界容量，关闭等待真实生命周期。

原任务层新增可选的内部 `taskAdmissionMode` 元数据端口。已安装业务的新任务必须进入原 `createTaskFromPlugin` 的包/profile/个人报价准入；旧公开 v0 路径在创建 Run 前拒绝无 pin 的安装式任务。旧宿主不实现该端口时保留原行为，历史 v0/v1 回执继续先重放。没有新增 HTTP 字段或改变旧持久化形状，原前端本阶段未修改。

实际安装业务集成在 SQLite 和 PostgreSQL 上 **8/8** 通过：使用实际包注册、原基础发布/部署、通用工厂、StoreBacked resolver 和就绪 Host，再通过原个人报价事务进入 owned standalone Worker。原默认 Agent 同时完成普通任务；重复请求只保留一个原任务、原报价和积分预留。关闭并重开 Worker 与数据库连接后，已经升级至 v2 且停用的选择仍允许旧任务用 v1 原包观察回执，无再次执行。profile 用例只证明实际物化层拒绝，不是跨 profile 的完整启动测试；供应商回执是同进程具名 Map，不是跨操作系统进程或在线 API 验收。当前积分仍为预留，不算完成结算。

本阶段 Host 全量 **165/165**、Application 全量 **328/328**、Worker 双库全量 **1,393/1,393**，均零失败、零跳过。类型、生产许可证、架构边界及相关格式检查通过。日志为 `output/extensions/checks/installed-business-{host-full,application-full,worker-full-dual-store,execution-integration}.log`。异步工厂创建另外捕获原输入；返回对象的构造证明失败时先清理真实资源，清理失败保留真实失败 owner，不把容量误报为已释放。

当前是显式组合 API 的增量实现；生产 main 的身份/发布者许可、实际报价与结算、单包 UI/任务/执行组合、Krea2/短剧包迁移和在线外部 API 仍待验收。无实际凭据租用服务时，非空 credential binding 明确拒绝；尚无依赖闭包时拒绝必需的外部 Node 服务。不能将专项测试的模型、许可和报价夹具当成这些生产权威。

## 2026-10-03：已安装包执行 owner、原工具路由与失败清理隔离

Standalone SQLite/PostgreSQL 组合现在可以显式配置 `installedPluginExecution`，由宿主提供安装根、当前 actor 解析、原授权端口、发布者/包许可端口及可选容量。组合在打开 Store 前验证并捕获配置值和方法身份，拒绝与注入 resolver 并用；显式迁移完成后，从本组合的实际 Run、扩展及安装 Store 构造真实 `InstalledPluginRunContext` 和 `InstalledPluginRuntimeResolver`。组合拥有该 resolver，启动失败回收，重复关闭合并为一次；关闭顺序为 Worker 停止准入、执行资源释放、最后关闭 Store。

真实 resolver 以不可变 admission、原配置、原执行目标和工具目录核验确切安装包，通过 `PluginExecutionPackage` 加载原摘要对应的 Node ESM，从真实 Node lease 取得 SDK 工厂并创建每个 Run 的工具实例。router 仅接管业务清单声明的插件工具，保留原完整目录及其顺序、原 Kernel 和宿主工具；执行、恢复、取消及保留回执仍交给各自实际 owner。只有权威 v1 记录确实不存在才沿用原工具路径，来源读取错误、缺少 owner 或物化证明均明确拒绝，不回退到当前版本或旧内置实现。

当前授权同时检查持久化安装选择、原扩展激活和真实 actor。安装选择停用阻断新的 dispatch，`reconcilable` 观察仍使用原包与回执；`replaySafe reconcile` 按 `submit` 检查。Run 的 canonical `toolPermissionMode` 从实际持久化 Run 和原受理回执核验后投影为 sandbox 上下文，调用方不能通过修改 Run 副本提升权限。包 setup 完成后的异步 `beforeCommit` gate 再次读取当前身份、选择和许可，发布者许可端口等待期间发生的撤权也会在后置检查中拒绝发布。

缓存保留仍有物理调用或未确认 SDK 完成回执的实例，warm 借用授权失败不关闭这些旧资源。闲置退休需要实际 `canRetire() === true`；可选 `close` 缺失时也不能凭空推断清理完成。新增启动清理失败的真实 owner：Host 用私有 WeakMap 将冻结的关闭句柄绑定到实际抛出的错误，仿造或包装错误不能取得该所有权。resolver 将清理失败的 Host/SDK 实例留在有界隔离项中，同一原任务不重新 setup，其他任务仍受容量限制，显式关闭继续报告失败，不假称已清理或释放容量。

已确认专项为 resolver **32/32**、实际 SQLite/PostgreSQL composition **26/26**、router **11/11**、Host 全量 **135/135**、Worker 双库全量 **1,323/1,323**，均零失败、零跳过；Host 和 Worker 类型、生产许可证、架构边界及相关格式检查通过。实际安装执行专项通过 composition helper 构造真实 resolver，再接真实 Worker、双库 Store、不可变安装文件和原任务/工具回执路径；模型、SDK 外部供应商实现、身份、包许可及报价仍为明确夹具。它证明执行 owner 和组合行为，不等同于完整生产 main、真实积分结算或在线生成 API 的端到端验收。历史阶段的全量数字仅代表当时版本。

**仍待接通：** 生产 Worker `main` 的真实身份和包许可配置、通用已安装业务包的 Agent 物化证明、生产动作桥与真实报价/积分结算权威、历史依赖闭包、Krea2/短剧独立包及真实 API 验收。上述组合 API 已实现，但不能用预览身份、静态自授权或测试物化证明替代这些生产端口。历史阶段记录保留，完整目标继续进行中；当前启动边界见[已安装插件的服务启动](./installed-plugin-service-startup.md)。

## 2026-10-03：执行工厂协议、原 Run 执行入口与历史包加载基础

公开 SDK 增加显式声明的 `crewon.execution` API `1` 执行工厂。工厂接收宿主核验后的原包、Run、配置和完整执行目标快照，不携带账号权限、Store 或凭据值；返回自含的原 ToolRuntime 协议，覆盖执行、恢复、取消、预约、保留结果与确认。Node 声明仍无需 DOM 或宿主私有包。Host 将工厂注册绑定到实际 Node 实例及其清理周期，借用必须使用未释放的真实 Node lease；同形对象不能伪造身份。已开始的工厂创建由调用方继续持有，关闭不丢弃晚到资源。

新增独立历史包加载器，从宿主安装根与原摘要核验文件后加载 ESM，重启后能重新取得旧版本工厂，不修改其他宿主的当前选择。它只提供执行注册服务，遇到外部必需服务依赖明确拒绝，尚未实现持久化依赖闭包锁。调用方必须持有 Node 借用直到工具实例和物理调用结束；有活跃借用时关闭拒绝提前清理，释放后可以重试。

Worker 取得实际 v1 任务来源读取端口，只有显式启用扩展时才执行迁移，不创建个人钱包或发放余额。原禁用启动不调用扩展 Store，也不迁移插件表，普通 Run 按需检查本库 schema 元数据；两张 v1 表均确实不存在、或合法 schema 下确实没有原任务记录时才沿用原路径。半缺 schema、未来版本、数据库错误均不解释为不存在；同一端口能够识别其他进程随后提交的迁移和任务，未缓存 schema 缺失。普通历史 Run 保留原核心 ID 规则。有 v1 记录却缺少执行 owner、实际 Agent 物化证明或完全一致的工具目录时拒绝执行，不降级到旧内置工具。可信 resolver 仅替换原运行时的工具，保留原 Kernel、权限策略、模型目录和上下文。其资源在 Worker 停止准入后、Store 关闭前释放，启动失败也清理一次，逻辑超时后继续保留物理借用并释放晚到租约。

原任务上下文读取器核验真实 Run、不可变 binding、受理回执、个人报价关联、配置修订与安装账本，并重新解析当前调用者和权限。工具适配器保留原命令、ActionIntent、原生 AbortSignal 和结果身份，固定使用宿主派生的 Run 权限上下文；每次外部执行再次检查当前授权。恢复入口同时覆盖 `running` 中已派发的回执与 `reconciling`：停用后允许观察原结果，新的副作用仍拒绝。独立审查发现 `replaySafe reconcile` 可能重新派发读取，已增加统一授权映射，将其按 `submit` 检查；只有 `reconcilable` 原结果查询及取消使用 `observe`。可选能力继续按原实现暴露，空扫描不生成退休证明，关闭等待原实现及已开始的调用，不因晚取消丢弃完成回执。

验证包括 SDK 实际仓外打包/离线编译与 ABI 8/8、Host 全量 129/129、真实上下文 SQLite 16/16、工具适配行为 24/24、真实 Worker 受理及恢复 17/17。新增执行 owner 的 SQLite/PostgreSQL 启动和关闭行为 6/6，原双库组合及内置 ComfyUI 路径 53/53，均零跳过。原任务恢复专项使用真实 SQLite、Kernel、上下文读取器与工具适配器，重放专项关闭原 Worker 后换用丢失本地结果的实际 Broker，验证启用时能够重放、停用时不增加调用及积分预留；其工厂及外部供应商仍为具名夹具，不能当作生产独立包执行验收。相关日志为 `output/extensions/checks/plugin-execution-*.log`、`installed-plugin-run-*.log`、`plugin-tool-runtime-adapter-*.log`。

首次 Worker 全量实际双库检查 1,247 通过、1 失败，发现禁用启动不应访问插件 Store 的既有测试被新迁移触发；原测试保持不变，改用上述只读 schema 检测并恢复原启动边界。修复后启动兼容专项 24/24，新增实际双库只读检测 18/18，均零跳过；覆盖长 ID/原始空格、同端口后续迁移、坏 schema、SQLite 临时影子表及错误空间不得降级。最终 Worker 全量带实际 PostgreSQL 为 **1,249/1,249，零跳过**，包括原模型流、审批、取消、重开与 CLI 子进程关闭；SDK、Host、Store、Worker 和 Control 类型，Worker 生产依赖许可、入口边界及仓库和新增源码格式检查均通过。检测日志为 `plugin-task-admission-probe-behavior.log`，启动兼容为 `plugin-execution-startup-compatibility-final.log`，全量为 `plugin-execution-worker-full-dual-store-final.log`。

另修复构建升级夹具：每个离线复制工作区从自身源码构建 SDK，并验证 SDK 三个 import-only 子路径，没有补造包根导出或借用主工作区 dist。原 Electron、业务 UI 和七入口构建三个实际调用者 3/3 通过，五个独立复制工作区分别构建自己的 SDK；窄路径校验 5/5。日志为 `copied-sdk-ui-callers.log` 与 `copied-sdk-script-caller.log`。本轮没有修改页面、公共 HTTP、原任务摘要或旧回执；自有临时 PostgreSQL 已停止并删除。

**仍待接通：** 生产 Worker 的实际安装包 owner → SDK 工厂 → 工具适配器组合、当前身份/发布者信任及资产权威、历史依赖闭包、Krea2/短剧独立包迁移和真实积分权威。现有 resolver 是显式注入端口，默认生产 v1 任务会明确拒绝缺失 owner，未称为独立插件端到端交付。完整目标继续进行中。

## 2026-10-03：窄屏用户栏与设置布局修复

在用户当前 766px 宽的 Codex 浏览器中实际复现：原 ≤860px 规则隐藏整个侧栏，而唯一展开开关也位于隐藏的侧栏内，导致账号与设置入口不可达；此前四种 ≥1000px 的检查没有覆盖这个尺寸。设置页还受到旧浮层导航规则影响，导航绝对定位后遮住第一列的主内容。这两处规则在改造前基线同样存在，不能把宽屏核验等同于当前窗口可用。

仅修复 ≤860px 的 desktop surface：沿用原侧栏、账号菜单和设置组件，展开为 232px 导航列，折叠为 0px，保留原展开按钮；设置导航继续占据原 220px 列，≤760px 使用原 180px 列，并恢复参与布局。侧栏开关的中英文标签和 aria-pressed 与真实状态同步。没有增加遮罩或复制导航，>860px 视觉规则和浏览器移动端规则保留。

真实 Codex 浏览器验证 766px 用户栏、账号菜单→设置→外观→返回及折叠/展开：主内容 534px↔766px，矩形边界相邻，无横向溢出；760px 设置导航 180px、内容 580px，1280px 原首页布局仍为 232px+1048px。临时视口已重置。截图为 `output/extensions/short-drama-preview/ui-settings-recovery/{account,settings}-narrow-desktop.png`。相关 18 文件 176/176；最终布局修复后设置/宿主专项 7 文件 66/66，UI lint（含 Electron）、build、仓库及源码格式检查通过，快照未修改。5719 仍为未登录的独立预览，设置服务没有接通，不能将恢复入口与布局称为正式设置读写已恢复。

## 2026-10-03：用户栏和设置页再次核验

再次检查用户反馈的入口缺失：5719 使用当前 worktree 源码，左下角账号菜单已接回原设置路由。独立 Headless Chrome 在 1440×900、1280×720、1000×600、1000×400 四种窗口中确认用户栏没有裁切，可以打开菜单、进入全部 11 个当前可见设置分类并返回原首页，无页面错误。本次没有再次修改组件或 CSS；样式目录与改造前 `776484c57` 没有差异。预览没有登录账号或设置服务，因此服务配置仍明确显示暂不可用，不能将只读预览称为正式账号设置已接通。原标签自动化因设备锁屏不可用，已请求在 Codex 打开当前预览，返回状态为 queued，不声称已刷新原标签。

相关 UI 专项 17 文件 144/144，UI build 通过。命令参数误用导致另外执行了完整 UI suite，结果为 3117 通过、10 失败；失败涉及既有历史视图/文案、压力检查超时及两项构建夹具按根入口解析只有子路径导出的 SDK，本次未改测试或快照规避，不将全量结果算作绿色验收。证据位于 `output/extensions/short-drama-preview/ui-settings-recovery/`，包括 `{component-narrow-tests,component-tests,build,browser-verification}.log`、`browser-verification.json`、`account-menu.png` 和 `settings-page.png`。

## 2026-10-03：SDK 调用引用与原任务动作桥

公开 SDK 增加 `crewon.tasks` API `1` 的生成请求和原六字段任务回执，以及按贡献点声明的 `read` / `generateTask` 动作服务。动作服务使用包自己的 plugin ID，不把任意动作名解释成 Node 服务。NodeHost 只对宿主服务按实际实例绑定窄端口；同形身份对象、旧实例端口和另一个包都不能借用当前调用引用。默认共享服务与原生命周期保持兼容。SDK 实际仓外打包、离线安装、Node-only 声明和任务 ABI 6/6；绑定专项 6/6、原 NodeHost 加绑定回归 88/88 通过。

新增 `PluginTaskActionBridge`，从已授权 UI 上下文派生完整 actor/profile/包版本/pin，签发最多 128 个、最多 30 秒的调用引用。SDK 请求不接受 actor、payer、profile、价格或摘要字段；一次调用只允许一个稳定任务命令，重复调用等待原结果，不创建第二个 Run。报价完成后、原事务提交前再次核验当前 profile、权限 epoch、同步持久选择、引用期限及实际 UI 挂载。最后一项使用私有 WeakMap 登记本次 context，实际 `closeMount` 或调用结束立即撤销准入，不能用同形对象或客户端字段伪造。业务声明不是授权，同步 profile 拥有权也不是权限证明。

`PluginUiCommittedTaskAuthority` 从实际 Store 的原任务回执、完整 pin、个人报价关联和真实 Run 核验受理结果，只签发本次调用可消费一次的私有句柄。普通 JSON 和读取动作保持前后权限检查；只有该句柄可以在提交后停用、升级、撤权、租约关闭或期限变化时返回原任务 DTO。插件自报 committed、假句柄和跨调用复用均不能绕过校验。生产组合可以显式注入这个可信核验端口，关闭仍拒绝新的调用和普通晚返回；有核验端口的在途动作等待原受理结果，不把已经确认的提交重新报告为准入失败。

真实 SQLite、SDK bundle、不可变文件安装、删除开发目录、Node ESM、UI Application 和原 Turn/Run/个人积分链路 9/9，零跳过。覆盖提交后真实停用、epoch/期限变化和 bridge 关闭只返回原回执，报价等待中的三类撤权及真实页面关闭零写入，普通读取后置撤权，以及第二个 SQLite 连接重试保留原 30 积分报价且不重新预留。资金、价格、身份和同步选择写者都为明确测试夹具；没有调用在线生图，也没有将它们称作生产价格或正式账号权威。Application 全量 320/320、Host 全量 108/108 通过；最后一处回执投影捕获和夹具引用白名单调整后，动作桥单元 11 项与真实 SQL 集成 9 项再次合计 20/20 通过。Control 全量基线 330 通过/11 环境相关跳过，最终生产 UI 专项 8 通过/2 项 PG 环境跳过，均零失败；本次没有运行 PG 服务。独立审查发现动作数组索引 getter 和自定义迭代器可绕过遍历上限，已改为严格自有数据索引捕获并覆盖零 getter 执行。实际关闭页面的最终门禁由上述 9 项 SQL 集成和 Application 全量单独验证。日志位于 `output/plugin-ui-committed-task/` 和 `output/extensions/checks/plugin-task-*.log`。

**仍待完成：** 生产安装/Node owner 与动作桥的 main 装配、真实报价/积分权威、SDK 执行工厂、Worker 按确切独立包执行和历史冷恢复、Krea2/短剧独立包迁移、Electron 资产代理、安装管理和第二个实际企业 API。当前生成包 ID 必须与原 extension ID 相同；尚未提供跨插件委托或多执行工厂。正式 main 仍明确返回业务动作不可用，本轮未修改原 UI 或样式，完整目标继续进行中。

## 2026-10-03：生产已安装 UI 启动与原 Run 的包版本准入

生产 Control 现在接受显式的已安装 UI 配置，复用真实 `ProductionControlApiIdentity`、HTTPS profile/权限权威、共享 PostgreSQL pool 的独立安装账本及受批准的不可变文件子集。未配置时原路由保持不变，不创建安装账本。原生资源及引用仍逐次核验当前作用域、权限 epoch 和选择修订；关闭取消权威请求并撤销服务引用。实际 HTTPS、完整生产 PostgreSQL 组合及旧鉴权回归共 55/55 通过。启动方式和当前边界见[已安装插件的服务启动](./installed-plugin-service-startup.md)。生产动作仍明确不可用，未假接 ComfyUI、账号、profile、价格或积分。

PostgreSQL 安装组合新增实际 profile owner：专用连接持有 session 锁，普通写者在回执/命名空间前取得相同 profile 锁，拥有者通过自己的连接串行提交。物理提交确认之前同步版本投影不可用；确认后从当前持久行重建，旧回执不会回退最新选择。失去连接或关闭父宿主会同步撤销准入并等待物理连接结束。真实 PG 拥有权 8/8、原安装双库兼容 24/24，均零跳过；不将这个同步投影当作权限证明或瞬时网络故障探测。

新增内部 `createTaskFromPlugin` 和独立 `crewon.plugin-task-admission.v1` 记录，使用原 Turn/Run/operation/个人积分路径。完整包、profile、选择修订、调用者、贡献/动作、权限 epoch 和原 binding 关联在原 Run 提交事务中保存；PostgreSQL 选择行的共享锁持续到提交，停用更新必须等待，SQLite 使用原写事务。新生成必须取得真实个人报价和受支持的原子存储，不走无报价分支；已接受的重复请求保留原任务与原价格，不重新报价。旧 v0 摘要、幂等键、回执和 HTTP DTO 不变，迁移也保持显式 opt-in。实际双库应用到存储、并发提交、真实停用竞争、原子失败回滚、卸载保留及严格输入边界共 69/69，零跳过；独立审查发现的 PG clone 弱化 accessor/隐藏字段问题已修复并覆盖 pin getter 零执行用例。v1 还在快照后再次核验 pin 与最终 Turn，双库覆盖同 Run ID 下合法 actor 切换的 getter 回归；SQLite 仅 v1 使用快照，v0 保留原流程。

全量基线 Domain 199/199、Application 289/289、Store 919 通过/240 环境相关跳过、Control 328 通过/11 环境相关跳过，均零失败；随后最终快照修复的 69 项相关双库回归全部通过。未把跳过的 PG 项算作验证，实际 PG 证据由上述专项单独提供。20 个 packages、Control、Runtime Worker 类型检查、入口边界及源码和仓库格式通过。检查日志位于 `output/extensions/checks/plugin-task-*.log`、`production-plugin-*.log`、`postgres-plugin-profile-owner-*.log`、`installed-plugin-*.log`。本轮没有改 UI 或共用样式，也没有重复在线生成；自有临时 PostgreSQL 在连接及测试 schema 清理后正常停止。

**尚未完成：** 生产安装/Node 拥有者装配、SDK 调用引用及已提交动作回执语义、Worker 按独立包执行和历史查询、Krea2/短剧包迁移、真实积分权威、Electron 资产代理及第二个真实企业 API。完整目标仍进行中，不把这些基础测试称为插件产品验收。

## 2026-10-03：补回预览用户栏与原设置页

用户指出 5719 预览缺少用户栏和设置页。原因是独立预览没有账号上下文，原 Chrome 按条件隐藏账号页脚，且设置回调只显示预览提示。新增明确的宿主预览选项，复用原 `SidebarAccount` 的未登录分支，不伪造用户或角色，不显示密码和退出动作；已登录原账号 DOM、交互和快照逐字保留。默认正式页面不启用该预览选项。

设置点击打开现 `CommandSettingsRoute`，保留全部原导航分类和返回入口；独立预览尚未连接服务，设置为只读，外观读取当前设备实际偏好。原工作区保持挂载，设置期间暂时收起工作台及其快捷键，返回恢复原开关、项目和未保存内容。没有修改原设置组件、六张共用 CSS、Frame 或右栏。相关 107/107 和统一 UI 25 文件 228/228 通过，唯一更新的快照是确实新增用户栏的预览快照。新增导航测试的只读 tuple 类型推断问题已改为直接逐组遍历，预览 6/6、UI lint（含 Electron）及 build 通过；日志为 `output/plugin-app-ui-*.log`。浏览器已验证菜单、常规和外观、设置往返与编辑内容保留，截图为 `output/extensions/short-drama-preview/account-settings-restored.jpg` 和 `settings-restored.jpg`。原 5719 服务未重启；原标签的自动化读取超时，使用同浏览器的自有临时标签完成验证，未重载原标签。临时标签已关闭，原标签保留，临时视口已重置。

## 2026-10-03：原页面的已安装模块组合与纯 UI 包恢复

正式 App 增加已授权插件目录读取，主内容模块沿用原导航行与内容槽，多贡献使用插件和贡献的组合 ID，版本与选择修订属于挂载标识。目录刷新保留未变化模块的实例；删除、线程或场景切换、退出账号、权限或选择变化撤回旧页面的调用资格。主题只读取宿主实际已绘制的变量，插件不改全局样式。用户再次要求“样式完全一致”，18 张既有 CSS 与 `776484c57` 全部逐字一致，证据为 `output/extensions/short-drama-preview/style-all-css-parity.json`。

目录与动作使用现 `ControlApiClient` 会话，原生资源固定走 `/api/v1/plugins/ui/mounts/:ref/assets/*`；完整服务端 lease 作为不可变身份，有界分页、取消及请求期限，不接受任意资源地址。此组合当前仅支持同源 HTTP Web/BFF，`file://` 和不同源 Desktop 客户端明确不加载，需要后续实现已鉴权的原生资源代理。未配置生产插件服务时保持原页面；没有伪造身份、epoch、价格或收费调用。

本地选择与恢复新增真正的 `node: null` 分支：完整安装字节、发布者、兼容和当前授权检查仍然必需；同步提交撤回同插件的 Node 接收资格，保留已借用的旧服务。不执行 UI JS，不创建虚构 Node 注册，纯 UI 包不允许声明 Node 服务依赖或提供者。真实 SQLite/文件与 Node 双向切换、数据库重开、重复恢复、撤权和篡改均有行为覆盖，Host 全量 82/82、Control Client 136/136 通过。正式 HTTP 组合、目录和挂载生命周期均有客户端行为测试，但本轮尚未新增正式 App 的浏览器原生导入验收。

原 Tool/Run/operation/个人独立积分、Krea2/短剧独立包迁移、生产启动权威与跨进程拥有权、历史任务精确版本恢复和第二个真实企业 API 验收仍待落地，完整目标保持进行中。

## 2026-10-03：安装与 UI 的 HTTP 链路、已安装选择恢复

增加 `/api/v1/plugins` 的严格公开请求及脱敏响应，提供安装、选择、目录、挂载、资源和动作接口，复用 Control 身份、CSRF 和安装幂等回执。安装来源仅接受宿主登记的 source ID；客户端不能提供 actor、profile、目录或价格。挂载关闭接受无请求体或空对象，重复关闭返回完成，其他调用者关闭引用不会影响其所有者。资产与动作权限分别核验；权限 epoch 或选择变化会永久撤回已观察到失效的引用。服务未明确装配时不发布这些路由。

`ControlApiClient.plugins` 与 BFF 接通现有账号会话；每次资源读取重新解析 cookie 和验证用户令牌。插件 JSON 和二进制资产分别限额，拒绝重定向，执行取消和 10 秒期限。HTTP adapter 传入原始请求 target，路径穿越在 URL 归一化前拒绝，不能从浏览器身份头获取此上下文。实际 Client → 自有 HTTP BFF → 监听中的 Control → SQLite/不可变文件/Node/UI 测试通过：两版安装及回执重放、删除开发源码、启用、入口与相对 chunk 字节、升级旧引用撤回、重复关闭以及跨账号隔离。测试使用明确测试身份与策略，不代表已接真实生产权威或扣费。

本地恢复 API 从安装目录和已确认选择重建 Node 投影，不修改数据库修订、审计或回执。最多 64 项，完整字节、兼容、依赖和当前权限预检后按依赖顺序加载；失败清理本批注册，保留旧借用。实际关闭重开 SQLite 与 Node、删除开发目录、多 profile、撤权和失败清理均有覆盖。当前启用恢复要求 Node 入口；UI-only 恢复、生产启动接线、跨进程拥有权及崩溃安装锁恢复尚未实现。

Contracts 全量 176/176、Control 既有接口及插件安全/路由 74/74、Host 全量 74/74、客户端 135/135、BFF 36/36、包边界 24/24 通过；20 个 packages 类型、Control/BFF 类型及入口边界通过。新增 HTTP 契约同时更新 OpenAPI、生成类型和既有精确路径清单。独立审查发现 Unicode 幂等键不能进入 HTTP 请求头，已只对 HTTP 键收敛为 1–128 个无空白可打印 ASCII 字符，内部 Unicode ID 和账本规则不变；非法键在客户端返回协议错误且不发请求，新增回归通过。相关证据为 `output/extensions/checks/plugin-control-*.log`、`plugin-installation-recovery-*.log` 与 `output/plugin-control-*.log`。生产 main 的安装组合、正式页面目录、多插件导航、Electron 资产加载、原 Tool/Run/operation/个人积分和 Krea2/短剧包迁移仍待接通；本轮没有重复在线生成。

最新“样式完全一致”再核验：改造前 18 张既有 CSS 均逐字一致，窗口、原左右栏和主题保持原实现；当前 HTTP/恢复改动没有 UI 或 CSS 差异。浏览器 1280px 左栏 232px、右栏 360px、主内容 688px，折叠左栏后主内容 920px，边界相邻且无横向溢出。关闭右栏并重置临时视口后保留原预览页；核验截图为 `output/extensions/short-drama-preview/style-final-both-sidebars.jpg`。

## 2026-10-03：删除预览响应式覆盖，严格沿用历史样式

用户再次要求“样式完全一致”，最终审查发现预览仍单独覆盖了 ≤860px 左栏网格。删除该 CSS 及其导入，响应式布局也直接沿用改造前版本，不再保留预览例外。替换该覆盖规则的旧快照检查，新增两种预览入口与生产入口的六张样式及加载顺序一致、预览组合不导入独立宿主 CSS 的回归；原页面及模块 DOM 快照未更新。

相对 `776484c57`，共用 CSS、Frame、Route、右工作台、主题与平台文件仍无差异。短剧 CSS 的 107 个规则均限定在 `.drama-workbench`。实际浏览器检查 1280px 桌面左右栏占位与动态主内容；766px 恢复原单列及隐藏左栏规则，无横向溢出。临时视口重置，用户 5719 原页面保留。预览继续使用已有本地外观；没有伪造真实账号、远端偏好或连接状态。比较视觉时须使用相同主题、外观和视口。相关 16 文件 136/136、UI lint（含 Electron）、build、边界及仓库格式检查通过，日志为 `output/plugin-ui-style-consistency-*.log`；最终截图为 `output/extensions/short-drama-preview/style-consistency-both-sidebars-latest.jpg` 和 `style-original-narrow-latest.jpg`。

## 2026-10-03：生产插件身份与权限适配端口

新增安装授权、独立 UI 权限 epoch 与当前 profile 适配器，以及有界 HTTPS 权威端口。复用已验证 actor；安装保持原精确 allow/deny 协议，UI 的 allow 必须携带真实权限 epoch，profile 必须由权威服务返回并与 actor 的租户/空间一致。没有固定 profile、从 principal 推导配置、默认角色或伪造 epoch。未知字段、getter、跨作用域、缺失权威、超时、超大响应及无效 UTF-8 均拒绝；旧生产适配器仅扩安装请求类型 union。

新增 20 条行为测试，与原安全测试合计 31/31，Control API 类型及定向格式通过；独立只读复核未发现具体缺陷。日志为 `output/extensions/checks/plugin-security-adapters-{narrow-final,typecheck-final,format-final}.log`。当前尚未装配 main/production composition，也未实际访问权威服务；这是生产接线所需的边界基础，不能称完整生产插件宿主已交付，目标保持进行中。

## 2026-10-03：独立 UI 安装产物加载与原宿主样式核验

增加严格 `crewon.plugin-ui-lease.v1` 和有界 JSON 契约，内部 UI 用例从当前 actor/profile 读取真实安装账本，以独立 UI 权限、修订及权限 epoch 核验目录、挂载、资源和动作。引用不单独授予权限；异步前后重新核验，观察到失效的引用不随回滚恢复。实际文件适配器要求宿主批准公开子集，逐次验证完整安装目录和资源字节，不把混合包的 Node 入口默认暴露给浏览器。Node-only/未支持贡献可以从目录跳过，身份、授权、文件和未知异常仍保持拒绝。

Renderer 通过固定同源 URL 原生导入预构建 UI，支持相对 chunk；只挂在原主内容槽，传入有界主题投影及窄动作桥。隐藏模块不加载，退出同步撤回本次动作资格；更新、替换、取消和卸载分别清理自己持有的实例，失败保留诊断。当前只支持可信 `trustedModule` 的主内容模块；可信代码拥有普通 Renderer 权限，样式根节点约束不是沙箱。原生导入没有入口 SRI 且已经开始后不能取消，未实现的 `isolatedWeb`、设置和结果贡献不降级加载。

实际[仓外浏览器夹具](../artifacts/installable-plugin-ui-preview/README.md) 打包 SDK，在独立临时项目离线安装、严格编译与 bundle 两个版本，安装到真实 SQLite/目录组合后删除开发目录与 node_modules。浏览器原生获取 8 次声明的入口/chunk 字节，实际 SHA/长度与安装清单一致；v1/v2 动作分别调用实际 Node 服务，投影更新、退出/重进、升级、卸载/重挂和授权撤销通过。无会话、伪造 actor、私有 Node 资源和旧引用均拒绝，关闭后的资源为 404。最终停用修订为 4，6 个挂载引用全部关闭，撤销后没有额外成功动作。仅使用固定测试身份、测试策略及计数服务，不代表生产授权、收费调用或第二个真实企业接口。

按用户再次强调的“样式完全一致”复查 `776484c57` 与模块接入前 `2d753e8f5`：原共用 CSS、窗口框架、路由、右工作台、平台与外观文件均无插件改写；导航只追加模块入口。修正新独立预览在已有 appearance 时漏写主题的初始化，复用原主题与 URL 覆盖逻辑。实际浏览器确认原首页、侧栏品牌/工具的字体颜色及模块进入前后布局相同；左栏 232px↔0px 动态重排，左右栏同时展开时主内容 568px、右工作台 480px，矩形相邻，无覆盖及横向溢出。原 5719 页面保留；5720 临时服务正常停止，全部自有临时目录清除。截图为 `output/extensions/short-drama-preview/style-consistency-home.jpg`、`style-consistency-both-sidebars.jpg` 及 `output/extensions/independent-ui/native-installed-v2.jpg`。

统一检查 Application 271/271、Host 60/60、test-contracts 24/24、SDK 真实仓外分发 5/5、20 个 packages 类型及边界通过。额外只读审查发现 JSON 聚合预算原来在复制/序列化后检查，已改为遍历时准确累计 UTF-8/转义/标点预算，避免超大输入先放大内存；新增小预算回归不制造大内存。修复后契约专项 11/11、Application UI 24/24、Renderer 34/34，Contracts 全量 161/161、SDK 5/5 再次通过。原宿主工作台 128/128、相邻样式/预览/窗口 98/98，加上 loader/组件/架构 39/39，全为 0 失败；既有快照未改，UI lint、build、最终边界和仓库格式通过。有效日志为 `output/extensions/checks/plugin-ui-*-unified.log`、`plugin-ui-*-final.log`、`plugin-ui-json-budget-*.log` 及 `output/plugin-ui-shell-{command-workspace-narrow,style-preview-frame,build}.log`；误用 pnpm 参数分隔符启动的全 UI 检查已中断，不计验收。

生产安装 HTTP/UI、当前身份/策略与动态可见目录组合、多插件导航、Krea2/短剧独立包迁移、原 Tool/Run/operation/个人积分事务、旧任务恢复及真实企业 API 验收仍待实施，目标保持进行中。此次没有修改正式身份/Worker/积分服务，也未重复在线生图。

夹具另补齐初始化异常及提前退出的资源所有权：资源创建后逐项登记逆序清理，初始化期间 SIG 只请求退出，在当前操作结束后的检查点清理，正常 SIG/stdin 共享同一清理 Promise。启动失败、提前 SIGTERM、正常 stdin stop 和 SIGINT 的 4/4 独立进程验证通过，全部临时目录删除；各 probe 证据单独保存为 `plugin-ui-preview-cleanup-*-evidence.json`，原浏览器证据按备份原字节恢复。服务端及 Renderer 夹具通过严格类型复核，未把测试配置或身份组合并入正式应用。

## 2026-10-02：恢复插件改造前的完整前端宿主

按用户“样式完全一致”的要求，预览改为直接复用原 `DesktopWindowFrame`、`AppCommandShellRoute` 和 `CommandWorkspaceCapabilityDrawer`。撤销预览自造的导航按钮、左侧绝对定位抽屉、遮罩及模块顶端额外间距，恢复原窗口控件、品牌位置、右侧工作台开关与宽度调整。通过已有 URL 桌面样式覆盖统一 Frame、Chrome 和 appearance 的环境检测，保存的外观设置不会再把预览切回 Web；没有伪造原生 IPC 桥接。

相对历史基线 `776484c57` 和 `2d753e8f5`，原宿主与左右栏组件、六张共用样式、平台检测、字体、颜色和主题文件均无插件改写。CommandWorkspace/Chrome 仅增加可选模块入口、内容槽与切换逻辑。按用户明确要求，窄宽度预览保持桌面原 232px/0px 左栏网格，主内容随之重排；该规则仅属于预览，不改正式 Web 响应式行为。新增“AI 短剧”导航行属于新增模块。预览账号上下文为空，登录账号页脚不显示，不能将这一演示数据状态称为已登录生产界面。

相关宿主、组合、样式、架构及窗口外框回归 56/56，UI lint（含 Electron）、build 和源码格式检查通过，日志为 `output/short-drama-desktop-frame-*.log`。实际浏览器核验桌面原窗口按钮和左右栏开关，1280px 左栏展开时主内容 1048px、折叠时 1280px；766px 预览为 534px/766px，无覆盖或横向溢出。左右栏同时展开的矩形边界相邻，短剧模块仍仅占主内容区。截图为 `output/extensions/short-drama-preview/original-host-restored.jpg` 与 `original-host-both-sidebars.jpg`。此修复取代之前的预览遮罩调整；没有重跑已确认的 UI 全量基线失败，也没有修改正式业务 API。

## 2026-10-02：持久安装组合与实际本地宿主接通

新增安装领域、必需授权与可信 profile 端口、内部 Application 服务，以及共享原 SQLite/PG 生命周期的独立安装账本。记录不可变包、当前选定版本和完整 actor/scope/kind/key 回执，CAS 提交选择；精确版本/摘要和发布者命名空间不能重绑定。首装保持停用，安装新版本保留旧选择，启用/停用/切换/逻辑卸载提交新修订。回执重放返回原结果，不重安装、不重新激活，也不删除原项目、创作修订或个人积分账本。四张独立表和 schema v1 不改变原业务协议或迁移版本。

NodeHost 新增暂存 prepare/同步 commit/abort，setup 成功后仍待提交才发布；旧服务与在途借用保留，候选失败只撤销自身资源。同步发布前后核对当前实例和依赖，依赖提供者仍有活动消费者时拒绝直接升级，清理失败保留诊断。私有 `LocalPluginInstallationHost` 接通真实受控 source 目录、不可变字节安装和本地 NodeHost，要求安装/启用授权、数据与运行兼容检查、提交核验。它不是分布式领导者，也不替代原 Run 事务内的选择与积分准入。数据库确认提交后发布失败返回持久选择与 `plugin_projection_pending`，不伪装未提交；原回执重放不会重发布旧实例。启动投影恢复与生产当前权限核验尚待接入。

三项实际 Application/SQLite/文件/ESM 集成通过：安装不执行模块，删除开发源码后启用、升级、回滚与逻辑卸载，旧借用继续使用锁定版本；卸载保留通过实际服务创建的项目和独立积分流水，重新打开数据库保留选择。真实 SQLite receipt INSERT 故障、ESM setup 失败和兼容拒绝保持旧选择；提交后授权拒绝保留新选择、报告 pending 并阻止新借用，原回执不激活；显式新选择可重新协调。同步撤销授权回调中的重入发布被检测，独立新实例不被错误清理。该夹具调用当前 SQLite 选择作同步核验，不能称为生产跨进程 Run 准入证明。

最终 Domain 195/195、Application 247/247、Host 47/47、test-contracts 24/24；带唯一自有 PostgreSQL 的 Store 全量 1,358 项，1,357 通过、0 失败、1 项原无数据库提示测试按条件跳过。安装双库及真实提交关闭专项 24/24，均无跳过。第一次 Store 全量有 10 项 PostgreSQL `out of shared memory`；仅提高自有临时数据库的锁容量后，同一代码全量重跑全部行为通过，没有改测试断言或生产数据库。检查日志为 `output/extensions/checks/plugin-installation-*-unified*.log`，Store 以 `plugin-installation-store-tests-unified-final.log` 为准，数据库前后参数见 `owned-pg-resource-*.log`。

20 个 packages 类型检查、入口边界、源码及仓库格式通过。验证完成后已停止唯一自有临时 PostgreSQL，原 PID 已退出、55543 没有监听，日志和数据库证据保留。依赖锁只增 Host 的 Application/Domain workspace 依赖和实际集成测试用 Store devDependency；SDK 的公开分发与 ABI 不改。仅 `plugin-installation-local-host.ts` 被批准桥接 App/Domain，通用加载器与 SDK 边界继续禁止 Store、内部子路径和 UI 依赖。正式安装 HTTP/页面、生产授权治理、动态 UI/动作桥、原 Tool/Run 安全退休与持久恢复、Krea2/短剧独立包迁移和 E5 第二个真实企业服务仍待完成，目标保持进行中。

## 2026-10-02：可分发 SDK、真实本地安装和 Node 加载基础

新增公开 `@crewon/plugin-sdk` 0.1.0，本地 `.tgz` 分发只公开 `/contracts`、`/node`、`/ui`。使用现有 esbuild 与 TypeScript 产出三个 JS 入口、共享校验模块和九个自含声明，携带原 LICENSE/NOTICE；没有私有运行时依赖、React 或宿主源码。包描述仍来自原 Contracts 权威源，声明闭包随 SDK 输出，不手抄第二套协议。Node 专用声明无需 DOM；UI 定义包含独立 mount/update/dispose 和窄动作 ABI，实际 UI 挂载尚未实现。

新增私有 `@crewon/plugin-host`，对预构建目录核验完整实际字节、SHA-256、路径、目录项和文件/总量限额，拒绝 symlink/hardlink、非普通文件、包外路径与未声明文件。安装许可和发布者信任由必需的宿主回调判断，元数据自报身份不授信。来源快照复制到独占 staging、重新核验，再在同摘要锁下发布到宿主拥有的固定版本目录；不运行构建/生命周期脚本。坏包、旧目录损坏或取消不覆盖先前版本。macOS 的目录迁移权限问题已由实际测试修复；发布后保护失败保留产物供复核重试，正确保护的重复安装不改变 inode/ctime。

NodeHost 只从安装根目录和完整摘要导出版本路径，避免可变源码目录与 ESM 缓存混用。导入前核验身份、授权和必需服务；未声明或不兼容的服务不注入。setup 注册先暂存，成功后原子发布；失败反向清理。停用立即使启动中、排队和新借用失效，旧借用保留其服务快照；替换版本失败或依赖闭包穿过待撤旧实例时保留原选择。清理延至借用释放，清理失败保留诊断和依赖借用。这是可信同进程生命周期，公开接口不是安全沙箱。

实际仓外夹具通过本地 SDK tgz 安装、独立 TypeScript 编译与 bundle，仅解析外部项目内依赖；安装产物后删除整个开发目录及 node_modules，再成功加载、调用、停用并清理。未修改宿主业务分支或重编译宿主。SDK 行为/分发 5/5、Host 全量 31/31（17 项实际文件安装、13 项 Node 生命周期和 1 项上述仓外路径），均无失败或跳过；修正夹具失败清理后仓外路径再单次 1/1 通过。20 个 packages 类型及 test-contracts 全量 23/23 通过。应用测试夹具按既有规则改名为 `.test-support.ts`，规则未放宽，相关行为 25/25 通过。依赖锁只增两个包的 importer，不升级既有依赖。

证据为 `output/extensions/checks/plugin-sdk-*-final.log`、`plugin-host-full.log`、`plugin-independent-package-final.log`、`installable-plugin-packages-types.log` 和 `output/plugin-test-contracts-final.log`。SDK 使用说明见[README](../packages/plugin-sdk/README.md)。生产安装组合及授权治理、原 Tool/Run/配置/项目/积分端口、动态 UI、Krea2/短剧包迁移、升级后原任务恢复及卸载保留数据仍待实施；内部 Node 夹具不能算完整产品安装验收，目标保持进行中。本轮未改正式 HTTP、Worker 或 Renderer 行为，没有重复这些层的全量或在线生图。

## 2026-10-02：收回整体改版，明确独立安装目标

按用户要求，短剧页面改为复用原 CommandWorkspace 首页和侧栏，仅新增 AI 短剧入口，业务内容在原主内容区显示。删除预览自造的工作空间、账号、全局导航和主题；模块使用宿主主题与控件变量，样式限定在自己的根节点。宿主新插槽只供当前可信组件组合，未接生产 App，也不是动态安装器。原宿主 SSR 快照逐字保留；新组合与模块有真实 DOM 交互和快照覆盖。窄屏预览复用同一原侧栏，触发及抽屉样式仅属于预览宿主，不塞进业务模块。

对照原生产基线 `776484c57`，六张宿主样式及 main 未改；用户主工作区的设置样式修改也保留。实际样式失真来自预览漏写 `data-theme`，同时命中深色外壳和浅色色阶。预览首次渲染前恢复原 `getInitialTheme()` 与本地 appearance 解析，保持 URL 主题覆盖与已有偏好，不改全局 CSS。低高度验证另发现图片外描述错误绝对定位，已改回图片面板内正常布局。浏览器确认原首页、模块入口、深色继承、滚动、窄屏导航及无横向溢出；证据为 `output/extensions/short-drama-preview/host-module-restored-theme.jpg`。

UI 最终 441 文件、3,041 项：3,033 通过、8 失败。八项均由 HEAD `2d753e8f5` 独立归档基线的相同六个 suite 实际复现，含 soak trend 的已有超时；三项 obsolete 快照也保留。新增组合最初违反 UI 依赖边界，已移到 app 组合层，规则未放宽；原宿主、组合及架构专项 88/88、模块专项 3/3 通过。最终 UI lint（含 Electron）、build、入口边界、仓库格式通过。证据为 `output/extensions/checks/short-drama-host-ui-final-*.log`、`short-drama-host-ui-head-baseline-six-suites.log` 和基线 JSON；本项未修改后端行为，未重复 Store 全量。

用户随后明确“插件一定是可插拔的，做好插件协议，就可以独立开发并安装”。[可变边界](./plugin-variability-boundary.md)已区分模块业务变化与平台应用组合，并补充[可安装协议实施顺序](./installable-plugin-protocol-plan.md)。后续优先公开包协议与 SDK、实际安装/加载、独立 UI，再将 Krea2 和短剧作为包接入。须以仓外构建插件安装、停用、升级及历史恢复而无需修改宿主源码作为验收；当前试点和页面预览不能算达成。该界面阶段尚未实现安装，随后新增的 SDK 和本地 Node 基础见本页开头；动态 UI 与完整产品验收仍待实施，目标保持进行中。

用户反馈打开侧栏后整页发灰，实际浏览器确认预览遮罩误用了深色主题会反转为近白色的 `--n-950`。改为与公共弹窗相同的固定黑色遮罩语义，保持原 18% 透明度、原侧栏材质和层级，仅改预览宿主样式。导航交互 4/4 与格式检查通过；打开状态的截图为 `output/extensions/short-drama-preview/host-navigation-overlay-fixed.jpg`。本项低影响 CSS 修正未重复已完成的 UI 全量或类型检查。

## 2026-10-02：独立包描述契约第一步

通过明确的 `@crewon/contracts/plugins` 入口增加 `crewon.plugin-package.v1` 描述解析，不修改主 Contracts 导出、公共 HTTP、业务 manifest v0 或历史执行摘要。包声明插件/发布者身份、精确 SemVer、宿主 API 标签、Node/UI 入口、独立业务 manifest、依赖与提供服务、页面/设置/结果贡献，以及包内产物路径、字节长度和 SHA-256 清单。入口必须存在于清单且非空，UI 与贡献互相匹配；一个产物可用于两种入口。服务 API 标签只作有界标识解析，不暗示实际可用或兼容。

拒绝未知字段与协议、重复清单/服务/贡献、自身服务依赖、缺失入口、描述文件自引用、绝对路径和穿越、编码逃逸、控制字符、非法 Unicode、getter/异常原型、循环及超限对象。复制得到不可变独立快照，所有集合与字符串有界，总字节声明溢出时拒绝。此解析器不读取产物、核验实际字节或发布者、不执行代码、不安装或激活插件；v1 仍是新加载器的协议基础。

新增行为 15/15，Contracts 全量 150/150，无失败或跳过；18 个 packages 类型、入口边界、新文件和仓库格式通过。产物清单另拒绝文件与其子路径同时存在、描述文件成为路径祖先；合法同名前缀及共享入口保持可用。日志为 `output/extensions/checks/plugin-package-contract-*.log`。该阶段只提供元数据契约；SDK 和本地安装/Node 加载的后续基础见本页开头，完整产品端到端仍待实施，目标保持进行中。

## 2026-10-02：项目修订的实际双库存储基础

继续 S0 的存储步骤，在原 SqliteRunStore / PostgresDomainStore 宿主增加 `creativeProjectStore()`，共享连接及关闭边界。创建适配器不自动迁移；宿主显式调用独立版本 1 的项目迁移，原核心 schema、SQLite user_version、插件配置及个人积分版本保持不变。项目、需求修订、概念图元数据、描述修订及按 tenant/space/principal/actor/命令种类隔离的回执已落实际数据库，不引入第二套运行时。

读取在 SQL 层按当前本人及租户/空间过滤，子修订通过项目归属关联查询。写入在同一事务中重读项目、资产版本和确切已保存需求，复算 Domain 转换后核对全部准备记录；CAS、需求摘要或归属不匹配时拒绝。项目或输入更新与幂等回执共同提交，并发相同键返回原 ID、时间和输入快照。旧需求、描述和回执禁止修改或删除，项目与资产的稳定身份也受数据库触发器保护；归档保留历史及元数据操作，不允许新创作输入。

实际 SQLite 文件和 PostgreSQL schema 的相同契约 26/26、无跳过，使用两个独立宿主连接并关闭重开验证持久化。覆盖本人/空间/审计 actor/命令种类隔离、同键不同服务端 ID 的并发重放、项目及资产 CAS、归档、防伪需求重读、稳定 Unicode scalar / UTF-8 二进制分页、迁移兼容和未来版本拒绝。项目、首版需求、新资产、新描述及最后回执 INSERT 的具名故障均证明完整回滚；已有资产追加修订失败也不留下元数据变化。另有真实 PostgreSQL INSERT/COMMIT 屏障 2/2：提交前关闭回滚，服务端已确认 COMMIT 后关闭仍返回成功。新增存储行为共 28 项，本项不使用内存夹具作为双库证据。

本轮带自有临时 PostgreSQL 的 Store 全量 1,334 项：1,333 通过、0 失败，唯一跳过为已有的无数据库环境提示占位测试；它在已配置真实 PostgreSQL 时按原条件跳过。18 个 packages、Control、Worker 类型检查及 TypeScript 入口边界通过，仓库文档及新增源码格式通过。本轮没有重新运行 Domain/Application 行为全量，上一阶段的 184/184 与 220/220 记录继续保留；没有据此声称新的公共 HTTP、Worker 生成或正式界面验收。双库夹具关闭自己的宿主、连接并清理文件/schema，临时 PostgreSQL 实例由主任务统一管理。

日志为 `output/extensions/checks/creative-project-store-narrow.log`、`creative-project-store-full.log` 及 `creative-project-storage-*.log`。本轮只完成项目记录与输入修订的存储基础：ProjectGenerationLink / OperationResultLink、项目公共 HTTP/BFF/Client、页面真实保存、结果选用和真实扣费仍未接通，S0 未完成。生产当前身份协议及原 E5 的第二个实际企业 API 仍待提供，目标保持进行中。用户明确插件仅新增功能模块，后续界面必须保留现有 CrewON 侧边栏、顶栏、导航和普通聊天入口，不能替换整体页面；已有交互预览继续是内存演示。

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
