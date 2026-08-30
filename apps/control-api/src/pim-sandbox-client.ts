import { randomUUID } from "node:crypto";
import path from "node:path";

const SANDBOX_ROOT = "/workspace";
const MAX_DIRECTORY_ENTRIES = 120;
const MAX_FILE_BYTES = 3_000;
const MAX_COMMAND_BYTES = 16 * 1024;

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

export type SandboxDiffView = Readonly<{
  cwd: typeof SANDBOX_ROOT;
  diff: string;
}>;

export type SandboxCommandView = Readonly<{
  cwd: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export interface ThreadSandboxPort {
  listDirectory(requestedPath?: string): Promise<SandboxDirectoryView>;
  readFile(requestedPath: string): Promise<SandboxFileView>;
  readDiff(): Promise<SandboxDiffView>;
  runCommand(input: {
    command: string;
    cwd?: string;
    timeoutSeconds?: number;
  }): Promise<SandboxCommandView>;
}

type PimExecution = Readonly<{
  exit_code: number;
  stderr?: string;
  stdout?: string;
}>;

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

  async readDiff(): Promise<SandboxDiffView> {
    const script = [
      `cd ${shellQuote(SANDBOX_ROOT)} || exit 1`,
      "if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi",
      "git diff --no-ext-diff --no-color --unified=3 HEAD -- .",
      'git ls-files --others --exclude-standard -- . | while IFS= read -r file; do git diff --no-ext-diff --no-color --no-index --unified=3 /dev/null "$file" || test $? -eq 1; done',
    ].join("\n");
    const result = await this.#execute(script, "shell", 30);
    requireSuccessful(result, "pim_sandbox_diff_failed");
    return { cwd: SANDBOX_ROOT, diff: result.stdout ?? "" };
  }

  async runCommand(input: {
    command: string;
    cwd?: string;
    timeoutSeconds?: number;
  }): Promise<SandboxCommandView> {
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
    const result = await this.#execute(script, "shell", timeoutSeconds);
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

  async #execute(
    scriptContent: string,
    language: "python" | "shell",
    timeout: number,
  ): Promise<PimExecution> {
    await this.#ensureSandbox();
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
    );
    if (
      typeof value.exit_code !== "number" ||
      (value.stdout !== undefined && typeof value.stdout !== "string") ||
      (value.stderr !== undefined && typeof value.stderr !== "string")
    ) {
      throw new Error("pim_sandbox_execution_invalid");
    }
    return value as PimExecution;
  }

  async #ensureSandbox(): Promise<void> {
    this.#ensurePromise ??= this.#request(
      `/api/v1/containers/agents/${this.#agentId}/sandbox`,
      { method: "POST", body: "{}" },
    ).then(() => undefined);
    try {
      await this.#ensurePromise;
    } catch (error) {
      this.#ensurePromise = null;
      throw error;
    }
  }

  async #request(
    pathname: string,
    init: RequestInit,
    retry = true,
  ): Promise<Record<string, unknown>> {
    const token = await this.#token();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/json");
    const response = await this.#fetch(new URL(pathname, this.#baseUrl), {
      ...init,
      headers,
    });
    if (response.status === 401 && retry) {
      this.#accessToken = null;
      return this.#request(pathname, init, false);
    }
    if (!response.ok) throw new Error(`pim_sandbox_http_${response.status}`);
    return parseJsonObject(
      await response.text(),
      "pim_sandbox_response_invalid",
    );
  }

  async #token(): Promise<string> {
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
      },
    );
    if (!response.ok) throw new Error(`pim_sandbox_login_${response.status}`);
    const value = parseJsonObject(
      await response.text(),
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
