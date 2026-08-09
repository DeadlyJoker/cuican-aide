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

| Slice                                      | Thread                                 | Worktree                                              | Isolated result                                                           | Shared-root status               |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| Provider settings and real `/models` probe | `019fe5f8-835b-7f22-badf-29042cfea9f0` | `/Users/wangqichen/.codex/worktrees/aee9/cuican-aide` | Control-to-Worker probe, bounded/redacted result and focused tests passed | authority integrated; probe pending |
| Native workspace top-level list            | `019fe5f8-835b-7f22-badf-2932191f2b76` | `/Users/wangqichen/.codex/worktrees/9118/cuican-aide` | Control-to-Device-to-Native read-only operation and focused tests passed  | handoff complete; not integrated |
| `manualOnly` Automation and immediate Run  | `019fe5f8-835b-7f22-badf-28f2c796ccdd` | `/Users/wangqichen/.codex/worktrees/645d/cuican-aide` | durable definition plus immediate unified Run and focused tests passed    | Domain/Application foundation integrated; Store pending |

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
  9,999-byte fully rendered instruction admission, invocation binding, and an
  Application compound-port/service foundation with receipt-first create and
  run-now semantics. Application tests are `75/75` at that integration point.
  Store persistence is intentionally blocked until Automation origin is a
  canonical Run, Message, Model History and WorkItem field accepted by the
  existing reducers/codecs; casts or validator bypasses are forbidden.
- The isolated implementation has no due-trigger claim, scheduler, misfire,
  timezone or restart compensation. It may expose only `manualOnly` definitions
  and an immediate command; `automaticScheduling=false` remains explicit.
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
- Control owns a durable receipt keyed independently of the request body. It
  freezes policy, route, workspace, device, action and command digests;
  reconcile/cancel load that frozen operation and never recompute a new route.
- Native scanning must bound scanned entries, bytes and wall time and observe a
  cancellation token during traversal. The prototype's collect-all, sort and
  truncate behavior is not bounded execution.
- Cross-process receipt authority, winner deep replay, UTF-8 bytewise ordering,
  stable directory-handle/no-follow semantics and Windows DACL/reparse handling
  are mandatory before enabling the operation.
- There is currently no staged/supervised Native binary or mTLS/device binding
  provisioning in the desktop bundle. Until packaged crash/replay acceptance
  passes, the production result is `deviceUnavailable`; renderer filesystem
  fallback is forbidden.

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
