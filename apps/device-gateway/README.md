# CrewON Device Gateway

This process boundary terminates outbound Device WebSocket connections. It owns
authenticated connection state, Device protocol validation, lease fencing,
sequenced receipt acknowledgement, bounded output, cancellation forwarding,
disconnect-to-unknown-outcome conversion and Gateway-local dispatch
idempotency. It does not own Run state, approval, Worker retry decisions, model
calls or workspace paths.

`DeviceIdentityVerifierPort` must return an identity already authenticated by
mTLS or a registered device-key challenge. The production entrypoint uses TLS
1.3 with mandatory client certificates, then maps the verified SHA-256
certificate fingerprint through a strict local registry. A Hello frame is still
checked against that independent identity. Header-only identity and anonymous
WebSocket connections are test fixtures, not production authentication.

Required production environment:

- `CREWON_DEVICE_GATEWAY_TLS_KEY_PATH`
- `CREWON_DEVICE_GATEWAY_TLS_CERT_PATH`
- `CREWON_DEVICE_GATEWAY_TLS_CA_PATH`
- `CREWON_DEVICE_REGISTRY_PATH`
- Standalone Tool-only: `CREWON_DEVICE_GATEWAY_DATABASE_PATH`
- Standalone local Workspace: `CREWON_DEVICE_GATEWAY_DATABASE_PATH` and the
  explicit `CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID`
- Team: `CREWON_DEVICE_GATEWAY_DATABASE_URL`, `CREWON_DEVICE_GATEWAY_ID`,
  `CREWON_DEVICE_GATEWAY_PEER_TLS_KEY_PATH` and
  `CREWON_DEVICE_GATEWAY_PEER_TLS_CERT_PATH`

Exactly one database setting is required; dual configuration fails closed and
never falls back. Team may set `CREWON_DEVICE_GATEWAY_DATABASE_SCHEMA`
(default `crewon_device_gateway`) and
`CREWON_DEVICE_CONNECTION_LEASE_MS` (default 30000). The PostgreSQL authority
must migrate successfully before the listener opens.

The local Workspace Gateway ID is a single-process SQLite route identity. It
causes Device Hello to receive a fenced welcome/epoch and lets Workspace
accepted events validate against the same SQLite authority. It never enables
Gateway peer ingress or egress and must not be used as a multi-Gateway or Team
substitute. Without that explicit ID, the historical Standalone Tool path is
unchanged and Workspace dispatch remains unavailable.

The registry is `crewon.device-registry.v0`. `devices`, `workers` and optional
`gateways` contain role-separated identities with unique IDs, credentials and
uppercase colon-separated `fingerprint256` fields; one credential or
certificate cannot occupy multiple roles. Every Team Gateway must have a
registered HTTPS origin-only endpoint and the local `CREWON_DEVICE_GATEWAY_ID`
must identify one of those entries. `commandSigningKeys` contains unique
Control Plane `keyId` and Ed25519 public-key PEM fields. Private signing keys
must never enter the Gateway registry. The default listener is
`127.0.0.1:8443`; Team deployment must explicitly set the host and separately
authorize `wss://.../device/v1` for Devices,
`POST /worker/v1/device-dispatch` for Runtime Workers and
`POST /gateway/v1/device-dispatch` only for registered Gateway peers.

Every command carries a canonical Ed25519 authorization envelope. The Gateway
checks the registered key, issued/expiry window, signature, lease and optional
digest-bound Approval proof before forwarding. The Rust protocol boundary uses
the same canonical payload digest and verifies post-signing mutation with
`ed25519-dalek`.

The production entrypoint exposes a role-authenticated TLS 1.3 Worker API and a
separate mTLS Device WebSocket. Before sending a Device command, it persists a
stable action fingerprint in a dedicated SQLite authority. Renewed Worker
leases single-flight to the same action; terminal receipts replay after Gateway
restart. A crash after `prepared` but before a provable terminal result stays
non-terminal and returns `unknownOutcome`; it is not written as a durable
terminal receipt. A later authenticated Device session may resume that exact
stored command only when its Hello explicitly advertises the execution in
`lastAcknowledged` and the original lease and command authorization are still
valid. The Gateway sends the original command with the same execution and
idempotency identity, and the Device must attach to the existing side effect
and replay events from sequence 1. Hello omission, expired authority or an
identity mismatch remains unknown and never dispatches.

The real loopback vertical test covers mTLS Worker HTTPS, mTLS Device WSS,
sequence ACK, terminal persistence, Gateway shutdown, database reopen and
receipt reconciliation without a connected Device. It also covers an accepted
side effect disconnecting, Gateway process restart, explicit Hello
acknowledgement, replay without a second side-effect start, cancel recovery and
terminal persistence. This is bounded single-Gateway recovery under the
original lease/authorization, not replica failover. Remaining production gates
are renewed authority for long outages, dynamic registration and certificate
rotation, HSM/KMS command signing, retention/backup operations, cross-host
partition drills and the complete native `crewon-device` runtime.

The Team PostgreSQL schema now shares immutable execution identity, terminal
receipts and a leased Device connection route. Every authenticated connection
atomically advances `gatewayId + connectionId + epoch`; an old Gateway cannot
renew or release a newer route, and its heartbeat closes the stale WebSocket.
Worker dispatch uses a fenced router that rechecks the current route at the
target Gateway. The production Team entrypoint now forwards a non-owner request
over TLS 1.3 mutual authentication using an independent Gateway role, a strict
bounded single-hop contract and static HTTPS peer endpoints. The target
rechecks the complete route fence before touching its Device session; stale or
unreachable routes remain retryable and never fall back to a local stale
session.

After route claim, the Gateway sends a strict `crewon.device-welcome.v0` frame
containing `gatewayId`, `connectionId`, `connectionEpoch` and lease expiry
before accepting commands on the session. TypeScript and Rust parse this frame
from the same conformance fixture. The new minimal `crewon-device` crate accepts
bounded raw frames, verifies a rotating Ed25519 PEM key registry, persists
strictly increasing epochs and exposes a linearization permit that rejects an
older socket before native side-effect start. That component is not yet wired
into a production WSS/UDS capability dispatcher.

A local PostgreSQL fault-injection test starts two independent Gateway OS
processes, kills the Device owner after `execution.accepted`, deterministically
expires its route and proves takeover reconciliation and cancellation without a
second side-effect start. It uses test transport identities, a fake command
authorizer and a WebSocket Device simulator, so it does not prove the complete
Native or production deployment. Until that wiring and three-platform
execution land, the implementation is not claimed as complete multi-Gateway
HA. The full invariant and evidence boundary is recorded in
`artifacts/migration/device-gateway-ha.md`.

The wire shapes and fail-closed parser codes are shared with the narrow Rust
`crewon-device-protocol` crate through
`packages/test-contracts/fixtures/device-protocol.reference.json`. That crate is
an execution-boundary dependency only; it must never import product domain,
model, database, or orchestration logic.
