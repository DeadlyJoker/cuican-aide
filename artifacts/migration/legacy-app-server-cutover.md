# Legacy App Server cutover gate

This matrix records the current product call path. It is an authority/deletion
gate, not a compatibility promise: a row may move to Control only after its
replacement has a durable owner, generated contract, recovery semantics and a
production composition test. A failed Control path must never silently fall
back to the legacy Rust authority.

## Active migration rule

The production target is the TypeScript Control/Worker runtime. Rust Runtime
behavioral parity, dual execution, dual write, fallback routing and compatibility
fixtures are not release gates. Existing Rust comparison fixtures are historical
evidence only and may be retained while useful, but new TypeScript work must be
judged against the frozen domain/transaction contracts and production recovery
invariants. Rust remains in scope only where the Tauri shell or process guardian
actually requires it.

## Already cut over

| Capability                                                   | Current authority                                                          | Renderer path                                                                                        | Deletion evidence                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Thread list/read/create/fork/archive/unarchive/rename/delete | Control API + Domain Store                                                 | `ControlThreadRuntime` selected whenever a Control session is configured                             | generated HTTP client, revision CAS, same-key retry, Thread SSE, SQLite/PostgreSQL conformance                                       |
| Turn admission and Run lifecycle                             | Control API + Runtime Worker                                               | one atomic `startTurn`, Run SSE and durable refresh                                                  | route-pinned admission, Work Item lease, Attempt/Step, restart and PostgreSQL worker competition                                     |
| persistent Goal                                              | Thread Goal snapshot/event authority                                       | Goal GET/mutation + independent Goal SSE                                                             | snapshot/event cursor handoff and accounting cursor                                                                                  |
| one-Run Plan                                                 | terminal Message with `ProposedPlan`                                       | dedicated transcript Plan item                                                                       | atomic Message/history/event/outbox commit, refresh recovery, read-only Tool policy                                                  |
| manual context compaction                                    | Control API + Runtime Worker maintenance Run                               | settings action uses `ControlThreadRuntime.compactThread`; Run SSE owns progress                     | receipt-first command replay, Thread/history/active-Run/Goal admission fence, atomic compaction terminal commit on SQLite/PostgreSQL |
| Thread transcript rollback                                   | append-only Thread event, Model History marker and invalidation read model | settings action uses `ControlThreadRuntime.rollbackThread`; Thread SSE refreshes standard view       | receipt-first CAS command, active-Run/Work fences, audit-preserving projection and SQLite/PostgreSQL conformance                     |
| desktop Provider secret                                      | operating-system credential store through the open-source `keyring` crate  | typed Tauri credential catalog; secret is injected only into the supervised Worker environment       | catalog/keyring compensation, real macOS Keychain round trip, active-Run admission fence                                             |
| Provider settings and probe                                  | Control API + Provider coordinator/Worker                                  | Settings reads the redacted Control snapshot; probe uses the typed Control client                    | non-secret contract, runtime availability, idempotent bounded probe and production egress fence                                      |
| active Agent catalog                                         | immutable AgentVersion release authority                                   | Agent Library and command target/model selector read the active Control catalog                      | release/digest admission, active default selection, exact AgentVersion target binding and bounded public projection                  |
| released Tool capability catalog                             | immutable AgentVersion release projection                                  | typed Control client exposes bounded read-only capability metadata; no mutable legacy Skill owner    | release-bound cursor, tenant/space scope, stable ordering and no schema, instructions, credentials or secret projection              |
| device-local locale and appearance settings                  | standalone Control API + atomic SQLite settings snapshot                   | Account/Appearance panels use the typed Control client; startup hydrates renderer state from Control | strict generated contract, CSRF mutation, revision CAS, cross-connection concurrency and stable 409/503 failures                     |
| manual-only Automation                                       | Control API + Automation Application/Store                                 | Automation Library lists immutable definitions and `run-now` uses Automation/Thread revision CAS     | receipt-first create/run, idempotency, canonical Run binding and explicit absence of scheduling/toggle compatibility                 |
| Tool output resources                                        | encrypted Artifact authority                                               | Tool Library validates current-Thread Run `outputRef` values through Control before display          | digest, source Run/Step, scan/sensitivity projection and bounded 50-Run/20-reference lookup                                          |
| selected Workspace list/read/search/Git status               | local TypeScript Runtime Worker                                            | authenticated Control/Worker path; renderer exposes only bounded Search and Git status tools         | root/symlink/UTF-8 bounds, durable receipts, bounded read-only operations, restart and packaged smoke                                |
| Workflow including Human Gate                                | Control API + canonical Domain Store + TypeScript Runtime Worker           | Workflow start/gate APIs and Run events                                                              | atomic start/fan-out/admission/settlement/gate/reconcile/cancel/terminal convergence on SQLite/PostgreSQL                            |
| Knowledge records                                            | Control API + canonical Domain Store                                       | Knowledge Library lists bounded memory/source records through the typed Control client               | receipt-first create, strict UTF-8/NFC/digest validation, tenant/space isolation and stable pagination                               |
| Office definitions and explicit target Runs                  | Control API + canonical Domain Store + canonical Run service               | Office Library lists immutable versions; execution remains an ordinary AgentVersion-pinned Run       | receipt-first version CAS, published AgentVersion references, scoped pagination and no Office-specific scheduler/runtime             |

