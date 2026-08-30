# CrewON Control API

TypeScript Control API composition root. It binds only to `127.0.0.1` and persists Thread, Message, Run, Approval, immutable
AgentVersion and manual-only Automation authority through the application ports. Standalone derives one Actor/Tenant/Space from trusted local
configuration and uses SQLite or PostgreSQL. Team/Cloud uses the production PostgreSQL composition, derives a request-scoped
Actor from a verified short-lived user Control token, and authorizes every operation through the external policy authority.

## Required configuration

Copy values from `.env.example` into the process environment. The server does not load `.env` files and refuses to start if the
selected security/database configuration is absent. Never commit real secret values.

`CREWON_CONTROL_SECURITY_MODE=standalone` is the default local mode. It requires the session token, CSRF token and allowed
origin list documented below. Session and CSRF values must be distinct random values of at least 32 bytes. Set
`CREWON_CONTROL_DATABASE_URL` and an optional `CREWON_CONTROL_DATABASE_SCHEMA` for standalone PostgreSQL; otherwise
`CREWON_CONTROL_DB_PATH` is required.

`CREWON_CONTROL_SECURITY_MODE=production` requires PostgreSQL plus all of the following production authorities:

- `CREWON_CONTROL_BFF_TOKEN`, `CREWON_BFF_ALLOWED_ORIGINS`, and `CREWON_BFF_ALLOWED_REMOTE_ADDRESSES` authenticate the direct
  BFF service credential, exact public Origin asserted by the BFF, and direct socket peer independently from the user token.
- `CREWON_IDENTITY_VERIFY_URL`, `CREWON_IDENTITY_SERVICE_TOKEN`, `CREWON_IDENTITY_EXPECTED_ISSUER`, and
  `CREWON_IDENTITY_EXPECTED_AUDIENCE` configure the trusted HTTPS token-verification authority. Its strict response derives
  `principalId`, `actorId`, `tenantId`, and `spaceId`; no request header can supply those values.
- `CREWON_POLICY_DECISION_URL` and `CREWON_POLICY_SERVICE_TOKEN` configure the dynamic HTTPS PIM/policy authority.
- `CREWON_SECURITY_AUTHORITY_TIMEOUT_MS` bounds both authorities. `CREWON_IDENTITY_CACHE_TTL_MS` is zero by default and capped
  at 30 seconds; `CREWON_IDENTITY_CACHE_MAX_ENTRIES` is also bounded. Authorization decisions are not cached.

The browser session and browser CSRF check belong to the Web BFF. On every proxied request, Control separately requires
`Authorization: Bearer <short-lived user control token>` and
`X-CrewON-BFF-Authorization: Bearer <CREWON_CONTROL_BFF_TOKEN>`. It also checks the exact configured direct peer and Origin,
and rejects Principal/Actor/Tenant/Space headers rather than trusting browser-derived identity. Missing configuration,
transport failures, timeouts, malformed assertions, issuer/audience/expiry mismatch, cross-scope resources and malformed policy
decisions all fail closed.

The identity verifier must return HTTP 200 with a JSON body no larger than 16 KiB and exactly these fields (no additional
fields):

```json
{
  "issuer": "https://identity.example",
  "audience": ["crewon-control"],
  "principalId": "principal-1",
  "actorId": "actor-1",
  "tenantId": "tenant-1",
  "spaceId": "space-1",
  "issuedAt": "2026-08-09T00:00:00.000Z",
  "expiresAt": "2026-08-09T00:05:00.000Z"
}
```

The policy authority receives the complete Actor/action/resource tuple and returns exactly `{ "outcome": "allow" }` or
`{ "outcome": "deny", "reasonCode": "bounded_machine_code" }`. Both authority URLs must use HTTPS, redirects are rejected,
responses are size-bounded, and authority service credentials are distinct from the BFF credential and user token.

Artifact authority is also mandatory for this process. Set `CREWON_ARTIFACT_ROOT`, `CREWON_ARTIFACT_DB_PATH`,
`CREWON_ARTIFACT_ENCRYPTION_KEY_PATH`, and `CREWON_ARTIFACT_ENCRYPTION_KEY_ID`. The key file must contain exactly 32 raw bytes or
their canonical base64 encoding and, on Unix, must not be group/world accessible. The Control API and every Runtime Worker in a
Standalone deployment must use the same metadata database, blob root, key file, and key ID. This filesystem adapter is a
single-host authority; using it with PostgreSQL does not establish multi-host HA. Team/Cloud still requires the planned shared
S3-compatible store plus external KMS adapter.

For a local key file outside the repository:

```bash
umask 077
openssl rand 32 > /absolute/path/to/crewon-artifact.key
```

Default and explicitly selected AgentVersions are admitted only through the immutable `AgentVersionDeployment` record in the
shared SQLite/PostgreSQL Domain Store. Run `pnpm --filter @crewon/runtime-worker release` with the reviewed release environment
before starting Control or Workers. That separate process compiles and activates the bootstrap asset and runtime-binding
manifest; Worker construction performs only exact read-side verification. The Control API receives only the default
`CREWON_AGENT_VERSION_ID` in standalone mode and derives authority, runtime generation, policy and workspace from the durable
asset plus the active release bundle. Production mode instead resolves each verified tenant's default from that tenant's active
release and never assumes a process-wide Actor or tenant. Neither the bundle nor its activation audit contains a Provider
credential value:

