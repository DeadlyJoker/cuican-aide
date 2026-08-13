import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_NATIVE_READONLY_LIMITS,
  parseWorkspaceNativeReadonlyControlRequest,
  parseWorkspaceNativeReadonlyControlResponse,
  parseWorkspaceNativeReadonlyResponse,
  type WorkspaceContentSearchRequest,
  type WorkspaceGitStatusRequest,
} from "./workspace-native-readonly.ts";

const search: WorkspaceContentSearchRequest = {
  schemaVersion: "crewon.workspace-native-readonly-request.v0",
  operation: "contentSearch",
  tenantId: "tenant-1",
  spaceId: "space-1",
  workspaceBindingId: "workspace-1",
  query: "needle",
  pathSegments: [],
  maxMatches: 10,
};
const git: WorkspaceGitStatusRequest = {
  schemaVersion: "crewon.workspace-native-readonly-request.v0",
  operation: "gitStatus",
  tenantId: "tenant-1",
  spaceId: "space-1",
  workspaceBindingId: "workspace-1",
};

test("public Workspace read-only contract owns no binding authority", () => {
  assert.deepEqual(
    parseWorkspaceNativeReadonlyControlRequest({
      schemaVersion: search.schemaVersion,
      operation: search.operation,
      query: search.query,
      pathSegments: [],
      maxMatches: 10,
    }),
    {
      schemaVersion: search.schemaVersion,
      operation: search.operation,
      query: search.query,
      pathSegments: [],
      maxMatches: 10,
    },
  );
  assert.throws(() =>
    parseWorkspaceNativeReadonlyControlRequest({
      schemaVersion: git.schemaVersion,
      operation: git.operation,
      workspaceBindingId: "forged",
    }),
  );
  assert.deepEqual(
    parseWorkspaceNativeReadonlyControlResponse(
      {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "gitStatus",
        branch: "main",
        head: "a".repeat(40),
        entries: [],
        truncated: false,
      },
      { schemaVersion: git.schemaVersion, operation: git.operation },
    ),
    {
      schemaVersion: "crewon.workspace-native-readonly-response.v0",
      operation: "gitStatus",
      branch: "main",
      head: "a".repeat(40),
      entries: [],
      truncated: false,
    },
  );
  assert.throws(() =>
    parseWorkspaceNativeReadonlyControlResponse(
      {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "gitStatus",
        workspaceBindingId: "leaked",
        branch: "main",
        head: "a".repeat(40),
        entries: [],
        truncated: false,
      },
      { schemaVersion: git.schemaVersion, operation: git.operation },
    ),
  );
});

test("private response enforces scan counters and porcelain status codes", () => {
  const response = {
    schemaVersion: "crewon.workspace-native-readonly-response.v0",
    operation: "contentSearch",
    workspaceBindingId: "workspace-1",
    matches: [],
    scannedFiles: 0,
    scannedBytes: 0,
    truncated: false,
  } as const;
  assert.throws(() =>
    parseWorkspaceNativeReadonlyResponse(
      {
        ...response,
        scannedFiles: WORKSPACE_NATIVE_READONLY_LIMITS.maxScannedFiles + 1,
      },
      search,
    ),
  );
  assert.throws(() =>
    parseWorkspaceNativeReadonlyResponse(
      {
        ...response,
        scannedBytes: WORKSPACE_NATIVE_READONLY_LIMITS.maxScannedBytes + 1,
      },
      search,
    ),
  );
  assert.throws(() =>
    parseWorkspaceNativeReadonlyResponse(
      {
        schemaVersion: response.schemaVersion,
        operation: "gitStatus",
        workspaceBindingId: "workspace-1",
        branch: "main",
        head: "a".repeat(40),
        entries: [{ path: "safe.txt", index: "X", worktree: " " }],
        truncated: false,
      },
      git,
    ),
  );
});
