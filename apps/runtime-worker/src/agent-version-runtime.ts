import { isDeepStrictEqual } from "node:util";
import type { AgentKernelPort } from "@crewon/agent-kernel";
import type { CompiledAgentVersion } from "@crewon/agent-version";
import type {
  ContentDigester,
  RunExecutionPolicyPort,
  ThreadModelState,
} from "@crewon/application";
import type {
  ContextCompactorPort,
  GovernedContextBundle,
} from "@crewon/context";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import {
  RuntimeResourceOwner,
  type RuntimeResourceLease,
} from "./runtime-resource-lease.ts";
import { IdleAgentRuntimeRetirement } from "./idle-agent-runtime-retirement.ts";
import {
  processAgentRuntimeCapacity,
  type AgentRuntimeCapacity,
  type AgentRuntimeReservation,
} from "./agent-runtime-capacity.ts";
import { closeAdmittedAgentRuntime } from "./admitted-agent-runtime-creation.ts";
import type { RuntimeExtensionMaterialization } from "./extensions/extension-runtime-proof.ts";

import type {
  PriorModelCompactionResolverPort,
  PriorModelCompactionRuntime,
} from "./model-switch-compaction.ts";

/** Identifies who owns the Agent prompt, tools, and orchestration loop. */
export type AgentExecutionAuthority = "crewonKernel" | "providerAgent";

export type AgentVersionRuntime = Readonly<{
  version: CompiledAgentVersion;
  executionAuthority: AgentExecutionAuthority;
  kernel: AgentKernelPort;
  policy: RunExecutionPolicyPort;
  toolRuntime: ToolRuntimePort;
  contextCompactor: ContextCompactorPort;
  governedContext?: GovernedContextBundle;
  /** Verified snapshots attached only after successful construction of the actual tool owner. */
  extensions?: readonly RuntimeExtensionMaterialization[];
  /** Opt-in proof for exclusive, reconstructible owners; never inferred from a catalog. */
  canRetire?(): boolean;
  close?(): Promise<void>;
}>;

export type AgentVersionRuntimeLocator = Readonly<{
  tenantId: string;
  agentVersionId: string;
}>;

export type ScopedAgentVersionRuntime = Readonly<{
  tenantId: string | null;
  runtime: AgentVersionRuntime;
  reservation?: AgentRuntimeReservation;
}>;

/** Resolves every runtime dependency from the immutable AgentVersion pinned by a Run. */
export interface AgentVersionRuntimeResolverPort {
  /** Borrowers must release after execution, including late physical prerequisites. */
  acquire?(
    locator: AgentVersionRuntimeLocator,
  ):
    | RuntimeResourceLease<AgentVersionRuntime>
    | null
    | Promise<RuntimeResourceLease<AgentVersionRuntime> | null>;
  acquireResident?(
    locator: AgentVersionRuntimeLocator,
  ): RuntimeResourceLease<AgentVersionRuntime> | null;
  nextToolResultMaintenanceLease?(): RuntimeResourceLease<ToolRuntimePort> | null;
  /** Memory-only lookup: never performs I/O or materializes a new runtime. */
  resolveResident?(
    locator: AgentVersionRuntimeLocator,
  ): AgentVersionRuntime | null;
  /** Rotates already materialized owners; never loads a new model or Tool connection. */
  nextToolResultMaintenanceRuntime?(): ToolRuntimePort | null;
  resolve(
    locator: AgentVersionRuntimeLocator,
  ): AgentVersionRuntime | null | Promise<AgentVersionRuntime | null>;
}

