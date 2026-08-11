# P0 基础 Agent Runtime 对齐矩阵

日期：2026-08-09  
状态：In progress  
Rust source of truth：`codex-rs/core/src/session/turn.rs`、`codex-rs/core/src/responses_retry.rs` 与下表列出的
`codex-rs/core/tests/suite` integration tests

本矩阵把“TS 看起来能聊天”与“基础 Agent 行为已和 Rust 对齐”严格分开。只有同一 fixture 的 request、稳定事件顺序、
terminal state、usage、错误分类与恢复结果都通过自动差分，状态才能标为 `PARITY`。

状态定义：

- `PARITY`：已有 Rust-reference fixture 与 TS candidate 自动 deep-equal。
- `PARTIAL`：主路径已实现，但尚无完整 Rust-reference 差分或缺少分支。
- `MISSING`：TS 主路径尚未实现。
- `REDESIGN`：不会逐行照搬，但必须先冻结 Rust 行为和新处置，不能静默删减用户效果。

## 已确认的基础循环不变量

Rust `run_turn` 的稳定语义是：同一 Turn 复用一个 model client session；每次 sampling 从 canonical history 构建 request；
assistant-only response 完成 Turn；Tool call 先执行并把 output 写回 history，再发下一次 sampling；pending user input、context
window 与 compaction 可以让循环继续。retryable stream error 在同一 Turn 内最多重试 provider 的 `stream_max_retries`
（默认 5），耗尽后才尝试 WebSocket→HTTP fallback；取消会中断 stream/Tool，并留下下一次模型可见的 aborted 事实。

当前 TS Kernel 已实现 bounded request/stream、usage、cancel 与 Canonical Model History，并在结构化 Tool boundary 结束
单次模型 Segment；Runtime Worker 拥有 durable Tool Step/Attempt/Receipt、execute/reconcile 和 follow-up sampling。WebSocket
prewarm、连接复用、增量 request、两次 reconnect、426/耗尽 fallback、sticky HTTP 和独立 HTTP retry budget 已有 TS
loopback evidence；AR-012/023/024/029 已新增 Rust+TS shared fixture，但仍不能把首批 30 项称为完整 parity：

1. Tool→result→follow-up sampling、aborted Tool history 与跨 crash durable Tool receipt 已进入 Worker/Store；
   pre-sampling durable compaction、revision-safe continuation、token-limit mid-turn、旧模型前缀压缩与 fork history copy 已落地；
   AR-026/027 的 import-only legacy rollout、compact/resume/fork shared differential 已落地，orphan/missing Tool pair normalization 已落地。
2. Canonical final assistant item 已消除 streamed/final 重复；`response.output_item.done` 后缺失
   `response.completed` 的 assistant 与 Tool 两类 completed-item history boundary 已由 bounded shared fixture 冻结。assistant
   item 进入同 Turn retry request；observable completion projection 采用 intentional redesign：Rust 发出 `first`、`done` 两个
   completed assistant items，TS 保留 `first` 的 delta/history 但不提交缺 terminal 的 phantom final Message，只提交最终 `done`。
   Tool item 结束当前 Kernel segment，由 durable Worker exactly-once 执行后把 call+result 放入下一 request。
3. **已关闭：同一 response 中混合 completed assistant text/commentary 与 Tool call。**
   `mixed-assistant-tool-response.reference.json` 由 Rust focused integration 与 TS durable Worker candidate 共同消费；completed
   assistant item 在 Tool call 前按顺序进入 canonical history，Tool request/result exactly-once 后进行第二次 sampling，最终只提交
   follow-up 的 terminal assistant Message。只有 partial delta、没有 completed assistant item 的混合输出仍以
   `model_tool_call_with_text_unsupported` fail closed。

## 基础 Rust reference cases

