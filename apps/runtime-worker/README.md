# CrewON Runtime Worker

Standalone TypeScript execution process for durable `run.execute` Work Items. It opens the same Standalone SQLite authority as
the Control API, claims work with an owner/lease/epoch fence, reloads the canonical Run, Thread and Model History, revalidates the pinned route
and policy snapshot, then runs one bounded CrewON Agent Kernel segment.

The default production composition is the SDK-free Direct Responses transport:

```bash
CREWON_CONTROL_DB_PATH=/absolute/path/to/crewon-control.sqlite3 \
CREWON_MODEL_ID=gpt-5.6 \
CREWON_MODEL_API_KEY=... \
pnpm --filter @crewon/runtime-worker release

CREWON_CONTROL_DB_PATH=/absolute/path/to/crewon-control.sqlite3 \
CREWON_MODEL_ID=gpt-5.6 \
CREWON_MODEL_API_KEY=... \
pnpm --filter @crewon/runtime-worker start
```

`release` is a separate process boundary: it compiles the immutable bootstrap AgentVersion and configured runtime bindings into
one canonical digest-addressed bundle, authorizes every `agentVersion:publish/deploy` decision, then commits the bundle, all new
Deployments, operator audit and tenant active pointer in one Store transaction without constructing a Worker. A caller may set
`CREWON_AGENT_VERSION_ACTIVATION_ID` and safely reuse it after an uncertain response; reuse returns `replayed` and never moves a
newer active pointer. Concurrent activations are serialized with an active-release CAS. `start` is read-only with respect to
release authority and requires its exact immutable bundle to have been registered, but the bundle may now be historical: this
lets a restarted Worker finish Runs pinned before a rollback while Control admits new Runs only from the active bundle.

Rollback does not recompile content or load Provider credentials:

```bash
CREWON_AGENT_VERSION_ROLLBACK_RELEASE_ID=sha256:<reviewed release digest> \
pnpm --filter @crewon/runtime-worker release:rollback
```

The rollback command records a new operator activation and atomically moves the active pointer to the existing bundle. Use
`CREWON_RELEASE_PRINCIPAL_ID` and `CREWON_RELEASE_ACTOR_ID` for the dedicated release identity; they default only for Standalone
development.

Production Tool execution also configures `CREWON_ARTIFACT_ROOT`, `CREWON_ARTIFACT_DB_PATH`,
`CREWON_ARTIFACT_ENCRYPTION_KEY_PATH`, and `CREWON_ARTIFACT_ENCRYPTION_KEY_ID` to the exact same Standalone authority used by the
Control API. All four variables must be present together. With none configured, text-only and bounded Tool outputs remain
available during migration, but a truncated output or Provider-supplied Artifact reference fails closed with
`artifact_authority_required`; raw output is never silently discarded. The key file format and single-host limitation are
documented in [`../control-api/README.md`](../control-api/README.md).

`CREWON_RESPONSES_ENDPOINT` defaults to `https://api.openai.com/v1/responses`. A self-hosted Responses-compatible endpoint can
be selected without `CREWON_MODEL_API_KEY`; credentials are therefore not a process startup dependency. Provider-side response
storage is disabled by default. `previous_response_id` continuation is allowed only when storage is explicitly enabled; the
Worker then promotes an SDK-free provider checkpoint in the same fenced transaction as the assistant Message and terminal Run.
After restart, it verifies the checkpoint identity and Model History boundary, sends only new canonical items, and supplies
`previous_response_id`. With storage disabled it continues to use complete manual history replay.

`CREWON_RESPONSES_REQUEST_PROFILE=responsesLite` explicitly selects the Rust-compatible Responses Lite request profile. It
adds `reasoning.context=all_turns` and forces `parallel_tool_calls=false` on every HTTP or WebSocket request. The default
`standard` profile omits both fields so self-hosted Responses-compatible endpoints are not required to implement an
OpenAI-specific profile. The profile is part of the transport adapter identity, so a profile change invalidates an older
Provider checkpoint and forces safe manual replay.

`CREWON_AGENT_INSTRUCTIONS` supplies the bounded instructions source. Before Store open or Provider prewarm, production
release compilation freezes instructions, transport/model identity, context window, compaction threshold, retry/Tool-round
policy, governed-context digest and ordered Tool definitions into a deeply immutable AgentVersion. The Kernel and Worker are
built only from that registry record. Deployments set `CREWON_AGENT_VERSION_CONTENT_DIGEST` to the reviewed compiler output;
reusing an ID after changing any compiled field fails release or Worker verification. The release process registers the
bootstrap version as a tenant-scoped durable asset before activation; Worker startup never creates or modifies that asset.
Instructions are limited to 32 KiB of UTF-8 and invalid values fail closed.

