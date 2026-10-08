import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreativeProject,
  setCreativeProjectState,
} from "./creative-project.ts";
import { CreativeProjectError } from "./creative-project-validation.ts";
import {
  assertProjectFoundationDownstreamAllowed,
  confirmProjectProposal,
  createProjectFoundation,
  setProjectFoundationSource,
  updateProjectFoundationParameters,
} from "./project-foundation.ts";
import type { ProjectFoundation } from "./project-foundation.ts";
import {
  createProjectProposal,
  validateProjectProposal,
} from "./project-proposal.ts";
import type { CreateProjectProposalInput } from "./project-proposal.ts";

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "owner",
  actorId: "human",
};
const at = "2026-10-08T00:00:00.000Z";
const project = createCreativeProject({ scope, actor, title: "方案测试", at });
const digest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;
const parameters = {
  genre: null,
  episodeMode: "series" as const,
  episodeCount: null,
  episodeDurationSeconds: null,
  aspectRatio: "9:16" as const,
  visualStyle: null,
  needsCharacters: true,
  needsArt: true,
  adaptation: null,
};
const creative = createProjectFoundation({
  project,
  actor,
  expectedProjectRevision: 1,
  origin: "creative",
  parameters,
  source: null,
  creativeStartMode: "confirm-plan",
  at,
});
const novel = createProjectFoundation({
  project,
  actor,
  expectedProjectRevision: 1,
  origin: "novel",
  parameters: {
    ...parameters,
    episodeDurationSeconds: { minimum: 60, maximum: 120 },
    visualStyle: "hand-drawn",
    adaptation: {
      strategy: "faithful",
      retainedCharacters: [],
      retainedScenes: [],
    },
  },
  source: { revision: 3, digest },
  creativeStartMode: null,
  at,
});

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof CreativeProjectError && error.code === code;
}

function input(
  foundation: ProjectFoundation = creative,
): CreateProjectProposalInput {
  return {
    project,
    foundation,
    actor,
    expectedFoundationRevision: foundation.revision,
    previousProposal: null,
    expectedProposalRevision: 0,
    kind:
      foundation.origin === "creative" ? "creative-plan" : "novel-adaptation",
    text: "  方案正文\n人物与剧情  ",
    contentDigest: digest,
    at,
  };
}

function mutation(foundation: ProjectFoundation) {
  return {
    project,
    foundation,
    actor,
    expectedFoundationRevision: foundation.revision,
    at,
  };
}

test("candidate versions retain exact content, current bindings and detached immutable audit", () => {
  const mutable = structuredClone({
    ...input(novel),
    foundation: { ...novel },
    actor: { ...actor },
  });
  const before = JSON.stringify(novel);
  const first = createProjectProposal(mutable);
  mutable.text = "改写";
  mutable.actor.actorId = "agent";
  mutable.foundation.source = { revision: 99, digest: otherDigest };
  assert.equal(first.revision, 1);
  assert.equal(first.kind, "novel-adaptation");
  assert.equal(first.foundationRevision, novel.revision);
  assert.equal(first.parametersRevision, novel.parametersRevision);
  assert.deepEqual(first.source, novel.source);
  assert.equal(first.text, "  方案正文\n人物与剧情  ");
  assert.equal(first.createdByActorId, actor.actorId);
  assert.equal(first.ownerPrincipalId, actor.principalId);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.source));
  assert.equal(JSON.stringify(novel), before);
  assert.equal(novel.confirmedProposal, null);
  const second = createProjectProposal({
    ...input(novel),
    previousProposal: first,
    expectedProposalRevision: 1,
    text: "新方案",
    contentDigest: otherDigest,
    actor: { ...actor, actorId: "agent" },
  });
  assert.equal(second.revision, 2);
  assert.equal(second.createdByActorId, "agent");
  assert.equal(first.revision, 1);
  assert.equal(first.text, "  方案正文\n人物与剧情  ");
  assert.equal(project.revision, 1);
  assert.equal(novel.revision, 1);
});

