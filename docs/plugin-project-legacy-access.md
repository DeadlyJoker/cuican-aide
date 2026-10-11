# 原项目管理入口的隔离接线

更新：2026-10-12。继续使用原 Application、Store、数据库、Workspace、Thread、Run 和 Tool。当前增量只阻止普通入口访问已持久声明插件归属的项目；没有另建管理系统，也没有开放新项目归属写入、旧项目接管或生产自动迁移。

## 已提交范围

| 原管理入口                  | 提交        | 已保护的行为                                                       |
| --------------------------- | ----------- | ------------------------------------------------------------------ |
| CreativeProject 元数据      | `41abbb1fe` | 原项目、brief、concept、历史、分页与回执；修改及原 Run 创建路径    |
| Foundation 需求、来源与提案 | `743574a24` | 原公开读取、写入、回执、实际 Run facts/digest 和目标项目的来源采纳 |
| Asset 公开 Store            | `3de28fbdf` | 原资产、revision、reference、分页、参考图来源、写入和实际保存回执  |

普通项目继续走原方法。归属 sidecar 完全缺席时保持 legacy 行为；部分结构、未知版本或破坏结构明确拒绝，不自动补表或将其当作旧版。列表在原 SQL 排序、游标和 LIMIT 前过滤保护项目；单项目及事实证明路径明确拒绝。防绕过的 facts/digest 不能把真实保护记录改成“不存在”。

回放以数据库中实际保存的项目为准。更换本次请求的 projectId、摘要或新 ID，不能绕过旧回执的归属检查；原 JSON、外部幂等 key、历史来源、Run 和 Tool 结果不重写。现有授权、安装、来源、downstream、取消和事务末端租约检查继续保留，新增 SQL 完成后再次执行原最终检查。确认 COMMIT 后不增加能撤销已持久成功的检查。

## 使用同一个原数据库事务

SQLite 的结构检查、归属判断和数据读取使用同一快照；已有调用方事务时直接借用，不嵌套 BEGIN，不替调用方 COMMIT 或 ROLLBACK。真实 WAL 双连接与另一 Node 进程首次迁移测试证明，不会在检查之后读取另一进程新写入的保护数据。

PostgreSQL 使用原 pool 的同一个 client。原迁移排他锁与普通读取的共享事务锁使用相同 key，避免首次建表时“结构缺席”的判定过期。锁辅助方法先用 SAVEPOINT 证明实际调用方事务，再校验隔离级别；支持 READ ONLY，锁持续到外层事务结束。此处新接线的 owned 读写入口显式使用 READ COMMITTED。borrowed 入口遇到 REPEATABLE READ 或 SERIALIZABLE 明确拒绝，不偷偷修改或提交原调用方事务；其他尚未接线的 owned Turn 仍需逐组核对。

这些辅助方法是内部负向检查，没有保护项目的访问资格、用户可提交的 owner 或额外 pool。未来的访问资格仍须来自真实 Host UI 或原 Run/Tool，再交给同一套管理方法。

## 验证与范围

Node 24、真实 SQLite 与任务自有 PostgreSQL 18.6，均无跳过：

| 验证组              | 结果    | 范围                                                   |
| ------------------- | ------- | ------------------------------------------------------ |
| 元数据及原回归      | 164/164 | 新负例、同连接与迁移竞争、原 schema/项目/授权/插件/Run |
| Foundation 及原回归 | 159/159 | 新归属、借事务、来源/提案、实际 Run lease，原上传兼容  |
| 原 Control 集成     | 12/12   | 真实挂载的 Foundation/source-upload UI 路径兼容        |
| Asset 及原回归      | 64/64   | 公开 Store 隔离、默认隔离级别、原参考图与阶段执行      |

各组有重叠，不相加作为唯一测试数量。Store 类型、项目边界和格式检查通过。测试中的直接 sidecar INSERT 仅验证已保存记录的约束与普通入口拒绝，不能当作真实 Host 授权或产品创建验收。小规模性能样本不证明完整归属校验在大数据量下的成本。

本增量尚未更新 Web 或正式桌面。文本与结构化大纲、计划、共享 Asset generator、独立 recovery、media/material、generation/query 冷回放、concept selection、Conversation/stage，以及上传素材已关联项目的来源隔离仍需接线。详见[剩余入口清单](./plugin-project-isolation-remaining-entrypoints.md)。这些缺口关闭前，不开放保护项目创建；完成实际安装与 Web 全流程验收后再更新桌面。
