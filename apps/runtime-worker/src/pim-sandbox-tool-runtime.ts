import {
  InMemoryToolBroker,
  ToolBrokerError,
  type ToolDefinition,
  type ToolExecutionPolicy,
  type ToolInvocation,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import {
  PimThreadSandbox,
  type ThreadSandboxPort,
} from "../../control-api/src/pim-sandbox-client.ts";

const SANDBOX_ROOT = "/workspace";
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 24 * 1024;
const CONFIGURATION_NAMES = [
  "CREWON_PIM_SANDBOX_BASE_URL",
  "CREWON_PIM_SANDBOX_USERNAME",
  "CREWON_PIM_SANDBOX_PASSWORD",
  "CREWON_PIM_SANDBOX_AGENT_ID",
] as const;
type FunctionInputSchema = Extract<
  ToolDefinition,
  { kind: "function" }
>["inputSchema"];

const definitions: readonly ToolDefinition[] = [
  definition(
    "workspace_list_directory",
    "List one directory in the current PIM workspace sandbox. Paths must stay below /workspace.",
    {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
    },
  ),
  definition(
    "workspace_read_file",
    "Read a bounded UTF-8 preview of one file in the current PIM workspace sandbox.",
    {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  ),
  definition(
    "workspace_git_diff",
    "Read the current git diff, including untracked files, from the PIM workspace sandbox.",
    {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  ),
  definition(
    "workspace_run_command",
    "Run a bounded shell command in the current PIM workspace sandbox and return its real cwd, exit code, stdout, and stderr.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 },
      },
      required: ["command"],
    },
    "serial",
  ),
];

const readPolicy: ToolExecutionPolicy = {
  effect: "readOnly",
  recovery: "replaySafe",
  resourceBindingId: "pim-workspace-sandbox",
  credentialBindingId: "pim-sandbox-service",
  executionTarget: { kind: "control", bindingId: "pim-sandbox" },
  capability: "workspace.read.v0",
  approvalRequirement: "none",
  limits: {
    timeoutMs: 35_000,
    maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    maxArtifactBytes: 1,
  },
};

const commandPolicy: ToolExecutionPolicy = {
  ...readPolicy,
  effect: "mutation",
  recovery: "reconcilable",
  capability: "workspace.command.v0",
  limits: { ...readPolicy.limits, timeoutMs: 125_000 },
};

/** Adds the PIM-owned sandbox to the same durable Tool path as other Runs. */
export function createPimSandboxToolRuntime(
  sandbox: ThreadSandboxPort,
): ToolRuntimePort {
  const handlers = new Map([
    [
      key("workspace_list_directory"),
      async (invocation: ToolInvocation) => ({
        output: boundedJson(
          await sandbox.listDirectory(
            sandboxPath(
              optionalStringInput(invocation.input, "path") ?? SANDBOX_ROOT,
            ),
          ),
        ),
      }),
    ],
    [
      key("workspace_read_file"),
      async (invocation: ToolInvocation) => ({
        output: boundedJson(
          await sandbox.readFile(
            sandboxPath(requiredStringInput(invocation.input, "path")),
          ),
        ),
      }),
    ],
    [
      key("workspace_git_diff"),
      async (invocation: ToolInvocation) => {
        requireExactInput(invocation.input, []);
        return { output: boundedJson(await sandbox.readDiff()) };
      },
    ],
    [
      key("workspace_run_command"),
      async (invocation: ToolInvocation) => {
        const input = parseObject(invocation.input, [
          "command",
          "cwd",
          "timeoutSeconds",
        ]);
        const command = requiredString(input.command, "workspace_command_invalid");
        const cwdInput = optionalString(
          input.cwd,
          "workspace_command_cwd_invalid",
        );
        const cwd = cwdInput === undefined ? undefined : sandboxPath(cwdInput);
        const timeoutSeconds = optionalTimeout(input.timeoutSeconds);
        const view = await sandbox.runCommand({
          command,
          ...(cwd === undefined ? {} : { cwd }),
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        });
        return {
          output: boundedJson({
            ...view,
            stdout: truncateUtf8(view.stdout, MAX_COMMAND_OUTPUT_BYTES),
            stderr: truncateUtf8(view.stderr, MAX_COMMAND_OUTPUT_BYTES),
          }),
        };
      },
    ],
  ]);
  const policies = new Map(
    definitions.map((item) => [
      `${item.kind}:${item.name}`,
      item.name === "workspace_run_command" ? commandPolicy : readPolicy,
    ]),
  );
  return new InMemoryToolBroker(definitions, handlers, policies);
}

export function createConfiguredPimSandboxToolRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): ToolRuntimePort | undefined {
  const configured = CONFIGURATION_NAMES.filter(
    (name) => environment[name]?.trim().length,
  );
  if (configured.length === 0) return undefined;
  if (configured.length !== CONFIGURATION_NAMES.length) {
    throw new Error("CREWON_PIM_SANDBOX_configuration_incomplete");
  }
  const agentId = Number(environment.CREWON_PIM_SANDBOX_AGENT_ID);
  return createPimSandboxToolRuntime(
    new PimThreadSandbox({
      agentId,
      baseUrl: environment.CREWON_PIM_SANDBOX_BASE_URL!,
      username: environment.CREWON_PIM_SANDBOX_USERNAME!,
      password: environment.CREWON_PIM_SANDBOX_PASSWORD!,
    }),
  );
}

function definition(
  name: string,
  description: string,
  inputSchema: FunctionInputSchema,
  execution: "parallel" | "serial" = "parallel",
): ToolDefinition {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name,
    description,
    execution,
    inputSchema,
  };
}

function key(name: string): string {
  return `function:${name}`;
}

function requiredStringInput(input: string, name: string): string {
  const value = parseObject(input, [name]);
  return requiredString(value[name], `workspace_${name}_invalid`);
}

function optionalStringInput(input: string, name: string): string | undefined {
  const value = parseObject(input, [name]);
  return optionalString(value[name], `workspace_${name}_invalid`);
}

function requireExactInput(input: string, keys: readonly string[]): void {
  parseObject(input, keys);
}

function parseObject(
  input: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (cause) {
    throw new ToolBrokerError("workspace_tool_input_invalid", { cause });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw new ToolBrokerError("workspace_tool_input_invalid");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string): string {
  const parsed = optionalString(value, code);
  if (parsed === undefined) throw new ToolBrokerError(code);
  return parsed;
}

function optionalString(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value) > 16 * 1024 ||
    value.includes("\0")
  ) {
    throw new ToolBrokerError(code);
  }
  return value;
}

function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 120) {
    throw new ToolBrokerError("workspace_command_timeout_invalid");
  }
  return Number(value);
}

function sandboxPath(value: string): string {
  return value.startsWith("/") ? value : `${SANDBOX_ROOT}/${value}`;
}

function boundedJson(value: unknown): string {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > MAX_TOOL_OUTPUT_BYTES) {
    throw new ToolBrokerError("workspace_tool_output_too_large");
  }
  return output;
}

function truncateUtf8(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maximum
    ? value
    : `${bytes.subarray(0, maximum).toString("utf8")}\n[output truncated]`;
}
