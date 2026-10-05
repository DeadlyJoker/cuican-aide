import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import { parsePublicProjectAssetContent } from "../project-assets-codec.mjs";
import type {
  AssetDraft,
  AssetSnapshot,
  AssetScriptSource,
} from "./ProjectAssetController.types";

export function validAssetDraft(draft: AssetDraft | null): boolean {
  if (!draft) return false;
  try {
    parsePublicProjectAssetContent(draft.content);
    return true;
  } catch {
    return false;
  }
}

export function assetDraftFromRevision(
  content: NonNullable<AssetSnapshot["content"]>,
): AssetDraft {
  return {
    kind: content.kind,
    content: { ...content.content },
    briefRevision: content.brief.briefRevision,
    script: content.script
      ? { ...content.script, title: `剧本 ${content.script.episodeId}` }
      : null,
  };
}

/** Recover the recorded immutable source; current selection is never substituted. */
export async function readAssetDraftScript(
  input: Readonly<{
    texts: Pick<PluginProjectTextUiClient, "getRevision">;
    projectId: string;
    source: Readonly<{ artifactId: string; contentRevision: number }> | null;
    signal: AbortSignal;
  }>,
): Promise<AssetScriptSource | null> {
  if (input.source === null) return null;
  const { contentRevision: revision } = await input.texts.getRevision(
    { projectId: input.projectId, ...input.source },
    { signal: input.signal },
  );
  if (
    revision.kind !== "script" ||
    revision.episodeId === null ||
    revision.projectId !== input.projectId ||
    revision.artifactId !== input.source.artifactId ||
    revision.contentRevision !== input.source.contentRevision
  )
    throw new Error("project_asset_recovery_script_invalid");
  return {
    ...input.source,
    episodeId: revision.episodeId,
    title: revision.content.title,
  };
}
