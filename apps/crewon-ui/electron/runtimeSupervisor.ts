import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import type { ActiveProvider } from "./providerCredentials.ts";

type RuntimePaths = Readonly<{
  control: string;
  release: string;
  worker: string;
  workspaceMcp: string;
  source: boolean;
}>;

export type ControlRuntimeSession = Readonly<{
  baseUrl: string;
  csrfToken: string;
  origin: string;
  sessionToken: string;
}>;

export class RuntimeSupervisor {
  readonly #dataDirectory: string;
  readonly #paths: RuntimePaths;
  readonly #repositoryRoot: string | null;
  readonly #origin = "http://crewon.localhost";
  readonly #sessionToken = randomBytes(32).toString("hex");
  readonly #csrfToken = randomBytes(32).toString("hex");
  readonly #probeToken = randomBytes(32).toString("hex");
  readonly #provider: () => ActiveProvider | null;
  readonly #workspaceRoot: () => string | null;
  #controlPort = 0;
  #probePort = 0;
  #children: ChildProcess[] = [];
  #restart: Promise<void> = Promise.resolve();
  #ready = false;

  constructor(options: {
    dataDirectory: string;
    paths: RuntimePaths;
    repositoryRoot: string | null;
    provider: () => ActiveProvider | null;
    workspaceRoot: () => string | null;
  }) {
    this.#dataDirectory = options.dataDirectory;
    this.#paths = options.paths;
    this.#repositoryRoot = options.repositoryRoot;
    this.#provider = options.provider;
    this.#workspaceRoot = options.workspaceRoot;
  }

  async start(): Promise<void> {
    if (this.#children.length > 0) return;
    const provider = this.#provider();
    if (provider === null) {
      this.#ready = false;
      return;
    }
    this.#controlPort ||= await freePort();
    this.#probePort ||= await freePort();
    ensureStorage(this.#dataDirectory);
    const environment = this.#environment(provider);
    await this.#runOnce("Runtime release", this.#paths.release, environment);
    this.#children = [
      this.#spawn("Control API", this.#paths.control, environment),
      this.#spawn("Runtime Worker", this.#paths.worker, environment, true),
    ];
    try {
      await waitForReady(
        `http://127.0.0.1:${this.#controlPort}/api/v1/health/ready`,
        this.#children,
      );
      this.#ready = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async restart(): Promise<void> {
    this.#restart = this.#restart.then(async () => {
      await this.stop();
      await this.start();
    });
    return this.#restart;
  }

  async stop(): Promise<void> {
    this.#ready = false;
    const children = this.#children.splice(0);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
    await Promise.all(children.map(waitForExit));
  }

