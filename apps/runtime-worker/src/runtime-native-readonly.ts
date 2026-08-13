import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  WORKSPACE_NATIVE_READONLY_LIMITS as LIMITS,
  parseWorkspaceNativeReadonlyRequest,
  type WorkspaceNativeReadonlyRequest,
  type WorkspaceNativeReadonlyResponse,
} from "@crewon/contracts";
import type { RuntimeWorkspaceDispatchAuthority } from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";
const execFileAsync = promisify(execFile);
export class RuntimeNativeReadonlyService {
  readonly #root: string;
  readonly #authority: RuntimeWorkspaceDispatchAuthority;

  constructor(config: {
    root: string;
    authority: RuntimeWorkspaceDispatchAuthority;
  }) {
    if (!isAbsolute(config.root))
      throw failure("workspace_native_root_invalid");
    this.#root = config.root;
    this.#authority = config.authority;
  }

  async execute(
    input: WorkspaceNativeReadonlyRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const request = parseWorkspaceNativeReadonlyRequest(input);
    this.#authorize(request);
    active(signal);
    return request.operation === "contentSearch"
      ? this.#search(request, signal)
      : this.#gitStatus(signal);
  }

  #authorize(request: WorkspaceNativeReadonlyRequest): void {
    if (
      request.tenantId !== this.#authority.tenantId ||
      request.spaceId !== this.#authority.spaceId ||
      request.workspaceBindingId !== this.#authority.workspaceBindingId
    )
      throw failure("workspace_native_scope_denied");
  }

  async #search(
    request: Extract<
      WorkspaceNativeReadonlyRequest,
      { operation: "contentSearch" }
    >,
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const root = await realpath(this.#root);
    let start = root;
    for (const segment of request.pathSegments) {
      start = resolve(start, segment);
      within(root, start);
      if ((await lstat(start)).isSymbolicLink())
        throw failure("workspace_native_link_unsupported");
    }
    if (!(await lstat(start)).isDirectory())
      throw failure("workspace_native_search_directory_invalid");
    const pending = [start];
    const matches: { path: string; line: number; preview: string }[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;
    while (pending.length > 0 && !truncated) {
      active(signal);
      const directory = pending.pop()!;
      if ((await realpath(directory)) !== directory)
        throw failure("workspace_native_link_unsupported");
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        active(signal);
        const path = resolve(directory, entry.name);
        within(root, path);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name !== ".git") pending.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        if (scannedFiles >= LIMITS.maxScannedFiles) {
          truncated = true;
          break;
        }
        const handle = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stats = await handle.stat();
          if (!stats.isFile()) continue;
          if (
            stats.size > LIMITS.maxFileBytes ||
            scannedBytes + stats.size > LIMITS.maxScannedBytes
          ) {
            truncated = true;
            break;
          }
          const bytes = await handle.readFile();
          scannedFiles += 1;
          scannedBytes += bytes.byteLength;
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            continue;
          }
          for (const [index, line] of content.split(/\r?\n/u).entries()) {
            if (!line.includes(request.query)) continue;
            matches.push({
              path: relative(root, path).split("\\").join("/"),
              line: index + 1,
              preview: Buffer.from(line).subarray(0, 768).toString("utf8"),
            });
            if (matches.length >= request.maxMatches) {
              truncated = true;
              break;
            }
          }
        } finally {
          await handle.close();
        }
        if (truncated) break;
      }
    }
    return {
      schemaVersion: "crewon.workspace-native-readonly-response.v0",
      operation: "contentSearch",
      workspaceBindingId: this.#authority.workspaceBindingId,
      matches,
      scannedFiles,
      scannedBytes,
      truncated,
    };
  }

  async #gitStatus(
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const root = await realpath(this.#root);
    const run = (args: readonly string[]) =>
      execFileAsync("git", [...args], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: LIMITS.responseBytes,
        signal,
        timeout: 10_000,
        windowsHide: true,
      });
    try {
      const [status, branch, head] = await Promise.all([
        run([
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
          "--no-renames",
        ]),
        run(["rev-parse", "--abbrev-ref", "HEAD"]),
        run(["rev-parse", "--verify", "HEAD"]),
      ]);
      const records = status.stdout.split("\0").filter(Boolean);
      const truncated = records.length > LIMITS.maxStatusEntries;
      const entries = records
        .slice(0, LIMITS.maxStatusEntries)
        .map((record) => {
          if (record.length < 4 || record[2] !== " ")
            throw failure("workspace_native_git_output_invalid");
          return {
            index: record[0]!,
            worktree: record[1]!,
            path: record.slice(3),
          };
        });
      return {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "gitStatus",
        workspaceBindingId: this.#authority.workspaceBindingId,
        branch:
          branch.stdout.trim() === "HEAD" ? null : branch.stdout.trim() || null,
        head: head.stdout.trim() || null,
        entries,
        truncated,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof RuntimeWorkspaceError
        ? error
        : failure("workspace_native_git_unavailable", error);
    }
  }
}

function within(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path.startsWith("..") || isAbsolute(path))
    throw failure("workspace_native_path_invalid");
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
function failure(code: string, cause?: unknown): RuntimeWorkspaceError {
  return new RuntimeWorkspaceError(code, {
    cause: cause instanceof Error ? cause : undefined,
  });
}
