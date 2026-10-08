import { parseProjectOutlineDocument } from "./project-outline-document.ts";
import type { ProjectOutlineCharacterTier } from "./project-outline-document-types.ts";

type EpisodeUse = Readonly<{ episodeId: string; ep: number }>;
type Requirement = Readonly<{
  entityId: string;
  name: string;
  episodes: readonly EpisodeUse[];
}>;
export type ProjectOutlineAssetRequirements = Readonly<{
  characters: readonly (Requirement &
    Readonly<{ tier: ProjectOutlineCharacterTier; role: string }>)[];
  scenes: readonly (Requirement &
    Readonly<{ primary: boolean; reusePlan: string | null }>)[];
  props: readonly (Requirement &
    Readonly<{ function: string; beatIds: readonly string[] }>)[];
}>;

/** Derived production requirements, not generated or saved image assets. All uses retain stable episode identities. */
export function projectOutlineAssetRequirements(
  input: unknown,
): ProjectOutlineAssetRequirements {
  const document = parseProjectOutlineDocument(input);
  const uses = (
    kind: "characterIds" | "sceneIds" | "propIds",
    entityId: string,
  ) =>
    Object.freeze(
      document.episodes
        .filter((episode) => episode[kind]?.includes(entityId))
        .map((episode) =>
          Object.freeze({ episodeId: episode.episodeId, ep: episode.ep }),
        ),
    );
  return Object.freeze({
    characters: Object.freeze(
      document.characters.map((character) =>
        Object.freeze({
          entityId: character.id,
          name: character.name,
          tier: character.tier,
          role: character.role,
          episodes: uses("characterIds", character.id),
        }),
      ),
    ),
    scenes: Object.freeze(
      document.scenes.map((scene) =>
        Object.freeze({
          entityId: scene.id,
          name: scene.name,
          primary: scene.primary,
          reusePlan: scene.reusePlan ?? null,
          episodes: uses("sceneIds", scene.id),
        }),
      ),
    ),
    props: Object.freeze(
      (document.props ?? []).map((prop) =>
        Object.freeze({
          entityId: prop.id,
          name: prop.name,
          function: prop.function,
          beatIds: prop.beatIds ?? Object.freeze([]),
          episodes: uses("propIds", prop.id),
        }),
      ),
    ),
  });
}
