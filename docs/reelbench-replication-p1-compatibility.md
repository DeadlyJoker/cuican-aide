# ReelBench 复刻 P1：两类项目、原文与方案的兼容扩展

2026-10-08。依据[产品拆解](./reelbench-product-replication-analysis.md)和[验收清单](./reelbench-replication-acceptance.md)。两类项目、真实文件解析和双库持久化已实现；正式已安装插件的 HTTP 创建、方案确认、分片上传、原文解析和小说项目关联已在真实双库通过。SDK 0.1.1 与插件 39.0.0 为未公开发布、未安装候选；创意/小说页面与桌面原生服务组合已有定向验证，Agent 阶段执行仍待完成。用户已安装的桌面插件尚不能调用新服务，完整产品验收没有完成。

## 2026-10-08 正式上传与候选页面进度

- [原安装 HTTP 集成](../apps/control-api/src/project-foundation-plugin-ui.integration.test.ts)和[原始分片集成](../apps/control-api/src/project-source-upload-plugin-ui.integration.test.ts)合计 **12 项通过、0 跳过**，覆盖真实 SQLite 与 PostgreSQL、HTTPS profile/policy、已安装字节和实际启用记录。小说链路为 begin → 两片原字节写入/精确重放 → prepare → 两个项目复用同一 ready 上传 → 真实章节/Unicode 正文读取。没有创建 Run，也没有替代 Agent 执行验收。
- 原上传 JSON 动作与独立 raw writePart 共用真实挂载、安装事务和原账户；业务 write 权限独立于 status/prepare/adopt。应用层新增 **12 项 raw 专项测试**，验证首个 await 前复制、原生取消、CAS 竞态及真实 COMMIT 后返回事实。Control-client 实际原生 HTTP **13 项通过**，原插件/恢复/Origin 回归 **24 项通过**。
- 网页 BFF 实际 HTTP 与原身份/CSRF、响应限额、断连路径已验证，全套 **85 项通过**。SDK 候选 **83 项通过**，包含真实 tarball 仓外 ES2022/DOM 编译、原 UI ABI 兼容及分片回执丢失后的显式重放。SDK 未上传公共 registry；[准备脚本](../scripts/prepare-short-drama-sdk.ts)可在 clone 后生成独立插件所需 tarball。
- 原网页与桌面 UI loader 均沿原 Control 客户端提供可选原生字节方法；只有真实挂载声明 SourceUploads v1 时才提供该传输方法；每次请求还需实际后端 owner 与独立权限。两项新增元数据依赖保持 optional，避免整个安装包的依赖声明阻断尚未提供这些 Node 服务的原执行工厂。连接就绪提示不代表服务可用或授权。插件 39 使用模块内原主题，首页区分创意与小说，编辑参数、保存/确认方案及按需读取原文/章节；候选页面和 File 编排测试仍与实际桌面、供应商、Agent 端到端验收分开记录。
- 插件候选双入口构建与独立 UI/File 编排行为 **385 项通过**；原宿主挂载和 raw 传输 **24 项通过**，原 UI source/preview 回归 **32 项通过**。这些覆盖与全 UI 初次运行仍有的其他失败分开记录；全 UI 尚未宣告通过。
- [桌面正式组合](../apps/control-api/src/desktop-project-foundation.test.ts) **10 项通过**，原 Native startup、运行、恢复、计划、会话及媒体工厂回归 **76 项通过、0 跳过**。原 v3 私有配置新增可选 Foundation 声明，旧配置保持；真实 SQLite 上验证上传、解析、小说创建、方案确认、冷重开、提交前撤权回滚及 COMMIT 后返回事实。Foundation 新增可选同步外部授权钩子，最终提交仍核对原私有配置、scope 和实际 profile；Application 对应 **16 项通过**。没有修改用户 profile，也没有更新已安装 App。
- 当前全部 packages 类型检查、UI/桌面 host lint、TypeScript boundary 与仓库格式检查通过。Control 全量启用真实 PG 后执行 1454 项：1413 通过、1 失败、7 取消、33 跳过；8 个失败/取消用例均记录执行或供应商请求超时，正在按原时限、较低文件并发复核。没有提高时限、修改生产执行或删减断言，尚不能报告 Control 全量通过。
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
