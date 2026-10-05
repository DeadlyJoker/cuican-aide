import {
  parseProjectAssetContent,
  projectAssetFailure,
  projectAssetId,
  projectAssetKind,
  projectAssetRecord,
  projectAssetRevision,
  type ProjectAssetContent,
  type ProjectAssetKind,
} from "@crewon/domain";

export type ProjectAssetMutationKind =
  | "save-content"
  | "select-content"
  | "set-lock"
  | "save-reference"
  | "select-reference";
type Common = Readonly<{
  projectId: string;
  expectedAssetRevision: number;
  idempotencyKey: string;
}>;
export type SaveProjectAssetCandidateCommand = Common &
  Readonly<{
    assetId: string | null;
    kind: ProjectAssetKind;
    briefRevision: number;
    script: Readonly<{ artifactId: string; contentRevision: number }> | null;
    content: ProjectAssetContent;
  }>;
export type SelectProjectAssetRevisionCommand = Common &
  Readonly<{ assetId: string; contentRevision: number }>;
export type SetProjectAssetLockedCommand = Common &
  Readonly<{ assetId: string; locked: boolean }>;
export type SaveProjectAssetReferenceCandidateCommand = Common &
  Readonly<{
    assetId: string;
    assetContentRevision: number;
    conceptAssetId: string;
    selectionRevision: number;
  }>;
export type SelectProjectAssetReferenceCommand = Common &
  Readonly<{ assetId: string; referenceRevision: number }>;
export type ProjectAssetMutationCommand =
  | SaveProjectAssetCandidateCommand
  | SelectProjectAssetRevisionCommand
  | SetProjectAssetLockedCommand
  | SaveProjectAssetReferenceCandidateCommand
  | SelectProjectAssetReferenceCommand;

/** One strict command shape shared by authenticated UI and independently qualified Agent callers. */
export function parseProjectAssetMutationCommand(
  kind: ProjectAssetMutationKind,
  input: unknown,
): ProjectAssetMutationCommand {
  const extra =
    kind === "save-content"
      ? ["kind", "briefRevision", "script", "content"]
      : kind === "select-content"
        ? ["contentRevision"]
        : kind === "set-lock"
          ? ["locked"]
          : kind === "save-reference"
            ? ["assetContentRevision", "conceptAssetId", "selectionRevision"]
            : kind === "select-reference"
              ? ["referenceRevision"]
              : projectAssetFailure("project_asset_command_invalid");
  const value = projectAssetRecord(input, [
    "projectId",
    "assetId",
    "expectedAssetRevision",
    "idempotencyKey",
    ...extra,
  ]);
  const common = {
    projectId: projectAssetId(value.projectId),
    expectedAssetRevision: projectAssetRevision(
      value.expectedAssetRevision,
      kind === "save-content" ? 0 : 1,
    ),
    idempotencyKey: projectAssetId(value.idempotencyKey),
  };
  if (common.idempotencyKey.includes(","))
    projectAssetFailure("project_asset_idempotency_key_invalid");
  if (kind === "save-content") {
    const script =
      value.script === null
        ? null
        : projectAssetRecord(value.script, ["artifactId", "contentRevision"]);
    const assetId =
      value.assetId === null ? null : projectAssetId(value.assetId);
    if ((assetId === null) !== (common.expectedAssetRevision === 0))
      projectAssetFailure("project_asset_creation_invalid");
    return Object.freeze({
      ...common,
      assetId,
      kind: projectAssetKind(value.kind),
      briefRevision: projectAssetRevision(value.briefRevision),
      script:
        script === null
          ? null
          : Object.freeze({
              artifactId: projectAssetId(script.artifactId),
              contentRevision: projectAssetRevision(script.contentRevision),
            }),
      content: parseProjectAssetContent(value.content),
    });
  }
  const assetId = projectAssetId(value.assetId);
  if (kind === "select-content")
    return Object.freeze({
      ...common,
      assetId,
      contentRevision: projectAssetRevision(value.contentRevision),
    });
  if (kind === "set-lock") {
    if (typeof value.locked !== "boolean")
      projectAssetFailure("project_asset_lock_invalid");
    return Object.freeze({ ...common, assetId, locked: value.locked });
  }
  if (kind === "save-reference")
    return Object.freeze({
      ...common,
      assetId,
      assetContentRevision: projectAssetRevision(value.assetContentRevision),
      conceptAssetId: projectAssetId(value.conceptAssetId),
      selectionRevision: projectAssetRevision(value.selectionRevision),
    });
  return Object.freeze({
    ...common,
    assetId,
    referenceRevision: projectAssetRevision(value.referenceRevision),
  });
}
