import { writeDesktopConfigAtomically } from "./host-config-file.ts";
import {
  consumeLocalWorkspaceProjectRegistration,
  type LocalWorkspaceProjectRegistration,
} from "./host-workspace-project-registration.ts";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const SCHEMA_VERSION = "crewon.desktop-workspace-authority.v2";
const MAX_WORKSPACES = 100;
const MAX_REGISTRY_BYTES = 128 * 1024;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type WorkspaceEntry = Readonly<{ workspaceId: string; root: string }>;
type WorkspaceState = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  activeWorkspaceId: string | null;
  workspaces: readonly WorkspaceEntry[];
}>;
type WorkspaceRootSnapshot = Readonly<{
  revision: number;
  root: string;
}>;

/** The native registry owns private paths; renderer snapshots contain only IDs and names. */
export class LocalWorkspaceAuthority {
  readonly #path: string;
  #state: WorkspaceState;
  #persistedBytes: string;
  #activeGeneration: number;

  constructor(dataDirectory: string, fallbackRoot?: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.#path = join(dataDirectory, "desktop-workspace.json");
    const { state, persist, bytes } = this.#read(fallbackRoot);
    this.#persistedBytes = persist ? this.#write(state, bytes) : bytes!;
    this.#state = state;
    this.#activeGeneration = state.revision;
  }

