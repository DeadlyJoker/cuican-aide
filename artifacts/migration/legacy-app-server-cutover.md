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

The legacy JSON-RPC Goal notifications and pre-send Goal/Plan writes are not
part of these paths. When Control is configured but unavailable, Thread
authority fails closed instead of selecting the legacy client.

## Still using the compatibility sidecar

| Capability family                                            | Why the sidecar is still required                                                                                   | Required replacement before deletion                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| account/config/model discovery and account-backed providers  | settings and account metadata still use existing app-server RPCs; only desktop secret ownership has moved           | typed non-secret settings/account ports and an actual Control/Worker provider probe                                    |
| terminal, shell, filesystem, search, Git and workspace watch | renderer workbench actions still call local app-server process capabilities                                         | Device/Native Runtime capability protocol, bounded streaming, cancellation and durable mutation receipts               |
| MCP, plugins, skills, hooks, apps and external agents        | discovery/configuration remains on the legacy catalog and some execution paths are not yet reconcilable             | versioned catalogs plus reviewed Tool admission; mutation requires durable provider receipt/reconcile                  |
| Agent Platform resources, expert teams and remote workspaces | these are external-resource and entitlement integrations, not local Run authority                                   | scoped provider adapters with PIM identity/resource bindings and fail-closed availability                              |
| Workflow, Office, automation and Human Gate surfaces         | legacy definitions and schedulers still serve product UI outside the new single-Run slice                           | versioned Workflow/Office projections on unified Run/Step/Attempt and a one-time importer; remove duplicate schedulers |
| memory and remaining Thread settings                         | memory mode and remaining settings still call legacy session/config methods even though main Thread authority moved | durable memory eligibility/records; explicit import-only tools retain provenance                                       |
| desktop packaging bootstrap                                  | the application bundle still stages and starts `crewon-app-server` for the families above                           | zero renderer production calls, startup without the binary, migration/import tool separated from normal runtime        |

## Hard deletion gate

The legacy app-server can leave the PC/Web product package only when all of the
following are true:

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
   dual-write fallback.
5. macOS, Windows and Web production packages pass their signed release gates;
   real Identity/PIM and at least one live Provider canary are verified.

Until those gates pass, the sidecar is a compatibility dependency for the
listed peripheral families. It is not the authority for the already-cut-over
Thread/Run/Goal/Plan path.
