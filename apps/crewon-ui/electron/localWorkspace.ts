import { writeDesktopConfigAtomically } from "./desktopConfigFile.ts";
import {
  withWorkspaceProcesses,
  type WorkspaceProcessRequest,
} from "./localWorkspaceProcesses.ts";
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
} from "./localWorkspaceReads.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const VIRTUAL_ROOT = "/workspace";
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_TIMEOUT_SECONDS = 30;
const MAX_DIFF_BYTES = 96 * 1024;
const MAX_GIT_BRANCH_BYTES = 1_024;
const MAX_GIT_PATH_LIST_BYTES = 64 * 1024;
const MAX_UNTRACKED_FILES = 200;
const GIT_WORKSPACE_PATHSPEC = [".", ":(exclude).crewon/**"] as const;

type WorkspaceState = {
  schemaVersion: "crewon.desktop-workspace-authority.v1";
  revision: number;
  root: string | null;
};

type WorkspaceRootSnapshot = Readonly<{
  revision: number;
  root: string;
}>;

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

  captureRoot(): WorkspaceRootSnapshot {
    return { revision: this.#state.revision, root: this.root() };
  }

  assertRootCurrent(snapshot: WorkspaceRootSnapshot): void {
    if (
      this.#state.revision !== snapshot.revision ||
      this.#state.root !== snapshot.root
    ) {
      throw new Error("desktop_sandbox_workspace_changed");
    }
  }

  select(root: string, request: unknown) {
    this.#requireMutation(request);
    const canonical = requireDirectory(root);
    this.#write({
      schemaVersion: "crewon.desktop-workspace-authority.v1",
      revision: this.#state.revision + 1,
      root: canonical,
    });
    return { outcome: "committed", snapshot: this.status() } as const;
  }

  canceled(request: unknown) {
    this.#requireMutation(request);
    return { outcome: "userCanceled", snapshot: this.status() } as const;
  }

  clear(request: unknown) {
    this.#requireMutation(request);
    this.#write({
      schemaVersion: "crewon.desktop-workspace-authority.v1",
      revision: this.#state.revision + 1,
      root: null,
    });
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

  #write(state: WorkspaceState): void {
    writeDesktopConfigAtomically(this.#path, `${JSON.stringify(state)}\n`);
    this.#state = state;
  }
}

export class LocalWorkspaceSandbox {
  constructor(private readonly authority: LocalWorkspaceAuthority) {}

  listDirectory(requestedPath = VIRTUAL_ROOT) {
    return listWorkspaceDirectory(this.authority, requestedPath);
  }

  readFile(requestedPath: string) {
    return readWorkspaceFile(this.authority, requestedPath);
  }

  async readGitSummary() {
    const view = await this.#readGit(false);
    return {
      cwd: view.cwd,
      isGitRepository: view.isGitRepository,
      branch: view.branch,
      head: view.head,
      changedFiles: view.changedFiles,
      additions: view.additions,
      deletions: view.deletions,
      statsComplete: view.statsComplete,
    };
  }

  async readDiff() {
    return this.#readGit(true);
  }

