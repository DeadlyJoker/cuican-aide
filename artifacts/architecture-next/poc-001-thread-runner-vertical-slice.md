# PoC-001：Thread → Run → Tool → Runner 纵向切片（历史方案）

状态：Superseded  
日期：2026-08-08

本 PoC 原来用于评估早期 Rust Device Runner，不再定义最终实现。最终态使用严格裁剪的 Rust
`crewon-device` Native Runtime 和版本化 Device Protocol；新的实现切片必须以根目录 `ARCHITECTURE_FINAL.md` 和
`adr-007-hybrid-final-runtime-and-owned-agent-kernel.md` 为准。

## 1. 目标

证明新架构的最小真实闭环，而不是证明 Fastify、Node.js 或 Rust 子进程可以单独启动。

PoC 必须从真实 CrewON UI 发起一次消息，经过新 Control API、TypeScript Runtime Worker、模型流、Policy/Approval、独立 Rust Runner、持久化和 SSE，再在进程重启或流重连后恢复一致状态。

## 2. 范围

### 包含

- 一个 PC UI surface。
- 一个 Standalone Control API。
- 一个 Runtime Worker。
- 一个 SQLite Store adapter；PostgreSQL schema 和 conformance test 可以同时准备，但 PostgreSQL live 不是 PoC-001 的强制条件。
- 一个 Rust Runner process。
- 一个 deterministic fake model adapter。
- 一个真实 OpenAI-compatible self-host/remote model smoke path。
- 一个只读 Tool 和一个需审批的写 Tool。
- Run Event SSE 和 `Last-Event-ID` 恢复。
- cancel、process restart 和 unknown outcome 测试。

### 不包含

- Office、Experts、Workflow DAG UI。
- 多租户 Cloud deployment。
- Redis、Kafka、NATS、Temporal。
- Marketplace 和自动 Plugin 安装。
- 长期 Memory、向量检索。
- 浏览器自动化和远程 Device Mesh。
- 旧 Thread 全量迁移。
- 与真实旧 Agent Loop 同时执行同一有副作用任务。

## 3. 建议目录

```text
apps/control-api/
apps/runtime-worker/
packages/contracts/
packages/domain/
packages/agent-runtime/
packages/policy/
packages/store/
crates/crewon-runner-protocol/
crates/crewon-runner/
```

PoC 可以先在现有 monorepo 中建立这些目录，但必须从干净基线和独立分支开始。当前 shared dirty worktree 只用于设计审查，不是 PoC implementation baseline。

## 4. 用户场景

### 场景 A：只读 Tool

用户输入：

```text
读取当前工作区 README 的标题，并告诉我文件是否存在。
```

期望：

1. UI 创建/选择 Thread。
2. UI POST Message，服务端以 idempotency key 创建 Run。
3. Worker 调用 deterministic model，产生 `workspace.readFile` tool intent。
4. Policy 自动允许限定 root 内的 bounded read。
5. Runner 校验 lease、workspace binding、capability 和 output cap。
6. Runner 返回 content digest 和有界文本。
7. Worker 继续模型循环并完成 Run。
8. UI 只根据 SSE Event/Snapshot 展示运行状态。

### 场景 B：需审批写 Tool

用户输入：

```text
在临时 PoC workspace 中创建 note.txt，内容为 hello。
```

期望：

1. Worker 创建 ActionIntent 和 Approval。
2. UI 收到 `approval.required`，显示 path、动作类型和有界参数预览。
3. 用户批准后服务端验证 expected revision 和 action digest。
4. Runner 只在批准有效且 lease 未过期时写入。
5. 重复 approval decision、重复 runner request 和 SSE 重放不会重复写入。

## 5. 最小 API

```text
POST /v1/threads
GET  /v1/threads/{threadId}
POST /v1/threads/{threadId}/messages
GET  /v1/runs/{runId}
GET  /v1/runs/{runId}/events
POST /v1/runs/{runId}:cancel
POST /v1/approvals/{approvalId}:decide
GET  /v1/health/live
GET  /v1/health/ready
```

`POST messages` 返回 `message + run`，而不是等待 Agent 完成。

## 6. 最小事件

```text
run.created
run.started
model.started
model.delta
model.completed
tool.requested
approval.required
approval.decided
tool.started
tool.completed
tool.failed
message.completed
run.cancelRequested
run.canceled
run.reconciling
run.completed
run.failed
```

约束：

- `model.delta` 可以高频但必须有 chunk/byte 上限；不进入长期 Snapshot。
- Tool stdout/stderr 超出上限后进入 Payload/Artifact，Event 只保留 preview 和 ref。
- `run.completed` 只能在最终 Message、usage、Snapshot 和 Outbox 同事务落库后产生。
- 客户端忽略未知非安全事件；未知 Approval/Policy 状态必须 fail closed。

## 7. 最小数据模型

```text
threads(id, revision, created_at, updated_at)
messages(id, thread_id, role, content_ref, created_at)
runs(id, thread_id, status, authority, contract_hash, revision, created_at)
run_steps(id, run_id, kind, status, revision)
run_attempts(id, step_id, attempt_no, status, lease_epoch)
run_events(run_id, sequence, event_id, type, payload_json, occurred_at)
run_snapshots(run_id, sequence, status, snapshot_json)
approvals(id, run_id, action_digest, status, revision, expires_at)
workspace_bindings(id, runner_id, opaque_root_ref, permission_snapshot)
runner_leases(id, run_id, attempt_id, runner_id, epoch, expires_at)
inbox_receipts(scope, idempotency_key, response_ref)
outbox(id, topic, payload_ref, status)
```

