# ReelBench 复刻 P1：两类项目、原文与方案的兼容扩展

2026-10-08。依据[产品拆解](./reelbench-product-replication-analysis.md)和[验收清单](./reelbench-replication-acceptance.md)。两类项目、真实文件解析和双库持久化已实现；正式已安装插件的 HTTP 创建、方案确认、分片上传、原文解析和小说项目关联已在真实双库通过。SDK 0.1.1 与插件 39.0.0 的候选字节已冻结；新增 Node 协议使用 SDK 0.1.2，插件 40.0.0 是下一候选，尚未安装到用户桌面，也未公开发布。创意/小说页面与桌面原生服务组合已有定向验证，Agent 阶段执行仍待完成。完整产品验收没有完成。

## 2026-10-08 安装协议与实际运行接线

候选40保留原24个工具并新增8个独立 Foundation 工具，共32个。原 manifest v1 的24个上限会在真实业务注册时拒绝这个包，构建成功不证明能安装。因此新增显式 `crewon.extension-manifest.v2`，仍使用 `crewon.extensions.v1` host API，工具上限固定32。v0仍最多16个、v1仍最多24个，原字段、credential slots、schema、名称、输入和总 manifest 字节预算均不变。新版本由严格 parser 识别；旧宿主拒绝新版本，不能静默降级、删掉原工具或扩大旧版本预算。[原协议与新版本测试](../packages/domain/src/extension-manifest-vtwo.test.ts)合计10项通过，包含边界、JSON重开和旧限制回归。真实候选发行与32工具组合执行仍须另外验收。

桌面 Main 通过独立可选 `projectFoundationTools` 私有声明接到 [Native Worker](../apps/runtime-worker/src/plugins/native-project-foundation-runtime.ts)。它绑定已批准的包和确切模块，不从 UI 元数据许可或图片供应商配置推导；旧 v1/v2/v3未声明时仍没有新服务。Native 服务借用原 SQLite 和项目身份，授权只允许本 scope 的项目读取/写入；Node 不能创建项目、采用原文或确认方案。[实际 Main/Native 组合测试](../apps/runtime-worker/src/plugins/native-project-foundation-runtime.test.ts)4项通过，覆盖旧配置、附属规格读取、冷重开、外部身份与配置撤回。这组测试没有调用模型或供应商，也不代表桌面包已经更新。

Main 的原本机来源导入另将显式 `trustUiModule`、实际发布的 UI 入口与已安装包 metadata 的确切 contribution 联合核验，分别按 descriptor 声明生成 Foundation 与 SourceUploads UI publication。私有 v3 approval/bootstrap 新增可选 `projectFoundation`；无字段的原版本行为保持，v1/v2 拒绝新字段，v2 导入新能力时显式升 v3 并保留原项目许可。Node tools、供应商配置及 UI 包可见性均不能单独推导新 UI 权限。真实冻结40导入、保存后冷 bootstrap 和原 Control parser 转发验证包含在 [Main 测试](../apps/crewon-ui/electron/desktopLocalProjectFoundationApproval.test.ts)；与原 sourceImport、bootstrap、Node 许可回归合计97项通过、0跳过。此测试没有修改用户 profile 或安装桌面 App。

原 Run 事务的真实双库验证包含34项附属 schema/读取测试、11项 Tool 提交/未知结果重试测试，以及78项原 Stage/Run 回归，均无跳过。实际提交前撤权回滚，提交完成后准确发布已有回执；候选追加不推进 Foundation 或自动确认。另有28项新下游门禁与109项原文本/资产/计划回归验证当前来源和确认有效性。下游门禁只验证**当前资格**，尚不代替长篇计划各批次固定输入依据的完整实现。

新工具的模型输出必须在其独立边界保证整个 wrapper 的 UTF8字节数小于10,000；将大 JSON 拆成字符串数组不构成多个模型 fragment。原宿主的40,000字节工具结果投影会截断更大的输出，不能依靠较大的服务 DTO 预算或包装 allowance 声称模型上下文合格。宿主仍可返回完整有界 DTO；插件参数正文和章节按明确游标分页，页面和原协议保持。整个候选40真实模型投影及流式/停止/重连验收须记录完成证据后才算通过。

