# CrewON Native Device Runtime

This crate is the approved minimal Rust execution boundary. It must not own or
import CrewON Agent, Thread, Run, Workflow, Store, Provider, MCP or UI logic.

The first extracted component is `ConnectionEpochFence`. It persists every
accepted higher epoch as an append-only private state record, synchronizes it
before returning, and rejects rollback after process restart.
`NativeDeviceConnection` now accepts bounded raw welcome/command frames,
strictly parses the shared protocol, maps a bounded rotating PEM key registry,
verifies Ed25519 authorization and checks expiry again at the final start
boundary. Capability code can inspect a `VerifiedDeviceCommand`, but the native
side effect can only start while `ConnectionEpochPermit` is held. A Gateway
takeover between verification and start therefore rejects the old socket.

The unconnected filesystem read primitive accepts only canonical
workspace-relative components, traverses Unix directories with no-follow
handles, reads regular UTF-8 files under hard byte/output caps and between-call
deadline checks, and rechecks workspace incarnation after execution. Its
independent strict accepted/terminal/ACK wire and SQLite restart-replay journal
are now durable, but it remains absent from Device Hello and the runtime frame
router. The Native handle adapter, takeover barrier and reconnect projection
must be wired before `workspace.read_file.v0` can be advertised. A supervised strict wall-clock
boundary and Windows handle-relative traversal also remain unavailable. Its
next Native connection adapter must acquire stable handles under the epoch
permit, release that permit before any blocking read, then recheck command time,
epoch and workspace incarnation; a deterministic takeover barrier test is
required before that adapter is exposed.

Process/PTY dispatch, installation and three-platform security tests remain
separate migration gates.