The legacy JSON-RPC Goal notifications and pre-send Goal/Plan writes are not
part of these paths. When Control is configured but unavailable, Thread
authority fails closed instead of selecting the legacy client.

The 2026-08-13 resource cutover package was rebuilt with the official
redistributable Node 24 binary. Its application bundle contains only the GUI,
process guardian, Node runtime, and the Control/Worker/Release/provider-settings
TypeScript bundles. An isolated-HOME smoke reached Control readiness on port
3210 twice, never opened the legacy port 6176, and both GUI `SIGKILL` runs left
no supervised child process or listener behind. Updater signing/notarization is
still blocked only by the unavailable release private key.

The GUI-to-Worker stdin boundary now has one current envelope,
`crewon.worker-native-bootstrap.v4`. Standalone, selected Workspace, and private
MCP credential launches use the same exact shape with explicit nullable
`workspace` and `credentialBindings` fields; the `v1`/`v2`/`v3` readers and
emitters were deleted instead of retained as migration compatibility. A rebuilt
application completed the real packaged Workflow crash/restart smoke with one
Agent sample before the kill, one Verification sample after restart, one
canonical terminal event, and complete guardian cleanup. The updater artifact
was generated before the expected missing-signing-key failure.

The packaged home composer now derives execution targets and model choices only
from the active Control AgentVersion release. CrewON means the release default
single Agent; each additional target carries its exact `agentVersionId` and
immutable bound model. Empty or unavailable catalogs disable submission instead
of falling back to a fabricated model, Team, Agent Platform target, or legacy
App Server client.

The renderer source no longer contains the legacy App Server transport.
`AppServerClient`, its WebSocket principal-session bootstrap, the Backend
Workspace bridge, connection effects, event coordinators and runtime-authority
selectors were deleted. Active thread-list and timeout effects depend on small
named Control ports instead of borrowing App Server types. Unsupported product
entries were removed; there is no null-client compatibility composition left to
keep alive.

The default development entry point is also Control-only. `pnpm crewon:dev`
builds only the permitted process guardian, stages Node 24 and the TypeScript
runtime bundles, and launches Tauri. The legacy App Server supervisor, its 6176
restart loop, and the public `crewon:app-server` package script were deleted.

The production Settings composition now advertises only the three surfaces
with a real Control authority: Account, Appearance (`locale`/`theme`) and Model
providers. Unknown or historical Settings deep links resolve to Appearance,
unsupported fields fail closed, and the legacy Thread Settings button and
coordinator entry point are absent. Appearance changes use revisioned
`GET -> PUT` and update renderer preferences only after the Control commit.

Control Library reads are generation-fenced so an older request cannot replace
a newer panel. Automation details are re-read from Control before display, and
Office pagination uses the OpenAPI `cursor` parameter end to end. The obsolete
`before` query is rejected instead of accepted as a compatibility alias;
pagination is bounded to five pages/500 records and visibly reports truncation.

The Command Workspace capability drawer now exposes only two operations with a
real Control authority: bounded Workspace search and Git status. Review,
Terminal, Browser, Files, Apps/Plugins and Side Chat launchers were removed
instead of retaining warning-only or no-op callbacks. The generic pushed-panel
surface remains available for actionable Control requests, but rejects legacy
terminal panels and no longer advertises an App Server tool launcher.

