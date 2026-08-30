import { spawn } from "node:child_process";
import {
  chmod,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MAX_OUTPUT_BYTES = 60 * 1024;
const MAX_FILE_BYTES = 24 * 1024;
const MAX_DIRECTORY_ENTRIES = 200;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;

if (process.argv[2] === "--write-config") {
  await writeConfig({
    outputPath: process.argv[3],
    repoRoot: process.argv[4],
    nodePath: process.argv[5],
    pnpmPath: process.argv[6],
    gitPath: process.argv[7],
  });
  process.exit(0);
}

const repoRoot = await requireDirectory(
  process.env.CREWON_LOCAL_WORKSPACE_ROOT,
  "local_workspace_root_invalid",
);
const pnpmPath = requireExecutablePath(
  process.env.CREWON_LOCAL_PNPM_PATH,
  "local_pnpm_path_invalid",
);
const gitPath = requireExecutablePath(
  process.env.CREWON_LOCAL_GIT_PATH,
  "local_git_path_invalid",
);

const server = new Server(
  { name: "crewon-local-workspace-checks", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_files",
      description:
        "List a bounded directory inside the current local workspace. Use a relative path such as . or apps/crewon-ui.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative directory path.",
          },
        },
      },
    },
    {
      name: "read_file",
      description:
        "Read a bounded UTF-8 text file inside the current local workspace using a relative path.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
        },
      },
    },
    {
      name: "git_status",
      description:
        "Run git status --short in the current local workspace and return the real exit code and bounded output.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "run_ui_test",
      description:
        "Run one existing CrewON UI Vitest file in the current local workspace and return the real exit code and bounded output.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["testFile"],
        properties: {
          testFile: {
            type: "string",
            description:
              "A path below apps/crewon-ui/src ending in .test.ts or .test.tsx; apps/crewon-ui/ may be omitted.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "list_files") {
    const input = request.params.arguments ?? {};
    if (!hasExactKeys(input, ["path"]) || typeof input.path !== "string") {
      return toolError("list_files_input_invalid");
    }
    try {
      const directory = await resolveWorkspacePath(
        repoRoot,
        input.path,
        "directory",
      );
      const entries = await readdir(directory, { withFileTypes: true });
      const visible = entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : "file",
        }))
        .sort((left, right) =>
          left.kind === right.kind
            ? left.name.localeCompare(right.name)
            : left.kind === "directory"
              ? -1
              : 1,
        );
      return toolValue({
        path: input.path,
        entries: visible.slice(0, MAX_DIRECTORY_ENTRIES),
        truncated: visible.length > MAX_DIRECTORY_ENTRIES,
      });
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : "workspace_path_invalid",
      );
    }
  }
  if (request.params.name === "read_file") {
    const input = request.params.arguments ?? {};
    if (!hasExactKeys(input, ["path"]) || typeof input.path !== "string") {
      return toolError("read_file_input_invalid");
    }
    try {
      const file = await resolveWorkspacePath(repoRoot, input.path, "file");
      const bytes = await readFile(file);
      return toolValue({
        path: input.path,
        content: bytes.subarray(0, MAX_FILE_BYTES).toString("utf8"),
        byteLength: bytes.byteLength,
        truncated: bytes.byteLength > MAX_FILE_BYTES,
      });
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : "workspace_path_invalid",
      );
    }
  }
  if (request.params.name === "git_status") {
    if (!hasExactKeys(request.params.arguments ?? {}, [])) {
      return toolError("git_status_input_invalid");
    }
    return toolResult(
      await runCommand(gitPath, ["status", "--short"], repoRoot),
    );
  }
  if (request.params.name === "run_ui_test") {
    const input = request.params.arguments ?? {};
    if (
      !hasExactKeys(input, ["testFile"]) ||
      typeof input.testFile !== "string"
    ) {
      return toolError("ui_test_input_invalid");
    }
    let testFile;
    try {
      testFile = await resolveUiTestFile(repoRoot, input.testFile);
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : "ui_test_path_invalid",
      );
    }
    return toolResult(
      await runCommand(
        pnpmPath,
        ["--filter", "@crewon/ui", "exec", "vitest", "run", testFile],
        repoRoot,
      ),
    );
  }
  return toolError("local_workspace_tool_not_found");
});

