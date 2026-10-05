import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectTitle,
} from "./creative-project-validation.ts";
import type {
  ProjectOutlineContent,
  ProjectScriptContent,
} from "./project-text-types.ts";

export const MAX_PROJECT_OUTLINE_CONTENT_BYTES = 16 * 1024;
export const MAX_PROJECT_SCRIPT_CONTENT_BYTES = 32 * 1024;
export const MAX_PROJECT_OUTLINE_EPISODES = 16;
export const MAX_PROJECT_SCRIPT_SCENES = 32;
export const MAX_PROJECT_SCENE_DIALOGUE = 64;

export class ProjectTextError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectTextError";
    this.code = code;
  }
}
export function projectTextFailure(code: string): never {
  throw new ProjectTextError(code);
}
/** Only the new text locators reject dot segments; original project and actor schemas are unchanged. */
export function projectTextOpaqueId(input: unknown): string {
  const value = creativeProjectOpaqueId(input);
  if (value === "." || value === "..")
    projectTextFailure("project_text_identity_invalid");
  return value;
}
export function projectTextRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  return creativeProjectRecord(input, fields);
}
export function projectTextString(
  input: unknown,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof input !== "string" ||
    (!allowEmpty && !input.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    projectTextFailure("project_text_content_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      projectTextFailure("project_text_content_invalid");
  }
  if (new TextEncoder().encode(input).length > maximumBytes)
    projectTextFailure("project_text_content_limit");
  return input;
}
function collection(
  input: unknown,
  maximum: number,
  allowEmpty = false,
): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    (!allowEmpty && input.length === 0)
  )
    projectTextFailure("project_text_content_invalid");
  return input;
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    projectTextFailure("project_text_duplicate_item");
}
function bounded<T>(input: T, maximum: number): T {
  if (new TextEncoder().encode(extensionCanonicalJson(input)).length > maximum)
    projectTextFailure("project_text_content_limit");
  return input;
}
export function parseProjectOutlineContent(
  input: unknown,
): ProjectOutlineContent {
  const value = projectTextRecord(input, [
    "title",
    "logline",
    "synopsis",
    "episodes",
  ]);
  const episodes = collection(value.episodes, MAX_PROJECT_OUTLINE_EPISODES).map(
    (raw) => {
      const episode = projectTextRecord(raw, ["episodeId", "title", "summary"]);
      return Object.freeze({
        episodeId: projectTextOpaqueId(episode.episodeId),
        title: creativeProjectTitle(episode.title),
        summary: projectTextString(episode.summary, 8192),
      });
    },
  );
  unique(episodes.map((episode) => episode.episodeId));
  return bounded(
    Object.freeze({
      title: creativeProjectTitle(value.title),
      logline: projectTextString(value.logline, 2048),
      synopsis: projectTextString(value.synopsis, 8192),
      episodes: Object.freeze(episodes),
    }),
    MAX_PROJECT_OUTLINE_CONTENT_BYTES,
  );
}
export function parseProjectScriptContent(
  input: unknown,
): ProjectScriptContent {
  const value = projectTextRecord(input, ["title", "scenes"]);
  const scenes = collection(value.scenes, MAX_PROJECT_SCRIPT_SCENES).map(
    (raw) => {
      const scene = projectTextRecord(raw, [
        "sceneId",
        "location",
        "timeOfDay",
        "action",
        "dialogue",
      ]);
      const dialogue = collection(
        scene.dialogue,
        MAX_PROJECT_SCENE_DIALOGUE,
        true,
      ).map((line) => {
        const fields = projectTextRecord(line, ["speaker", "text"]);
        return Object.freeze({
          speaker: projectTextString(fields.speaker, 640),
          text: projectTextString(fields.text, 8192),
        });
      });
      const action = projectTextString(scene.action, 8192, true);
      if (!action.trim() && dialogue.length === 0)
        projectTextFailure("project_text_content_invalid");
      return Object.freeze({
        sceneId: projectTextOpaqueId(scene.sceneId),
        location: projectTextString(scene.location, 640),
        timeOfDay: projectTextString(scene.timeOfDay, 320),
        action,
        dialogue: Object.freeze(dialogue),
      });
    },
  );
  unique(scenes.map((scene) => scene.sceneId));
  return bounded(
    Object.freeze({
      title: creativeProjectTitle(value.title),
      scenes: Object.freeze(scenes),
    }),
    MAX_PROJECT_SCRIPT_CONTENT_BYTES,
  );
}
