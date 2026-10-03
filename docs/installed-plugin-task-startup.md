# Installed plugin task startup

Production Control and Runtime Worker now have an explicit installed-plugin task path. A mounted plugin action reaches the original task Application, reserves personal plugin credits in the original Run transaction, and executes the exact installed SDK package in Worker. The existing shell, default Agent and ordinary Run path remain unchanged.

This document describes startup wiring and its trust boundaries. Actual PostgreSQL Control/BFF/Worker process tests use named identity, policy, model, quote, funding and supplier fixtures. They establish the integration path; they do not establish live business services, credit settlement, enterprise API acceptance or a packaged desktop application.

## Required deployment state

Use Node.js 24 and pnpm 10. Keep the existing [web deployment](./deployment.md) and application-specific database, artifact, model and security configuration. Control's task opt-in requires production security mode, a real PostgreSQL parent Store, production request identity and the existing [installed UI configuration](./installed-plugin-service-startup.md). Standalone Control and Windows reject this task configuration.

Control and Worker must use the same installation ledger, configuration and Run database, with the same tenant/space/profile and immutable installed packages available in their configured installation roots. Control's task and UI `installRoot` must be identical. Package approval, UI asset publication, current user permissions, execution readiness and credit admission are separate checks.

Before starting Worker, use the [installed release CLI](./installed-plugin-release-publication.md) to publish the exact original model assets, derived Agents and final complete release bundle. The [Worker deployment configuration](./installed-plugin-worker-deployment.md) pins the actual installed package, profile, configuration revision and full execution target. Worker startup verifies this state; it does not install, publish, activate, grant credits or invent a configuration.

**First-ever configuration bootstrap remains incomplete.** Publication already requires the persisted extension configuration revision, while public configuration preparation depends on the verified published materialization. The process proof starts with an explicit operator-prepared installation ledger and configuration, then uses public configuration reads and activation. It is not evidence of a fresh-database, end-user bootstrap flow. Do not bypass this requirement with a fabricated Store row or readiness response.

## Worker private peer

Set `CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH` as described in the Worker deployment document, then configure the following new variables:

| Variable                                   | Format                                                                |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `CREWON_INSTALLED_PLUGIN_PEER_PORT`        | Required canonical unsigned decimal, 0–65535                          |
| `CREWON_INSTALLED_PLUGIN_PEER_TOKEN`       | Required secret, 32–8192 bytes; no spaces or ASCII control characters |
| `CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS` | Optional canonical unsigned decimal, 1000–30000; default 10000        |

All three absent means off. Any supplied variable requires valid port and token; empty, partial or conflicting configuration is rejected. Canonical decimal excludes leading zeros and signs. Use a 32–8192-character printable ASCII token to satisfy both Worker and Control. Supply it through the deployment's secret mechanism, never a plugin, browser projection or checked-in example.

For example, the non-secret Worker settings are:

```bash
export CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH=/operator/approved/worker-plugin.json
export CREWON_INSTALLED_PLUGIN_PEER_PORT=18442
export CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS=10000
pnpm --filter @crewon/runtime-worker start
```

The token must already be present in the Worker's environment. Peer startup requires the installed release and authority; it cannot run alone or coexist with the old bundled extension host/runtime. With port `0`, Worker selects an ephemeral port. Read its actual startup line and use that origin in Control:

```text
CrewON Installed Plugin Peer origin http://127.0.0.1:<actual port>
```

The peer listens only on IPv4 loopback and accepts authenticated JSON POSTs at `/private/v1/installed-plugins`. It is a private service channel on the same host/network namespace, not a browser endpoint. Its bearer token is not printed.

## Control task configuration

Set `CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH` to an absolute canonical path to a private JSON file. Omitting the variable preserves the original Control path without allocating task authorities or running these plugin migrations. A defined empty value is invalid. The new opt-in cannot coexist with the old Control extension-worker configuration.

The file must be a nonempty regular file owned by the current OS user, have one hard link, no group/other permissions, no symlink path, and contain at most 64 KiB. Invalid UTF-8, unknown fields or file identity/content changes while reading are rejected. Every field below is required:

```json
{
  "schemaVersion": "crewon.installed-plugin-control-tasks.v1",
  "installRoot": "/operator/approved/plugins",
  "peer": {
    "origin": "http://127.0.0.1:18442",
    "tokenEnvironmentVariable": "PLUGIN_PEER_TOKEN"
  },
  "packageAuthority": {
    "url": "https://policy.example/plugin-tasks/package",
    "serviceTokenEnvironmentVariable": "PLUGIN_TASK_PACKAGE_AUTHORITY_TOKEN"
  },
  "quoteAuthority": {
    "url": "https://billing.example/plugin-tasks/quote",
    "serviceTokenEnvironmentVariable": "PLUGIN_TASK_QUOTE_AUTHORITY_TOKEN"
  },
  "timeoutMs": 2000,
  "maximumPackages": 32
}
```

These paths and URLs are illustrative and contain no credentials. `peer.origin` must be exactly an origin of the form `http://127.0.0.1:<1–65535>`: no trailing slash, credentials, path, query, fragment, `localhost` or IPv6 substitute. It must identify the actual Worker peer. The captured value of `PLUGIN_PEER_TOKEN` must equal Worker's `CREWON_INSTALLED_PLUGIN_PEER_TOKEN`.

Authority URLs require HTTPS without credentials, query or fragment, and at most 2048 bytes. Token variable names match `[A-Z][A-Z0-9_]{0,127}`; captured values contain 32–8192 printable ASCII characters. Configuration serialization redacts these values. `timeoutMs` is an integer from 1 to 30000; `maximumPackages` is an integer from 1 to 32 and bounds Control's package owners. Secrets are captured at startup, so changing their environment requires restarting the owner.

Keep `CREWON_CONTROL_SECURITY_MODE=production`, `CREWON_CONTROL_DATABASE_URL` and the original verified BFF/identity/policy settings. Existing `CREWON_PLUGIN_UI_*` profile, epoch policy and asset publication settings remain required; this task file does not replace them. See [installed UI and installation startup](./installed-plugin-service-startup.md). Installation management is a separate opt-in and does not itself grant execution or a price.

After the real authorities, release and Worker peer are ready, start Control with its original production configuration plus:

```bash
export CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH=/operator/approved/control-plugin-tasks.json
pnpm --filter @crewon/control-api start
```

Start the existing Web BFF with its original `CREWON_WEB_PUBLIC_ORIGIN`, `CREWON_CONTROL_TARGET`, `CREWON_CONTROL_BFF_TOKEN`, `CREWON_CONTROL_CSRF_TOKEN`, `CREWON_WEB_CSRF_SECRET`, `CREWON_IDENTITY_SESSION_URL` and `CREWON_IDENTITY_SERVICE_TOKEN` settings. No new BFF plugin secret or route is introduced. The public edge retains TLS, session cookies, CSRF and trusted-origin requirements from the existing deployment.

```bash
pnpm --filter @crewon/web-bff start
```

## Current authority and personal credits

Browser identity still terminates at BFF. Control resolves the current actor through its production token verifier, and the profile authority returns that actor's current tenant/space/profile. Caller actor headers and plugin action input cannot select a principal or profile. Current Application permissions and the UI policy epoch are checked across asynchronous calls and before new admission.

Control's package authority receives a bounded HTTPS POST using the existing `crewon.plugin-execution-package.v1` wire: exact plugin/publisher/version/package digest, full profile scope and requested purpose. Response is exactly `{outcome: "allow" | "deny"}`. This approves the package for that purpose; it does not replace current user, UI, model, network or credit authority.

The quote authority receives exactly `{actor, binding, input, commandRequestDigest}` from the actual generation request. `binding` is the original v0 extension Run binding, with `source: null`; input and digest must match. Its response is exactly:

```json
{ "poolId": "personal-plugin-pool", "priceRevision": 1, "quotedCredits": "30" }
```

This is a shape example, not a configured price or funded pool. `poolId` must be a valid opaque ID, `priceRevision` a positive safe integer, and `quotedCredits` a positive decimal string of at most 48 digits. The authority must provide actual approved prices. The adapter supplies no amount, payer, grant or funding rule. Missing, invalid or unavailable quotes fail before a Run or reservation is committed.

Task authority responses require HTTP 200, valid UTF-8 JSON and at most 16 KiB, including streamed bodies; redirects are rejected. Current request authority is rechecked around quote and package calls. No result from this channel can turn a caller-supplied admission into authority.