```json
{
  "bundle": {
    "schemaVersion": "crewon.agent-version-release-bundle.v0",
    "tenantId": "standalone-tenant",
    "releaseId": "sha256:<canonical manifest digest>",
    "manifestDigest": "sha256:<same canonical manifest digest>",
    "defaultAgentVersionId": "reviewed-agent-v1",
    "deployments": [
      {
        "schemaVersion": "crewon.agent-version-deployment.v0",
        "tenantId": "standalone-tenant",
        "agentVersionId": "reviewed-agent-v1",
        "contentDigest": "sha256:<64 lowercase hex characters>",
        "materializationDigest": "sha256:<64 lowercase hex characters>",
        "authorityId": "standalone-authority",
        "workspaceBindingId": null
      }
    ]
  },
  "activation": {
    "schemaVersion": "crewon.agent-version-release-activation.v0",
    "tenantId": "standalone-tenant",
    "releaseId": "sha256:<canonical manifest digest>",
    "activationId": "<idempotency identity>",
    "previousReleaseId": null,
    "operator": {
      "principalId": "release-principal",
      "actorId": "release-actor",
      "spaceId": "standalone-space"
    },
    "activatedAt": "2026-08-10T00:00:00Z"
  }
}
```

Release activation is authorized, audited, idempotent and atomic across every version in the bundle; a database failure cannot
leave a partial bundle active. Concurrent activations use a CAS on the prior active release. Any attempt to rebind the same
tenant/version fails closed. A published version outside the active bundle remains discoverable but cannot create a new Run; the
API returns `agent_version_not_admitted`. Omitting `agentVersionId` selects the bundle's configured default ID and performs the
same admission. Standalone `/api/v1/health/ready` requires its configured active default asset and digest; production readiness
checks shared storage without pretending one tenant's release represents every tenant. A rollback moves only the active pointer;
Workers may still load a registered historical bundle to recover Runs that were pinned before the rollback.

```bash
pnpm --filter @crewon/control-api start
```

Standalone authenticated requests require:

```text
Authorization: Bearer <CREWON_CONTROL_SESSION_TOKEN>
Origin: <one configured CREWON_CONTROL_ALLOWED_ORIGINS value>
X-CSRF-Token: <CREWON_CONTROL_CSRF_TOKEN>   # mutations
Idempotency-Key: <unique semantic command key> # mutations
```

`POST /api/v1/threads/{threadId}:rollback` requires both mutation headers and the exact JSON body
`{"expectedRevision": <positive integer>, "numTurns": <1..4294967295>}`. The server derives Actor, tenancy and the durable
rollback identifiers; none are client inputs. A newly committed append-only rollback returns `201`, while the same semantic
idempotency key returns the original safe Thread projection with `200`. Active Run/Work Item, stale Thread revision and Model
History CAS conflicts return `409`; cross-tenant and cross-space Threads remain `404`. The response is the ordinary
`ThreadMutationResponse` and never contains marker IDs, raw history boundaries, invalidated Message details or actor identity.

Automation is exposed only as immutable `manualOnly` v0 definitions:

- `POST /api/v1/automations` creates a definition against an exact active Thread revision; `GET /api/v1/automations` and
  `GET /api/v1/automations/{automationId}` return its redacted view.
- `POST /api/v1/automations/{automationId}:run-now` requires the exact Automation and Thread revisions and atomically commits
  the canonical Automation-origin Message, Model History item, Run, Outbox, Work Item and receipt before returning that Run.
- Mutation requests require CSRF plus `Idempotency-Key`; retries use the same key. Public views always report
  `executionMode: "manualOnly"` and `automaticScheduling: false`. Tenant, actor, stored schedule metadata, definition/content/
  route digests, invocation binding and Run route are never projected.

There is no public scheduler, due/claim endpoint, enable toggle or automatic execution path. Clients correlate the Run returned
by `run-now` and attach its normal Run SSE; they must not reinterpret every Run on the Automation's Thread as an Automation Run.

`GET /api/v1/model-provider-settings` returns the authorized non-secret catalog snapshot: revision, active Provider, safe
binding metadata, update time, and one explicit runtime availability state. It never returns a runtime binding/coordinator ID,
operation record, tenant identity, credential, or Worker route. `POST /api/v1/model-provider-settings/probe` requires CSRF and
`Idempotency-Key`, accepts only `{}`, and probes the active binding through the private Control-to-Worker `/models` chain. A
same-key retry recovers the bounded public result without issuing another Provider request while the process-local replay entry
is live. The packaged standalone runtime supplies the fixed loopback Worker origin and a distinct memory-only service token via
`CREWON_PROVIDER_PROBE_WORKER_ORIGIN` and `CREWON_PROVIDER_PROBE_WORKER_TOKEN`; neither value is a browser credential. Public
Team probing remains unavailable until the production coordinator, tenant-approved egress policy, and authenticated Worker
transport are deployed together. There is no public Provider mutation route: desktop credentials and two-phase switching stay
behind typed native Tauri commands.

