import { copyExtensionJson, extensionRecord } from "./extension-validation.ts";
import { parseProjectOutlineDocument } from "./project-outline-document.ts";
import {
  projectTextFailure,
  projectTextOpaqueId,
} from "./project-text-content.ts";
import type {
  ProjectOutlineDocument,
  ProjectOutlineCharacter,
  ProjectOutlineScene,
  ProjectOutlineProp,
  ProjectOutlineBeat,
  ProjectOutlineEpisode,
} from "./project-outline-document-types.ts";

/** A small original command can build a large immutable document without widening v1 transport or model context. */
export const MAX_PROJECT_OUTLINE_CHANGE_BYTES = 48 * 1024;
export const MAX_PROJECT_OUTLINE_CHANGE_ITEMS = 10;
export type ProjectOutlineOverview = Pick<
  ProjectOutlineDocument,
  "title" | "logline" | "synopsis" | "source" | "lang" | "params"
>;
type Collections = Readonly<{
  characters: ProjectOutlineCharacter;
  scenes: ProjectOutlineScene;
  props: ProjectOutlineProp;
  beats: ProjectOutlineBeat;
  episodes: ProjectOutlineEpisode;
}>;
export type ProjectOutlineDocumentChange =
  | Readonly<{ kind: "initialize"; document: ProjectOutlineDocument }>
  | Readonly<{ kind: "overview"; value: ProjectOutlineOverview }>
  | Readonly<{
      kind: "adaptation";
      value: ProjectOutlineDocument["adaptation"];
    }>
  | {
      [K in keyof Collections]: Readonly<{
        kind: "upsert";
        collection: K;
        items: readonly Collections[K][];
        removeIds: readonly string[];
      }>;
    }[keyof Collections];

export function parseProjectOutlineDocumentChange(
  input: unknown,
): ProjectOutlineDocumentChange {
  const value = copyExtensionJson(input, MAX_PROJECT_OUTLINE_CHANGE_BYTES);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "initialize") {
    const fields = extensionRecord(value, ["kind", "document"]);
    return Object.freeze({
      kind,
      document: parseProjectOutlineDocument(fields.document),
    });
  }
  if (kind === "overview" || kind === "adaptation") {
    const fields = extensionRecord(value, ["kind", "value"]);
    // Validate this section with the same whole-document parser, including all field limits.
    const checked = parseProjectOutlineDocument({
      ...emptyDocument,
      ...(kind === "overview"
        ? extensionRecord(fields.value, [
            "title",
            "logline",
            "synopsis",
            "source",
            "lang",
            "params",
          ])
        : { adaptation: fields.value }),
    });
    return kind === "overview"
      ? Object.freeze({ kind, value: overview(checked) })
      : Object.freeze({ kind, value: checked.adaptation });
  }
  if (kind !== "upsert") invalid();
  const fields = extensionRecord(value, [
    "kind",
    "collection",
    "items",
    "removeIds",
  ]);
  const collection = fields.collection;
  if (
    typeof collection !== "string" ||
    !collections.includes(collection as keyof Collections)
  )
    invalid();
  if (
    !Array.isArray(fields.items) ||
    fields.items.length > MAX_PROJECT_OUTLINE_CHANGE_ITEMS ||
    !Array.isArray(fields.removeIds) ||
    fields.removeIds.length > MAX_PROJECT_OUTLINE_CHANGE_ITEMS
  )
    invalid();
  const checked = parseProjectOutlineDocument({
    ...emptyDocument,
    [collection]: fields.items,
  });
  const items = checked[collection as keyof Collections] ?? [];
  const removeIds = fields.removeIds.map(projectTextOpaqueId);
  if (
    new Set(removeIds).size !== removeIds.length ||
    items.some((item) => removeIds.includes(identity(item)))
  )
    invalid();
  return Object.freeze({
    kind,
    collection,
    items,
    removeIds: Object.freeze(removeIds),
  }) as ProjectOutlineDocumentChange;
}

/** Patch only the requested fields. Stable identities, unsupplied fields and ordering survive each batch. */
export function changeProjectOutlineDocument(
  base: ProjectOutlineDocument | null,
  input: ProjectOutlineDocumentChange,
): ProjectOutlineDocument {
  const change = parseProjectOutlineDocumentChange(input);
  if (change.kind === "initialize") return change.document;
  if (base === null) projectTextFailure("project_outline_base_required");
  const current = parseProjectOutlineDocument(base);
  if (change.kind === "overview")
    return parseProjectOutlineDocument({ ...current, ...change.value });
  if (change.kind === "adaptation")
    return parseProjectOutlineDocument({
      ...current,
      adaptation: change.value,
    });
  const items = new Map<string, Collections[keyof Collections]>(
    (current[change.collection] ?? []).map((item) => [identity(item), item]),
  );
  for (const id of change.removeIds) {
    if (!items.delete(id)) projectTextFailure("project_outline_item_not_found");
  }
  for (const item of change.items) items.set(identity(item), item);
  const list = [...items.values()];
  if (change.collection === "episodes")
    list.sort(
      (a, b) =>
        (a as ProjectOutlineEpisode).ep - (b as ProjectOutlineEpisode).ep,
    );
  return parseProjectOutlineDocument({ ...current, [change.collection]: list });
}
export function projectOutlineOverview(
  input: ProjectOutlineDocument,
): ProjectOutlineOverview {
  return overview(parseProjectOutlineDocument(input));
}
function overview(value: ProjectOutlineDocument): ProjectOutlineOverview {
  return Object.freeze({
    title: value.title,
    logline: value.logline,
    synopsis: value.synopsis,
    source: value.source,
    lang: value.lang,
    params: value.params,
  });
}
function identity(item: Collections[keyof Collections]): string {
  return "episodeId" in item ? item.episodeId : item.id;
}
const collections = [
  "characters",
  "scenes",
  "props",
  "beats",
  "episodes",
] as const;
const emptyDocument = Object.freeze<ProjectOutlineDocument>({
  schemaVersion: "crewon.project-outline-document.v2",
  title: "草稿",
  logline: "",
  synopsis: "",
  source: "",
  lang: "zh",
  params: { episodes: 1, minutesPerEpisode: 1, genre: "", adaptMode: "忠实" },
  adaptation: { core: "", keep: [], cut: [], merge: [], risks: [] },
  characters: [],
  scenes: [],
  beats: [],
  episodes: [],
});
function invalid(): never {
  projectTextFailure("project_outline_change_invalid");
}
