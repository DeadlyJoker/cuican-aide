# Installed plugin release publication

The existing Runtime Worker release CLI accepts the private installed-plugin deployment configuration. It publishes the original model assets and derived plugin Agents, then activates one complete release bundle. Worker startup only verifies that publication; it does not publish, repair missing state, install a package, or fund a wallet.

This is an operator deployment step, separate from developing, installing and enabling an independent package. It is also separate from a user's permission to run the plugin. Current identity, business task admission, quotes and credit settlement still require their actual host services.

## Inputs and authority

Use the same `CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH` file, package authority and release document described in [Worker deployment](./installed-plugin-worker-deployment.md). Omitting the variable preserves the original CLI. A defined empty value is invalid. The new path cannot coexist with the old bundled extension host, runtime or recovery configuration.

The installed path requires explicit `CREWON_RELEASE_PRINCIPAL_ID`, `CREWON_RELEASE_ACTOR_ID`, `CREWON_TENANT_ID` and `CREWON_SPACE_ID`. They identify the existing OS release operator for the original `RuntimeReleaseAuthorization` contract. They are not a replacement for a current enterprise login. Package authority's `read` approval does not grant `agentVersion:publish` or `agentVersion:deploy`.

Before opening the release database or constructing the model/tool runtime, the CLI validates the private configuration and document, matches the operator tenant/space and unchanged default Agent, and reads the real immutable installed package with current package approval. This reads metadata without importing the package's Node code. The database must already contain the exact original extension configuration revision and installed package ledger for every document entry. Publication does not create those installation/configuration records or choose a package version.

For a first publication, `CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH` must provide each exact original `modelSource.runtimeBinding`. The CLI's final deployment set and the Worker's deployment set must be identical. Missing or conflicting original candidates are rejected; the CLI does not activate a temporary prerequisite bundle or substitute the default Agent's static materialization digest.

An original model source whose Agent ID equals the default Agent but whose deployment differs is rejected. Use an explicitly configured original model source with its own ID; keep the default Agent unchanged. Unrelated configured model bindings continue through the existing path.

The original development-profile/model-catalog generation remains available. For an installed publication, its generated manifest includes the explicitly declared original model-source bindings. Same-ID conflicts are rejected, including conflicts with a generated entry. The new code does not silently replace an ordinary model binding with the plugin's source.

## Invocation and result

Use Node.js 24 and pnpm 10. Keep the existing model, route and database deployment settings, add the explicit inputs above, then run:

```bash
pnpm --filter @crewon/runtime-worker release
```

The existing JSON result retains disposition, release/activation IDs and full deployment identifiers/digests. The installed path also reports verification status. Inspect `verification.outcome` before treating the deployment as ready.

The publisher checks the actual installed inputs, publishes immutable original and planned Agent assets through `AgentVersionApplicationService`, rechecks the inputs, and invokes `AgentVersionReleaseApplicationService.activate` once with the final bundle. It then verifies the actual stored assets, deployments and release bundle. Retrying the same activation ID and exact bundle uses the original replay contract; it does not rebase materialization or create another activation.

That publisher verification proves stored publication, including a historical release. The CLI separately checks the actual current active bundle before reporting verified or publishing a generated manifest. Replaying an old activation after a different bundle became active returns the original replayed receipt with unavailable verification and does not overwrite the manifest or move the active pointer. The current-bundle check does not claim an atomic lock across later activation and filesystem operations. Worker verification retains the original ability to use explicitly published historical bundles.

Asset publication and final activation are separate existing transactions. A late rejection can leave authorized immutable assets, while the active release remains unchanged. A rejection before any publication leaves no published Agent assets or activation. Neither case creates a Run, quote, credit grant or supplier request.

If activation has already committed, later withdrawal, shutdown or verification failure returns the real committed activation with `verification.outcome: "unavailable"`. It does not report that the activation never happened. The CLI prints the verification outcome without exposing exception details or private authority tokens.

## Generated binding manifests and shutdown

For the new installed path, generated bindings use a private staging file. The original manifest is checked before replacing it, and the staged manifest is published only after actual release activation, verified publication and a matching current active bundle. Cleanup removes a staging file only when its actual file identity and complete expected bytes still prove ownership. Replaced, modified or unknown partial files are preserved and reported as unavailable. A changed original or failed post-commit file publication preserves the committed activation and reports unavailable verification; inspect the actual database and manifest before retrying.

Filesystem publication and database activation are not one atomic transaction. The file identity/content checks detect changes during the publication pipeline; they are not a filesystem CAS against arbitrary concurrent changes by the same OS user.

The publication owner withdraws new calls synchronously and joins actual pending authorization/storage operations. A started activation is allowed to produce its real commit receipt. CLI cleanup closes the publisher, loaded release and authority before its owned database, then the original model/tool resources. Loading and publication do not allocate the installed Node execution factory.

## Remaining product integration

This CLI closes the deployment-publication gap. Control's formal business task startup and readiness/query bridge, actual current-user services, explicit independent credit funding/prices/settlement, Short Drama saved projects and live generation, and the second real enterprise API still need their own end-to-end evidence. The reference packages and test-funded Runs do not prove those production paths are ready.
