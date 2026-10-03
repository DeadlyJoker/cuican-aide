# 项目生成关联：内部增量协议

## 2026-10-03：按保存源读取原生成已实现

公共只读 GET、客户端、真实 Application 与 SQLite/PostgreSQL 已接通，见[保存生成读取协议](./project-generation-read.md)。它通过本人源及当前任务权限复核原 link 和完整受理回执，返回原 Run、operationRevision 及核验图片的原始 resultIndex；历史归档可读，不触发供应商、Run 或积分写入。独立只读 enable 只验证既有 schema，不迁移、不启用付费写能力；默认关闭。

SDK/Host 读取、独立插件生成页面、显式查询及结果选用仍未实现。以下章节保留前置阶段的范围。

## 2026-10-03：跨插件 Host / Control 与原事务资格已实现

当前可信 Host / Control 已接通明确批准的业务 UI 包到独立执行包的调度。新增 `ExtensionTaskApplicationService.createPublishedProjectTaskFromPlugin` 捕获保存引用、两端真实 pin、映射及本次调用资格，兼容原 `createProjectTaskFromPlugin` 内部路径。业务来源保持原 registered UI context；目标使用实际验证的 Node 包、原任务服务与自己的执行 pin，不接受插件 JSON 注入 owner、actor、付款人或可信提交回调。

`projectGenerationPublicationVersion` 只在显式完成既有 `migrateProjectGenerations()` 后提供，不新增持久 schema 版本，也不改变原 link、binding、任务请求或回执 JSON。普通默认任务及普通项目 metadata 路径不因新调度读取或迁移关联表。

本机管理/standalone 不支持付费项目生成；相关 creator 在开数据库前拒绝 `pluginGenerations`，直接 composition 也拒绝此配置，desktop 原保护仍保留。本机安装或管理账号不构成原个人执行、报价或钱包权限；明确测试资金也不改变这条部署边界。

新提交在原 SQLite/PG Turn 事务中核验两端实际安装包及 selection。PostgreSQL 以固定顺序取得真实两端 selection/package 的 `FOR SHARE` 锁，沿用原事务 client，再取得项目互斥和积分账户锁；SQLite 保持原同步事务。锁等待期间的停用、卸载或换包不能使用旧 pin 继续收费。完整 UI current 检查放在事务前；事务资格只做当前身份/profile/PDP、磁盘字节和同步 active 检查，不通过共享池重新读项目或安装 Store。消息、history、Run、目标准入、原个人预留、增强回执和不可变 link 仍同事务提交。

真实 Node 执行借用沿原严格任务 ABI 发起任务，不为业务 UI 创建第二份执行准入或付款身份。确认提交后由同一原 issuer 核验已保存事实并交付 opaque 回执；之后需求追加、归档、卸载、挂载/owner/runtime 关闭和策略撤回均不反向否定已确认的提交。幂等重放返回同一 Run、原报价、原 hold 和原关联，不再报价或预留。

Application **95/95**、实际双库 Store/单连接 Application **20/20**、真实 PG 两端安装锁竞争 **12/12**、原 Turn/付费/metadata/link Store 回归 **162/162** 均零跳过。这四份日志分别是 `project-generation-publication-application-20261003.log`、`project-generation-publication-store-20261003.log`、`project-generation-publication-locks-20261003.log` 和 `project-generation-publication-store-regression-20261003.log`，位于 `output/extensions/checks/`。原回执组在其他检查中可能复跑，不跨组求和。实际 Control owner、Production UI HTTP/TLS、Host 及构造配置的分组证据见[实施进度](./incremental-extension-progress.md)。

本阶段尚未接页面生成控件、按项目/资产/输入恢复原生成、operation 查询或结果选用；没有新增 `OperationResultLink` 或选用指针。测试身份、profile/PDP 与充值夹具不代表人类生产身份或钱包；实际 UI runtime/routes 的证明也不代表完整生产 factory 或正式 Main/full App 在线生图验收。

以下既有章节保留内部关联前置阶段的记录；其中后续 Host / Control 接线的状态以本节为准。

日期：2026-10-03。状态：已实现 Domain、Application 及 SQLite/PostgreSQL 内部适配器；尚未装配到生产 Control 或短剧模块的生成按钮。实际数据库验证与独立插件发行证据保存在 `output/extensions/checks/`。本协议不代表 S0 生图、查询和选用闭环已交付。

## 入口与身份

可信宿主通过 `ExtensionTaskApplicationService.createProjectTaskFromPlugin` 提交原严格任务命令、安装插件准入 pin、项目输入引用和本次调用的提交权威。引用只包含 `projectId`、`assetId`、不可变 `assetRevision`、当前 `expectedProjectRevision` 和 `expectedAssetMetadataRevision`。归属、审计 actor、付款人、报价、配置及 Run 均沿原服务端权威派生；插件 JSON 不能提供提交回调或付款身份。

