import type { PublicCreativeProject } from "@crewon/plugin-sdk/contracts";
import type { ConceptIntent, ConceptSnapshot } from "./ConceptController.types";

export function validConceptPrompt(prompt: string): boolean {
  return (
    Boolean(prompt.trim()) &&
    prompt.length <= 2000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(prompt)
  );
}
export function validConceptName(name: string): boolean {
  return (
    Boolean(name.trim()) &&
    [...name.trim()].length <= 160 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(name)
  );
}
export function conceptErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return error instanceof Error ? error.message : "";
}
export const initialConceptSnapshot = (): ConceptSnapshot => ({
  phase: "idle",
  assets: [],
  nextAfterAssetId: null,
  selection: null,
  opening: false,
  editing: false,
  draft: null,
  confirmedOldBrief: false,
  saving: false,
  pendingKind: null,
  failure: null,
  conflictRefreshed: false,
  error: null,
  notice: null,
  revisions: [],
  nextAfterAssetRevision: null,
  loadingHistory: false,
});

/** The existing metadata-save gate; external description copies obtain no additional write rights. */
export function canSaveConceptDraft(
  input: Readonly<{
    snapshot: ConceptSnapshot;
    project: PublicCreativeProject | null;
    available: boolean;
    operationBlocked: boolean;
    intent: ConceptIntent | null;
  }>,
): boolean {
  const { snapshot, project } = input;
  const draft = snapshot.draft;
  return (
    input.available &&
    !input.operationBlocked &&
    !snapshot.saving &&
    Boolean(draft) &&
    snapshot.editing &&
    project?.state === "active" &&
    validConceptPrompt(draft!.prompt) &&
    validConceptName(draft!.name) &&
    (draft!.source.briefRevision === project.latestBriefRevision ||
      snapshot.confirmedOldBrief) &&
    (!input.intent ||
      (snapshot.failure === "conflict" && snapshot.conflictRefreshed))
  );
}
