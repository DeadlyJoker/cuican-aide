import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SqliteRunStore } from "@crewon/store/sqlite-run-store";
import type { RunState, ThreadState } from "@crewon/domain";
import {
  ToolBrokerError,
  type ToolRuntimePort,
  type ToolExecutionCommand,
  type ToolCallKind,
  type ToolExecutionPolicyContext,
  type ToolExecutionResultAcknowledgement,
  type RetainedToolExecutionResultLookup,
  type RetainedToolExecutionResultQuery,
  type ToolExecutionReservationOptions,
  type RetainedToolExecutionResultScan,
  type ScopedRetainedToolExecutionResult,
} from "@crewon/tool-broker";

export interface DesktopWorkspaceThreadStore {
  loadRun(locator: {
    tenantId: string;
    runId: string;
  }): Promise<Pick<
    RunState,
    "tenantId" | "spaceId" | "threadId" | "runId"
  > | null>;
  loadThreadInSpace(locator: {
    tenantId: string;
    spaceId: string;
    threadId: string;
  }): Promise<Pick<
    ThreadState,
    "tenantId" | "spaceId" | "threadId" | "status" | "workspaceId"
  > | null>;
  close?(): Promise<void>;
}

type Binding = Readonly<{ workspaceId: string; root: string }>;

/** Reads only immutable Thread ownership; the selected UI workspace is irrelevant. */
export async function resolveDesktopThreadWorkspace(config: {
  store: DesktopWorkspaceThreadStore;
  registryPath: string;
  tenantId: string;
  spaceId: string;
  runId: string;
}): Promise<Binding> {
  const run = await config.store.loadRun({
    tenantId: config.tenantId,
    runId: config.runId,
  });
  if (
    run === null ||
    run.runId !== config.runId ||
    run.tenantId !== config.tenantId ||
    run.spaceId !== config.spaceId
  ) {
    throw new ToolBrokerError("desktop_workspace_run_unavailable");
  }
  const thread = await config.store.loadThreadInSpace({
    tenantId: run.tenantId,
    spaceId: run.spaceId,
    threadId: run.threadId,
  });
  if (
    thread === null ||
    thread.threadId !== run.threadId ||
    thread.tenantId !== run.tenantId ||
    thread.spaceId !== run.spaceId ||
    thread.status === "deleted"
  ) {
    throw new ToolBrokerError("desktop_workspace_thread_unavailable");
  }
  const workspaceId = thread.workspaceId ?? null;
  if (workspaceId === null)
    throw new ToolBrokerError("desktop_workspace_thread_unbound");
  return {
    workspaceId,
    root: readDesktopWorkspaceRoot(config.registryPath, workspaceId),
  };
}

export function readDesktopWorkspaceRoot(
  path: string,
  workspaceId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workspaceId))
    throw new ToolBrokerError("desktop_workspace_id_invalid");
  try {
    const descriptor = openSync(path, "r");
    let serialized: string;
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size > 128 * 1024)
        throw new Error("invalid");
      const bytes = Buffer.alloc(128 * 1024 + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          null,
        );
        if (count === 0) break;
        offset += count;
      }
      if (offset > 128 * 1024) throw new Error("invalid");
      serialized = bytes.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
    const registry = JSON.parse(serialized);
    if (
      registry?.schemaVersion !== "crewon.desktop-workspace-authority.v2" ||
      !Array.isArray(registry.workspaces) ||
      registry.workspaces.length > 100
    )
      throw new Error("invalid");
    if (
      !Number.isSafeInteger(registry.revision) ||
      registry.revision < 0 ||
      (registry.activeWorkspaceId !== null &&
        typeof registry.activeWorkspaceId !== "string")
    )
      throw new Error("invalid");
    const ids = new Set<string>();
    const roots = new Set<string>();
    for (const entry of registry.workspaces) {
      if (
        typeof entry?.workspaceId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.workspaceId) ||
        ids.has(entry.workspaceId) ||
        typeof entry.root !== "string" ||
        !isAbsolute(entry.root) ||
        entry.root.includes("\0") ||
        resolve(entry.root) !== entry.root ||
        roots.has(entry.root)
      )
        throw new Error("invalid");
      ids.add(entry.workspaceId);
      roots.add(entry.root);
    }
    if (
      registry.activeWorkspaceId !== null &&
      !ids.has(registry.activeWorkspaceId)
    )
      throw new Error("invalid");
    const entry = registry.workspaces.find(
      (value: Binding) => value.workspaceId === workspaceId,
    );
    if (entry === undefined) throw new Error("missing");
    const root = realpathSync(entry.root);
    // A replaced symlink must never silently redirect a registered authority.
    if (root !== entry.root || !statSync(root).isDirectory())
      throw new Error("unavailable");
    return root;
  } catch {
    throw new ToolBrokerError("desktop_workspace_binding_unavailable");
  }
}