| ID     | Rust integration source                                                                                           | 要冻结的稳定语义                                                        | 当前 TS 状态 | 下一证据                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR-001 | `session/turn.rs::run_turn` + `client.rs` basic text cases                                                        | user input→assistant item→Turn complete；同一 Turn client session 复用  | PARITY       | shared full-Turn trace                                                                                                                                                                      |
| AR-002 | `stream_no_completed.rs` early/partial/completed-item close cases                                                 | partial 丢弃；completed item 进入后续 history；completion 投影见脚注    | PARITY†      | Rust+TS shared fixtures 4/4                                                                                                                                                                 |
| AR-003 | `stream_error_allows_next_turn.rs::continue_after_stream_error`                                                   | 错误 Turn 必须释放 active task，下一 Turn 可成功                        | PARITY       | Rust+TS shared two-turn fixture                                                                                                                                                             |
| AR-004 | `websocket_fallback.rs::websocket_fallback_switches_to_http_after_retries_exhausted`                              | initial + N retry 后切 HTTP                                             | PARITY       | shared fallback decision fixture                                                                                                                                                            |
| AR-005 | `websocket_fallback.rs::websocket_fallback_is_sticky_across_turns`                                                | fallback 对后续 Turn sticky                                             | PARITY       | shared two-turn decision fixture                                                                                                                                                            |
| AR-006 | `websocket_fallback.rs::websocket_fallback_hides_first_websocket_retry_stream_error`                              | release build 首个 WS reconnect warning 可隐藏                          | PARITY       | client `[2]` + audit `[1,2]`                                                                                                                                                                |
| AR-007 | `client.rs::responses_lite_sets_all_turns_context_and_disables_parallel_tool_calls`                               | request context mode 与 parallel flag 精确                              | PARITY       | shared HTTP/WebSocket request fixture                                                                                                                                                       |
| AR-008 | `client.rs::usage_limit_error_emits_rate_limit_event`                                                             | usage limit 与普通 429 分类、rate-limit snapshot                        | PARITY       | Rust+TS shared usage-limit fixture                                                                                                                                                          |
| AR-009 | `client.rs::incomplete_response_emits_content_filter_error_message`                                               | incomplete/content-filter 终态 fail closed                              | PARITY       | Rust+TS shared incomplete fixture                                                                                                                                                           |
| AR-010 | `client.rs::history_dedupes_streamed_and_final_messages_across_turns`                                             | streamed/final assistant item 不重复进入 history                        | PARITY       | Rust+TS shared three-turn fixture                                                                                                                                                           |
| AR-011 | `client_websockets.rs::responses_websocket_v2_incremental_requests_are_reused_across_turns`                       | incremental response continuation 与连接复用                            | PARITY       | shared connection/request fixture                                                                                                                                                           |
| AR-012 | `prompt_caching.rs::prompt_tools_are_consistent_across_requests`                                                  | cache-friendly prefix/tool schema 稳定                                  | PARITY       | shared instructions/Tool fixture                                                                                                                                                            |
| AR-013 | `tools.rs::custom_tool_unknown_returns_custom_output_error`                                                       | unknown Tool 形成 model-visible bounded error，不崩 Turn                | PARITY       | Rust+TS shared unknown Tool fixture                                                                                                                                                         |
| AR-014 | `shell_serialization.rs::shell_output_preserves_fixture_json_as_freeform`                                         | Tool output 作为 function-call output 精确回送                          | PARITY       | shared process output fixture                                                                                                                                                               |
| AR-015 | `shell_serialization.rs::shell_output_is_freeform_for_nonzero_exit`                                               | 非零退出仍形成结构化 Tool result，再由模型决定                          | PARITY       | shared nonzero output fixture                                                                                                                                                               |
| AR-016 | `truncation.rs::tool_call_output_exceeds_limit_truncated_for_model`                                               | 原始结果与 model-visible bounded/truncated 结果分离                     | PARITY       | shared normalized truncation trace                                                                                                                                                          |
| AR-017 | `rmcp_client.rs::stdio_mcp_parallel_tool_calls_default_false_runs_serially`                                       | 默认有副作用/未知 MCP Tool 串行                                         | REDESIGN     | 未审计 Tool 不进入 catalog                                                                                                                                                                  |
| AR-018 | `rmcp_client.rs::stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in`                           | 明确只读 Tool 可安全并发，结果顺序确定                                  | PARITY       | shared MCP scheduling fixture                                                                                                                                                               |
| AR-019 | `rmcp_client.rs::stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently`                                          | server opt-in 并发策略                                                  | REDESIGN     | mutation receipt gate                                                                                                                                                                       |
| AR-020 | `abort_tasks.rs::interrupt_long_running_tool_emits_turn_aborted`                                                  | Tool 执行中取消产生 TurnAborted                                         | PARITY       | Rust+TS shared cancel fixture                                                                                                                                                               |
| AR-021 | `abort_tasks.rs::interrupt_tool_records_history_entries`                                                          | 下次 request 含原 Tool call 与 aborted output                           | PARITY       | Rust+TS shared two-turn fixture                                                                                                                                                             |
| AR-022 | `abort_tasks.rs::interrupt_persists_turn_aborted_marker_in_next_request`                                          | model-visible `<turn_aborted>` marker 持久化                            | PARITY       | shared exact marker fixture                                                                                                                                                                 |
| AR-023 | `compact.rs::auto_compact_runs_after_token_limit_hit`                                                             | token limit + follow-up 时 mid-turn compaction 后继续                   | PARITY       | shared 7-request compact fixture                                                                                                                                                            |
| AR-024 | `compact.rs::pre_sampling_compact_runs_on_switch_to_smaller_context_model`                                        | 模型降档前按旧模型 compact                                              | PARITY       | shared prior-prefix compact fixture                                                                                                                                                         |
| AR-025 | `compact.rs::manual_compact_retries_after_context_window_error`                                                   | context-window error 有专用 compact retry 语义                          | PARITY       | shared compact retry fixture                                                                                                                                                                |
| AR-026 | `resume.rs::resume_includes_initial_messages_from_rollout_events`                                                 | resume 重建 canonical history，不只恢复 UI 文本                         | PARITY       | import-only shared rollout fixture                                                                                                                                                          |
| AR-027 | `compact_resume_fork.rs::compact_resume_and_fork_preserve_model_history_view`                                     | compact/resume/fork 的 model view 一致                                  | PARITY       | Rust+TS SQLite three-path fixture                                                                                                                                                           |
| AR-028 | `context_manager/history_tests.rs::normalize_removes_orphan_function_call_output`                                 | orphan Tool output fail-safe normalization                              | PARITY       | Rust+TS shared normalization fixture                                                                                                                                                        |
| AR-029 | `governed_context.rs::governed_context_reaches_responses_with_roles_bounds_and_incremental_stability`             | context role、bounds、增量稳定性                                        | PARITY       | shared role/bounds/stability fixture                                                                                                                                                        |
| AR-030 | `safety_check_downgrade.rs::cyber_policy_response_emits_typed_error_without_retry`                                | typed policy failure 不进入 retry loop                                  | PARITY       | Rust+TS typed policy fixture                                                                                                                                                                |
| AR-031 | `provider_end_turn.rs` + `stream_no_completed.rs::end_turn_false_completed_assistant_and_tool_continue_same_turn` | Provider `end_turn=false` 的 completed response 在同 Turn 继续 sampling | PARTIAL      | manual assistant-only durable continuation、mixed assistant→Tool、stored empty/assistant checkpoint chain 与 stored Tool boundary 已有 evidence；stored mixed assistant→Tool 仍 fail closed |
| AR-032 | `crewon-api/src/sse/responses.rs::process_responses_event` + TS Responses protocol decoder | Provider usage 必须非负、cached≤input 且 total=input+output；异常计量 fail closed | PARITY       | Rust+TS shared malformed-usage fixture |

