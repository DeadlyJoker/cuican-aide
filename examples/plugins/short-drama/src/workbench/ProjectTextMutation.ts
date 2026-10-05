import type {
  PluginProjectTextUiClient,
  ProjectTextMutationResponse,
  PublicProjectTextArtifactView,
} from "../project-texts-ui-service";
import type { TextIntent, TextSnapshot } from "./ProjectTextController.types";

export function projectTextConflict(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  return (
    typeof code === "string" &&
    /(?:revision_conflict|project_text_locked|project_text_dependencies_stale|project_text_(?:outline|brief)_reference_invalid|project_text_selection_required|idempotency_conflict|artifact_locked|project_archived)/u.test(
      code,
    )
  );
}

export function invokeTextIntent(
  client: PluginProjectTextUiClient,
  intent: TextIntent,
  signal: AbortSignal,
): Promise<ProjectTextMutationResponse> {
  const options = { signal };
  switch (intent.kind) {
    case "save-outline":
      return client.saveOutlineCandidate(intent.input, options);
    case "save-script":
      return client.saveScriptCandidate(intent.input, options);
    case "select-revision":
      return client.selectRevision(intent.input, options);
    case "set-lock":
      return client.setLocked(intent.input, options);
  }
}

export function projectTextMutationProjection(
  intent: TextIntent,
  result: ProjectTextMutationResponse,
  snapshot: TextSnapshot,
): Partial<TextSnapshot> {
  const saved = intent.kind === "save-outline" || intent.kind === "save-script";
  const view: PublicProjectTextArtifactView = {
    artifact: result.artifact,
    selectedRevision:
      intent.kind === "select-revision"
        ? result.contentRevision
        : (snapshot.view?.selectedRevision ?? null),
    dependencyState: snapshot.view?.dependencyState ?? "unselected",
    staleReasons: snapshot.view?.staleReasons ?? [],
  };
  return {
    saving: false,
    pendingKind: null,
    failure: null,
    view,
    ...(saved
      ? {
          content: result.contentRevision,
          draft: result.contentRevision?.content ?? snapshot.draft,
          dirty: false,
        }
      : {}),
    notice: saved
      ? "候选已保存，采用后成为后续阶段的来源。"
      : intent.kind === "select-revision"
        ? "已采用所选内容版本。"
        : result.artifact.locked
          ? "当前采用版本已锁定，仍可保存新的候选。"
          : "已解锁，可以采用其他版本。",
  };
}