  async #readGit(includeDiff: boolean) {
    const workspace = this.authority.captureRoot();
    const root = workspace.root;
    return withWorkspaceProcesses(async (run) => {
      const runGit = async (
        request: Omit<WorkspaceProcessRequest, "command" | "cwd">,
      ) => {
        this.authority.assertRootCurrent(workspace);
        const result = await run({ ...request, command: "git", cwd: root });
        if (result.timedOut) throw new Error("desktop_sandbox_command_timeout");
        return result;
      };
      const repository = await runGit({
        args: ["rev-parse", "--is-inside-work-tree"],
        maximumOutputBytes: 128,
      });
      if (repository.exitCode !== 0) {
        this.authority.assertRootCurrent(workspace);
        return {
          cwd: VIRTUAL_ROOT,
          diff: "",
          isGitRepository: false,
          branch: null,
          head: null,
          changedFiles: 0,
          additions: 0,
          deletions: 0,
          statsComplete: false,
          diffTruncated: false,
        } as const;
      }
      if (repository.stdout.trim() !== "true") {
        throw new Error("desktop_sandbox_diff_failed");
      }

      const headResult = await runGit({
        args: ["rev-parse", "--verify", "HEAD"],
        maximumOutputBytes: 128,
      });
      const head =
        headResult.exitCode === 0
          ? requireGitHead(headResult.stdout.trim())
          : headResult.exitCode === 128
            ? null
            : failGitDiff();
      const branchResult = await runGit({
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        maximumOutputBytes: MAX_GIT_BRANCH_BYTES + 1,
      });
      const branch =
        branchResult.exitCode === 0
          ? requireGitBranch(branchResult.stdout.replace(/[\r\n]+$/u, ""))
          : branchResult.exitCode === 1 || branchResult.exitCode === 128
            ? null
            : failGitDiff();

      let diff = "";
      let diffTruncated = false;
      let changedFiles = 0;
      let additions = 0;
      let deletions = 0;
      let statsComplete = head !== null;
      const appendDiff = (value: string) => {
        const remaining = MAX_DIFF_BYTES - Buffer.byteLength(diff);
        if (remaining > 0) diff += truncateUtf8(value, remaining);
      };
      const trackedArgs = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
      ];
      if (head !== null) {
        if (includeDiff) {
          const tracked = await runGit({
            args: [...trackedArgs, "HEAD", "--", ...GIT_WORKSPACE_PATHSPEC],
            maximumOutputBytes: MAX_DIFF_BYTES,
          });
          if (tracked.exitCode !== 0) failGitDiff();
          appendDiff(tracked.stdout);
          diffTruncated = tracked.stdoutTruncated;
        }
        const trackedStatsResult = await runGit({
          args: [
            "diff",
            "--shortstat",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
            ...GIT_WORKSPACE_PATHSPEC,
          ],
          maximumOutputBytes: 1_024,
          environment: gitLocaleEnvironment(),
        });
        if (trackedStatsResult.exitCode !== 0) failGitDiff();
        const trackedStats = parseGitShortstat(trackedStatsResult.stdout);
        changedFiles += trackedStats.changedFiles;
        additions += trackedStats.additions;
        deletions += trackedStats.deletions;
        statsComplete =
          statsComplete &&
          !trackedStatsResult.stdoutTruncated &&
          trackedStats.complete;
      } else if (includeDiff) {
        const staged = await runGit({
          args: [...trackedArgs, "--cached", "--", ...GIT_WORKSPACE_PATHSPEC],
          maximumOutputBytes: MAX_DIFF_BYTES,
        });
        if (staged.exitCode !== 0) failGitDiff();
        appendDiff(staged.stdout);
        diffTruncated = staged.stdoutTruncated;
        const remaining = MAX_DIFF_BYTES - Buffer.byteLength(diff);
        if (remaining > 0) {
          const unstaged = await runGit({
            args: [...trackedArgs, "--", ...GIT_WORKSPACE_PATHSPEC],
            maximumOutputBytes: remaining,
          });
          if (unstaged.exitCode !== 0) failGitDiff();
          appendDiff(unstaged.stdout);
          diffTruncated ||= unstaged.stdoutTruncated;
        }
      }

      const untracked = await runGit({
        args: [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ...GIT_WORKSPACE_PATHSPEC,
        ],
        maximumOutputBytes: MAX_GIT_PATH_LIST_BYTES,
      });
      if (untracked.exitCode !== 0) failGitDiff();
      const untrackedPaths = untracked.stdout.split("\0");
      if (untracked.stdout && !untracked.stdout.endsWith("\0")) {
        untrackedPaths.pop();
      }
      const allUntrackedPaths = untrackedPaths.filter(Boolean);
      if (
        untracked.stdoutTruncated ||
        allUntrackedPaths.length > MAX_UNTRACKED_FILES
      ) {
        statsComplete = false;
        diffTruncated = includeDiff;
      }
      for (const relativePath of allUntrackedPaths.slice(
        0,
        MAX_UNTRACKED_FILES,
      )) {
        if (
          isAbsolute(relativePath) ||
          relativePath.split("/").some((segment) => segment === "..")
        ) {
          failGitDiff();
        }
        if (Number.isSafeInteger(changedFiles + 1)) {
          changedFiles += 1;
        } else {
          statsComplete = false;
        }
        const fileStatsResult = await runGit({
          args: [
            "diff",
            "--shortstat",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-index",
            "--",
            gitNullDevice(process.platform),
            relativePath,
          ],
          maximumOutputBytes: 1_024,
          environment: gitLocaleEnvironment(),
        });
        if (fileStatsResult.exitCode !== 0 && fileStatsResult.exitCode !== 1) {
          failGitDiff();
        }
        if (fileStatsResult.stdout) {
          const fileStats = parseGitShortstat(fileStatsResult.stdout);
          const nextAdditions = additions + fileStats.additions;
          const nextDeletions = deletions + fileStats.deletions;
          if (
            Number.isSafeInteger(nextAdditions) &&
            Number.isSafeInteger(nextDeletions)
          ) {
            additions = nextAdditions;
            deletions = nextDeletions;
          } else {
            statsComplete = false;
          }
          statsComplete =
            statsComplete &&
            !fileStatsResult.stdoutTruncated &&
            fileStats.complete &&
            fileStats.changedFiles === 1;
        } else {
          try {
            const metadata = lstatSync(join(root, relativePath));
            statsComplete =
              statsComplete && metadata.isFile() && metadata.size === 0;
          } catch {
            statsComplete = false;
          }
        }
        if (!includeDiff) continue;
        const remaining = MAX_DIFF_BYTES - Buffer.byteLength(diff);
        if (remaining <= 0) {
          diffTruncated = true;
          continue;
        }
        const patch = await runGit({
          args: [
            ...trackedArgs,
            "--no-index",
            "--",
            gitNullDevice(process.platform),
            relativePath,
          ],
          maximumOutputBytes: remaining,
        });
        if (patch.exitCode !== 0 && patch.exitCode !== 1) failGitDiff();
        diffTruncated ||= patch.stdoutTruncated;
        if (diff && patch.stdout && !diff.endsWith("\n")) appendDiff("\n");
        appendDiff(patch.stdout);
      }

      this.authority.assertRootCurrent(workspace);
      return {
        cwd: VIRTUAL_ROOT,
        diff,
        isGitRepository: true,
        branch,
        head,
        changedFiles,
        additions,
        deletions,
        statsComplete,
        diffTruncated,
      } as const;
    });
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
    const result = await withWorkspaceProcesses((run) =>
      run({
        command: shell,
        args,
        cwd: resolved.target,
        timeoutMs: timeoutSeconds * 1_000,
      }),
    );
    return {
      cwd: resolved.virtualPath,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
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

export function gitNullDevice(platform: NodeJS.Platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

function gitLocaleEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: "C", LC_ALL: "C" };
}

