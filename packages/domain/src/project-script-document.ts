import {
  copyExtensionJson,
  ExtensionManifestError,
} from "./extension-validation.ts";
import {
  projectTextOpaqueId,
  projectTextString,
} from "./project-text-content.ts";
import { DEFAULT_PARAMS } from "./third-party/shuohao-script/core.mjs";
import {
  PROJECT_SCRIPT_DOCUMENT_SCHEMA,
  MAX_PROJECT_SCRIPT_DOCUMENT_BYTES,
  MAX_PROJECT_SCRIPT_DOCUMENT_EPISODES,
  type ProjectScriptDocument,
  type ProjectScriptBeat,
  type ProjectScriptArtReferences,
} from "./project-script-document-types.ts";

export class ProjectScriptDocumentError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(code);
    this.name = "ProjectScriptDocumentError";
    this.code = code;
    this.path = path;
  }
}
function invalid(
  path: string,
  code = "project_script_document_invalid",
): never {
  throw new ProjectScriptDocumentError(code, path);
}
function detach(input: unknown): unknown {
  try {
    return copyExtensionJson(input, MAX_PROJECT_SCRIPT_DOCUMENT_BYTES);
  } catch (error) {
    if (error instanceof ExtensionManifestError)
      invalid(
        "$",
        error.code === "extension_json_limit"
          ? "project_script_document_limit"
          : "project_script_document_invalid",
      );
    throw error;
  }
}
function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
) {
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
  maximum = 4096,
  allowEmpty = false,
): string {
  try {
    return projectTextString(input, maximum, allowEmpty);
  } catch {
    return invalid(path);
  }
}
function id(input: unknown, path: string): string {
  try {
    return projectTextOpaqueId(input);
  } catch {
    return invalid(path);
  }
}
function number(
  input: unknown,
  path: string,
  maximum: number,
  minimum = 0,
  integer = false,
): number {
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input <= minimum ||
    input > maximum ||
    (integer && !Number.isSafeInteger(input))
  )
    invalid(path);
  return input;
}
function list<T>(
  input: unknown,
  path: string,
  maximum: number,
  parse: (value: unknown, at: string) => T,
): readonly T[] {
  if (!Array.isArray(input) || input.length > maximum) invalid(path);
  return Object.freeze(input.map((value, i) => parse(value, `${path}[${i}]`)));
}
function distinct(values: readonly (string | number)[], path: string): void {
  if (new Set(values).size !== values.length)
    invalid(path, "project_script_document_duplicate_identity");
}
function ids(input: unknown, path: string): readonly string[] {
  const values = list(input, path, 8192, id);
  distinct(values, path);
  return values;
}