## 已有证据映射

- `agent-text-turn.reference.json` 现在同时由真实 Rust Turn integration 与 Runtime Worker 的 InMemory、SQLite、PostgreSQL
  candidate 消费；自动差分 request history、delta/assistant/terminal event、rollout/model history、usage、active slot release 和
  terminal state。`text-run.reference.json` 仍只表示 Kernel 的最小 deterministic Segment，不再作为完整 Turn 证据。
- AR-001 的 assistant-only Turn 只有一次 sampling；“同一 Turn 复用 client session”的多次 sampling 证据由
  `unknown-custom-tool.reference.json` 交叉冻结：Rust 在同一个 `run_turn` 中发出 Tool request 和 follow-up request，TS Worker
  对同一个 transport 实例发出两次 request，并精确比较 Tool call/result 后缀。
- `mcp-tool-scheduling.reference.json` 同时冻结 Rust legacy 与新架构处置。AR-018 保持用户效果：reviewed
  `readOnly + replaySafe` Tool 在 durable Worker 内并发执行，完成结果仍按模型 call order 提交；真实独立 stdio MCP、Rust barrier
  reference、TS MCP Runtime 与 Worker 纵向路径均通过。AR-017/019 明确采用更严格的最终处置：未审计 Tool 不进入 catalog，
  server opt-in 不能越过 effect/recovery policy；缺少 durable provider receipt/reconcile 的 stdio mutation MCP 不可用。
- `stream-early-close-retry.reference.json` 与 `stream-partial-close-retry.reference.json` 同时由 Rust integration 和 TS
  candidate 消费；自动验证两次 request、一次 retry、partial discard、最终 output 与单 durable Attempt。
