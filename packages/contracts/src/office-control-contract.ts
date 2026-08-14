import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseStartWorkflowRunRequest,
  type RunView,
  type StartWorkflowRunRequest,
} from "./control-api-contract.ts";

const OFFICE_CURSOR_PREFIX = "crewon.office.cursor.v1:";
const OFFICE_DELEGATION_CURSOR_PREFIX = "crewon.office-delegation.cursor.v1:";

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
export type OfficeDelegationContract = Readonly<{
  schemaVersion: "crewon.office-delegation.v0";
  delegationId: string;
  tenantId: string;
  spaceId: string;
  officeId: string;
  officeVersionId: string;
  workflowVersionBinding: Readonly<{
    workflowId: string;
    workflowVersionId: string;
    contentDigest: string;
  }>;
  threadId: string;
  runId: string;
  requestedByActorId: string;
  createdAt: string;
}>;
export type StartOfficeDelegationRequest = StartWorkflowRunRequest;
export type OfficeDelegationMutationResponse = Readonly<{
  disposition: "committed" | "replayed";
  delegation: OfficeDelegationContract;
  run: RunView;
}>;
export type ListOfficeDelegationsResponse = Readonly<{
  data: readonly Readonly<{
    delegation: OfficeDelegationContract;
    run: RunView;
  }>[];
  nextCursor: string | null;
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
    members: array(object.members, 0, 32, member),
    executionTargets: array(object.executionTargets, 1, 32, target),
  };
}
export function parseStartOfficeDelegationRequest(
  value: unknown,
): StartOfficeDelegationRequest {
  return parseStartWorkflowRunRequest(value);
}
export function parseOfficeVersionId(value: unknown) {
  return text(value, 128, "office_version_id_invalid");
}
export function parseOfficeListQuery(value: unknown) {
  const object = record(value, "office_list_query_invalid");
  exact(object, ["limit", "cursor"]);
  const limit = object.limit === undefined ? 50 : Number(object.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail("office_list_limit_invalid");
  let before = null;
  if (object.cursor !== undefined) {
    try {
      const input = text(object.cursor, 1024, "office_cursor_invalid");
      const decoded = decodeBase64Url(input);
      if (!decoded.startsWith(OFFICE_CURSOR_PREFIX))
        fail("office_cursor_invalid");
      const tuple: unknown = JSON.parse(
        decoded.slice(OFFICE_CURSOR_PREFIX.length),
      );
      if (!Array.isArray(tuple) || tuple.length !== 2)
        fail("office_cursor_invalid");
      before = {
        createdAt: timestamp(tuple[0], "office_cursor_invalid"),
        officeVersionId: text(tuple[1], 128, "office_cursor_invalid"),
      };
      if (formatOfficeCursor(before) !== input) fail("office_cursor_invalid");
    } catch {
      fail("office_cursor_invalid");
    }
  }
  return { limit, before };
}
export function formatOfficeCursor(value: {
  createdAt: string;
  officeVersionId: string;
}) {
  return encodeBase64Url(
    `${OFFICE_CURSOR_PREFIX}${JSON.stringify([
      timestamp(value.createdAt, "office_cursor_invalid"),
      text(value.officeVersionId, 128, "office_cursor_invalid"),
    ])}`,
  );
}
export function parseOfficeDelegationListQuery(value: unknown) {
  const object = record(value, "office_delegation_list_query_invalid");
  exact(object, ["limit", "cursor"]);
  const limit = object.limit === undefined ? 50 : Number(object.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail("office_delegation_list_limit_invalid");
  let before = null;
  if (object.cursor !== undefined) {
    try {
      const input = text(
        object.cursor,
        1024,
        "office_delegation_cursor_invalid",
      );
      const decoded = decodeBase64Url(input);
      if (!decoded.startsWith(OFFICE_DELEGATION_CURSOR_PREFIX))
        fail("office_delegation_cursor_invalid");
      const tuple: unknown = JSON.parse(
        decoded.slice(OFFICE_DELEGATION_CURSOR_PREFIX.length),
      );
      if (!Array.isArray(tuple) || tuple.length !== 2)
        fail("office_delegation_cursor_invalid");
      before = {
        createdAt: timestamp(tuple[0], "office_delegation_cursor_invalid"),
        delegationId: text(tuple[1], 512, "office_delegation_cursor_invalid"),
      };
      if (formatOfficeDelegationCursor(before) !== input)
        fail("office_delegation_cursor_invalid");
    } catch {
      fail("office_delegation_cursor_invalid");
    }
  }
  return { limit, before };
}
export function formatOfficeDelegationCursor(value: {
  createdAt: string;
  delegationId: string;
}) {
  return encodeBase64Url(
    `${OFFICE_DELEGATION_CURSOR_PREFIX}${JSON.stringify([
      timestamp(value.createdAt, "office_delegation_cursor_invalid"),
      text(value.delegationId, 512, "office_delegation_cursor_invalid"),
    ])}`,
  );
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
function array<T>(
  value: unknown,
  min: number,
  max: number,
  parse: (item: unknown) => T,
) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
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
function timestamp(value: unknown, code: string): string {
  const parsed = text(value, 64, code);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed) ||
    Number.isNaN(Date.parse(parsed))
  )
    fail(code);
  return parsed;
}
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail("office_cursor_invalid");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder(undefined, { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}
function fail(code: string): never {
  throw new ContractValidationError(code);
}
