# Parallel worktree integration queue

Status: shared-root integration in progress  
Date: 2026-08-09

The following vertical slices were implemented and tested in independent Codex
worktrees created from the same dirty working-tree snapshot. Isolated results
remain handoff evidence only. The shared-root status column is authoritative
for work that has since been rebased and revalidated here.

Do not copy shared hotspot files wholesale. The shared root has since added
Thread lifecycle/delete, Goal, Plan, manual compaction and rollback work which
the worktrees do not contain.

## Queue

| Slice                                      | Thread                                 | Worktree                                              | Isolated result                                                           | Shared-root status                                                                                                                             |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider settings and real `/models` probe | `019fe5f8-835b-7f22-badf-29042cfea9f0` | `/Users/wangqichen/.codex/worktrees/aee9/cuican-aide` | Control-to-Worker probe, bounded/redacted result and focused tests passed | authority, PC native coordinator, safe public probe and UI integrated; Team live gates remain                                                  |
| Native workspace top-level list            | `019fe5f8-835b-7f22-badf-2932191f2b76` | `/Users/wangqichen/.codex/worktrees/9118/cuican-aide` | Control-to-Device-to-Native read-only operation and focused tests passed  | bounded operation/delivery authority, Gateway local/peer recovery, Native journal/WSS runtime, public Control/client and Control-only UI state integrated; visible App authority and packaged process supervision pending |
| `manualOnly` Automation and immediate Run  | `019fe5f8-835b-7f22-badf-28f2c796ccdd` | `/Users/wangqichen/.codex/worktrees/645d/cuican-aide` | durable definition plus immediate unified Run and focused tests passed    | canonical authority, three Store adapters, Control/client and manual-only UI integrated                                                        |

## Mandatory merge order

1. Finish the shared-root rollback Store migration before assigning another
   SQLite schema version.
2. Integrate Provider authority first. Rebase its proposed SQLite v19 and
   PostgreSQL component schema on the then-current shared versions; merge
   OpenAPI and generated client symbols instead of replacing files.
3. Integrate Automation second. Provider and Automation both proposed SQLite
   v19 in isolation, so Automation must receive the next version or be combined
   with Provider in one explicitly reviewed migration. Two unrelated v19
   migrations must never coexist.
4. Integrate Native workspace-list last because it changes Cargo dependencies,
   Device Runtime packaging, Control routes and renderer wiring but no database
   schema. Merge its new files first, then relocate Device runtime config and
   merge shared symbols.

Each integration must regenerate contracts and lockfiles from the shared root,
run its focused tests, then run the affected package suites. Isolated worktree
lockfiles and generated files are not authoritative.

## Rebase decisions

### Provider settings and `/models` probe

- Shared SQLite v19 is the rollback authority. Provider settings use v20.
  PostgreSQL keeps an independent `model_provider_settings_authority` component
  at v1; it must not be coupled to `thread_authority` v5.
- The shared root now implements and validates the durable two-phase authority:
  immutable actor-audited operation records, Store-owned TTL, explicit
  `finalize | abort | expire` terminal receipts, latest-finalized catalog-head
  validation and history-independent receipt replay. Pending switches fence
  new Run, TurnStart and Goal activation/continuation admission. SQLite v19 to
  v20 preserves rollback invalidations and receipts.
- Shared validation after the rebase: Application `77/77`; Provider
  InMemory/SQLite `22/22`; real PostgreSQL 15 focused `13 passed + 1 sentinel
skip`; real PostgreSQL Store full `329 passed + 1 sentinel skip`, zero
  failures. The authority is integrated, but no public Control mutation or UI
  cutover is enabled yet.
- The private probe foundation now binds every request and result to the
  durable catalog revision, Provider ID and server-derived `runtimeBindingId`.
  Node 24 uses a one-request socket, pinned approved address, post-connect
  `remoteAddress` verification and original-host SNI/certificate validation;
  redirects and responses above 64 KiB are rejected. Control cancellation and
  one total deadline propagate through tenant routing and the private Worker
  server to the Provider socket and secret lease. Final shared evidence is:
  four package typechecks; Provider Application/Store `31/31`; Runtime Worker
  `28/28`; Control `7/7`; Application full `81/81`; real PostgreSQL Store
  `334 passed + 1 sentinel skip`; Runtime Worker full `132 passed + 1
PostgreSQL-unconfigured skip`; Control full `52 passed + 3 PostgreSQL
integration skips`, all with zero failures.
- The PC native two-phase coordinator, safe public snapshot/probe, typed client
  and Control-only UI are now integrated. Team production still requires
  Control-to-Worker mTLS/service identity, a durable cross-replica rate
  authority, tenant-owned DNS/egress policy and live Identity/PIM staging;
  missing Team routing remains unavailable rather than selecting the desktop
  path.
