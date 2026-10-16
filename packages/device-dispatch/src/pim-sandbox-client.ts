import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  MAX_WORKSPACE_CHANGE_SUMMARY_BYTES,
  parseWorkspaceChangeSummary,
  type WorkspaceChangeSummary,
} from "@crewon/contracts";

const SANDBOX_ROOT = "/workspace";
const MAX_DIRECTORY_ENTRIES = 120;
const MAX_FILE_BYTES = 3_000;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_DIFF_BYTES = 96 * 1024;
const MAX_GIT_BRANCH_BYTES = 1_024;
const MAX_GIT_PATH_LIST_BYTES = 64 * 1024;
const MAX_UNTRACKED_FILES = 200;
const MAX_TASK_CHANGE_NUMSTAT_BYTES = 96 * 1024;
const MAX_TRACKED_COMMAND_STREAM_BYTES = 24 * 1024;
const MAX_PIM_RESPONSE_BYTES = 256 * 1024;
const MAX_PIM_LOGIN_RESPONSE_BYTES = 16 * 1024;
const TRACKED_COMMAND_GRACE_SECONDS = 15;
const TRACKED_COMMAND_TRUNCATION_MARKER = "output truncated after 24576 bytes";

export type SandboxDirectoryEntry = Readonly<{
  kind: "directory" | "file" | "symlink";
  name: string;
  path: string;
  size: number;
}>;

export type SandboxDirectoryView = Readonly<{
  root: typeof SANDBOX_ROOT;
  path: string;
  entries: readonly SandboxDirectoryEntry[];
  truncated: boolean;
}>;

export type SandboxFileView = Readonly<{
  path: string;
  content: string;
  byteLength: number;
  truncated: boolean;
}>;

export type SandboxGitSummaryView = Readonly<{
  cwd: typeof SANDBOX_ROOT;
  isGitRepository: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  statsComplete: boolean;
}>;

export type SandboxDiffView = SandboxGitSummaryView &
  Readonly<{
    diff: string;
    diffTruncated: boolean;
  }>;