宿主必须显式注入既有项目 Store 和当前项目授权策略。项目创建者本人仍须通过当前项目写入、插件执行和原线程/Run 权限检查。输入引用与权威回调在第一次异步等待前捕获，异步报价、锁等待和写入后继续核验撤权及调用关闭状态。

原公共任务请求、`ExtensionRunBinding`、任务回执及安装插件动作 v0 均保持原形状。新增[项目生成 UI 协议及 SDK helper](./project-generation-ui-protocol.md)只冻结保存引用及原任务回执；当前没有新增公开生成路由或启用 Host dispatcher，也未配置短剧业务插件与实际执行插件的生产映射。

## 保存的生成意图

生成必须引用已经保存的概念输入修订及其确切需求修订。事务核验 owner、tenant/space、项目处于 active、两项元数据 CAS、输入版本、需求版本与内容摘要。任务业务输入必须严格等于保存的 `{ prompt }`，保留原空白；尚未保存的页面草稿不能参与生成。

稳定资产 ID、资产元数据 revision 和不可变输入 revision 分别表示不同身份。允许显式选择历史输入，但新提交仍须提供当前元数据 CAS。改需求或输入需追加修订，不能覆盖旧输入。业务描述的摘要与原任务 `inputDigest` 分别校验；它不声称是模型实际送给供应商的完整请求。

`ProjectGenerationLink` 使用 `crewon.project-generation-link.v0`，保存本人范围、确切输入/需求摘要、原完整 binding、原任务回执身份、Run 创建时间及关联内容摘要。每个 `(tenant, space, project, asset, assetRevision)` 只有一个生成意图，每个原 Run 只有一条关联。

## 原子提交和重放

项目关联与原消息、history、Run、插件准入、独立积分冻结及任务回执在原 Turn 事务中写入。源不存在、版本冲突、余额不足、槽位占用、迟到撤权或任意后续 SQL 失败均回滚整笔事务；不能在 Run 启动后补关联。Thread 仍须先通过原线程创建路径存在，不声称线程创建属于这笔事务。

新关联命令保留原回执键范围，只把严格输入引用加入请求摘要。相同键改变、添加或移除关联均拒绝。丢失回复后重放返回原 binding、Run、报价与关联，不再冻结生成费用；重放核验当前权限，但不要求旧项目仍 active，也不重新执行已变化的元数据 CAS。

取消 Run 或释放冻结不删除生成槽位，也不表示供应商已取消。再次创作须追加一个新输入修订，即使描述相同；同一输入修订换键提交不能创建第二个收费意图。提交已成功后发生撤权不能把已确认的 COMMIT 改写成未提交；读取仍按当前权限控制。

PostgreSQL 使用与项目元数据命令相同的、含实际 schema 的项目互斥键，并在同一个已借用连接上重读源。事务内授权回调不再通过共享连接池读取项目，避免 `maxPoolSize: 1` 自等待。SQLite 继续使用原 `BEGIN IMMEDIATE`。两库均在最终异步权威检查后连续执行同步 active 检查和提交。

## 显式迁移和兼容性

只有显式调用 `migrateProjectGenerations()` 才启用内部关联能力。独立 `project_generation_schema_version` 使用版本 1；原 core、extension、项目元数据及积分迁移版本不变。冷打开后需再次显式验证该能力。默认适配器及普通任务不会读取或迁移项目元数据表。

关联表包含唯一槽位、原 binding/回执/项目/输入/需求外键、行与 JSON 身份匹配及不可变触发器。迁移、读取和提交均拒绝未知版本、残缺约束、被修改的历史保护或触发器，不静默修复已有持久化结构。

验证覆盖领域摘要与身份、应用层兼容/撤权/回执重放、实际双库回滚/并发/冷恢复/槽位，以及实际 Application 到单连接 PostgreSQL 适配器。应用层替身测试不能替代数据库原子性证据。

## 后续接线

下一步是在可信 Host/Control 中建立短剧业务到既有 Krea2 执行插件的明确映射，再接模块提交及原任务会话导航。随后接原 operation 的显式查询、核验结果枚举和确切图片选用；当前未创建 `OperationResultLink`、图片选用指针或第二套供应商状态机。

生产身份、个人插件钱包、价格和结算策略仍待权威服务协议；测试夹具的账号与资金不构成生产充值或扣费。现有 5719 页面预览及 5720 的旧发行包保持原版本，独立短剧 3.0.0 包已验证项目/需求/概念输入保存和历史，不自动替换这些预览。
