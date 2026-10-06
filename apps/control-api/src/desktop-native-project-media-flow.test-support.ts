import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { TestContext } from "node:test";
import {
  ThreadApplicationService,
  ProjectAssetApplicationService,
  ProjectTextApplicationService,
  type PluginUiJsonValue,
} from "@crewon/application";
import { createComfyUiProjectGenerationImageResultVerifier } from "@crewon/artifacts";
import { parsePluginUiRecoveryRequest } from "@crewon/contracts";
import { extensionCanonicalJson } from "@crewon/domain";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { desktopNativeMediaInputFixture } from "./desktop-native-project-media-input.test-support.ts";
import { nativeMediaProvider } from "./desktop-native-project-media-provider.test-support.ts";

/** Real Native files/Core/UI actions, original project/selection/asset/thread records and encrypted materials.
 * Peer readiness and provider operation/socket results are named fixtures; no live generation is claimed. */
export async function nativeMediaFlowFixture(
  t: TestContext,
  options: {
    kind?: "T10" | "D18";
    mediaTransportGrant?: "none" | "read" | "all";
  } = {},
) {
  const provider = nativeMediaProvider(t);
  const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
    mediaGenerations: true,
    generationFlow: true,
    mediaTransportGrant: options.mediaTransportGrant,
  });
  const source = f.bootstrap.sources[0]!,
    target = f.entry.configuredTarget;
  const ext = f.parent.extensionStore();
  const common = {
    clock: f.clock,
    digester: f.digester,
    ids: { nextId: () => randomUUID() },
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
  };
  await f.runtime.installation.install(f.actor, {
    sourceId: source.sourceId,
    expectedPluginId: source.pluginId,
    expectedPackageDigest: source.packageDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "native-flow-install",
  });
  // Native Main reviewed this exact configuration before startup. Persist it through the original Store.
  await ext.saveExtensionConfiguration({
    configuration: f.entry.configuration,
    expectedRevision: 0,
    receipt: {
      actorId: f.actor.actorId,
      idempotencyKey: "native-flow-config",
      requestDigest: f.digester.sha256("native-flow-config"),
    },
  });
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
  const releaseId = f.digester.sha256("named-native-media-flow-release");
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
      activationId: "named-native-media-flow-activation",
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
        pluginId: source.pluginId,
        configurationRevision: 1,
        expectedRevision: 0,
        idempotencyKey: "native-flow-activate",
        state: "enabled",
        agentVersionId: target.agentVersionId,
      }),
  );
  await f.runtime.installation.select(f.actor, {
    pluginId: source.pluginId,
    selectedPackageDigest: source.packageDigest,
    state: "enabled",
    expectedSelectionRevision: 1,
    idempotencyKey: "native-flow-enable",
  });
  const threads = new ThreadApplicationService({
    ...common,
    store: f.parent,
    workspaceAdmission: { admit: async () => {} },
  });
  assert.ok(f.runtime.bindProjectConversations?.(threads));
  const mount = await f.runtime.ui.openMount(f.actor, {
    pluginId: source.pluginId,
    contributionId: "workbench",
    expectedPackageDigest: source.packageDigest,
    expectedSelectionRevision: 2,
  });
  const invoke = async (action: string, input: PluginUiJsonValue) => {
    if (
      action === "crewon.project-generations.v1.generateConcept" ||
      action === "crewon.project-generation-selections.v1.selectConceptImage"
    ) {
      const command = {
        mountRef: mount.mountRef,
        ...parsePluginUiRecoveryRequest({ action, input }),
      };
      await f.runtime.ui.recoveryAuthenticatedRequest!(
        f.request(),
        f.actor,
        undefined,
        () => f.runtime.ui.stageRecovery!(f.actor, command),
      );
    }
    return f.runtime.ui.invokeAuthenticatedRequest!(
      f.request(),
      f.actor,
      { mountRef: mount.mountRef, action, input },
      new AbortController().signal,
    );
  };
  const concept = await f.projectService.createConcept(f.actor, {
    projectId: f.query.projectId,
    expectedProjectRevision: f.project.project.revision,
    briefRevision: 1,
    name: "已采用角色参考",
    prompt: "Two named reference images for the real Native material flow.",
    idempotencyKey: "native-flow-concept",
  });
  const reference = {
    projectId: concept.project.projectId,
    assetId: concept.asset.assetId,
    assetRevision: concept.assetRevision.assetRevision,
    expectedProjectRevision: concept.project.revision,
    expectedAssetMetadataRevision: concept.asset.revision,
  };
  await seedThread(f.parent, { ...f.actor, threadId: "native-source-thread" });
  const created = (await invoke(
    "crewon.project-generations.v1.generateConcept",
    {
      reference,
      threadId: "native-source-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "native-source-generation",
    },
  )) as { runId: string };
  assert.equal(typeof created.runId, "string");
  const binding = await ext.loadExtensionRunBinding({
    ...f.scope,
    runId: created.runId,
  });
  assert.ok(binding);
  const run = await f.parent.loadRun({
    tenantId: f.actor.tenantId,
    runId: created.runId,
  });
  assert.ok(run);
  const claim = await f.parent.claimNextWorkItem({
    ownerId: "native-source-provider-fixture",
    leaseId: randomUUID(),
    leaseDurationMs: 60_000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, created.runId);
  await f.parent.commitLeasedRun({
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    commit: {
      tenantId: f.actor.tenantId,
      idempotency: {
        scope: "native-source-start",
        key: created.runId,
        requestFingerprint: f.digester.sha256("native-source-start"),
      },
      expectedRevision: run.revision,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: created.runId },
          eventId: randomUUID(),
          sequence: run.lastSequence + 1,
          occurredAt: f.clock.now(),
          type: "run.started",
          data: {},
        },
      ],
      outbox: [],
      workItems: [],
    },
    history: null,
  });
  const operations = f.parent.externalOperationStore();
  const reserved = await operations.reserveExternalOperation({
    tenantId: f.actor.tenantId,
    runId: created.runId,
    bindingDigest: binding.bindingDigest,
    operationId: randomUUID(),
    correlationId: randomUUID(),
    executionId: "named-native-source-images",
    idempotencyKey: "native-source-operation",
    actionDigest: f.digester.sha256("native-source-action"),
    requestDigest: f.digester.sha256("native-source-request"),
    createdAt: f.clock.now(),
  });
  const operation = (
    await operations.advanceExternalOperation({
      ...reserved.operation,
      expectedRevision: reserved.operation.revision,
      status: "succeeded",
      providerOperationId: "named-native-provider-result",
      resultJson: extensionCanonicalJson({ images: provider.images }),
      updatedAt: f.clock.now(),
    })
  ).operation;
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: f.mediaInputs.referenceIdentities,
  });
  const assets = new ProjectAssetApplicationService({
    ...common,
    store: f.parent.projectAssetStore({ verifier }),
    projects: f.parent.creativeProjectStore(),
    texts: f.parent.projectTextStore(),
  });
  async function adopt(
    kind: "scene" | "character",
    name: string,
    resultIndex: number,
    selectionRevision: number,
  ) {
    await invoke("crewon.project-generation-selections.v1.selectConceptImage", {
      reference,
      operationId: operation.operationId,
      expectedOperationRevision: operation.revision,
      resultIndex,
      expectedSelectionRevision: selectionRevision - 1,
      idempotencyKey: `native-select-${name}`,
    });
    const candidate = await assets.saveCandidate(f.actor, {
      projectId: f.query.projectId,
      assetId: null,
      kind,
      expectedAssetRevision: 0,
      briefRevision: 1,
      script: null,
      content: {
        name,
        setting: `Named ${name}`,
        visualPrompt: `Preserve ${name}`,
      },
      idempotencyKey: `native-asset-${name}`,
    });
    const assetId = candidate.asset.assetId;
    await assets.selectRevision(f.actor, {
      projectId: f.query.projectId,
      assetId,
      expectedAssetRevision: 1,
      contentRevision: 1,
      idempotencyKey: `native-content-${name}`,
    });
    await assets.saveReferenceCandidate(f.actor, {
      projectId: f.query.projectId,
      assetId,
      expectedAssetRevision: 2,
      assetContentRevision: 1,
      conceptAssetId: reference.assetId,
      selectionRevision,
      idempotencyKey: `native-reference-${name}`,
    });
    await assets.selectReference(f.actor, {
      projectId: f.query.projectId,
      assetId,
      expectedAssetRevision: 3,
      referenceRevision: 1,
      idempotencyKey: `native-adopt-${name}`,
    });
    return {
      projectId: f.query.projectId,
      assetId,
      kind,
      expectedAssetRevision: 4,
      contentRevision: 1,
      referenceRevision: 1,
    };
  }
  const character = await adopt("character", "林予", 0, 1);
  let mediaBody: PluginUiJsonValue = {
    ...f.command,
    item: { kind: "character-reference", assetId: character.assetId },
    references: { character },
  };
  if (options.kind === "D18") {
    const scene = await adopt("scene", "雨夜旧站", 0, 2);
    const characterTwo = await adopt("character", "许晟", 1, 3);
    const texts = new ProjectTextApplicationService({
      ...common,
      store: f.parent.projectTextStore(),
      projects: f.parent.creativeProjectStore(),
    });
    const script = await texts.saveScriptCandidate(f.actor, {
      projectId: f.query.projectId,
      episodeId: "episode-1",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: null,
      content: {
        title: "旧站来信",
        scenes: [
          {
            sceneId: "scene-1",
            location: "旧站",
            timeOfDay: "夜",
            action: "林予遇到许晟",
            dialogue: [],
          },
        ],
      },
      idempotencyKey: "native-script",
    });
    await texts.selectRevision(f.actor, {
      projectId: f.query.projectId,
      artifactId: script.artifact.artifactId,
      expectedArtifactRevision: 1,
      contentRevision: 1,
      idempotencyKey: "native-script-adopt",
    });
    mediaBody = {
      ...f.command,
      item: { kind: "storyboard-frame-exploration", episodeId: "episode-1" },
      workflowId: "flux2-three-reference-storyboard",
      script: { artifactId: script.artifact.artifactId, contentRevision: 1 },
      references: { scene, characterOne: character, characterTwo },
    };
  }
  const saved = await f.app.inject({
    method: "POST",
    url: f.request().url,
    headers: { ...f.headers, "idempotency-key": "native-saved-media-input" },
    payload: mediaBody,
  });
  assert.equal(saved.statusCode, 200, inspect(f.routeState.errors));
  const input = saved.json().input;
  assert.equal(input.inputRevision, 1);
  const conversation = (await invoke(
    "crewon.project-conversations.v1.createConversation",
    {
      projectId: f.query.projectId,
      workspaceId: "native-existing-workspace",
      title: "Native素材生成",
      idempotencyKey: "native-flow-conversation",
    },
  )) as {
    binding: { threadId: string; workspaceId: string | null; revision: number };
  };
  assert.equal(conversation.binding.workspaceId, "native-existing-workspace");
  const body = {
    mediaInputId: input.mediaInputId as string,
    inputRevision: 1,
    expectedInputRevision: 1,
    executionId: "native-original-media-execution",
    threadId: conversation.binding.threadId,
    expectedThreadRevision: 1,
  };
  const post = (
    changes: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    f.app.inject({
      method: "POST",
      url: `/api/v1/creative-projects/${f.query.projectId}/media-generations`,
      headers: {
        ...f.headers,
        "idempotency-key": "native-original-media-generation",
        ...changes.headers,
      },
      payload: changes.body ?? body,
    });
  return {
    ...f,
    provider,
    invoke,
    assets,
    character,
    body,
    post,
    sourceRunId: created.runId,
    binding: conversation.binding,
    input,
  };
}