## 2026-10-08 独立 Node 协议与 Run 资格进度

新增 [Domain 附属记录](../packages/domain/src/project-foundation-run-admission.ts)、[可移植 Node 合同](../packages/contracts/src/project-foundation-tools.ts)和 [SDK client](../packages/plugin-sdk/src/project-foundation-tools.ts)，服务为 `crewon.project-foundation-tools@1`。首期只处理原 `discussion` 阶段，八个操作为 `foundation_scope`、`foundation_read`、`foundation_source`、`foundation_source_page`、`foundation_chapters`、`foundation_proposal`、`foundation_proposals`、`foundation_proposal_save`。全部符合原插件 operation 的24字节限制，没有扩大旧规则。

- 读取范围、规格、来源、章节和候选方案；唯一写操作是保存新的候选方案。Node 不确认方案，不创建项目，不改参数、来源或创意起始模式。确认仍走真实人工 UI 动作，不能用 UI pin 或旧 stage 的 allowedOps 替代新的 Node 许可。
- 新 [Run sidecar schema](../packages/store/src/project-foundation-run-schema.ts)与旧 `ProjectStageRunAdmission`、Run DTO、项目 v0 和原 receipt namespace 分离，复用原数据库和连接。显式迁移建立附属表；构造与读取不做 DDL。原 discussion Turn 的[事务接点](../packages/store/src/project-foundation-run-turn.ts)从真实当前 binding、Foundation、参数和来源生成事实及 required marker；事实记录不授予服务或写权限。旧项目没有 Foundation 时沿原协议执行，不在读取中补写新对象。
- [独立 Node factory](../apps/runtime-worker/src/plugins/installed-plugin-project-foundation-tools.ts)要求显式部署配置及独立服务授权；缺配置不提供新服务。真正调用还需原 Worker 的 command 对象、Tool receipt、claim/lease、任务准入、当前安装记录和 PDP。新的 [Run commit authority](../packages/application/src/project-foundation-run-commit-authority.ts)只接受自己的版本和 `foundation_proposal_save`，重试键由真实 Tool receipt 派生，插件不能指定。对已经要求新资格的 Run，私有 required marker 或对应 sidecar 缺失、不匹配时拒绝；配置、skill、可见 DTO 和附属记录均不替代授权。
- 冻结指针包含 Foundation revision、独立 parameters revision/摘要、source 和 confirmedProposal。上游改变会返回 `project_foundation_run_inputs_stale` 冲突，损坏资格记录仍按 invalid 拒绝。latestProposal 仅为上下文提示；本 Run 保存候选不会推进 Foundation，也不会因此撤掉自己的读取资格，候选追加另以 expectedProposalRevision 做 CAS。
- 输入最多24KiB；scope、来源/方案正文页、方案历史和保存回执最多8KiB，完整规格与16项章节页最多32KiB。原文及方案正文每页最多1024 Unicode scalar，历史每页最多4项元数据，保存回执不回显正文。32KiB 仅适用于这个新协议的两个动作，不改变旧工具限制，不静默截断参数，不注入全书。
- `foundation_read` 可携带 `parametersStartOffset`（0..8192）和 `parametersLimit`（1..1024），供插件模型投影读取规范参数 JSON 的 scalar 页；省略表示0/1024，宿主完整规格 DTO 不变。`foundation_chapters` 省略 `afterStartOffset` 表示首屏，线上的 null 拒绝，数值0是实际游标并排除 startOffset 为0的章节。这些字段只属于新 Node 协议，不扩大原 Workflow schema 的类型范围。

本支线定向验证：Domain/Contracts **20项通过**，新独立 Run authority 与原协议回归 **21项通过**；SDK 0.1.2 的真实 tarball **87项通过**，包含仓外 ES2022、无 DOM、`types: []`、不使用 skipLibCheck 的编译。新增[重放发布测试](../packages/application/src/project-foundation-application-replay.test.ts)与原 Foundation Application suite 合计 **26项通过**：Store 已完成资格核验并发布 committed replay 后即刻撤权，Application 准确返回已有事实；后续新调用仍拒绝。该 memory-port 测试只验证 Application 契约，不证明 SQL COMMIT、实际安装行或 genuine Worker dispatch。