/** Pinned owners plus reconstructible projections of immutable durable AgentVersions. */
export class InMemoryAgentVersionRuntimeRegistry
  implements AgentVersionRuntimeResolverPort
{
  readonly #digester: ContentDigester;
  readonly #runtimes = new Map<string, AgentVersionRuntime>();
  readonly #owners = new Map<
    AgentVersionRuntime,
    RuntimeResourceOwner<AgentVersionRuntime>
  >();
  readonly #runtimeKeys = new WeakMap<AgentVersionRuntime, Set<string>>();
  readonly #reservations = new WeakMap<
    AgentVersionRuntime,
    AgentRuntimeReservation
  >();
  readonly capacity: AgentRuntimeCapacity;
  readonly #retirement: IdleAgentRuntimeRetirement;
  #closed = false;
  #closeTask: Promise<void> | null = null;

  constructor(
    digester: ContentDigester,
    options: { capacity?: AgentRuntimeCapacity } = {},
  ) {
    this.#digester = digester;
    this.capacity = options.capacity ?? processAgentRuntimeCapacity;
    this.#retirement = new IdleAgentRuntimeRetirement({
      unused: (runtime) => this.#owners.get(runtime)?.users === 0,
      retire: (runtime) => this.#retire(runtime),
    });
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  register(
    scoped: ScopedAgentVersionRuntime,
  ): Readonly<{ disposition: "registered" | "existing" }> {
    const result = this.#register(scoped);
    this.#retirement.pin(
      this.#runtimes.get(
        runtimeKey(scoped.tenantId, scoped.runtime.version.agentVersionId),
      )!,
    );
    return result;
  }

  registerReconstructible(
    scoped: ScopedAgentVersionRuntime,
  ): Readonly<{ disposition: "registered" | "existing" }> {
    const alreadyOwned = this.#owners.has(scoped.runtime);
    const result = this.#register(scoped);
    if (alreadyOwned) this.#retirement.pin(scoped.runtime);
    else if (
      result.disposition === "registered" &&
      scoped.runtime.canRetire !== undefined
    )
      this.#retirement.add(scoped.runtime);
    return result;
  }

  #register(
    scoped: ScopedAgentVersionRuntime,
  ): Readonly<{ disposition: "registered" | "existing" }> {
    if (this.#closed) {
      throw new AgentVersionRuntimeError(
        "agent_version_runtime_registry_closed",
      );
    }
    validateTenantScope(scoped.tenantId);
    const { runtime } = scoped;
    validateAgentVersionRuntime(runtime, this.#digester);
    const key = runtimeKey(scoped.tenantId, runtime.version.agentVersionId);
    const existing = this.#runtimes.get(key);
    if (existing !== undefined) {
      if (existing.version.contentDigest !== runtime.version.contentDigest) {
        throw new AgentVersionRuntimeError("agent_version_runtime_id_conflict");
      }
      return { disposition: "existing" };
    }
    const reservation = this.#owners.has(runtime)
      ? this.#reservations.get(runtime)!
      : (scoped.reservation ??
        this.capacity.reserve(
          Buffer.byteLength(JSON.stringify(runtime.version)),
        ));
    this.#runtimes.set(key, Object.freeze(runtime));
    const keys = this.#runtimeKeys.get(runtime) ?? new Set<string>();
    keys.add(key);
    this.#runtimeKeys.set(runtime, keys);
    if (!this.#owners.has(runtime)) {
      this.#reservations.set(runtime, reservation);
      this.#owners.set(
        runtime,
        new RuntimeResourceOwner(runtime, () =>
          closeAdmittedAgentRuntime({ runtime, reservation }),
        ),
      );
      reservation.setReclaimer(() => {
        this.#retirement.retireUnderPressure(runtime);
      });
    } else if (
      scoped.reservation !== undefined &&
      scoped.reservation !== reservation
    ) {
      scoped.reservation.release();
    }
    return { disposition: "registered" };
  }

  resolve(locator: AgentVersionRuntimeLocator): AgentVersionRuntime | null {
    const runtime = this.peekResident(locator);
    if (runtime !== null) this.#retirement.pin(runtime);
    return runtime;
  }

  /** Internal identity lookup; execution callers must acquire a lease or use pinned resolve. */
  peekResident(
    locator: AgentVersionRuntimeLocator,
  ): AgentVersionRuntime | null {
    if (this.#closed) {
      return null;
    }
    validateTenantScope(locator.tenantId);
    return (
      this.#runtimes.get(
        runtimeKey(locator.tenantId, locator.agentVersionId),
      ) ??
      this.#runtimes.get(runtimeKey(null, locator.agentVersionId)) ??
      null
    );
  }

  resolveResident(
    locator: AgentVersionRuntimeLocator,
  ): AgentVersionRuntime | null {
    return this.resolve(locator);
  }

  acquire(
    locator: AgentVersionRuntimeLocator,
  ): RuntimeResourceLease<AgentVersionRuntime> | null {
    const runtime = this.peekResident(locator);
    if (runtime === null) return null;
    this.#retirement.use(runtime);
    this.#reservations.get(runtime)!.touch();
    return this.#lease(runtime);
  }

  acquireResident(
    locator: AgentVersionRuntimeLocator,
  ): RuntimeResourceLease<AgentVersionRuntime> | null {
    return this.acquire(locator);
  }

  resourceSnapshot() {
    return {
      registeredRuntimes: this.#runtimes.size,
      resourceOwners: this.#owners.size,
      activeLeases: [...this.#owners.values()].reduce(
        (count, owner) => count + owner.users,
        0,
      ),
      closed: this.#closed,
    };
  }

  retirementSnapshot() {
    return this.#retirement.snapshot();
  }

  #lease(
    runtime: AgentVersionRuntime,
  ): RuntimeResourceLease<AgentVersionRuntime> | null {
    const lease = this.#owners.get(runtime)!.acquire();
    if (lease === null) return null;
    let released = false;
    return {
      resource: runtime,
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        if (!this.#closed) this.#retirement.sweep();
      },
    };
  }

  #retire(runtime: AgentVersionRuntime): Promise<void> | null {
    if (!this.#reservations.get(runtime)!.beginRetirement()) return null;
    for (const key of this.#runtimeKeys.get(runtime) ?? []) {
      if (this.#runtimes.get(key) === runtime) this.#runtimes.delete(key);
    }
    this.#runtimeKeys.delete(runtime);
    return this.#owners
      .get(runtime)!
      .close()
      .then(() => {
        this.#owners.delete(runtime);
      });
  }

  nextToolResultMaintenanceLease(): RuntimeResourceLease<ToolRuntimePort> | null {
    if (!this.#closed) this.#retirement.sweep();
    const runtime = this.#nextRuntime();
    if (runtime === null) return null;
    const lease = this.#lease(runtime);
    return lease === null
      ? null
      : { resource: runtime.toolRuntime, release: lease.release };
  }

  nextToolResultMaintenanceRuntime(): ToolRuntimePort | null {
    const runtime = this.#nextRuntime();
    if (runtime !== null) this.#retirement.pin(runtime);
    return runtime?.toolRuntime ?? null;
  }

  #nextRuntime(): AgentVersionRuntime | null {
    if (this.#closed) return null;
    const first = this.#runtimes.entries().next().value;
    if (first === undefined) return null;
    const [key, runtime] = first;
    this.#runtimes.delete(key);
    this.#runtimes.set(key, runtime);
    return runtime;
  }

  priorModelCompactionResolver(): PriorModelCompactionResolverPort {
    return new RegistryPriorModelCompactionResolver(this);
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closed = true;
    this.#retirement.clear();
    this.#runtimes.clear();
    this.#closeTask = Promise.allSettled(
      [...this.#owners].map(async ([runtime, owner]) => {
        try {
          await owner.close();
        } finally {
          this.#owners.delete(runtime);
        }
      }),
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          "agent_version_runtime_close_failed",
        );
    });
    return this.#closeTask;
  }
}

