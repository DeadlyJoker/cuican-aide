import { canonicalJsonValue } from "./canonical-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

/** C01 limits include evidence bodies, which are stored separately from the export. */
export const RECORDING_BUDGETS = Object.freeze({
  maxSteps: 200,
  maxDurationMs: 30 * 60 * 1_000,
  maxStepBytes: 8 * 1_024,
  maxEvidenceBytes: 16 * 1_024,
  maxTotalBytes: 2 * 1_024 * 1_024,
  maxEdits: 400,
});

export type RecordingDigest = `sha256:${string}`;
export type RecordingStatus =
  | "recording"
  | "paused"
  | "completed"
  | "interrupted"
  | "budget-exceeded";
export type RecordingInput =
  | { classification: "ordinary" | "parameter-candidate"; value: string }
  | { classification: "runtime-required" };
export type RecordingStep = {
  stepId: string;
  /** Original monotonic sequence. Deleting a step never renumbers remaining steps. */
  sequence: number;
  kind: "navigate" | "click" | "input" | "select" | "download" | "unsupported";
  occurredAt: string;
  page: { origin: string; routeTemplate: string; routeDigest: RecordingDigest };
  target: {
    tag: string;
    selector: string;
    description: string;
    role: string | null;
    accessibleName: string | null;
  } | null;
  input: RecordingInput | null;
  note: string | null;
  evidenceIds: string[];
  outcome: "observed" | "completed" | "cancelled" | "unknown";
  reason: string | null;
  relatedStepId: string | null;
};
export type RecordingEvidence = {
  evidenceId: string;
  kind: "redacted-layout" | "redacted-screenshot";
  mediaType: "image/svg+xml" | "image/png";
  byteLength: number;
  contentDigest: RecordingDigest;
};
export type RecordingEdit = {
  revision: number;
  stepId: string;
  operation: "delete" | "annotate";
  at: string;
};
export type RecordingExportBody = {
  schemaVersion: 1;
  recordingId: string;
  revision: number;
  /** Provenance only: an importer must independently authorize its owner/workspace. */
  scope: { ownerId: string; workspaceId: string | null };
  authorization: {
    source: "desktop-user-start";
    authorizedAt: string;
    allowedOrigins: string[];
  };
  startedAt: string;
  updatedAt: string;
  status: RecordingStatus;
  steps: RecordingStep[];
  evidence: RecordingEvidence[];
  edits: RecordingEdit[];
};
export type RecordingExport = RecordingExportBody & {
  contentDigest: RecordingDigest;
};

const BODY_KEYS = [
  "schemaVersion",
  "recordingId",
  "revision",
  "scope",
  "authorization",
  "startedAt",
  "updatedAt",
  "status",
  "steps",
  "evidence",
  "edits",
] as const;
const encoder = new TextEncoder();

/** Seal a strict C01 body; the digest detects alteration, it does not grant authority. */
export async function sealRecordingExport(
  body: RecordingExportBody,
): Promise<RecordingExport> {
  parseBody(body);
  const serialized = canonicalJsonValue(body);
  const result = {
    ...(JSON.parse(serialized) as RecordingExportBody),
    contentDigest: await digest(serialized),
  };
  checkTotalBytes(result);
  return result;
}

/** Verify C01 shape, references, bounded content and its deterministic SHA-256 digest. */
export async function validateRecordingExport(
  value: unknown,
): Promise<RecordingExport> {
  const object = shape(value, [...BODY_KEYS, "contentDigest"]);
  const contentDigest = readDigest(object.contentDigest);
  const { contentDigest: omitted, ...body } = object;
  void omitted;
  parseBody(body);
  const serialized = canonicalJsonValue(body);
  const snapshot = {
    ...(JSON.parse(serialized) as RecordingExportBody),
    contentDigest,
  };
  checkTotalBytes(snapshot);
  if ((await digest(serialized)) !== contentDigest) fail("digest_mismatch");
  return snapshot;
}

