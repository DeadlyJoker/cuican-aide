import { createHash } from "node:crypto";
import { createCreativeProject } from "./creative-project.ts";
import { createProjectConversationBinding } from "./project-conversation-binding.ts";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import { createProjectStageRunAdmission } from "./project-stage-run-admission.ts";
import {
  createProjectFoundation,
  type ProjectFoundation,
} from "./project-foundation.ts";
import { createProjectProposal } from "./project-proposal.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";

export const foundationRunDigester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
export function foundationRunAdmissionFixture(
  origin: "creative" | "novel" = "creative",
) {
  const d = foundationRunDigester;
  const at = "2026-10-08T00:00:00.000Z";
  const actor = {
    tenantId: "tenant",
    spaceId: "space",
    principalId: "principal",
    actorId: "human",
  };
  const installation = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "profile",
    pluginId: "crewon.short-drama",
    publisherId: "crewon",
    version: "40.0.0",
    packageDigest: d.sha256("actual fixture package bytes"),
    selectionRevision: 2,
  };
  const binding = createProjectConversationBinding(
    {
      bindingId: "binding",
      owner: actor,
      profileId: installation.profileId,
      projectId: "project",
      threadId: "thread",
      workspaceId: "actual-workspace",
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: at,
      updatedAt: at,
    },
    d,
  );
  const extensionBinding = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: installation.pluginId,
      actorId: actor.actorId,
      threadId: binding.threadId,
      runId: "run",
      configurationRevision: 1,
      configurationDigest: d.sha256("configuration"),
      target: {
        executionAuthority: "crewonKernel",
        agentVersionContentDigest: d.sha256("agent"),
        materializationDigest: d.sha256("materialization"),
        agentVersionId: "agent",
        authorityId: "authority",
        runtimeGeneration: "generation",
        policySnapshotId: "policy",
        workspaceBindingId: null,
      },
      inputDigest: d.sha256("original user content"),
      source: null,
    },
    d,
  );
  const admission = {
    schemaVersion: "crewon.plugin-task-admission.v1" as const,
    ...actor,
    ...installation,
    runId: extensionBinding.runId,
    threadId: binding.threadId,
    extensionBindingDigest: extensionBinding.bindingDigest,
    requestDigest: d.sha256("actual request"),
    idempotencyKey: "original-key",
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "authority-epoch",
  };
  const stageAdmission = createProjectStageRunAdmission(
    {
      actor,
      binding,
      admission,
      extensionBinding,
      stage: { kind: "discussion" },
      sources: { brief: null, outline: null },
      at,
    },
    d,
  );
  const project = createCreativeProject({
    actor,
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: binding.projectId,
    },
    title: "Foundation Run fixture",
    at,
  });
  const foundation = createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: project.revision,
    origin,
    parameters: {
      genre: null,
      episodeMode: "series",
      episodeCount: null,
      episodeDurationSeconds:
        origin === "novel" ? { minimum: 60, maximum: 120 } : null,
      aspectRatio: "9:16",
      visualStyle: origin === "novel" ? "semi-realistic" : null,
      needsCharacters: true,
      needsArt: true,
      adaptation:
        origin === "novel"
          ? {
              strategy: "core",
              retainedCharacters: ["林雨"],
              retainedScenes: [],
            }
          : null,
    },
    source:
      origin === "novel"
        ? { revision: 1, digest: d.sha256("canonical original source") }
        : null,
    creativeStartMode: origin === "creative" ? "confirm-plan" : null,
    at,
  });
  return {
    actor,
    binding,
    admission,
    extensionBinding,
    stageAdmission,
    foundation,
    latestProposal: null,
    at,
  };
}
export function foundationRunProposal(
  f: ReturnType<typeof foundationRunAdmissionFixture>,
  foundation: ProjectFoundation = f.foundation,
) {
  const project = createCreativeProject({
    actor: f.actor,
    scope: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      projectId: f.binding.projectId,
    },
    title: "Foundation Run fixture",
    at: f.at,
  });
  const candidate = createProjectProposal({
    project,
    foundation,
    actor: f.actor,
    expectedFoundationRevision: foundation.revision,
    previousProposal: null,
    expectedProposalRevision: 0,
    kind: foundation.origin === "novel" ? "novel-adaptation" : "creative-plan",
    text: "候选方案：雨夜重逢。",
    contentDigest: foundationRunDigester.sha256("placeholder"),
    at: f.at,
  });
  const { contentDigest: _, ...body } = candidate;
  return {
    ...body,
    contentDigest: foundationRunDigester.sha256(extensionCanonicalJson(body)),
  };
}
