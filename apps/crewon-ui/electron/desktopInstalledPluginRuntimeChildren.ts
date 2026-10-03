import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerCatalogEntry,
  type InstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

const READY_PREFIX = "CrewON Installed Plugin Peer origin ";
const DEFAULT_DEADLINE_MS = 10_000;
type ExpectedEntry = Pick<
  InstalledPluginPeerCatalogEntry,
  "identity" | "configuration" | "configuredTarget"
>;

export type DesktopInstalledPluginRuntimeChildrenRuntime = Readonly<{
  worker: Readonly<NodeJS.ProcessEnv>;
  control: Readonly<NodeJS.ProcessEnv>;
  controlAfterPeer?(
    input: Readonly<{ origin: string }>,
  ): Readonly<NodeJS.ProcessEnv>;
  token: string;
  scope: PluginProfileScope;
  expectedCatalogEntries: readonly ExpectedEntry[];
  assertCurrent(): void;
  withdraw(): void;
}>;

/** Challenges loaded metadata before the owner can issue explicit v3 candidate/activation input. */
export async function startDesktopInstalledPluginRuntimeChildren(input: {
  runtime: DesktopInstalledPluginRuntimeChildrenRuntime;
  signal: AbortSignal;
  spawnControl(environment: NodeJS.ProcessEnv): ChildProcess;
  spawnWorker(environment: NodeJS.ProcessEnv): ChildProcess;
  trackChild(child: ChildProcess): void;
  deadlineMs?: number;
}): Promise<Readonly<{ control: ChildProcess; worker: ChildProcess }>> {
  const runtime = input.runtime;
  const workerEnvironment = copyEnvironment(runtime.worker);
  const controlEnvironment = copyEnvironment(runtime.control);
  const controlAfterPeer = runtime.controlAfterPeer?.bind(runtime);
  const token = runtime.token;
  if (!/^[a-f0-9]{64}$/u.test(token)) fail("token_invalid");
  const scope = parsePluginProfileScope(runtime.scope);
  if (
    scope.tenantId !== DESKTOP_RUNTIME_OWNER.tenantId ||
    scope.spaceId !== DESKTOP_RUNTIME_OWNER.spaceId
  )
    fail("scope_invalid");
  const expected = copyExpectedEntries(runtime.expectedCatalogEntries, scope);
  const assertCurrent = runtime.assertCurrent.bind(runtime);
  const withdraw = runtime.withdraw.bind(runtime);
  const signal = input.signal;
  const spawnWorker = input.spawnWorker;
  const spawnControl = input.spawnControl;
  const trackChild = input.trackChild;
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 30_000
  )
    fail("deadline_invalid");
  const fetchPeer = globalThis.fetch;
  const controller = new AbortController();
  let withdrawn = false;
  const revoke = (code: string) => {
    if (!controller.signal.aborted) controller.abort(failure(code));
    if (!withdrawn) {
      withdrawn = true;
      withdraw();
    }
  };
  const onAbort = () => revoke("cancelled");
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => revoke("deadline_exceeded"), deadlineMs);
  let worker: ChildProcess | undefined;
  const onExit = () => revoke("worker_exited");
  const onError = () => revoke("worker_error");
  const assertLive = () => {
    controller.signal.throwIfAborted();
    assertCurrent();
    if (worker && (worker.exitCode !== null || worker.signalCode !== null))
      fail("worker_exited");
  };
  try {
    if (signal.aborted) onAbort();
    assertLive();
    worker = spawnWorker(workerEnvironment);
    trackChild(worker);
    worker.once("exit", onExit);
    worker.once("error", onError);
    assertLive();
    const origin = await waitForPeerOrigin(worker, controller.signal);
    assertLive();
    const request = parseInstalledPluginPeerRequest({
      protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
      requestId: randomUUID(),
      operation: "catalog",
      actor: DESKTOP_RUNTIME_OWNER,
      scope,
    });
    await challengeCatalog({
      origin,
      token,
      request,
      expected,
      signal: controller.signal,
      fetchPeer,
      revoke: () => revoke("challenge_failed"),
    });
    assertLive();
    const challengedControl = controlAfterPeer
      ? copyEnvironment(controlAfterPeer({ origin }))
      : controlEnvironment;
    assertLive();
    const control = spawnControl(challengedControl);
    trackChild(control);
    if (control.exitCode !== null || control.signalCode !== null)
      fail("control_exited");
    assertLive();
    return Object.freeze({ control, worker });
  } catch (error) {
    revoke("challenge_failed");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    worker?.off("exit", onExit);
    worker?.off("error", onError);
  }
}

function copyEnvironment(
  input: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const values = ownRecord(input);
  if (
    Object.values(values).some(
      (value) => value !== undefined && typeof value !== "string",
    )
  )
    fail("environment_invalid");
  return Object.freeze({ ...values }) as NodeJS.ProcessEnv;
}

