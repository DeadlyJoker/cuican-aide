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
} from "@crewon/contracts/runtime";
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
    switch (request.operation) {
      case "contentSearch":
        return this.#search(request, signal);
      case "gitStatus":
        return this.#gitStatus(signal);
      case "listDirectory":
        return this.#listDirectory(request.pathSegments, signal);
      case "readTextFile":
        return this.#readTextFile(request.pathSegments, signal);
      case "gitDiff":
        return this.#gitDiff(request.pathSegments, signal);
    }
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
      execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: LIMITS.responseBytes,
        signal,
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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
      const statusText = decodeGitOutput(status.stdout);
      const branchText = decodeGitOutput(branch.stdout).trim();
      const headText = decodeGitOutput(head.stdout).trim();
      const records = statusText.split("\0").filter(Boolean);
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
        branch: branchText === "HEAD" ? null : branchText || null,
        head: headText || null,
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

  async #listDirectory(
    pathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const { root, path } = await this.#boundedPath(pathSegments, "directory");
    active(signal);
    const listed = await readdir(path, { withFileTypes: true });
    const entries = listed
      .filter(
        (entry) =>
          !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()),
      )
      .sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      );
    return {
      schemaVersion: "crewon.workspace-native-readonly-response.v0",
      operation: "listDirectory",
      workspaceBindingId: this.#authority.workspaceBindingId,
      path: relative(root, path).split("\\").join("/"),
      entries: entries.slice(0, LIMITS.maxDirectoryEntries).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      })),
      truncated: entries.length > LIMITS.maxDirectoryEntries,
    };
  }

  async #readTextFile(
    pathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const { root, path } = await this.#boundedPath(pathSegments, "file");
    active(signal);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || !Number.isSafeInteger(stats.size))
        throw failure("workspace_native_read_file_invalid");
      const buffer = Buffer.alloc(LIMITS.maxReadTextBytes + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        active(signal);
        const result = await handle.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const truncated = offset > LIMITS.maxReadTextBytes;
      let end = Math.min(offset, LIMITS.maxReadTextBytes);
      let content: string | null = null;
      for (let backoff = 0; backoff < 4 && end >= 0; backoff += 1) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, end),
          );
          break;
        } catch {
          if (!truncated) break;
          end -= 1;
        }
      }
      if (content === null)
        throw failure("workspace_native_read_file_not_text");
      return {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "readTextFile",
        workspaceBindingId: this.#authority.workspaceBindingId,
        path: relative(root, path).split("\\").join("/"),
        content,
        size: stats.size,
        truncated,
      };
    } finally {
      await handle.close();
    }
  }

  async #gitDiff(
    pathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const { root, path } = await this.#boundedPath(pathSegments, "file");
    active(signal);
    try {
      const result = await execFileAsync(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--unified=3",
          "HEAD",
          "--",
          relative(root, path),
        ],
        {
          cwd: root,
          encoding: "buffer",
          maxBuffer: LIMITS.maxFileBytes,
          signal,
          timeout: 10_000,
          windowsHide: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
      );
      const bytes =
        typeof result.stdout === "string"
          ? Buffer.from(result.stdout)
          : result.stdout;
      return {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "gitDiff",
        workspaceBindingId: this.#authority.workspaceBindingId,
        path: relative(root, path).split("\\").join("/"),
        patch: decodeUtf8Prefix(bytes, LIMITS.maxGitDiffBytes),
        truncated: bytes.byteLength > LIMITS.maxGitDiffBytes,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof RuntimeWorkspaceError
        ? error
        : failure("workspace_native_git_diff_unavailable", error);
    }
  }

  async #boundedPath(
    pathSegments: readonly string[],
    kind: "directory" | "file",
  ): Promise<{ root: string; path: string }> {
    const root = await realpath(this.#root);
    const candidate = resolve(root, ...pathSegments);
    within(root, candidate);
    const path = await realpath(candidate);
    within(root, path);
    if (path !== candidate) throw failure("workspace_native_link_unsupported");
    const stats = await lstat(path);
    if (
      stats.isSymbolicLink() ||
      (kind === "directory" ? !stats.isDirectory() : !stats.isFile())
    )
      throw failure(
        kind === "directory"
          ? "workspace_native_list_directory_invalid"
          : "workspace_native_read_file_invalid",
      );
    return { root, path };
  }
}

export function decodeGitOutput(value: string | Buffer): string {
  try {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw failure("workspace_native_git_output_invalid", error);
  }
}

function decodeUtf8Prefix(bytes: Buffer, maximum: number): string {
  let end = Math.min(bytes.byteLength, maximum);
  for (let backoff = 0; backoff < 4 && end >= 0; backoff += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, end),
      );
    } catch {
      if (bytes.byteLength <= maximum) break;
      end -= 1;
    }
  }
  throw failure("workspace_native_git_output_invalid");
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