新协议已接入[原 Worker composition](../apps/runtime-worker/src/plugins/installed-plugin-runtime-composition.ts)、[私有 Run snapshot](../apps/runtime-worker/src/plugins/installed-plugin-run-context.ts)和[原 resolver](../apps/runtime-worker/src/plugins/installed-plugin-runtime-resolver.ts)。只有原安装 manifest 明确声明新工具时才组装独立 owner；旧包和没有 opt-in 的部署保持原路径。实际 SQLite 的[安装集成](../apps/runtime-worker/src/installed-plugin-foundation-tools.integration.test.ts)通过真实安装行、原 discussion Turn、附属资格和原 Worker 派发八个操作，覆盖候选保存后回执丢失、物理冷重开、单一方案、人工确认状态未变及 SSE 输出/序号续读；完整规格超过8KiB仍按独立32KiB响应预算读取。缺配置、独立服务权限撤回、全部附属表丢失分别拒绝新工具，不从旧 project.write 或 stage allowedOperations 回退。此夹具使用明确内部来源配方，不声称真实上传采用、候选40模型包装或完整短剧 Agent 已验收。原 resolver/context/lifecycle 等回归 **58项、56通过、2个原跳过**；冻结39原 Stage 的真实 SQLite 与 PostgreSQL 回归 **2项通过、0跳过**，没有重建39。

日志为 `foundation-tools-contract-domain-test.log`、`foundation-tools-run-authority-test.log`、`foundation-tools-sdk-test.log`、`foundation-application-replay-test.log`、`foundation-worker-runtime-integration.log`、`foundation-worker-original-regression.log` 和 `foundation-worker-original-stage-regression.log`，均位于 `output/extensions/checks/reelbench-p1-import-20261008/`。这些合同、包编译及定向测试不代表候选40已安装，也不代表新 UI、停止/重连和完整短剧 Agent 流程已通过端到端验收。下文保留各阶段原证据；“尚未实现”描述记录当时的范围，以本节与正式上传进度为准。

## 2026-10-08 正式上传与候选页面进度

