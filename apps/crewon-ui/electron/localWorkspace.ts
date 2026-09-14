import { spawn } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";

export { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";

const VIRTUAL_ROOT = "/workspace";
const MAX_DIRECTORY_ENTRIES = 120;
const MAX_FILE_BYTES = 3_000;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const MAX_COMMAND_TIMEOUT_SECONDS = 30;
const MAX_DIFF_BYTES = 96 * 1024;
const MAX_GIT_BRANCH_BYTES = 1_024;
const MAX_GIT_PATH_LIST_BYTES = 64 * 1024;
const MAX_UNTRACKED_FILES = 200;
const GIT_WORKSPACE_PATHSPEC = [".", ":(exclude).crewon/**"] as const;

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
    const repository = await runBounded(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      root,
      MAX_COMMAND_TIMEOUT_SECONDS,
      128,
    );
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

    const headResult = await runBounded(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      root,
      MAX_COMMAND_TIMEOUT_SECONDS,
      128,
    );
    const head =
      headResult.exitCode === 0
        ? requireGitHead(headResult.stdout.trim())
        : headResult.exitCode === 128
          ? null
          : failGitDiff();
    const branchResult = await runBounded(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      root,
      MAX_COMMAND_TIMEOUT_SECONDS,
      MAX_GIT_BRANCH_BYTES + 1,
    );
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
        const tracked = await runBounded(
          "git",
          [...trackedArgs, "HEAD", "--", ...GIT_WORKSPACE_PATHSPEC],
          root,
          MAX_COMMAND_TIMEOUT_SECONDS,
          MAX_DIFF_BYTES,
        );
        if (tracked.exitCode !== 0) failGitDiff();
        appendDiff(tracked.stdout);
        diffTruncated = tracked.stdoutTruncated;
      }
      const trackedStatsResult = await runBounded(
        "git",
        [
          "diff",
          "--shortstat",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
          ...GIT_WORKSPACE_PATHSPEC,
        ],
        root,
        MAX_COMMAND_TIMEOUT_SECONDS,
        1_024,
        gitLocaleEnvironment(),
      );
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
      const staged = await runBounded(
        "git",
        [...trackedArgs, "--cached", "--", ...GIT_WORKSPACE_PATHSPEC],
        root,
        MAX_COMMAND_TIMEOUT_SECONDS,
        MAX_DIFF_BYTES,
      );
      if (staged.exitCode !== 0) failGitDiff();
      appendDiff(staged.stdout);
      diffTruncated = staged.stdoutTruncated;
      const remaining = MAX_DIFF_BYTES - Buffer.byteLength(diff);
      if (remaining > 0) {
        const unstaged = await runBounded(
          "git",
          [...trackedArgs, "--", ...GIT_WORKSPACE_PATHSPEC],
          root,
          MAX_COMMAND_TIMEOUT_SECONDS,
          remaining,
        );
        if (unstaged.exitCode !== 0) failGitDiff();
        appendDiff(unstaged.stdout);
        diffTruncated ||= unstaged.stdoutTruncated;
      }
    }

    const untracked = await runBounded(
      "git",
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...GIT_WORKSPACE_PATHSPEC,
      ],
      root,
      MAX_COMMAND_TIMEOUT_SECONDS,
      MAX_GIT_PATH_LIST_BYTES,
    );
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
      const fileStatsResult = await runBounded(
        "git",
        [
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
        root,
        MAX_COMMAND_TIMEOUT_SECONDS,
        1_024,
        gitLocaleEnvironment(),
      );
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
      const patch = await runBounded(
        "git",
        [
          ...trackedArgs,
          "--no-index",
          "--",
          gitNullDevice(process.platform),
          relativePath,
        ],
        root,
        MAX_COMMAND_TIMEOUT_SECONDS,
        remaining,
      );
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

function virtualPathFor(root: string, path: string): string {
  const suffix = relative(root, path).split(sep).filter(Boolean).join("/");
  return suffix ? `${VIRTUAL_ROOT}/${suffix}` : VIRTUAL_ROOT;
}

function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  maximumOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const collect = (target: Buffer[], chunk: Buffer, current: number) => {
      const remaining = Math.max(0, maximumOutputBytes - current);
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
        stdoutTruncated: stdoutBytes > maximumOutputBytes,
        stderrTruncated: stderrBytes > maximumOutputBytes,
      });
    });
  });
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
