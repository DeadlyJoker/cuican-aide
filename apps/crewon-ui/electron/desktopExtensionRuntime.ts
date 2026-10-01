import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  EXTENSION_HOST_PRIVATE_PATH,
  EXTENSION_HOST_WIRE_LIMITS,
  parseExtensionHostActor,
  parseExtensionHostResponse,
} from "@crewon/contracts";

export const DESKTOP_EXTENSION_CONFIGURATION_FILE =
  "desktop-extension-runtime.json";
const SCHEMA = "crewon.desktop-extension-runtime.v0";
const MAX_CONFIGURATION_BYTES = 16 * 1024;
const DEFAULT_DEADLINE_MS = 20_000;
const READY_PREFIX = "CrewON Extension Host origin ";

/** The existing single-owner standalone composition, never supplied by ambient env. */
export const DESKTOP_RUNTIME_OWNER = parseExtensionHostActor({
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
});

export type DesktopExtensionRuntimeConfiguration =
  | Readonly<{ schemaVersion: typeof SCHEMA; enabled: false }>
  | Readonly<{
      schemaVersion: typeof SCHEMA;
      enabled: true;
      runtimeBindingsPath: string | null;
      agentVersionAssetsPath: string | null;
    }>;

export type DesktopExtensionRuntimeEnvironments = Readonly<{
  release: NodeJS.ProcessEnv;
  worker: NodeJS.ProcessEnv;
  control: (origin: string) => NodeJS.ProcessEnv;
  deadlineMs: number;
}> &
  (Readonly<{ enabled: false }> | Readonly<{ enabled: true; token: string }>);

export function parseDesktopExtensionRuntimeConfiguration(
  input: unknown,
): DesktopExtensionRuntimeConfiguration {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((d) => !("value" in d) || !d.enumerable))
    invalid();
  const value = Object.fromEntries(
    Object.entries(descriptors).map(([key, d]) => [key, d.value]),
  ) as Record<string, unknown>;
  const expected =
    value.enabled === false
      ? ["schemaVersion", "enabled"]
      : [
          "schemaVersion",
          "enabled",
          "runtimeBindingsPath",
          "agentVersionAssetsPath",
        ];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== SCHEMA ||
    (value.enabled !== false && value.enabled !== true)
  )
    invalid();
  if (!value.enabled)
    return Object.freeze({ schemaVersion: SCHEMA, enabled: false });
  const runtimeBindingsPath = configurationPath(value.runtimeBindingsPath);
  const agentVersionAssetsPath = configurationPath(
    value.agentVersionAssetsPath,
  );
  if ((runtimeBindingsPath === null) !== (agentVersionAssetsPath === null))
    invalid();
  return Object.freeze({
    schemaVersion: SCHEMA,
    enabled: true,
    runtimeBindingsPath,
    agentVersionAssetsPath,
  });
}

/** Reload on every start; the operator can prepare immutable inputs and restart. */
export function loadDesktopExtensionRuntimeConfiguration(
  dataDirectory: string,
): DesktopExtensionRuntimeConfiguration {
  const path = join(dataDirectory, DESKTOP_EXTENSION_CONFIGURATION_FILE);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return parseDesktopExtensionRuntimeConfiguration({
        schemaVersion: SCHEMA,
        enabled: false,
      });
    invalid();
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CONFIGURATION_BYTES) invalid();
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > MAX_CONFIGURATION_BYTES) invalid();
    return parseDesktopExtensionRuntimeConfiguration(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    invalid();
  } finally {
    closeSync(descriptor);
  }
}

export function clearDesktopExtensionEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const copied = { ...environment };
  for (const name of Object.keys(copied)) {
    if (
      name.startsWith("CREWON_EXTENSIONS") ||
      name.startsWith("CREWON_EXTENSION_") ||
      (name.startsWith("CREWON_NATIVE_") && name.includes("BOOTSTRAP"))
    )
      delete copied[name];
  }
  return copied;
}