An optional `CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH` enables exact multi-version and multi-Provider routing. The bounded JSON
manifest maps `tenantId + agentVersionId + contentDigest` to an independent Direct Responses endpoint, credential environment
name, request profile, workspace binding and optional stdio MCP config. Raw API keys are rejected from the manifest. The release
compiler derives immutable `AgentVersionDeployment` candidates and their materialization digests without resolving Provider
credentials. Only the atomic release-bundle Store operation can create Deployment rows; the prior single-Deployment write API is
removed. The Worker resolves credentials only when building its runtime factory, reads the registered bundle and Deployment
records, and refuses startup or lazy materialization on missing content or content/materialization/authority/workspace drift.
The Control API reads only the tenant's active bundle; there is no second admission allowlist or static bootstrap route.
The digest covers the canonical bounded MCP/Device configuration content, not only its filesystem path, and is recomputed before
materialization. A Deployment also requires an existing same-tenant AgentVersion asset with the exact content digest.
See [`runtime-bindings.example.json`](./runtime-bindings.example.json); replace its zero digest with the compiler output and keep
the manifest free of raw credentials.

The bootstrap `CREWON_MODEL_*`, route and AgentVersion variables must be identical for `release` and `start`. The Control API
needs only `CREWON_AGENT_VERSION_ID` to select the default; authority, runtime generation, policy and workspace are derived from
the durable asset and Deployment. The runtime-binding manifest adds independently selected versions; it never makes
client-supplied Provider configuration authoritative.

`CREWON_RESPONSES_WEBSOCKET_ENABLED=true` enables the open, SDK-free WebSocket path. Startup prewarms the connection, sends the
Responses WebSocket beta header, reuses one authenticated connection across Turns, and sends only the new canonical suffix when the prior response is a
verified prefix. The default remains HTTP/SSE so self-hosted Responses-compatible endpoints do not need WebSocket support.
WebSocket transport failures get two reconnects by default (`CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES=2`); exhaustion or HTTP 426
emits a durable `model.transport.fallback` event and switches the Worker process to sticky HTTP. The fallback resets the
same-Turn sampling counter, so HTTP receives its own configured retry budget. A reconnect discards connection-local incremental
state and rebuilds from the complete canonical history retained in every request.

Before model sampling, `@crewon/context` builds a bounded provider-neutral projection. Clean history keeps the exact stable
prefix. Rust-compatible orphan/missing Tool-pair repair is content-free in diagnostics and forces manual replay, so a rewritten
projection never continues from an older provider checkpoint. Durable Store writes remain strict and cannot persist malformed
Tool pairing.

The Worker automatically compacts before sampling when either the bounded item threshold or UTF-8 byte threshold is reached.
Compaction is a Tool-free Kernel segment with its own durable Step/Attempt. Its summary, retained user messages, usage,
`context.compacted` Run event, Outbox records and Attempt completion commit atomically. A process restart reprojects the same
append-only history. Thread forks copy a fenced canonical prefix, retain compaction semantics and lineage, and intentionally start
without the source Thread's provider checkpoint; the first fork Turn therefore rebuilds manually before establishing its own
continuation.

The Worker also performs Rust-compatible mid-Run compaction after a completed Tool round when the latest provider usage reaches
`CREWON_AUTO_COMPACT_AT_TOKENS` (default `200000`). The high-token Model Attempt and Tool receipt remain durable, compaction gets
its own Step/Attempt and `context.compacted` event, and sampling then continues inside the same Run. A committed compaction resets
the token trigger, allowing multiple bounded Tool/compact rounds without repeatedly firing on stale usage. This interim threshold
must move into the immutable AgentVersion model policy before production cutover.

Every terminal text completion atomically replaces the Thread's `ThreadModelState` together with Run/Thread events, assistant
Message, canonical Model History, Attempt, Outbox and Work Item settlement. The state records AgentVersion and transport identity,
context window, compact threshold, latest usage, history boundary and context revision. When a later Run selects a smaller model
and the prior usage exceeds the new threshold, the Worker resolves the prior immutable AgentVersion compactor, summarizes only
the old history prefix with the previous model, preserves the already-appended incoming user Message, and then samples the new
model. Missing prior runtime resolution fails the Run closed; it never silently samples an over-budget smaller model. A durable
prefix-compaction boundary suppresses duplicate compaction after Worker restart.