test("proposal history uses its own CAS independent of the foundation revision", () => {
  const first = createProjectProposal(input());
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        previousProposal: first,
        expectedProposalRevision: 0,
      }),
    hasCode("project_proposal_revision_conflict"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        previousProposal: null,
        expectedProposalRevision: 1,
      }),
    hasCode("project_proposal_revision_conflict"),
  );
  const confirmed = confirmProjectProposal({
    ...mutation(creative),
    proposal: first,
  });
  const changed = updateProjectFoundationParameters({
    ...mutation(confirmed),
    parameters: { ...parameters, episodeCount: 120 },
  });
  const second = createProjectProposal({
    ...input(changed),
    previousProposal: first,
    expectedProposalRevision: 1,
    contentDigest: otherDigest,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.foundationRevision, 3);
  assert.equal(second.parametersRevision, 2);
  assert.throws(
    () =>
      createProjectProposal({
        ...input(changed),
        previousProposal: second,
        expectedProposalRevision: 1,
      }),
    hasCode("project_proposal_revision_conflict"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(changed),
        previousProposal: first,
        expectedProposalRevision: 1,
        expectedFoundationRevision: 2,
      }),
    hasCode("project_foundation_revision_conflict"),
  );
});

test("saving a new candidate preserves the current selection until explicit confirmation", () => {
  const first = createProjectProposal(input(novel));
  const confirmed = confirmProjectProposal({
    ...mutation(novel),
    proposal: first,
  });
  const second = createProjectProposal({
    ...input(confirmed),
    previousProposal: first,
    expectedProposalRevision: 1,
    text: "待审阅的新方案",
    contentDigest: otherDigest,
  });
  assert.deepEqual(confirmed.confirmedProposal, { revision: 1, digest });
  assert.equal(confirmed.revision, 2);
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: confirmed,
    proposal: first,
  });
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation: confirmed,
        proposal: second,
      }),
    hasCode("project_foundation_confirmed_proposal_mismatch"),
  );
  const adopted = confirmProjectProposal({
    ...mutation(confirmed),
    proposal: second,
  });
  assert.equal(adopted.revision, 3);
  assert.deepEqual(adopted.confirmedProposal, {
    revision: 2,
    digest: otherDigest,
  });
  assertProjectFoundationDownstreamAllowed({
    project,
    actor,
    foundation: adopted,
    proposal: second,
  });
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation: adopted,
        proposal: first,
      }),
    hasCode("project_foundation_confirmed_proposal_mismatch"),
  );
  assert.throws(
    () => confirmProjectProposal({ ...mutation(adopted), proposal: first }),
    hasCode("project_proposal_binding_stale"),
  );
  assert.deepEqual(
    confirmProjectProposal({ ...mutation(adopted), proposal: second }),
    adopted,
  );
});

test("novel and creative proposal kinds cannot cross origin or overwrite another owner/scope", () => {
  const first = createProjectProposal(input());
  assert.throws(
    () => createProjectProposal({ ...input(), kind: "novel-adaptation" }),
    hasCode("project_proposal_kind_mismatch"),
  );
  assert.throws(
    () => createProjectProposal({ ...input(novel), kind: "creative-plan" }),
    hasCode("project_proposal_kind_mismatch"),
  );
  for (const field of ["tenantId", "spaceId", "projectId"] as const) {
    const foreign = { ...first, [field]: "another" };
    assert.throws(
      () =>
        createProjectProposal({
          ...input(),
          previousProposal: foreign,
          expectedProposalRevision: 1,
        }),
      hasCode("creative_project_scope_mismatch"),
    );
    assert.throws(
      () =>
        confirmProjectProposal({ ...mutation(creative), proposal: foreign }),
      hasCode("creative_project_scope_mismatch"),
    );
  }
  const foreignOwner = { ...first, ownerPrincipalId: "another" };
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        previousProposal: foreignOwner,
        expectedProposalRevision: 1,
      }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      confirmProjectProposal({ ...mutation(creative), proposal: foreignOwner }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(novel),
        previousProposal: first,
        expectedProposalRevision: 1,
      }),
    hasCode("project_proposal_kind_mismatch"),
  );
});

