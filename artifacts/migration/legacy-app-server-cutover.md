# Legacy app-server runtime cutover

This matrix records the production authority after the TypeScript Control
cutover. It distinguishes removing the legacy Rust **app-server process** from
removing Rust that belongs at the native device boundary. A failed Control path
must never silently fall back to the legacy authority.

## Normal product runtime

| Capability | Current authority | Runtime evidence |
| --- | --- | --- |
| Thread list/read/create/fork/archive/rename/delete | Control API + Domain Store | The renderer selects `ControlThreadRuntime` only and fails closed while Control is unavailable. |
| Turn admission, streaming and Run lifecycle | Control API + Runtime Worker | One atomic `startTurn`, Run SSE, durable refresh and restart recovery. |
| Goal, Plan, compaction and rollback | Control API + Runtime Worker | Goal/event cursors, terminal Plan message, maintenance Run and append-only rollback projection. |
| Teams, Workflow, Office and automation schedules | Control API + Runtime Worker | Versioned Control projections and Control-owned scheduled Runs; the renderer does not select the legacy scheduler. |
| PIM account resources, knowledge, tools and experts | PIM platform adapters | Reads are scoped to the authenticated platform account and fail closed when the platform session is absent. |
| Web files, diff and terminal | PIM workspace sandbox | Bounded Control sandbox operations rooted at `/workspace`. |
| Desktop files, diff and terminal | Tauri native workspace adapter | Operations use the selected durable workspace authority, canonical path containment, bounded previews/output and command timeout. |
| Desktop Provider secret | OS credential store through `keyring` | Secret material is injected only into the supervised Worker environment. |

## Removed from normal startup and packaging

- `crewon-app-server` is no longer listed in Tauri `externalBin`.
- The desktop shell no longer contains an app-server spawn or run-event path.
- The desktop staging script no longer builds, copies or verifies the
  `crewon-app-server` binary.
- The renderer disables the legacy WebSocket connection effect and has no
  legacy Thread/model/workspace fallback authority.
- Local development starts Control, Runtime Worker, Device Gateway and the
  native device boundary without opening port 6176.

Compatibility client modules and migration utilities may remain in the source
tree while they are mechanically retired. They are not a production runtime
dependency and cannot be selected by the normal application composition. Their
continued source cleanup must preserve import provenance and does not justify
bringing back a dual-authority fallback.

## Intentionally retained native boundary

The desktop package still contains Rust for Tauri window integration, OS
credential access, durable workspace selection and the constrained native
device/guardian executables. These are OS/device primitives, not the legacy
business app-server. Control, domain orchestration, teams, workflows,
automation, scheduling and agent execution remain TypeScript-owned.

## Release gate

Every release after this cutover must prove all of the following:

1. Source/composition tests show that the normal renderer cannot enable the
   legacy connection or select a legacy business authority.
2. The staged desktop package contains no `crewon-app-server`, and a local Run
   completes with no listener or process on port 6176.
3. Desktop files, diff and terminal stay inside the bound workspace; Web uses
   the authenticated PIM sandbox. Both paths enforce bounded reads/output and
   fail closed when their workspace authority is unavailable.
4. Threads, long-running Agent work, team collaboration and schedules execute
   through Control and recover through the same Run/Step/Attempt records.
5. The deployed Web build passes authenticated PIM resource and workspace
   capability checks; the desktop build passes its native workspace checks.
