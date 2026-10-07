import type { desktopNativeMediaInputFixture } from "./desktop-native-project-media-input.test-support.ts";
type Fixture = Awaited<ReturnType<typeof desktopNativeMediaInputFixture>>;
/** Install, activate and mount through the original native application services. */
export async function activateNativeProjectUi(f: Fixture) {
  const pluginId = f.entry.identity.pluginId,
    packageDigest = f.entry.identity.packageDigest;
  const installed = await f.runtime.installation.install(f.actor, {
    sourceId: "native-short21-media",
    expectedPluginId: pluginId,
    expectedPackageDigest: packageDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "native-result-ui-install",
  });
  // Persist the configuration reviewed by the Native fixture through the original store.
  await f.parent.extensionStore().saveExtensionConfiguration({
    configuration: f.entry.configuration,
    expectedRevision: 0,
    receipt: {
      actorId: f.actor.actorId,
      idempotencyKey: "native-result-ui-config",
      requestDigest: f.digester.sha256("native-result-ui-config"),
    },
  });
  const target = f.entry.configuredTarget;
  await f.parent.registerAgentVersion({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: f.actor.tenantId,
    agentVersionId: target.agentVersionId,
    contentDigest: target.agentVersionContentDigest,
    createdAt: f.clock.now(),
    definitionJson: JSON.stringify({
      schemaVersion: "crewon.agent-version.v0",
      agentVersionId: target.agentVersionId,
      runtimeGeneration: target.runtimeGeneration,
      policySnapshotId: target.policySnapshotId,
    }),
  });
  const releaseId = f.digester.sha256("named-native-result-ui-release");
  await f.parent.activateAgentVersionRelease({
    bundle: {
      schemaVersion: "crewon.agent-version-release-bundle.v0",
      tenantId: f.actor.tenantId,
      releaseId,
      manifestDigest: releaseId,
      defaultAgentVersionId: target.agentVersionId,
      deployments: [
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: f.actor.tenantId,
          agentVersionId: target.agentVersionId,
          contentDigest: target.agentVersionContentDigest,
          materializationDigest: target.materializationDigest,
          authorityId: target.authorityId,
          workspaceBindingId: target.workspaceBindingId,
        },
      ],
    },
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: f.actor.tenantId,
      releaseId,
      activationId: "named-native-result-ui-activation",
      previousReleaseId: null,
      operator: {
        principalId: f.actor.principalId,
        actorId: f.actor.actorId,
        spaceId: f.actor.spaceId,
      },
      activatedAt: f.clock.now(),
    },
    expectedActiveReleaseId: null,
  });
  await f.runtime.configuration.requests.run(
    { request: f.request(), actor: f.actor, preparation: "configuration" },
    () =>
      f.runtime.configuration.extensions.setActivation(f.actor, {
        pluginId: pluginId,
        configurationRevision: 1,
        expectedRevision: 0,
        idempotencyKey: "native-result-ui-activate",
        state: "enabled",
        agentVersionId: target.agentVersionId,
      }),
  );
  const selected = await f.runtime.installation.select(f.actor, {
    pluginId,
    state: "enabled",
    selectedPackageDigest: packageDigest,
    expectedSelectionRevision: installed.selection!.revision,
    idempotencyKey: "native-result-ui-enable",
  });
  const mount = await f.runtime.ui.openMount(f.actor, {
    pluginId,
    contributionId: "workbench",
    expectedPackageDigest: packageDigest,
    expectedSelectionRevision: selected.mutation.selection.revision,
  });
  return { mount, selected };
}
export async function remountNativeProjectUi(
  f: Pick<Fixture, "actor" | "entry" | "runtime">,
  selectionRevision: number,
) {
  return f.runtime.ui.openMount(f.actor, {
    pluginId: f.entry.identity.pluginId,
    contributionId: "workbench",
    expectedPackageDigest: f.entry.identity.packageDigest,
    expectedSelectionRevision: selectionRevision,
  });
}