The actual installed Node action uses `PluginTaskActionBridge` and the original `createTaskFromPlugin` path. The v1 package/profile/selection admission, original Turn/Run, v0 binding, personal quote reservation and idempotent receipt commit in the same parent Store transaction. Replaying the same accepted request returns the saved Run rather than creating another Run or reservation. Selection and activation of version B do not rewrite version A's saved pin. A permission withdrawal after a real commit preserves its accepted receipt; subsequent new requests must pass current authority again.

The current path reserves independent personal plugin credits. Successful generation does not by itself settle or release that reservation. Real credit funding, price policy and settlement remain product integration work.

## Peer metadata, readiness and history

The private wire has five operations: `catalog`, `validateConfiguration`, `readiness`, `queryResolveRegistration` and `queryReadiness`. Its request and response protocols are `crewon.installed-plugin-peer-request.v1` and `crewon.installed-plugin-peer-response.v1`. Common fields identify the request, current actor and full profile scope. Package identity contains all six fields: plugin, publisher, version, package, manifest and implementation digests. Targets include all eight original execution-target fields.

Catalog rows come from the actual loaded release and installed business registration. They are metadata, not ready grants. Current enabled selection is required. A matching enabled business activation filters the exact configuration/target; absent, disabled or old-version activation can still expose the selected package's actual metadata for explicit configuration and activation. The task Application independently checks the real activation and full binding.

Readiness uses the same actual parent Store and runtime resolver, current actor/profile/policy, actual installed bytes, exact published materialization and SDK factory. Declared execution services require actual IO preflight. It does not execute `factory.create`, create a synthetic Run, quote or dispatch a supplier operation. Missing IO or network approval remains unavailable.

Historical query requests carry `expectedSource` only as an expectation. Worker rereads the original paid Run, admission, task receipt, personal reservation and durable external operation from its same Store before accepting the full comparison. Observation uses the original package/configuration/target, including after a selection change. Readiness requires that exact historical materialization to be explicitly available in the loaded release; it never substitutes the newest package. This peer boundary has separate dual-Store coverage. The formal Control/BFF process proof in this stage covers generation, not paid query action acceptance or result projection.

Wire limits are 512 KiB per message, 32 catalog rows, 16 KiB configuration, 64 KiB manifest/source, 4 KiB target, JSON depth 24 and 16384 nodes. Peer owners are allocated from at most **32 distinct full-scope plus package-identity candidates** declared by the actual release. This is not a promise of at most 32 physical Node instances: generation/query purpose owners and execution leases have separate lifetimes and existing bounds.

## Shutdown and evidence limits

Close synchronously withdraws new peer/request/task authority and begins cancellation of outstanding service work. A timeout or disconnected caller can finish logically while the actual callback, fetch body or host borrow remains active. Its pending slot stays occupied until physical completion; timeout is not proof that the resource is gone.

Worker joins peer server and generation/query hosts before closing the installed execution resolver; it then releases loaded release/authority resources before its Store. Control withdraws request and action owners and joins actual Node/peer/authority work before closing its parent Store. Startup failures use the same cleanup boundary, and repeated close shares the existing closing operation. A late commit retains its real accepted receipt rather than being reported as never submitted.

The actual production-process test uses PostgreSQL plus real `release-main`, Worker main, Control main and BFF children. It reads configuration and activates via the original public HTTP routes, mounts/invokes an installed Report action, submits both immutable versions, verifies idempotent admission, rejects a missing quote and subsequent withdrawn action, and runs an ordinary default Agent. Two named test reservations remain reserved after completion. Identity, model, quote, test grant and HTTP/SQLite supplier are explicit fixtures.

Executable references are the [Control task configuration parser](../apps/control-api/src/installed-plugin-task-environment.ts), [Worker peer environment parser](../apps/runtime-worker/src/plugins/installed-plugin-peer-environment.ts), [private wire contract](../packages/contracts/src/installed-plugin-peer-api.ts), [production-process test](../apps/control-api/src/installed-plugin-tasks-process.integration.test.ts) and [Worker peer dual-Store/lifetime tests](../apps/runtime-worker/src/installed-plugin-peer.test.ts).

This evidence does not claim first-ever persisted-configuration bootstrap, formal query task completion, settlement, live ComfyUI/enterprise API acceptance, Short Drama saved projects/generation, or packaged Electron application delivery. Installation/UI management and the old v0/default execution path remain available when these new opt-ins are omitted. The new installed path rejects incomplete authority rather than falling back to a fabricated v0 registration.
