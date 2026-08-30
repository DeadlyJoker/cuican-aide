import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const VIRTUAL_ROOT = "/workspace";
const MAX_DIRECTORY_ENTRIES = 120;
const MAX_FILE_BYTES = 3_000;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const MAX_COMMAND_TIMEOUT_SECONDS = 30;

type WorkspaceState = {
  schemaVersion: "crewon.desktop-workspace-authority.v1";
  revision: number;
  root: string | null;
};

export class LocalWorkspaceAuthority {
  readonly #path: string;
  #state: WorkspaceState;

  constructor(dataDirectory: string, fallbackRoot?: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.#path = join(dataDirectory, "desktop-workspace.json");
    this.#state = this.#read(fallbackRoot);
  }

  status() {
    return {
      schemaVersion: "crewon.desktop-workspace-status.v0",
      availability: "available",
      revision: this.#state.revision,
      supervisorGeneration: this.#state.revision,
      current:
        this.#state.root === null
          ? null
          : { displayName: basename(this.#state.root) },
    } as const;
  }

  root(): string {
    if (this.#state.root === null) {
      throw new Error("desktop_sandbox_workspace_unbound");
    }
    return realpathSync(this.#state.root);
  }

  select(root: string, request: unknown) {
    this.#requireMutation(request);
    const canonical = requireDirectory(root);
    this.#state = {
      schemaVersion: "crewon.desktop-workspace-authority.v1",
      revision: this.#state.revision + 1,
      root: canonical,
    };
    this.#write();
    return { outcome: "committed", snapshot: this.status() } as const;
  }

  canceled(request: unknown) {
    this.#requireMutation(request);
    return { outcome: "userCanceled", snapshot: this.status() } as const;
  }

  clear(request: unknown) {
    this.#requireMutation(request);
    this.#state = {
      schemaVersion: "crewon.desktop-workspace-authority.v1",
      revision: this.#state.revision + 1,
      root: null,
    };
    this.#write();
    return { outcome: "committed", snapshot: this.status() } as const;
  }

  #requireMutation(value: unknown): void {
    if (!isPlainObject(value))
      throw new Error("desktop_workspace_request_invalid");
    const keys = Object.keys(value).sort();
    if (
      keys.join("\0") !== "expectedRevision\0idempotencyKey" ||
      value.expectedRevision !== this.#state.revision ||
      typeof value.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.idempotencyKey)
    ) {
      throw new Error("desktop_workspace_authority_conflict");
    }
  }

  #read(fallbackRoot?: string): WorkspaceState {
    if (existsSync(this.#path)) {
      try {
        const metadata = statSync(this.#path);
        if (metadata.isFile() && metadata.size <= 16 * 1024) {
          const value: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
          if (
            isPlainObject(value) &&
            value.schemaVersion === "crewon.desktop-workspace-authority.v1" &&
            Number.isSafeInteger(value.revision) &&
            Number(value.revision) >= 0 &&
            (value.root === null || typeof value.root === "string")
          ) {
            return {
              schemaVersion: value.schemaVersion,
              revision: Number(value.revision),
              root:
                value.root === null
                  ? fallbackRoot
                    ? requireDirectory(fallbackRoot)
                    : null
                  : requireDirectory(value.root),
            };
          }
        }
      } catch {
        // A corrupt local preference is replaced by a clean authority state.
      }
    }
    return {
      schemaVersion: "crewon.desktop-workspace-authority.v1",
      revision: 0,
      root: fallbackRoot ? requireDirectory(fallbackRoot) : null,
    };
  }

  #write(): void {
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.#path);
  }
}

export class LocalWorkspaceSandbox {
  constructor(private readonly authority: LocalWorkspaceAuthority) {}

  listDirectory(requestedPath = VIRTUAL_ROOT) {
    const { target, virtualPath } = this.#resolve(requestedPath, "directory");
    const root = this.authority.root();
    const all = readdirSync(target)
      .map((name) => {
        const path = join(target, name);
        const metadata = lstatSync(path);
        const kind = metadata.isSymbolicLink()
          ? "symlink"
          : metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : null;
        return kind === null
          ? null
          : {
              kind,
              name,
              path: virtualPathFor(root, path),
              size: metadata.size,
            };
      })
      .filter((entry) => entry !== null)
      .sort((left, right) =>
        left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === "directory"
            ? -1
            : right.kind === "directory"
              ? 1
              : left.name.localeCompare(right.name),
      );
    return {
      root: VIRTUAL_ROOT,
      path: virtualPath,
      entries: all.slice(0, MAX_DIRECTORY_ENTRIES),
      truncated: all.length > MAX_DIRECTORY_ENTRIES,
    };
  }

