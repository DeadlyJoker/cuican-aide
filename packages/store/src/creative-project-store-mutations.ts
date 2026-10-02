import type {
  CreativeProjectStore,
  CreativeProjectMutationKind,
  CreativeProjectMutationResult,
} from "@crewon/application";
import {
  validateCreativeProject,
  validateConceptAsset,
  parseProjectBriefRevision,
  parseConceptAssetRevision,
  creativeProjectRevision,
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  createCreativeProject,
  renameCreativeProject,
  setCreativeProjectState,
  appendProjectBriefRevision,
  createConceptAsset,
  appendConceptAssetRevision,
  type CreativeProject,
  type ProjectBriefRevision,
  type ConceptAsset,
} from "@crewon/domain";
import {
  creativeStoreRecord,
  creativeMutationIdentity,
  creativeMutationKind,
  creativeRecordJson,
  creativeStoreFailure,
  creativeStoreDigester,
} from "./creative-project-store-records.ts";

export type PreparedCreativeMutation =
  | (Parameters<CreativeProjectStore["commitProjectCreation"]>[0] & {
      kind: "create-project";
    })
  | (Omit<
      Parameters<CreativeProjectStore["commitProjectMetadata"]>[0],
      "kind"
    > & { kind: "rename-project" })
  | (Omit<
      Parameters<CreativeProjectStore["commitProjectMetadata"]>[0],
      "kind"
    > & { kind: "set-project-state" })
  | (Parameters<CreativeProjectStore["commitProjectBrief"]>[0] & {
      kind: "append-brief";
    })
  | Parameters<CreativeProjectStore["commitConceptRevision"]>[0];

export function prepareCreativeMutation(
  kind: CreativeProjectMutationKind,
  input: unknown,
): PreparedCreativeMutation {
  creativeMutationKind(kind);
  const fields = ["actor", "receipt", "project"];
  if (kind === "create-project") fields.push("initialBrief");
  else fields.push("expectedProjectRevision");
  if (kind === "rename-project" || kind === "set-project-state")
    fields.push("kind");
  if (kind === "append-brief") fields.push("brief");
  if (kind === "create-concept" || kind === "append-concept")
    fields.push("kind", "asset", "assetRevision");
  if (kind === "append-concept") fields.push("expectedAssetMetadataRevision");
  const value = creativeStoreRecord(input, fields);
  if ("kind" in value && value.kind !== kind)
    creativeStoreFailure("creative_project_mutation_kind_invalid");
  const identity = creativeMutationIdentity({
    actor: value.actor,
    receipt: value.receipt,
    kind,
  });
  const project = validateCreativeProject(value.project);
  assertCreativeProjectOwner(project, identity.actor);
  const common = { actor: identity.actor, receipt: identity.receipt, project };
  if (kind === "create-project") {
    const initialBrief = parseProjectBriefRevision(
      value.initialBrief,
      creativeStoreDigester,
    );
    assertCreativeProjectScope(project, initialBrief);
    return Object.freeze({ ...common, kind, initialBrief });
  }
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  if (kind === "rename-project" || kind === "set-project-state")
    return Object.freeze({ ...common, kind, expectedProjectRevision });
  if (kind === "append-brief") {
    const brief = parseProjectBriefRevision(value.brief, creativeStoreDigester);
    assertCreativeProjectScope(project, brief);
    return Object.freeze({ ...common, kind, expectedProjectRevision, brief });
  }
  const asset = validateConceptAsset(value.asset);
  const assetRevision = parseConceptAssetRevision(
    value.assetRevision,
    creativeStoreDigester,
  );
  assertCreativeProjectScope(project, asset);
  assertCreativeProjectScope(project, assetRevision);
  if (asset.assetId !== assetRevision.assetId)
    creativeStoreFailure("creative_project_scope_mismatch");
  if (kind === "create-concept")
    return Object.freeze({
      ...common,
      kind,
      expectedProjectRevision,
      asset,
      assetRevision,
    });
  return Object.freeze({
    ...common,
    kind,
    expectedProjectRevision,
    asset,
    assetRevision,
    expectedAssetMetadataRevision: creativeProjectRevision(
      value.expectedAssetMetadataRevision,
    ),
  });
}

