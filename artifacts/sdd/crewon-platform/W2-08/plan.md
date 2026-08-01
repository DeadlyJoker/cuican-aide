# W2-08 Implementation Plan

## Stage D: Discovery（已完成）

1. [x] 审计 Provider runtime、CloudWorker、Task outbox/recovery、dynamic tool event path 和 UI PIM 调用点。
2. [x] 确认 W2-07/W2-08 生命周期边界：W2-07 提供单页 pump/recovery input，W2-08 拥有 supervisor。
3. [x] 识别 Thread Dynamic Tool 缺少 durable verified principal/workspace/resource context，冻结不安全直接切换。
4. [x] 将 W2-08 拆成 A Provider supervisor、B Thread authority、C Dynamic Tool/UI atomic cutover、D Gate。

## Stage A: Provider Run Supervisor

1. [x] Harness Red：Worker outbox filter、durable defer/backoff CAS、success-only delivery、restart recovery、shutdown drain。
2. [x] State 增加 bounded Worker decision query、pending defer API 和 durable Run poll schedule，不改既有通用 outbox语义。
3. [x] app-server 增加 deterministic `run_once` supervisor，使用 fake executor/fixed clock Harness。
4. [x] 接入 CloudWorker + production factory，加入 30 秒 timeout、单并发硬上限和 shutdown token。
5. [x] 以独立环境开关在 app-server startup 默认关闭地注册；配置关闭或依赖缺失时不启动、不报假 ready。

## Stage B: Durable Thread Execution Context

1. [x] Harness：forged owner/workspace、binding revoke/revision drift、restart。
2. [x] additive State migration + strict record/validation/runtime；metadata/reference only。
3. [x] app-server adapter 从 `RequestIdentity` + Workspace Registry 创建/read/update context。
4. [x] 协议只允许 `thread/start`/`thread/fork` 首次创建 authority；独立 binding update RPC 只更新既有 context。
5. [x] thread start/resume/fork/delete 生命周期接入；archive/unarchive 保留 context，中心文件只传窄 prepared authority，不复制规则。
6. [x] Harness 覆盖 first-claim、cross-owner resume/fork/update、start/fork 回滚、delete cleanup。

## Stage C: Dynamic Tool 与 UI 原子切换

1. [x] Harness：Provider namespace server dispatch、non-Provider client passthrough、unknown namespace fail-closed、duplicate call id、timeout/unknown/revoke。
2. [x] 从 exact active bindings 构造 registry/spec；把 binding identity 与 thread runtime settings 持久关联。
3. [x] 在 app-server bespoke event 路径注入窄 router，不把 router 逻辑写入大中心模块。
4. [x] UI `App.tsx` 接入 W2-06 session/picker；删除 PIM interceptor/executor/tests，保留通用 dynamic tool UI。
5. [x] 加入 rg/call graph Harness，证明旧 PIM execute API 为零且无 fallback。

## Stage D: Wave 2 Gate

1. [x] 完整 hermetic vertical Harness：真实 request processors、temporary State、production Provider client 与 Fake Provider 串通 connect/list/read/bind → thread authority → Provider dynamic success；restart/revoke/cursor/shutdown 分层 Harness 亦通过。
2. [x] protocol/state/provider/transport/app-server/UI 定向与包级测试；完整 workspace `just test` 按仓库规则仍需用户授权。
3. [x] dependency/breaking-change/security/size review；旧 PIM execute 调用点为零，Cloud Agent 旧链明确留给 W3-01。
4. [x] 对 app-server/core/protocol/state/transport/provider 做 scoped fix，最后执行 `just fmt`；verification 已更新。
5. [x] W3-01 精确切换清单已冻结在 `../W3-01/`；真实部署 key/model smoke 仍留在 R1，完整 workspace release evidence 通过前不得执行。

## Review staging

- A1 State outbox filter/defer，A2 deterministic supervisor，A3 startup lifecycle。
- B1 State thread context，B2 app-server authority adapter，B3 thread lifecycle。
- C1 server router，C2 UI atomic deletion，D integration Gate。
- 每个复杂生产切片目标少于 500 行，总变更超过 800 行时独立审查，不跨阶段混合提交。
