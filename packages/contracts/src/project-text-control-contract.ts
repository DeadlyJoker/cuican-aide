import { parseCreativeProjectIdempotencyKey } from "./creative-project-control-contract.ts";
import {
  projectTextControlArray as array,
  projectTextControlCopy as copy,
  projectTextControlFailure as fail,
  projectTextControlId as id,
  projectTextControlNumber as revision,
  projectTextControlQuery as query,
  projectTextControlQueryNumber as queryNumber,
  projectTextControlRecord as record,
  projectTextControlText as text,
  projectTextControlTitle as title,
} from "./project-text-control-support.ts";
import {
  MAX_PROJECT_TEXT_PAGE_SIZE,
  type ProjectTextArtifactListQuery,
  type ProjectTextRevisionListQuery,
  type ProjectTextOutlineContent,
  type ProjectTextScriptContent,
  type SaveProjectOutlineCandidateRequest,
  type SaveProjectScriptCandidateRequest,
  type SelectProjectTextRevisionRequest,
  type SetProjectTextArtifactLockedRequest,
} from "./project-text-control-types.ts";
export const MAX_PROJECT_TEXT_OUTLINE_CONTENT_BYTES = 16 * 1024;
export const MAX_PROJECT_TEXT_SCRIPT_CONTENT_BYTES = 32 * 1024;
export function parseProjectTextId(input: unknown): string {
  return id(input);
}
export function parseProjectTextIdempotencyKey(input: unknown): string {
  try {
    return parseCreativeProjectIdempotencyKey(input);
  } catch {
    return fail();
  }
}
export function parseProjectTextContentRevision(input: unknown): number {
  return typeof input === "string" ? queryNumber(input) : revision(input);
}
export function parseProjectTextEmptyQuery(input: unknown): void {
  query(input, []);
}
function bounded<T>(value: T, maximum: number): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum)
    fail();
  return value;
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail();
}
export function parseProjectTextOutlineContent(
  input: unknown,
): ProjectTextOutlineContent {
  const value = record(copy(input), [
    "title",
    "logline",
    "synopsis",
    "episodes",
  ]);
  const episodes = array(value.episodes, 1, 16).map((raw) => {
    const item = record(raw, ["episodeId", "title", "summary"]);
    return Object.freeze({
      episodeId: id(item.episodeId),
      title: title(item.title),
      summary: text(item.summary, 8192),
    });
  });
  unique(episodes.map((item) => item.episodeId));
  return bounded(
    Object.freeze({
      title: title(value.title),
      logline: text(value.logline, 2048),
      synopsis: text(value.synopsis, 8192),
      episodes: Object.freeze(episodes),
    }),
    MAX_PROJECT_TEXT_OUTLINE_CONTENT_BYTES,
  );
}
export function parseProjectTextScriptContent(
  input: unknown,
): ProjectTextScriptContent {
  const value = record(copy(input), ["title", "scenes"]);
  const scenes = array(value.scenes, 1, 32).map((raw) => {
    const item = record(raw, [
      "sceneId",
      "location",
      "timeOfDay",
      "action",
      "dialogue",
    ]);
    const dialogue = array(item.dialogue, 0, 64).map((rawLine) => {
      const line = record(rawLine, ["speaker", "text"]);
      return Object.freeze({
        speaker: text(line.speaker, 640),
        text: text(line.text, 8192),
      });
    });
    const action = text(item.action, 8192, true);
    if (!action.trim() && dialogue.length === 0) fail();
    return Object.freeze({
      sceneId: id(item.sceneId),
      location: text(item.location, 640),
      timeOfDay: text(item.timeOfDay, 320),
      action,
      dialogue: Object.freeze(dialogue),
    });
  });
  unique(scenes.map((item) => item.sceneId));
  return bounded(
    Object.freeze({ title: title(value.title), scenes: Object.freeze(scenes) }),
    MAX_PROJECT_TEXT_SCRIPT_CONTENT_BYTES,
  );
}
export function parseSaveProjectOutlineCandidateRequest(
  input: unknown,
): SaveProjectOutlineCandidateRequest {
  const value = record(copy(input), [
    "expectedArtifactRevision",
    "briefRevision",
    "content",
  ]);
  return Object.freeze({
    expectedArtifactRevision: revision(value.expectedArtifactRevision, 0),
    briefRevision: revision(value.briefRevision),
    content: parseProjectTextOutlineContent(value.content),
  });
}
export function parseSaveProjectScriptCandidateRequest(
  input: unknown,
): SaveProjectScriptCandidateRequest {
  const value = record(copy(input), [
    "expectedArtifactRevision",
    "briefRevision",
    "outline",
    "content",
  ]);
  const outline =
    value.outline === null
      ? null
      : record(value.outline, ["artifactId", "contentRevision"]);
  return Object.freeze({
    expectedArtifactRevision: revision(value.expectedArtifactRevision, 0),
    briefRevision: revision(value.briefRevision),
    outline:
      outline === null
        ? null
        : Object.freeze({
            artifactId: id(outline.artifactId),
            contentRevision: revision(outline.contentRevision),
          }),
    content: parseProjectTextScriptContent(value.content),
  });
}
export function parseSelectProjectTextRevisionRequest(
  input: unknown,
): SelectProjectTextRevisionRequest {
  const value = record(copy(input), [
    "expectedArtifactRevision",
    "contentRevision",
  ]);
  return Object.freeze({
    expectedArtifactRevision: revision(value.expectedArtifactRevision),
    contentRevision: revision(value.contentRevision),
  });
}
export function parseSetProjectTextArtifactLockedRequest(
  input: unknown,
): SetProjectTextArtifactLockedRequest {
  const value = record(copy(input), ["expectedArtifactRevision", "locked"]);
  if (typeof value.locked !== "boolean") fail();
  return Object.freeze({
    expectedArtifactRevision: revision(value.expectedArtifactRevision),
    locked: value.locked,
  });
}
function limit(input: string | undefined): number {
  const value =
    input === undefined ? MAX_PROJECT_TEXT_PAGE_SIZE : queryNumber(input);
  if (value > MAX_PROJECT_TEXT_PAGE_SIZE) fail();
  return value;
}
export function parseProjectTextArtifactListQuery(
  input: unknown,
): ProjectTextArtifactListQuery {
  const value = query(input, ["afterArtifactId", "limit"]);
  return Object.freeze({
    afterArtifactId:
      value.afterArtifactId === undefined ? null : id(value.afterArtifactId),
    limit: limit(value.limit),
  });
}
export function parseProjectTextRevisionListQuery(
  input: unknown,
): ProjectTextRevisionListQuery {
  const value = query(input, ["afterContentRevision", "limit"]);
  return Object.freeze({
    afterContentRevision:
      value.afterContentRevision === undefined
        ? 0
        : queryNumber(value.afterContentRevision, 0),
    limit: limit(value.limit),
  });
}
