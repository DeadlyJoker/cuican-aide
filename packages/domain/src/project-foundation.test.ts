import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreativeProject,
  setCreativeProjectState,
  validateCreativeProject,
} from "./creative-project.ts";
import { CreativeProjectError } from "./creative-project-validation.ts";
import {
  assertProjectFoundationDownstreamAllowed,
  confirmProjectProposal,
  createProjectFoundation,
  setProjectFoundationCreativeStartMode,
  setProjectFoundationSource,
  updateProjectFoundationParameters,
  validateProjectFoundation,
} from "./project-foundation.ts";
import type {
  ProjectCreationParameters,
  ProjectFoundation,
  ProjectFoundationMutationInput,
} from "./project-foundation.ts";
import { createProjectProposal } from "./project-proposal.ts";

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "owner",
  actorId: "human",
};
const at = "2026-10-08T00:00:00.000Z";
const earlier = "2026-10-07T23:00:00.000Z";
const project = createCreativeProject({
  scope,
  actor,
  title: "小说与创意",
  at,
});
const digest = `sha256:${"a".repeat(64)}`;
const anotherDigest = `sha256:${"b".repeat(64)}`;
const source = { revision: 1, digest };
const creativeParameters: ProjectCreationParameters = {
  genre: null,
  episodeMode: "series",
  episodeCount: null,
  episodeDurationSeconds: null,
  aspectRatio: "9:16",
  visualStyle: null,
  needsCharacters: true,
  needsArt: false,
  adaptation: null,
};
const novelParameters: ProjectCreationParameters = {
  ...creativeParameters,
  episodeDurationSeconds: { minimum: 60, maximum: 120 },
  visualStyle: "semi-realistic",
  adaptation: {
    strategy: "core",
    retainedCharacters: ["主角"],
    retainedScenes: ["相遇"],
  },
};

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof CreativeProjectError && error.code === code;
}

function creative(
  creativeStartMode: "confirm-plan" | "direct-script" = "confirm-plan",
) {
  return createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: 1,
    origin: "creative",
    parameters: creativeParameters,
    source: null,
    creativeStartMode,
    at,
  });
}

function novel() {
  return createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: 1,
    origin: "novel",
    parameters: novelParameters,
    source,
    creativeStartMode: null,
    at,
  });
}

function mutation(
  foundation: ProjectFoundation,
): ProjectFoundationMutationInput {
  return {
    project,
    foundation,
    actor,
    expectedFoundationRevision: foundation.revision,
    at: earlier,
  };
}

function proposal(foundation: ProjectFoundation) {
  return createProjectProposal({
    ...mutation(foundation),
    previousProposal: null,
    expectedProposalRevision: 0,
    kind: foundation.origin === "novel" ? "novel-adaptation" : "creative-plan",
    text: "保留人物，调整节奏。",
    contentDigest: digest,
  });
}

test("foundation is explicitly created without widening or changing legacy v0", () => {
  const before = JSON.stringify(project);
  const foundation = creative("direct-script");
  assert.equal(foundation.schemaVersion, "crewon.project-foundation.v1");
  assert.equal(foundation.ownerPrincipalId, actor.principalId);
  assert.equal(foundation.origin, "creative");
  assert.equal(foundation.revision, 1);
  assert.equal(foundation.parametersRevision, 1);
  assert.equal(foundation.confirmedProposal, null);
  assert.equal(foundation.creativeStartMode, "direct-script");
  assert.equal(foundation.createdByActorId, actor.actorId);
  const updated = updateProjectFoundationParameters({
    ...mutation(foundation),
    parameters: { ...creativeParameters, episodeCount: 120 },
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.parameters.episodeCount, 120);
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(validateCreativeProject(project), project);
  assert.equal(project.kind, "short-drama");
  assert.equal(project.revision, 1);
  assert.equal(project.latestBriefRevision, 0);
  assert.throws(
    () => validateProjectFoundation(null),
    hasCode("creative_project_object_invalid"),
  );
  assert.throws(
    () => validateProjectFoundation(project),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, origin: "creative" }),
    hasCode("creative_project_fields_invalid"),
  );
});

