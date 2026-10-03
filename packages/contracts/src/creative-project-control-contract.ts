import {
  creativeControlBrief,
  creativeControlCopy,
  creativeControlFailure,
  creativeControlId,
  creativeControlLimit,
  creativeControlQuery,
  creativeControlQueryRevision,
  creativeControlRecord,
  creativeControlRevision,
  creativeControlText,
  creativeControlTimestamp,
  creativeControlTitle,
} from "./creative-project-control-support.ts";
import type {
  AppendConceptAssetRevisionRequest,
  AppendProjectBriefRequest,
  ConceptAssetListQuery,
  ConceptRevisionListQuery,
  CreateConceptAssetRequest,
  CreateCreativeProjectRequest,
  CreativeProjectCursor,
  CreativeProjectListQuery,
  CreativeProjectListState,
  ProjectBriefListQuery,
  RenameCreativeProjectRequest,
  SetCreativeProjectStateRequest,
} from "./creative-project-control-types.ts";
export * from "./creative-project-control-types.ts";
export * from "./creative-project-control-response.ts";

export function parseCreativeProjectId(input: unknown): string {
  return creativeControlId(input);
}
export function parseCreativeProjectRevision(input: unknown): number {
  return typeof input === "string"
    ? creativeControlQueryRevision(input, 1)
    : creativeControlRevision(input);
}
export function parseCreativeProjectIdempotencyKey(input: unknown): string {
  const value = creativeControlText(input, 128);
  // HTTP adapters can merge repeated fields into one comma-separated value.
  if (value !== value.trim() || /[,\u0000-\u001f\u007f]/u.test(value))
    creativeControlFailure();
  return value;
}
export function parseCreateCreativeProjectRequest(
  input: unknown,
): CreateCreativeProjectRequest {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "title",
    "briefText",
  ]);
  return Object.freeze({
    title: creativeControlTitle(value.title),
    briefText: creativeControlBrief(value.briefText),
  });
}
export function parseRenameCreativeProjectRequest(
  input: unknown,
): RenameCreativeProjectRequest {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "title",
    "expectedProjectRevision",
  ]);
  return Object.freeze({
    title: creativeControlTitle(value.title),
    expectedProjectRevision: creativeControlRevision(
      value.expectedProjectRevision,
    ),
  });
}
export function parseSetCreativeProjectStateRequest(
  input: unknown,
): SetCreativeProjectStateRequest {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "state",
    "expectedProjectRevision",
  ]);
  if (value.state !== "active" && value.state !== "archived")
    creativeControlFailure();
  return Object.freeze({
    state: value.state,
    expectedProjectRevision: creativeControlRevision(
      value.expectedProjectRevision,
    ),
  });
}
export function parseAppendProjectBriefRequest(
  input: unknown,
): AppendProjectBriefRequest {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "text",
    "expectedProjectRevision",
  ]);
  return Object.freeze({
    text: creativeControlBrief(value.text),
    expectedProjectRevision: creativeControlRevision(
      value.expectedProjectRevision,
    ),
  });
}
export function parseCreateConceptAssetRequest(
  input: unknown,
): CreateConceptAssetRequest {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "briefRevision",
    "name",
    "prompt",
    "expectedProjectRevision",
  ]);
  return Object.freeze({
    briefRevision: creativeControlRevision(value.briefRevision),
    name: creativeControlTitle(value.name),
    prompt: creativeControlText(value.prompt, 2000),
    expectedProjectRevision: creativeControlRevision(
      value.expectedProjectRevision,
    ),
  });
}
export function parseAppendConceptAssetRevisionRequest(
  input: unknown,
): AppendConceptAssetRevisionRequest {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "briefRevision",
    "prompt",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
  ]);
  return Object.freeze({
    briefRevision: creativeControlRevision(value.briefRevision),
    prompt: creativeControlText(value.prompt, 2000),
    expectedProjectRevision: creativeControlRevision(
      value.expectedProjectRevision,
    ),
    expectedAssetMetadataRevision: creativeControlRevision(
      value.expectedAssetMetadataRevision,
    ),
  });
}
export function parseCreativeProjectEmptyQuery(input: unknown): void {
  creativeControlQuery(input, []);
}
export function formatCreativeProjectCursor(
  input: CreativeProjectCursor & Readonly<{ state: CreativeProjectListState }>,
): string;
export function formatCreativeProjectCursor(
  state: CreativeProjectListState,
  after: CreativeProjectCursor,
): string;
export function formatCreativeProjectCursor(
  stateInput:
    | CreativeProjectListState
    | (CreativeProjectCursor & Readonly<{ state: CreativeProjectListState }>),
  afterInput?: CreativeProjectCursor,
): string {
  const fields =
    typeof stateInput === "object"
      ? creativeControlRecord(stateInput, ["state", "updatedAt", "projectId"])
      : null;
  const state = listState(fields ? fields.state : stateInput);
  const after = creativeControlRecord(
    fields
      ? { updatedAt: fields.updatedAt, projectId: fields.projectId }
      : afterInput,
    ["updatedAt", "projectId"],
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "crewon.creative-project-cursor.v1",
      state,
      creativeControlTimestamp(after.updatedAt),
      creativeControlId(after.projectId),
    ]),
  );
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function parseCursor(
  input: unknown,
  state: CreativeProjectListState,
): CreativeProjectCursor {
  try {
    if (
      typeof input !== "string" ||
      input.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/u.test(input)
    )
      creativeControlFailure();
    const binary = atob(input.replaceAll("-", "+").replaceAll("_", "/"));
    const value: unknown = JSON.parse(
      new TextDecoder(undefined, { fatal: true }).decode(
        Uint8Array.from(binary, (point) => point.charCodeAt(0)),
      ),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== "crewon.creative-project-cursor.v1" ||
      value[1] !== state
    )
      creativeControlFailure();
    const after = Object.freeze({
      updatedAt: creativeControlTimestamp(value[2]),
      projectId: creativeControlId(value[3]),
    });
    if (formatCreativeProjectCursor(state, after) !== input)
      creativeControlFailure();
    return after;
  } catch {
    return creativeControlFailure();
  }
}
function listState(input: unknown): CreativeProjectListState {
  if (input !== "active" && input !== "archived" && input !== "all")
    creativeControlFailure();
  return input;
}
export function parseCreativeProjectListQuery(
  input: unknown,
): CreativeProjectListQuery {
  const value = creativeControlQuery(input, ["state", "cursor", "limit"]);
  const state = listState(value.state ?? "active");
  return Object.freeze({
    state,
    after: value.cursor === undefined ? null : parseCursor(value.cursor, state),
    limit: creativeControlLimit(value.limit),
  });
}
export function parseProjectBriefListQuery(
  input: unknown,
): ProjectBriefListQuery {
  const value = creativeControlQuery(input, ["afterBriefRevision", "limit"]);
  return Object.freeze({
    afterBriefRevision:
      value.afterBriefRevision === undefined
        ? 0
        : creativeControlQueryRevision(value.afterBriefRevision, 0),
    limit: creativeControlLimit(value.limit),
  });
}
export function parseConceptAssetListQuery(
  input: unknown,
): ConceptAssetListQuery {
  const value = creativeControlQuery(input, ["afterAssetId", "limit"]);
  return Object.freeze({
    afterAssetId:
      value.afterAssetId === undefined
        ? null
        : creativeControlId(value.afterAssetId),
    limit: creativeControlLimit(value.limit),
  });
}
export function parseConceptRevisionListQuery(
  input: unknown,
): ConceptRevisionListQuery {
  const value = creativeControlQuery(input, ["afterAssetRevision", "limit"]);
  return Object.freeze({
    afterAssetRevision:
      value.afterAssetRevision === undefined
        ? 0
        : creativeControlQueryRevision(value.afterAssetRevision, 0),
    limit: creativeControlLimit(value.limit),
  });
}