export class AgentVersionRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AgentVersionRuntimeError";
    this.code = code;
  }
}

class RegistryPriorModelCompactionResolver
  implements PriorModelCompactionResolverPort
{
  readonly #registry: InMemoryAgentVersionRuntimeRegistry;

  constructor(registry: InMemoryAgentVersionRuntimeRegistry) {
    this.#registry = registry;
  }

  async acquire(
    prior: ThreadModelState,
  ): Promise<RuntimeResourceLease<PriorModelCompactionRuntime> | null> {
    const lease = this.#registry.acquire({
      tenantId: prior.tenantId,
      agentVersionId: prior.agentVersionId,
    });
    if (lease === null) return null;
    const runtime = lease.resource;
    return {
      resource: {
        executionAuthority: runtime.executionAuthority,
        compactor: runtime.contextCompactor,
        ...(runtime.governedContext === undefined
          ? {}
          : { governedContext: runtime.governedContext }),
      },
      release: lease.release,
    };
  }

  async resolve(
    prior: ThreadModelState,
  ): Promise<PriorModelCompactionRuntime | null> {
    const runtime = await this.#registry.resolve({
      tenantId: prior.tenantId,
      agentVersionId: prior.agentVersionId,
    });
    return runtime === null
      ? null
      : {
          executionAuthority: runtime.executionAuthority,
          compactor: runtime.contextCompactor,
          ...(runtime.governedContext === undefined
            ? {}
            : { governedContext: runtime.governedContext }),
        };
  }
}

function runtimeKey(tenantId: string | null, agentVersionId: string): string {
  return JSON.stringify([tenantId, agentVersionId]);
}

function validateTenantScope(tenantId: string | null): void {
  if (
    tenantId !== null &&
    (typeof tenantId !== "string" ||
      tenantId.trim().length === 0 ||
      tenantId.length > 256)
  ) {
    throw new AgentVersionRuntimeError("agent_version_runtime_tenant_invalid");
  }
}

export function validateAgentVersionRuntime(
  runtime: AgentVersionRuntime,
  digester: ContentDigester,
): void {
  if (
    runtime.executionAuthority !== "crewonKernel" &&
    runtime.executionAuthority !== "providerAgent"
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_execution_authority_invalid",
    );
  }
  if (
    runtime.executionAuthority === "providerAgent" &&
    (runtime.version.instructions !== null ||
      runtime.version.tools.length !== 0 ||
      runtime.version.resources.governedContextDigest !== null ||
      runtime.version.resources.workspaceRequired ||
      runtime.governedContext !== undefined)
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_provider_authority_mismatch",
    );
  }
  const identity = runtime.kernel.modelIdentity;
  if (
    identity.adapterName !== runtime.version.model.adapterName ||
    identity.adapterVersion !== runtime.version.model.adapterVersion ||
    identity.modelId !== runtime.version.model.modelId ||
    runtime.kernel.maxOutputTokens !== runtime.version.model.maxOutputTokens
  ) {
    throw new AgentVersionRuntimeError("agent_version_runtime_model_mismatch");
  }
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(runtime.toolRuntime.definitions())),
      runtime.version.tools,
    )
  ) {
    throw new AgentVersionRuntimeError("agent_version_runtime_tools_mismatch");
  }
  const governedContextDigest =
    runtime.governedContext === undefined
      ? null
      : digester.sha256(JSON.stringify(runtime.governedContext.modelItems()));
  if (
    governedContextDigest !== runtime.version.resources.governedContextDigest
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_runtime_context_mismatch",
    );
  }
}