  session(): ControlRuntimeSession {
    if (!this.#ready) throw new Error("control_runtime_unavailable");
    return {
      baseUrl: `http://127.0.0.1:${this.#controlPort}/`,
      csrfToken: this.#csrfToken,
      origin: this.#origin,
      sessionToken: this.#sessionToken,
    };
  }

  #environment(provider: ActiveProvider): NodeJS.ProcessEnv {
    const agentProfiles = [
      {
        agentVersionIdSuffix: "planner",
        instructions:
          "你是本地规划智能体。先拆解约束、依赖和验收标准，再给出可执行计划。",
      },
      {
        agentVersionIdSuffix: "verifier",
        instructions:
          "你是本地独立验证智能体。逐项检查证据并明确通过、不通过或缺失证据。",
      },
    ] as const;
    const workspace = this.#workspaceRoot();
    const mcpConfig =
      workspace === null ? null : this.#writeMcpConfig(workspace);
    const fingerprint = desktopRuntimeFingerprint({
      providerId: provider.providerId,
      endpoint: provider.endpoint,
      modelId: provider.modelId,
      agentProfiles,
      localWorkspaceMcp:
        mcpConfig === null
          ? null
          : {
              configPath: mcpConfig,
              configDigest: fileDigest(mcpConfig),
              serverDigest: fileDigest(this.#paths.workspaceMcp),
            },
    });
    const agentVersionId = `local-desktop-${fingerprint.slice(0, 24)}`;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      CREWON_ACTOR_ID: "standalone-actor",
      CREWON_AGENT_VERSION_ID: agentVersionId,
      CREWON_ARTIFACT_DB_PATH: join(
        this.#dataDirectory,
        "artifact-metadata.sqlite",
      ),
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "desktop-artifact-key-v1",
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: join(
        this.#dataDirectory,
        "artifact-encryption.key",
      ),
      CREWON_ARTIFACT_ROOT: join(this.#dataDirectory, "artifacts"),
      CREWON_AUTHORITY_ID: "standalone-authority",
      CREWON_CONTROL_ALLOWED_ORIGINS: this.#origin,
      CREWON_CONTROL_CSRF_TOKEN: this.#csrfToken,
      CREWON_CONTROL_DB_PATH: join(this.#dataDirectory, "control.sqlite"),
      CREWON_CONTROL_ORIGIN: this.#origin,
      CREWON_CONTROL_PORT: String(this.#controlPort),
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_CONTROL_SESSION_TOKEN: this.#sessionToken,
      CREWON_CONTROL_TARGET: `http://127.0.0.1:${this.#controlPort}`,
      CREWON_MODEL_ADAPTER: "responses",
      CREWON_MODEL_API_KEY: provider.apiKey ?? "",
      CREWON_MODEL_ID: provider.modelId,
      CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify([
        ...agentProfiles.map((profile) => ({
          agentVersionId: `${agentVersionId}-${profile.agentVersionIdSuffix}`,
          instructions: profile.instructions,
        })),
      ]),
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
        this.#dataDirectory,
        "agent-version-runtime-bindings.json",
      ),
      CREWON_NATIVE_WORKSPACE_READ_ENABLED: "0",
      CREWON_POLICY_SNAPSHOT_ID: "standalone-policy-v0",
      CREWON_PRINCIPAL_ID: "standalone-principal",
      CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
      CREWON_PROVIDER_PROBE_ENDPOINT: provider.endpoint,
      CREWON_PROVIDER_PROBE_PORT: String(this.#probePort),
      CREWON_PROVIDER_PROBE_PROVIDER_ID: provider.providerId,
      CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: `desktop-${fingerprint.slice(0, 32)}`,
      CREWON_PROVIDER_PROBE_TOKEN: this.#probeToken,
      CREWON_PROVIDER_PROBE_WORKER_ORIGIN: `http://127.0.0.1:${this.#probePort}`,
      CREWON_PROVIDER_PROBE_WORKER_TOKEN: this.#probeToken,
      CREWON_RELEASE_ACTOR_ID: "standalone-actor",
      CREWON_RELEASE_PRINCIPAL_ID: "standalone-principal",
      CREWON_RESPONSES_ENDPOINT: responsesEndpoint(provider.endpoint),
      CREWON_RUNTIME_GENERATION: `desktop-${fingerprint.slice(0, 32)}`,
      CREWON_SPACE_ID: "standalone-space",
      CREWON_TENANT_ID: "standalone-tenant",
    };
    if (mcpConfig !== null)
      environment.CREWON_MCP_STDIO_CONFIG_PATH = mcpConfig;
    for (const name of [
      "CREWON_CONTROL_DATABASE_URL",
      "CREWON_CONTROL_DATABASE_SCHEMA",
      "CREWON_DEVICE_TOOL_CONFIG_PATH",
      "CREWON_NATIVE_WORKSPACE_BOOTSTRAP",
      "CREWON_WORKSPACE_RUNTIME_WORKER_ORIGIN",
      "CREWON_WORKSPACE_RUNTIME_WORKER_TOKEN",
    ]) {
      delete environment[name];
    }
    return environment;
  }

  #writeMcpConfig(workspace: string): string | null {
    const server = this.#paths.workspaceMcp;
    if (!existsSync(server)) return null;
    const path = join(this.#dataDirectory, "local-workspace-mcp.json");
    const readPolicy = {
      effect: "readOnly",
      recovery: "replaySafe",
      resourceBindingId: "local-workspace",
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "local-workspace" },
      capability: "workspace.read_only_command.v0",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 125_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 1,
      },
    };
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: "crewon.mcp-stdio-config.v0",
          servers: [
            {
              serverId: "workspace_checks",
              command: process.execPath,
              args: [server],
              cwd: workspace,
              env: {
                ...pickEnvironment(["PATH"]),
                ELECTRON_RUN_AS_NODE: "1",
                CREWON_LOCAL_WORKSPACE_ROOT: workspace,
                CREWON_LOCAL_PNPM_PATH: executable("pnpm"),
                CREWON_LOCAL_GIT_PATH: executable("git"),
              },
              tools: {
                list_files: readPolicy,
                read_file: readPolicy,
                git_status: readPolicy,
                run_ui_test: readPolicy,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    return path;
  }

  #spawn(
    name: string,
    entry: string,
    environment: NodeJS.ProcessEnv,
    keepStdin = false,
  ): ChildProcess {
    const child = spawn(
      process.execPath,
      nodeArguments(entry, this.#paths.source),
      {
        cwd: this.#repositoryRoot ?? process.resourcesPath,
        env: environment,
        stdio: [keepStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout?.on("data", (chunk: Buffer) =>
      process.stdout.write(`[${name}] ${chunk}`),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      process.stderr.write(`[${name}] ${chunk}`),
    );
    child.once("error", (error) =>
      process.stderr.write(`[${name}] ${error.message}\n`),
    );
    return child;
  }

  async #runOnce(
    name: string,
    entry: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    const child = this.#spawn(name, entry, environment);
    const { code, signal } = await waitForExit(child);
    if (code !== 0)
      throw new Error(`${name} failed (${signal ?? code ?? "unknown"})`);
  }
}

export function desktopRuntimeFingerprint(input: {
  providerId: string;
  endpoint: string;
  modelId: string;
  agentProfiles: readonly Readonly<{
    agentVersionIdSuffix: string;
    instructions: string;
  }>[];
  localWorkspaceMcp: Readonly<{
    configPath: string;
    configDigest: string;
    serverDigest: string;
  }> | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        runtimeContract: "crewon.electron-typescript-runtime.v1",
      }),
    )
    .digest("hex");
}

export function runtimePaths(options: {
  packaged: boolean;
  repositoryRoot: string;
  resourcesPath: string;
}): RuntimePaths {
  const root = options.packaged
    ? join(options.resourcesPath, "runtime")
    : options.repositoryRoot;
  return options.packaged
    ? {
        control: join(root, "control-api.mjs"),
        release: join(root, "runtime-release.mjs"),
        worker: join(root, "runtime-worker.mjs"),
        workspaceMcp: join(root, "local-workspace-checks-mcp.mjs"),
        source: false,
      }
    : {
        control: join(root, "apps", "control-api", "src", "main.ts"),
        release: join(root, "apps", "runtime-worker", "src", "release-main.ts"),
        worker: join(root, "apps", "runtime-worker", "src", "main.ts"),
        workspaceMcp: join(root, "scripts", "local-workspace-checks-mcp.mjs"),
        source: true,
      };
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nodeArguments(entry: string, source: boolean): string[] {
  return source ? ["--experimental-strip-types", entry] : [entry];
}

function ensureStorage(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDirectory, "artifacts"), { recursive: true, mode: 0o700 });
  const key = join(dataDirectory, "artifact-encryption.key");
  if (!existsSync(key)) writeFileSync(key, randomBytes(32), { mode: 0o600 });
  chmodSync(key, 0o600);
  if (!statSync(key).isFile() || statSync(key).size !== 32) {
    throw new Error("artifact_encryption_key_invalid");
  }
}

function responsesEndpoint(base: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/responses`;
  return url.toString();
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForReady(
  url: string,
  children: readonly ChildProcess[],
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (
      children.some(
        (child) => child.exitCode !== null || child.signalCode !== null,
      )
    ) {
      throw new Error("control_runtime_child_exited");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The listening socket is expected to be absent while migrations finish.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("control_runtime_readiness_timeout");
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function executable(name: string): string {
  const pathEntries = (process.env.PATH ?? "").split(
    process.platform === "win32" ? ";" : ":",
  );
  const candidates =
    process.platform === "win32"
      ? [`${name}.cmd`, `${name}.exe`, name]
      : [name];
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const path = resolve(directory, candidate);
      if (existsSync(path)) return path;
    }
  }
  return name;
}

function pickEnvironment(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  );
}
