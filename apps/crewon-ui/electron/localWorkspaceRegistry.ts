import { writeDesktopConfigAtomically } from "./desktopConfigFile.ts";
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
import { basename, isAbsolute, join, resolve } from "node:path";

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

  constructor(dataDirectory: string, fallbackRoot?: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.#path = join(dataDirectory, "desktop-workspace.json");
    const { state, persist } = this.#read(fallbackRoot);
    if (persist) this.#write(state);
    this.#state = state;
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

  root(workspaceId = this.#state.activeWorkspaceId): string {
    const workspace = this.#state.workspaces.find(
      (entry) => entry.workspaceId === workspaceId,
    );
    if (!workspace) throw new Error("desktop_sandbox_workspace_unbound");
    const canonical = requireDirectory(workspace.root);
    if (canonical !== workspace.root)
      throw new Error("desktop_workspace_path_changed");
    return canonical;
  }

  captureRoot(): WorkspaceRootSnapshot {
    return { revision: this.#state.revision, root: this.root() };
  }

  assertRootCurrent(snapshot: WorkspaceRootSnapshot): void {
    if (
      this.#state.revision !== snapshot.revision ||
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
    this.root(workspaceId);
    return this.#commit({ ...this.#state, activeWorkspaceId: workspaceId });
  }

  canceled(request: unknown) {
    this.#requireMutation(request);
    return { outcome: "userCanceled", snapshot: this.status() } as const;
  }

  clear(request: unknown) {
    this.#requireMutation(request);
    return this.#commit({ ...this.#state, activeWorkspaceId: null });
  }

  #commit(state: WorkspaceState) {
    const next = { ...state, revision: this.#state.revision + 1 };
    this.#write(next);
    this.#state = next;
    return { outcome: "committed", snapshot: this.status() } as const;
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

  #read(fallbackRoot?: string): { state: WorkspaceState; persist: boolean } {
    if (!existsSync(this.#path)) {
      const entry = fallbackRoot
        ? {
            workspaceId: `workspace-${randomUUID()}`,
            root: requireDirectory(fallbackRoot),
          }
        : null;
      return {
        persist: true,
        state: {
          schemaVersion: SCHEMA_VERSION,
          revision: 0,
          activeWorkspaceId: entry?.workspaceId ?? null,
          workspaces: entry ? [entry] : [],
        },
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(readRegistry(this.#path));
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
      state: {
        schemaVersion: SCHEMA_VERSION,
        revision: Number(value.revision),
        activeWorkspaceId: value.activeWorkspaceId,
        workspaces,
      },
    };
  }

  #write(state: WorkspaceState): void {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES)
      throw new Error("desktop_workspace_limit_reached");
    writeDesktopConfigAtomically(this.#path, serialized);
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
