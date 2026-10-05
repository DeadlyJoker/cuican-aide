import { isDeepStrictEqual } from "node:util";
import {
  captureCreativeProjectCommitAuthority,
  type CreativeProjectCommitOptions,
  type CreativeProjectOwnerScope,
  type ProjectTextStore,
  type ProjectTextMutationIdentity,
  type ProjectTextMutationKind,
  type ProjectTextMutationResult,
} from "@crewon/application";
import {
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectTextRecord,
  projectTextFailure,
  saveProjectOutlineCandidate,
  saveProjectScriptCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
  validateCreativeProject,
  validateCreativeProjectActor,
  type CreativeProject,
  type ProjectBriefRevision,
  type ProjectOutlineRevision,
  type ProjectTextArtifact,
  type ProjectTextArtifactRevision,
} from "@crewon/domain";
import {
  creativeStoreDigester,
  creativeStoreOwner,
} from "./creative-project-store-records.ts";

export type TextInput<M extends keyof ProjectTextStore> = Parameters<
  ProjectTextStore[M]
>[0];
export type TextPrepared =
  | TextInput<"commitCandidate">
  | (TextInput<"commitSelection"> & { kind: "select-revision" })
  | (TextInput<"commitLock"> & { kind: "set-lock" });
export type TextIdentity = ProjectTextMutationIdentity & {
  owner: CreativeProjectOwnerScope;
};
export type TextRow = Record<string, unknown> | null | undefined;
export const textJson = (value: unknown): string => JSON.stringify(value);
export const textRequired = <T>(
  value: T | null,
  code = "project_text_store_record_invalid",
): T => value ?? projectTextFailure(code);
export function textEqual(a: unknown, b: unknown): void {
  if (!isDeepStrictEqual(a, b))
    projectTextFailure("project_text_store_recipe_invalid");
}
export function textAuthority(
  options: CreativeProjectCommitOptions | undefined,
) {
  const authority = captureCreativeProjectCommitAuthority(options, {
    allowTextUiTransaction: true,
    allowPlanTransaction: true,
  });
  if (authority?.transaction !== undefined)
    projectTextFailure("project_text_transaction_authority_unsupported");
  return authority;
}
export function textKind(kind: unknown): ProjectTextMutationKind {
  if (
    kind !== "save-outline" &&
    kind !== "save-script" &&
    kind !== "select-revision" &&
    kind !== "set-lock"
  )
    projectTextFailure("project_text_mutation_kind_invalid");
  return kind;
}
export function textIdentity(input: unknown): TextIdentity {
  const value = projectTextRecord(input, ["actor", "receipt", "kind"]);
  const actor = validateCreativeProjectActor(value.actor);
  const receipt = projectTextRecord(value.receipt, [
    "idempotencyKey",
    "requestDigest",
  ]);
  return Object.freeze({
    actor,
    owner: creativeStoreOwner({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      principalId: actor.principalId,
    }),
    kind: textKind(value.kind),
    receipt: Object.freeze({
      idempotencyKey: creativeProjectOpaqueId(receipt.idempotencyKey),
      requestDigest: creativeProjectDigest(receipt.requestDigest),
    }),
  });
}
const readFields = {
  loadOutline: ["owner", "projectId"],
  loadScript: ["owner", "projectId", "episodeId"],
  loadArtifact: ["owner", "projectId", "artifactId"],
  loadRevision: ["owner", "projectId", "artifactId", "contentRevision"],
  listArtifacts: ["owner", "projectId", "afterArtifactId", "limit"],
  listRevisions: [
    "owner",
    "projectId",
    "artifactId",
    "afterContentRevision",
    "limit",
  ],
} as const;
export function textRead<M extends keyof typeof readFields>(
  method: M,
  input: TextInput<M>,
): TextInput<M> {
  const value = projectTextRecord(input, readFields[method]);
  const out: Record<string, unknown> = {
    ...value,
    owner: creativeStoreOwner(value.owner),
    projectId: creativeProjectOpaqueId(value.projectId),
  };
  for (const key of ["artifactId", "episodeId"])
    if (key in value) out[key] = creativeProjectOpaqueId(value[key]);
  if ("afterArtifactId" in value)
    out.afterArtifactId =
      value.afterArtifactId === null
        ? null
        : creativeProjectOpaqueId(value.afterArtifactId);
  for (const key of ["contentRevision", "afterContentRevision"])
    if (key in value)
      out[key] = creativeProjectRevision(value[key], {
        minimum: key === "afterContentRevision" ? 0 : 1,
      });
  if ("limit" in value) {
    const limit = creativeProjectRevision(value.limit);
    if (limit > 16) projectTextFailure("project_text_limit_invalid");
    out.limit = limit;
  }
  return Object.freeze(out) as TextInput<M>;
}
function number(value: unknown): number {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value))
    value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    projectTextFailure("project_text_store_index_invalid");
  return value;
}
function same(a: unknown, b: unknown) {
  if (a !== b) projectTextFailure("project_text_store_index_invalid");
}
function json(row: Record<string, unknown>, field = "record_json"): unknown {
  const value = row[field];
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value) > 65_536)
    projectTextFailure("project_text_json_limit");
  try {
    return JSON.parse(value);
  } catch {
    projectTextFailure("project_text_store_record_invalid");
  }
}
function scope(
  row: Record<string, unknown>,
  record: {
    tenantId: string;
    spaceId: string;
    projectId: string;
    artifactId: string;
    kind: string;
    episodeId: string | null;
  },
  owner: CreativeProjectOwnerScope,
  projectId: string,
) {
  for (const [column, key] of [
    ["tenant_id", "tenantId"],
    ["space_id", "spaceId"],
    ["project_id", "projectId"],
    ["artifact_id", "artifactId"],
    ["kind", "kind"],
  ] as const)
    same(row[column], record[key]);
  same(row.episode_id, record.episodeId ?? "");
  same(row.owner_principal_id, owner.principalId);
  same(record.tenantId, owner.tenantId);
  same(record.spaceId, owner.spaceId);
  same(record.projectId, projectId);
}
export function decodeTextArtifact(
  row: TextRow,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  artifactId?: string,
): ProjectTextArtifact | null {
  if (row == null) return null;
  const artifact = parseProjectTextArtifact(json(row));
  scope(row, artifact, owner, projectId);
  same(artifact.ownerPrincipalId, owner.principalId);
  if (artifactId !== undefined) same(artifact.artifactId, artifactId);
  same(number(row.revision), artifact.revision);
  same(number(row.latest_content_revision), artifact.latestContentRevision);
  same(
    row.selected_content_revision === null
      ? null
      : number(row.selected_content_revision),
    artifact.selectedContentRevision,
  );
  same(number(row.locked), artifact.locked ? 1 : 0);
  return artifact;
}
export function decodeTextRevision(
  row: TextRow,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  artifactId: string,
): ProjectTextArtifactRevision | null {
  if (row == null) return null;
  const revision = parseProjectTextArtifactRevision(
    json(row),
    creativeStoreDigester,
  );
  scope(row, revision, owner, projectId);
  same(revision.artifactId, artifactId);
  same(number(row.content_revision), revision.contentRevision);
  same(row.content_digest, revision.contentDigest);
  same(number(row.brief_revision), revision.brief.briefRevision);
  same(row.brief_content_digest, revision.brief.contentDigest);
  same(row.outline_artifact_id, revision.outline?.artifactId ?? null);
  same(
    row.outline_content_revision === null
      ? null
      : number(row.outline_content_revision),
    revision.outline?.contentRevision ?? null,
  );
  same(row.outline_content_digest, revision.outline?.contentDigest ?? null);
  return revision;
}
export function decodeTextReceipt(
  row: TextRow,
  identity: TextIdentity,
): ProjectTextMutationResult | null {
  if (row == null) return null;
  for (const [column, expected] of [
    ["tenant_id", identity.actor.tenantId],
    ["space_id", identity.actor.spaceId],
    ["principal_id", identity.actor.principalId],
    ["actor_id", identity.actor.actorId],
    ["kind", identity.kind],
    ["idempotency_key", identity.receipt.idempotencyKey],
  ])
    same(row[column!], expected);
  if (row.request_digest !== identity.receipt.requestDigest)
    projectTextFailure("project_text_idempotency_conflict");
  const value = projectTextRecord(json(row, "result_json"), [
    "kind",
    "disposition",
    "artifact",
    "contentRevision",
  ]);
  same(value.kind, identity.kind);
  same(value.disposition, "committed");
  const artifact = parseProjectTextArtifact(value.artifact);
  if (
    (identity.kind === "save-outline" && artifact.kind !== "outline") ||
    (identity.kind === "save-script" && artifact.kind !== "script")
  )
    projectTextFailure("project_text_store_record_invalid");
  same(artifact.tenantId, identity.actor.tenantId);
  same(artifact.spaceId, identity.actor.spaceId);
  same(artifact.ownerPrincipalId, identity.actor.principalId);
  same(artifact.updatedByActorId, identity.actor.actorId);
  same(row.project_id, artifact.projectId);
  const revision =
    value.contentRevision === null
      ? null
      : parseProjectTextArtifactRevision(
          value.contentRevision,
          creativeStoreDigester,
        );
  if (identity.kind === "set-lock") {
    if (revision !== null)
      projectTextFailure("project_text_store_record_invalid");
  } else {
    const saved = textRequired(revision);
    assertCreativeProjectScope(artifact, saved);
    same(saved.artifactId, artifact.artifactId);
    same(saved.kind, artifact.kind);
    same(saved.episodeId, artifact.episodeId);
    same(
      saved.contentRevision,
      identity.kind === "select-revision"
        ? artifact.selectedContentRevision
        : artifact.latestContentRevision,
    );
  }
  return Object.freeze({
    kind: identity.kind,
    disposition: "replayed",
    artifact,
    contentRevision: revision,
  });
}
export function prepareText(
  kind: ProjectTextMutationKind,
  input: unknown,
): TextPrepared {
  const fields = [
    "actor",
    "receipt",
    "project",
    "expectedArtifactRevision",
    "artifact",
  ];
  if (kind === "save-outline" || kind === "save-script")
    fields.push("kind", "contentRevision");
  else if (kind === "select-revision") fields.push("contentRevision");
  const value = projectTextRecord(input, fields);
  if ("kind" in value && value.kind !== kind)
    projectTextFailure("project_text_mutation_kind_invalid");
  const identity = textIdentity({
    actor: value.actor,
    receipt: value.receipt,
    kind,
  });
  const project = validateCreativeProject(value.project);
  assertCreativeProjectOwner(project, identity.actor);
  const artifact = parseProjectTextArtifact(value.artifact);
  assertCreativeProjectScope(project, artifact);
  same(artifact.ownerPrincipalId, identity.actor.principalId);
  const common = {
    actor: identity.actor,
    receipt: identity.receipt,
    project,
    artifact,
    expectedArtifactRevision: creativeProjectRevision(
      value.expectedArtifactRevision,
      { minimum: kind === "save-outline" || kind === "save-script" ? 0 : 1 },
    ),
  };
  if (kind === "set-lock") return Object.freeze({ ...common, kind });
  const contentRevision = parseProjectTextArtifactRevision(
    value.contentRevision,
    creativeStoreDigester,
  );
  assertCreativeProjectScope(artifact, contentRevision);
  same(artifact.artifactId, contentRevision.artifactId);
  same(artifact.kind, contentRevision.kind);
  same(artifact.episodeId, contentRevision.episodeId);
  return Object.freeze({ ...common, kind, contentRevision });
}
export function prepareTextCandidate(input: unknown): TextPrepared {
  const value = projectTextRecord(input, [
    "actor",
    "receipt",
    "project",
    "expectedArtifactRevision",
    "artifact",
    "kind",
    "contentRevision",
  ]);
  if (value.kind !== "save-outline" && value.kind !== "save-script")
    projectTextFailure("project_text_mutation_kind_invalid");
  return prepareText(value.kind, value);
}
export type TextStored = {
  project: CreativeProject | null;
  artifact: ProjectTextArtifact | null;
  brief: ProjectBriefRevision | null;
  outline: ProjectTextArtifactRevision | null;
  revision: ProjectTextArtifactRevision | null;
  latestBrief: ProjectBriefRevision | null;
  selectedOutline: ProjectTextArtifactRevision | null;
};
export function verifyText(
  prepared: TextPrepared,
  stored: TextStored,
): ProjectTextMutationResult {
  const project = textRequired(stored.project, "creative_project_not_found");
  assertCreativeProjectScope(prepared.project, project);
  assertCreativeProjectOwner(project, prepared.actor);
  const common = {
    project,
    actor: prepared.actor,
    artifact: stored.artifact,
    expectedArtifactRevision: prepared.expectedArtifactRevision,
    at: prepared.artifact.updatedAt,
  };
  let next: {
    artifact: ProjectTextArtifact;
    contentRevision?: ProjectTextArtifactRevision;
  };
  if (prepared.kind === "save-outline" || prepared.kind === "save-script") {
    const brief = textRequired(
      stored.brief,
      "creative_project_brief_not_found",
    );
    textEqual(prepared.contentRevision.brief, {
      briefRevision: brief.briefRevision,
      contentDigest: brief.contentDigest,
    });
    const args = { ...common, artifactId: prepared.artifact.artifactId, brief };
    if (prepared.kind === "save-outline") {
      if (prepared.contentRevision.kind !== "outline")
        projectTextFailure("project_text_store_recipe_invalid");
      next = saveProjectOutlineCandidate(
        { ...args, content: prepared.contentRevision.content },
        creativeStoreDigester,
      );
    } else {
      if (prepared.contentRevision.kind !== "script")
        projectTextFailure("project_text_store_recipe_invalid");
      let outline: ProjectOutlineRevision | null = null;
      if (prepared.contentRevision.outline !== null) {
        const actual = textRequired(
          stored.outline,
          "project_text_revision_not_found",
        );
        if (actual.kind !== "outline")
          projectTextFailure("project_text_outline_reference_invalid");
        textEqual(prepared.contentRevision.outline, {
          artifactId: actual.artifactId,
          contentRevision: actual.contentRevision,
          contentDigest: actual.contentDigest,
        });
        outline = actual;
      }
      next = saveProjectScriptCandidate(
        {
          ...args,
          episodeId: prepared.contentRevision.episodeId,
          outline,
          content: prepared.contentRevision.content,
        },
        creativeStoreDigester,
      );
    }
    textEqual(prepared.contentRevision, next.contentRevision);
  } else {
    const artifact = textRequired(
      stored.artifact,
      "project_text_artifact_not_found",
    );
    if (prepared.kind === "set-lock")
      next = setProjectTextArtifactLocked({
        ...common,
        artifact,
        locked: prepared.artifact.locked,
      });
    else {
      const revision = textRequired(
        stored.revision,
        "project_text_revision_not_found",
      );
      textEqual(revision, prepared.contentRevision);
      if (
        stored.selectedOutline !== null &&
        stored.selectedOutline.kind !== "outline"
      )
        projectTextFailure("project_text_outline_reference_invalid");
      next = selectProjectTextRevision(
        {
          ...common,
          artifact,
          contentRevision: revision,
          latestBrief: textRequired(
            stored.latestBrief,
            "creative_project_brief_not_found",
          ),
          selectedOutline:
            stored.selectedOutline as ProjectOutlineRevision | null,
        },
        creativeStoreDigester,
      );
    }
  }
  textEqual(prepared.artifact, next.artifact);
  return Object.freeze({
    kind: prepared.kind,
    disposition: "committed",
    artifact: next.artifact,
    contentRevision: next.contentRevision ?? null,
  });
}
export function artifactValues(
  a: ProjectTextArtifact,
): (string | number | null)[] {
  return [
    a.tenantId,
    a.spaceId,
    a.projectId,
    a.artifactId,
    a.ownerPrincipalId,
    a.kind,
    a.episodeId ?? "",
    a.revision,
    a.latestContentRevision,
    a.selectedContentRevision,
    a.locked ? 1 : 0,
    textJson(a),
  ];
}
export function revisionValues(
  r: ProjectTextArtifactRevision,
): (string | number | null)[] {
  return [
    r.tenantId,
    r.spaceId,
    r.projectId,
    r.artifactId,
    r.kind,
    r.episodeId ?? "",
    r.contentRevision,
    r.contentDigest,
    r.brief.briefRevision,
    r.brief.contentDigest,
    r.outline?.artifactId ?? null,
    r.outline?.contentRevision ?? null,
    r.outline?.contentDigest ?? null,
    textJson(r),
  ];
}
export const artifactColumns =
  "tenant_id,space_id,project_id,artifact_id,owner_principal_id,kind,episode_id,revision,latest_content_revision,selected_content_revision,locked,record_json";
export const revisionColumns =
  "tenant_id,space_id,project_id,artifact_id,kind,episode_id,content_revision,content_digest,brief_revision,brief_content_digest,outline_artifact_id,outline_content_revision,outline_content_digest,record_json";
