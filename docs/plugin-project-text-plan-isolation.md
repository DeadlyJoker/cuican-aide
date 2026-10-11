# 文本计划与操作记录的普通入口隔离

本轮继续复用宿主原来的项目、文本、Thread、Run、工具和 SQL Store。新增的检查只拒绝普通入口访问已经记录插件归属的项目；没有新增项目管理器、运行时、数据库、正向资格或受保护项目创建入口，也没有搬移历史会话和产物。

## 实际接线范围

- 原 `ProjectTextPlanStore` 的计划、版本、步骤、项目列表、保存回执、控制操作、观察、暂停和恢复扫描均检查原数据库中的实际项目归属。恢复扫描在 SQL 的 `LIMIT` 与游标分页之前排除受保护项目，保留普通暂停、撤回计划的原游标行为。
- 计划回执先检查实际父计划的保存项目，再解码历史结果；结果中的项目还必须与父计划一致。Run admission 通过保存 `plan_id` 与实际计划关联，先检查真实项目，再执行原 JSON、marker、digest 和身份校验。受保护的 admission 不能退化为未标记任务。
- 原计划结果事实、checkpoint、手动选择、委托选择和继续执行路径检查保存的业务回执项目，不把调用参数或结果 JSON 当成项目归属证明。原绑定、选择、来源指针、工具回执和执行资格保持原语义。
- 原文本 UI journal 的 staging、pending、accepted、拒绝观察、ACK 和冷恢复都守实际保存项目。原业务文本事务中的 journal begin/finish 也守保存记录与业务回执；原 key、JSON 和状态迁移没有改写。
- 原 ExtensionStore 的 Run/Turn 回执聚合读取复用同一数据库连接。SQLite 在同一原数据库快照中读取保存回执和 admission；PostgreSQL 在同一个原 PoolClient 的显式 READ COMMITTED 只读事务中聚合回执、composition、funding 和各阶段记录。原写入事务显式使用 READ COMMITTED，未引入额外连接或隐式恢复。

## 事务与兼容约束

SQLite 普通读取使用原数据库的 DEFERRED 快照；已有事务借用原事务，写入保留 IMMEDIATE。PostgreSQL 借用路径必须已有真实 READ COMMITTED 事务，并持有与显式 owner migration 相同的共享迁移锁，直到原外层 COMMIT。低层 borrowed reader 不会自行 BEGIN、COMMIT 或换 PoolClient。所有新增 SQL 完成后才执行原最后的授权、活动 owner 和物理执行租约检查。

实际 owner schema 完整缺席时保留旧项目行为。部分、未知、影子或损坏 schema 拒绝数据操作，不自动修复。原显式 Plan/journal DDL 迁移仍独立于无关的 optional owner schema；它不会修复或回填 owner，数据操作继续拒绝不完整归属证据。

历史 required marker 有一项原有兼容行为：当 owner sidecar 与独立 Plan schema 都完整缺席时，仍返回 `plugin_task_admissions` 保存的非空 digest，让后续 admission 校验拒绝缺失证据。不会将它改成 `null`。owner schema 存在或计划可观察时，必须核对真实保存 admission 与父计划；缺失必要证据直接失败。

## 验证边界

新增测试用原项目、安装选择、Thread、Run、claim、工具、计划、journal 和 Store writer 建立真实 SQLite/PostgreSQL 记录。raw owner 行只是负面约束测试数据，不能证明 Host 授权。覆盖保护后冷读取、保存回执重放、SQL 分页、真正 Run/Tool 重放、结果事实、部分 schema、显式 DDL、borrowed 无事务拒绝、首次 PostgreSQL migration 等待，以及新增末端 SQL 后撤权回滚。

固定 Node.js 24，PostgreSQL 18.6，文件并发为 1；原短租约和 timeout 保持不变。原 Control 计划/协调器集成测试使用临时数据库与模型无关的原服务链，不等于真实浏览器 Web、已安装桌面包或外部模型验收。需要安装目录的两个完整插件执行 fixture 本轮未提供目录，因此跳过，不能记为通过。

本轮不开放 Native allocator → SQL metadata owner 的正向创建，不接中央 Agent 的受保护项目 provisioning，不安装业务插件、不部署、不更新桌面。它完成的是原管理能力的普通入口隔离，产品正向授权闭环仍由后续接线处理。

本轮最后一次执行记录：

- Store 13 文件完整组：89/89，通过；其中新增负面与事务测试 23 项，0 跳过。
- 原 ExtensionStore、ExtensionTurn、unmetered、composition 4 文件：63/63，通过，0 跳过。
- 原 Control conflict、resume、coordinator、drift 4 文件：11/11，通过，0 跳过。此前另运行的两个安装目录 fixture 显式跳过。
- Store/Control typecheck、TypeScript boundary、19 文件 Prettier 和 `git diff --check` 通过。

这些都是固定 Node.js 24 的 `node --experimental-strip-types --test --test-concurrency=1` 运行结果，不代表生产部署或模型供应商可用性。全部自有测试连接与 Pool 已关闭；本轮联合验收结束后，自有 PostgreSQL fixture 已停止并删除。