/** Strict, detached content. Draft seeds are allowed; quality validation decides readiness. */
export function parseProjectScriptDocument(
  input: unknown,
): ProjectScriptDocument {
  const root = record(
    detach(input),
    ["schemaVersion", "source", "episodes"],
    ["params"],
    "$",
  );
  if (root.schemaVersion !== PROJECT_SCRIPT_DOCUMENT_SCHEMA)
    invalid("$.schemaVersion", "project_script_document_schema_unsupported");
  const rawParams = Object.hasOwn(root, "params")
    ? record(root.params, [], Object.keys(DEFAULT_PARAMS), "$.params")
    : {};
  const parameter = (key: keyof typeof DEFAULT_PARAMS): unknown =>
    Object.hasOwn(rawParams, key) ? rawParams[key] : DEFAULT_PARAMS[key];
  const tolerance = parameter("tolerance");
  const params = Object.freeze({
    charsPerSecond: number(
      parameter("charsPerSecond"),
      "$.params.charsPerSecond",
      100,
    ),
    actionSeconds: number(
      parameter("actionSeconds"),
      "$.params.actionSeconds",
      600,
    ),
    tolerance:
      tolerance === 0 ? 0 : number(tolerance, "$.params.tolerance", 0.99),
    maxLineChars: number(
      parameter("maxLineChars"),
      "$.params.maxLineChars",
      4096,
      0,
      true,
    ),
    hookWindow: number(
      parameter("hookWindow"),
      "$.params.hookWindow",
      8192,
      0,
      true,
    ),
  });
  const sceneKeys: string[] = [];
  const beatIds: string[] = [];
  const episodes = list(
    root.episodes,
    "$.episodes",
    MAX_PROJECT_SCRIPT_DOCUMENT_EPISODES,
    (raw, at) => {
      const episode = record(
        raw,
        [
          "episodeId",
          "ep",
          "targetSeconds",
          "hook",
          "cliff",
          "beatsClaimed",
          "hookBeat",
          "scenes",
        ],
        [],
        at,
      );
      const scenes = list(
        episode.scenes,
        at + ".scenes",
        8192,
        (rawScene, sceneAt) => {
          const scene = record(
            rawScene,
            ["sceneKey", "sceneId", "characters", "flow"],
            ["lighting", "props"],
            sceneAt,
          );
          const sceneKey = id(scene.sceneKey, sceneAt + ".sceneKey");
          sceneKeys.push(sceneKey);
          const flow = list<ProjectScriptBeat>(
            scene.flow,
            sceneAt + ".flow",
            8192,
            (rawBeat, beatAt) => {
              const value = record(
                rawBeat,
                ["beatId", "kind"],
                ["action", "speaker", "line", "delivery"],
                beatAt,
              );
              const beatId = id(value.beatId, beatAt + ".beatId");
              beatIds.push(beatId);
              if (value.kind === "action") {
                record(value, ["beatId", "kind", "action"], [], beatAt);
                return Object.freeze({
                  beatId,
                  kind: "action" as const,
                  action: text(value.action, beatAt + ".action"),
                });
              }
              if (value.kind !== "dialogue") invalid(beatAt + ".kind");
              record(
                value,
                ["beatId", "kind", "speaker", "line"],
                ["delivery"],
                beatAt,
              );
              return Object.freeze({
                beatId,
                kind: "dialogue" as const,
                speaker: id(value.speaker, beatAt + ".speaker"),
                line: text(value.line, beatAt + ".line"),
                ...(Object.hasOwn(value, "delivery")
                  ? {
                      delivery: text(
                        value.delivery,
                        beatAt + ".delivery",
                        2048,
                        true,
                      ),
                    }
                  : {}),
              });
            },
          );
          return Object.freeze({
            sceneKey,
            sceneId: id(scene.sceneId, sceneAt + ".sceneId"),
            characters: ids(scene.characters, sceneAt + ".characters"),
            flow,
            ...(Object.hasOwn(scene, "lighting")
              ? { lighting: text(scene.lighting, sceneAt + ".lighting", 256) }
              : {}),
            ...(Object.hasOwn(scene, "props")
              ? { props: ids(scene.props, sceneAt + ".props") }
              : {}),
          });
        },
      );
      return Object.freeze({
        episodeId: id(episode.episodeId, at + ".episodeId"),
        ep: number(
          episode.ep,
          at + ".ep",
          MAX_PROJECT_SCRIPT_DOCUMENT_EPISODES,
          0,
          true,
        ),
        targetSeconds: number(
          episode.targetSeconds,
          at + ".targetSeconds",
          3600,
        ),
        hook: text(episode.hook, at + ".hook", 4096, true),
        cliff: text(episode.cliff, at + ".cliff", 4096, true),
        beatsClaimed: ids(episode.beatsClaimed, at + ".beatsClaimed"),
        hookBeat:
          episode.hookBeat === null
            ? null
            : id(episode.hookBeat, at + ".hookBeat"),
        scenes,
      });
    },
  );
  if (episodes.length === 0) invalid("$.episodes");
  distinct(
    episodes.map((episode) => episode.episodeId),
    "$.episodes.episodeId",
  );
  distinct(
    episodes.map((episode) => episode.ep),
    "$.episodes.ep",
  );
  distinct(sceneKeys, "$.episodes.scenes.sceneKey");
  distinct(beatIds, "$.episodes.scenes.flow.beatId");
  return Object.freeze({
    schemaVersion: PROJECT_SCRIPT_DOCUMENT_SCHEMA,
    source: text(root.source, "$.source", 2048),
    params,
    episodes,
  });
}

export function parseProjectScriptArtReferences(
  input: unknown,
): ProjectScriptArtReferences {
  const root = record(detach(input), ["scenes", "props"], [], "$");
  const scenes = list(root.scenes, "$.scenes", 8192, (raw, at) => {
    const scene = record(raw, ["id", "lighting"], [], at);
    const lighting = list(
      scene.lighting,
      at + ".lighting",
      256,
      (raw, lightAt) => {
        const state = record(raw, ["state"], [], lightAt);
        return Object.freeze({
          state: text(state.state, lightAt + ".state", 256),
        });
      },
    );
    distinct(
      lighting.map((light) => light.state),
      at + ".lighting",
    );
    return Object.freeze({ id: id(scene.id, at + ".id"), lighting });
  });
  const props = list(root.props, "$.props", 8192, (raw, at) => {
    const prop = record(raw, ["id"], [], at);
    return Object.freeze({ id: id(prop.id, at + ".id") });
  });
  distinct(
    scenes.map((scene) => scene.id),
    "$.scenes",
  );
  distinct(
    props.map((prop) => prop.id),
    "$.props",
  );
  return Object.freeze({ scenes, props });
}
