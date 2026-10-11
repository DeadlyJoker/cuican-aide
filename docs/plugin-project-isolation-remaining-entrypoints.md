# 插件项目隔离的剩余入口清单

本清单来自 `7069425e7` 的只读代码映射，记录普通 CreativeProject 下游的真实读取、提交和回执回放入口，供后续分组实施。它不构成生产接线、Host grant、全量隔离或 Web／桌面验收证明。行号以该映射基线为参考，后续修改应以函数名定位。

约束与总体状态参见 [插件项目管理隔离](plugin-project-management-isolation.md)。2026-10-12 已提交核心项目 Store、Foundation、Asset 与 Text v1 公开 Store，以及 SourceUpload/保存来源/原 Foundation Run 冷恢复的局部接线及真实两数据库回归，范围见[原管理入口隔离](plugin-project-legacy-access.md)；下面尚未接线的共享生成器、独立 journal、其他关联读取和 Extension Turn 冷回放不能据此视为完成。不得把测试直接写入的 metadata fixture 当成真实 Host、SQL CRUD、UI 或 Agent 授权。

## 所有分组共用的规则

- 普通旧入口使用 `creative-project-legacy-access.ts` 的负向检查；已有 UI、Run、installation 或 publication qualification 不自动成为 metadata full-owner grant。
- 检查原 SQLite `DatabaseSync` 或已经借用的 PG `PoolClient`，不另开数据库、不在原事务内借另一个 pool client、不引入新 SDK／运行时／公开授权协议。
- 完整旧 schema 且整个可选 sidecar 不存在，保持旧 SQL 的行为和返回值。sidecar 部分存在或结构无效必须拒绝，不能当作不存在或自动修复。
- SQLite 公开多语句读取需要同一原数据库快照；借用已有事务时不能擅自提交。PG 必须有真实原事务，首次迁移的检查与读取共享原 schema migration lock，不能把 autocommit 的 xact lock 当成持续保护。
- 对显式单项目，先检查实际项目再执行分页 SQL。跨项目分页必须在 SQL 的 cursor、ORDER、LIMIT+1 之前加入 sidecar 排除条件，不能先截断再在 JS 过滤。
- Run-only 和回执读取要从真实保存的记录解出项目／owner，不能只守调用者新提交的 projectId。回执读取不得修改原 key、digest、结果字节或历史来源规则。
- 写入／回放的检查放在原 BEGIN 之后，并在原 COMMIT 前再次检查真实结果项目。新增异步检查不能越过最后的真实 Run lease 校验或削弱原 authority／installation／downstream／funding／selection 检查。
- 防绕过的 marker 或存在性探测不能把 protected 数据过滤为 `false`／`null`，使普通 Run 意外获得许可；应保留实际存在或明确拒绝。

## 文本与结构化大纲

2026-10-12：文本 v1 公开 Store 已在 `bb9081d8d` 接入原事务隔离和真实保存回执检查，最终 380/380 原库回归通过、零跳过。下述 v1 段保留为原入口映射；独立结构化 v2、计划和 UI journal 仍未完成，不能由 v1 的通过推断。范围见[原管理入口隔离](plugin-project-legacy-access.md)。

实际 Store：

- `packages/store/src/project-text-sqlite-store.ts`：`SqliteProjectTextStore`。
- `packages/store/src/project-text-postgres-store.ts`：`PostgresProjectTextStore`。
- `packages/store/src/project-structured-outline-sqlite.ts`：`SqliteStructuredOutlineStorage`。
- `packages/store/src/project-structured-outline-postgres.ts`：`PostgresStructuredOutlineStorage`。

文本 v1 的公开入口是 `loadOutline`、`loadScript`、`loadArtifact`、`loadRevision`、`loadOutlineSourceRevision`、`listArtifacts`、`listRevisions`、`loadMutationReceipt`、`commitCandidate`、`commitSelection`、`commitLock`。其原 filter 只有 tenant／space／principal／project。

最小汇聚点是各 Store 的 `#project`。`#receipt` 解出保存结果后再读实际项目，因此项目检查可覆盖该回放；直接 `#artifact`、`#revision`、`#outlineSourceRevision` 和分页 SQL 没有经过 `#project`，必须另接检查。PG 单项读取的原 `Pool` 参数不能使 schema 检查和下一条查询换连接。

结构化 v2 是独立实例，公开包装为 `loadStructuredRevision`、`listStructuredRevisions`、`loadStructuredMutationReceipt`、`commitStructuredOutlineCandidate`、`commitStructuredOutlineSelection`；实际执行 `loadRevision`、`listRevisions`、`receipt`、`candidate`、`selection`。它有独立 `#project`／`#revision`／`#receipt`，不能假设 v1 已覆盖。SQLite v2 有 replay 提前 COMMIT 和 fresh COMMIT 两个末端，二者都要保持原 qualification 和隔离检查。

