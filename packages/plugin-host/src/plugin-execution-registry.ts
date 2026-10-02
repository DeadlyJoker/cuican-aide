import {
  CREWON_EXECUTION_API_VERSION,
  CREWON_EXECUTION_SERVICE,
  type PluginDisposable,
  type PluginExecutionService,
  type PluginIdentity,
  type PluginToolRuntimeFactory,
} from "@crewon/plugin-sdk/node";
import type {
  PluginHostService,
  PluginHostServiceLifetime,
} from "./plugin-host-service.ts";
import type { PluginNodeLease } from "./plugin-node-host.ts";
import { pluginNodeLeaseIdentity } from "./plugin-node-lease-authority.ts";

export class PluginExecutionRegistryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PluginExecutionRegistryError";
    this.code = code;
  }
}

type Binding = {
  identity: PluginIdentity;
  registered: boolean;
  closed: boolean;
  factory: PluginToolRuntimeFactory | null;
};

/**
 * Same-process factory registration only. A live Node borrow is required; Run/configuration,
 * current authorization and the returned ToolRuntime lifecycle remain the Worker's responsibility.
 */
export class PluginExecutionRegistry {
  readonly #byIdentity = new WeakMap<object, Binding>();
  readonly #bindings = new Set<Binding>();
  readonly #maximum: number;
  #closed = false;

  constructor(input: Readonly<{ maximumFactories?: number }> = {}) {
    const maximum = input.maximumFactories ?? 128;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024)
      fail("plugin_execution_limit_invalid");
    this.#maximum = maximum;
  }

  hostService(): PluginHostService {
    const unavailable: PluginExecutionService = Object.freeze({
      register: () => fail("plugin_execution_unbound"),
    });
    return Object.freeze({
      service: CREWON_EXECUTION_SERVICE,
      apiVersion: CREWON_EXECUTION_API_VERSION,
      value: unavailable,
      bindForPlugin: (
        identity: PluginIdentity,
        lifetime: PluginHostServiceLifetime,
      ) => this.#bind(identity, lifetime),
    });
  }

  /** The returned factory does not acquire ownership; its caller must retain this actual lease. */
  acquire(lease: PluginNodeLease): PluginToolRuntimeFactory {
    const identity = pluginNodeLeaseIdentity(lease);
    const binding = this.#byIdentity.get(identity);
    this.#available(binding);
    const factory = binding!.factory!;
    return Object.freeze({
      create: (
        context: Parameters<PluginToolRuntimeFactory["create"]>[0],
        services?: Parameters<PluginToolRuntimeFactory["create"]>[1],
      ) => {
        const current = pluginNodeLeaseIdentity(lease);
        this.#available(binding);
        if (current !== binding!.identity)
          fail("plugin_execution_identity_mismatch");
        if (context === null || typeof context !== "object")
          fail("plugin_execution_identity_mismatch");
        const supplied = Object.getOwnPropertyDescriptor(context, "identity");
        if (
          !supplied?.enumerable ||
          !("value" in supplied) ||
          !matchesIdentity(supplied.value, current)
        )
          fail("plugin_execution_identity_mismatch");
        // Creation that has already started belongs to the caller's NodeLease and ToolRuntime owner.
        return factory.create(context, services);
      },
    });
  }

  /** Revokes registration and future creation; never closes a caller-owned ToolRuntime. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const binding of [...this.#bindings]) this.#dispose(binding);
  }

  #bind(
    identity: PluginIdentity,
    lifetime: PluginHostServiceLifetime,
  ): PluginExecutionService {
    if (this.#closed) fail("plugin_execution_registry_closed");
    if (this.#byIdentity.has(identity))
      fail("plugin_execution_binding_conflict");
    if (this.#bindings.size >= this.#maximum)
      fail("plugin_execution_capacity_exceeded");
    const binding: Binding = {
      identity,
      registered: false,
      closed: false,
      factory: null,
    };
    // Binding itself must happen during actual setup, and host cleanup is mandatory even if a
    // plugin forgets to retain or register the disposable returned by register().
    lifetime.onDispose(() => this.#dispose(binding));
    this.#bindings.add(binding);
    this.#byIdentity.set(identity, binding);
    return Object.freeze({
      register: (input: PluginToolRuntimeFactory): PluginDisposable => {
        if (this.#closed) fail("plugin_execution_registry_closed");
        if (binding.closed) fail("plugin_execution_registration_closed");
        if (binding.registered) fail("plugin_execution_factory_conflict");
        const factory = captureFactory(input);
        // Recheck the real setup window on registration, not only when the service was retrieved.
        lifetime.onDispose(() => this.#dispose(binding));
        binding.factory = factory;
        binding.registered = true;
        return Object.freeze({ dispose: () => this.#dispose(binding) });
      },
    });
  }

  #available(binding: Binding | undefined): void {
    if (this.#closed) fail("plugin_execution_registry_closed");
    if (binding === undefined || binding.closed || binding.factory === null)
      fail("plugin_execution_factory_unavailable");
  }

  #dispose(binding: Binding): void {
    if (binding.closed) return;
    binding.closed = true;
    binding.factory = null;
    this.#byIdentity.delete(binding.identity);
    this.#bindings.delete(binding);
  }
}

function captureFactory(
  input: PluginToolRuntimeFactory,
): PluginToolRuntimeFactory {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_execution_factory_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 1 ||
    keys[0] !== "create"
  )
    fail("plugin_execution_factory_invalid");
  const create = Object.getOwnPropertyDescriptor(input, "create");
  if (
    !create?.enumerable ||
    !("value" in create) ||
    typeof create.value !== "function"
  )
    fail("plugin_execution_factory_invalid");
  return Object.freeze({ create: create.value.bind(input) });
}

function fail(code: string): never {
  throw new PluginExecutionRegistryError(code);
}

/** Context identity is portable metadata; authority comes exclusively from the actual NodeLease. */
function matchesIdentity(input: unknown, expected: PluginIdentity): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const fields = ["pluginId", "version", "packageDigest"] as const;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key as (typeof fields)[number]))
  )
    return false;
  return fields.every((key) => {
    const field = Object.getOwnPropertyDescriptor(input, key);
    return (
      field?.enumerable === true &&
      "value" in field &&
      field.value === expected[key]
    );
  });
}
