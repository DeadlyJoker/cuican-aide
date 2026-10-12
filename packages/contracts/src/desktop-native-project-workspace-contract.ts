/** Private Main/Control IPC values. This protocol does not grant SQL, directory access or execution. */
import type { DesktopNativePluginPackageIdentity } from "./desktop-native-plugin-authority-contract.ts";
export const DESKTOP_PROJECT_WORKSPACE_PREPARE_REQUEST_SCHEMA =
  "crewon.desktop-native-project-workspace-prepare-request.v1";
export const DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA =
  "crewon.desktop-native-project-workspace-prepare-response.v1";
export type DesktopNativeProjectWorkspacePrepareRequest = Readonly<{
  schemaVersion: typeof DESKTOP_PROJECT_WORKSPACE_PREPARE_REQUEST_SCHEMA;
  requestId: string;
  projectId: string;
  packageIdentity: DesktopNativePluginPackageIdentity;
}>;
export type DesktopNativeProjectWorkspacePrepareResponse = Readonly<{
  schemaVersion: typeof DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA;
  requestId: string;
}> &
  (
    | Readonly<{
        outcome: "prepared";
        ticket: DesktopNativeProjectWorkspaceTicket;
      }>
    | Readonly<{
        outcome: "unavailable";
        reasonCode: "request_invalid" | "project_unavailable";
      }>
  );
export function parseDesktopNativeProjectWorkspacePrepareRequest(
  input: unknown,
): DesktopNativeProjectWorkspacePrepareRequest {
  const value = wireRecord(input, [
    "schemaVersion",
    "requestId",
    "projectId",
    "packageIdentity",
  ]);
  const pkg = wireRecord(value.packageIdentity, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  if (
    value.schemaVersion !== DESKTOP_PROJECT_WORKSPACE_PREPARE_REQUEST_SCHEMA ||
    !correlation(value.requestId)
  )
    invalid();
  for (const id of [
    value.projectId,
    pkg.pluginId,
    pkg.publisherId,
    pkg.version,
  ])
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 128 ||
      id.trim() !== id ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(id)
    )
      invalid();
  if (
    typeof pkg.packageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(pkg.packageDigest)
  )
    invalid();
  return Object.freeze({
    schemaVersion: DESKTOP_PROJECT_WORKSPACE_PREPARE_REQUEST_SCHEMA,
    requestId: value.requestId as string,
    projectId: value.projectId as string,
    packageIdentity: Object.freeze({
      ...pkg,
    }) as DesktopNativePluginPackageIdentity,
  });
}
export function parseDesktopNativeProjectWorkspacePrepareResponse(
  input: unknown,
): DesktopNativeProjectWorkspacePrepareResponse {
  const outcome = dataProperty(input, "outcome");
  const value = wireRecord(input, [
    "schemaVersion",
    "requestId",
    "outcome",
    outcome === "prepared" ? "ticket" : "reasonCode",
  ]);
  if (
    value.schemaVersion !== DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA ||
    !correlation(value.requestId)
  )
    invalid();
  const base: Pick<
    DesktopNativeProjectWorkspacePrepareResponse,
    "schemaVersion" | "requestId"
  > = {
    schemaVersion: DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA,
    requestId: value.requestId as string,
  };
  if (outcome === "prepared")
    return Object.freeze({
      ...base,
      outcome,
      ticket: parseDesktopNativeProjectWorkspaceTicket(value.ticket),
    });
  if (
    outcome !== "unavailable" ||
    (value.reasonCode !== "request_invalid" &&
      value.reasonCode !== "project_unavailable")
  )
    invalid();
  return Object.freeze({ ...base, outcome, reasonCode: value.reasonCode });
}
function correlation(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(input)
  );
}
export const DESKTOP_PROJECT_WORKSPACE_REQUEST_SCHEMA =
  "crewon.desktop-native-project-workspace-request.v1";
export const DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA =
  "crewon.desktop-native-project-workspace-response.v1";
export const DESKTOP_PROJECT_WORKSPACE_TICKET_SCHEMA =
  "crewon.desktop-native-project-workspace-ticket.v1";