- The isolated direct catalog replacement is not the final mutation protocol.
  The shared authority must persist `prepare -> finalize | abort`, keep the
  active catalog unchanged while a switch is pending, and fence Run admission
  and probes until the native/team runtime coordinator proves the candidate
  generation is active. Unknown outcomes replay the same phase receipt.
- A desktop renderer must not publish a new Control catalog and then ask Tauri
  to replace the old Worker. Coordinator operation IDs and proofs are
  server/native-derived; a rollback failure leaves the supervisor unavailable
  instead of exposing two authorities.
- Production Control is multi-tenant, so a single fixed Worker probe client is
  insufficient. A trusted tenant route resolver selects a preconfigured Worker
  endpoint; tenant input can never select a URL or credential. Missing routing
  is `providerUnavailable`, not cross-tenant fallback.
- The real `/models` request remains bounded, redirect-free and redacted, but
  syntax validation is not an egress policy. Production requires an injected
  tenant/provider/endpoint policy and resolved-address checks; approved
  self-hosted endpoints are explicit policy decisions.

### `manualOnly` Automation

- Provider v20 lands first; Automation uses SQLite v21 and a separate
  PostgreSQL `automation_authority` v1 component.
- The shared root now has the immutable manual-only Domain definition,
  9,999-byte fully rendered instruction admission, and a canonical invocation
  origin shared by Message, Model History, `run.created`, Run state and the
  WorkItem. Its binding freezes the Automation revision/definition digest,
  instruction digest, invocation/run identity and the invocation-time route
  digest. Application receipt-first create/run-now semantics perform coarse
  authorization before receipt lookup, exact authorization on a miss, and
  deep fresh/replay result validation. Current evidence is Application
  `81/81`, Automation focused `12/12`, Store invariant focused `2/2`, and Store
  non-PostgreSQL `208 passed + 43 conditional skips`, with zero failures.
  Casts or validator bypasses are forbidden.
- Rollback, fork and compaction now consume the same Domain-owned source
  classifications. `automation_invocation` is an instruction boundary, a
  Message-ledger-backed item and a retainable user instruction; Goal
  continuation/steering are none of those. Rollback invalidates the correlated
  Automation Message, fork preserves only surviving canonical origin/binding
  data, and later manual/automatic compaction cannot resurrect a rolled
  Automation instruction. Domain `80/80`, Context `17/17`, Application `82/82`,
  cross-package focused `41/41`, two Store rollback adapters `2/2`, and Worker
  Automation/rollback/compaction `2/2` passed at this boundary.
- InMemory, SQLite v21 and PostgreSQL `automation_authority` v1 now implement
  the compound authority. Fresh invocation holds the Provider admission fence,
  then the proposed Run and Thread fences, and atomically commits the
  definition-bound Message, Model History, Thread/Run events and snapshots,
  Outbox, canonical WorkItem and receipt. Receipt replay validates immutable
  durable artifacts but permits legitimate later Run/Thread/queue evolution
  and rollback invalidation. SQLite reads receipt authority in one read
  snapshot; PostgreSQL uses receipt -> Provider -> Run -> Thread lock order.
  Shared-root validation is Application `83/83`, non-PostgreSQL Store
  `216 passed + 45 conditional skips`, and real PostgreSQL Store full
  `350 passed + 1 sentinel skip`, with zero failures. The final PostgreSQL
  Automation `9/9` also exercises commit-prior replay directly, a fresh
  repeatable-read snapshot after the idempotency transaction, and the same
  `hashtextextended` proposed-Run lock used by production Run authority.
- The isolated implementation has no due-trigger claim, scheduler, misfire,
  timezone or restart compensation. It may expose only `manualOnly` definitions
  and an immediate command; `automaticScheduling=false` remains explicit.
- The shared Control/client/UI vertical now exposes only create/get/list and
  immediate `run-now`. Public projection freezes `manualOnly` and
  `automaticScheduling=false`; the existing schedule page no longer displays
  frequency, next-run or enabled controls for this authority. Unknown outcomes
  retry the same key once, including malformed 2xx recovery, and the accepted
  canonical Run is correlated through redacted invocation identity before the
  normal Run SSE runtime adopts it. Strict RunView/SSE validation binds the
  expected Thread and Run. Runtime/session/workspace generations fence stale UI
  writes, and Control cohorts block legacy AppServer Automation at open,
  deep-link, dispatch, action and notification/polling layers.
- Immediate execution cannot be a plain synthesized user Turn. The atomic Turn
  transaction must pin a server-derived Automation definition ID, revision,
  digest and invocation identity on the Run/Message origin. Receipt replay
  occurs before definition/route lookup, changed payload conflicts, and the UI
  may correlate only this origin instead of treating every Run on the Thread as
  an Automation Run.
