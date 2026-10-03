# Installed plugin Worker deployment

The Worker can explicitly load an installed plugin release. Without this configuration, its existing startup, default Agent, model bindings and tools follow the original path. Desktop installation management does not enable execution or billing.

This is a private deployment protocol. The authority services below must be implemented and deployed by the host. The bridge does not provide a user directory, price source or wallet funding. Release publication is a separate explicit CLI step; Worker startup does not perform it. Test authorities and test-funded Runs do not prove those production services are connected.

## Configuration

Set `CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH` to an absolute, canonical path to an operator-owned JSON file. The file must be a regular file owned by the current OS user, with no group/other permissions, one hard link and at most 128 KiB. Symlinks, invalid UTF-8, unknown fields and changes while reading are rejected. An empty environment value is invalid; omit the variable to retain the original startup path.

The document has this shape:

```json
{
  "schemaVersion": "crewon.installed-plugin-worker.v1",
  "installRoot": "/operator/approved/plugins",
  "releaseDocumentPath": "/operator/approved/plugin-release.json",
  "actorAuthority": {
    "url": "https://identity.example/plugin-execution/actor",
    "serviceTokenEnvironmentVariable": "PLUGIN_ACTOR_AUTHORITY_TOKEN"
  },
  "policyAuthority": {
    "url": "https://policy.example/authorize",
    "serviceTokenEnvironmentVariable": "PLUGIN_POLICY_AUTHORITY_TOKEN"
  },
  "profileAuthority": {
    "url": "https://identity.example/plugin-profile",
    "serviceTokenEnvironmentVariable": "PLUGIN_PROFILE_AUTHORITY_TOKEN"
  },
  "packageAuthority": {
    "url": "https://policy.example/plugin-execution/package",
    "serviceTokenEnvironmentVariable": "PLUGIN_PACKAGE_AUTHORITY_TOKEN"
  },
  "networkAuthority": null,
  "historicalScope": null,
  "timeoutMs": 2000
}
```

These URLs are illustrative. Every endpoint requires HTTPS without URL credentials, query parameters or fragments. Service tokens are captured from the named environment variables before database initialization, must contain 32–8192 printable ASCII characters, and are redacted from JSON serialization and inspection. They are never placed in plugin configuration or browser DTOs. Timeout is an explicit integer between 1 and 30000 ms.

For the standalone historical query host, `historicalScope` is the exact `{tenantId, spaceId, profileId}` of the deployment. It does not confer permission. The installed private peer instead uses actual scopes declared by the loaded release and resolves the current profile even when `historicalScope` is null. A plugin needing host JSON HTTP also requires an explicit `networkAuthority` endpoint with the same URL/token-reference shape. No DNS, transport or TLS bypass can be configured through this document.

Desktop-managed startup clears this execution configuration from its inherited environment. Its management approval file and local Native identity cannot substitute for execution authority.

## Authority requests

All requests are bounded JSON HTTP POSTs with `Authorization: Bearer <service token>`. Redirects are rejected. A response must be HTTP 200, JSON, valid UTF-8 and no more than 16 KiB, including streamed bodies. Responses are current decisions, not cached grants. Timeouts and caller cancellation reject logically while the owner retains the actual request until its transport/body operation terminates. Shutdown withdraws authority synchronously and joins those physical operations before closing storage.

### Current actor

Request:

```json
{
  "schemaVersion": "crewon.plugin-execution-actor.v1",
  "owner": { "tenantId": "tenant", "spaceId": "space", "actorId": "actor" }
}
```

Response is `null` or exactly `{principalId, actorId, tenantId, spaceId}`. The returned actor, tenant and space must match the saved Run owner. The principal is resolved by the current authority; a historical admission does not supply a current principal.

### Application policy and profile

The existing policy wire remains `{actor, action, resource}`. This bridge supports the installed path's `run:read`, `run:execute`, `extension:read`, `extension:run`, `extension:query` and `agentVersion:read`, checking resource tenant/space against the current actor. Response is `{outcome: "allow"}` or `{outcome: "deny", reasonCode?: string}`. Installation policy's epoch response is a separate protocol and is not accepted here.

Profile request is `{actor}`; response is exactly `{tenantId, spaceId, profileId}`. Tenant and space must match that current actor. The historical query host also requires its exact configured profile.

### Installed package

Request:

```json
{
  "schemaVersion": "crewon.plugin-execution-package.v1",
  "identity": {
    "pluginId": "publisher.plugin",
    "publisherId": "publisher",
    "version": "1.0.0",
    "packageDigest": "sha256:<64 lowercase hexadecimal characters>"
  },
  "scope": { "tenantId": "tenant", "spaceId": "space", "profileId": "profile" },
  "purpose": "read"
}
```