export type DesktopNativeProjectWorkspaceTicket = Readonly<{
  schemaVersion: typeof DESKTOP_PROJECT_WORKSPACE_TICKET_SCHEMA;
  ticketId: string;
  expiresAt: string;
}>;
export type DesktopNativeProjectWorkspaceRequest = Readonly<{
  schemaVersion: typeof DESKTOP_PROJECT_WORKSPACE_REQUEST_SCHEMA;
  requestId: string;
  ticketId: string;
}>;
export const DESKTOP_PROJECT_WORKSPACE_ALLOCATION_FAILURES = [
  "directoryUnavailable",
  "directoryOwnershipUnproven",
  "registryUnavailable",
  "authorityConflict",
  "journalUnavailable",
] as const;
export type DesktopProjectWorkspaceAllocationStatus = Readonly<{
  schemaVersion: "crewon.desktop-plugin-project-workspace-allocation-status.v1";
  workspaceId: string;
  phase: "unallocated" | "pending" | "registered" | "failed";
  observation: "registered" | "unregistered" | "unobserved";
  failureCode:
    | (typeof DESKTOP_PROJECT_WORKSPACE_ALLOCATION_FAILURES)[number]
    | null;
}>;
export type DesktopNativeProjectWorkspaceResponse = Readonly<{
  schemaVersion: typeof DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA;
  requestId: string;
}> &
  (
    | Readonly<{
        outcome: "observed";
        allocation: DesktopProjectWorkspaceAllocationStatus;
      }>
    | Readonly<{
        outcome: "unavailable";
        reasonCode:
          | "request_invalid"
          | "ticket_unavailable"
          | "deadline_exceeded"
          | "allocation_unavailable";
      }>
  );

export function parseDesktopNativeProjectWorkspaceTicket(
  input: unknown,
): DesktopNativeProjectWorkspaceTicket {
  const v = wireRecord(input, ["schemaVersion", "ticketId", "expiresAt"]);
  if (
    v.schemaVersion !== DESKTOP_PROJECT_WORKSPACE_TICKET_SCHEMA ||
    typeof v.ticketId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.ticketId) ||
    typeof v.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.expiresAt) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    new Date(v.expiresAt).toISOString() !== v.expiresAt
  )
    invalid();
  return Object.freeze({
    schemaVersion: DESKTOP_PROJECT_WORKSPACE_TICKET_SCHEMA,
    ticketId: v.ticketId,
    expiresAt: v.expiresAt,
  });
}
export function parseDesktopNativeProjectWorkspaceResponse(
  input: unknown,
): DesktopNativeProjectWorkspaceResponse {
  const outcome = dataProperty(input, "outcome");
  const v = wireRecord(input, [
    "schemaVersion",
    "requestId",
    "outcome",
    outcome === "observed" ? "allocation" : "reasonCode",
  ]);
  if (
    v.schemaVersion !== DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA ||
    typeof v.requestId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(v.requestId)
  )
    invalid();
  const base = {
    schemaVersion: DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA,
    requestId: v.requestId,
  } as const;
  if (outcome === "unavailable") {
    if (
      ![
        "request_invalid",
        "ticket_unavailable",
        "deadline_exceeded",
        "allocation_unavailable",
      ].includes(v.reasonCode as string)
    )
      invalid();
    return Object.freeze({
      ...base,
      outcome,
      reasonCode: v.reasonCode as
        | "request_invalid"
        | "ticket_unavailable"
        | "deadline_exceeded"
        | "allocation_unavailable",
    });
  }
  if (outcome !== "observed") invalid();
  const a = wireRecord(v.allocation, [
    "schemaVersion",
    "workspaceId",
    "phase",
    "observation",
    "failureCode",
  ]);
  if (
    a.schemaVersion !==
      "crewon.desktop-plugin-project-workspace-allocation-status.v1" ||
    typeof a.workspaceId !== "string" ||
    !/^workspace-project-[a-f0-9]{64}$/u.test(a.workspaceId) ||
    !["unallocated", "pending", "registered", "failed"].includes(
      a.phase as string,
    ) ||
    !["registered", "unregistered", "unobserved"].includes(
      a.observation as string,
    ) ||
    (a.failureCode !== null &&
      !DESKTOP_PROJECT_WORKSPACE_ALLOCATION_FAILURES.includes(
        a.failureCode as never,
      ))
  )
    invalid();
  return Object.freeze({
    ...base,
    outcome,
    allocation: Object.freeze({
      ...a,
    }) as DesktopProjectWorkspaceAllocationStatus,
  });
}
function dataProperty(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object"
    ? Object.getOwnPropertyDescriptor(input, key)?.value
    : undefined;
}
function wireRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d?.enumerable || !Object.hasOwn(d, "value")) invalid();
    output[key] = d.value;
  }
  return output;
}
function invalid(): never {
  throw new Error("desktop_native_project_workspace_wire_invalid");
}
