import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";

export type ProjectConversationOutline = Readonly<{
  artifactId: string;
  contentRevision: number;
  episodes: readonly Readonly<{ episodeId: string; title: string }>[];
}>;

/** Read only the adopted revision, including all pages, through the mixed v1/v2 service. */
export async function readProjectConversationOutline(
  client: ControlApiClient,
  input: Readonly<{ projectId: string; briefRevision: number }>,
  options: Readonly<{ signal?: AbortSignal }>,
): Promise<ProjectConversationOutline | null> {
  let view;
  try {
    ({ view } = await client.projectOutlines.getOutline(
      { projectId: input.projectId },
      options,
    ));
  } catch (error) {
    // Only an older server missing this route may use the unchanged legacy protocol.
    if (
      !(
        error instanceof ControlApiClientError &&
        error.status === 404 &&
        error.code === "route_not_found"
      )
    )
      throw error;
    const legacy = await client.projectTexts.getOutline(
      input.projectId,
      options,
    );
    const selected = legacy.view?.selectedRevision;
    return selected?.kind === "outline" &&
      selected.brief.briefRevision === input.briefRevision
      ? {
          artifactId: selected.artifactId,
          contentRevision: selected.contentRevision,
          episodes: selected.content.episodes.map(({ episodeId, title }) => ({
            episodeId,
            title,
          })),
        }
      : null;
  }
  const selected = view?.selectedRevision;
  if (
    selected == null ||
    selected.brief.briefRevision !== input.briefRevision ||
    view!.staleReasons.length !== 0
  )
    return null;
  const episodes: { episodeId: string; title: string }[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = await client.projectOutlines.getSection(
      {
        projectId: input.projectId,
        artifactId: selected.artifactId,
        contentRevision: selected.contentRevision,
        contentDigest: selected.contentDigest,
        section: "episodes",
        afterIndex: cursor,
        limit: 10,
      },
      options,
    );
    if (
      page.totalItems !== selected.counts.episodes ||
      episodes.length + page.items.length > 240
    )
      invalid();
    for (const item of page.items) {
      if (
        typeof item.episodeId !== "string" ||
        !item.episodeId ||
        item.episodeId.length > 160 ||
        /[\u0000-\u001f\u007f]/u.test(item.episodeId) ||
        typeof item.title !== "string" ||
        new TextEncoder().encode(item.title).byteLength > 640 ||
        seen.has(item.episodeId)
      )
        invalid();
      seen.add(item.episodeId);
      episodes.push({ episodeId: item.episodeId, title: item.title });
    }
    if (page.nextIndex === null) break;
    if (page.nextIndex <= cursor) invalid();
    cursor = page.nextIndex;
  }
  options.signal?.throwIfAborted();
  return {
    artifactId: selected.artifactId,
    contentRevision: selected.contentRevision,
    episodes,
  };
}
function invalid(): never {
  throw new Error("project_conversation_outline_invalid");
}
