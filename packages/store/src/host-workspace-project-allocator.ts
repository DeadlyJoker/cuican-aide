import {
  parsePluginProjectWorkspaceOwner,
  type PluginProjectWorkspaceOwner,
} from "@crewon/domain";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LocalWorkspaceAuthority } from "./host-workspace-registry.ts";
import { issueLocalWorkspaceProjectRegistration } from "./host-workspace-project-registration.ts";
import {
  ALLOCATION_LOCK_FILE,
  LocalWorkspaceProjectAllocationJournal,
  exactRecord,
  hasCode,
  projectAllocationWorkspaceId,
  readPrivateAllocationFile,
  type AllocationFailureCode,
  type AllocationRecord,
} from "./host-workspace-project-allocation-journal.ts";

export type LocalWorkspaceProjectAllocationStatus = Readonly<{
  schemaVersion: "crewon.desktop-plugin-project-workspace-allocation-status.v1";
  workspaceId: string;
  phase: "unallocated" | AllocationRecord["phase"];
  observation: "registered" | "unregistered" | "unobserved";
  failureCode: AllocationFailureCode | null;
}>;
const PROOF_SCHEMA = "crewon.desktop-plugin-project-workspace-owner.v1";

/** Host-only provisioning over the original workspace authority; never a renderer command. */
export class LocalWorkspaceProjectAllocator {
  readonly #authority: LocalWorkspaceAuthority;
  readonly #owner: PluginProjectWorkspaceOwner;
  readonly #workspaceId: string;
  readonly #dataDirectory: string;
  readonly #journal: LocalWorkspaceProjectAllocationJournal;
  constructor(
    authority: LocalWorkspaceAuthority,
    owner: PluginProjectWorkspaceOwner,
  ) {
    // The actual class's private brand rejects structural fake authorities and overridden methods.
    this.#dataDirectory =
      LocalWorkspaceAuthority.prototype.projectAllocationDataDirectory.call(
        authority,
      );
    this.#authority = authority;
    this.#owner = parsePluginProjectWorkspaceOwner(owner);
    this.#workspaceId = projectAllocationWorkspaceId(this.#owner);
    this.#journal = new LocalWorkspaceProjectAllocationJournal(
      this.#dataDirectory,
    );
  }
  inspect(): LocalWorkspaceProjectAllocationStatus {
    let record: AllocationRecord | undefined;
    try {
      record = this.#record();
      if (record === undefined)
        return this.#status("unallocated", "unregistered", null);
      if (record.phase !== "registered")
        return this.#status(record.phase, "unobserved", record.failureCode);
      this.#assertOwnedDirectory(this.#root());
      const observation =
        LocalWorkspaceAuthority.prototype.inspectProjectAllocation.call(
          this.#authority,
          this.#workspaceId,
          this.#root(),
        );
      return this.#status(
        record.phase,
        observation === "registered" ? "registered" : "unregistered",
        observation === "registered" ? null : "registryUnavailable",
      );
    } catch (error) {
      return this.#status(
        record?.phase ?? "unallocated",
        "unobserved",
        failureCode(error),
      );
    }
  }
  /** A pending/failed allocation never retries implicitly when opening the project. */
  provision(): LocalWorkspaceProjectAllocationStatus {
    return this.#withLease(() =>
      this.#record() === undefined ? this.#attempt() : this.inspect(),
    );
  }
  /** Explicit recovery replays the same owner, ID and directory, including partial Native commits. */
  recover(): LocalWorkspaceProjectAllocationStatus {
    return this.#withLease(() =>
      this.#record() === undefined
        ? this.#status("unallocated", "unregistered", null)
        : this.#attempt(),
    );
  }
  #record(): AllocationRecord | undefined {
    return this.#journal
      .read()
      .state.allocations.find(
        (record) => record.workspaceId === this.#workspaceId,
      );
  }
  #root(): string {
    return join(
      this.#dataDirectory,
      "plugin-project-workspaces",
      this.#workspaceId,
    );
  }
  #attempt(): LocalWorkspaceProjectAllocationStatus {
    const snapshot = this.#journal.read();
    const previous = snapshot.state.allocations.find(
      (record) => record.workspaceId === this.#workspaceId,
    );
    const pending: AllocationRecord = Object.freeze({
      owner: this.#owner,
      workspaceId: this.#workspaceId,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      phase: "pending",
      failureCode: null,
    });
    // Persist the allocation intent before creating any directory or registry entry.
    this.#journal.write(snapshot, pending);
    let stage: "directory" | "registry" | "journal" = "directory";
    try {
      this.#ensureOwnedDirectory();
      stage = "registry";
      const token = issueLocalWorkspaceProjectRegistration({
        authority: this.#authority,
        workspaceId: this.#workspaceId,
        root: this.#root(),
      });
      LocalWorkspaceAuthority.prototype.registerProjectAllocation.call(
        this.#authority,
        token,
      );
      stage = "journal";
      this.#journal.write(
        this.#journal.read(),
        Object.freeze({ ...pending, phase: "registered" }),
      );
      return this.inspect();
    } catch (error) {
      const code = failureCode(error, stage);
      try {
        this.#journal.write(
          this.#journal.read(),
          Object.freeze({ ...pending, phase: "failed", failureCode: code }),
        );
      } catch {
        /* The persisted pending intent remains recoverable; never claim the failed write committed. */
      }
      return this.inspect();
    }
  }
  #withLease(
    operation: () => LocalWorkspaceProjectAllocationStatus,
  ): LocalWorkspaceProjectAllocationStatus {
    const path = join(this.#dataDirectory, ALLOCATION_LOCK_FILE);
    // A real exclusive fixed staging file excludes other Native processes. Only the original
    // ownsSingleInstance startup cleanup may discard an interrupted lease, never this allocator.
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch {
      throw new Error("desktop_workspace_allocation_lease_unavailable");
    }
    let identity: Readonly<{ dev: number; ino: number }> | undefined;
    try {
      identity = fstatSync(fd);
      writeFileSync(
        fd,
        '{"schemaVersion":"crewon.desktop-plugin-project-allocation-lease.v1"}\n',
        "utf8",
      );
      fsyncSync(fd);
      LocalWorkspaceAuthority.prototype.projectAllocationDataDirectory.call(
        this.#authority,
      );
      return operation();
    } finally {
      try {
        // Proper competing allocators never replace an occupied slot. Still do not remove
        // an externally replaced or linked file merely because it has our fixed name.
        let current;
        try {
          current = lstatSync(path);
        } catch {
          throw new Error("desktop_workspace_allocation_lease_changed");
        }
        if (
          identity === undefined ||
          !current.isFile() ||
          current.nlink !== 1 ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          (current.mode & 0o077) !== 0 ||
          current.size > 1024
        )
          throw new Error("desktop_workspace_allocation_lease_changed");
        unlinkSync(path);
      } finally {
        closeSync(fd);
      }
    }
  }
  #ensureOwnedDirectory(): void {
    const parent = join(this.#dataDirectory, "plugin-project-workspaces");
    ensurePrivateDirectory(parent);
    const root = this.#root();
    if (existsSync(root)) {
      this.#assertOwnedDirectory(root);
      return;
    }
    const staging = join(parent, `.${this.#workspaceId}.pending-v1`);
    if (existsSync(staging)) this.#assertOwnedDirectory(staging);
    else {
      mkdirSync(staging, { mode: 0o700 });
      mkdirSync(join(staging, ".crewon"), { mode: 0o700 });
      const marker = openSync(
        join(staging, ".crewon", "native-project-workspace-owner.json"),
        "wx",
        0o600,
      );
      try {
        writeFileSync(
          marker,
          `${JSON.stringify({ schemaVersion: PROOF_SCHEMA, owner: this.#owner, workspaceId: this.#workspaceId })}\n`,
        );
        fsyncSync(marker);
      } finally {
        closeSync(marker);
      }
    }
    // A legacy user-selected root (including the staging directory) cannot be adopted.
    LocalWorkspaceAuthority.prototype.inspectProjectAllocation.call(
      this.#authority,
      this.#workspaceId,
      staging,
    );
    if (existsSync(root))
      throw new Error("desktop_workspace_allocation_directory_unproven");
    renameSync(staging, root);
    this.#assertOwnedDirectory(root);
  }
  #assertOwnedDirectory(root: string): void {
    assertPrivateDirectory(
      join(this.#dataDirectory, "plugin-project-workspaces"),
    );
    assertPrivateDirectory(root);
    assertPrivateDirectory(join(root, ".crewon"));
    const bytes = readPrivateAllocationFile(
      join(root, ".crewon", "native-project-workspace-owner.json"),
      16 * 1024,
    );
    if (bytes === null)
      throw new Error("desktop_workspace_allocation_directory_unproven");
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw new Error("desktop_workspace_allocation_directory_unproven");
    }
    const proof = exactRecord(value, ["schemaVersion", "owner", "workspaceId"]);
    const owner = parsePluginProjectWorkspaceOwner(proof.owner);
    if (
      proof.schemaVersion !== PROOF_SCHEMA ||
      proof.workspaceId !== this.#workspaceId ||
      projectAllocationWorkspaceId(owner) !== this.#workspaceId
    )
      throw new Error("desktop_workspace_allocation_directory_unproven");
  }
  #status(
    phase: LocalWorkspaceProjectAllocationStatus["phase"],
    observation: LocalWorkspaceProjectAllocationStatus["observation"],
    failureCode: AllocationFailureCode | null,
  ): LocalWorkspaceProjectAllocationStatus {
    return Object.freeze({
      schemaVersion:
        "crewon.desktop-plugin-project-workspace-allocation-status.v1",
      workspaceId: this.#workspaceId,
      phase,
      observation,
      failureCode,
    });
  }
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  assertPrivateDirectory(path);
}
function assertPrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  )
    throw new Error("desktop_workspace_allocation_directory_unproven");
}
function failureCode(
  error: unknown,
  stage: "directory" | "registry" | "journal" = "directory",
): AllocationFailureCode {
  if (error instanceof Error && error.message.includes("authority_conflict"))
    return "authorityConflict";
  if (
    error instanceof Error &&
    (error.message.includes("directory_unproven") ||
      error.message.includes("allocation_conflict"))
  )
    return "directoryOwnershipUnproven";
  if (error instanceof Error && error.message.includes("journal"))
    return "journalUnavailable";
  if (error instanceof Error && error.message.includes("workspace_limit"))
    return "registryUnavailable";
  if (stage === "registry") return "registryUnavailable";
  if (stage === "journal") return "journalUnavailable";
  return "directoryUnavailable";
}