- `turn-error-release.reference.json` 同时冻结 Rust Error→TurnComplete→next Turn 与 TS terminal Work Item→next Run；Provider
  sampling budget 耗尽不会进入无限 durable Attempt retry。
- `usage-limit-reached.reference.json` 同时冻结 Rust TokenCount rate-limit snapshot 与 TS durable `rate_limit.updated`；
  `usage_limit_reached` 和普通 429 已分开，前者不可重试且不会消耗 sampling retry budget。
- `content-filter-incomplete.reference.json` 同时冻结 Rust/TS partial delta、non-retryable content-filter failure、Turn/Work
  Item release 与不提交 assistant Message。
- `unknown-custom-tool.reference.json` 冻结 unknown custom Tool 的 exact model-visible output、第二次 sampling 与最终输出；
  `shell-tool-output.reference.json` 冻结成功/非零退出均为 plain freeform output。
- `tool-output-truncation.reference.json` 冻结 head/tail、truncation marker、plain text 与约 10K-token 上限；raw output 先进入
  digest/provenance-bound Artifact authority，公共 Run Event 只保留安全投影，公开 SSE 不暴露 Artifact reference。
- `tool-cancel.reference.json` 冻结 Tool 执行中 durable cancel、AbortSignal 和不伪造 `tool.completed`。
- `aborted-tool-history.reference.json` 同时冻结 Rust/TS 下一轮的原 Tool call、动态 elapsed 归一化 aborted output、完整
  `<turn_aborted>` marker 与 follow-up user item；TS 路径在 SQLite 关闭重开后再采样。
- `canonical-history-dedupe.reference.json` 冻结 Rust/TS 三轮 manual request history；stream delta 不会和 terminal
  assistant item 双写，SQLite Model History 序列保持 user/assistant 一一对应。
- `context-normalization.reference.json` 冻结 orphan function/custom result 删除、matched pair 稳定前缀和 missing result
  的 `aborted` 修复；Rust debug 继续 fail-fast，release projection 与 TS repair 语义对齐。TS 发生任何 repair 都禁止复用
  旧 Provider checkpoint。
- `legacy-rollout-resume-fork.reference.json` 同时驱动 Rust resume、Rust compact/resume/fork 与 import-only TS importer；
  importer 从 response/replacement history 重建模型视图、从 event_msg 重建客户端历史，以一个 Thread transaction 写入，
  SQLite 关闭重开后的 resume 与真实 fork transaction 保持相同 model-visible prefix。无法无损表达的旧 model item fail closed。
- Direct HTTP/SSE parser、idle timeout、caller abort、provider checkpoint 与 durable response reconcile tests 是 AR-001 shared
  full-Turn trace 之外的补充分支证据。`provider-response-reconcile.reference.json` 记录 Rust retry/incomplete source pointer 和
  intentional TS durable recovery：POST 获得 response ID 后只 GET 同一 response，pending 不终结，unsupported fail closed。
- `websocket-transport.reference.json` 现在同时驱动 Rust 与 TS：AR-004 冻结 initial + 2 retry 后切 HTTP，AR-005 冻结
  下一 Turn sticky HTTP 且不重复 fallback，AR-011 冻结单连接复用、`previous_response_id=resp-1` 和仅发送新增 user suffix。
  Rust focused fallback `4/4`、incremental `1/1` 与 TS Agent Responses `26/26` 通过。TS 另保留 HTTP 获得独立 retry budget、
  426 立即切换、connection-limit reconnect、binary fail closed、abort/idle timeout 证据。
- AR-006 没有删除审计事实：fixture 同时冻结 Rust debug `[1,2]` 与 release `[2]`；TS durable audit 和 Control API
  `view=audit` 保留 `[1,2]`，默认 `view=client` 只投影 `[2]`，显式 fallback 始终可见。可见性不再依赖 build mode。
- `provider-usage-validation.reference.json` 冻结 provider usage 的语义校验：任一 token count 为负、cached input 超过 input、
  或 total 不等于 input+output 时，两侧都在 completed/usage 进入 Agent 记账前 fail closed。Rust 的 HTTP/SSE 与 WebSocket
  共用 `process_responses_event`，因此同一校验覆盖两种 transport；TS Direct Responses decoder 消费同一组 malformed cases。
- `typed-policy-failure.reference.json` 同时驱动 Rust cyber policy integration、Direct Responses 与 Runtime Worker；HTTP 400
  `cyber_policy` 映射为安全稳定 `responses_provider_cyber_policy`，只有一次 request、0 sampling retry、无 assistant Message，
  并原子释放 Work Item。