test("candidate creation guards authenticated owner, active state, current base and history bounds", () => {
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        actor: { ...actor, principalId: "other" },
      }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        actor: { ...actor, spaceId: "other" },
      }),
    hasCode("creative_project_scope_mismatch"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        foundation: { ...creative, projectId: "other" },
      }),
    hasCode("creative_project_scope_mismatch"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        foundation: { ...creative, ownerPrincipalId: "other" },
      }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () => createProjectProposal({ ...input(), expectedFoundationRevision: 2 }),
    hasCode("project_foundation_revision_conflict"),
  );
  const archived = setCreativeProjectState({
    project,
    actor,
    expectedProjectRevision: 1,
    state: "archived",
    at,
  });
  assert.throws(
    () => createProjectProposal({ ...input(), project: archived }),
    hasCode("creative_project_archived"),
  );
  const first = createProjectProposal(input());
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        previousProposal: { ...first, foundationRevision: 2 },
        expectedProposalRevision: 1,
      }),
    hasCode("project_proposal_previous_invalid"),
  );
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        previousProposal: {
          ...first,
          foundationRevision: 2,
          parametersRevision: 2,
        },
        expectedProposalRevision: 1,
      }),
    hasCode("project_proposal_previous_invalid"),
  );
});

test("confirmation rejects stale foundation, parameter and source bindings separately", () => {
  const first = createProjectProposal(input(novel));
  assert.throws(
    () =>
      confirmProjectProposal({
        ...mutation(novel),
        proposal: { ...first, foundationRevision: 2 },
      }),
    hasCode("project_proposal_binding_stale"),
  );
  const changed = updateProjectFoundationParameters({
    ...mutation(novel),
    parameters: { ...novel.parameters, episodeCount: 120 },
  });
  assert.throws(
    () => confirmProjectProposal({ ...mutation(changed), proposal: first }),
    hasCode("project_proposal_binding_stale"),
  );
  const fresh = createProjectProposal(input(changed));
  assert.throws(
    () =>
      confirmProjectProposal({
        ...mutation(changed),
        proposal: { ...fresh, parametersRevision: 1 },
      }),
    hasCode("project_proposal_binding_stale"),
  );
  for (const changedSource of [
    { revision: 4, digest },
    { revision: 3, digest: otherDigest },
  ]) {
    assert.throws(
      () =>
        confirmProjectProposal({
          ...mutation(novel),
          proposal: { ...first, source: changedSource },
        }),
      hasCode("project_proposal_binding_stale"),
    );
  }
  const sourceChanged = setProjectFoundationSource({
    ...mutation(novel),
    source: { revision: 4, digest: otherDigest },
  });
  assert.throws(
    () =>
      confirmProjectProposal({ ...mutation(sourceChanged), proposal: first }),
    hasCode("project_proposal_binding_stale"),
  );
});

test("downstream uses the actual confirmed immutable proposal and retains all identity/archival guards", () => {
  const first = createProjectProposal(input(novel));
  const confirmed = confirmProjectProposal({
    ...mutation(novel),
    proposal: first,
  });
  const downstream = { project, actor, foundation: confirmed, proposal: first };
  assertProjectFoundationDownstreamAllowed(downstream);
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        proposal: null,
      }),
    hasCode("project_foundation_proposal_confirmation_required"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        foundation: novel,
      }),
    hasCode("project_foundation_proposal_confirmation_required"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        proposal: { ...first, contentDigest: otherDigest },
      }),
    hasCode("project_foundation_confirmed_proposal_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        proposal: { ...first, revision: 2 },
      }),
    hasCode("project_foundation_confirmed_proposal_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        proposal: { ...first, foundationRevision: 2 },
      }),
    hasCode("project_proposal_binding_stale"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        actor: { ...actor, principalId: "other" },
      }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        proposal: { ...first, projectId: "other" },
      }),
    hasCode("creative_project_scope_mismatch"),
  );
  const archived = setCreativeProjectState({
    project,
    actor,
    expectedProjectRevision: 1,
    state: "archived",
    at,
  });
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        ...downstream,
        project: archived,
      }),
    hasCode("creative_project_archived"),
  );
  const direct = createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: 1,
    origin: "creative",
    parameters,
    source: null,
    creativeStartMode: "direct-script",
    at,
  });
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project,
        actor,
        foundation: direct,
        proposal: { ...first, projectId: "other" },
      }),
    hasCode("creative_project_scope_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectFoundationDownstreamAllowed({
        project: archived,
        actor,
        foundation: direct,
        proposal: null,
      }),
    hasCode("creative_project_archived"),
  );
});

