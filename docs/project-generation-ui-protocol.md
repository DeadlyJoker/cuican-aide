# 项目生成 UI 协议与跨插件回执

2026-10-04 更新：独立短剧 5.0.0 的生成控件、真实就绪检查、原会话准备及模块重开后的未知请求恢复已接通，见[项目生成上下文](./installed-plugin-generation-context-actions.md)。下文 2026-10-03 的阶段验证保留历史范围；原操作查询、确切结果选用和完整应用重启恢复仍未完成。

## 2026-10-03：实际 Host / Control 调度已接通

当前已实现 `PluginProjectGenerationActionBridge`、`PluginProjectGenerationExecutionBridge` 和 `InstalledPluginProjectGenerationOwner`。明确部署映射把实际安装的业务 UI 包关联到另一个实际安装的执行包；原 `PluginUiApplicationService` 注册并持有业务 UI context，执行端使用自己的包字节、安装 pin、当前策略及真实 Node 借用。没有复制或伪造目标 UI context，没有从插件 JSON 接受可信 actor、付款人、prompt 或执行配置。

`crewon.project-generations@1`、唯一 `generateConcept` 动作、SDK helper 及四字段输入保持不变。响应仍为原六字段任务受理回执；新增调度沿用 `/api/v1/plugins/ui/mounts/:mountRef/actions`，没有新增公开 HTTP shape、任务 action kind 或第二套供应商状态机。原普通任务动作保留原路径。

UI-only 包的生成依赖由实际 owner 发布的受信 Host availability 明确提供，只接受批准的 source 包摘要与贡献。协议可用性不授予执行权限；没有 owner、未知声明、错误映射或关闭后的 owner 均拒绝，默认不开启。执行包的真实声明、字节、当前选择、策略及 readiness 在派发时独立核验，不把 Host 协议伪装为 Node 服务。

本机管理身份及 standalone 装配不支持付费项目生成，配置 `pluginGenerations` 在打开数据库前拒绝，不能从本机管理权限派生个人执行或付款身份。生产开启仍须明确映射、原已授权付费任务配置及真实业务身份；测试夹具不授予这类部署权限。

提交进入 `createPublishedProjectTaskFromPlugin` 显式内部入口；原内部生成入口保持兼容。Store 在原事务连接上验证并锁定两端安装选择，再核验保存输入、项目 CAS、原执行准入和独立积分预留。完整 UI current 检查仅用于事务前的实际调用；借用连接期间使用不重新读取共享 Store 的事务资格及原 invocation active 检查，单连接 PostgreSQL 不发生嵌套取连接。

Control 构造核对 generation owner、实际 task owner、任务服务和原 issuer 的精确配对，并核对 issuer 已捕获相同明确映射。确认提交后由原 `PluginUiCommittedTaskAuthority.issueProjectGeneration` 读取真实 Run、付费准入、增强回执和历史项目关联，签发原 context 的一次 opaque 回执。之后的挂载/owner/runtime 关闭、策略撤回或元数据后改，不把已确认 COMMIT 变成重试信号。

本阶段真实 Control owner 专项 **24/24**、原 owner 回归 **21/21**、Production UI HTTP 专项 **10/10**，均零跳过。后者使用真实 SQLite、单连接 PostgreSQL、原安装包/Node、原 issuer、Fastify 路由与 CA/主机名验证的 TLS 1.3 profile/PDP 测试服务，证明生成、幂等重放、提交前撤权及提交后 runtime 关闭。身份与积分是明确夹具，不是生产人类账号或钱包。其他 Application/Store、Host、issuer 和 composition 的分组日志见[实施进度](./incremental-extension-progress.md)，不同检查组不相加。

尚未接入独立短剧页面的生成按钮、真实能力状态与原线程准备。按保存输入查找原生成已通过独立的[只读 UI 协议](./project-generation-read-ui-protocol.md)接入；operation 查询、确切结果选用和冷恢复导航仍待实现。本阶段也不代表完整生产 runtime factory、正式 Main/full App/packaged Krea2 在线生图、人类身份钱包或价格结算验收。

以下既有章节保留协议前置阶段的记录，其中“尚未装配”等状态以本节的当前实现为准。