- `responses-lite-request.reference.json` 同时由 Rust request integration 与 TS HTTP/WebSocket adapter 消费；显式
  `responsesLite` profile 精确发送 `reasoning.context=all_turns`、`parallel_tool_calls=false`。默认 `standard` profile 不发送
  这两个 OpenAI 特定字段，保持 self-hosted Responses-compatible 路径独立。Rust focused `1/1`、TS 三条 profile evidence 通过。
- `context-window-compaction.reference.json` 同时冻结 Rust 与 TS 的 AR-025：Provider `context_length_exceeded` 映射为安全
  `responses_provider_context_length_exceeded`，compaction 在同一执行尝试内删除恰好一个最老 history item、保持 prompt 稳定并
  立即重试；只有成功结果进入 durable compaction commit。Rust focused `1/1`、TS transport/compactor/SQLite Worker 纵向证据通过。
- Runtime Worker 的 durable cancel、retryable Attempt、assistant Message terminal transaction 与真实 `SIGKILL` tests 是新的
  durability 语义；它们不替代 Rust request/history/Tool/compaction 差分。
- `stream-completed-assistant-close-retry.reference.json` 与
  `stream-completed-tool-close-retry.reference.json` 由 Rust `stream_no_completed.rs`、TS Kernel 和真实 durable Worker 共同消费。
  Rust integration 直接断言第二次 `/responses` request：assistant completed item 保留；Tool completed item 与它的一次
  model-visible output 同时保留。`PARITY†` 仅指 request-history boundary；completion observable 是上文明确的 intentional
  redesign。TS assistant test 同时消费 fixture 的 `completedAssistantOutputs=["first","done"]` 与
  `duplicateFinalOutput=false`，并断言 durable projection 只提交最终 `done` Message/一次 `message.completed`。Tool shared parity
  只覆盖 model-visible call/result、第二请求 history 与 exactly-once boundary；Rust 侧是 unknown unsupported-call handler，TS
  侧是注册的 read-only test handler，两者不代表真实副作用类型等价。fixture 的
  `tsCandidateToolHandlerInvocationCount` 是 TS-only durability assertion；Rust evidence 是第二请求恰有一个对应 output。
- `mixed-assistant-tool-response.reference.json` 冻结同一 completed response 的 commentary→Tool 顺序、第二请求的
  assistant/call/result 后缀、一次 Tool 副作用、follow-up sampling、terminal usage/error 和唯一 terminal Message。TS 把 completed
  assistant items 与首个 Tool request 原子追加到 durable Model History；Kernel/Worker 继续拒绝无法证明 completed item 的 partial text。
- `provider-end-turn-continuation.reference.json` 关闭 AR-031 的最高风险最小分支：Rust `ResponseEvent::Completed` 的
  `end_turn: Some(false)` 与 TS Responses `end_turn=false` 都会让无输出、无 Tool 的 completed response 在同一 Turn/Segment 发起第二次
  sampling；该 `PARITY` 子边界明确限于 manual / `storeResponses=false`。两次 request history 保持相同 user prefix，第一次 usage 不丢失，第二次才产生唯一 terminal assistant output，且该 continuation
  不计入 sampling retry。Rust integration 与 TS Kernel candidate 对 fixture 的 request、稳定事件、terminal 和累计 usage 自动 deep-equal。
  AR-031 的 manual / `storeResponses=false` mixed completed assistant→Tool 分支现也有独立 shared evidence：Rust 与 TS 都先保留 completed
  assistant item，再在 durable Worker Segment boundary 对 Tool 生成一次 request/result receipt，第二次 sampling 的 history suffix
  精确包含 assistant/call/result；这不是 sampling retry，首个 response 的 usage 与最终 response usage累计，唯一 terminal Message
  仍来自 follow-up。原 normal completed mixed-response fixture 保持不变并继续回归。只有 partial delta、没有对应 completed
  assistant item 的 response 继续 fail closed，避免把未完成文本写入 history。manual / `storeResponses=false` assistant-only output
  现由 Rust+TS shared fixture 冻结 exact completed-item history；durable Worker 以显式 provider-continuation sample marker 原子提交 usage、
  Model History 与 model state，并覆盖 commit 后 crash、恢复后 exact suffix 和唯一 terminal Message。
  stored-response 的 empty 分支现会从 completed checkpoint 发起新的 `previous_response_id` POST，且发送空增量 input；不会 GET/retrieve
  同一个 completed response，也不消耗 sampling retry budget。stored Tool 分支会先返回 Tool boundary 与 completed checkpoint，沿用现有
  durable Tool receipt/continuation authority。stored assistant-only output 现把 completed assistant items、usage、checkpoint、Attempt digest、
  Thread continuation 与 provider-continuation marker 在同一 Store transaction 提交；真实文件 SQLite close/reopen 证明恢复只发送一次
  `previous_response_id` POST、input suffix 为空、没有 GET/旧 response 重采样，且 history/usage/marker 不重复。InMemory 与 SQLite 消费同一
  execution-store conformance checkpoint fixture；PostgreSQL adapter 也走同一注册测试，但本轮因未配置 `CREWON_TEST_POSTGRES_URL` 明确 skip，
  不计作通过。广义 AR-031 仍标 `PARTIAL`：stored mixed assistant→Tool 还缺把 assistant history、checkpoint、Tool request boundary 与后续
  Tool receipt authority 收敛为可恢复的原子边界，因此继续以非 retryable
  `model_end_turn_false_stored_mixed_response_unsupported` fail closed。