export type SandboxCommandView = Readonly<{
  cwd: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export type SandboxTrackedCommandView = Readonly<{
  command: SandboxCommandView;
  workspaceChanges: WorkspaceChangeSummary;
}>;

export interface ThreadSandboxPort {
  listDirectory(requestedPath?: string): Promise<SandboxDirectoryView>;
  readFile(requestedPath: string): Promise<SandboxFileView>;
  readGitSummary(): Promise<SandboxGitSummaryView>;
  readDiff(): Promise<SandboxDiffView>;
  runCommand(
    input: {
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<SandboxCommandView>;
  runTrackedCommand?(
    input: {
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<SandboxTrackedCommandView>;
}

type PimExecution = Readonly<{
  exit_code: number;
  stderr?: string;
  stdout?: string;
}>;

/** The mutation was dispatched, but PIM did not return a trustworthy receipt. */
export class PimSandboxMutationOutcomeUnknownError extends Error {
  constructor(options?: ErrorOptions) {
    super("pim_sandbox_mutation_outcome_unknown", options);
    this.name = "PimSandboxMutationOutcomeUnknownError";
  }
}

/** Server-side adapter for the PIM-owned Agent sandbox. */
export class PimThreadSandbox implements ThreadSandboxPort {
  readonly #agentId: number;
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #password: string;
  readonly #username: string;
  #accessToken: string | null = null;
  #ensurePromise: Promise<void> | null = null;

  constructor(config: {
    agentId: number;
    baseUrl: string;
    username: string;
    password: string;
    fetch?: typeof globalThis.fetch;
  }) {
    if (!Number.isSafeInteger(config.agentId) || config.agentId < 1) {
      throw new Error("pim_sandbox_agent_id_invalid");
    }
    const baseUrl = new URL(config.baseUrl);
    if (
      (baseUrl.protocol !== "https:" &&
        !(baseUrl.protocol === "http:" && isLoopback(baseUrl.hostname))) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("pim_sandbox_base_url_invalid");
    }
    this.#agentId = config.agentId;
    this.#baseUrl = baseUrl;
    this.#username = requiredSecret(
      config.username,
      "pim_sandbox_username_invalid",
    );
    this.#password = requiredSecret(
      config.password,
      "pim_sandbox_password_invalid",
    );
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listDirectory(
    requestedPath = SANDBOX_ROOT,
  ): Promise<SandboxDirectoryView> {
    const sandboxPath = normalizeSandboxPath(requestedPath);
    const script = [
      "import json, os, pathlib, stat",
      `root = pathlib.Path(${JSON.stringify(SANDBOX_ROOT)}).resolve()`,
      `target = pathlib.Path(${JSON.stringify(sandboxPath)}).resolve()`,
      "if target != root and root not in target.parents: raise ValueError('path_outside_workspace')",
      "items = []",
      `for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))[:${MAX_DIRECTORY_ENTRIES + 1}]:`,
      "    info = child.lstat()",
      "    kind = 'symlink' if child.is_symlink() else ('directory' if child.is_dir() else 'file')",
      "    items.append({'kind': kind, 'name': child.name, 'path': str(child), 'size': info.st_size})",
      `print(json.dumps({'path': str(target), 'entries': items[:${MAX_DIRECTORY_ENTRIES}], 'truncated': len(items) > ${MAX_DIRECTORY_ENTRIES}}, separators=(',', ':')))`,
    ].join("\n");
    const result = await this.#execute(script, "python", 15);
    requireSuccessful(result, "pim_sandbox_list_failed");
    const value = parseJsonObject(result.stdout, "pim_sandbox_list_invalid");
    if (!Array.isArray(value.entries) || typeof value.truncated !== "boolean") {
      throw new Error("pim_sandbox_list_invalid");
    }
    return {
      root: SANDBOX_ROOT,
      path: normalizeSandboxPath(value.path),
      entries: value.entries.map(parseDirectoryEntry),
      truncated: value.truncated,
    };
  }

  async readFile(requestedPath: string): Promise<SandboxFileView> {
    const sandboxPath = normalizeSandboxPath(requestedPath);
    if (sandboxPath === SANDBOX_ROOT)
      throw new Error("pim_sandbox_file_path_invalid");
    const script = [
      "import base64, json, pathlib",
      `root = pathlib.Path(${JSON.stringify(SANDBOX_ROOT)}).resolve()`,
      `target = pathlib.Path(${JSON.stringify(sandboxPath)}).resolve()`,
      "if root not in target.parents or not target.is_file(): raise ValueError('file_invalid')",
      "content = target.read_bytes()",
      `shown = content[:${MAX_FILE_BYTES}]`,
      "print(json.dumps({'path': str(target), 'content': base64.b64encode(shown).decode('ascii'), 'byteLength': len(content), 'truncated': len(content) > len(shown)}, separators=(',', ':')))",
    ].join("\n");
    const result = await this.#execute(script, "python", 15);
    requireSuccessful(result, "pim_sandbox_read_failed");
    const value = parseJsonObject(result.stdout, "pim_sandbox_read_invalid");
    if (
      typeof value.content !== "string" ||
      !Number.isSafeInteger(value.byteLength) ||
      Number(value.byteLength) < 0 ||
      typeof value.truncated !== "boolean"
    ) {
      throw new Error("pim_sandbox_read_invalid");
    }
    return {
      path: normalizeSandboxPath(value.path),
      content: Buffer.from(value.content, "base64").toString("utf8"),
      byteLength: Number(value.byteLength),
      truncated: value.truncated,
    };
  }

  async readGitSummary(): Promise<SandboxGitSummaryView> {
    return this.#readGit(false);
  }

  async readDiff(): Promise<SandboxDiffView> {
    return this.#readGit(true);
  }

  async #readGit(includeDiff: false): Promise<SandboxGitSummaryView>;
  async #readGit(includeDiff: true): Promise<SandboxDiffView>;
  async #readGit(
    includeDiff: boolean,
  ): Promise<SandboxGitSummaryView | SandboxDiffView> {
    const script = [
      includeDiff
        ? "import base64, json, os, pathlib, re, subprocess"
        : "import json, os, pathlib, re, subprocess",
      `root = pathlib.Path(${JSON.stringify(SANDBOX_ROOT)}).resolve()`,
      `include_diff = ${includeDiff ? "True" : "False"}`,
      `max_diff = ${MAX_DIFF_BYTES}`,
      `max_path_list = ${MAX_GIT_PATH_LIST_BYTES}`,
      `max_untracked = ${MAX_UNTRACKED_FILES}`,
      "git_env = dict(os.environ)",
      "git_env['LC_ALL'] = 'C'",
      "git_env['LANG'] = 'C'",
      "def run_git(args, limit, accepted=(0,), allow_truncation=False):",
      "    process = subprocess.Popen(['git', *args], cwd=root, env=git_env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)",
      "    if process.stdout is None: raise RuntimeError('git_stdout_missing')",
      "    output = process.stdout.read(limit + 1)",
      "    truncated = len(output) > limit",
      "    if truncated:",
      "        process.kill()",
      "        process.wait()",
      "        if not allow_truncation: raise RuntimeError('git_output_too_large')",
      "        return output[:limit], None, True",
      "    try:",
      "        code = process.wait(timeout=10)",
      "    except subprocess.TimeoutExpired:",
      "        process.kill()",
      "        process.wait()",
      "        raise RuntimeError('git_timeout')",
      "    if code not in accepted: raise RuntimeError('git_failed')",
      "    return output, code, False",
      "def parse_shortstat(payload):",
      "    text = payload.strip().decode('ascii', errors='strict')",
      "    if not text: return 0, 0, 0, True",
      "    values = {'files': 0, 'additions': 0, 'deletions': 0}",
      "    seen = set()",
      "    patterns = [('files', r'([0-9]+) files? changed'), ('additions', r'([0-9]+) insertions?\\(\\+\\)'), ('deletions', r'([0-9]+) deletions?\\(-\\)')]",
      "    for part in text.split(', '):",
      "        matched = False",
      "        for key, pattern in patterns:",
      "            result = re.fullmatch(pattern, part)",
      "            if result is not None and key not in seen:",
      "                values[key] = int(result.group(1))",
      "                seen.add(key)",
      "                matched = True",
      "                break",
      "        if not matched: return 0, 0, 0, False",
      "    if 'files' not in seen: return 0, 0, 0, False",
      "    return values['files'], values['additions'], values['deletions'], True",
      "inside, inside_code, _ = run_git(['rev-parse', '--is-inside-work-tree'], 32, (0, 128))",
      "if inside_code != 0 or inside.strip() != b'true':",
      includeDiff
        ? "    print(json.dumps({'isGitRepository': False, 'branch': None, 'head': None, 'changedFiles': 0, 'additions': 0, 'deletions': 0, 'statsComplete': False, 'diffTruncated': False, 'diffBase64': ''}, separators=(',', ':')))"
        : "    print(json.dumps({'isGitRepository': False, 'branch': None, 'head': None, 'changedFiles': 0, 'additions': 0, 'deletions': 0, 'statsComplete': False}, separators=(',', ':')))",
      "else:",
      "    head_bytes, head_code, _ = run_git(['rev-parse', '--verify', 'HEAD'], 128, (0, 128))",
      "    head = head_bytes.strip().decode('ascii') if head_code == 0 else None",
      "    branch_bytes, branch_code, _ = run_git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 4096, (0, 1, 128))",
      "    branch = branch_bytes.rstrip(b'\\r\\n').decode('utf-8', errors='strict') if branch_code == 0 else None",
      "    diff = bytearray()",
      "    diff_truncated = False",
      "    changed_files = 0",
      "    additions = 0",
      "    deletions = 0",
      "    stats_complete = head is not None",
      "    tracked_args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3']",
      "    if head is not None:",
      "        if include_diff:",
      "            tracked, _, tracked_truncated = run_git([*tracked_args, 'HEAD', '--', '.', ':(exclude).crewon/**'], max_diff, allow_truncation=True)",
      "            diff.extend(tracked)",
      "            diff_truncated = tracked_truncated",
      "        tracked_stats, _, tracked_stats_truncated = run_git(['diff', '--shortstat', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ':(exclude).crewon/**'], 1024, allow_truncation=True)",
      "        tracked_changed, tracked_additions, tracked_deletions, tracked_stats_complete = parse_shortstat(tracked_stats)",
      "        changed_files += tracked_changed",
      "        additions += tracked_additions",
      "        deletions += tracked_deletions",
      "        stats_complete = stats_complete and not tracked_stats_truncated and tracked_stats_complete",
      "    else:",
      "        if include_diff:",
      "            staged, _, staged_truncated = run_git([*tracked_args, '--cached', '--', '.', ':(exclude).crewon/**'], max_diff, allow_truncation=True)",
      "            diff.extend(staged)",
      "            diff_truncated = staged_truncated",
      "            remaining = max_diff - len(diff)",
      "            if remaining > 0:",
      "                unstaged, _, unstaged_truncated = run_git([*tracked_args, '--', '.', ':(exclude).crewon/**'], remaining, allow_truncation=True)",
      "                diff.extend(unstaged)",
      "                diff_truncated = diff_truncated or unstaged_truncated",
      "    paths_raw, _, paths_truncated = run_git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).crewon/**'], max_path_list, allow_truncation=True)",
      "    paths = paths_raw.split(b'\\0')",
      "    if paths_raw and not paths_raw.endswith(b'\\0'): paths = paths[:-1]",
      "    all_untracked = [item for item in paths if item]",
      "    if paths_truncated or len(all_untracked) > max_untracked:",
      "        stats_complete = False",
      "        diff_truncated = include_diff",
      "    for relative_path in all_untracked[:max_untracked]:",
      "        if relative_path.startswith(b'/') or b'..' in relative_path.split(b'/'): raise RuntimeError('git_path_invalid')",
      "        changed_files += 1",
      "        untracked_stats, _, untracked_stats_truncated = run_git(['diff', '--shortstat', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-index', '--', b'/dev/null', relative_path], 1024, (0, 1), True)",
      "        if untracked_stats:",
      "            file_changed, file_additions, file_deletions, file_stats_complete = parse_shortstat(untracked_stats)",
      "            additions += file_additions",
      "            deletions += file_deletions",
      "            stats_complete = stats_complete and not untracked_stats_truncated and file_stats_complete and file_changed == 1",
      "        else:",
      "            empty_path = os.path.join(os.fsencode(root), relative_path)",
      "            stats_complete = stats_complete and os.path.lexists(empty_path) and os.lstat(empty_path).st_size == 0",
      "        if include_diff:",
      "            remaining = max_diff - len(diff)",
      "            if remaining <= 0:",
      "                diff_truncated = True",
      "                continue",
      "            patch, _, patch_truncated = run_git([*tracked_args, '--no-index', '--', b'/dev/null', relative_path], remaining, (0, 1), True)",
      "            diff_truncated = diff_truncated or patch_truncated",
      "            if diff and patch and not diff.endswith(b'\\n') and len(diff) < max_diff: diff.extend(b'\\n')",
      "            diff.extend(patch[:max_diff - len(diff)])",
      includeDiff
        ? "    print(json.dumps({'isGitRepository': True, 'branch': branch, 'head': head, 'changedFiles': changed_files, 'additions': additions, 'deletions': deletions, 'statsComplete': stats_complete, 'diffTruncated': diff_truncated, 'diffBase64': base64.b64encode(bytes(diff)).decode('ascii')}, separators=(',', ':')))"
        : "    print(json.dumps({'isGitRepository': True, 'branch': branch, 'head': head, 'changedFiles': changed_files, 'additions': additions, 'deletions': deletions, 'statsComplete': stats_complete}, separators=(',', ':')))",
    ].join("\n");
    const result = await this.#execute(script, "python", 30);
    const failedCode = includeDiff
      ? "pim_sandbox_diff_failed"
      : "pim_sandbox_git_summary_failed";
    const invalidCode = includeDiff
      ? "pim_sandbox_diff_invalid"
      : "pim_sandbox_git_summary_invalid";
    requireSuccessful(result, failedCode);
    const value = parseJsonObject(result.stdout, invalidCode);
    if (
      !hasExactKeys(
        value,
        includeDiff
          ? [
              "additions",
              "branch",
              "changedFiles",
              "deletions",
              "diffBase64",
              "diffTruncated",
              "head",
              "isGitRepository",
              "statsComplete",
            ]
          : [
              "additions",
              "branch",
              "changedFiles",
              "deletions",
              "head",
              "isGitRepository",
              "statsComplete",
            ],
      ) ||
      typeof value.isGitRepository !== "boolean" ||
      (value.branch !== null && typeof value.branch !== "string") ||
      (value.head !== null && typeof value.head !== "string") ||
      !isNonNegativeSafeInteger(value.changedFiles) ||
      !isNonNegativeSafeInteger(value.additions) ||
      !isNonNegativeSafeInteger(value.deletions) ||
      typeof value.statsComplete !== "boolean"
    ) {
      throw new Error(invalidCode);
    }
    const branch = parseGitBranch(value.branch, invalidCode);
    const head = parseGitHead(value.head, invalidCode);
    if (
      !value.isGitRepository &&
      (branch !== null ||
        head !== null ||
        value.changedFiles !== 0 ||
        value.additions !== 0 ||
        value.deletions !== 0 ||
        value.statsComplete)
    ) {
      throw new Error(invalidCode);
    }
    const summary: SandboxGitSummaryView = {
      cwd: SANDBOX_ROOT,
      isGitRepository: value.isGitRepository,
      branch,
      head,
      changedFiles: Number(value.changedFiles),
      additions: Number(value.additions),
      deletions: Number(value.deletions),
      statsComplete: value.statsComplete,
    };
    if (!includeDiff) return summary;
    if (
      typeof value.diffBase64 !== "string" ||
      typeof value.diffTruncated !== "boolean"
    ) {
      throw new Error(invalidCode);
    }
    const decodedDiff = decodeBoundedBase64(
      value.diffBase64,
      MAX_DIFF_BYTES,
      invalidCode,
    ).toString("utf8");
    const diff = truncateUtf8(decodedDiff, MAX_DIFF_BYTES);
    if (!value.isGitRepository && (diff || value.diffTruncated)) {
      throw new Error(invalidCode);
    }
    return {
      ...summary,
      diff,
      diffTruncated: value.diffTruncated || diff !== decodedDiff,
    };
  }

  async runCommand(
    input: {
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<SandboxCommandView> {
    const command = input.command.trim();
    if (!command || Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
      throw new Error("pim_sandbox_command_invalid");
    }
    const cwd = normalizeSandboxPath(input.cwd ?? SANDBOX_ROOT);
    const timeoutSeconds = input.timeoutSeconds ?? 60;
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 120
    ) {
      throw new Error("pim_sandbox_timeout_invalid");
    }
    const marker = `__CREWON_CWD_${randomUUID().replaceAll("-", "")}__`;
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const script = [
      `cd ${shellQuote(cwd)} || exit 1`,
      `eval "$(printf %s ${shellQuote(encoded)} | base64 -d)"`,
      "status=$?",
      `printf '\n${marker}%s\n' "$PWD"`,
      "exit $status",
    ].join("\n");
    const result = await this.#execute(script, "shell", timeoutSeconds, signal);
    const stdout = result.stdout ?? "";
    const markerIndex = stdout.lastIndexOf(marker);
    const nextCwd =
      markerIndex < 0
        ? cwd
        : normalizeSandboxPath(
            stdout.slice(markerIndex + marker.length).trim(),
          );
    return {
      cwd: nextCwd,
      exitCode: result.exit_code,
      stderr: result.stderr ?? "",
      stdout:
        markerIndex < 0
          ? stdout
          : stdout.slice(0, markerIndex).replace(/\n$/u, ""),
    };
  }

  async runTrackedCommand(
    input: {
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<SandboxTrackedCommandView> {
    const command = input.command.trim();
    if (!command || Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
      throw new Error("pim_sandbox_command_invalid");
    }
    const cwd = normalizeSandboxPath(input.cwd ?? SANDBOX_ROOT);
    const timeoutSeconds = input.timeoutSeconds ?? 60;
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 120
    ) {
      throw new Error("pim_sandbox_timeout_invalid");
    }
    const marker = `__CREWON_CWD_${randomUUID().replaceAll("-", "")}__`;
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const script = [
      "import base64, ctypes, fcntl, json, os, pathlib, selectors, signal, subprocess, sys, tempfile, time",
      `root = pathlib.Path(${JSON.stringify(SANDBOX_ROOT)}).resolve()`,
      `cwd = pathlib.Path(${JSON.stringify(cwd)}).resolve()`,
      `encoded_command = ${JSON.stringify(encoded)}`,
      `cwd_marker = ${JSON.stringify(marker)}`,
      `max_numstat = ${MAX_TASK_CHANGE_NUMSTAT_BYTES}`,
      `max_command_stream = ${MAX_TRACKED_COMMAND_STREAM_BYTES}`,
      `max_summary = ${MAX_WORKSPACE_CHANGE_SUMMARY_BYTES}`,
      `command_timeout = ${timeoutSeconds}`,
      "def incomplete():",
      "    return {'schemaVersion': 'crewon.workspace-change-summary.v0', 'paths': [], 'additions': 0, 'deletions': 0, 'statsComplete': False}",
      "def run_git(args, env=None, limit=8192):",
      "    process = subprocess.Popen(['git', *args], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)",
      "    if process.stdout is None: raise RuntimeError('git_stdout_missing')",
      "    output = process.stdout.read(limit + 1)",
      "    if len(output) > limit:",
      "        process.kill()",
      "        process.wait()",
      "        raise RuntimeError('git_output_too_large')",
      "    if process.wait() != 0: raise RuntimeError('git_failed')",
      "    return output",
      "def snapshot(temp_root, name, object_dir, alternate_objects):",
      "    env = dict(os.environ)",
      "    env['LC_ALL'] = 'C'",
      "    env['LANG'] = 'C'",
      "    env['GIT_INDEX_FILE'] = str(temp_root / (name + '.index'))",
      "    env['GIT_OBJECT_DIRECTORY'] = str(object_dir)",
      "    env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = str(alternate_objects)",
      "    run_git(['read-tree', '--empty'], env)",
      "    run_git(['add', '-A', '--', '.', ':(exclude).crewon/**'], env)",
      "    return run_git(['write-tree'], env).strip().decode('ascii'), env",
      "def summarize(before, after, env):",
      "    raw = run_git(['diff', '--numstat', '-z', '--no-renames', before, after, '--', '.', ':(exclude).crewon/**'], env, max_numstat)",
      "    paths = []",
      "    additions = 0",
      "    deletions = 0",
      "    for record in raw.split(b'\\0'):",
      "        if not record: continue",
      "        parts = record.split(b'\\t', 2)",
      "        if len(parts) != 3: raise RuntimeError('git_numstat_invalid')",
      "        if parts[0] == b'-' and parts[1] == b'-':",
      "            file_additions = 0",
      "            file_deletions = 0",
      "        elif parts[0] == b'-' or parts[1] == b'-':",
      "            raise RuntimeError('git_numstat_invalid')",
      "        else:",
      "            file_additions = int(parts[0])",
      "            file_deletions = int(parts[1])",
      "        additions += file_additions",
      "        deletions += file_deletions",
      "        relative_path = parts[2].decode('utf-8', errors='strict')",
      "        if not relative_path or relative_path.startswith('/') or any(ord(character) < 32 or ord(character) == 127 for character in relative_path) or any(part in ('', '.', '..') for part in relative_path.split('/')): raise RuntimeError('git_path_invalid')",
      "        paths.append(relative_path)",
      "    paths.sort(key=lambda value: value.encode('utf-16-be', errors='surrogatepass'))",
      "    if len(paths) > 256 or len(set(paths)) != len(paths) or sum(len(path.encode('utf-8')) for path in paths) > 65536 or any(len(path.encode('utf-8')) > 4096 for path in paths): raise RuntimeError('git_paths_too_large')",
      "    if additions > 9007199254740991 or deletions > 9007199254740991: raise RuntimeError('git_stats_too_large')",
      "    summary = {'schemaVersion': 'crewon.workspace-change-summary.v0', 'paths': paths, 'additions': additions, 'deletions': deletions, 'statsComplete': True}",
      "    if len(json.dumps(summary, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > max_summary: return incomplete()",
      "    return summary",
      "def retain_prefix(buffer, chunk, limit):",
      "    if len(buffer) < limit: buffer.extend(chunk[:limit - len(buffer)])",
      "def retain_tail(buffer, chunk, limit):",
      "    buffer.extend(chunk)",
      "    if len(buffer) > limit: del buffer[:-limit]",
      "def enable_subreaper():",
      "    if not sys.platform.startswith('linux'): return False",
      "    try:",
      "        libc = ctypes.CDLL(None, use_errno=True)",
      "        return libc.prctl(36, 1, 0, 0, 0) == 0",
      "    except Exception:",
      "        return False",
      "def descendants():",
      "    parent_by_pid = {}",
      "    for entry in pathlib.Path('/proc').iterdir():",
      "        if not entry.name.isdigit(): continue",
      "        try:",
      "            raw = (entry / 'stat').read_text()",
      "            fields = raw[raw.rfind(')') + 2:].split()",
      "            parent_by_pid[int(entry.name)] = int(fields[1])",
      "        except (FileNotFoundError, IndexError, PermissionError, ValueError):",
      "            continue",
      "    found = set()",
      "    frontier = {os.getpid()}",
      "    while frontier:",
      "        next_frontier = {pid for pid, parent in parent_by_pid.items() if parent in frontier and pid not in found}",
      "        found.update(next_frontier)",
      "        frontier = next_frontier",
      "    return found",
      "def terminate_descendants():",
      "    if not process_isolation_supported: return False",
      "    cleanup_deadline = time.monotonic() + 1.0",
      "    empty_passes = 0",
      "    while time.monotonic() < cleanup_deadline:",
      "        active = descendants()",
      "        if active:",
      "            empty_passes = 0",
      "            for pid in active:",
      "                try: os.kill(pid, signal.SIGKILL)",
      "                except ProcessLookupError: pass",
      "        else:",
      "            empty_passes += 1",
      "            if empty_passes >= 2: return True",
      "        while True:",
      "            try:",
      "                waited, _ = os.waitpid(-1, os.WNOHANG)",
      "                if waited == 0: break",
      "            except ChildProcessError:",
      "                break",
      "        time.sleep(0.02)",
      "    return False",
      "def drain_command(shell_script):",
      "    process = subprocess.Popen(['/bin/sh', '-c', shell_script], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)",
      "    if process.stdout is None or process.stderr is None: raise RuntimeError('command_stream_missing')",
      "    stream_selector = selectors.DefaultSelector()",
      "    streams = ((process.stdout, 'stdout'), (process.stderr, 'stderr'))",
      "    for stream, name in streams:",
      "        os.set_blocking(stream.fileno(), False)",
      "        stream_selector.register(stream, selectors.EVENT_READ, name)",
      "    stdout = bytearray()",
      "    stderr = bytearray()",
      "    stdout_tail = bytearray()",
      "    stdout_size = 0",
      "    stderr_size = 0",
      "    deadline = time.monotonic() + command_timeout",
      "    return_code = None",
      "    killed = False",
      "    stream_cleanup_incomplete = False",
      "    drain_deadline = None",
      "    while stream_selector.get_map():",
      "        if drain_deadline is not None and time.monotonic() >= drain_deadline:",
      "            stream_cleanup_incomplete = True",
      "            for key in list(stream_selector.get_map().values()):",
      "                stream_selector.unregister(key.fileobj)",
      "                key.fileobj.close()",
      "            break",
      "        remaining = deadline - time.monotonic()",
      "        if return_code is None and remaining <= 0:",
      "            try: os.killpg(process.pid, signal.SIGKILL)",
      "            except ProcessLookupError: pass",
      "            return_code = 124",
      "            killed = True",
      "            drain_deadline = time.monotonic() + 1.0",
      "        if return_code is None:",
      "            polled = process.poll()",
      "            if polled is not None:",
      "                return_code = polled",
      "                try: os.killpg(process.pid, signal.SIGKILL)",
      "                except ProcessLookupError: pass",
      "                killed = True",
      "                drain_deadline = time.monotonic() + 1.0",
      "        wait_for = min(0.05, max(0.0, drain_deadline - time.monotonic())) if drain_deadline is not None else min(0.1, max(0.0, remaining))",
      "        events = stream_selector.select(wait_for)",
      "        if not events and return_code is not None:",
      "            for key in list(stream_selector.get_map().values()):",
      "                try: chunk = os.read(key.fd, 65536)",
      "                except BlockingIOError: continue",
      "                if not chunk:",
      "                    stream_selector.unregister(key.fileobj)",
      "                    key.fileobj.close()",
      "                    continue",
      "                if key.data == 'stdout':",
      "                    stdout_size += len(chunk)",
      "                    retain_prefix(stdout, chunk, max_command_stream)",
      "                    retain_tail(stdout_tail, chunk, 8192)",
      "                else:",
      "                    stderr_size += len(chunk)",
      "                    retain_prefix(stderr, chunk, max_command_stream)",
      "            if not events: continue",
      "        for key, _ in events:",
      "            try: chunk = os.read(key.fd, 65536)",
      "            except BlockingIOError: continue",
      "            if not chunk:",
      "                stream_selector.unregister(key.fileobj)",
      "                key.fileobj.close()",
      "                continue",
      "            if key.data == 'stdout':",
      "                stdout_size += len(chunk)",
      "                retain_prefix(stdout, chunk, max_command_stream)",
      "                retain_tail(stdout_tail, chunk, 8192)",
      "            else:",
      "                stderr_size += len(chunk)",
      "                retain_prefix(stderr, chunk, max_command_stream)",
      "    if return_code is None: return_code = process.wait()",
      "    elif killed: process.wait()",
      "    isolation_complete = terminate_descendants() if not stream_cleanup_incomplete else False",
      "    return return_code, stdout, stderr, stdout_tail, stdout_size, stderr_size, isolation_complete",
      "summary = incomplete()",
      "process_isolation_supported = enable_subreaper()",
      "lock_fd = os.open(root, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))",
      "fcntl.flock(lock_fd, fcntl.LOCK_EX)",
      "with tempfile.TemporaryDirectory(prefix='crewon-task-changes-') as temp_name:",
      "    temp_root = pathlib.Path(temp_name)",
      "    object_dir = temp_root / 'objects'",
      "    object_dir.mkdir()",
      "    before = None",
      "    before_env = None",
      "    try:",
      "        inside = run_git(['rev-parse', '--is-inside-work-tree'], limit=32).strip()",
      "        if inside != b'true': raise RuntimeError('not_git')",
      "        git_objects = run_git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], limit=8192).strip().decode('utf-8', errors='strict')",
      "        before, before_env = snapshot(temp_root, 'before', object_dir, pathlib.Path(git_objects))",
      "    except Exception:",
      "        before = None",
      "        before_env = None",
      `    shell_script = base64.b64decode(encoded_command).decode('utf-8') + r'''
status=$?
printf '\\n${marker}%s\\n' "$PWD"
exit $status'''`,
      "    return_code, stdout, stderr, stdout_tail, stdout_size, stderr_size, process_isolation_complete = drain_command(shell_script)",
      "    marker_bytes = cwd_marker.encode('ascii')",
      "    marker_index = stdout_tail.rfind(marker_bytes)",
      "    next_cwd = str(cwd)",
      "    content_size = stdout_size",
      "    if marker_index >= 0:",
      "        next_cwd = stdout_tail[marker_index + len(marker_bytes):].strip().decode('utf-8', errors='strict')",
      "        absolute_marker = stdout_size - len(stdout_tail) + marker_index",
      "        content_size = absolute_marker",
      "        if content_size > 0 and absolute_marker > 0 and stdout_tail[marker_index - 1:marker_index] == b'\\n': content_size -= 1",
      "        if absolute_marker < len(stdout): stdout = stdout[:absolute_marker]",
      "        if stdout.endswith(b'\\n'): stdout = stdout[:-1]",
      "    if before is not None and before_env is not None:",
      "        try:",
      "            after, after_env = snapshot(temp_root, 'after', object_dir, pathlib.Path(before_env['GIT_ALTERNATE_OBJECT_DIRECTORIES']))",
      "            summary = summarize(before, after, after_env)",
      "        except Exception:",
      "            summary = incomplete()",
      "    if not process_isolation_complete: summary = incomplete()",
      "    print(json.dumps({'cwd': next_cwd, 'exitCode': return_code, 'stdoutBase64': base64.b64encode(stdout).decode('ascii'), 'stdoutTruncated': content_size > len(stdout), 'stderrBase64': base64.b64encode(stderr).decode('ascii'), 'stderrTruncated': stderr_size > len(stderr), 'workspaceChanges': summary}, separators=(',', ':')))",
    ].join("\n");
    try {
      const result = await this.#execute(
        script,
        "python",
        timeoutSeconds + TRACKED_COMMAND_GRACE_SECONDS,
        signal,
        true,
      );
      requireSuccessful(result, "pim_sandbox_command_failed");
      const value = parseJsonObject(
        result.stdout,
        "pim_sandbox_tracked_command_invalid",
      );
      if (
        !hasExactKeys(value, [
          "cwd",
          "exitCode",
          "stderrBase64",
          "stderrTruncated",
          "stdoutBase64",
          "stdoutTruncated",
          "workspaceChanges",
        ]) ||
        !Number.isSafeInteger(value.exitCode) ||
        typeof value.stdoutBase64 !== "string" ||
        typeof value.stderrBase64 !== "string" ||
        typeof value.stdoutTruncated !== "boolean" ||
        typeof value.stderrTruncated !== "boolean"
      ) {
        throw new Error("pim_sandbox_tracked_command_invalid");
      }
      return {
        command: {
          cwd: normalizeSandboxPath(value.cwd),
          exitCode: Number(value.exitCode),
          stdout: commandStreamText(
            value.stdoutBase64,
            value.stdoutTruncated,
            "stdout",
          ),
          stderr: commandStreamText(
            value.stderrBase64,
            value.stderrTruncated,
            "stderr",
          ),
        },
        workspaceChanges: parseWorkspaceChangeSummary(value.workspaceChanges),
      };
    } catch (cause) {
      if (
        signal?.aborted ||
        cause instanceof PimSandboxMutationOutcomeUnknownError
      ) {
        throw cause;
      }
      throw new PimSandboxMutationOutcomeUnknownError({ cause });
    }
  }

  async #execute(
    scriptContent: string,
    language: "python" | "shell",
    timeout: number,
    signal?: AbortSignal,
    mutationOutcomeRisk = false,
  ): Promise<PimExecution> {
    await this.#ensureSandbox(signal);
    const value = await this.#request(
      `/api/v1/containers/agents/${this.#agentId}/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          script_content: scriptContent,
          language,
          timeout,
          args: [],
        }),
      },
      true,
      signal,
      mutationOutcomeRisk,
    );
    if (
      typeof value.exit_code !== "number" ||
      (value.stdout !== undefined && typeof value.stdout !== "string") ||
      (value.stderr !== undefined && typeof value.stderr !== "string")
    ) {
      const cause = new Error("pim_sandbox_execution_invalid");
      if (mutationOutcomeRisk) {
        throw new PimSandboxMutationOutcomeUnknownError({ cause });
      }
      throw cause;
    }
    return value as PimExecution;
  }

  async #ensureSandbox(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    let shared = this.#ensurePromise;
    if (shared === null) {
      shared = this.#request(
        `/api/v1/containers/agents/${this.#agentId}/sandbox`,
        { method: "POST", body: "{}" },
        true,
      ).then(() => undefined);
      this.#ensurePromise = shared;
      void shared.catch(() => {
        if (this.#ensurePromise === shared) {
          this.#ensurePromise = null;
        }
      });
    }
    await (signal === undefined ? shared : awaitWithAbort(shared, signal));
  }

  async #request(
    pathname: string,
    init: RequestInit,
    retry = true,
    signal?: AbortSignal,
    mutationOutcomeRisk = false,
  ): Promise<Record<string, unknown>> {
    const token = await this.#token(signal);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.#fetch(new URL(pathname, this.#baseUrl), {
        ...init,
        headers,
        signal,
      });
    } catch (cause) {
      if (signal?.aborted || !mutationOutcomeRisk) throw cause;
      throw new PimSandboxMutationOutcomeUnknownError({ cause });
    }
    if (response.status === 401 && retry) {
      if (mutationOutcomeRisk) {
        throw new PimSandboxMutationOutcomeUnknownError({
          cause: new Error("pim_sandbox_http_401"),
        });
      }
      await response.body?.cancel().catch(() => undefined);
      this.#accessToken = null;
      return this.#request(pathname, init, false, signal, mutationOutcomeRisk);
    }
    if (!response.ok) {
      const cause = new Error(`pim_sandbox_http_${response.status}`);
      if (mutationOutcomeRisk) {
        throw new PimSandboxMutationOutcomeUnknownError({ cause });
      }
      throw cause;
    }
    try {
      return parseJsonObject(
        await readResponseTextBounded(
          response,
          MAX_PIM_RESPONSE_BYTES,
          "pim_sandbox_response_too_large",
        ),
        "pim_sandbox_response_invalid",
      );
    } catch (cause) {
      if (!mutationOutcomeRisk) throw cause;
      throw new PimSandboxMutationOutcomeUnknownError({ cause });
    }
  }

  async #token(signal?: AbortSignal): Promise<string> {
    if (this.#accessToken !== null) return this.#accessToken;
    const body = new URLSearchParams({
      username: this.#username,
      password: this.#password,
    });
    const response = await this.#fetch(
      new URL("/api/v1/auth/login", this.#baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal,
      },
    );
    if (!response.ok) throw new Error(`pim_sandbox_login_${response.status}`);
    const value = parseJsonObject(
      await readResponseTextBounded(
        response,
        MAX_PIM_LOGIN_RESPONSE_BYTES,
        "pim_sandbox_login_response_too_large",
      ),
      "pim_sandbox_login_invalid",
    );
    this.#accessToken = requiredSecret(
      value.access_token,
      "pim_sandbox_login_invalid",
    );
    return this.#accessToken;
  }
}

function normalizeSandboxPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > 4_096
  ) {
    throw new Error("pim_sandbox_path_invalid");
  }
  const normalized = path.posix.normalize(value.trim() || SANDBOX_ROOT);
  if (
    normalized !== SANDBOX_ROOT &&
    !normalized.startsWith(`${SANDBOX_ROOT}/`)
  ) {
    throw new Error("pim_sandbox_path_invalid");
  }
  return normalized;
}

function parseDirectoryEntry(input: unknown): SandboxDirectoryEntry {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("pim_sandbox_list_invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    (value.kind !== "directory" &&
      value.kind !== "file" &&
      value.kind !== "symlink") ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0
  ) {
    throw new Error("pim_sandbox_list_invalid");
  }
  return {
    kind: value.kind,
    name: value.name,
    path: normalizeSandboxPath(value.path),
    size: Number(value.size),
  };
}

function parseJsonObject(
  input: unknown,
  code: string,
): Record<string, unknown> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new Error(code, { cause });
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function decodeBoundedBase64(
  value: string,
  maximumBytes: number,
  code: string,
): Buffer {
  if (
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error(code);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength > maximumBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(code);
  }
  return decoded;
}

function commandStreamText(
  encoded: string,
  truncated: boolean,
  stream: "stderr" | "stdout",
): string {
  const content = decodeBoundedBase64(
    encoded,
    MAX_TRACKED_COMMAND_STREAM_BYTES,
    "pim_sandbox_tracked_command_invalid",
  ).toString("utf8");
  if (!truncated) return content;
  return `${content}${content.endsWith("\n") || content.length === 0 ? "" : "\n"}[${stream} ${TRACKED_COMMAND_TRUNCATION_MARKER}]`;
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("pim_sandbox_request_aborted");
}

async function readResponseTextBounded(
  response: Response,
  maximumBytes: number,
  code: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maximumBytes
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(code);
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel(code).catch(() => undefined);
        throw new Error(code);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total,
      ),
    );
  } catch (cause) {
    throw new Error(code, { cause });
  }
}

function parseGitBranch(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value) > MAX_GIT_BRANCH_BYTES ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function parseGitHead(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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

function requireSuccessful(result: PimExecution, code: string): void {
  if (result.exit_code !== 0) throw new Error(code);
}

function requiredSecret(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.includes("\0")
  ) {
    throw new Error(code);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}
