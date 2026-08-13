import { ContractValidationError } from "./contract-validation-error.ts";

export type OfficeMemberContract = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
}>;
export type OfficeExecutionTargetContract = Readonly<{
  targetId: string;
  agentVersionId: string;
}>;
export type OfficeContract = Readonly<{
  schemaVersion: "crewon.office-definition.v0";
  tenantId: string;
  spaceId: string;
  officeId: string;
  officeVersionId: string;
  revision: number;
  title: string;
  members: readonly OfficeMemberContract[];
  executionTargets: readonly OfficeExecutionTargetContract[];
  createdByActorId: string;
  createdAt: string;
}>;
export type CreateOfficeRequest = Readonly<{
  officeId?: string;
  expectedRevision: number;
  title: string;
  members: readonly OfficeMemberContract[];
  executionTargets: readonly OfficeExecutionTargetContract[];
}>;
export type OfficeMutationResponse = Readonly<{
  disposition: "created" | "replayed";
  office: OfficeContract;
}>;
export type GetOfficeResponse = Readonly<{ office: OfficeContract }>;
export type ListOfficesResponse = Readonly<{
  data: readonly OfficeContract[];
  nextCursor: string | null;
}>;
export type StartOfficeRunRequest = Readonly<{
  targetId: string;
  threadId: string;
}>;

export function parseCreateOfficeRequest(value: unknown): CreateOfficeRequest {
  const object = record(value, "office_request_invalid");
  exact(object, [
    "officeId",
    "expectedRevision",
    "title",
    "members",
    "executionTargets",
  ]);
  if (
    !Number.isSafeInteger(object.expectedRevision) ||
    (object.expectedRevision as number) < 0
  )
    fail("office_revision_invalid");
  const officeId =
    object.officeId === undefined
      ? undefined
      : text(object.officeId, 128, "office_id_invalid");
  return {
    ...(officeId === undefined ? {} : { officeId }),
    expectedRevision: object.expectedRevision as number,
    title: text(object.title, 160, "office_title_invalid"),
    members: array(object.members, 32, member),
    executionTargets: array(object.executionTargets, 32, target),
  };
}
export function parseStartOfficeRunRequest(
  value: unknown,
): StartOfficeRunRequest {
  const object = record(value, "office_run_request_invalid");
  exact(object, ["targetId", "threadId"]);
  return {
    targetId: text(object.targetId, 128, "office_target_id_invalid"),
    threadId: text(object.threadId, 128, "thread_id_invalid"),
  };
}
export function parseOfficeVersionId(value: unknown) {
  return text(value, 128, "office_version_id_invalid");
}
export function parseOfficeListQuery(value: unknown) {
  const object = record(value, "office_list_query_invalid");
  exact(object, ["limit", "before"]);
  const limit = object.limit === undefined ? 50 : Number(object.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail("office_list_limit_invalid");
  let before = null;
  if (object.before !== undefined) {
    const decoded = Buffer.from(
      text(object.before, 1024, "office_cursor_invalid"),
      "base64url",
    )
      .toString("utf8")
      .split("\0");
    if (decoded.length !== 2) fail("office_cursor_invalid");
    before = {
      createdAt: text(decoded[0], 64, "office_cursor_invalid"),
      officeVersionId: text(decoded[1], 128, "office_cursor_invalid"),
    };
  }
  return { limit, before };
}
export function formatOfficeCursor(value: {
  createdAt: string;
  officeVersionId: string;
}) {
  return Buffer.from(
    `${value.createdAt}\0${value.officeVersionId}`,
    "utf8",
  ).toString("base64url");
}
function member(value: unknown): OfficeMemberContract {
  const object = record(value, "office_member_invalid");
  exact(object, ["memberId", "displayName", "agentVersionId"]);
  return {
    memberId: text(object.memberId, 128, "office_member_invalid"),
    displayName: text(object.displayName, 160, "office_member_invalid"),
    agentVersionId: text(object.agentVersionId, 128, "office_member_invalid"),
  };
}
function target(value: unknown): OfficeExecutionTargetContract {
  const object = record(value, "office_target_invalid");
  exact(object, ["targetId", "agentVersionId"]);
  return {
    targetId: text(object.targetId, 128, "office_target_invalid"),
    agentVersionId: text(object.agentVersionId, 128, "office_target_invalid"),
  };
}
function array<T>(value: unknown, max: number, parse: (item: unknown) => T) {
  if (!Array.isArray(value) || value.length > max)
    fail("office_collection_bounds_invalid");
  return value.map(parse);
}
function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(code);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail("unknown_field");
}
function text(value: unknown, max: number, code: string) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value
  )
    fail(code);
  return value;
}
function fail(code: string): never {
  throw new ContractValidationError(code);
}
