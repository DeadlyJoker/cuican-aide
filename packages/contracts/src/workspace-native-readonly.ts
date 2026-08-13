import { ContractValidationError } from "./contract-validation-error.ts";
export const WORKSPACE_NATIVE_READONLY_PATH = "/worker/v1/workspace-native-readonly" as const;
export const WORKSPACE_NATIVE_READONLY_LIMITS = {
  requestBytes: 8 * 1024,
  responseBytes: 256 * 1024,
  maxMatches: 200,
  maxScannedFiles: 10_000,
  maxScannedBytes: 64 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxStatusEntries: 2_000,
} as const;
type Scope = Readonly<{ tenantId: string; spaceId: string; workspaceBindingId: string }>;

export type WorkspaceContentSearchRequest = Scope &
  Readonly<{
    schemaVersion: "crewon.workspace-native-readonly-request.v0";
    operation: "contentSearch";
    query: string;
    pathSegments: readonly string[];
    maxMatches: number;
}>;
export type WorkspaceGitStatusRequest = Scope &
  Readonly<{
    schemaVersion: "crewon.workspace-native-readonly-request.v0";
    operation: "gitStatus";
  }>;
export type WorkspaceNativeReadonlyRequest = WorkspaceContentSearchRequest | WorkspaceGitStatusRequest;

export type WorkspaceNativeReadonlyControlRequest =
  | Omit<WorkspaceContentSearchRequest, "tenantId" | "spaceId">
  | Omit<WorkspaceGitStatusRequest, "tenantId" | "spaceId">;

export type WorkspaceNativeReadonlyResponse =
  | Readonly<{
      schemaVersion: "crewon.workspace-native-readonly-response.v0";
      operation: "contentSearch";
      workspaceBindingId: string;
      matches: readonly Readonly<{ path: string; line: number; preview: string }>[];
      scannedFiles: number;
      scannedBytes: number;
      truncated: boolean;
    }>
  | Readonly<{
      schemaVersion: "crewon.workspace-native-readonly-response.v0";
      operation: "gitStatus";
      workspaceBindingId: string;
      branch: string | null;
      head: string | null;
      entries: readonly Readonly<{ path: string; index: string; worktree: string }>[];
      truncated: boolean;
    }>;

export function parseWorkspaceNativeReadonlyRequest(
  input: unknown,
): WorkspaceNativeReadonlyRequest {
  const value = object(input);
  if (value.schemaVersion !== "crewon.workspace-native-readonly-request.v0")
    throw invalid();
  const scope = {
    tenantId: opaque(value.tenantId),
    spaceId: opaque(value.spaceId),
    workspaceBindingId: opaque(value.workspaceBindingId),
  };
  if (value.operation === "gitStatus") {
    exact(value, [
      "operation",
      "schemaVersion",
      "spaceId",
      "tenantId",
      "workspaceBindingId",
    ]);
    return {
      ...scope,
      schemaVersion: value.schemaVersion,
      operation: "gitStatus",
    };
  }
  if (value.operation !== "contentSearch") throw invalid();
  exact(value, [
    "maxMatches",
    "operation",
    "pathSegments",
    "query",
    "schemaVersion",
    "spaceId",
    "tenantId",
    "workspaceBindingId",
  ]);
  if (
    typeof value.query !== "string" ||
    value.query.length < 1 ||
    utf8Bytes(value.query) > 512 ||
    !Number.isSafeInteger(value.maxMatches) ||
    Number(value.maxMatches) < 1 ||
    Number(value.maxMatches) > WORKSPACE_NATIVE_READONLY_LIMITS.maxMatches ||
    !Array.isArray(value.pathSegments) ||
    value.pathSegments.length > 32
  )
    throw invalid();
  const pathSegments = value.pathSegments.map(segment);
  return {
    ...scope,
    schemaVersion: value.schemaVersion,
    operation: "contentSearch",
    query: value.query,
    pathSegments,
    maxMatches: Number(value.maxMatches),
  };
}

