# 原项目管理入口的隔离接线

更新：2026-10-12。继续使用原 Application、Store、数据库、Workspace、Thread、Run 和 Tool。当前增量只阻止普通入口访问已持久声明插件归属的项目；没有另建管理系统，也没有开放新项目归属写入、旧项目接管或生产自动迁移。

## 已提交范围

| 原管理入口                   | 提交        | 已保护的行为                                                                                          |
| ---------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| CreativeProject 元数据       | `41abbb1fe` | 原项目、brief、concept、历史、分页与回执；修改及原 Run 创建路径                                       |
| Foundation 需求、来源与提案  | `743574a24` | 原公开读取、写入、回执、实际 Run facts/digest 和目标项目的来源采纳                                    |
| Asset 公开 Store             | `3de28fbdf` | 原资产、revision、reference、分页、参考图来源、写入和实际保存回执                                     |
| Text v1 公开 Store           | `bb9081d8d` | 大纲、剧本、产物、固定来源、分页、原写入和保存回执；同快照读取                                        |
| StructuredOutline v2         | `991cac2ed` | 原独立大纲读取、分页、实际保存回执、fresh/replay 写入与最后物理租约                                   |
| Text Plan 与文本 UI journal  | `29cfd7d98` | 计划、步骤、结果事实、SQL 恢复扫描、保存操作记录、Run/Turn 聚合同连接读取                             |
| 共享 Asset 与 media/material | `1a4a6ca2c` | 共享生成器、Asset V1/V2 journal/recovery、media input/result、material、实际 stage admission 与冷回放 |
| SourceUpload 与保存来源      | `a7d8d2836` | 原上传与全部实际关联、来源复制、Foundation 保存指针与回执、Run facts/admission 和冷恢复               |

普通项目继续走原方法。归属 sidecar 完全缺席时保持 legacy 行为；部分结构、未知版本或破坏结构明确拒绝，不自动补表或将其当作旧版。列表在原 SQL 排序、游标和 LIMIT 前过滤保护项目；单项目及事实证明路径明确拒绝。防绕过的 facts/digest 不能把真实保护记录改成“不存在”。

回放以数据库中实际保存的项目为准。更换本次请求的 projectId、摘要或新 ID，不能绕过旧回执的归属检查；原 JSON、外部幂等 key、历史来源、Run 和 Tool 结果不重写。现有授权、安装、来源、downstream、取消和事务末端租约检查继续保留，新增 SQL 完成后再次执行原最终检查。确认 COMMIT 后不增加能撤销已持久成功的检查。

## 使用同一个原数据库事务

SQLite 的结构检查、归属判断和数据读取使用同一快照；已有调用方事务时直接借用，不嵌套 BEGIN，不替调用方 COMMIT 或 ROLLBACK。真实 WAL 双连接与另一 Node 进程首次迁移测试证明，不会在检查之后读取另一进程新写入的保护数据。

PostgreSQL 使用原 pool 的同一个 client。原迁移排他锁与普通读取的共享事务锁使用相同 key，避免首次建表时“结构缺席”的判定过期。锁辅助方法先用 SAVEPOINT 证明实际调用方事务，再校验隔离级别；支持 READ ONLY，锁持续到外层事务结束。此处新接线的 owned 读写入口显式使用 READ COMMITTED。borrowed 入口遇到 REPEATABLE READ 或 SERIALIZABLE 明确拒绝，不偷偷修改或提交原调用方事务；其他尚未接线的 owned Turn 仍需逐组核对。

这些辅助方法是内部负向检查，没有保护项目的访问资格、用户可提交的 owner 或额外 pool。未来的访问资格仍须来自真实 Host UI 或原 Run/Tool，再交给同一套管理方法。

原显式 DDL 迁移使用原数据库、迁移锁和验证器，不因无关的部分 owner 结构而被拦截，也不修改或修复该结构。数据访问仍严格拒绝。新增负向 SQL 和 downstream 查询必须先完成，最后再执行原完整 Run qualification、真实物理租约和同步 active/open 检查；SQLite 同步 SQL 也会消耗租约时间。