test("novel creation requires source and explicit parameters without inventing defaults", () => {
  const foundation = novel();
  assert.equal(foundation.parameters.genre, null);
  assert.equal(foundation.parameters.episodeCount, null);
  assert.equal(foundation.creativeStartMode, null);
  assert.deepEqual(foundation.source, source);
  const input = {
    project,
    actor,
    expectedProjectRevision: 1,
    origin: "novel" as const,
    parameters: novelParameters,
    source,
    creativeStartMode: null,
    at,
  };
  assert.throws(
    () => createProjectFoundation({ ...input, source: null }),
    hasCode("project_foundation_source_required"),
  );
  for (const field of [
    "adaptation",
    "episodeDurationSeconds",
    "visualStyle",
  ] as const) {
    assert.throws(
      () =>
        createProjectFoundation({
          ...input,
          parameters: { ...novelParameters, [field]: null },
        }),
      hasCode("project_foundation_novel_parameters_required"),
    );
  }
  assert.throws(
    () =>
      createProjectFoundation({ ...input, creativeStartMode: "direct-script" }),
    hasCode("project_foundation_start_mode_invalid"),
  );
  assert.throws(
    () =>
      createProjectFoundation({
        ...input,
        origin: "creative",
        creativeStartMode: "confirm-plan",
      }),
    hasCode("project_foundation_adaptation_not_applicable"),
  );
  assert.throws(
    () => createProjectFoundation({ ...input, expectedProjectRevision: 2 }),
    hasCode("creative_project_revision_conflict"),
  );
});

test("creative and novel foundations explicitly persist a single episode choice", () => {
  const creativeSingle = createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: 1,
    origin: "creative",
    parameters: {
      ...creativeParameters,
      episodeMode: "single",
      episodeCount: 1,
    },
    source: null,
    creativeStartMode: "direct-script",
    at,
  });
  assert.equal(creativeSingle.parameters.episodeMode, "single");
  assert.equal(creativeSingle.parameters.episodeCount, 1);
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: creativeSingle,
    proposal: null,
  });
  const novelSingle = createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: 1,
    origin: "novel",
    parameters: { ...novelParameters, episodeMode: "single", episodeCount: 1 },
    source,
    creativeStartMode: null,
    at,
  });
  assert.equal(novelSingle.parameters.episodeMode, "single");
  assert.equal(novelSingle.parameters.episodeCount, 1);
  const candidate = proposal(novelSingle);
  const confirmed = confirmProjectProposal({
    ...mutation(novelSingle),
    proposal: candidate,
  });
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: confirmed,
    proposal: candidate,
  });
});

test("records detach mutable input and freeze every retained nested value", () => {
  const mutable = structuredClone({
    project: { ...project },
    actor,
    expectedProjectRevision: 1,
    origin: "novel" as const,
    parameters: {
      ...novelParameters,
      episodeDurationSeconds: { ...novelParameters.episodeDurationSeconds! },
      adaptation: {
        ...novelParameters.adaptation!,
        retainedCharacters: [...novelParameters.adaptation!.retainedCharacters],
        retainedScenes: [...novelParameters.adaptation!.retainedScenes],
      },
    },
    source,
    creativeStartMode: null,
    at,
  });
  const foundation = createProjectFoundation(mutable);
  mutable.parameters.adaptation!.retainedCharacters = ["改写"];
  mutable.parameters.episodeDurationSeconds!.minimum = 1;
  mutable.source.digest = anotherDigest;
  mutable.actor.actorId = "changed";
  mutable.project.title = "changed";
  assert.deepEqual(foundation.parameters.adaptation!.retainedCharacters, [
    "主角",
  ]);
  assert.equal(foundation.parameters.episodeDurationSeconds!.minimum, 60);
  assert.equal(foundation.source!.digest, digest);
  assert.equal(foundation.createdByActorId, "human");
  for (const value of [
    foundation,
    foundation.parameters,
    foundation.parameters.adaptation,
    foundation.parameters.adaptation!.retainedCharacters,
    foundation.parameters.adaptation!.retainedScenes,
    foundation.parameters.episodeDurationSeconds,
    foundation.source,
  ])
    assert.ok(Object.isFrozen(value));
  const candidate = proposal(foundation);
  const confirmed = confirmProjectProposal({
    ...mutation(foundation),
    proposal: candidate,
  });
  assert.ok(Object.isFrozen(confirmed.confirmedProposal));
});

