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

This slice is not yet a runnable Device sidecar. WSS/UDS transport,
process/PTY/filesystem capability dispatch, durable receipts, installation and
three-platform security tests remain separate migration gates.