保留 `project-outline-source-store-support.ts` 的来源语义：fresh write 校验实时输入，既有 receipt／历史 revision 使用原固定来源，不能因隔离改造重新解释旧内容。

## 计划、文本 UI journal 与结果事实

实际文件：

- `packages/store/src/project-text-plan-sqlite-store.ts`、`project-text-plan-postgres-store.ts`。
- `packages/store/src/project-text-plan-control-support.ts`。
- `packages/store/src/project-text-plan-result-facts.ts`。
- `packages/store/src/project-text-plan-markers.ts`。
- `packages/store/src/project-text-ui-intent-sqlite-store.ts`、`project-text-ui-intent-postgres-store.ts`。

计划入口包括 `loadPlan`、`loadRevision`、`loadStep`、`listSteps`、`listPlans`、`loadMutationReceipt`、`commitControl`、`commitObservation`、`commitSystemPause`、`scanRecoverable`、`loadRunAdmission`。计划 owner 虽包含 actor／profile，仍没有 metadata plugin／publisher 隔离。

`#plan` 和 `#receipt` 直接解码保存记录，必须检查真实 `plan.projectId`。`listPlans` 按显式项目先检查；`scanRecoverable` 按 tenant／space／profile 跨项目扫描，必须在 SQL 分页前过滤，不得对已经 slice 的 locators 后过滤。

`planControlQueries` 直接读取原 project／brief／outline／binding／heads。`assertSqlitePlanResultFacts` 和 `assertPostgresPlanResultFacts` 直接读取原 foundation 或 text mutation receipt 与 Tool receipt；它们是原事实证明路径，不经公开项目 Store。接入同连接检查时必须继续证明实际 plan、step、Run、Tool 和产物索引一致。

`loadSqlitePlanAdmission`／`loadPostgresPlanAdmission` 直接按 tenant／run 读取保存 admission，要检查保存记录中的真实 project。`readRequiredPlanDigest` 是拒绝绕过的 marker，不应被变成不存在。

文本 UI journal 的 `stage`、`getPending`、`acknowledge`、`observeRejected` 主要汇聚于 `#project`，但已有 receipt 和终态处理也需要实际项目检查。保留原 intent keys、recovery 和 acknowledged 历史。

## Asset 生成器与独立 recovery

Asset 本轮公开 Store 修改只覆盖 `SqliteProjectAssetStore`／`PostgresProjectAssetStore` 的入口，不代表所有共享计划已完成：

- `packages/store/src/project-asset-store-support.ts`：`assetProject`、`assetHead`、`assetContent`、`assetReference`、`assetReceipt`。
- `packages/store/src/project-asset-store-reads.ts`：`assetPage`、`assetContentPage`、`assetReferencePage`。
- `packages/store/src/project-asset-mutation-plan.ts`：`commitAssetPlan`。
- `packages/store/src/project-asset-mutation-records.ts`：`prepareAssetMutation`。
- `packages/store/src/project-asset-reference-image-plan.ts`、`project-asset-reference-proof-plan.ts`。

`assetProject` 是共享汇聚点，`assetReceipt` 会用保存 command 的 projectId 调用它。直接 head／content／reference 与分页 helper 不经过 `assetProject`。后续同连接 generator executor 的接法不能另借 PG client，也不能把 SQL 数据当成 publication grant。

另有独立入口：

- `project-asset-ui-intent-sqlite-store.ts`／`project-asset-ui-intent-postgres-store.ts` 的 `loadIntent` 直接执行 `project-asset-ui-intent-plan.ts` 的 `readAssetIntent`，只按 intentId／scope digest 解码，不调用 `assetProject`。
- `project-asset-vtwo-recovery-store.ts` 的 `loadIntent` 直接执行 `project-asset-vtwo-recovery-plan.ts` 的 `assetVtwoById`，同样需要在保存记录真实 project 上检查。
- `rejectAssetIntent` 的非 pending 提前返回、原 receipt 回放和 V2 terminal 验证不能只依赖 fresh `prepareAssetMutation` 的项目检查。

`stage`、`getPending`、`acknowledge`、`cancelPending` 和各 commit 的末端检查也要完整核对。保留原 UI／Run qualification、reference provenance、media adoption receipt 和 journal 终态证明。

## Media input、generation、result 与 material preparation

实际共享计划：

