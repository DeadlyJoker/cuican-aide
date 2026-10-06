import type { PluginProjectAssetUiClient } from "../project-assets-service";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { MediaInputReference } from "../project-media-inputs-ui-client";

export type MediaAssetChoice = Readonly<{
  label: string;
  visualPrompt: string;
  reference: MediaInputReference;
}>;
export type MediaScriptChoice = Readonly<{
  label: string;
  episodeId: string;
  artifactId: string;
  contentRevision: number;
}>;
/** Read one bounded source page. Only actual, current adopted versions become choices. */
export async function readMediaInputSources(input: {
  projectId: string;
  briefRevision: number;
  afterAssetId: string | null;
  afterArtifactId: string | null;
  assets: Pick<PluginProjectAssetUiClient, "listAssets" | "getAsset">;
  texts: Pick<PluginProjectTextUiClient, "listArtifacts" | "getArtifact">;
  signal: AbortSignal;
}) {
  const options = { signal: input.signal };
  const [assets, texts] = await Promise.all([
    input.assets.listAssets(
      {
        projectId: input.projectId,
        afterAssetId: input.afterAssetId,
        limit: 8,
      },
      options,
    ),
    input.texts.listArtifacts(
      {
        projectId: input.projectId,
        afterArtifactId: input.afterArtifactId,
        limit: 8,
      },
      options,
    ),
  ]);
  const assetChoices: MediaAssetChoice[] = [];
  // Bounded sequential detail reads avoid an unbounded pool of in-flight module requests.
  for (const asset of assets.assets) {
    if (asset.kind !== "character" && asset.kind !== "scene") continue;
    if (
      asset.selectedContentRevision === null ||
      asset.selectedReferenceRevision === null
    )
      continue;
    input.signal.throwIfAborted();
    const { view } = await input.assets.getAsset(
      { projectId: input.projectId, assetId: asset.assetId },
      options,
    );
    if (
      !view ||
      view.dependencyState !== "current" ||
      view.referenceState !== "current" ||
      !view.selectedContentRevision ||
      !view.selectedReferenceRevision ||
      view.selectedContentRevision.brief.briefRevision !== input.briefRevision
    )
      continue;
    assetChoices.push(
      Object.freeze({
        label: view.selectedContentRevision.content.name,
        visualPrompt: view.selectedContentRevision.content.visualPrompt,
        reference: Object.freeze({
          projectId: input.projectId,
          assetId: asset.assetId,
          kind: asset.kind,
          expectedAssetRevision: view.asset.revision,
          contentRevision: view.selectedContentRevision.contentRevision,
          referenceRevision: view.selectedReferenceRevision.referenceRevision,
        }),
      }),
    );
  }
  const scriptChoices: MediaScriptChoice[] = [];
  for (const artifact of texts.artifacts) {
    if (artifact.kind !== "script" || artifact.selectedContentRevision === null)
      continue;
    input.signal.throwIfAborted();
    const { view } = await input.texts.getArtifact(
      { projectId: input.projectId, artifactId: artifact.artifactId },
      options,
    );
    const revision = view?.selectedRevision;
    if (
      !view ||
      view.dependencyState !== "current" ||
      revision?.kind !== "script" ||
      revision.brief.briefRevision !== input.briefRevision
    )
      continue;
    scriptChoices.push(
      Object.freeze({
        label: revision.content.title,
        episodeId: revision.episodeId,
        artifactId: revision.artifactId,
        contentRevision: revision.contentRevision,
      }),
    );
  }
  return {
    assets: assetChoices,
    scripts: scriptChoices,
    nextAssetId: assets.nextAssetId,
    nextArtifactId: texts.nextArtifactId,
  };
}