PoC schema 可以简化列，但不能删除 idempotency、revision、sequence、lease epoch 和 action digest 这些正确性边界。

## 8. Runner Protocol

最小 capability：

```text
workspace.readFile
workspace.writeFile
```

`readFile` 限制：

- workspace binding 内 canonical path。
- symlink escape 拒绝。
- 单文件大小上限。
- 输出 byte 上限。
- 二进制文件只返回 metadata/digest。

`writeFile` 限制：

- workspace binding 内 canonical path。
- 明确 overwrite policy。
- Action Digest 覆盖 path、content hash、workspace、actor purpose 和 side-effect class。
- approval expiry 和 lease expiry 校验。
- 原子临时文件 + rename；失败不留下部分正文。

## 9. Deterministic Fake Model

禁止用 sleep 或真实模型不确定输出驱动正确性测试。

Fake 以输入 fixture 推进事件：

```text
fixture/read-title
  -> assistant reasoning summary
  -> tool call workspace.readFile
  -> wait tool result
  -> final message

fixture/write-note
  -> tool call workspace.writeFile
  -> wait approval and tool result
  -> final message
```

测试通过显式事件推进和 flush promises 驱动，不依赖墙钟 sleep。TTL/lease 测试使用可注入 Clock。

## 10. 必测失败场景

| 场景                                       | 期望                                       |
| ------------------------------------------ | ------------------------------------------ |
| 重复 POST message idempotency key          | 返回同一 Run，不创建第二个                 |
| SSE 在 sequence N 断开                     | 使用 Last-Event-ID 从 N+1 补齐             |
| Approval 重复提交                          | 返回原决定或 revision conflict，不重复执行 |
| Approval 后参数改变                        | action digest 不匹配，必须重新审批         |
| Runner lease 过期                          | 拒绝执行；stale result 不更新 Snapshot     |
| Runner 执行中连接断开                      | Run 进入 reconciling，不立即重发写操作     |
| Worker 在 tool completed 后、commit 前崩溃 | receipt/reconcile 防止重复副作用           |
| Tool 输出超过上限                          | Event 只有 bounded preview + payload ref   |
| `../` 或 symlink escape                    | fail closed，目标文件不变                  |
| cancel 在 model streaming                  | Provider 停止，Run 收敛 canceled           |
| cancel 在 approval waiting                 | Approval 失效，Runner 不执行               |
| API/Worker 重启                            | Run/Snapshot/Event 可恢复，无假 completed  |
| malformed Runner result                    | typed validation error，不进入模型上下文   |

## 11. 测试层次

### Unit

- Reducer deep equality。
- Action Digest canonicalization。
- Policy decision。
- Path/capability validation。
- Event schema 和 Snapshot projection。

### Contract

- Generated client ↔ Control API。
- Worker ↔ Store adapters。
- Worker ↔ Runner fake/real process。
- SSE replay semantics。

### Integration

- deterministic fake model 完成场景 A/B。
- Runner real temporary workspace。
- API/Worker process restart。
- SQLite crash/reopen。

### Smoke

- 一个 OpenAI-compatible Provider 完成只读场景。
- Smoke 只证明指定 Provider/环境链路，不替代 deterministic correctness tests。

## 12. 可观测性证据

每个 PoC Run 产生：

- requestId、traceId、runId、stepId、attemptId。
- model/tool/approval/runner spans。
- event sequence 和 SSE reconnect count。
- bounded latency、token/usage、output bytes。
- cancel/reconcile reason。
- 不含 Secret、完整文件正文、绝对 cloud-visible path 或 Provider raw error。

## 13. 验收标准

PoC 只有同时满足以下条件才通过：

1. UI 真实使用 generated client，不调用旧 app-server 或 Agent Platform direct path 完成场景。
2. 场景 A 和 B 在 deterministic integration tests 中稳定通过且无 sleep。
3. Runner 是独立 Rust process，build graph 不依赖产品 domain。
4. SSE 重连能从持久化 sequence 恢复。
5. idempotency、stale lease、digest mismatch、workspace escape 和 cancel tests 通过。
6. API/Worker 重启后 Run 状态可恢复。
7. 一个 OpenAI-compatible Provider smoke 通过；未配置商业 Provider 时系统仍能启动和运行 fake/self-host path。
8. PoC 发行物 SBOM 无 denylist 或 unknown license。
9. 没有新旧 Authority 双写。
10. 结果报告明确区分 fake、local smoke、PostgreSQL 未验证和跨平台未验证边界。

## 14. 非通过状态

以下证据不足以宣布 PoC 成功：

- API health 返回 200。
- UI 显示静态 Run 卡片。
- Rust Runner 能单独执行 `echo`。
- 模型能生成文本但 Tool/Approval 未闭环。
- 只通过 mocked HTTP 而没有真实独立 Runner process。
- SSE 能 live stream 但断线不能续读。
- SQLite 通过却宣称 PostgreSQL/多 Worker 已完成。
- 使用闭源 Agent SDK 或 hosted-only Queue 临时跑通。

## 15. PoC 完成后的决策

记录并评审：

- 一次普通产品变更涉及的文件和语言数量。
- TypeScript Worker 的内存和 stream backpressure。
- Runner Protocol 的复杂度与跨平台差异。
- crash/reconcile 的真实缺口。
- Store schema 是否足以承载 Workflow/Office，而没有提前加入专用字段。
- 开源依赖和打包链是否可重复。

本段是历史决策条件。最终目标已经由 ADR-007 和 `ARCHITECTURE_FINAL.md` 取代，不再依据本 PoC 升级 ADR。