test("all mutation commands guard principal, project scope, CAS and archived state even on no-op", () => {
  const foundation = creative();
  const commands = [
    (base: ProjectFoundationMutationInput) =>
      updateProjectFoundationParameters({
        ...base,
        parameters: creativeParameters,
      }),
    (base: ProjectFoundationMutationInput) =>
      setProjectFoundationSource({ ...base, source: null }),
    (base: ProjectFoundationMutationInput) =>
      setProjectFoundationCreativeStartMode({
        ...base,
        creativeStartMode: "confirm-plan",
      }),
    (base: ProjectFoundationMutationInput) =>
      confirmProjectProposal({ ...base, proposal: proposal(foundation) }),
  ];
  const archived = setCreativeProjectState({
    project,
    actor,
    expectedProjectRevision: 1,
    state: "archived",
    at,
  });
  for (const command of commands) {
    assert.throws(
      () =>
        command({
          ...mutation(foundation),
          actor: { ...actor, principalId: "stranger" },
        }),
      hasCode("creative_project_owner_mismatch"),
    );
    assert.throws(
      () =>
        command({
          ...mutation(foundation),
          actor: { ...actor, tenantId: "other" },
        }),
      hasCode("creative_project_scope_mismatch"),
    );
    assert.throws(
      () =>
        command({
          ...mutation(foundation),
          foundation: { ...foundation, projectId: "other" },
        }),
      hasCode("creative_project_scope_mismatch"),
    );
    assert.throws(
      () =>
        command({
          ...mutation(foundation),
          foundation: { ...foundation, ownerPrincipalId: "stranger" },
        }),
      hasCode("creative_project_owner_mismatch"),
    );
    assert.throws(
      () => command({ ...mutation(foundation), expectedFoundationRevision: 2 }),
      hasCode("project_foundation_revision_conflict"),
    );
    assert.throws(
      () => command({ ...mutation(foundation), project: archived }),
      hasCode("creative_project_archived"),
    );
  }
  assert.throws(
    () =>
      createProjectFoundation({
        project: archived,
        actor,
        expectedProjectRevision: 2,
        origin: "creative",
        parameters: creativeParameters,
        source: null,
        creativeStartMode: "direct-script",
        at,
      }),
    hasCode("creative_project_archived"),
  );
  assert.throws(
    () =>
      createProjectFoundation({
        project,
        actor: { ...actor, principalId: "stranger" },
        expectedProjectRevision: 1,
        origin: "creative",
        parameters: creativeParameters,
        source: null,
        creativeStartMode: "direct-script",
        at,
      }),
    hasCode("creative_project_owner_mismatch"),
  );
});

test("parameter changes clear confirmation but preserve both proposal and foundation history", () => {
  const foundation = novel();
  const candidate = proposal(foundation);
  const confirmed = confirmProjectProposal({
    ...mutation(foundation),
    proposal: candidate,
  });
  assert.equal(confirmed.revision, 2);
  assert.equal(confirmed.parametersRevision, 1);
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: confirmed,
    proposal: candidate,
  });
  assert.deepEqual(
    confirmProjectProposal({ ...mutation(confirmed), proposal: candidate }),
    confirmed,
  );
  const noOp = updateProjectFoundationParameters({
    ...mutation(confirmed),
    parameters: novelParameters,
  });
  assert.deepEqual(noOp, confirmed);
  const changed = updateProjectFoundationParameters({
    ...mutation(confirmed),
    actor: { ...actor, actorId: "agent" },
    parameters: { ...novelParameters, episodeCount: 120 },
  });
  assert.equal(changed.revision, 3);
  assert.equal(changed.parametersRevision, 2);
  assert.equal(changed.confirmedProposal, null);
  assert.equal(changed.createdAt, at);
  assert.equal(changed.updatedAt, earlier);
  assert.equal(changed.updatedByActorId, "agent");
  assert.deepEqual(confirmed.confirmedProposal, { revision: 1, digest });
  assert.equal(candidate.foundationRevision, 1);
  assert.equal(candidate.parametersRevision, 1);
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation: changed,
        proposal: candidate,
      }),
    hasCode("project_foundation_proposal_confirmation_required"),
  );
  assert.throws(
    () => confirmProjectProposal({ ...mutation(changed), proposal: candidate }),
    hasCode("project_proposal_binding_stale"),
  );
});

test("source changes are monotonic, clear confirmation and can explicitly remove source", () => {
  const foundation = novel();
  const candidate = proposal(foundation);
  const confirmed = confirmProjectProposal({
    ...mutation(foundation),
    proposal: candidate,
  });
  assert.deepEqual(
    setProjectFoundationSource({ ...mutation(confirmed), source }),
    confirmed,
  );
  assert.throws(
    () =>
      setProjectFoundationSource({
        ...mutation(confirmed),
        source: { revision: 1, digest: anotherDigest },
      }),
    hasCode("project_foundation_source_digest_conflict"),
  );
  const changed = setProjectFoundationSource({
    ...mutation(confirmed),
    source: { revision: 2, digest: anotherDigest },
  });
  assert.equal(changed.revision, 3);
  assert.equal(changed.parametersRevision, 1);
  assert.equal(changed.confirmedProposal, null);
  assert.throws(
    () => setProjectFoundationSource({ ...mutation(changed), source }),
    hasCode("project_foundation_source_revision_stale"),
  );
  assert.throws(
    () => confirmProjectProposal({ ...mutation(changed), proposal: candidate }),
    hasCode("project_proposal_binding_stale"),
  );
  const removed = setProjectFoundationSource({
    ...mutation(changed),
    source: null,
  });
  assert.equal(removed.revision, 4);
  assert.equal(removed.source, null);
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation: removed,
        proposal: null,
      }),
    hasCode("project_foundation_source_required"),
  );
  assert.throws(
    () => proposal(removed),
    hasCode("project_foundation_source_required"),
  );
  assert.deepEqual(foundation.source, source);
  assert.deepEqual(confirmed.confirmedProposal, { revision: 1, digest });
  assert.deepEqual(candidate.source, source);
});