- Definition creation must validate the exact tenant/space/active Thread in the
  same transaction/lock as the Automation row. A foreign key to a soft-deleted
  Thread is not an admission fence.
- The complete rendered Automation instruction item is capped at 9,999 UTF-8
  bytes, including XML/structured wrapper escaping. Oversized definitions fail
  at creation; runtime truncation must not silently change the task.

### Native top-level workspace list

- The isolated slice is a protocol/implementation source, not a packaged
  cutover. Shared Control/contracts/client/UI symbols must be replayed
  additively after Provider and Automation; whole-file copies would delete
  rollback, manual compaction and Thread SSE.
- Application owns an immutable phase receipt plus append-only operation revisions and delivery attempts. It freezes policy, workspace/device/runtime
  binding、action/command digest与Thread fence；reconcile/cancel加载冻结operation，不能以新的signed command/lease冒充原execution。
- Native scanning must bound scanned entries, bytes and wall time and observe a
  cancellation token during traversal. N3a now keeps stable handles and bounds
  entry/name/output work; a single already-blocked kernel enumeration call is
  not forcibly interrupted yet, so absolute wall-time on a failed/network
  filesystem remains a supervised-process/platform-cancel Gate.
- Cross-process operation/revision/delivery-attempt authority、UTF-8 bytewise ordering、stable
  directory-handle/no-follow semantics and Windows reparse handling are now
  implemented. The additive signed Workspace Device command is also frozen in
  TS/Rust shared fixtures without fake Run identifiers. Native now verifies that
  command against the current device/runtime/workspace incarnation, acquires the
  stable handle under the connection epoch, scans outside the epoch lock and
  rejects a result after takeover at a post-scan fence. Additive Workspace
  event/ACK and Worker/peer dispatch contracts are frozen without changing the
  old Tool wire. Gateway SQLite v2/PostgreSQL v3 now persist global Tool/Workspace kind、accepted/terminal event与frozen route receipt；
  Application SQLite v23/PostgreSQL workspace v2 persist attempt leases和历史result revisions。Gateway本地Workspace Worker API/session已实现
  accepted/terminal commit-before-ACK、跨expiry exact replay、orphan event恢复与runtime-binding authorization；独立Native SQLite journal及
  orchestrator已实现command+accepted、terminal、cumulative ACK、accepted-before-scan observer、accepted-only crash unknown recovery和零scan terminal
  replay。Workspace Team router/peer使用Gateway mTLS、目标证书pin、完整route及sourceWorker runtime
  fence，并通过真实PG owner SIGKILL恢复且不重复listing。独立`crewon-device-runtime`现已把journal orchestrator接到真实TLS1.3 mTLS WSS，
  以subscribe-before-snapshot/replay-first enqueue关闭generation handoff漏发与乱序，并保持ACK/cancel reader在blocking scan期间可响应。
  Runtime Worker与Control之间的PC loopback private freeze/dispatch client也已接通，写权限独立于read权限；public contract与三Store bounded
  read authority已冻结。public Control handler/client、Control-only UI状态机和未接App的compact可见panel已接通；packaged Worker
  Workspace stdin/private/mTLS vertical已通过。Tauri现已stage native Device binary与Gateway bundle，并能从已提交的native authority按
  Gateway(port0)→Device(strict Welcome/epoch)→Worker(v2 private ready)→Control顺序启动；四个child都受同一Supervisor生命周期约束。
  Provider reload保留Gateway/Device与同一App-lifetime material，只重启Worker/Control并重新验证Workspace private binding。目录选择/clear的
  四进程切换事务、App接线、real Windows host validation和最终实包crash/replay acceptance仍是启用前硬门槛。
- Native binary、ephemeral PKI、mTLS/device/command binding与四进程initial supervision已经存在，不能再描述为“未stage”；但renderer
  filesystem fallback仍严格禁止。直到native selector在active Run/Workspace delivery fence下完成candidate startup、catalog commit与Control
  admission activation的无窗口切换，并通过实包orphan=0验收，production mutation仍应投影为`deviceUnavailable`/read-only。

## Shared hotspot rules

- Preserve `ThreadCompactionApplicationService`, `thread.rolled_back`, Goal
  accounting, lifecycle tombstones, ProposedPlan projection and purpose-aware
  maintenance Run filtering.
- Preserve receipt-first replay and the global PostgreSQL lock order.
- Never add a renderer fallback to legacy Rust when Control is configured.
- Do not claim Native production cutover until the real WSS/UDS process host,
  restart receipt recovery and packaged acceptance have passed.
- Do not claim Automation scheduling until due-trigger claim, misfire/dedupe,
  timezone ownership and restart compensation exist.
- Do not claim a Provider is usable from a static catalog or mock; the shared
  vertical test must traverse Control, authenticated Worker and a real bounded
  HTTP endpoint without persisting or returning the credential.