- [原安装 HTTP 集成](../apps/control-api/src/project-foundation-plugin-ui.integration.test.ts)和[原始分片集成](../apps/control-api/src/project-source-upload-plugin-ui.integration.test.ts)合计 **12 项通过、0 跳过**，覆盖真实 SQLite 与 PostgreSQL、HTTPS profile/policy、已安装字节和实际启用记录。小说链路为 begin → 两片原字节写入/精确重放 → prepare → 两个项目复用同一 ready 上传 → 真实章节/Unicode 正文读取。没有创建 Run，也没有替代 Agent 执行验收。
- 原上传 JSON 动作与独立 raw writePart 共用真实挂载、安装事务和原账户；业务 write 权限独立于 status/prepare/adopt。应用层新增 **12 项 raw 专项测试**，验证首个 await 前复制、原生取消、CAS 竞态及真实 COMMIT 后返回事实。Control-client 实际原生 HTTP **13 项通过**，原插件/恢复/Origin 回归 **24 项通过**。
- 网页 BFF 实际 HTTP 与原身份/CSRF、响应限额、断连路径已验证，全套 **85 项通过**。SDK 候选 **83 项通过**，包含真实 tarball 仓外 ES2022/DOM 编译、原 UI ABI 兼容及分片回执丢失后的显式重放。SDK 未上传公共 registry；[准备脚本](../scripts/prepare-short-drama-sdk.ts)可在 clone 后生成独立插件所需 tarball。
- 原网页与桌面 UI loader 均沿原 Control 客户端提供可选原生字节方法；只有真实挂载声明 SourceUploads v1 时才提供该传输方法；每次请求还需实际后端 owner 与独立权限。两项新增元数据依赖保持 optional，避免整个安装包的依赖声明阻断尚未提供这些 Node 服务的原执行工厂。连接就绪提示不代表服务可用或授权。插件 39 使用模块内原主题，首页区分创意与小说，编辑参数、保存/确认方案及按需读取原文/章节；候选页面和 File 编排测试仍与实际桌面、供应商、Agent 端到端验收分开记录。
- 插件候选双入口构建与独立 UI/File 编排行为 **385 项通过**；原宿主挂载和 raw 传输 **24 项通过**，原 UI source/preview 回归 **32 项通过**。这些覆盖与全 UI 初次运行仍有的其他失败分开记录；全 UI 尚未宣告通过。
- [桌面正式组合](../apps/control-api/src/desktop-project-foundation.test.ts) **10 项通过**，原 Native startup、运行、恢复、计划、会话及媒体工厂回归 **76 项通过、0 跳过**。原 v3 私有配置新增可选 Foundation 声明，旧配置保持；真实 SQLite 上验证上传、解析、小说创建、方案确认、冷重开、提交前撤权回滚及 COMMIT 后返回事实。Foundation 新增可选同步外部授权钩子，最终提交仍核对原私有配置、scope 和实际 profile；Application 对应 **16 项通过**。没有修改用户 profile，也没有更新已安装 App。
- 当时全部 packages 类型检查、UI/桌面 host lint、TypeScript boundary 与仓库格式检查通过。Control 全量启用真实 PG 后执行1454项：1413通过、1失败、7取消、33跳过；8个失败/取消用例记录执行或供应商请求超时。对应原文件按原时限、文件并发2重跑完成81项通过，没有提高时限、修改生产执行或删减断言；全量初次运行本身仍不能报告通过。
- 后续阶段仍需在实际提交事务内执行来源/方案确认门禁，接入原 Run/Tool 与 shuohao skills，完成对象成果关系、媒体生成、手动/Agent 接力、冷恢复和桌面更新。HTML 快照、测试数量与 HTTP 成功不能代替这份完整产品验收。

日志位于 `output/extensions/checks/reelbench-p1-import-20261008/`，包括 `source-upload-formal-http-tests.log`、`upload-raw-control-client*.log`、`source-upload-bff-test-final.log` 和 `sdk-source-upload-0.1.1-final-tests.log`。下列“本轮实施记录”保留底层阶段的原证据；其中“尚未接线”仅描述当时阶段，最新状态以上述记录为准。

## 本轮实施记录

| 工作               | 当前状态与证据                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两类项目和独立版本 | [领域入口](../packages/domain/src/project-foundation.ts)、[严格参数](../packages/domain/src/project-foundation-validation.ts)已实现。创意明确保存方案确认/直接剧本选择；小说新建要求原文指针。`episodeMode` 明确区分 single/series，单集保存1集，系列可保存未定集数。                                                                                           |
| 参数、来源和确认   | [不可变方案](../packages/domain/src/project-proposal.ts)绑定来源和参数版本；参数/来源变化取消确认，旧方案和原文保留。领域门禁已实现，实际下游执行服务尚未接入此门禁。                                                                                                                                                                                           |
| 原文清单与按需阅读 | [原文领域](../packages/domain/src/project-source.ts)区分原文件摘要与规范文本摘要。正文块最多4096 UTF8字节；分页最多1024 Unicode scalar；章节独立于分集，支持按来源版本/摘要分页索引。                                                                                                                                                                           |
| 原库原子持久化     | [SQLite](../packages/store/src/project-foundation-sqlite-store.ts)与[PostgreSQL](../packages/store/src/project-foundation-postgres-store.ts)借用原宿主连接，独立[schema](../packages/store/src/project-foundation-schema.ts)和回执。原子创建v0项目、brief、规格、原文；方案保存不推进规格版本，确认另行CAS。父store提供构造入口，但宿主服务启动尚未启用新迁移。 |
| 独立提交资格       | [store port](../packages/application/src/project-foundation-store-port.ts)和[authority](../packages/application/src/project-foundation-commit-authority.ts)已实现。新动作不接受旧v1 pin；事务内核对安装tuple/完整快照，提交前撤权回滚，确认提交后返回事实。真实UI invocation注册、PDP服务与committedMetadata发布仍待接入。                                      |
| 验证               | [存储行为测试](../packages/store/src/project-foundation-store.test.ts)已在真实SQLite与临时PostgreSQL18完成38项、0跳过；含20,000,000字节规范正文完整写入/重开/跨块Unicode阅读、末尾窗口、20MB+1拒绝与无半写入。[schema测试](../packages/store/src/project-foundation-schema.test.ts)7项覆盖旧v0保留、独立版本、损坏schema拒绝及真实PG迁移。                      |