## 验证与范围

Node 24、真实 SQLite 与任务自有 PostgreSQL 18.6，均无跳过：

| 验证组              | 结果    | 范围                                                                                               |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| 元数据及原回归      | 164/164 | 新负例、同连接与迁移竞争、原 schema/项目/授权/插件/Run                                             |
| Foundation 及原回归 | 159/159 | 新归属、借事务、来源/提案、实际 Run lease，原上传兼容                                              |
| 原 Control 集成     | 12/12   | 真实挂载的 Foundation/source-upload UI 路径兼容                                                    |
| Asset 及原回归      | 64/64   | 公开 Store 隔离、默认隔离级别、原参考图与阶段执行                                                  |
| Text、核心及原回归  | 380/380 | v1 读写/回执、真实 WAL 快照与迁移等待、2 秒真实租约、原 DDL 独立兼容                               |
| 来源及受影响 Store  | 212/212 | 实际上传关联、保存来源与原 Run、冷恢复、原 schema/commit/lease；最终文件串行                       |
| 来源 Control 集成   | 56/56   | 原 mounted 路由、安装/PDP、来源采纳、20MB multipart 和真实提交后撤权；最终文件串行                 |
| 结构化大纲 v2       | 80/80   | 新隔离与原 v1/v2、Run、来源和固定历史；真实 SQLite/PG，零跳过                                      |
| 大纲 v2 Control     | 9/9     | 原 UI 路由；实际单连接 PG 回执授权死锁修复                                                         |
| 文本计划与 journal  | 89/89   | 真实计划/工具/保存事实、分页、回放、首次迁移等待、末端撤权；零跳过                                 |
| 原任务聚合兼容      | 63/63   | 原 ExtensionStore/Turn、unmetered、composition；同连接收集阶段与计划记录                           |
| 计划 Control        | 11/11   | 原 conflict/resume/coordinator/drift；另两个安装目录 fixture 缺目录显式跳过                        |
| 共享资产与阶段记录  | 141/141 | 原私有生成器、独立 journal/recovery、media/material、实际 required marker、Run/Turn 冷回放；零跳过 |
| 共享资产 Control    | 26/26   | 原 mounted Asset/media/material 路由；零跳过                                                       |

各组有重叠，不相加作为唯一测试数量。Store 类型、项目边界和格式检查通过。测试中的直接 sidecar INSERT 仅验证已保存记录的约束与普通入口拒绝，不能当作真实 Host 授权或产品创建验收。小规模性能样本不证明完整归属校验在大数据量下的成本。

共享生成器通过明确的内部指令联合类型执行检查，复用原连接和原事务；不按 SQL 字符串猜测授权，也不新增管理器。保护判断以实际保存的项目、父记录与数据库索引为准，损坏 JSON 不能先触发重放或引用其他项目。Asset 与 media-input stage 的真实 marker 仍明确拒绝保护数据，不能返回 `null` 让普通任务绕过。

一次本地普通项目调用的测量中，SQLite 保存约 7.75ms、PG 保存约 57.71ms，PG 执行 179 条 SQL。catalog 检查 68 次约 28.92ms，锁 56 次约 7.53ms；其中也包含原 schema 检查，不能全部归因于新增代码。这不是远程或生产性能证明，重复检查在高网络延迟下的成本仍需优化；本轮未缓存归属判断或放松首次迁移/撤权检查。

本增量尚未更新 Web 或正式桌面。来源组的范围与保存关联不变量见[原上传源隔离](./plugin-project-source-upload-isolation.md)，计划范围见[文本计划隔离](./plugin-project-text-plan-isolation.md)。外部 MediaOperation 自己的原生命周期、generation/query/historical 的实际保存关联和冷回放、concept selection、Conversation/stage 仍需接线；仅让某个 executor 支持新指令不算其原业务计划已经覆盖。详见[剩余入口清单](./plugin-project-isolation-remaining-entrypoints.md)。这些缺口关闭前，不开放保护项目创建；完成实际安装与 Web 全流程验收后再更新桌面。
