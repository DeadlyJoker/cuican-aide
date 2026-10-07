import { chmod, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkspaceCommandGuard } from "./local-workspace-command-guard.mts";
import {
  createWorkspaceCommands,
  WORKSPACE_COMMAND_TIMEOUT_MS,
} from "./local-workspace-commands.mts";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePrefix,
} from "./local-workspace-reads.mts";

const COMMAND_TIMEOUT_MS = WORKSPACE_COMMAND_TIMEOUT_MS;

if (process.argv[2] === "--command-guard") await runWorkspaceCommandGuard();

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

const [
  { Server },
  { StdioServerTransport },
  { CallToolRequestSchema, ListToolsRequestSchema },
] = await Promise.all([
  import("@modelcontextprotocol/sdk/server/index.js"),
  import("@modelcontextprotocol/sdk/server/stdio.js"),
  import("@modelcontextprotocol/sdk/types.js"),
]);
const commands = createWorkspaceCommands(fileURLToPath(import.meta.url));

const server = new Server(
  { name: "crewon-local-workspace-checks", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_files",
      description:
        "List up to 200 sorted entries inside the current local workspace. Scans exceeding 10,000 entries or the work deadline are rejected; choose a narrower relative directory such as apps/crewon-ui.",
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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
      return toolValue({
        path: input.path,
        ...(await listWorkspaceDirectory(directory, { signal: extra.signal })),
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
      return toolValue({
        path: input.path,
        ...(await readWorkspaceFilePrefix(file, { signal: extra.signal })),
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
    return executeCommand({
      command: process.env.CREWON_LOCAL_GIT_PATH,
      commandError: "local_git_path_invalid",
      args: ["status", "--short"],
      cwd: repoRoot,
      signal: extra.signal,
    });
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
    return executeCommand({
      command: process.env.CREWON_LOCAL_PNPM_PATH,
      commandError: "local_pnpm_path_invalid",
      args: ["--filter", "@crewon/ui", "exec", "vitest", "run", testFile],
      cwd: repoRoot,
      signal: extra.signal,
    });
  }
  return toolError("local_workspace_tool_not_found");
});

await server.connect(new StdioServerTransport());

let shutdownPromise;
const shutdown = () =>
  (shutdownPromise ??= (async () => {
    await commands.close();
    await server.close();
  })());
server.onclose = () => {
  void shutdown();
};
process.stdin.once("end", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

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

function toolResult(result) {
  const text = JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: result,
    isError: result.timedOut || result.exitCode !== 0,
  };
}

async function executeCommand(request) {
  try {
    // Finder does not inherit the developer shell's PATH. Missing optional
    // developer tools must not prevent catalog discovery and file reads from
    // starting the desktop runtime. Keep absolute-path validation at invocation.
    const { commandError, ...execution } = request;
    execution.command = requireExecutablePath(execution.command, commandError);
    return toolResult(await commands.run(execution));
  } catch (error) {
    return toolError(
      error instanceof Error ? error.message : "workspace_command_failed",
    );
  }
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
