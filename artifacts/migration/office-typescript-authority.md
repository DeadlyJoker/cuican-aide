# Office TypeScript authority and contract

## Scope

Office is a tenant/space-scoped control-plane definition. It is not an execution
engine, scheduler, expert compatibility layer, or handoff mechanism. An Office
start resolves one immutable execution target and delegates to the existing
canonical Thread/Run application services. The resulting Run remains the sole
execution projection and authority.

## Authority

- `OfficeDefinitionStore` is the only Office authority and is part of the same
  `DomainStore` implemented by SQLite and PostgreSQL.
- An Office has a stable `officeId` and immutable, monotonically increasing
  versions. A version contains a bounded title, bounded members, and bounded
  execution targets.
- Every member and execution target references an existing published
  `AgentVersion`. Office never copies an Agent definition or mutable deployment.
- Creation is receipt-first. `(tenantId, spaceId, actorId, idempotencyKey)` maps
  to one request digest and result. Replays return that result; digest mismatch
  is a conflict.
- Creating the next version uses compare-and-swap against the latest Office
  revision. The first version expects revision zero.
- Reads and list cursors are tenant/space scoped. Limits, strings, collections,
  request bodies, and cursor components have hard bounds.

## Control contract

- `POST /api/v1/offices` creates an immutable Office version and requires an
  idempotency key plus `expectedRevision`.
- `GET /api/v1/offices/:officeVersionId` reads one version.
- `GET /api/v1/offices?limit=&before=` lists versions with stable pagination.
- `POST /api/v1/offices/:officeVersionId:runs` starts the selected target through
  the existing canonical Run service. It does not enqueue Office-specific work.
- The request does not atomically persist an Office-to-Run provenance binding in
  this slice. The returned canonical Run identifies its AgentVersion and Thread;
  durable Office provenance is an explicitly uncovered future contract.
- All operations resolve the authenticated actor first and authorize an
  Office-scoped action before touching authoritative state.

## Deliberate exclusions

No legacy Rust compatibility, auto-dispatch, timers, scheduler, expert aliases,
in-memory handoff, or Office-specific Run state is introduced. The first slice
selects one target explicitly; orchestration across targets is future work.