- `packages/store/src/project-media-input-plan.ts`：`loadProjectMediaInputPlan`、`listProjectMediaInputPlan`、`loadProjectMediaInputReceipt`、`qualifyProjectMediaInputPlan`、`saveProjectMediaInputPlan`、`qualifySavedProjectMediaInput`。
- `packages/store/src/project-media-generation-read.ts`：`loadProjectMediaGenerationLinkPlan`、`loadProjectMediaGenerationContextPlan`。
- `packages/store/src/project-media-generation-turn.ts`：capture／prepare／save／replay。
- `packages/store/src/project-media-generation-transaction.ts`：`executeSqliteMediaGenerationPlan`、`executePostgresMediaGenerationPlan`。
- `packages/store/src/project-media-result-plan.ts`：`mediaResultSourcePlan`、`mediaResultLoadPlan`、`mediaResultSavePlan`、`mediaResultPublicationPlan`、`mediaResultCatalogPlan`。
- `packages/store/src/project-material-preparation-plan.ts`：`loadMaterialPreparation`、`reserveMaterialPreparation`、`claimMaterialPreparation`、`advanceMaterialPreparation`。

Media input 的 owner helper 先锁原项目并调用 `assetProject`，可在共享资产接法落地后覆盖显式项目单项／分页／receipt。Media generation 先解保存 Run link，再使用真实 actor／project 调用 input helper；原 Turn executor 已借用原 DB／client，没有独立 BEGIN 或 pool，不得改成旁路事务。

Media result source／load／save／publication／catalog 主要汇聚于 `mediaResultSourcePlan` 或 `assetProject`；catalog 的项目检查位于 candidate 页 SQL 之前。Material load 也先调用 `assetProject`，reserve 回放、dispatch claim 和 advance 继续核对真实 reservation。还要逐一检查实际 Store 的末端 COMMIT，不能只改 generator 第一条查询。

保留 actual input／generation／operation／result、adopted reference、dispatch lease／revision 和 source proof。Media result 的 PG adoption 原预检查在借用单槽 pool 之前执行，不能为隔离引入第二次借用或把该检查挪成死锁。

## Generation、query、historical query 与原 Turn 冷回放

实际公开入口：

- `packages/store/src/sqlite-extension-store.ts` 的 `loadProjectGenerationLink`、`loadProjectGenerationLinkBySource`、`loadProjectQueryLink`、`loadProjectHistoricalQueryLink`。
- PG `postgres-extension-store.ts` 委托 `postgres-project-associations.ts` 的同名四个入口。

实际共享 helper：

- `project-generation-store-support.ts`：`metadataQueries`、`prepareSqliteProjectGeneration`、`preparePostgresProjectGeneration`、`assertProjectGenerationReceipt`、`projectGenerationReadSql`。
- `project-generation-source-read.ts`：`projectGenerationSourceReadSql`、`decodeProjectGenerationSource` 和 funding verifier。
- `project-query-store-support.ts`：prepare／load SQLite／PG 与 `assertProjectQueryReceipt`。
- `project-historical-query-store-support.ts`：prepare／load SQLite／PG 与 `assertProjectHistoricalQueryReceipt`。

按 Run 的 generation read locator 只有 tenant／space／run，没有 caller principal；必须先证明原保存 link 索引，再用真实 `ownerPrincipalId`／`projectId` 检查，不能仅守新请求传入的 owner。Source read 虽 JOIN 原项目并证明 funding／binding／receipt，仍需要 sidecar 检查。

原 Turn 有独立冷回执路径：

- `sqlite-extension-turn-commit.ts` 原 generation／query／historical receipt 检查分别在映射基线约 399／411／423 行。
- `postgres-extension-turn-commit.ts` 对应约 409／419／438 行。

这里可以完全跳过 fresh prepare。必须守真实保存 link，不能只修改 prepare helper。新提交准备、保存关联与原 `beforeCommit` 同连接接入末端检查；保留原 Run／WorkItem／installation 锁、funding、stage、plan、media、foundation 和 lease 校验。历史 query 的固定 source pin 与原 immutable generation 字节不改变。

## Concept image selection

实际 Store：`sqlite-project-concept-selection-store.ts`、`postgres-project-concept-selection-store.ts`；入口为 `loadConceptSelectionReceipt`、`loadCurrentConceptSelection`、`commitConceptImageSelection`。

`concept-selection-store-support.ts` 的 `loadConceptSelectionReceiptPlan` 直接执行 receipt → saved pointer → linkedResult，没有经过 `metadata`／`source`，因此单给 metadata SQL 加条件不能覆盖回执。必须检查真实 pointer 项目。

`metadata` 可汇聚 current／fresh；`commitConceptSelectionPlan` 先查 receipt，再对 replay 读取 linkedResult／source 后返回，也要检查保存项目。保留原 publication／binding／funding／external result proof，并在原 SQLite／PG commit 末端检查。

## Conversation、stage 与防绕过探测

实际 Store：`project-conversation-sqlite-store.ts`、`project-conversation-postgres-store.ts`；入口为 `loadBinding`、`listBindings`、`loadMutationReceipt`、`commitBinding`、`loadStageAdmission`。

