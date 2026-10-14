import {
  parsePluginProjectWorkspaceOwner,
  PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS,
  pluginProjectWorkspaceIdentityInput,
  type PluginProjectWorkspaceOwner,
} from "@crewon/domain";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { writeDesktopConfigAtomically } from "./host-config-file.ts";

const SCHEMA = "crewon.desktop-plugin-project-workspace-allocations.v1";
export const ALLOCATION_LOCK_FILE =
  "desktop-plugin-project-allocation-lock.json.pending-v1";
export const ALLOCATION_FAILURE_CODES = [
  "directoryUnavailable",
  "directoryOwnershipUnproven",
  "registryUnavailable",
  "authorityConflict",
  "journalUnavailable",
] as const;
export type AllocationFailureCode = (typeof ALLOCATION_FAILURE_CODES)[number];
export type AllocationRecord = Readonly<{
  owner: PluginProjectWorkspaceOwner;
  workspaceId: string;
  createdAt: string;
  phase: "pending" | "registered" | "failed";
  failureCode: AllocationFailureCode | null;
}>;
type JournalState = Readonly<{
  schemaVersion: typeof SCHEMA;
  revision: number;
  allocations: readonly AllocationRecord[];
}>;
export type AllocationJournalSnapshot = Readonly<{
  state: JournalState;
  bytes: string | null;
}>;
const CAP = 128 * 1024;

export function projectAllocationWorkspaceId(
  owner: PluginProjectWorkspaceOwner,
): string {
  return `workspace-project-${createHash("sha256").update(pluginProjectWorkspaceIdentityInput(owner)).digest("hex")}`;
}

/** The journal describes Native allocation only. It makes no SQL binding or product readiness claim. */
export class LocalWorkspaceProjectAllocationJournal {
  readonly #path: string;
  constructor(dataDirectory: string) {
    this.#path = join(dataDirectory, "desktop-plugin-project-workspaces.json");
  }
  read(): AllocationJournalSnapshot {
    const bytes = readPrivateAllocationFile(this.#path, CAP);
    if (bytes === null)
      return Object.freeze({
        bytes,
        state: Object.freeze({
          schemaVersion: SCHEMA,
          revision: 0,
          allocations: [],
        }),
      });
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      return invalidJournal();
    }
    const v = exactRecord(value, ["schemaVersion", "revision", "allocations"]);
    if (
      v.schemaVersion !== SCHEMA ||
      !Number.isSafeInteger(v.revision) ||
      Number(v.revision) < 0 ||
      !Array.isArray(v.allocations) ||
      v.allocations.length > 100
    )
      return invalidJournal();
    const ids = new Set<string>();
    const allocations = v.allocations.map((entry: unknown) => {
      const allocation = parseAllocationRecord(entry);
      if (ids.has(allocation.workspaceId)) return invalidJournal();
      ids.add(allocation.workspaceId);
      return allocation;
    });
    return Object.freeze({
      bytes,
      state: Object.freeze({
        schemaVersion: SCHEMA,
        revision: Number(v.revision),
        allocations: Object.freeze(allocations),
      }),
    });
  }
  write(
    previous: AllocationJournalSnapshot,
    allocation: AllocationRecord,
  ): void {
    allocation = parseAllocationRecord(allocation);
    if (previous.state.revision === Number.MAX_SAFE_INTEGER)
      return invalidJournal();
    const allocations = previous.state.allocations.filter(
      (entry) => entry.workspaceId !== allocation.workspaceId,
    );
    if (allocations.length >= 100)
      throw new Error("desktop_workspace_allocation_limit_reached");
    allocations.push(allocation);
    const bytes = `${JSON.stringify({ schemaVersion: SCHEMA, revision: previous.state.revision + 1, allocations })}\n`;
    writeDesktopConfigAtomically(this.#path, bytes, {
      beforeRename: () => {
        if (readPrivateAllocationFile(this.#path, CAP) !== previous.bytes)
          throw new Error("desktop_workspace_allocation_journal_conflict");
      },
    });
  }
}

function parseAllocationRecord(input: unknown): AllocationRecord {
  const a = exactRecord(input, [
    "owner",
    "workspaceId",
    "createdAt",
    "phase",
    "failureCode",
  ]);
  const owner = parsePluginProjectWorkspaceOwner(a.owner);
  if (
    a.workspaceId !== projectAllocationWorkspaceId(owner) ||
    typeof a.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(a.createdAt) ||
    !Number.isFinite(Date.parse(a.createdAt)) ||
    !["pending", "registered", "failed"].includes(String(a.phase)) ||
    (a.phase === "failed"
      ? !ALLOCATION_FAILURE_CODES.includes(
          a.failureCode as AllocationFailureCode,
        )
      : a.failureCode !== null)
  )
    return invalidJournal();
  return Object.freeze({
    owner,
    workspaceId: String(a.workspaceId),
    createdAt: a.createdAt,
    phase: a.phase as AllocationRecord["phase"],
    failureCode: a.failureCode as AllocationFailureCode | null,
  });
}

/** No-follow, one-link, private, bounded reads for journal and ownership proof. */
export function readPrivateAllocationFile(
  path: string,
  limit: number,
): string | null {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.size > limit
  )
    return invalidJournal();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      (after.mode & 0o077) !== 0 ||
      after.size > limit
    )
      return invalidJournal();
    const buffer = Buffer.alloc(limit + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > limit) return invalidJournal();
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function exactRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== keys.length ||
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    )
  )
    return invalidJournal();
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(input),
  ))
    if (!("value" in descriptor) || !descriptor.enumerable)
      return invalidJournal();
  return input as Record<string, unknown>;
}
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function invalidJournal(): never {
  throw new Error("desktop_workspace_allocation_journal_invalid");
}
