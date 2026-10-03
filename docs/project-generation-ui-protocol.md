# 项目生成 UI 协议与跨插件回执

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

工作台随后需要真实能力状态、原线程准备、按保存输入恢复原受理记录，以及通过项目关联核验的原会话导航。旧 task hook 按业务 module.pluginId 查任务，不能放宽它来接受不同执行插件。原 operation 查询、确切图片选用和生产钱包仍是后续工作。
