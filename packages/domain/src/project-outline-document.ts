import {
  copyExtensionJson,
  ExtensionManifestError,
} from "./extension-validation.ts";
import {
  projectTextOpaqueId,
  projectTextString,
} from "./project-text-content.ts";
import {
  PROJECT_OUTLINE_DOCUMENT_SCHEMA,
  MAX_PROJECT_OUTLINE_DOCUMENT_BYTES,
  MAX_PROJECT_OUTLINE_DOCUMENT_EPISODES,
  type ProjectOutlineDocument,
  type ProjectOutlineThresholds,
} from "./project-outline-document-types.ts";

export class ProjectOutlineDocumentError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(code);
    this.name = "ProjectOutlineDocumentError";
    this.code = code;
    this.path = path;
  }
}
function invalid(
  path: string,
  code = "project_outline_document_invalid",
): never {
  throw new ProjectOutlineDocumentError(code, path);
}
function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid(path);
  const value = input as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid(path);
  return value;
}
function text(
  input: unknown,
  path: string,
  maximum = 2048,
  allowEmpty = true,
): string {
  try {
    return projectTextString(input, maximum, allowEmpty);
  } catch {
    return invalid(path);
  }
}
function opaqueId(input: unknown, path: string): string {
  try {
    return projectTextOpaqueId(input);
  } catch {
    return invalid(path);
  }
}
function entityId(
  input: unknown,
  kind: "C" | "S" | "P" | "B",
  path: string,
): string {
  const value = text(input, path, 64, false);
  if (!new RegExp("^" + kind + "\\d{2,}$", "u").test(value)) invalid(path);
  return value;
}
function integer(input: unknown, path: string, maximum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximum
  )
    invalid(path);
  return input;
}
function list<T>(
  input: unknown,
  path: string,
  maximum: number,
  parse: (value: unknown, path: string) => T,
): readonly T[] {
  if (!Array.isArray(input) || input.length > maximum) invalid(path);
  return Object.freeze(
    input.map((value, index) => parse(value, `${path}[${index}]`)),
  );
}
function texts(input: unknown, path: string, maximum = 32): readonly string[] {
  return list(input, path, maximum, (value, at) =>
    text(value, at, 1024, false),
  );
}
function ids(
  input: unknown,
  path: string,
  kind: "C" | "S" | "P" | "B",
  maximum = 64,
): readonly string[] {
  const value = list(input, path, maximum, (item, at) =>
    entityId(item, kind, at),
  );
  if (new Set(value).size !== value.length)
    invalid(path, "project_outline_document_duplicate_reference");
  return value;
}
function unique<T extends { id: string }>(
  items: readonly T[],
  path: string,
): readonly T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalid(path, "project_outline_document_duplicate_identity");
  return items;
}
function decisions(input: unknown, path: string) {
  return list(input, path, 32, (raw, at) => {
    const item = record(raw, ["what", "why"], ["evidence"], at);
    return Object.freeze({
      what: text(item.what, at + ".what"),
      why: text(item.why, at + ".why"),
      ...(Object.hasOwn(item, "evidence")
        ? { evidence: text(item.evidence, at + ".evidence", 2048, false) }
        : {}),
    });
  });
}