export function desktopExtensionRuntimeEnvironments(input: {
  configuration: DesktopExtensionRuntimeConfiguration;
  sharedEnvironment: NodeJS.ProcessEnv;
  workerEnvironment: NodeJS.ProcessEnv;
  deadlineMs?: number;
  /** Only supplied by the native composition for installed bundled entrypoints. */
  retainedBuild?: Readonly<{ dataRoot: string }>;
}): DesktopExtensionRuntimeEnvironments {
  const configuration = parseDesktopExtensionRuntimeConfiguration(
    input.configuration,
  );
  const deadlineMs = deadline(input.deadlineMs);
  const shared = clearDesktopExtensionEnvironment(input.sharedEnvironment);
  const worker = clearDesktopExtensionEnvironment(input.workerEnvironment);
  if (!configuration.enabled)
    return {
      enabled: false as const,
      release: shared,
      worker,
      control: (_origin: string) => ({ ...shared }),
      deadlineMs,
    };
  const token = randomBytes(32).toString("hex");
  const archive =
    input.retainedBuild === undefined
      ? {}
      : {
          CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: configurationPath(
            input.retainedBuild.dataRoot,
          )!,
        };
  const owner = {
    CREWON_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
    CREWON_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
    CREWON_TENANT_ID: DESKTOP_RUNTIME_OWNER.tenantId,
    CREWON_SPACE_ID: DESKTOP_RUNTIME_OWNER.spaceId,
    CREWON_EXTENSIONS_ENABLED: "1",
  };
  const paths =
    configuration.runtimeBindingsPath === null
      ? {}
      : {
          CREWON_EXTENSION_RUNTIME_BINDINGS_PATH:
            configuration.runtimeBindingsPath,
          CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH:
            configuration.agentVersionAssetsPath!,
        };
  return {
    enabled: true as const,
    token,
    deadlineMs,
    release: { ...shared, ...owner, ...paths, ...archive },
    worker: {
      ...worker,
      ...owner,
      ...paths,
      CREWON_EXTENSION_HOST_PORT: "0",
      CREWON_EXTENSION_HOST_TOKEN: token,
      CREWON_EXTENSION_HOST_DEADLINE_MS: String(deadlineMs),
    },
    control: (origin: string) => ({
      ...shared,
      ...owner,
      CREWON_EXTENSION_HOST_ORIGIN: parseDesktopExtensionHostOrigin(origin),
      CREWON_EXTENSION_HOST_TOKEN: token,
      CREWON_EXTENSION_HOST_DEADLINE_MS: String(deadlineMs),
    }),
  };
}

/** Tracks each child before any await, so the supervisor owns every partial start. */
export async function startDesktopRuntimeChildren(input: {
  environments: DesktopExtensionRuntimeEnvironments;
  signal: AbortSignal;
  spawnControl: (environment: NodeJS.ProcessEnv) => ChildProcess;
  spawnWorker: (environment: NodeJS.ProcessEnv) => ChildProcess;
  trackChild: (child: ChildProcess) => void;
}): Promise<
  Readonly<{
    control: ChildProcess;
    worker: ChildProcess;
    extensionOrigin?: string;
  }>
> {
  const extensions = input.environments;
  const spawn = (child: ChildProcess) => {
    input.trackChild(child);
    return child;
  };
  if (!extensions.enabled) {
    const control = spawn(input.spawnControl(extensions.release));
    const worker = spawn(input.spawnWorker(extensions.worker));
    return { control, worker };
  }
  const worker = spawn(input.spawnWorker(extensions.worker));
  const origin = await waitForDesktopExtensionHost(worker, {
    signal: input.signal,
    deadlineMs: extensions.deadlineMs,
  });
  await challengeDesktopExtensionHost({
    origin,
    token: extensions.token,
    signal: input.signal,
    deadlineMs: extensions.deadlineMs,
  });
  input.signal.throwIfAborted();
  if (worker.exitCode !== null || worker.signalCode !== null)
    throw new Error("desktop_extension_host_child_exited");
  const control = spawn(input.spawnControl(extensions.control(origin)));
  return { control, worker, extensionOrigin: origin };
}