The renderer also has one Workspace UI authority rather than a
`control | legacy` selector. Historical `?view=office` links are no longer
rewritten into the Team shell, no local `cwd` is injected into new threads, and
the old Workspace handler, workbench browser/files/review/terminal surfaces,
terminal action dispatcher and terminal state/output chain have been deleted.
Three unused Agent Platform App Server RPCs (`auth`, `agent/info` and
`workflow/execute`) were removed with their compatibility-only tests.

Import-graph deletion then removed the remaining unreachable renderer
subtrees: legacy notification and server-request handling, provider resources,
Settings refresh adapters, App Library/Domain handlers, the old Domain and
Office runtime, Activity Board, browser/file/review/terminal workbench surfaces,
and their compatibility-only tests. The canonical Control Office room, Control
Library, Workflow UI and Workspace read-only tools remain. Across this cutover
stage, roughly 190 files changed and more than 49,000 lines of unreachable
compatibility source and tests were deleted.

The remaining Experts compatibility surface was then removed from the active
Team workspace. Team now exposes only Control Office and Control Workflow; it
does not query registered legacy workspaces, read or create Experts records, or
serialize `experts:*` into Thread scene settings. Composer execution targets
group real durable definitions as single Agent or Team, and the old Experts
dialog, cards, DTO, styles, tests and snapshots were deleted rather than
adapted.

The Command shell cutover is now structural rather than a production flag. Its
public component contract no longer accepts `workspaceAuthority`, renderer cwd,
`executionTargetClient` or `scheduleClient`; new tasks cross only the Control
thread boundary and native Workspace selection crosses only the typed desktop
authority. The legacy folder roster/picker tree, Agent Platform execution-target
adapter, personal Schedule implementation, Office creation fallback and their
compatibility tests were deleted. The visible sidebar is a single Control task
tree, and no hidden Schedule route remains in the renderer.

A fresh renderer build and the Tauri bundle manifest are now guarded together:
the production bundle contains no `AppServerClient`, WebSocket/6176 transport,
Rust Device/App Server or Device Gateway marker, while the packaged executable
and resource allowlists contain only the process guardian, Node runtime and the
four TypeScript runtime bundles. The web manifest no longer describes the
product as an App Server client.

## Not migrated and deliberately unavailable under Control

| Capability family                                            | Current Control behavior                                                                                            | Required replacement before enabling                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| account identity, usage and remaining config                 | locale/theme settings are migrated; identity, usage and unsupported panels fail closed                              | typed account/config queries with an explicit durable owner                                            |
| terminal, shell and workspace watch                          | no packaged legacy connection or renderer launcher; the old terminal action/workbench source has been deleted       | bounded native TypeScript capability ports, cancellation and durable mutation receipts                 |
| MCP, plugins, skills, hooks, apps and external agents        | library shows no fabricated catalog and does not fall back                                                          | versioned catalogs plus reviewed Tool admission; mutation requires durable provider receipt/reconcile  |
| Agent Platform resources, expert teams and remote workspaces | external-resource/entitlement surfaces remain unavailable                                                           | scoped provider adapters with PIM identity/resource bindings                                           |
| Office expert delegation and automatic orchestration         | Office definitions are readable, but expert aliases, auto-dispatch, scheduler and memory handoff remain unavailable | an explicit product contract on top of canonical Workflow/Run authority; no legacy compatibility layer |
| Knowledge retrieval and lifecycle                            | bounded records are readable; delete/reset, ingestion, embedding and RAG remain unavailable                         | explicit retention/deletion receipts and a bounded retrieval authority                                 |

## Renderer compatibility deletion result

The legacy Rust app-server and Device binaries have already left the packaged
desktop runtime. They are not migration fallbacks or compatibility targets.
The renderer deletion gate is now closed:

1. Production composition and fresh bundle scans contain no App Server client,
   WebSocket transport, port 6176, Device or Gateway marker.
2. `apps/crewon-ui/src` contains no `app-server/appServer` import,
   `AppServerClient`, principal-session transport or `ws://app-server` endpoint.
3. Every advertised replacement uses its Control/Worker authority; unavailable
   capabilities have no launcher rather than a dormant compatibility handler.
4. Control/Worker/Native Runtime start and recover without the legacy process or
   database, and W01 transaction acceptance remains the authority for enabled
   Workflow mutations.

Release signing, notarization and platform canaries remain release gates, but
they are not Rust Runtime compatibility work and did not block this source
deletion. Packaged Control paths never start or select the Rust app-server.