Production BFF-to-Control requests require the two independent bearer credentials described above. The BFF consumes browser
CSRF; Control does not accept a browser Actor header or substitute the BFF service credential for the user Control token.

## Current evidence boundary

- Real loopback HTTP and real SQLite reopen cover Thread create/get, text Message append/list with an opaque cursor, Run
  create/get/cancel, Tool Approval query/decision, live SSE and sequence catch-up without sleeps.
- SSE uses the decimal Run sequence as its `id`; a reconnect sends that value in `Last-Event-ID`. The default `view=client`
  suppresses only bounded pre-budget WebSocket retry noise; `view=audit` exposes every durable Run event. Hidden client events
  still advance the server cursor and are never deleted from Store authority. Provider-continuation events appear in both views
  with only bounded coordination metadata (`segmentId`, `sampleIndex` and `throughHistorySequence`); internal segment sequence
  bookkeeping is omitted.
- `GET /api/v1/threads/{threadId}/goal/events` uses the independent decimal Thread Goal event sequence as its SSE `id` and
  accepts that sequence in `Last-Event-ID`. It first catches up from the authorized tenant/thread database log, then polls that
  log periodically; it does not depend on the Run Outbox or in-process Run event hub. A `goal.cleared` event is not terminal, so
  the same stream can later deliver a new Goal beginning at revision 1 while the Goal event sequence continues monotonically.
- `GET /api/v1/threads/{threadId}/goal` returns `{goal,eventSequence}` from one Store read point. The client attaches the Goal
  event stream with that `eventSequence` as `Last-Event-ID`, including when `goal` is null after a clear.
- Public projections omit internal identity/routing/policy/workspace and Message digest details. A public Message append is
  always assigned the `user` role server-side. Approval responses also omit the Action digest, policy snapshot, workspace,
  resource and credential bindings.
- `GET /api/v1/artifacts/{artifactId}` returns authorized immutable metadata without tenant/space/owner, encryption key ID,
  scanner implementation or storage path. `GET /api/v1/artifacts/{artifactId}/content` decrypts and authenticates AES-256-GCM,
  rechecks size/SHA-256, and returns bytes with an immutable digest ETag. Cross-space reads are hidden as not found.
- `GET /api/v1/tool-approvals/{approvalId}` reads the current tenant/space-scoped decision state.
  `POST /api/v1/tool-approvals/{approvalId}:decide` accepts only `approved` or `rejected`, an expected Approval revision and a
  bounded optional comment. The decision, Run resume and held Work Item wake-up are one Store transaction; approval does not
  weaken the Tool ActionIntent or replace Worker-side revalidation.
- Thread/Message commands atomically write snapshot, event, content and idempotency receipt. Run creation additionally requires
  an active same-tenant/same-space Thread and atomically writes its strong binding, event, snapshot, Outbox message and initial
  Work Item. The Outbox dispatcher
  claims with an owner/lease/epoch fence, publishes the referenced committed event to the in-process SSE hub, then acknowledges
  delivery; expired claims are reclaimable after restart and the periodic database scan is the cross-process correctness path.
- Thread rollback appends one correlated Thread event and Model History marker while atomically invalidating rolled-back public
  Messages, Provider continuations and model state. It never rewrites raw history or changes the Thread Goal. Standard reads hide
  invalidated Messages; audit reads retain physical Message sequence and attach only the bounded invalidation projection.
- A separate TypeScript Runtime Worker process now completes deterministic text Runs through the same SQLite authority. Its
  committed Agent events arrive through Outbox live SSE, and `Last-Event-ID` still reads the durable sequence after reconnect.
- AgentVersion publish/get/list is tenant-scoped and immutable. A selected Run resolves the durable definition, recomputes its
  source digest, checks exact deployment admission, and derives runtime/model policy fields server-side; clients cannot inject
  authority, policy, workspace or runtime generation.
- PostgreSQL uses database-time leases and `FOR UPDATE SKIP LOCKED`; Store conformance, two-Worker competition and post-SIGKILL
  reclaim are covered in an isolated PostgreSQL 15 environment. This is not evidence for cross-host partitions, backup/restore,
  staging SLOs or production readiness.
- `@crewon/control-client` provides typed Thread/Message/Run/AgentVersion/Approval/Artifact methods over generated contract
  types, a bounded digest-verifying Artifact download, and a bounded fetch-based SSE reader. It never exposes a generic
  authenticated fetch surface. CrewON UI has not switched to this client yet.
- Direct Responses HTTP/SSE and optional WebSocket transport are implemented in the Worker. Read-only stdio MCP exists; signed
  Device dispatch/native execution and mutation MCP receipt/reconcile remain closed.
- This app is not connected to the existing CrewON UI or production traffic yet.