function copyExpectedEntries(
  input: readonly ExpectedEntry[],
  scope: PluginProfileScope,
): readonly ExpectedEntry[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    Object.getOwnPropertySymbols(input).length !== 0 ||
    input.length > INSTALLED_PLUGIN_PEER_WIRE_LIMITS.entries
  )
    fail("catalog_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).length !== input.length + 1)
    fail("catalog_invalid");
  const captured = Array.from({ length: input.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("catalog_invalid");
    return descriptor.value as ExpectedEntry;
  });
  // The public wire parser captures every nested value before any asynchronous work.
  const parsed = parseInstalledPluginPeerResponse({
    protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
    requestId: "native-catalog-snapshot",
    operation: "catalog",
    actor: DESKTOP_RUNTIME_OWNER,
    scope,
    entries: captured.map((entry) => {
      const value = ownRecord(entry);
      if (
        Object.keys(value).length !== 3 ||
        !["identity", "configuration", "configuredTarget"].every((key) =>
          Object.hasOwn(value, key),
        )
      )
        fail("catalog_invalid");
      return { ...value, manifest: {} };
    }),
  });
  if (parsed.operation !== "catalog") fail("catalog_invalid");
  const entries = parsed.entries.map(
    ({ identity, configuration, configuredTarget }) => {
      parseExtensionExecutionTarget(configuredTarget);
      return Object.freeze({ identity, configuration, configuredTarget });
    },
  );
  for (let index = 0; index < entries.length; index++) {
    if (
      entries
        .slice(0, index)
        .some((entry) => isDeepStrictEqual(entry, entries[index]))
    )
      fail("catalog_duplicate");
  }
  return Object.freeze(entries);
}

function ownRecord(input: unknown): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    fail("input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some(
      (value) => !("value" in value) || !value.enumerable,
    )
  )
    fail("input_invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([name, value]) => [name, value.value]),
  );
}

function waitForPeerOrigin(
  child: ChildProcess,
  signal: AbortSignal,
): Promise<string> {
  if (!child.stdout) return Promise.reject(failure("stdout_unavailable"));
  const stdout = child.stdout;
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let bytes = 0;
    let settled = false;
    const finish = (error: unknown, origin?: string) => {
      if (settled) return;
      settled = true;
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(origin!);
    };
    const onAbort = () => finish(signal.reason ?? failure("cancelled"));
    const onEnd = () => finish(failure("stdout_closed"));
    const onData = (chunk: Buffer | string) => {
      try {
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += data.byteLength;
        if (bytes > INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes)
          fail("stdout_limit");
        text += decoder.decode(data, { stream: true });
        for (
          let newline = text.indexOf("\n");
          newline !== -1;
          newline = text.indexOf("\n")
        ) {
          const line = text.slice(0, newline).replace(/\r$/u, "");
          text = text.slice(newline + 1);
          if (line.startsWith(READY_PREFIX)) {
            finish(null, peerOrigin(line.slice(READY_PREFIX.length)));
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    };
    stdout.on("data", onData);
    stdout.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function peerOrigin(input: string): string {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(input);
  if (!match || Number(match[1]) > 65_535 || new URL(input).origin !== input)
    fail("origin_invalid");
  return input;
}

async function challengeCatalog(input: {
  origin: string;
  token: string;
  request: InstalledPluginPeerRequest;
  expected: readonly ExpectedEntry[];
  signal: AbortSignal;
  fetchPeer: typeof fetch;
  revoke(): void;
}): Promise<void> {
  // Cancellation withdraws authority immediately, but cannot release actual fetch/body ownership.
  // A transport that ignores AbortSignal must physically settle before this promise rejects.
  const response = await input.fetchPeer(
    `${input.origin}${INSTALLED_PLUGIN_PEER_PRIVATE_PATH}`,
    {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: input.signal,
      headers: {
        "authorization": `Bearer ${input.token}`,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify(input.request),
    },
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    input.signal.throwIfAborted();
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/iu.test(
        response.headers.get("content-type") ?? "",
      )
    )
      fail("response_invalid");
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^[0-9]+$/u.test(length) ||
        Number(length) > INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes)
    )
      fail("response_limit");
    if (!response.body) fail("response_invalid");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      input.signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes)
        fail("response_limit");
      chunks.push(chunk.value);
    }
    const parsed = parseInstalledPluginPeerResponse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
    if (
      parsed.operation !== "catalog" ||
      parsed.requestId !== input.request.requestId ||
      !isDeepStrictEqual(parsed.actor, input.request.actor) ||
      !isDeepStrictEqual(parsed.scope, input.request.scope)
    )
      fail("response_echo_mismatch");
    const seen = new Set<number>();
    for (const entry of parsed.entries) {
      const manifest = parseExtensionManifest(entry.manifest);
      if (
        manifest.pluginId !== entry.identity.pluginId ||
        manifest.version !== entry.identity.version ||
        `sha256:${createHash("sha256").update(extensionCanonicalJson(manifest)).digest("hex")}` !==
          entry.identity.manifestDigest
      )
        fail("manifest_mismatch");
      parseExtensionExecutionTarget(entry.configuredTarget);
      const projection = {
        identity: entry.identity,
        configuration: entry.configuration,
        configuredTarget: entry.configuredTarget,
      };
      const index = input.expected.findIndex((expected) =>
        isDeepStrictEqual(expected, projection),
      );
      if (index === -1 || seen.has(index)) fail("catalog_mismatch");
      seen.add(index);
    }
  } catch (error) {
    input.revoke();
    throw error;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    } else if (response.body) await response.body.cancel();
  }
}

function failure(code: string): Error {
  return new Error(`desktop_installed_plugin_peer_${code}`);
}
function fail(code: string): never {
  throw failure(code);
}