await server.connect(new StdioServerTransport());

async function writeConfig({
  outputPath,
  repoRoot,
  nodePath,
  pnpmPath,
  gitPath,
}) {
  for (const [name, value] of Object.entries({
    outputPath,
    repoRoot,
    nodePath,
    pnpmPath,
    gitPath,
  })) {
    if (
      typeof value !== "string" ||
      !isAbsolute(value) ||
      value.includes("\0")
    ) {
      throw new Error(`${name}_invalid`);
    }
  }
  const serverPath = resolve(
    repoRoot,
    "scripts/local-workspace-checks-mcp.mjs",
  );
  const policy = {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "local-workspace",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "local-workspace" },
    capability: "workspace.read_only_command.v0",
    approvalRequirement: "none",
    limits: {
      timeoutMs: COMMAND_TIMEOUT_MS + 5_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 1,
    },
  };
  const config = {
    schemaVersion: "crewon.mcp-stdio-config.v0",
    servers: [
      {
        serverId: "workspace_checks",
        command: nodePath,
        args: [serverPath],
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "",
          CREWON_LOCAL_WORKSPACE_ROOT: repoRoot,
          CREWON_LOCAL_PNPM_PATH: pnpmPath,
          CREWON_LOCAL_GIT_PATH: gitPath,
        },
        tools: {
          list_files: policy,
          read_file: policy,
          git_status: policy,
          run_ui_test: policy,
        },
      },
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
}

async function requireDirectory(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(code);
  }
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw new Error(code);
  return canonical;
}

function requireExecutablePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(code);
  }
  return value;
}

async function resolveUiTestFile(root, input) {
  const normalized = input
    .replaceAll("\\", "/")
    .replace(/^apps\/crewon-ui\//u, "");
  if (
    !/^src\/[A-Za-z0-9_./-]+\.test\.tsx?$/u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("ui_test_path_invalid");
  }
  const uiRoot = await realpath(resolve(root, "apps/crewon-ui"));
  const candidate = await realpath(resolve(uiRoot, normalized));
  const fromUiRoot = relative(uiRoot, candidate);
  if (
    fromUiRoot.startsWith("..") ||
    isAbsolute(fromUiRoot) ||
    !(await stat(candidate)).isFile()
  ) {
    throw new Error("ui_test_path_invalid");
  }
  return normalized;
}

async function resolveWorkspacePath(root, input, expectedKind) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 4_096 ||
    isAbsolute(input) ||
    input.includes("\0") ||
    input.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new Error("workspace_path_invalid");
  }
  const candidate = await realpath(resolve(root, input));
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("workspace_path_invalid");
  }
  const metadata = await stat(candidate);
  if (
    (expectedKind === "file" && !metadata.isFile()) ||
    (expectedKind === "directory" && !metadata.isDirectory())
  ) {
    throw new Error("workspace_path_invalid");
  }
  return candidate;
}

function runCommand(command, args, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const collect = (chunks, chunk, currentBytes) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return currentBytes + chunk.byteLength;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolveRun({
        command: [command, ...args],
        exitCode: null,
        signal: null,
        timedOut,
        stdout: "",
        stderr: error.message,
        outputTruncated: false,
      });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveRun({
        command: [command, ...args],
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputTruncated:
          stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES,
      });
    });
  });
}

function toolResult(result) {
  const text = JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: result,
    isError: result.exitCode !== 0,
  };
}

function toolValue(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(code) {
  return {
    content: [{ type: "text", text: code }],
    structuredContent: { error: code },
    isError: true,
  };
}

function hasExactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}