function parseGitShortstat(value: string): {
  changedFiles: number;
  additions: number;
  deletions: number;
  complete: boolean;
} {
  const trimmed = value.trim();
  if (!trimmed) {
    return { changedFiles: 0, additions: 0, deletions: 0, complete: true };
  }
  const result = { changedFiles: 0, additions: 0, deletions: 0 };
  const seen = new Set<keyof typeof result>();
  const patterns: ReadonlyArray<readonly [keyof typeof result, RegExp]> = [
    ["changedFiles", /^(\d+) files? changed$/u],
    ["additions", /^(\d+) insertions?\(\+\)$/u],
    ["deletions", /^(\d+) deletions?\(-\)$/u],
  ];
  for (const part of trimmed.split(", ")) {
    const matched = patterns.find(([, pattern]) => pattern.test(part));
    if (!matched || seen.has(matched[0])) {
      return { ...result, complete: false };
    }
    const match = matched[1].exec(part);
    const count = Number(match?.[1]);
    if (!Number.isSafeInteger(count) || count < 0) {
      return { ...result, complete: false };
    }
    result[matched[0]] = count;
    seen.add(matched[0]);
  }
  return { ...result, complete: seen.has("changedFiles") };
}

function requireGitBranch(value: string): string {
  if (
    value.length < 1 ||
    Buffer.byteLength(value) > MAX_GIT_BRANCH_BYTES ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    return failGitDiff();
  }
  return value;
}

function requireGitHead(value: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    return failGitDiff();
  }
  return value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0) {
    const candidate = bytes.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(candidate) <= maximumBytes) return candidate;
    end -= 1;
  }
  return "";
}

function failGitDiff(): never {
  throw new Error("desktop_sandbox_diff_failed");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