Purpose is `read`, `submit` or `observe`. Response is exactly `{outcome: "allow" | "deny"}`. These decisions approve the exact package tuple and profile for the requested deployment operation. They do not grant user access or create a dispatch/credit receipt. Current actor and Application policy checks remain separate.

### Host network service

Request is `{schemaVersion: "crewon.plugin-execution-network.v1", kind: "readiness", metadata}` or `{schemaVersion: "crewon.plugin-execution-network.v1", kind: "run", context}`. Metadata contains the actual installed identity, profile scope, immutable extension configuration, execution target and `submit`/`observe` purpose. Run context is the existing SDK `PluginToolRuntimeContext`, derived from the actual persisted Run pin; private admission and credit records stay in the Worker. Preflight never creates a synthetic Run.

Response is `null` or the existing network approval `{baseUrlParameter, paths}`. Each path is `{method: "GET" | "POST", path}` or `{method: "GET", operationPathPrefix}`. An approval only permits those paths for the actual configuration parameter. Host IO still applies its production DNS policy, pinned address and TLS validation, and requires the real dispatch authority before mutation.

## Installed release and publication

`releaseDocumentPath` contains `crewon.installed-plugin-release.v1`: tenant, unchanged `defaultAgentVersionId`, and 1–32 entries. Each entry pins the full profile scope, plugin/publisher/version/digest, original extension configuration, approval requirement, explicit original `crewonKernel` model source, compiled derived AgentVersion and all fields of its execution target.

The loader reads the complete actual installed package without importing its Node code. It compiles the derived version with the existing compiler and reuses the existing runtime-binding materializers. Original deployment digest, compiled content and target must match exactly. Provider-owned execution, shared base tools and the old bundled extension configuration are rejected for these entries. The new opt-in cannot coexist with the old bundled extension host/runtime; unrelated explicit model bindings retain exact version dispatch.

The actual parent Store must already contain the published original and derived Agent assets/deployments, configuration revision and installed-package ledger. Before publication, the [metadata-only Control stage](./installed-plugin-task-startup.md#control-configuration-before-publication) can read the actual installed business schema and save its first configuration through the original HTTP routes; it requires the real operator-prepared installation ledger and no Worker. After its explicit migrations, Worker startup verifies all published inputs before registering or allocating plugin runtimes. The existing full release-bundle verification also remains required. Startup does not publish assets, activate a release, select a package, grant credits or repair missing deployment state.

The existing `release-main` CLI now accepts this configuration through an explicit installed-publication path. It requires an explicitly identified OS release operator and the exact original model bindings in the final Worker deployment set. It publishes source and derived assets through the existing Application services and activates the complete bundle once. Loading this Worker configuration alone does not install or publish a package. See [publication inputs, invocation, verification and generated-file handling](./installed-plugin-release-publication.md).

Each factory creation rechecks the same Store, actual package bytes and current read approval. A different profile, materialization, compiled version, missing artifact or revoked permission fails closed. Successful runtime resources transfer to the existing runtime registry/caller; release shutdown joins pending verification/creation work without discarding a late-created resource.

To retain historical execution, publish explicit entries for each required old version alongside the new version. Selection changes and disabled state do not rewrite past Run pins or select the newest package for an old Run. Historical observation still requires current user/package authorization and its exact saved configuration/target.

## Private installed task peer

Worker main can additionally enable its loopback installed peer with `CREWON_INSTALLED_PLUGIN_PEER_PORT` and `CREWON_INSTALLED_PLUGIN_PEER_TOKEN`; the optional deadline defaults to 10000 ms. All absent preserves the original startup. Partial settings, a peer without this installed execution configuration, and the old bundled extension host/runtime combination are rejected. The peer uses actual loaded metadata and the same Store/resolver for readiness; it does not submit a task or grant credits. It is separate from the old v0 extension HTTP wire.

See [installed task startup](./installed-plugin-task-startup.md) for exact environment formats, Control's metadata-only first configuration and private task configurations, current-authority and personal-credit admission, historical readiness limits and physical shutdown. The peer's 32 distinct full-scope/package candidate bound is not a bound of 32 physical Node instances. Process evidence uses an explicit operator installation prerequisite and named service fixtures. The complete product configuration UI, fresh-database end-user installation through automatic publication, formal query task acceptance, real pricing/funding/settlement and the Short Drama saved-project workflow remain separate integration work.
