# Legacy App Server cutover gate

This matrix records the current product call path. It is an authority/deletion
gate, not a compatibility promise: a row may move to Control only after its
replacement has a durable owner, generated contract, recovery semantics and a
production composition test. A failed Control path must never silently fall
back to the legacy Rust authority.

## Already cut over

| Capability                                                   | Current authority                                                          | Renderer path                                                                                  | Deletion evidence                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Thread list/read/create/fork/archive/unarchive/rename/delete | Control API + Domain Store                                                 | `ControlThreadRuntime` selected whenever a Control session is configured                       | generated HTTP client, revision CAS, same-key retry, Thread SSE, SQLite/PostgreSQL conformance                                       |
| Turn admission and Run lifecycle                             | Control API + Runtime Worker                                               | one atomic `startTurn`, Run SSE and durable refresh                                            | route-pinned admission, Work Item lease, Attempt/Step, restart and PostgreSQL worker competition                                     |
| persistent Goal                                              | Thread Goal snapshot/event authority                                       | Goal GET/mutation + independent Goal SSE                                                       | snapshot/event cursor handoff, accounting cursor, Rust/TS shared fixtures                                                            |
| one-Run Plan                                                 | terminal Message with `ProposedPlan`                                       | dedicated transcript Plan item                                                                 | atomic Message/history/event/outbox commit, refresh recovery, read-only Tool policy                                                  |
| manual context compaction                                    | Control API + Runtime Worker maintenance Run                               | settings action uses `ControlThreadRuntime.compactThread`; Run SSE owns progress               | receipt-first command replay, Thread/history/active-Run/Goal admission fence, atomic compaction terminal commit on SQLite/PostgreSQL |
| Thread transcript rollback                                   | append-only Thread event, Model History marker and invalidation read model | settings action uses `ControlThreadRuntime.rollbackThread`; Thread SSE refreshes standard view | receipt-first CAS command, active-Run/Work fences, audit-preserving projection, SQLite/PostgreSQL conformance and Rust/TS fixture    |
| desktop Provider secret                                      | operating-system credential store through the open-source `keyring` crate  | typed Tauri credential catalog; secret is injected only into the supervised Worker environment | catalog/keyring compensation, real macOS Keychain round trip, active-Run admission fence                                             |
| Provider settings and probe                                  | Control API + Provider coordinator/Worker                                  | Settings reads the redacted Control snapshot; probe uses the typed Control client               | non-secret contract, runtime availability, idempotent bounded probe and production egress fence                                      |
| active Agent catalog                                         | immutable AgentVersion release authority                                   | Agent Library reads the active Control catalog                                                   | release/digest admission, active default selection and bounded public projection                                                     |
| manual-only Automation                                       | Control API + Automation Application/Store                                 | Automation Library lists immutable definitions and `run-now` uses Automation/Thread revision CAS | receipt-first create/run, idempotency, canonical Run binding and explicit absence of scheduling/toggle compatibility                 |
| Tool output resources                                        | encrypted Artifact authority                                               | Tool Library validates current-Thread Run `outputRef` values through Control before display       | digest, source Run/Step, scan/sensitivity projection and bounded 50-Run/20-reference lookup                                           |
| selected Workspace list/read                                 | local TypeScript Runtime Worker                                             | authenticated Control/Worker path; renderer uses typed Workspace client                           | root/symlink/UTF-8 bounds, durable receipts, restart and packaged smoke                                                               |
| Workflow including Human Gate                                | Control API + canonical Domain Store + TypeScript Runtime Worker            | Workflow start/gate APIs and Run events                                                           | atomic start/fan-out/admission/settlement/gate/reconcile/cancel/terminal convergence on SQLite/PostgreSQL                             |
| Knowledge records                                            | Control API + canonical Domain Store                                         | Knowledge Library lists bounded memory/source records through the typed Control client             | receipt-first create, strict UTF-8/NFC/digest validation, tenant/space isolation and stable pagination                               |
| Office definitions and explicit target Runs                  | Control API + canonical Domain Store + canonical Run service                 | Office Library lists immutable versions; execution remains an ordinary AgentVersion-pinned Run     | receipt-first version CAS, published AgentVersion references, scoped pagination and no Office-specific scheduler/runtime             |

The legacy JSON-RPC Goal notifications and pre-send Goal/Plan writes are not
part of these paths. When Control is configured but unavailable, Thread
authority fails closed instead of selecting the legacy client.

## Not migrated and deliberately unavailable under Control

| Capability family                                            | Current Control behavior                                                                                            | Required replacement before enabling                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| account and remaining config                                 | no packaged legacy connection; unsupported panels fail closed                                                       | typed account/config queries with an explicit durable owner                                                             |
| terminal, shell, search, Git and workspace watch             | no packaged legacy connection; these actions are not advertised as migrated                                         | bounded native TypeScript capability ports, cancellation and durable mutation receipts                                 |
| MCP, plugins, skills, hooks, apps and external agents        | library shows no fabricated catalog and does not fall back                                                          | versioned catalogs plus reviewed Tool admission; mutation requires durable provider receipt/reconcile                  |
| Agent Platform resources, expert teams and remote workspaces | external-resource/entitlement surfaces remain unavailable                                                           | scoped provider adapters with PIM identity/resource bindings                                                            |
| Office expert delegation and automatic orchestration         | Office definitions are readable, but expert aliases, auto-dispatch, scheduler and memory handoff remain unavailable | an explicit product contract on top of canonical Workflow/Run authority; no legacy compatibility layer                 |
| Knowledge retrieval and lifecycle                           | bounded records are readable; delete/reset, ingestion, embedding and RAG remain unavailable                         | explicit retention/deletion receipts and a bounded retrieval authority                                                 |

## Hard deletion gate

The legacy Rust app-server and Device binaries have already left the packaged
desktop runtime. The remaining renderer source and explicit development-only
legacy path can be deleted when all of the following are true:

1. A source scan and production composition test show zero renderer business
   calls to the legacy client. Import-only tooling is a separate executable and
   cannot be selected by normal runtime routing.
2. Control/Worker/Native Runtime start, execute, recover and upgrade without the
   legacy process or its database. Killing or removing the old binary cannot
   reduce an advertised capability silently.
3. Each mutation family has idempotency, authorization, durable receipt,
   unknown-outcome reconciliation and crash recovery. Read-only families have
   bounded pagination/streaming and scope isolation.
4. Standalone SQLite and Team PostgreSQL migration counts, digests and
   invariants match; rollback is a release/authority pointer operation, not
   dual-write fallback. A suite skipped because no real PostgreSQL URL is
   configured remains recorded as unverified.
5. macOS, Windows and Web production packages pass their signed release gates;
   real Identity/PIM and at least one live Provider canary are verified.

Until those gates pass, the residual source is not a compatibility promise:
packaged Control paths fail closed for unavailable families and never start or
select the Rust app-server.