/** Attempt every shutdown; retain ownership of a child that has not reached exit. */
export async function settleDesktopRuntimeChildren(
  children: readonly ChildProcess[],
  terminate: (child: ChildProcess) => Promise<void>,
): Promise<
  Readonly<{
    terminal: ReadonlySet<ChildProcess>;
    failures: readonly unknown[];
  }>
> {
  const results = await Promise.allSettled(children.map(terminate));
  return {
    terminal: new Set(
      children.filter(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    ),
    failures: results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  };
}

export function parseDesktopExtensionHostOrigin(value: string): string {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(value);
  if (!match || Number(match[1]) > 65_535)
    throw new Error("desktop_extension_host_origin_invalid");
  return value;
}

export function waitForDesktopExtensionHost(
  child: ChildProcess,
  options: { signal: AbortSignal; deadlineMs?: number },
): Promise<string> {
  const timeoutMs = deadline(options.deadlineMs);
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let pending = "";
    let settled = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const finish = (error: Error | null, origin?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      options.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(origin!);
    };
    const onData = (chunk: Buffer | string) => {
      try {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += buffer.byteLength;
        if (bytes > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
          throw new Error("desktop_extension_host_output_limit");
        pending += decoder.decode(buffer, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.startsWith(READY_PREFIX))
            finish(
              null,
              parseDesktopExtensionHostOrigin(line.slice(READY_PREFIX.length)),
            );
          if (settled) return;
        }
      } catch {
        finish(new Error("desktop_extension_host_readiness_invalid"));
      }
    };
    const onExit = () =>
      finish(new Error("desktop_extension_host_child_exited"));
    const onError = () =>
      finish(new Error("desktop_extension_host_child_failed"));
    const onAbort = () =>
      finish(new Error("desktop_extension_host_start_aborted"));
    const timer = setTimeout(
      () => finish(new Error("desktop_extension_host_readiness_timeout")),
      timeoutMs,
    );
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (!child.stdout || child.exitCode !== null || child.signalCode !== null)
      onExit();
    else if (options.signal.aborted) onAbort();
  });
}

/** Proves the discovered port is the native-owned Worker, including the complete owner. */
export async function challengeDesktopExtensionHost(input: {
  origin: string;
  token: string;
  signal: AbortSignal;
  deadlineMs?: number;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(input.token))
    throw new Error("desktop_extension_host_token_invalid");
  const origin = parseDesktopExtensionHostOrigin(input.origin);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(deadline(input.deadlineMs)),
  ]);
  const response = await fetch(`${origin}${EXTENSION_HOST_PRIVATE_PATH}`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "authorization": `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "crewon.extension-host-request.v0",
      operation: "catalog",
      actor: DESKTOP_RUNTIME_OWNER,
    }),
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
  ) {
    await response.body?.cancel();
    throw new Error("desktop_extension_host_challenge_failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("desktop_extension_host_challenge_failed");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
        throw new Error("desktop_extension_host_response_limit");
      chunks.push(chunk.value);
    }
    const value = parseExtensionHostResponse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
    if (
      value.operation !== "catalog" ||
      Object.entries(DESKTOP_RUNTIME_OWNER).some(
        ([key, expected]) =>
          value.actor[key as keyof typeof DESKTOP_RUNTIME_OWNER] !== expected,
      )
    )
      throw new Error("desktop_extension_host_owner_mismatch");
    signal.throwIfAborted();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function deadline(input?: number): number {
  const value = input ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(value) || value < 1000 || value > 30_000) invalid();
  return value;
}
function configurationPath(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !isAbsolute(value) ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    Buffer.byteLength(value) > 4096
  )
    invalid();
  return value;
}
function invalid(): never {
  throw new Error("desktop_extension_runtime_configuration_invalid");
}
