import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ApplicationError,
  type ActorContext,
  type ThreadWorkspaceAdmissionPort,
} from "@crewon/application";
import { normalizeThreadWorkspaceId } from "@crewon/domain";

const ENVIRONMENT_NAME = "CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH";
const MAX_REGISTRY_BYTES = 128 * 1024;

/** This local authority is never available to a production process. */
export function resolveDesktopWorkspaceRegistryPath(
  environment: Readonly<Record<string, string | undefined>>,
  securityMode: "standalone" | "production",
): string | undefined {
  const path = environment[ENVIRONMENT_NAME];
  if (securityMode === "production") {
    if (path !== undefined) throw new Error(`${ENVIRONMENT_NAME}_forbidden`);
    return undefined;
  }
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || path.trim() !== path || path.includes("\0")) {
    throw new Error(`${ENVIRONMENT_NAME}_invalid`);
  }
  return path;
}

/** Reads only native registry identity; no renderer path becomes authority. */
export function createDesktopWorkspaceAdmission(
  path: string | undefined,
  actor: ActorContext,
): ThreadWorkspaceAdmissionPort | undefined {
  if (path === undefined) return undefined;
  return {
    async admit(input) {
      if (
        input.actor.tenantId !== actor.tenantId ||
        input.actor.spaceId !== actor.spaceId ||
        input.actor.actorId !== actor.actorId ||
        input.actor.principalId !== actor.principalId
      ) {
        throw new ApplicationError("notFound", "workspace_not_found");
      }
      let workspaceIds: ReadonlySet<string>;
      try {
        workspaceIds = readWorkspaceIds(path);
      } catch (cause) {
        throw new ApplicationError(
          "internal",
          "workspace_registry_unavailable",
          { cause },
        );
      }
      if (!workspaceIds.has(input.workspaceId)) {
        throw new ApplicationError("notFound", "workspace_not_found");
      }
    },
  };
}

function readWorkspaceIds(path: string): ReadonlySet<string> {
  const descriptor = openSync(path, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_REGISTRY_BYTES)
      invalid();
    const bytes = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length < 2 || length > MAX_REGISTRY_BYTES) invalid();
    const value: unknown = JSON.parse(
      bytes.subarray(0, length).toString("utf8"),
    );
    if (
      !record(value) ||
      !exactKeys(value, [
        "schemaVersion",
        "revision",
        "activeWorkspaceId",
        "workspaces",
      ]) ||
      value.schemaVersion !== "crewon.desktop-workspace-authority.v2" ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 ||
      !Array.isArray(value.workspaces) ||
      value.workspaces.length > 100
    )
      invalid();
    const ids = new Set<string>();
    for (const entry of value.workspaces) {
      if (
        !record(entry) ||
        !exactKeys(entry, ["workspaceId", "root"]) ||
        typeof entry.workspaceId !== "string" ||
        normalizeThreadWorkspaceId(entry.workspaceId) === null ||
        ids.has(entry.workspaceId) ||
        typeof entry.root !== "string"
      )
        invalid();
      ids.add(entry.workspaceId);
    }
    if (
      value.activeWorkspaceId !== null &&
      (typeof value.activeWorkspaceId !== "string" ||
        !ids.has(value.activeWorkspaceId))
    )
      invalid();
    return ids;
  } finally {
    closeSync(descriptor);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function invalid(): never {
  throw new Error("desktop_workspace_registry_invalid");
}