/** Keeps each workspace's MCP process and command broker separate, including retries. */
type DesktopThreadWorkspaceRuntimeConfig = {
  registryPath: string;
  databasePath: string;
  tenantId: string;
  spaceId: string;
  createRuntime: (root: string) => Promise<ToolRuntimePort>;
  store?: DesktopWorkspaceThreadStore;
};

export class DesktopThreadWorkspaceToolRuntime implements ToolRuntimePort {
  readonly #catalog: ToolRuntimePort;
  readonly #config: DesktopThreadWorkspaceRuntimeConfig;
  readonly #pending = new Map<string, Promise<ToolRuntimePort>>();
  readonly #runtimes = new Map<string, ToolRuntimePort>();
  readonly #roots = new Map<string, string>();
  #store: DesktopWorkspaceThreadStore | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;
  #scanCursor = 0;
  readonly #prepared = new WeakMap<
    ToolExecutionCommand,
    { binding: Binding; runtime: ToolRuntimePort }
  >();

  constructor(
    catalog: ToolRuntimePort,
    config: DesktopThreadWorkspaceRuntimeConfig,
  ) {
    this.#catalog = catalog;
    this.#config = config;
  }

  definitions() {
    return this.#catalog.definitions();
  }
  executionPolicy(
    kind: ToolCallKind,
    name: string,
    context?: ToolExecutionPolicyContext,
  ) {
    return this.#catalog.executionPolicy(kind, name, context);
  }
  async execute(command: ToolExecutionCommand, signal: AbortSignal) {
    const runtime = await this.#route(command, signal);
    return runtime.execute(command, signal);
  }
  async prepareExecution(command: ToolExecutionCommand, signal: AbortSignal) {
    const runtime = await this.#route(command, signal);
    await runtime.prepareExecution?.(command, signal);
  }
  reserveExecution(
    command: ToolExecutionCommand,
    signal: AbortSignal,
    options?: ToolExecutionReservationOptions,
  ) {
    if (this.#closed) throw new ToolBrokerError("tool_runtime_closed");
    signal.throwIfAborted();
    const prepared = this.#prepared.get(command);
    if (prepared === undefined)
      throw new ToolBrokerError("desktop_workspace_execution_unprepared");
    if (
      readDesktopWorkspaceRoot(
        this.#config.registryPath,
        prepared.binding.workspaceId,
      ) !== prepared.binding.root
    ) {
      throw new ToolBrokerError("desktop_workspace_binding_changed");
    }
    return prepared.runtime.reserveExecution?.(command, signal, options);
  }
  async reconcile(command: ToolExecutionCommand, signal: AbortSignal) {
    const runtime = await this.#route(command, signal);
    return runtime.reconcile(command, signal);
  }
  async cancel(command: ToolExecutionCommand, signal: AbortSignal) {
    const runtime = await this.#route(command, signal);
    return runtime.cancel(command, signal);
  }
  retainedExecutionResults(query: RetainedToolExecutionResultQuery) {
    const results = [];
    for (const runtime of this.#runtimes.values()) {
      if (results.length >= query.limit) break;
      results.push(
        ...(runtime.retainedExecutionResults?.({
          ...query,
          limit: query.limit - results.length,
        }) ?? []),
      );
    }
    return results;
  }
  readRetainedExecutionResult(lookup: RetainedToolExecutionResultLookup) {
    for (const runtime of this.#runtimes.values()) {
      const result = runtime.readRetainedExecutionResult?.(lookup);
      if (result != null) return result;
    }
    return null;
  }
  acknowledgeExecutionResult(value: ToolExecutionResultAcknowledgement) {
    let acknowledged = true;
    for (const runtime of this.#runtimes.values()) {
      if (runtime.acknowledgeExecutionResult?.(value) === false)
        acknowledged = false;
    }
    return acknowledged;
  }
  cancelRetainedExecution(lookup: RetainedToolExecutionResultLookup) {
    for (const runtime of this.#runtimes.values()) {
      const result = runtime.cancelRetainedExecution?.(lookup);
      if (result != null) return result;
    }
    return null;
  }
  scanRetainedExecutionResults(query: RetainedToolExecutionResultScan) {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 128
    ) {
      throw new ToolBrokerError("tool_result_scan_limit_invalid");
    }
    const runtimes = [...this.#runtimes.values()];
    const results: ScopedRetainedToolExecutionResult[] = [];
    for (
      let count = 0;
      count < runtimes.length && results.length < query.limit;
      count++
    ) {
      const runtime = runtimes[(this.#scanCursor + count) % runtimes.length]!;
      results.push(
        ...(runtime.scanRetainedExecutionResults?.({ limit: 1 }) ?? []),
      );
    }
    if (runtimes.length > 0)
      this.#scanCursor = (this.#scanCursor + 1) % runtimes.length;
    return results;
  }
  canRetire() {
    return (
      this.#pending.size === this.#runtimes.size &&
      this.#catalog.canRetire?.() === true &&
      [...this.#runtimes.values()].every(
        (runtime) => runtime.canRetire?.() === true,
      )
    );
  }
  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await Promise.allSettled(this.#pending.values());
      const results = await Promise.allSettled([
        this.#catalog.close?.(),
        ...[...this.#runtimes.values()].map((runtime) => runtime.close?.()),
      ]);
      if (this.#config.store === undefined) await this.#store?.close?.();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.#closing;
  }

  async #route(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolRuntimePort> {
    if (this.#closed) throw new ToolBrokerError("tool_runtime_closed");
    signal.throwIfAborted();
    if (command.runId !== command.actionIntent.runId)
      throw new ToolBrokerError("desktop_workspace_run_mismatch");
    this.#store ??=
      this.#config.store ?? new SqliteRunStore(this.#config.databasePath);
    const binding = await resolveDesktopThreadWorkspace({
      ...this.#config,
      store: this.#store,
      runId: command.runId,
    });
    if (this.#closed) throw new ToolBrokerError("tool_runtime_closed");
    signal.throwIfAborted();
    const previousRoot = this.#roots.get(binding.workspaceId);
    if (previousRoot !== undefined && previousRoot !== binding.root)
      throw new ToolBrokerError("desktop_workspace_binding_changed");
    let pending = this.#pending.get(binding.workspaceId);
    if (pending === undefined) {
      if (this.#pending.size >= 100)
        throw new ToolBrokerError("desktop_workspace_runtime_capacity");
      this.#roots.set(binding.workspaceId, binding.root);
      pending = this.#config
        .createRuntime(binding.root)
        .then((runtime) => {
          this.#runtimes.set(binding.workspaceId, runtime);
          return runtime;
        })
        .catch((error) => {
          this.#pending.delete(binding.workspaceId);
          throw error;
        });
      this.#pending.set(binding.workspaceId, pending);
    }
    const runtime = await pending;
    if (this.#closed) throw new ToolBrokerError("tool_runtime_closed");
    signal.throwIfAborted();
    this.#prepared.set(command, { binding, runtime });
    return runtime;
  }
}
