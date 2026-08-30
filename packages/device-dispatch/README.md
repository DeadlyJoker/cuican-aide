# CrewON Device Dispatch

`@crewon/device-dispatch` is the Worker-side boundary between durable Tool execution and the separate Device Gateway process. It
does not import a Gateway session, own Run state, execute native operations, or store credentials in an AgentVersion/runtime
manifest.

`DeviceToolRuntime` validates the complete Tool command, exact policy, Action Digest, Approval proof and renewed Work Item lease.
It resolves the configured Device binding, converts function JSON or custom text into a bounded Device command, requires a signer
to return the same semantic command, and keeps `execute`, `reconcile` and `cancel` as separate remote operations. Tool
idempotency keys are mapped to a stable `device:<action-sha256>` opaque wire key rather than weakening the Device protocol to
accept path separators.

`Ed25519DeviceCommandSigner` is an open Node implementation. It accepts an Ed25519 private `KeyObject` or private-key input,
limits authorization lifetime to both the configured short TTL and durable lease expiry, signs the canonical shared payload and
rejects expired leases or non-Ed25519 keys. The private key is never serialized into the command, runtime manifest or Gateway
public-key registry. A production HSM/KMS implementation can replace the signer through the same port.

`HttpsDeviceDispatchClient` implements the authenticated Worker boundary using Node HTTPS, mandatory trust roots, client
certificate/key material, TLS 1.3, bounded response bodies and the shared strict request/response/error contract. It rejects HTTP,
credential-bearing URLs, operation drift and malformed remote errors. Runtime Worker loads it only through an explicit bounded
`crewon.device-tool-runtime.v0` deployment that binds definitions, policies, Device IDs, mTLS files and the signing key path; Device
mutations require `perAction` approval.

Gateway SQLite terminal replay is implemented, but active execution reconnect, multi-Gateway shared authority, HSM/KMS key custody
and native Device execution remain separate gates. Production must keep a Device Tool absent unless the complete explicit config and
a compatible authenticated Device are deployed.