## Goal runtime focused parity gate（2026-08-09）

结论：`PARITY（含 intentional redesign）`。Goal 状态、计费与 durable Worker 主路径已有强 focused evidence；模型可见 continuation prompt 已由
`goal-continuation.reference.json` 同时约束 Rust extension 与 TS Domain，关闭 completion audit、blocked 连续三轮阈值、
`update_plan` visibility、fidelity/no-scope-shrink、authoritative evidence 与 XML trust-boundary 漂移。Goal-bound 并行 Tool
exactly-once 和 running external clear 纵向边界也已关闭。`goal-runtime-semantics.reference.json` 只冻结跨实现公开投影与输入 delta，
并由 Rust extension/state 与 TS Domain candidate 同时消费；Tool/budget、terminal precedence、objective edit/clear、不重复与不可复活
均已有共享差分。`timeUsedSeconds` 不逐行迁移 Rust `Instant`，而是采用已冻结并有 fake-clock evidence 的 intentional redesign。

已实际运行的 Rust evidence：

| 命令                                         | 结果                              | 覆盖边界                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just test -p crewon-goal-extension`         | 26 passed、0 failed、0 skipped    | shared continuation/runtime semantics、完整 Goal context item 9,999-byte cap、cached token delta、Plan 排除、Tool finish、并发 Tool finish exactly-once、budgetLimited steering once、turn stop/abort/error、usage limit、objective set/clear、不可复活 |
| `just test -p crewon-state`                  | 242 passed、0 failed、0 skipped   | 其中 21 个 Goal state/CAS tests 覆盖 objective update、stale Goal version、budget/status precedence、并发 token delta 与删除级联                                                                                                                        |
| `just test -p crewon-app-server thread_goal` | 5 passed、0 failed、1349 filtered | Goal set/get/clear notification、objective edit 保留 usage、budgetLimited 与 stopped-status resume                                                                                                                                                      |

对应 TS focused evidence：

| 命令                                                                                                                                                                                                                                         | 结果                | 覆盖边界                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --experimental-strip-types --test packages/domain/src/run-goal-accounting.test.ts packages/domain/src/thread-goal.test.ts packages/application/src/goal-tool.test.ts packages/application/src/thread-goal-application-service.test.ts` | 40 passed、0 failed | shared runtime/prompt semantics、cursor delta、cached input、Goal-attributed elapsed、Tool Goal API、external mutation、terminal precedence、bounds/XML escape    |
| `CREWON_TEST_POSTGRES_URL='postgresql://crewon_test:crewon_test@127.0.0.1:54819/crewon_test' node --experimental-strip-types --test --test-name-pattern='Goal\|goal\|AR-008 usage-limit' apps/runtime-worker/src/runtime-worker.test.ts`     | 34 passed、0 failed | InMemory/SQLite/PostgreSQL continuation、cancel、failure、usage limit、并行 Tool boundary exactly-once、running clear、objective steering、Goal Tool crash replay |
| `node --experimental-strip-types --test --test-name-pattern='budget-limit steering' apps/runtime-worker/src/runtime-worker.test.ts`                                                                                                          | 2 passed、0 failed  | InMemory/SQLite 首次预算穿越后 durable steering 恰好一次                                                                                                          |

本轮已关闭的基础边界：