function parseBody(value: unknown): asserts value is RecordingExportBody {
  const body = shape(value, BODY_KEYS);
  if (body.schemaVersion !== 1) fail("unsupported_version");
  id(body.recordingId);
  const revision = integer(body.revision, 1);
  const scope = shape(body.scope, ["ownerId", "workspaceId"]);
  id(scope.ownerId);
  if (scope.workspaceId !== null) id(scope.workspaceId);
  const authorization = shape(body.authorization, [
    "source",
    "authorizedAt",
    "allowedOrigins",
  ]);
  if (authorization.source !== "desktop-user-start")
    fail("invalid_authorization");
  const startedAt = timestamp(body.startedAt);
  const updatedAt = timestamp(body.updatedAt);
  if (
    updatedAt < startedAt ||
    timestamp(authorization.authorizedAt) > startedAt
  )
    fail("invalid_time_order");
  const origins = array(
    authorization.allowedOrigins,
    RECORDING_BUDGETS.maxSteps,
  );
  if (origins.length === 0) fail("invalid_authorization");
  const allowedOrigins = new Set(origins.map(origin));
  if (origins.length !== allowedOrigins.size) fail("duplicate_origin");
  const status = choice(body.status, [
    "recording",
    "paused",
    "completed",
    "interrupted",
    "budget-exceeded",
  ]);
  if (status !== "recording" && revision < 2) fail("invalid_revision");

  const steps = array(body.steps, RECORDING_BUDGETS.maxSteps);
  const evidence = array(body.evidence, RECORDING_BUDGETS.maxSteps * 2);
  const edits = array(body.edits, RECORDING_BUDGETS.maxEdits);
  const evidenceIds = new Set<string>();
  for (const item of evidence) {
    const entry = shape(item, [
      "evidenceId",
      "kind",
      "mediaType",
      "byteLength",
      "contentDigest",
    ]);
    const evidenceId = id(entry.evidenceId);
    if (evidenceIds.has(evidenceId)) fail("duplicate_evidence_id");
    evidenceIds.add(evidenceId);
    if (
      !(
        (entry.kind === "redacted-layout" &&
          entry.mediaType === "image/svg+xml") ||
        (entry.kind === "redacted-screenshot" &&
          entry.mediaType === "image/png")
      )
    )
      fail("invalid_evidence_type");
    integer(entry.byteLength, 1, RECORDING_BUDGETS.maxEvidenceBytes);
    readDigest(entry.contentDigest);
  }
  const stepIds = new Set<string>();
  let previousSequence = 0;
  let previousTime = startedAt;
  for (const item of steps) {
    const step = shape(item, [
      "stepId",
      "sequence",
      "kind",
      "occurredAt",
      "page",
      "target",
      "input",
      "note",
      "evidenceIds",
      "outcome",
      "reason",
      "relatedStepId",
    ]);
    const stepId = id(step.stepId);
    if (stepIds.has(stepId)) fail("duplicate_step_id");
    const sequence = integer(step.sequence, 1, RECORDING_BUDGETS.maxSteps);
    if (sequence <= previousSequence) fail("invalid_step_order");
    previousSequence = sequence;
    const occurredAt = timestamp(step.occurredAt);
    if (occurredAt < previousTime || occurredAt > updatedAt)
      fail("invalid_time_order");
    previousTime = occurredAt;
    const kind = choice(step.kind, [
      "navigate",
      "click",
      "input",
      "select",
      "download",
      "unsupported",
    ]);
    const page = shape(step.page, ["origin", "routeTemplate", "routeDigest"]);
    if (!allowedOrigins.has(origin(page.origin))) fail("unauthorized_origin");
    routeTemplate(page.routeTemplate, page.origin as string);
    readDigest(page.routeDigest);
    if (step.target !== null) {
      const target = shape(step.target, [
        "tag",
        "selector",
        "description",
        "role",
        "accessibleName",
      ]);
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(string(target.tag, 32, 1)))
        fail("invalid_target_tag");
      string(target.selector, 512, 1);
      string(target.description, 160);
      nullableString(target.role, 64);
      nullableString(target.accessibleName, 160);
    }
    if (step.input !== null) {
      if (kind !== "input" && kind !== "select") fail("invalid_input_kind");
      const input = plain(step.input);
      if (input.classification === "runtime-required") {
        shape(input, ["classification"]);
      } else {
        shape(input, ["classification", "value"]);
        choice(input.classification, ["ordinary", "parameter-candidate"]);
        string(input.value, 2_048);
      }
    }
    nullableString(step.note, 1_000);
    nullableString(step.reason, 512);
    choice(step.outcome, ["observed", "completed", "cancelled", "unknown"]);
    const refs = array(step.evidenceIds, 8).map(id);
    if (
      new Set(refs).size !== refs.length ||
      refs.some((ref) => !evidenceIds.has(ref))
    )
      fail("invalid_evidence_reference");
    if (step.relatedStepId !== null && !stepIds.has(id(step.relatedStepId)))
      fail("invalid_related_step");
    stepIds.add(stepId);
    if (bytes(canonicalJsonValue(step)) > RECORDING_BUDGETS.maxStepBytes)
      fail("step_budget_exceeded");
  }
  const deletedIds = new Set<string>();
  let previousEditRevision = 1;
  let previousEditTime = startedAt;
  const annotatedIds: string[] = [];
  for (const item of edits) {
    const edit = shape(item, ["revision", "stepId", "operation", "at"]);
    const editRevision = integer(edit.revision, 2, revision);
    if (editRevision <= previousEditRevision) fail("invalid_edit_order");
    previousEditRevision = editRevision;
    const at = timestamp(edit.at);
    if (at < previousEditTime || at > updatedAt) fail("invalid_time_order");
    previousEditTime = at;
    const stepId = id(edit.stepId);
    if (deletedIds.has(stepId)) fail("edit_after_delete");
    if (choice(edit.operation, ["delete", "annotate"]) === "delete") {
      if (stepIds.has(stepId)) fail("deleted_step_present");
      deletedIds.add(stepId);
    } else {
      annotatedIds.push(stepId);
    }
  }
  if (
    annotatedIds.some(
      (stepId) => !stepIds.has(stepId) && !deletedIds.has(stepId),
    )
  )
    fail("invalid_edit_reference");
  if (steps.length + deletedIds.size > RECORDING_BUDGETS.maxSteps)
    fail("step_budget_exceeded");
}