Model-visible resource and provider data can only enter through a validated `GovernedContextBundle`. Every fragment binds an
audience, provenance, trust, sensitivity, purpose, freshness, token hard cap and SHA-256 content/source digest. Trusted
application fragments use the Responses `developer` role; Provider/User/Memory/Tool/Web content remains the `user` role and
cannot promote itself by embedding instructions. Each fragment is capped at 10K tokens using a conservative escaped UTF-8 byte
bound independent of the Provider tokenizer; secrets fail closed, XML
boundaries are escaped, and the immutable ordered prefix remains stable across Tool rounds. The bundle consumes the same global
item/byte budget as canonical history and compaction never persists it as conversational history.

If a compaction request receives the Rust-compatible `context_length_exceeded` provider failure, the compactor removes exactly
one oldest history item and immediately retries within that same durable Compaction Attempt. The synthesized compaction prompt
remains the final item on every request. A context-window failure with no removable history fails closed; no partial summary or
compaction Authority is committed.

`CREWON_MODEL_ADAPTER=deterministic-fake` remains available only as deterministic correctness infrastructure. It requires
`CREWON_FAKE_EXPECTED_USER_MESSAGE` and `CREWON_FAKE_RESPONSE`.

`CREWON_RESPONSES_STREAM_MAX_RETRIES` defaults to `5`, matching the Rust runtime's default. An early close or retryable
transport failure is retried inside the same Agent segment and durable Attempt. Each retry emits a bounded
`model.sampling.retry` progress event. If a failed sample already emitted text, `discardedOutput: true` resets the replay
projection before the next sample, so the durable audit retains the partial delta while the terminal assistant Message contains
only the successful sample. This maps Rust's unfinished partial item into an explicit replay-safe CrewON event.

Tool execution is injected through `ToolRuntimePort`. The Kernel performs one model sample and returns at a structured function
or custom Tool boundary; it has no execution method. The Worker creates an independent Tool Step/Attempt, persists a
digest-bound Receipt before dispatch, calls `execute` or `reconcile`, commits results in model call order, and then starts the
next model segment from canonical Model History. Parallel-safe calls execute concurrently while their durable commits remain
ordered. An unprovable mutation moves the Run to `reconciling` and is never automatically re-executed. A cancellation appends an
error Tool result plus the Rust-compatible `<turn_aborted>` marker when the outcome is known; an unknown mutation must reconcile
before cancellation can become terminal. A cancel requested while the Run is `reconciling` invokes the Provider `cancel`
operation; an unknown response keeps the Run in `reconciling`, while only a proved canceled or completed receipt may settle the
Run. Production composition defaults to an empty Tool Runtime.

Before a Tool result is committed, the Worker enforces the model-visible 40KB boundary. A larger raw string is first written as
an immutable `crewon.artifact.v0` record using the Tool receipt idempotency identity and the exact tenant/run/step/attempt/call
provenance; only then may the bounded head/tail preview and Artifact ID enter `tool.completed`. A Provider-supplied Artifact ID is
accepted only if the authority contains the same provenance and exact output digest/size. Standalone bytes are AES-256-GCM
encrypted; metadata and content reads remain behind Control API authorization.

Every Tool call now carries a canonical `ActionIntent` that binds the raw-input digest, pinned policy snapshot, workspace,
resource and credential bindings, execution target, capability and hard limits. Its SHA-256 digest is the Tool Step identity and
durable receipt lookup key. A `perAction` policy creates a separate durable Approval before Provider dispatch, changes the Run to
`waitingApproval`, and releases the Work Item lease into a long hold. The Control API decision, Approval transition, Run resume
and wake-up of that same Work Item commit atomically. A resumed Worker reclaims at the next lease epoch, abandons the pre-decision
Attempt, revalidates the exact ActionIntent and Approval, and only then invokes the Provider. Rejection terminates the new Tool
Attempt and Run without a Provider call. `CREWON_TOOL_APPROVAL_TTL_MS` defaults to 24 hours; an unattended decision becomes
`expired` without dispatch. `CREWON_TOOL_APPROVAL_RECHECK_MS` defaults to one second so cancellation and deadline recovery do not
wait for the TTL; an approval decision still wakes the held Work Item immediately in the same process. SQLite and PostgreSQL
currently use the bounded recovery scan; PostgreSQL `LISTEN/NOTIFY` remains a latency optimization to add, not a correctness
dependency.

## Correctness boundary

- Every Run mutation revalidates the active Work Item lease inside the same Store transaction; a stale or expired worker cannot
  write Agent events or terminal state.