/** Recompute each prepared recipe against the records read in the locked transaction. */
export function verifyCreativeMutation(
  input: PreparedCreativeMutation,
  stored: {
    project: CreativeProject | null;
    brief: ProjectBriefRevision | null;
    asset: ConceptAsset | null;
  },
): CreativeProjectMutationResult {
  if (input.kind === "create-project") {
    if (stored.project !== null)
      creativeStoreFailure("creative_project_revision_conflict");
    const initial = createCreativeProject({
      scope: scope(input.project),
      actor: input.actor,
      title: input.project.title,
      at: input.project.createdAt,
    });
    const next = appendProjectBriefRevision(
      {
        project: initial,
        actor: input.actor,
        expectedProjectRevision: 1,
        text: input.initialBrief.text,
        at: input.initialBrief.createdAt,
      },
      creativeStoreDigester,
    );
    equal(input.project, next.project);
    equal(input.initialBrief, next.brief);
    // Creation has a single audit instant, even if clocks later move backwards.
    if (input.project.createdAt !== input.initialBrief.createdAt)
      creativeStoreFailure("creative_project_store_recipe_invalid");
    return Object.freeze({
      kind: input.kind,
      disposition: "committed",
      ...next,
    });
  }
  if (stored.project === null)
    creativeStoreFailure("creative_project_not_found");
  const project = validateCreativeProject(stored.project);
  assertCreativeProjectScope(input.project, project);
  assertCreativeProjectOwner(project, input.actor);
  const common = {
    project,
    actor: input.actor,
    expectedProjectRevision: input.expectedProjectRevision,
    at: input.project.updatedAt,
  };
  if (input.kind === "rename-project" || input.kind === "set-project-state") {
    const next =
      input.kind === "rename-project"
        ? renameCreativeProject({ ...common, title: input.project.title })
        : setCreativeProjectState({ ...common, state: input.project.state });
    equal(input.project, next);
    return Object.freeze({
      kind: input.kind,
      disposition: "committed",
      project: next,
    });
  }
  if (input.kind === "append-brief") {
    const next = appendProjectBriefRevision(
      { ...common, text: input.brief.text, at: input.brief.createdAt },
      creativeStoreDigester,
    );
    equal(input.project, next.project);
    equal(input.brief, next.brief);
    return Object.freeze({
      kind: input.kind,
      disposition: "committed",
      ...next,
    });
  }
  // Domain validates scope/digest, but only storage can prove this exact brief exists.
  if (stored.brief === null)
    creativeStoreFailure("creative_project_brief_not_found");
  const brief = parseProjectBriefRevision(stored.brief, creativeStoreDigester);
  assertCreativeProjectScope(project, brief);
  if (
    brief.briefRevision !== input.assetRevision.briefRevision ||
    brief.contentDigest !== input.assetRevision.briefContentDigest
  )
    creativeStoreFailure("creative_project_brief_reference_invalid");
  const args = {
    ...common,
    brief,
    prompt: input.assetRevision.prompt,
    at: input.assetRevision.createdAt,
  };
  const next =
    input.kind === "create-concept"
      ? (() => {
          if (stored.asset !== null)
            creativeStoreFailure("creative_project_asset_revision_conflict");
          return createConceptAsset(
            { ...args, assetId: input.asset.assetId, name: input.asset.name },
            creativeStoreDigester,
          );
        })()
      : (() => {
          if (stored.asset === null)
            creativeStoreFailure("creative_project_asset_not_found");
          return appendConceptAssetRevision(
            {
              ...args,
              asset: stored.asset,
              expectedAssetMetadataRevision:
                input.expectedAssetMetadataRevision,
            },
            creativeStoreDigester,
          );
        })();
  equal(input.project, next.project);
  equal(input.asset, next.asset);
  equal(input.assetRevision, next.assetRevision);
  return Object.freeze({ kind: input.kind, disposition: "committed", ...next });
}

function scope(project: CreativeProject) {
  return {
    tenantId: project.tenantId,
    spaceId: project.spaceId,
    projectId: project.projectId,
  };
}

function equal(actual: unknown, expected: unknown): void {
  if (creativeRecordJson(actual) !== creativeRecordJson(expected))
    creativeStoreFailure("creative_project_store_recipe_invalid");
}