1. **P0 model-visible continuation semantic drift — 已关闭**：同一 bounded
   `packages/test-contracts/fixtures/goal-continuation.reference.json` 由 Rust `continuation_prompt` integration 和 TS
   `threadGoalContinuationPrompt` test 消费；冻结五组行为语义、XML escape/注入拒绝，并把该 fixture 渲染后的单个 model item 限制在
   9,999 UTF-8 bytes 内。Rust 与 TS continuation/objective-update/budget-limit renderer 都对完整 context item（包括 runtime marker）执行
   同一 9,999-byte 硬上限，最坏 4,000-scalar objective focused test 已通过；截断提示要求调用 `get_goal` 恢复完整 objective。
2. **P0 Goal-bound parallel Tool accounting — 已关闭**：Rust
   `parallel_tool_finish_accounts_active_goal_progress_once` 与 TS InMemory/SQLite
   `accounts parallel Goal-bound Tool completions exactly once` 均证明 Goal revision、cursor watermark 与 budget steering 不重复。
3. **P1 running external clear — 已关闭**：InMemory/SQLite/Postgres 三种 Store 均通过
   `clears a running Goal without canceling or reviving its current Run`；当前 Run 继续运行但不再归因于已清除 Goal，terminal 不复活旧 Goal。
4. **P0 idle wall-clock/resume semantics — accepted intentional Goal-bound Run elapsed redesign**：不迁移 Rust 的 idle
   wall-clock。Rust 当前实现不是 durable absolute wall-clock：`GoalWallClockAccounting` 使用进程内 `Instant`；active Goal 在
   `restore_after_resume` 时以 resume 当刻重新建立 baseline，离线时间不会被补记，但 resume 后尚无 Turn 的 live-runtime idle
   时间会在下一次 external mutation/accounting boundary 结算。TS 当前 event-sourced cursor 则在 `run.started` 建立
   `timeBaselineAt`，并在 Tool boundary、running external mutation 与 terminal transaction 中按整秒推进 baseline。最终语义冻结为：
   `timeUsedSeconds` 是 Goal attribution 已打开的 durable Run 从 `run.started` 到 terminal/detach 的累计 elapsed whole seconds；排除
   queued 时间、Run 之间的 idle 时间，以及 queued 状态下的进程停机；已经 started 且仍属同一 durable Run 的 approval、suspend、
   reconcile 和 Worker recovery 间隔仍属于该 Run elapsed interval。这样不会因调度积压或 active Goal 长期无人执行而增长，也不引入
   无法与 Rust `Instant` 精确对应的持久化 idle timestamp。

   - **冻结证据**：`ARCHITECTURE_FINAL.md` 与 Control OpenAPI 的 `timeUsedSeconds` description 已明确上述语义；Domain deterministic
     tests 覆盖 queued 排除、started/recovery、rebind 保留亚秒余量、detach 后停止、跨 continuation idle 排除与 clock regression。
   - **最小字段/实现边界**：不新增 Goal-level idle cursor；现有 `RunGoalAccountingCursor.timeBaselineAt`、`throughRunSequence`、
     `accountedUsage`、`attribution` 与 `updatedAt` 已足够。`run.created` 保持 null baseline；`run.started` 打开 baseline；Tool finish、
     external mutation 和 terminal compound transaction 继续原子结算并保留 sub-second remainder；terminal/detach 关闭 baseline；下一
     continuation Run 到自己的 `run.started` 才重新打开。若要增加可发现的 policy 名称，只新增非行为性的
     `goalAttributedRunElapsed.v1` 文档/常量，不应为了标签改写 append-only v0 Event 或要求 active Run drain。
   - **兼容/迁移**：TS 现有 cursor 数值行为无需 data rewrite；历史 v0 Run Event/snapshot 必须继续原样 replay。Rust import 的既有
     `timeUsedSeconds` 作为不可分解的 historical seed 保留，切换后只按新语义追加，不能回算或归零。公开 Goal/OpenAPI、Goal Tool 和
     prompt 文案需把 `elapsed time` 收窄为上述 Goal-bound Run elapsed，且 release note 明示 idle/resume divergence；旧客户端字段形状不变。

5. **P1 non-continuation shared differential — 已关闭**：bounded、provider-neutral
   `packages/test-contracts/fixtures/goal-runtime-semantics.reference.json` 不序列化 TS cursor、Goal revision 或 Rust `Instant`，只冻结
   `input-cachedInput+output` delta、terminal outcome 与公开 `objective/status/tokenBudget/tokensUsed`。它覆盖普通 Tool boundary、首次
   budget crossing/steering once、completed/canceled 保持 active、failed→blocked、budget 优先 generic failure、usage-limit 优先 budget、
   objective edit 保留 usage、clear 幂等与 late terminal 不复活；Rust 真实 extension/SQLite state path 和 TS Domain reducer/accounting
   同时消费；Worker InMemory/SQLite/PostgreSQL 纵向 tests 证明相同 durable 结果。