  status() {
    const workspaces = this.#state.workspaces.map(({ workspaceId, root }) => ({
      workspaceId,
      displayName: basename(root) || "根目录",
    }));
    return {
      schemaVersion: "crewon.desktop-workspace-status.v0",
      availability: "available",
      revision: this.#state.revision,
      supervisorGeneration: this.#state.revision,
      current:
        workspaces.find(
          ({ workspaceId }) => workspaceId === this.#state.activeWorkspaceId,
        ) ?? null,
      workspaces,
    } as const;
  }

  /** Ordinary navigation is a projection of the same registry, never a second registry. */
  ordinaryStatus() {
    const snapshot = this.status();
    const workspaces = snapshot.workspaces.filter(({ workspaceId }) => {
      const entry = this.#state.workspaces.find(
        (value) => value.workspaceId === workspaceId,
      )!;
      return !this.#isProjectAllocation(entry);
    });
    return {
      ...snapshot,
      workspaces,
      current:
        workspaces.find(
          (entry) => entry.workspaceId === snapshot.current?.workspaceId,
        ) ?? null,
    };
  }

  root(workspaceId = this.#state.activeWorkspaceId): string {
    const workspace = this.#state.workspaces.find(
      (entry) => entry.workspaceId === workspaceId,
    );
    if (!workspace) throw new Error("desktop_sandbox_workspace_unbound");
    if (arguments.length === 0 && this.#isProjectAllocation(workspace))
      throw new Error("desktop_workspace_project_requires_scoped_execution");
    const canonical = requireDirectory(workspace.root);
    if (canonical !== workspace.root)
      throw new Error("desktop_workspace_path_changed");
    return canonical;
  }

  captureRoot(): WorkspaceRootSnapshot {
    return { revision: this.#activeGeneration, root: this.root() };
  }

  assertRootCurrent(snapshot: WorkspaceRootSnapshot): void {
    if (
      this.#activeGeneration !== snapshot.revision ||
      this.root() !== snapshot.root
    ) {
      throw new Error("desktop_sandbox_workspace_changed");
    }
  }

  select(root: string, request: unknown) {
    this.#requireMutation(request);
    const canonical = requireDirectory(root);
    const existing = this.#state.workspaces.find(
      (entry) => entry.root === canonical,
    );
    if (
      this.#isProjectAllocation({
        workspaceId: existing?.workspaceId ?? "",
        root: canonical,
      })
    )
      throw new Error("desktop_workspace_project_requires_scoped_execution");
    if (!existing && this.#state.workspaces.length >= MAX_WORKSPACES) {
      throw new Error("desktop_workspace_limit_reached");
    }
    const entry = existing ?? {
      workspaceId: `workspace-${randomUUID()}`,
      root: canonical,
    };
    return this.#commit({
      ...this.#state,
      activeWorkspaceId: entry.workspaceId,
      workspaces: existing
        ? this.#state.workspaces
        : [...this.#state.workspaces, entry],
    });
  }

  activate(workspaceId: string, request: unknown) {
    this.#requireMutation(request);
    if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
      throw new Error("desktop_workspace_id_invalid");
    }
    // An unavailable directory remains registered, but cannot become the active authority.
    const entry = this.#state.workspaces.find(
      (value) => value.workspaceId === workspaceId,
    );
    if (entry && this.#isProjectAllocation(entry))
      throw new Error("desktop_workspace_project_requires_scoped_execution");
    this.root(workspaceId);
    return this.#commit({ ...this.#state, activeWorkspaceId: workspaceId });
  }

  canceled(request: unknown) {
    this.#requireMutation(request);
    return {
      outcome: "userCanceled",
      snapshot: this.ordinaryStatus(),
    } as const;
  }

  clear(request: unknown) {
    this.#requireMutation(request);
    return this.#commit({ ...this.#state, activeWorkspaceId: null });
  }

  /** Actual Native instance brand and private storage root; never exposed by the renderer bridge. */
  projectAllocationDataDirectory(): string {
    this.#assertPersistedCurrent();
    return requireDirectory(dirname(this.#path));
  }

  /** Inspection is also fenced against another real authority's persisted mutation. */
  inspectProjectAllocation(
    workspaceId: string,
    root: string,
  ): "registered" | "absent" {
    this.#assertPersistedCurrent();
    const byId = this.#state.workspaces.find(
      (entry) => entry.workspaceId === workspaceId,
    );
    const byRoot = this.#state.workspaces.find((entry) => entry.root === root);
    if (byId === undefined && byRoot === undefined) return "absent";
    if (byId?.root !== root || byRoot?.workspaceId !== workspaceId)
      throw new Error("desktop_workspace_allocation_conflict");
    if (this.root(workspaceId) !== root)
      throw new Error("desktop_workspace_path_changed");
    return "registered";
  }

  /** Appends to the original v2 registry without activating or invalidating the current root lease. */
  registerProjectAllocation(token: LocalWorkspaceProjectRegistration) {
    const entry = consumeLocalWorkspaceProjectRegistration(this, token);
    if (
      !WORKSPACE_ID.test(entry.workspaceId) ||
      requireDirectory(entry.root) !== entry.root
    )
      throw new Error("desktop_workspace_path_invalid");
    if (
      this.inspectProjectAllocation(entry.workspaceId, entry.root) ===
      "registered"
    )
      return { outcome: "replayed", snapshot: this.status() } as const;
    if (
      this.#state.workspaces.length >= MAX_WORKSPACES ||
      this.#state.revision === Number.MAX_SAFE_INTEGER
    )
      throw new Error("desktop_workspace_limit_reached");
    return this.#commit(
      { ...this.#state, workspaces: [...this.#state.workspaces, entry] },
      "preserveActive",
    );
  }

  #commit(
    state: WorkspaceState,
    binding: "replaceActive" | "preserveActive" = "replaceActive",
  ) {
    const next = { ...state, revision: this.#state.revision + 1 };
    this.#persistedBytes = this.#write(next, this.#persistedBytes);
    this.#state = next;
    if (binding === "replaceActive") this.#activeGeneration = next.revision;
    return {
      outcome: "committed",
      snapshot:
        binding === "preserveActive" ? this.status() : this.ordinaryStatus(),
    } as const;
  }

  #isProjectAllocation(entry: WorkspaceEntry): boolean {
    // Classification only: this grants no owner, installation or execution authority.
    if (/^workspace-project-[a-f0-9]{64}$/u.test(entry.workspaceId))
      return true;
    const path = relative(
      join(requireDirectory(dirname(this.#path)), "plugin-project-workspaces"),
      entry.root,
    );
    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
    );
  }

  #requireMutation(value: unknown): void {
    if (!isPlainObject(value))
      throw new Error("desktop_workspace_request_invalid");
    if (
      Object.keys(value).sort().join("\0") !==
        "expectedRevision\0idempotencyKey" ||
      value.expectedRevision !== this.#state.revision ||
      this.#state.revision === Number.MAX_SAFE_INTEGER ||
      typeof value.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.idempotencyKey)
    )
      throw new Error("desktop_workspace_authority_conflict");
  }

  #read(fallbackRoot?: string): {
    state: WorkspaceState;
    persist: boolean;
    bytes: string | null;
  } {
    if (!existsSync(this.#path)) {
      const entry = fallbackRoot
        ? {
            workspaceId: `workspace-${randomUUID()}`,
            root: requireDirectory(fallbackRoot),
          }
        : null;
      return {
        persist: true,
        bytes: null,
        state: {
          schemaVersion: SCHEMA_VERSION,
          revision: 0,
          activeWorkspaceId: entry?.workspaceId ?? null,
          workspaces: entry ? [entry] : [],
        },
      };
    }
    let value: unknown, bytes: string;
    try {
      bytes = readRegistry(this.#path);
      value = JSON.parse(bytes);
    } catch {
      return invalidRegistry();
    }
    if (
      !isPlainObject(value) ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0
    ) {
      return invalidRegistry();
    }
    if (value.schemaVersion === "crewon.desktop-workspace-authority.v1") {
      if (value.root !== null && typeof value.root !== "string")
        return invalidRegistry();
      const entry =
        value.root === null
          ? null
          : {
              workspaceId: `workspace-${randomUUID()}`,
              root: existingOrMissingDirectory(value.root),
            };
      return {
        persist: true,
        bytes,
        state: {
          schemaVersion: SCHEMA_VERSION,
          revision: Number(value.revision),
          activeWorkspaceId: entry?.workspaceId ?? null,
          workspaces: entry ? [entry] : [],
        },
      };
    }
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(value.workspaces) ||
      value.workspaces.length > MAX_WORKSPACES ||
      (value.activeWorkspaceId !== null &&
        typeof value.activeWorkspaceId !== "string")
    )
      return invalidRegistry();
    const ids = new Set<string>();
    const roots = new Set<string>();
    const workspaces: WorkspaceEntry[] = value.workspaces.map(
      (entry: unknown) => {
        if (
          !isPlainObject(entry) ||
          typeof entry.workspaceId !== "string" ||
          !WORKSPACE_ID.test(entry.workspaceId) ||
          typeof entry.root !== "string" ||
          !isAbsolute(entry.root) ||
          entry.root.includes("\0") ||
          resolve(entry.root) !== entry.root ||
          ids.has(entry.workspaceId) ||
          roots.has(entry.root)
        )
          return invalidRegistry();
        ids.add(entry.workspaceId);
        roots.add(entry.root);
        return { workspaceId: entry.workspaceId, root: entry.root };
      },
    );
    if (value.activeWorkspaceId !== null && !ids.has(value.activeWorkspaceId))
      return invalidRegistry();
    return {
      persist: false,
      bytes,
      state: {
        schemaVersion: SCHEMA_VERSION,
        revision: Number(value.revision),
        activeWorkspaceId: value.activeWorkspaceId,
        workspaces,
      },
    };
  }

  #write(state: WorkspaceState, previous: string | null): string {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES)
      throw new Error("desktop_workspace_limit_reached");
    writeDesktopConfigAtomically(this.#path, serialized, {
      beforeRename: () => {
        const actual = existsSync(this.#path) ? readRegistry(this.#path) : null;
        if (actual !== previous)
          throw new Error("desktop_workspace_authority_conflict");
      },
    });
    return serialized;
  }

  #assertPersistedCurrent(): void {
    if (
      !existsSync(this.#path) ||
      readRegistry(this.#path) !== this.#persistedBytes
    )
      throw new Error("desktop_workspace_authority_conflict");
  }
}

function existingOrMissingDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) return invalidRegistry();
  // Migration preserves an offline/deleted folder instead of silently erasing the saved workspace.
  if (!existsSync(path)) return resolve(path);
  return requireDirectory(path);
}

function readRegistry(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_REGISTRY_BYTES)
      return invalidRegistry();
    const bytes = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > MAX_REGISTRY_BYTES) return invalidRegistry();
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function requireDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("desktop_workspace_path_invalid");
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory())
    throw new Error("desktop_workspace_path_invalid");
  return canonical;
}

function invalidRegistry(): never {
  throw new Error("desktop_workspace_registry_invalid");
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
