import { createHash } from "node:crypto";
import { createCreativeProject } from "./creative-project.ts";
import {
  appendProjectBriefRevision,
  createConceptAsset,
} from "./creative-project-revisions.ts";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
} from "./extension-configuration.ts";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import { createProjectGenerationLink } from "./project-generation-link.ts";
import { createOperationResultLink } from "./operation-result-link.ts";
import { createCurrentConceptSelection } from "./current-concept-selection.ts";
import { saveProjectScriptCandidate } from "./project-text-mutations.ts";
import { saveProjectAssetCandidate } from "./project-asset-mutations.ts";
export const assetActor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "person",
  actorId: "human",
};
export const assetAt = "2026-10-06T00:00:00.000Z";
export const assetDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
/** Domain recipe data only, not an execution, admission or successful supplier test. */
export function projectAssetDomainFixture() {
  const brief = appendProjectBriefRevision(
    {
      project: createCreativeProject({
        scope: { tenantId: "tenant", spaceId: "space", projectId: "project" },
        actor: assetActor,
        title: "夜航",
        at: assetAt,
      }),
      actor: assetActor,
      expectedProjectRevision: 1,
      text: "雨夜短剧",
      at: assetAt,
    },
    assetDigester,
  );
  const concept = createConceptAsset(
    {
      project: brief.project,
      actor: assetActor,
      expectedProjectRevision: 2,
      brief: brief.brief,
      assetId: "concept",
      name: "雨夜",
      prompt: "雨夜角色",
      at: assetAt,
    },
    assetDigester,
  );
  const script = saveProjectScriptCandidate(
    {
      project: concept.project,
      actor: assetActor,
      artifact: null,
      artifactId: "script",
      episodeId: "episode-1",
      expectedArtifactRevision: 0,
      brief: brief.brief,
      outline: null,
      content: {
        title: "夜航",
        scenes: [
          {
            sceneId: "scene-1",
            location: "修复室",
            timeOfDay: "夜",
            action: "她抬起头。",
            dialogue: [],
          },
        ],
      },
      at: assetAt,
    },
    assetDigester,
  );
  if (script.contentRevision.kind !== "script")
    throw new Error("fixture_invalid");
  const asset = saveProjectAssetCandidate(
    {
      project: concept.project,
      actor: assetActor,
      asset: null,
      assetId: "character-1",
      kind: "character",
      expectedAssetRevision: 0,
      brief: brief.brief,
      script: null,
      content: {
        name: "修复师",
        setting: "谨慎而好奇。",
        visualPrompt: "雨夜的修复师\n细节\t自然光",
      },
      at: assetAt,
    },
    assetDigester,
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: "tenant",
      spaceId: "space",
      pluginId: "crewon.short-drama",
      revision: 1,
      pluginVersion: "19.0.0",
      manifestDigest: assetDigester.sha256("manifest"),
      implementationDigest: assetDigester.sha256("implementation"),
      parameters: { preset: "portrait" },
      credentialBindings: [],
      createdByActorId: assetActor.actorId,
      createdAt: assetAt,
    },
    assetDigester,
  );
  const binding = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      tenantId: "tenant",
      spaceId: "space",
      pluginId: configuration.pluginId,
      runId: "R-original",
      threadId: "thread",
      actorId: assetActor.actorId,
      configurationRevision: 1,
      configurationDigest: configuration.contentDigest,
      target: {
        executionAuthority: "crewonKernel",
        agentVersionId: "agent",
        agentVersionContentDigest: assetDigester.sha256("agent"),
        materializationDigest: assetDigester.sha256("materialization"),
        authorityId: "authority",
        runtimeGeneration: "runtime",
        policySnapshotId: "policy",
        workspaceBindingId: null,
      },
      inputDigest: assetDigester.sha256(
        extensionCanonicalJson({ prompt: concept.assetRevision.prompt }),
      ),
      source: null,
    },
    assetDigester,
  );
  const generation = createProjectGenerationLink(
    {
      actor: assetActor,
      reference: {
        projectId: "project",
        assetId: "concept",
        assetRevision: 1,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
      ...concept,
      brief: brief.brief,
      binding,
      receipt: {
        actorId: assetActor.actorId,
        idempotencyKey: "generation",
        requestDigest: assetDigester.sha256("request"),
      },
      at: assetAt,
    },
    assetDigester,
  );
  const resultLink = createOperationResultLink(
    {
      actor: assetActor,
      generationLink: generation,
      configuration,
      packageDigest: assetDigester.sha256("package"),
      operation: {
        operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        operationRevision: 3,
        operationDigest: assetDigester.sha256("operation"),
        rawResultDigest: assetDigester.sha256("result"),
        observedAt: assetAt,
      },
      image: {
        filename: "fixture.png",
        url: "https://supplier.example/view/fixture.png",
        resultIndex: 0,
        providerReferenceJson: '{"asset":"fixture"}',
      },
    },
    assetDigester,
  );
  const selection = createCurrentConceptSelection(
    {
      actor: assetActor,
      resultLink,
      previous: null,
      expectedSelectionRevision: 0,
      at: assetAt,
    },
    assetDigester,
  );
  return {
    project: concept.project,
    brief: brief.brief,
    script: script.contentRevision,
    asset: asset.asset,
    content: asset.contentRevision,
    resultLink,
    selection,
  };
}