保留的迁移边界不是 parity blocker：Rust import 的既有 `timeUsedSeconds` 仍作为不可分解 historical seed 保留，切换后只追加、不回算；
shared fixture 有意不冻结实现内部 revision/cursor/`Instant`，focused/offline evidence 也不外推为 staging 或生产 SLO。

## 实施顺序

1. AR-002/003/008/009/010 与 AR-013–022 的 shared fixture 主路径已完成。
2. AR-001/006/012/018/023–030 的 shared fixture 与 projection 已完成；AR-017/019 的 intentional redesign 已由共享
   scheduling fixture 冻结，不把不安全的 Rust mutation 行为逐行迁移。AgentVersion compiler、tenant-scoped durable registry、
   prior-runtime resolution、服务端 exact admission 与多 Provider runtime factory 已接管不可变版本选择。default/selected-version
   已收敛为 digest-addressed durable release bundle；独立 release 进程以单事务提交全部 Deployment、operator audit 与 CAS active
   pointer，支持无 Provider 凭据的 audited rollback。Control 只接收 active bundle，Worker 可读取 historical bundle 恢复已 pinned
   Run。远程 mutation MCP 仍只有在 receipt/reconcile/auth 契约完成后才能启用。
3. durable Tool Step/Attempt/Receipt、ActionIntent 与 per-action Approval 的 approve/reject/expire/cancel-supersede 原子恢复路径已落地；
   authenticated Worker→Gateway dispatch、单 Gateway SQLite terminal replay 与 Standalone encrypted Artifact authority 已接通。
   下一步接跨 Action supersede、Team Artifact/KMS/scan/streaming、Native raw admission 的真实 capability/receipt dispatcher 接线后，
   再开放完整 shell/MCP mutation/Native Device 能力。
   stdio MCP read-only Adapter 已通过真实独立进程；mutation 仍因缺少标准 receipt/reconcile 而拒绝。
   Device Gateway 已通过真实 WebSocket session、lease/sequence/ACK/cancel/unknown-outcome、mTLS fingerprint 身份 Gate 和
   Worker HTTPS→Gateway restart receipt replay；完整 RuntimeWorker Run→durable Approval→Device→ToolResult→follow-up sampling
   也已通过，但测试 Device 仍不是三平台 Native Runtime。
   Device Protocol signed command/Hello/ACK/cancel/六类 event、拒绝错误码与 canonical payload digest 已由 TS/Rust 同一 shared
   fixture 自动对比；两侧 Ed25519 verifier 都拒绝签名后篡改。Worker Tool command 已携带数据库续租 lease，开源 Ed25519
   signer 会生成不超过该 lease 的短期 authorization；真实 mTLS HTTPS/WSS 与 Gateway restart terminal replay 已通过。HSM/KMS、
   原授权有效期内的 active reconnect、PostgreSQL shared execution/route authority、Gateway peer mTLS forwarding 与 TS/Rust
   connection-epoch welcome wire 已完成；最小 Rust `crewon-device` 的 bounded raw Ed25519、append-only durable highest-epoch fence 与
   线性化 start permit 已通过 focused `10/10`。隔离 PostgreSQL 15 的两个真实 Gateway 子进程已覆盖 non-owner dispatch、owner
   `SIGKILL`、takeover、reconcile/cancel 且副作用只启动 1 次；真实 Native WSS/UDS capability/receipt dispatcher、前一版本兼容和
   native execution 仍未完成。
   首次 unknown outcome 的 Receipt、Run reconciliation Event/Outbox、Tool Attempt failure 与 Work Item retry release 已合并为
   单一 fenced Store transaction；legacy partial receipt repair 仍只作 fail-closed recovery。
4. WebSocket/fallback 的 AR-004–006/011 与 Responses Lite AR-007 已通过 shared fixture；不可变 AgentVersion
   compiler/registry、Control admission 与 runtime factory 已把 AR-012/024 推进到 server-selected multi-version 后端链路。
   staging/live Provider 与真实 UI 尚未验证，production routing Gate 仍未关闭。

每完成一个 case，必须同时留下 Rust source pointer、shared fixture、TS candidate test 和差分结果；只新增 TS snapshot 或只引用
Rust 测试名称都不能把状态改成 `PARITY`。