test("proposal text is bounded by UTF8 bytes while keeping significant whitespace", () => {
  const exact = `${"文".repeat(2_730)}ab`;
  assert.equal(new TextEncoder().encode(exact).length, 8_192);
  assert.equal(createProjectProposal({ ...input(), text: exact }).text, exact);
  assert.throws(
    () => createProjectProposal({ ...input(), text: `${exact}c` }),
    hasCode("creative_project_text_limit"),
  );
  assert.throws(
    () => createProjectProposal({ ...input(), text: " \n\t " }),
    hasCode("creative_project_text_invalid"),
  );
  assert.throws(
    () => createProjectProposal({ ...input(), text: "正文\u0000" }),
    hasCode("creative_project_text_invalid"),
  );
  assert.throws(
    () => createProjectProposal({ ...input(), text: "\ud800" }),
    hasCode("creative_project_json_invalid"),
  );
  assert.throws(
    () => createProjectProposal({ ...input(), text: "x".repeat(65_537) }),
    hasCode("creative_project_json_limit"),
  );
});

test("strict proposal schema rejects unknown keys, untrusted accessors, malformed digests and impossible revisions", () => {
  const first = createProjectProposal(input());
  let invoked = false;
  assert.throws(
    () =>
      validateProjectProposal({
        ...first,
        get text() {
          invoked = true;
          return "unexpected";
        },
      }),
    hasCode("creative_project_json_invalid"),
  );
  assert.equal(invoked, false);
  assert.throws(
    () => validateProjectProposal({ ...first, extra: null }),
    hasCode("creative_project_fields_invalid"),
  );
  const extraInput = { ...input(), extra: null };
  assert.throws(
    () => createProjectProposal(extraInput),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () =>
      validateProjectProposal({
        ...first,
        schemaVersion: "crewon.project-proposal.v0",
      }),
    hasCode("project_proposal_schema_unsupported"),
  );
  assert.throws(
    () => validateProjectProposal({ ...first, kind: "plan" }),
    hasCode("project_proposal_kind_invalid"),
  );
  assert.throws(
    () => validateProjectProposal({ ...first, parametersRevision: 2 }),
    hasCode("project_proposal_revision_invariant_invalid"),
  );
  assert.throws(
    () => validateProjectProposal({ ...first, revision: 0 }),
    hasCode("creative_project_revision_invalid"),
  );
  assert.throws(
    () =>
      validateProjectProposal({
        ...first,
        contentDigest: `sha256:${"A".repeat(64)}`,
      }),
    hasCode("creative_project_digest_invalid"),
  );
  assert.throws(
    () =>
      validateProjectProposal({
        ...first,
        source: { revision: 1, digest: "sha256:broken" },
      }),
    hasCode("creative_project_digest_invalid"),
  );
  assert.throws(
    () =>
      validateProjectProposal({
        ...first,
        kind: "novel-adaptation",
        source: null,
      }),
    hasCode("project_foundation_source_required"),
  );
  assert.throws(
    () => validateProjectProposal({ ...first, createdAt: "2026-10-08" }),
    hasCode("creative_project_timestamp_invalid"),
  );
  const exhausted = { ...first, revision: Number.MAX_SAFE_INTEGER };
  assert.throws(
    () =>
      createProjectProposal({
        ...input(),
        previousProposal: exhausted,
        expectedProposalRevision: Number.MAX_SAFE_INTEGER,
      }),
    hasCode("creative_project_revision_exhausted"),
  );
  const exhaustedFoundation = {
    ...creative,
    revision: Number.MAX_SAFE_INTEGER,
  };
  const lastCandidate = createProjectProposal(input(exhaustedFoundation));
  assert.throws(
    () =>
      confirmProjectProposal({
        ...mutation(exhaustedFoundation),
        proposal: lastCandidate,
      }),
    hasCode("creative_project_revision_exhausted"),
  );
});