- Lease renewal keeps the same epoch. Reclaim increments the epoch and fences the previous owner.
- Each Model and Tool Step owns durable Attempts. Reclaim abandons a still-running prior Attempt and links the new one with
  `retryOfAttemptId`; queue claim counters are not used as domain Attempt history. One Work Item may fence multiple independent
  Steps without equating `stepId` with `workItemId`.
- SQLite schema v15 and PostgreSQL AgentVersion authority v3 persist one authoritative `ThreadModelState` per Thread plus
  tenant-scoped immutable AgentVersion assets and Deployment records. The prior-model resolver can lazy-load the exact historical definition and
  instantiate it through the configured runtime factory; an unavailable old model fails closed before a smaller-model sample.
- The Worker revalidates the pinned execution policy before model execution and reloads Run cancel state at every kernel event
  boundary.
- Agent events are durable Run events and are delivered through the existing Outbox/SSE path.
- HTTP 429/408/409/5xx failures are classified as retryable, and a bounded `Retry-After` overrides the Work Item's default retry
  delay. Authentication, permission, invalid request and protocol failures fail closed.
- Same-Turn sampling retry and durable Attempt recovery are separate: Provider retry reuses one request contract and Attempt;
  budget exhaustion terminates that Run so a later user Turn can proceed. A later `retryOfAttemptId` is reserved for crash/lease
  reclaim or transactional execution recovery, not an unbounded loop over the same exhausted Provider error.
- `segment.checkpointed`, `segment.completed`, final assistant Message, assistant Model History item, Thread event/snapshot, continuation,
  `message.completed`, `run.completed`, Run snapshot, Step/Attempt, Outbox, Work Item settlement and idempotency receipt commit
  atomically.
- Retryable failure commits Attempt `failed`, Step `ready` and Work Item `pending` atomically. A later Attempt uses an
  attempt-scoped segment ID, so the prior Attempt's durable facts remain auditable without idempotency collisions.
- A Tool provider completion that races with process loss is recovered from the provider receipt; a committed Store receipt is
  replayed without calling the provider. Receipt completion, `tool.completed`, Model History result, Step/Attempt completion,
  Outbox and idempotency receipt now commit in one fenced Store transaction; an exact lost-response retry returns `replayed`,
  while changed completion data fails closed.

Current integration evidence uses a real child process and SQLite file: the test sends `SIGKILL` immediately after
`run.started` and the first Attempt commit, advances the already separately tested lease-expiry condition, starts a new Worker
process, and verifies Attempt 1 `abandoned`, Attempt 2 `completed` with `retryOfAttemptId`, continuous live SSE, and the terminal
assistant Message. It contains no sleep.

The Direct Responses adapter propagates an active `AbortSignal` into `fetch` and the response body. A durable cancellation watcher
also reloads the authoritative Run independently of model events, so a Control API cancel from another Store connection aborts a
blocked provider body. SQLite and PostgreSQL currently use bounded polling; PostgreSQL notification-based wakeup remains future
work. Isolated PostgreSQL 15 tests prove same-database multi-Worker competition and post-SIGKILL reclaim, but do not prove
cross-host partitions, a live OpenAI account, signed remote Device authorization or production readiness. Production composition
therefore still exposes no mutation Tool by default.

An optional real stdio MCP composition is enabled with CREWON_MCP_STDIO_CONFIG_PATH. The referenced JSON is parsed fail closed,
all servers complete the MCP initialize and paginated tools/list handshake before the Worker starts, and only tools with an
explicit trusted readOnly plus replaySafe policy are exposed. Commands and working directories must be absolute; the child
environment is explicit and does not inherit ambient secrets. Example:

```json
{
  "schemaVersion": "crewon.mcp-stdio-config.v0",
  "servers": [
    {
      "serverId": "local",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/server.mjs"],
      "cwd": null,
      "env": {},
      "tools": {
        "search": {
          "effect": "readOnly",
          "recovery": "replaySafe",
          "resourceBindingId": "mcp-local",
          "credentialBindingId": null,
          "executionTarget": {
            "kind": "control",
            "bindingId": "mcp-local-process"
          },
          "capability": "mcp.tool.read",
          "approvalRequirement": "none",
          "limits": {
            "timeoutMs": 30000,
            "maxOutputBytes": 65536,
            "maxArtifactBytes": 1048576
          }
        }
      }
    }
  ]
}
```

The MCP adapter is isolated in packages/mcp-runtime and is the only package importing the official MIT-licensed TypeScript SDK.
The generic adapter rejects mutation policies because MCP has no standard durable mutation receipt/reconcile operation. A
server-specific reconciler and durable provider receipt are mandatory before an MCP mutation can be enabled.