本轮仍是P1内部基础。以下增量推进到真实字节和服务层；**不表示正式上传入口、插件页面或Agent已经打通**，不能把内部测试算作[产品验收](./reelbench-replication-acceptance.md)的端到端通过。

| 新增工作         | 当前状态与限制                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原始文件解析     | [解析入口](../packages/media-runtime/src/project-source-import.ts)支持TXT、MD、HTML，严格UTF8及带BOM的UTF16LE/BE、统一换行；原始字节fileDigest与规范正文digest分别计算。HTML通过正式[parse5](https://parse5.js.org/)构造有预算的惰性树，不执行脚本或拉取资源；章节位置按Unicode scalar保存。14项测试通过，含真实20,000,000字节Unicode、错误编码、格式伪装、HTML实体、脚本隔离和规范正文扩容超限。它仅接受字节，不提供上传路由或磁盘journal。 |
| 准备结果绑定     | [host port](../packages/application/src/project-source-preparation-port.ts)核对真实owner/uploadId/fileDigest、每块摘要、连续位置、全正文摘要与章节范围，再由服务绑定项目身份。4项防伪/Unicode/输入边界测试通过；完整原字节的真实性仍由实际host字节读取器与parser提供，接口DTO本身不证明已消费任何SQL上传记录。                                                                                                                               |
| 两类项目业务服务 | [Application](../packages/application/src/project-foundation-application-service.ts)实现六种写动作与原文/章节/方案读取；使用原项目身份和PDP端口，receipt重放先于新ID和上传读取，提交前复核权限，提交成功后准确返回事实。21项测试通过，包括不同来源参数、CAS、来源/方案确认、历史重放、读取后撤权、提交后撤权与副作用前拒绝。默认来源准备改用可恢复上传journal；内部原解析器夹具明确选择trusted-internal-recipe，不代表真实上传采用。         |
| 独立公共合同     | 新[@crewon/contracts/project-foundation](../packages/contracts/src/project-foundation.ts)包含12个UI动作的严格codec。原public project和冻结SDK结构保持；新DTO不带owner、tenant、space或actor。输入24KiB、响应60KiB、正文1024scalar、章节16项、方案3项分页，保留最大转义正文且无静默截断。21项测试通过，含first source revision1、确认的前一规格版本、旧结构拒新增字段和历史回执快照。Node工具协议及真实调用注册尚未实现。                     |

原文件和规范正文都有独立20MB上限，UTF16解码后规范UTF8文本超限会明确拒绝，不截断。`fileDigest`不再只是parser的调用方声称值。新增[上传服务与双库journal](./reelbench-source-upload-protocol.md)保存实际64KiB原字节、不可变分片清单、原文件封存、解析claim、规范正文/章节及有版本的prepared proof；异步PDP在借连接前，实际全文hash与parser在写SQL事务外，提交前同步检查，PG支持maxpool=1。真实20,000,000字节/306片、冷重开、CAS、Unicode/编码、未知故障恢复和规范正文扩容拒绝已完成内部验证。

同一prepared upload可以关联多个项目，没有consumed标记。新增[准备桥接](../packages/application/src/project-source-upload-foundation-adapter.ts)、[采用证明](../packages/store/src/project-foundation-source-adoption.ts)、[SQLite采用](../packages/store/src/project-foundation-sqlite-source-adoption.ts)及[PG采用](../packages/store/src/project-foundation-source-adoption-postgres.ts)。默认严格模式拒绝无来源凭证；原项目事务内核对真实upload/schema realm、owner、封存清单、ready状态、prepared manifest及不可变章节/正文描述，再一起提交原项目、source、association与receipt。元数据根在借写连接前计算，不在写事务解析或全文hash，也不另借pool。旧内部配方验证显式选择trusted-internal-recipe；正式组合不使用此选项。独立adopt权限以真实回调组合项目Current/Active及安装transaction.Current，指针不替代授权。实际上传采用集成在SQLite/PG通过14项、零跳过：12片UTF16源、120集参数、实际SQL关联与Unicode窗口、冷重放不读上传/不生ID、一源多项目和UI/Agent同principal、错误realm/摘要/metadata/自洽正文拒绝、追加来源与旧确认指针同事务回滚/失效、独立项目/采用权限在关联写入后撤回回滚、真正写COMMIT后撤回仍返回事实。GC、公开HTTP/BFF、SDK和实际两端页面上传尚未实现。

基础双库定向验证为 **64项通过、0跳过**（38项行为、19项真实插件安装/行锁资格、7项schema）。新增[真实文件导入集成](../apps/control-api/src/project-foundation-import.integration.test.ts)在SQLite和临时PG18完成 **10项通过、0跳过**：实际TXT/MD/HTML字节经解析器、owner准备端口、业务服务、原数据库和公共codec，覆盖物理重开、章节及跨块分页、方案确认/失效、并发CAS、拒绝错误身份和不读取临时上传的receipt重放。此集成仍是内部端口，未经过正式HTTP、安装插件和Agent执行。

全部packages typecheck与Control API/Runtime Worker/Device Gateway typecheck通过。`pnpm --filter './packages/**' -r test`全量通过：domain 338项、contracts 635项、application 717项通过/11项既有环境跳过、store 1389项通过/566项既有环境跳过；全包默认未设置PG变量，新增双库用例另以真实PG18完整执行。media-runtime没有test脚本，其14项新解析器测试已单独运行。

初次全包测试在`test-contracts`暴露的5项现有边界问题已核对[已有架构决定](./package-boundary-adapter-registry.md)，按逐文件完整specifier登记并补反向拒绝测试；默认Application/SDK/renderer限制保留，32项boundary测试通过。SDK历史查询公开类型改为可移植取消接口，保留原生信号验证及取消行为；57项SDK测试通过，含两个真实离线tarball在外部ES2022/noDOM/`types: []`工程的编译与执行。严格类型检查暴露的UTF8排序数组下标问题已依据循环内长度检查补充非空断言，contracts既有行为测试通过。

完整Control回归执行1402项：1368通过、33项既有环境跳过，唯一失败为新增测试在只读事务COMMIT后误撤写权限。修正fixture区分只读/写事务后，该真实PG写COMMIT用例单独通过；未更改生产授权顺序。先前暴露的调用目录依赖、mixed-reader安全字段及容量保护问题也保留原失败记录；只修夹具路径/投影及清理本任务测试profile浏览器缓存，冻结包身份、生产权限、原磁盘保护和用户数据均保留。32项legacy UI验证、150项原CommandWorkspace验证及真实full-app browser路径通过，原网页身份链、任务/SSE、Worker执行和冷重开均经实际服务验证；这条旧插件兼容证据不是新短剧UI验收。

检查日志保存在 `output/extensions/checks/reelbench-p1-foundation-20261008/` 与 `output/extensions/checks/reelbench-p1-import-20261008/`。本轮没有安装新桌面插件包或向用户项目写数据。

下一步仍按P1顺序：沿原桌面IPC与云端HTTP/SDK注册实际上传 → 真实UI invocation注册/提交结果发布、独立Node协议及Run/Tool资格 → 两类创建页与原主页Agent。人工确认走UI动作，不能用合成UI pin冒充Agent执行授权。独立可移植上传Contracts已完成20项测试，含真实ES2022/noDOM/types[]声明闭包编译；它没有注册任何公开产品入口。新Foundation SDK client和真实UI私有调用owner正在下一阶段实施，尚未安装到用户桌面。实际下游服务还需执行来源/确认门禁，完成后再验收P1端到端路径。

## 决定

采用**原项目身份 + 独立附属规格 + 新协议**。保持原 `CreativeProject` v0 和 UI/HTTP v1 的字段、行为、旧记录及回执。单独改插件 UI 无法满足完整复刻，必须让宿主服务、运行工具和插件同时支持新协议。

项目来源用附属规格区分 creative/novel，不修改 `kind: short-drama`。既有项目无规格时明确来源未确定，不在读取中自动写入或猜测。所有来源、方案、成果和会话关联原 `(tenantId, spaceId, projectId)`，不创建第二套项目或聊天身份。

## 已核查的硬边界

| 原实现                                                                                                                                  | 边界与影响                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [项目v0](../packages/domain/src/creative-project.ts)、[校验](../packages/domain/src/creative-project-validation.ts)                     | 精确字段校验；不能偷偷加来源和参数或改kind                                                  |
| [HTTP返回](../packages/contracts/src/creative-project-control-response.ts)、[SDK UI](../packages/plugin-sdk/src/creative-project-ui.ts) | 外层和项目响应都严格；旧getProject不能多返回source，即使声称可选                            |
| [项目Schema](../packages/store/src/creative-project-schema.ts)                                                                          | 原schema版本只接受1；不能升级该版本表让旧宿主拒绝启动                                       |
| [文字Schema](../packages/store/src/project-text-schema.ts)                                                                              | 只允许outline/script；原文和改编方案不能冒用已有文字产物类型                                |
| [主页规划](../packages/contracts/src/project-planning-service.ts)                                                                       | 16集newProject启动建议；已有确认/创建/关联/执行路径可以复用，但不是改编骨架历史             |
| [SDK UI](../packages/plugin-sdk/src/creative-project-ui.ts)、[工具服务](../packages/contracts/src/plugin-project-tools-service.ts)      | v1 invoke JSON为24KiB，现有工具响应8KiB量级、内容1024 Unicode字符分页；20MB原文必须独立分块 |
| [旧提交映射](../packages/store/src/creative-project-plugin-commit-support.ts)                                                           | 六种mutation固定映射旧动作；新来源/方案不得借旧createProject许可写入                        |

## P1 数据和事务

1. 新增 `ProjectFoundation`：来源类型、目标参数、规格revision、来源版本和方案确认指针，关联原项目身份。
2. 在原SQLite/Postgres连接中新增独立版本表和附属表：规格、原文版本、章节/位置索引、内容块、方案不可变版本、确认指针、上传准备记录、幂等回执。原项目JSON、schema版本和receipt namespace保持。
3. 原文准备绑定真实actor/scope、格式、总字节、digest。块序号/内容摘要防止错序和不同内容的同键重试；中断从已确认块继续。只读按source revision、digest及Unicode位置有界分页；章节ID与episodeId分开。
4. 创建在同一事务提交原v0项目、初始brief、附属规格和准备好的来源关联。不能先v1创建再独立存类型，避免不可恢复半成品。事务失败不宣称项目创建成功。
5. 方案保存不可变版本；人工确认携带预期规格revision、方案revision、source digest与目标参数版本，提交内重新核对。创意直接写剧本作为明确选择保存；小说骨架未确认不进入新分集流程。上游变化使确认失效，但不删除历史和原成果。
6. 旧文字计划16集/18步以及建议16集限制需要版本化规模方案，模型单次输入仍有界；不能靠扩大数组完成长篇兼容。

## P1 协议与权限

新命名空间起点为 `crewon.project-foundation@1` / `crewon.project-foundation.v1.*`，独立严格codec，经原 `services.invoke` 接入。旧冻结SDK/v1保持。新服务缺失时，保留旧项目原有操作，新类型入口清楚说明能力不可用。

新动作有自己的事务资格、授权和回执，复用原principal/PDP、启用版本、package digest、selection revision。原安装包pin与CAS在同一事务检查，提交前撤权或切包拒绝；已经提交后准确返回原结果，不能因为随后撤权判成未知失败后重复创建。参考[原mutation应用](../packages/application/src/creative-project-mutation-application.ts)和[SQLite提交](../packages/store/src/sqlite-creative-project-store.ts)。

桌面dispatch的committedMetadata、生产request adapter、认证与可用性注册同时接入。新动作不拼在旧返回对象里。若新增HTTP，BFF对应策略与生成契约一起更新，防止前端能发而代理返回404。

Agent与手动入口调用同一业务服务；扩展来源/规格读取与方案产出工具，人工确认走UI动作，复用原主页会话/模型/工具/Run。不注入全书，不增加插件私有聊天存储。

## 实施位置

| 层          | 新模块及接入位置                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain      | 新foundation/source/proposal类型与独立校验模块，导出于[入口](../packages/domain/src/index.ts)；原项目形状不改                                                                                                                                                                                                                                                                         |
| Application | 新store port、application service、mutation authority、plugin action owner，导出于[入口](../packages/application/src/index.ts)                                                                                                                                                                                                                                                        |
| Store       | 新独立schema、SQLite/Postgres store与事务模块；共享[SQLite连接](../packages/store/src/sqlite-run-store.ts)、[Postgres连接池](../packages/store/src/postgres-domain-store.ts)，从[入口](../packages/store/src/index.ts)导出                                                                                                                                                            |
| Contracts   | 新UI/Node/public codec与[package exports](../packages/contracts/package.json)；提供HTTP时同步endpoint与[生成契约](../packages/contracts/src/generated/control-api.ts)                                                                                                                                                                                                                 |
| Control API | [项目组合](../apps/control-api/src/creative-project-composition.ts)、[桌面插件runtime](../apps/control-api/src/desktop-plugin-runtime.ts)、[桌面dispatch](../apps/control-api/src/desktop-project-plugin-ui-dispatch.ts)、[生产组合](../apps/control-api/src/production-plugin-ui-composition.ts)、[生产request服务](../apps/control-api/src/production-plugin-ui-request-service.ts) |
| Worker      | 独立来源/方案工具、Node服务与有界projection；接[installed services](../apps/runtime-worker/src/plugins/installed-plugin-project-services.ts)与[installed tools](../apps/runtime-worker/src/plugins/installed-plugin-project-tools.ts)，保留原project-tools v1                                                                                                                         |
| Plugin      | 新便携codec/client/controller；接[构建](../examples/plugins/short-drama/build.mjs)、[项目控制器](../examples/plugins/short-drama/src/workbench/creative-project-controller.ts)与主页；规格独立缓存，不给PublicCreativeProject加字段                                                                                                                                                   |
| Web BFF     | 新HTTP后缀同步[代理策略](../apps/web-bff/src/creative-project-proxy-policy.ts)，保持原端点行为                                                                                                                                                                                                                                                                                        |

先完成领域合同和兼容夹具，再持久化/权限与服务接线，最后接两类首页和原Agent。每步使用上述既有架构与pnpm，不另建运行时；不修改无关团队/办公室代码。

## P1 交付门槛

- 旧数据库、旧冻结SDK、已安装插件读取和编辑仍通过；原项目、会话、工作空间及采用版本不变。
- 两类创建进入正确第一步；参数、原文和来源可读；创建失败或响应丢失可恢复，同键同内容幂等，同键不同内容冲突。
- 跨owner/scope拒绝；提交前停用或版本切换拒绝，提交后撤权仍准确返回已提交结果。
- 20MB边界、格式/编码失败、分块中断、重复块、Unicode分页无遗漏；原文不经过旧小payload通道。
- 过期方案不能确认；来源变化与已确认版本明确区分；重启后规格和确认指针保留。
- 两类页面与原主页Agent读取同一数据；流式、停止/重连、未知回执遵守原运行语义。

P1完成只代表项目、原文和方案基础闭环，不代表媒体、分镜、完整长篇编排及完整复刻已经验收。
