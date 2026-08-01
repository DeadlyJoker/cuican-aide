# W1-06 Tasks

## A1. Schema and records

- [x] A1.1 新增 0037 migration 七组表、唯一约束和查询索引。
- [x] A1.2 定义 bounded Task/Attempt/Event/Inbox/Outbox/Snapshot/Commit records。
- [x] A1.3 测试真实 schema migration 和只使用 `state_5.sqlite`。

## A2. Atomic append

- [x] A2.1 create/read Task Genesis。
- [x] A2.2 BEGIN IMMEDIATE + expected version/offset CAS。
- [x] A2.3 Worker fencing projection 校验。
- [x] A2.4 Attempt/Event/Inbox/Outbox 同事务写入。
- [x] A2.5 duplicate Inbox/Event outcomes。
- [x] A2.6 transaction failure rollback 和 close/reopen deep equality。

## B. Recovery and cursors

- [x] B1 并发 commit 单 winner。
- [x] B2 list events + cursor no-gap CAS。
- [x] B3 pending outbox reopen recovery + delivered idempotency。
- [x] B4 old epoch/hash/WorkerRun/expired lease matrix。
- [x] B5 migration journal operations。

## C. Adapter

- [x] C1 Resource Binding/Task Aggregate 受校验 persistence Snapshot。
- [x] C2 Domain ↔ Record 显式映射。
- [x] C3 实现 W1-05 TaskStore port。
- [x] C4 adapter Harness，不注册 API/processor/旧 Office dual write。

## D. Verification

- [x] D1 Resource/Task/State/App-server tests。
- [x] D2 adapter targeted tests。
- [x] D3 schema/build data/DB file boundary review。
- [x] D4 scoped fix，最后 fmt。