各 Store 的 `#project` 主要覆盖 binding commit；直接 binding read、list 和 receipt 不经过它。`listBindings` 为显式单项目，先守再执行 SQL 分页。按 thread 或 receipt 读取则检查实际保存 binding 的 projectId。

另需核对原 Run helper：

- `project-stage-run-store-support.ts`：`loadSqliteStageIfAvailable`、`loadPostgresStageIfAvailable`、`assertSqliteProjectStage`、`assertPostgresProjectStage`。
- `project-stage-run-tool-qualification.ts`：stage Tool qualification。
- `project-concept-conversation-turn.ts`：`assertSqliteProjectConceptConversation`、`assertPostgresProjectConceptConversation`。
- `project-media-conversation-turn.ts`：`assertProjectMediaConversationTurn`。

这些直接读取 binding／thread／project 或保存 admission，不能假设公开项目 Store 已覆盖。现有 plugin project workspace binding fence 检查 workspace namespace，不等于 metadata full-owner 检查。回执历史应继续使用原来源／installation 规则，不能生成新 Run。

`hasThreadBinding`、`project-conversation-ordinary-turn-fence.ts`、thread binding marker 和 required stage digest 是防绕过探测，不能因 protected 项目而返回不存在；应保持真实 binding 存在或明确拒绝。

## SourceUpload 与 source adoption

2026-10-12：本节原普通入口的风险已在 `a7d8d2836` 接线；最后 Store 212/212、Control 56/56 真实两数据库回归通过、零跳过。还覆盖 Foundation 已复制来源、保存 source-only 指针、真实 Run admission/required digest 和冷恢复。下述保留为映射基线说明。它不覆盖其他未接线的 Extension/Media/Conversation 路径，亦不提供 protected 项目的正向访问资格，范围与生产关联集合不变量见[上传源隔离](plugin-project-source-upload-isolation.md)。

实际公开 Store：`project-source-upload-sqlite-store.ts`、`project-source-upload-postgres-store.ts`。`load`、`loadBeginReceipt`、`begin` replay、`loadRawBytes`、`loadPrepared` 和 prepare／write／cancel 操作读写 preproject upload ledger，只按 tenant／space／principal／upload 授权。

`project_source_upload_associations` 可以把同一 prepared upload 关联到多个项目。保护任一已关联项目后，普通 raw／prepared payload 读取和再次 adoption 不能只检查 destination。需要在同 owner／upload 的真实 association 集合上检查是否存在 protected 项目；未关联的 preproject upload 保持旧行为。

最小读取汇聚点是 `project-source-upload-sqlite-records.ts` 的 `sqliteUploadState` 和 `project-source-upload-postgres-queries.ts` 的 `UploadQueries.state`。SQLite `load`／`loadPrepared` 直接调用前者，单改 Store 的 `#state` 会漏掉它们。实际 reader／writer 的原事务中，schema、association 检查、ledger 数据和末端 fence 必须使用同连接。

映射基线中借用原 Foundation 事务的 `admitSqliteFoundationSourceAdoption` 和 `assertPostgresFoundationSourceAdoption` 的 destination guard 不能替代 source upload association 检查。PG helper 已有与 upload writer 一致的 `project-source-upload` advisory xact lock，需要在此原连接核对 source，并在关联插入后、原 COMMIT 前复核；本次接线已保留这些原锁与末端检查。

保留原 storage realm、raw／prepared digest、immutable ledger、chunks／chapters 索引、parser revision 和独立 adoption PDP。它们都不自行授权访问 metadata protected 项目。

## 每组完成前必须验证

1. 完整旧 schema、可选 sidecar 全不存在时，原普通 reads／writes／receipt／reopen 不变；partial／invalid schema 拒绝且不自动迁移。
2. 同 principal 的两个插件项目不能通过普通入口读／写／引用彼此产物；正常未保护项目仍可用。
3. 原 receipt 保存的项目被保护后，cold load／replay 拒绝。换一个新提交的 projectId、request digest 或随机新 ID 不能绕过真实 saved project 检查。
4. 单项目与跨项目第一页／后续页、空页、LIMIT+1 cursor 均在 SQL 分页前处理隔离；不出现后过滤导致漏项或 cursor 改写。
5. 真实原 DB／PG 同连接事务、max-one pool、first migration 并发、原已开启事务，以及最后一个新增 await 中 authority／lease 失效仍 fail closed。
6. 原固定来源、funding／Tool／Run／installation／selection／dispatch／recovery 证明保持，既有回执结果不重写；确认 COMMIT 后不因后置 withdrawal 把 durable 成功改成失败。

以上是后续实施与回归清单。尚未覆盖的组必须保持未完成状态，不能用局部 SQLite 通过、跳过的 PG 测试或 raw fixture 宣称全量生产隔离。