日期：2026-10-03。状态：已实现严格 Contracts、SDK helper、可信映射校验及已提交项目任务的回执核验。当前尚无 Host dispatcher、服务可用性装配、生成控件或新 HTTP 路由。独立短剧 3.0.0 继续只保存项目与输入，原页面及旧任务动作不变。

## 请求边界

预留服务为 `crewon.project-generations@1`，唯一动作是 `crewon.project-generations.v1.generateConcept`。浏览器 SDK 提供 `createPluginProjectGenerationClient(services).generateConcept(input, options?)`，沿原 `services.invoke` 调用，不签发身份、不准备执行会话、不查询能力、不自动重试或激活服务。

请求严格包含四个字段：保存输入的五字段 `reference`、`threadId`、`expectedThreadRevision` 和 `idempotencyKey`。引用分别为 `projectId`、稳定 `assetId`、不可变 `assetRevision` 及当前项目/资产元数据预期版本。插件不能提交 prompt、执行目标、配置、账号、付款人、报价、金额或提交回调。宿主必须从本人范围的持久源读取确切 prompt，并通过原线程路径准备会话。

回执保持原六字段：`disposition`、`threadId`、`threadRevision`、`runId`、`messageId`、`configurationRevision`。committed 和 replayed 都须属于原请求会话，修订必须为原预期值加一；不能用最新线程投影替代原回执。回执只表示任务已受理，不表示供应商生成成功。

helper 在第一次异步等待前捕获全部引用、版本和幂等键及本次 signal，校验输入和响应，取消时清理监听并观察迟到失败。取消浏览器等待不声称 Run、供应商作业或积分预留已取消。调用结果未知时，业务 controller 必须保留完整原请求以显式重试，不替换版本或键。

## 明确业务到执行的映射

`ProjectGenerationPublication` 是宿主的明确部署映射：source 保存业务包的 pluginId、packageDigest 和 contributionId；target 保存执行包的 pluginId、packageDigest、contributionId 和 action。列表最多 32 项，每个 exact source 只能有一个 target，解析后深冻结，不按任意动作名查找服务。

两端安装身份各自保留 publisher、version、selection revision 和 authority epoch，不制造目标 UI lease 或重写业务包身份。映射断言要求同一 tenant、space、profile、principal 和审计 actor，source 动作必须是预留 generateConcept。它只证明身份兼容，不代替真实安装、包字节、发布批准、readiness、当前策略或积分准入。

Host 组装任务时，从业务包身份和原 UI 幂等键派生有界命名空间，使不同业务包的同名键不能冒用彼此意图。命名空间不包含临时 mount、租约或 epoch；原任务回执摘要仍包含确切 execution pin、任务命令和保存引用。变更输入或线程后复用原键继续冲突。恢复旧意图仍需读取原持久关联，不能用新安装状态重新拼出旧执行身份。

## 已提交回执

原 `PluginUiCommittedTaskAuthority.issue` 仍只处理同一包的原任务摘要，不用它承认跨插件项目任务。显式配置 `projectGenerations` 后，`issueProjectGeneration` 核验部署映射、来源 UI 请求、命名空间、增强回执、原付费 pin、个人报价、完整 Run/binding 及项目关联，并读取原输入和需求修订核对内容摘要与 prompt。

核验只比较已确认的持久事实，不在 COMMIT 后重新要求项目 active、当前 CAS 或当前执行权限。新需求、归档、关闭或撤权不把已提交任务改成新的提交机会。返回结果仍属于原 UI context 的单次 opaque capability；其他 authority、context、克隆或插件 JSON 均不能冒用。默认构造不启用项目能力，也不读取项目表。

## 继续装配的前置工作

真实 Host dispatcher 需捕获两端实际安装与当前权威，沿[项目内部事务](./project-generation-link.md)提交。事务内借原连接验证并锁定两端 selection；不能把会重新获取共享连接的完整 UI current 检查塞入单连接 PostgreSQL 事务。该路径还需实际双库、撤权及关闭验证，目前尚未实现。

工作台随后需要真实能力状态、原线程准备，以及通过项目关联核验的原会话导航。按保存输入恢复原受理记录使用独立只读协议；旧 task hook 按业务 module.pluginId 查任务，不能放宽它来接受不同执行插件。原 operation 查询、确切图片选用和生产钱包仍是后续工作。
