const MAX_WORKSPACE_CHANGE_PATHS = 256;
const MAX_WORKSPACE_CHANGE_PATH_BYTES = 4_096;
const MAX_WORKSPACE_CHANGE_PATHS_BYTES = 64 * 1_024;
const MAX_WORKSPACE_CHANGE_SUMMARY_BYTES = 16 * 1_024;

export type WorkspaceChangeSummary = Readonly<{
  schemaVersion: "crewon.workspace-change-summary.v0";
  paths: string[];
  additions: number;
  deletions: number;
  statsComplete: boolean;
}>;

/**
 * Enforces the persisted Domain invariant without depending on the public HTTP
 * contract package. Boundary adapters perform their own wire-level parsing.
 */
export function validateWorkspaceChangeSummary(
  input: unknown,
): asserts input is WorkspaceChangeSummary {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, [
      "additions",
      "deletions",
      "paths",
      "schemaVersion",
      "statsComplete",
    ]) ||
    input.schemaVersion !== "crewon.workspace-change-summary.v0" ||
    !Array.isArray(input.paths) ||
    !isNonNegativeSafeInteger(input.additions) ||
    !isNonNegativeSafeInteger(input.deletions) ||
    typeof input.statsComplete !== "boolean" ||
    input.paths.length > MAX_WORKSPACE_CHANGE_PATHS
  ) {
    throw new Error("workspace_change_summary_invalid");
  }

  let pathBytes = 0;
  const paths: string[] = [];
  for (const path of input.paths) {
    if (
      typeof path !== "string" ||
      path.length < 1 ||
      path.startsWith("/") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("workspace_change_summary_invalid");
    }
    const bytes = new TextEncoder().encode(path).byteLength;
    if (bytes > MAX_WORKSPACE_CHANGE_PATH_BYTES) {
      throw new Error("workspace_change_summary_invalid");
    }
    pathBytes += bytes;
    paths.push(path);
  }

  if (
    pathBytes > MAX_WORKSPACE_CHANGE_PATHS_BYTES ||
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path) ||
    (!input.statsComplete &&
      (paths.length !== 0 || input.additions !== 0 || input.deletions !== 0)) ||
    new TextEncoder().encode(JSON.stringify(input)).byteLength >
      MAX_WORKSPACE_CHANGE_SUMMARY_BYTES
  ) {
    throw new Error("workspace_change_summary_invalid");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