test("direct script requires an explicit creative choice and switching modes cancels confirmation", () => {
  const foundation = creative();
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation,
        proposal: null,
      }),
    hasCode("project_foundation_proposal_confirmation_required"),
  );
  const candidate = proposal(foundation);
  const confirmed = confirmProjectProposal({
    ...mutation(foundation),
    proposal: candidate,
  });
  const direct = setProjectFoundationCreativeStartMode({
    ...mutation(confirmed),
    creativeStartMode: "direct-script",
  });
  assert.equal(direct.revision, 3);
  assert.equal(direct.creativeStartMode, "direct-script");
  assert.equal(direct.confirmedProposal, null);
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: direct,
    proposal: null,
  });
  assert.deepEqual(
    setProjectFoundationCreativeStartMode({
      ...mutation(direct),
      creativeStartMode: "direct-script",
    }),
    direct,
  );
  const back = setProjectFoundationCreativeStartMode({
    ...mutation(direct),
    creativeStartMode: "confirm-plan",
  });
  assert.equal(back.revision, 4);
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation: back,
        proposal: candidate,
      }),
    hasCode("project_foundation_proposal_confirmation_required"),
  );
  assert.throws(
    () => confirmProjectProposal({ ...mutation(direct), proposal: candidate }),
    hasCode("project_foundation_start_mode_invalid"),
  );
  assert.throws(
    () =>
      setProjectFoundationCreativeStartMode({
        ...mutation(novel()),
        creativeStartMode: "direct-script",
      }),
    hasCode("project_foundation_start_mode_invalid"),
  );
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: creative("direct-script"),
    proposal: null,
  });
});

test("strict immutable boundaries reject unknown fields, getters, invalid pointers and overflow", () => {
  const foundation = creative();
  let invoked = false;
  const accessor = {
    ...foundation,
    get origin() {
      invoked = true;
      return "creative";
    },
  };
  assert.throws(
    () => validateProjectFoundation(accessor),
    hasCode("creative_project_json_invalid"),
  );
  assert.equal(invoked, false);
  assert.throws(
    () => validateProjectFoundation({ ...foundation, extra: true }),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () =>
      validateProjectFoundation({
        ...foundation,
        schemaVersion: "crewon.project-foundation.v0",
      }),
    hasCode("project_foundation_schema_unsupported"),
  );
  assert.throws(
    () => validateProjectFoundation({ ...foundation, origin: "unknown" }),
    hasCode("project_foundation_origin_invalid"),
  );
  assert.throws(
    () => validateProjectFoundation({ ...foundation, parametersRevision: 2 }),
    hasCode("project_foundation_revision_invariant_invalid"),
  );
  assert.throws(
    () =>
      validateProjectFoundation({
        ...foundation,
        source: { revision: 0, digest },
      }),
    hasCode("creative_project_revision_invalid"),
  );
  assert.throws(
    () =>
      validateProjectFoundation({
        ...foundation,
        source: { revision: 1, digest: digest.toUpperCase() },
      }),
    hasCode("creative_project_digest_invalid"),
  );
  assert.throws(
    () =>
      validateProjectFoundation({ ...foundation, confirmedProposal: source }),
    hasCode("project_foundation_confirmation_invariant_invalid"),
  );
  assert.throws(
    () => validateProjectFoundation({ ...foundation, creativeStartMode: null }),
    hasCode("project_foundation_start_mode_invalid"),
  );
  assert.throws(
    () =>
      validateProjectFoundation({
        ...foundation,
        revision: 2,
        parametersRevision: 2,
        confirmedProposal: source,
      }),
    hasCode("project_foundation_confirmation_invariant_invalid"),
  );
  assert.throws(
    () => validateProjectFoundation({ ...foundation, createdAt: "2026-10-08" }),
    hasCode("creative_project_timestamp_invalid"),
  );
  const exhausted = { ...foundation, revision: Number.MAX_SAFE_INTEGER };
  assert.throws(
    () =>
      updateProjectFoundationParameters({
        ...mutation(exhausted),
        parameters: { ...creativeParameters, episodeCount: 3 },
      }),
    hasCode("creative_project_revision_exhausted"),
  );
  assert.throws(
    () => setProjectFoundationSource({ ...mutation(exhausted), source }),
    hasCode("creative_project_revision_exhausted"),
  );
  assert.throws(
    () =>
      setProjectFoundationCreativeStartMode({
        ...mutation(exhausted),
        creativeStartMode: "direct-script",
      }),
    hasCode("creative_project_revision_exhausted"),
  );
});