/** Detached, immutable, bounded v2. The strict legacy v1 content parser is intentionally unchanged. */
export function parseProjectOutlineDocument(
  input: unknown,
): ProjectOutlineDocument {
  let copied: unknown;
  try {
    copied = copyExtensionJson(input, MAX_PROJECT_OUTLINE_DOCUMENT_BYTES);
  } catch (error) {
    if (error instanceof ExtensionManifestError)
      invalid(
        "$",
        error.code === "extension_json_limit"
          ? "project_outline_document_limit"
          : "project_outline_document_invalid",
      );
    throw error;
  }
  const root = record(
    copied,
    [
      "schemaVersion",
      "title",
      "logline",
      "synopsis",
      "source",
      "lang",
      "params",
      "adaptation",
      "characters",
      "scenes",
      "beats",
      "episodes",
    ],
    ["props"],
    "$",
  );
  if (root.schemaVersion !== PROJECT_OUTLINE_DOCUMENT_SCHEMA)
    invalid("$.schemaVersion", "project_outline_document_schema_unsupported");
  if (root.lang !== "zh" && root.lang !== "en") invalid("$.lang");
  const params = record(
    root.params,
    ["episodes", "minutesPerEpisode", "genre", "adaptMode"],
    ["preferences", "thresholds"],
    "$.params",
  );
  if (
    typeof params.minutesPerEpisode !== "number" ||
    !Number.isFinite(params.minutesPerEpisode) ||
    params.minutesPerEpisode <= 0 ||
    params.minutesPerEpisode > 60
  )
    invalid("$.params.minutesPerEpisode");
  if (
    params.adaptMode !== "忠实" &&
    params.adaptMode !== "抽核" &&
    params.adaptMode !== "借壳"
  )
    invalid("$.params.adaptMode");
  let thresholds: ProjectOutlineThresholds | undefined;
  if (Object.hasOwn(params, "thresholds")) {
    const keys = [
      "maxLeads",
      "maxSupport",
      "maxFunctional",
      "maxBeatGap",
      "maxProps",
      "maxPrimaryScenes",
    ] as const;
    const raw = record(params.thresholds, [], keys, "$.params.thresholds");
    thresholds = Object.freeze(
      Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
          key,
          value === 0 && key !== "maxLeads" && key !== "maxBeatGap"
            ? 0
            : integer(value, "$.params.thresholds." + key, 120),
        ]),
      ),
    );
  }
  const adaptation = record(
    root.adaptation,
    ["core", "keep", "cut", "merge", "risks"],
    ["cutNote", "mergeNote"],
    "$.adaptation",
  );
  const characters = unique(
    list(root.characters, "$.characters", 64, (raw, at) => {
      const item = record(
        raw,
        ["id", "name", "role", "tier", "from"],
        ["arc"],
        at,
      );
      if (
        item.tier !== "lead" &&
        item.tier !== "support" &&
        item.tier !== "functional"
      )
        invalid(at + ".tier");
      return Object.freeze({
        id: entityId(item.id, "C", at + ".id"),
        name: text(item.name, at + ".name", 640),
        role: text(item.role, at + ".role"),
        tier: item.tier,
        from: texts(item.from, at + ".from"),
        ...(Object.hasOwn(item, "arc")
          ? { arc: text(item.arc, at + ".arc", 4096) }
          : {}),
      });
    }),
    "$.characters",
  );
  const scenes = unique(
    list(root.scenes, "$.scenes", 64, (raw, at) => {
      const item = record(raw, ["id", "name", "primary"], ["reusePlan"], at);
      if (typeof item.primary !== "boolean") invalid(at + ".primary");
      return Object.freeze({
        id: entityId(item.id, "S", at + ".id"),
        name: text(item.name, at + ".name", 640),
        primary: item.primary,
        ...(Object.hasOwn(item, "reusePlan")
          ? { reusePlan: text(item.reusePlan, at + ".reusePlan") }
          : {}),
      });
    }),
    "$.scenes",
  );
  const props = Object.hasOwn(root, "props")
    ? unique(
        list(root.props, "$.props", 32, (raw, at) => {
          const item = record(raw, ["id", "name", "function"], ["beatIds"], at);
          return Object.freeze({
            id: entityId(item.id, "P", at + ".id"),
            name: text(item.name, at + ".name", 640),
            function: text(item.function, at + ".function"),
            ...(Object.hasOwn(item, "beatIds")
              ? { beatIds: ids(item.beatIds, at + ".beatIds", "B", 240) }
              : {}),
          });
        }),
        "$.props",
      )
    : undefined;
  const beats = unique(
    list(root.beats, "$.beats", 240, (raw, at) => {
      const item = record(
        raw,
        ["id", "type", "weight", "episodeId", "setup", "payoff"],
        [],
        at,
      );
      if (item.weight !== "major" && item.weight !== "minor")
        invalid(at + ".weight");
      return Object.freeze({
        id: entityId(item.id, "B", at + ".id"),
        type: text(item.type, at + ".type", 256),
        weight: item.weight,
        episodeId: opaqueId(item.episodeId, at + ".episodeId"),
        setup: text(item.setup, at + ".setup"),
        payoff: text(item.payoff, at + ".payoff"),
      });
    }),
    "$.beats",
  );
  const episodes = list(
    root.episodes,
    "$.episodes",
    MAX_PROJECT_OUTLINE_DOCUMENT_EPISODES,
    (raw, at) => {
      const item = record(
        raw,
        [
          "episodeId",
          "ep",
          "title",
          "summary",
          "hook",
          "suspense",
          "sceneIds",
          "characterIds",
        ],
        ["propIds", "crowdPlan", "warnings"],
        at,
      );
      return Object.freeze({
        episodeId: opaqueId(item.episodeId, at + ".episodeId"),
        ep: integer(item.ep, at + ".ep", MAX_PROJECT_OUTLINE_DOCUMENT_EPISODES),
        title: text(item.title, at + ".title", 640),
        summary: text(item.summary, at + ".summary", 8192),
        hook: text(item.hook, at + ".hook"),
        suspense: text(item.suspense, at + ".suspense"),
        sceneIds: ids(item.sceneIds, at + ".sceneIds", "S"),
        characterIds: ids(item.characterIds, at + ".characterIds", "C"),
        ...(Object.hasOwn(item, "propIds")
          ? { propIds: ids(item.propIds, at + ".propIds", "P", 32) }
          : {}),
        ...(Object.hasOwn(item, "crowdPlan")
          ? { crowdPlan: text(item.crowdPlan, at + ".crowdPlan") }
          : {}),
        ...(Object.hasOwn(item, "warnings")
          ? { warnings: texts(item.warnings, at + ".warnings", 16) }
          : {}),
      });
    },
  );
  if (new Set(episodes.map((item) => item.episodeId)).size !== episodes.length)
    invalid("$.episodes", "project_outline_document_duplicate_identity");
  return Object.freeze({
    schemaVersion: PROJECT_OUTLINE_DOCUMENT_SCHEMA,
    title: text(root.title, "$.title", 640, false),
    logline: text(root.logline, "$.logline"),
    synopsis: text(root.synopsis, "$.synopsis", 8192),
    source: text(root.source, "$.source", 640),
    lang: root.lang,
    params: Object.freeze({
      episodes: integer(
        params.episodes,
        "$.params.episodes",
        MAX_PROJECT_OUTLINE_DOCUMENT_EPISODES,
      ),
      minutesPerEpisode: params.minutesPerEpisode,
      genre: text(params.genre, "$.params.genre", 640),
      adaptMode: params.adaptMode,
      ...(Object.hasOwn(params, "preferences")
        ? { preferences: texts(params.preferences, "$.params.preferences") }
        : {}),
      ...(thresholds === undefined ? {} : { thresholds }),
    }),
    adaptation: Object.freeze({
      core: text(adaptation.core, "$.adaptation.core"),
      keep: decisions(adaptation.keep, "$.adaptation.keep"),
      cut: decisions(adaptation.cut, "$.adaptation.cut"),
      merge: decisions(adaptation.merge, "$.adaptation.merge"),
      risks: list(adaptation.risks, "$.adaptation.risks", 32, (raw, at) => {
        const item = record(raw, ["what", "plan"], [], at);
        return Object.freeze({
          what: text(item.what, at + ".what"),
          plan: text(item.plan, at + ".plan"),
        });
      }),
      ...(Object.hasOwn(adaptation, "cutNote")
        ? {
            cutNote: text(
              adaptation.cutNote,
              "$.adaptation.cutNote",
              2048,
              false,
            ),
          }
        : {}),
      ...(Object.hasOwn(adaptation, "mergeNote")
        ? {
            mergeNote: text(
              adaptation.mergeNote,
              "$.adaptation.mergeNote",
              2048,
              false,
            ),
          }
        : {}),
    }),
    characters,
    scenes,
    ...(props === undefined ? {} : { props }),
    beats,
    episodes,
  });
}