export function parseWorkspaceNativeReadonlyControlRequest(
  input: unknown,
): WorkspaceNativeReadonlyControlRequest {
  const value = object(input);
  return stripScope(
    parseWorkspaceNativeReadonlyRequest({
      ...value,
      tenantId: "control-scope",
      spaceId: "control-scope",
    }),
  );
}

function stripScope(
  value: WorkspaceNativeReadonlyRequest,
): WorkspaceNativeReadonlyControlRequest {
  const { tenantId: _tenantId, spaceId: _spaceId, ...request } = value;
  return request;
}

export function parseWorkspaceNativeReadonlyResponse(
  input: unknown,
  expected: WorkspaceNativeReadonlyRequest,
): WorkspaceNativeReadonlyResponse {
  const value = object(input);
  if (
    value.schemaVersion !== "crewon.workspace-native-readonly-response.v0" ||
    value.operation !== expected.operation ||
    value.workspaceBindingId !== expected.workspaceBindingId ||
    typeof value.truncated !== "boolean"
  )
    throw invalid();
  if (value.operation === "contentSearch") {
    if (
      expected.operation !== "contentSearch" ||
      !Array.isArray(value.matches) ||
      value.matches.length > expected.maxMatches ||
      !safeCount(value.scannedFiles) ||
      !safeCount(value.scannedBytes)
    )
      throw invalid();
    const matches = value.matches.map((item) => {
      const match = object(item);
      exact(match, ["line", "path", "preview"]);
      if (
        typeof match.path !== "string" ||
        !safeCount(match.line) ||
        typeof match.preview !== "string" ||
        utf8Bytes(match.preview) > 1024
      )
        throw invalid();
      return {
        path: resultPath(match.path),
        line: Number(match.line),
        preview: match.preview,
      };
    });
    return {
      schemaVersion: value.schemaVersion,
      operation: "contentSearch",
      workspaceBindingId: value.workspaceBindingId,
      matches,
      scannedFiles: Number(value.scannedFiles),
      scannedBytes: Number(value.scannedBytes),
      truncated: value.truncated,
    };
  }
  if (
    !Array.isArray(value.entries) ||
    value.entries.length > WORKSPACE_NATIVE_READONLY_LIMITS.maxStatusEntries ||
    !(value.branch === null ||
      (typeof value.branch === "string" && utf8Bytes(value.branch) <= 1024 &&
        !/[\p{Cc}\p{Cf}]/u.test(value.branch))) ||
    !(value.head === null ||
      (typeof value.head === "string" && /^[a-f0-9]{40,64}$/u.test(value.head)))
  )
    throw invalid();
  const entries = value.entries.map((item) => {
    const entry = object(item);
    exact(entry, ["index", "path", "worktree"]);
    if (
      typeof entry.path !== "string" ||
      typeof entry.index !== "string" ||
      entry.index.length !== 1 ||
      typeof entry.worktree !== "string" ||
      entry.worktree.length !== 1
    )
      throw invalid();
    return { path: resultPath(entry.path), index: entry.index, worktree: entry.worktree };
  });
  return {
    schemaVersion: value.schemaVersion,
    operation: "gitStatus",
    workspaceBindingId: value.workspaceBindingId,
    branch: value.branch,
    head: value.head,
    entries,
    truncated: value.truncated,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw invalid();
}
function opaque(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    throw invalid();
  return value;
}
function segment(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    /[\\/\p{Cc}\p{Cf}]/u.test(value)
  )
    throw invalid();
  return value;
}
function resultPath(value: string): string {
  if (utf8Bytes(value) > 4096 || value.startsWith("/") || value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === ".." ||
      /[\p{Cc}\p{Cf}]/u.test(part))) throw invalid();
  return value;
}
function safeCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function invalid(): ContractValidationError {
  return new ContractValidationError(
    "workspace_native_readonly_contract_invalid",
  );
}