  readFile(requestedPath: string) {
    const { target, virtualPath } = this.#resolve(requestedPath, "file");
    const metadata = statSync(target);
    const bytes = readFileSync(target).subarray(0, MAX_FILE_BYTES);
    return {
      path: virtualPath,
      content: bytes.toString("utf8"),
      byteLength: metadata.size,
      truncated: metadata.size > bytes.byteLength,
    };
  }

  async readDiff() {
    const result = await runBounded(
      "git",
      ["diff", "--no-ext-diff", "--"],
      this.authority.root(),
      MAX_COMMAND_TIMEOUT_SECONDS,
    );
    if (result.exitCode !== 0) throw new Error("desktop_sandbox_diff_failed");
    return { cwd: VIRTUAL_ROOT, diff: result.stdout };
  }

  async runCommand(value: unknown) {
    if (!isPlainObject(value) || typeof value.command !== "string") {
      throw new Error("desktop_sandbox_command_invalid");
    }
    const bytes = Buffer.byteLength(value.command);
    if (
      value.command.trim() === "" ||
      bytes > MAX_COMMAND_BYTES ||
      value.command.includes("\0")
    ) {
      throw new Error("desktop_sandbox_command_invalid");
    }
    const cwd = typeof value.cwd === "string" ? value.cwd : VIRTUAL_ROOT;
    const resolved = this.#resolve(cwd, "directory");
    const timeoutSeconds =
      Number.isSafeInteger(value.timeoutSeconds) &&
      Number(value.timeoutSeconds) > 0
        ? Math.min(Number(value.timeoutSeconds), MAX_COMMAND_TIMEOUT_SECONDS)
        : MAX_COMMAND_TIMEOUT_SECONDS;
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args =
      process.platform === "win32"
        ? ["/D", "/S", "/C", value.command]
        : ["-lc", value.command];
    const result = await runBounded(
      shell,
      args,
      resolved.target,
      timeoutSeconds,
    );
    return { cwd: resolved.virtualPath, ...result };
  }

  #resolve(requestedPath: string, expected: "directory" | "file") {
    if (
      typeof requestedPath !== "string" ||
      (requestedPath !== VIRTUAL_ROOT &&
        !requestedPath.startsWith(`${VIRTUAL_ROOT}/`))
    ) {
      throw new Error("desktop_sandbox_path_invalid");
    }
    const segments = requestedPath
      .slice(VIRTUAL_ROOT.length)
      .split("/")
      .filter(Boolean);
    if (
      segments.some(
        (segment) =>
          segment === "." || segment === ".." || segment.includes("\0"),
      )
    ) {
      throw new Error("desktop_sandbox_path_invalid");
    }
    const root = this.authority.root();
    const target = realpathSync(resolve(root, ...segments));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error("desktop_sandbox_path_invalid");
    }
    const metadata = lstatSync(target);
    if (
      metadata.isSymbolicLink() ||
      (expected === "directory" ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      throw new Error("desktop_sandbox_path_invalid");
    }
    return { target, virtualPath: virtualPathFor(root, target) };
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

function virtualPathFor(root: string, path: string): string {
  const suffix = relative(root, path).split(sep).filter(Boolean).join("/");
  return suffix ? `${VIRTUAL_ROOT}/${suffix}` : VIRTUAL_ROOT;
}

function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolveRun, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const collect = (target: Buffer[], chunk: Buffer, current: number) => {
        const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - current);
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        return current + chunk.byteLength;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = collect(stdout, chunk, stdoutBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = collect(stderr, chunk, stderrBytes);
      });
      const timeout = setTimeout(
        () => child.kill("SIGTERM"),
        timeoutSeconds * 1_000,
      );
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveRun({
          exitCode: code ?? 124,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