function checkTotalBytes(value: RecordingExport): void {
  const total =
    bytes(canonicalJsonValue(value)) +
    value.evidence.reduce((sum, evidence) => sum + evidence.byteLength, 0);
  if (total > RECORDING_BUDGETS.maxTotalBytes) fail("total_budget_exceeded");
}

async function digest(value: string): Promise<RecordingDigest> {
  const hashed = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid_shape");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid_shape");
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")
    )
      fail("invalid_shape");
  }
  return value as Record<string, unknown>;
}

function shape(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const object = plain(value);
  const actualKeys = Reflect.ownKeys(object);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("invalid_shape");
  return object;
}

function array(value: unknown, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength)
    fail("array_budget_exceeded");
  if (
    Object.keys(value).length !== value.length ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail("invalid_array");
  return value;
}

function string(value: unknown, maxBytes: number, minLength = 0): string {
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    value.length > maxBytes ||
    bytes(value) > maxBytes
  )
    fail("invalid_string");
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    fail("invalid_string");
  return value;
}

function nullableString(value: unknown, maxBytes: number): void {
  if (value !== null) string(value, maxBytes);
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail("invalid_integer");
  return value;
}

function id(value: unknown): string {
  const parsed = string(value, 128, 1);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(parsed)) fail("invalid_id");
  return parsed;
}

function readDigest(value: unknown): RecordingDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
    fail("invalid_digest");
  return value as RecordingDigest;
}

function choice<const T extends string>(
  value: unknown,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    fail("invalid_enum");
  return value as T;
}

function timestamp(value: unknown): number {
  const parsed = string(value, 24, 24);
  const time = Date.parse(parsed);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== parsed)
    fail("invalid_timestamp");
  return time;
}

function origin(value: unknown): string {
  const parsed = string(value, 512, 1);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    fail("invalid_origin");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.origin !== parsed ||
    url.username ||
    url.password
  )
    fail("invalid_origin");
  return parsed;
}

function routeTemplate(value: unknown, expectedOrigin: string): void {
  const parsed = string(value, 2_048, 1);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    fail("invalid_route_template");
  }
  if (url.origin !== expectedOrigin || url.username || url.password || url.hash)
    fail("invalid_route_template");
  // Paths contain only already sanitized semantic segments and runtime placeholders.
  // The capture source is responsible for replacing sensitive/opaque path segments.
  for (const [key, queryValue] of url.searchParams) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ||
      queryValue !== "{runtime}"
    )
      fail("invalid_route_template");
  }
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function fail(reason: string): never {
  throw new ContractValidationError(`recording_export_${reason}`);
}
