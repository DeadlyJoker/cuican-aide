# ADR-004：Authority、PostgreSQL/SQLite 与旧数据迁移

状态：Accepted  
日期：2026-08-08

## 背景

当前 Thread 同时使用 JSONL Rollout 和 SQLite metadata，Office 还使用 workspace JSON、run index、memory index 和 scheduler 文件。新系统如果长期双写旧存储和新数据库，将产生无法可靠恢复的双权威。

同时，Standalone 需要轻量本地存储，Team/Cloud 需要 PostgreSQL、多 Worker lease 和可靠 Outbox。

## 决策

1. Team/Cloud Authority 使用 PostgreSQL。
2. Standalone Authority 可以使用 SQLite，但限制为单 active scheduler/worker owner。
3. 两种 Store 实现共享 DomainStore conformance suite，不伪造相同部署能力。
4. 一个 Run 创建时固定 Authority，不在执行中从 Local 切到 Cloud。
5. 新 aggregate 只写新 Store；legacy 数据在 import 前只读。
6. Import 是单向、幂等、按 aggregate 的事务过程，记录 source digest、schema、counts 和 result revision。
7. Import 成功后旧写入口 fail closed；不保留 silent fallback。

## 最小迁移状态

```text
legacy
  -> quiescing
  -> importing
  -> active

失败状态：importFailed，可重试同一 idempotency marker
```

### Quiescing

- 停止创建新的旧 Run/dispatch。
- 对活动执行选择完成、取消或 reconcile。
- 记录 fence revision。

### Importing

- 读取固定 legacy snapshot。
- 校验路径、schema、thread/office identity 和 parse errors。
- 计算 digest、counts 和 provenance。
- 同事务写新 aggregate、event/snapshot、import marker。

### Active

- 新 Store 是唯一写 Authority。
- 旧数据保留只读直到 retention 到期。
- 旧写入口返回明确 migrated error。

## 拒绝方案

### 长期双写

拒绝。跨 JSONL、SQLite、workspace file 和 PostgreSQL 无法形成单事务；任何部分失败都会产生不可判定权威。

### 读取新失败后回退旧存储

拒绝。它会让故障表现为旧数据复活和丢失新状态。

### 启动时全量强制迁移

拒绝。大数据量或损坏 rollout 会阻止产品启动；采用可审计 lazy migration 和后台 dry-run。

## 数据边界

- Run Event 保存执行事实和 ref。
- Transcript 保存用户/模型消息。
- Payload/Artifact 保存长正文和二进制。
- Audit 保存身份、授权、迁移、外部副作用和失败分类，不保存 Secret。

## 当前 Standalone Authority 与 Queue 落地

- SQLite schema v2 增加 durable `work_items`，并把 v1 仅 `pending` 的 Outbox 升级为
  `pending -> leased -> delivered` 状态机；v1 pending rows 原序迁移且保持可领取。
- SQLite schema v3 增加 Thread Snapshot/Event、Message、Thread Idempotency Receipt 和 `run_thread_bindings`；Run 创建只
  能引用同 tenant、同 space 的 active Thread，并由 foreign key 保持强引用。
- v1/v2 历史 Run 会在事务内回填兼容 Thread 与 binding；同一 legacy Thread 跨 space 或 creator 时拒绝迁移，禁止静默
  合并两个权威范围。
- Outbox 和 Work Item claim 都携带 owner、lease ID、单调 epoch 和 expiry；ack/complete/retry 必须匹配当前 lease，
  stale owner 和过期 lease 均 fail closed。
- Work Item 可以在不改变 epoch 的前提下续租；每个 Runtime Worker Run mutation 都在领域写事务内复核当前 lease，
  不能把 claim 时的一次应用层检查当成持续执行授权。
- retry 使用 durable `available_at_ms`，测试通过可注入 Lease Clock 推进，不依赖 sleep。
- `thread.create` 与 `thread.message.append` 分别把 Snapshot、Event、Message、Idempotency Receipt 同事务提交；
  `run.create` 的 Snapshot、Thread binding、Event、Outbox、Idempotency Receipt 和首个 `run.execute` Work Item 也在同一事务提交。
- text Run terminal commit 把 assistant Message、Thread Event/Snapshot、Run `message.completed`/`run.completed`、Run Snapshot、
  Outbox 和 Receipt 放在同一事务；任一写失败不得留下 terminal Run 或孤立 Message。
- SQLite 只证明单进程 Standalone owner 的崩溃重启与 lease reclaim；PostgreSQL 必须使用数据库时间和
  `FOR UPDATE SKIP LOCKED` 另行通过多 Worker conformance，不复用本地部署结论。

## 验收 Gate

- importer 支持 dry-run、resume 和 digest comparison。
- malformed、partial、duplicate 和 out-of-scope legacy data fail closed。
- migrated aggregate 的所有旧写路径被 contract test 拒绝。
- PostgreSQL crash/restart 和 SQLite process restart 恢复测试通过。
- 不把 SQLite focused test 外推为 PostgreSQL 多节点证据。
