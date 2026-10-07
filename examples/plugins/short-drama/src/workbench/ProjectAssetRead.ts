import type {
  PluginProjectAssetUiClient,
  PublicProjectAssetRevision,
  PublicProjectAssetView,
} from "../project-assets-v2-service";

/** Read exactly the requested immutable version, or only the current head. Never write or ACK. */
export async function readAssetVersion(
  input: Readonly<{
    client: PluginProjectAssetUiClient;
    projectId: string;
    assetId: string;
    revision: number | "latest" | null;
    signal: AbortSignal;
    isCurrent(): boolean;
  }>,
): Promise<Readonly<{
  view: PublicProjectAssetView;
  content: PublicProjectAssetRevision | null;
}> | null> {
  const options = { signal: input.signal };
  const { view } = await input.client.getAsset(
    { projectId: input.projectId, assetId: input.assetId },
    options,
  );
  if (!input.isCurrent()) return null;
  if (!view) throw new Error("project_asset_missing");
  let content: PublicProjectAssetRevision | null = null;
  if (input.revision !== null) {
    const result = await input.client.getRevision(
      {
        projectId: input.projectId,
        assetId: input.assetId,
        contentRevision:
          input.revision === "latest"
            ? view.asset.latestContentRevision
            : input.revision,
      },
      options,
    );
    if (!input.isCurrent()) return null;
    content = result.contentRevision;
  }
  return { view, content };
}
