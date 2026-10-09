import {
  captureInstalledPluginDelegatedIdentityInput,
  type InstalledPluginDelegatedIdentityInput,
  type InstalledPluginDelegatedIdentityPort,
} from "./installed-plugin-delegated-identity.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  type ActorContext,
  type ExtensionCatalogPort,
  type ExtensionHostPort,
  type PluginInstallationHostProfilePort,
  type PluginQueryHostPort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import type {
  InstalledPluginPeerClient,
  InstalledPluginPeerPrepared,
} from "./installed-plugin-peer-client.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requestContext } from "./request-context.ts";
import type {
  InstalledPluginConfigurationMetadataPort,
  InstalledPluginMetadataPrepared,
} from "./installed-plugin-configuration-metadata.ts";

const serviceOwners = new WeakMap<
  object,
  Readonly<{
    owner: InstalledPluginRequestOwner;
    preparation: "execution" | "configuration";
  }>
>();
const owners = new WeakSet<object>();

type State = {
  source:
    | Readonly<{ kind: "http"; request: ControlApiRequestContext }>
    | Readonly<{
        kind: "delegated";
        input: InstalledPluginDelegatedIdentityInput;
      }>;
  actor: ActorContext;
  scope: PluginProfileScope | null;
  prepared: InstalledPluginPeerPrepared | null;
  preparedPurpose: "activation" | "task" | null;
  metadata: InstalledPluginMetadataPrepared | null;
  preparation: "execution" | "configuration";
  controller: AbortController;
  signal: AbortSignal;
  alive: boolean;
};

/** Private request evidence never enters the SDK, a task body, a global actor map, or a token cache. */
export class InstalledPluginRequestOwner {
  readonly catalog: ExtensionCatalogPort;
  readonly host: ExtensionHostPort;
  readonly pluginQueryHost: PluginQueryHostPort;
  readonly #storage = new AsyncLocalStorage<State>();
  readonly #states = new Set<State>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #lifetime = new AbortController();
  readonly #identity: ProductionControlApiIdentity["resolveCurrentActor"];
  readonly #profile: PluginInstallationHostProfilePort["resolve"];
  readonly #prepare: InstalledPluginPeerClient["prepare"] | undefined;
  readonly #prepareTask: InstalledPluginPeerClient["prepare"] | undefined;
  readonly #metadata:
    | InstalledPluginConfigurationMetadataPort["prepare"]
    | undefined;
  readonly #delegatedIdentity:
    | InstalledPluginDelegatedIdentityPort["resolveCurrentActor"]
    | undefined;
  #closing: Promise<void> | null = null;

  constructor(
    input: Readonly<{
      identity: Pick<ProductionControlApiIdentity, "resolveCurrentActor">;
      profiles: PluginInstallationHostProfilePort;
      peer?: Pick<InstalledPluginPeerClient, "prepare">;
      taskPeer?: Pick<InstalledPluginPeerClient, "prepare">;
      metadata?: InstalledPluginConfigurationMetadataPort;
      delegatedIdentity?: InstalledPluginDelegatedIdentityPort;
    }>,
  ) {
    owners.add(this);
    this.#identity = input.identity.resolveCurrentActor.bind(input.identity);
    this.#delegatedIdentity = input.delegatedIdentity?.resolveCurrentActor.bind(
      input.delegatedIdentity,
    );
    this.#profile = input.profiles.resolve.bind(input.profiles);
    this.#prepare = input.peer?.prepare.bind(input.peer);
    this.#prepareTask =
      input.taskPeer?.prepare.bind(input.taskPeer) ?? this.#prepare;
    this.#metadata = input.metadata?.prepare.bind(input.metadata);
    this.catalog = Object.freeze({
      prepare: async (
        value: Parameters<NonNullable<ExtensionCatalogPort["prepare"]>>[0],
      ) => {
        const state = this.#current();
        if (!same(pluginSecurityActor(value.actor), state.actor)) denied();
        if (state.preparation === "execution") return;
        if (this.#metadata === undefined) denied();
        await this.assertCurrent();
        const prepared = await this.#metadata(
          { actor: state.actor, scope: state.scope!, request: value.request },
          { signal: state.signal },
        );
        this.#sameState(state);
        await this.assertCurrent();
        state.metadata = prepared;
      },
      list: () => this.#catalogPrepared().catalog.list(),
      resolve: (identity: Parameters<ExtensionCatalogPort["resolve"]>[0]) =>
        this.#catalogPrepared().catalog.resolve(identity),
    });
    this.host = Object.freeze({
      taskAdmissionMode: (
        input: Parameters<
          NonNullable<ExtensionHostPort["taskAdmissionMode"]>
        >[0],
      ) => {
        const prepared = this.#catalogPrepared();
        if (prepared.host.taskAdmissionMode?.(input) !== "installed") denied();
        return "installed" as const;
      },
      validateConfiguration: (
        input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
      ) =>
        this.#configurationCall(input.actor, (prepared) =>
          prepared.host.validateConfiguration(input),
        ),
      evaluate: (input: Parameters<ExtensionHostPort["evaluate"]>[0]) =>
        this.#configurationCall(input.actor, async () => {
          const prepared = await this.#executionPrepared(
            this.#current().preparation === "execution" ? "task" : "activation",
          );
          return prepared === null
            ? {
                outcome: "unavailable" as const,
                reasonCode: "extension_runtime_unavailable" as const,
              }
            : prepared.host.evaluate(input);
        }),
    });
    this.pluginQueryHost = Object.freeze({
      resolveRegistration: (
        input: Parameters<PluginQueryHostPort["resolveRegistration"]>[0],
      ) =>
        this.#call(input.actor, (prepared) =>
          prepared.pluginQueryHost.resolveRegistration(input),
        ),
      evaluate: (input: Parameters<PluginQueryHostPort["evaluate"]>[0]) =>
        this.#call(input.actor, (prepared) =>
          prepared.pluginQueryHost.evaluate(input),
        ),
    });
  }

  run<T>(
    input: Readonly<{
      request: ControlApiRequestContext;
      actor: ActorContext;
      signal?: AbortSignal;
      preparation?: "configuration";
    }>,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.#run(
      { kind: "http", request: captureRequest(input.request) },
      pluginSecurityActor(input.actor),
      input.signal,
      input.preparation ?? "execution",
      work,
    );
  }

  supportsDelegatedIdentity(): boolean {
    return this.#delegatedIdentity !== undefined;
  }

  runDelegated<T>(
    input: InstalledPluginDelegatedIdentityInput &
      Readonly<{ signal?: AbortSignal }>,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.#delegatedIdentity === undefined)
      throw new ApplicationError(
        "authorization",
        "project_text_plan_authorization_unavailable",
      );
    const fields = pluginSecurityRecord(input, [
      "actor",
      "scope",
      "installation",
      "delegation",
      ...(Object.hasOwn(input, "signal") ? ["signal"] : []),
    ]);
    const captured = captureInstalledPluginDelegatedIdentityInput({
      actor: fields.actor,
      scope: fields.scope,
      installation: fields.installation,
      delegation: fields.delegation,
    });
    return this.#run(
      { kind: "delegated", input: captured },
      captured.actor,
      input.signal,
      "configuration",
      work,
    );
  }

  #run<T>(
    source: State["source"],
    actor: ActorContext,
    signal: AbortSignal | undefined,
    preparation: State["preparation"],
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.#lifetime.signal.aborted || this.#states.size >= 128) denied();
    const controller = new AbortController();
    const state: State = {
      source,
      actor,
      scope: null,
      prepared: null,
      preparedPurpose: null,
      metadata: null,
      preparation,
      controller,
      signal: AbortSignal.any([
        controller.signal,
        this.#lifetime.signal,
        ...(signal ? [signal] : []),
      ]),
      alive: true,
    };
    state.signal.throwIfAborted();
    this.#states.add(state);
    const physical = Promise.resolve().then(() =>
      this.#storage.run(state, async () => {
        try {
          await this.assertCurrent();
          if (state.preparation === "execution") {
            if (this.#prepareTask === undefined) denied();
            state.prepared = await this.#prepareTask(
              { actor: state.actor, scope: state.scope! },
              { signal: state.signal },
            );
            state.preparedPurpose = "task";
          }
          await this.assertCurrent();
          // A committed original receipt may return after withdrawal. Admission and plain JSON
          // still perform their own current-authority checks inside the Application.
          return await work();
        } finally {
          state.alive = false;
          controller.abort();
          this.#states.delete(state);
        }
      }),
    );
    this.#pending.add(physical);
    void physical.then(
      () => this.#pending.delete(physical),
      () => this.#pending.delete(physical),
    );
    return physical;
  }

  async prepareDelegatedExecution(): Promise<void> {
    const state = this.#current();
    if (state.source.kind !== "delegated") denied();
    const prepared = await this.#executionPrepared("task");
    if (prepared === null) denied();
    this.#sameState(state);
    await this.assertCurrent();
    state.preparation = "execution";
  }

  currentSignal(): AbortSignal {
    return this.#current().signal;
  }
  currentActor(): ActorContext {
    return this.#current().actor;
  }

  currentScope(): PluginProfileScope {
    const scope = this.#current().scope;
    if (scope === null) denied();
    return parsePluginProfileScope(scope);
  }

  async resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal: AbortSignal,
  ): Promise<ActorContext | null> {
    const state = this.#current();
    const value = pluginSecurityRecord(owner, [
      "tenantId",
      "spaceId",
      "actorId",
    ]);
    if (
      value.tenantId !== state.actor.tenantId ||
      value.spaceId !== state.actor.spaceId ||
      value.actorId !== state.actor.actorId
    )
      denied();
    signal.throwIfAborted();
    await this.assertCurrent();
    signal.throwIfAborted();
    return state.actor;
  }

  async assertCurrent(): Promise<void> {
    const state = this.#current();
    let actor: ActorContext;
    try {
      actor = pluginSecurityActor(
        await (state.source.kind === "http"
          ? this.#identity(state.source.request, state.signal)
          : this.#delegatedIdentity!(state.source.input, state.signal)),
      );
    } catch {
      denied();
    }
    this.#sameState(state);
    if (!same(actor, state.actor)) denied();
    const scope = parsePluginProfileScope(await this.#profile(actor));
    this.#sameState(state);
    if (
      scope.tenantId !== actor.tenantId ||
      scope.spaceId !== actor.spaceId ||
      (state.scope !== null && !same(scope, state.scope))
    )
      denied();
    if (
      state.source.kind === "delegated" &&
      !same(scope, state.source.input.scope)
    )
      denied();
    state.scope = scope;
  }

  close(): Promise<void> {
    this.#lifetime.abort();
    for (const state of this.#states) {
      state.alive = false;
      state.controller.abort();
    }
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => {},
    ));
  }
  #current(): State {
    const state = this.#storage.getStore();
    if (
      !state ||
      !state.alive ||
      !this.#states.has(state) ||
      this.#lifetime.signal.aborted
    )
      denied();
    state.signal.throwIfAborted();
    return state;
  }
  #sameState(state: State): void {
    if (this.#current() !== state) denied();
  }
  #prepared(): InstalledPluginPeerPrepared {
    const prepared = this.#current().prepared;
    if (prepared === null) denied();
    return prepared;
  }
  #catalogPrepared(): InstalledPluginMetadataPrepared {
    const state = this.#current();
    if (state.preparation === "execution") return this.#prepared();
    if (state.metadata === null) denied();
    return state.metadata;
  }
  async #executionPrepared(
    purpose: "activation" | "task",
  ): Promise<InstalledPluginPeerPrepared | null> {
    const state = this.#current();
    if (state.prepared !== null && state.preparedPurpose === purpose)
      return state.prepared;
    const prepare = purpose === "task" ? this.#prepareTask : this.#prepare;
    if (prepare === undefined) return null;
    const prepared = await prepare(
      { actor: state.actor, scope: state.scope! },
      { signal: state.signal },
    );
    this.#sameState(state);
    await this.assertCurrent();
    state.prepared = prepared;
    state.preparedPurpose = purpose;
    return prepared;
  }
  async #call<T>(
    actor: ActorContext,
    work: (prepared: InstalledPluginPeerPrepared) => Promise<T>,
  ): Promise<T> {
    return this.#authorizedCall(actor, () => work(this.#prepared()));
  }
  async #configurationCall<T>(
    actor: ActorContext,
    work: (prepared: InstalledPluginMetadataPrepared) => Promise<T>,
  ): Promise<T> {
    return this.#authorizedCall(actor, () => work(this.#catalogPrepared()));
  }
  async #authorizedCall<T>(
    actor: ActorContext,
    work: () => Promise<T>,
  ): Promise<T> {
    const state = this.#current();
    if (!same(pluginSecurityActor(actor), state.actor)) denied();
    await this.assertCurrent();
    const result = await work();
    this.#sameState(state);
    await this.assertCurrent();
    return result;
  }
}

/** Only this module's issued request owners carry the actual private HTTP scope. */
export function isInstalledPluginRequestOwner(
  input: unknown,
): input is InstalledPluginRequestOwner {
  return input !== null && typeof input === "object" && owners.has(input);
}

/** Only actual host-created Application instances acquire this private HTTP scope. */
export function bindInstalledPluginRequestOwner<
  T extends
    | ExtensionConfigurationApplicationService
    | ExtensionTaskApplicationService
    | ExtensionReadApplicationService,
>(
  service: T,
  owner: InstalledPluginRequestOwner,
  options?: Readonly<{ preparation: "configuration" }>,
): T {
  if (
    (!(service instanceof ExtensionConfigurationApplicationService) &&
      !(service instanceof ExtensionTaskApplicationService) &&
      !(service instanceof ExtensionReadApplicationService)) ||
    !owners.has(owner) ||
    serviceOwners.has(service)
  )
    denied();
  serviceOwners.set(
    service,
    Object.freeze({ owner, preparation: options?.preparation ?? "execution" }),
  );
  return service;
}

/** Capture only the actual reader's configuration scope; no task owner or execution preparation is transferred. */
export function captureInstalledPluginReadRequestScope(
  service: ExtensionReadApplicationService,
): InstalledPluginReadRequestScope {
  const binding = serviceOwners.get(service);
  if (
    !(service instanceof ExtensionReadApplicationService) ||
    binding?.preparation !== "configuration"
  )
    denied();
  const { owner } = binding;
  const run = owner.run.bind(owner);
  return Object.freeze({
    run: <T>(
      input: Parameters<InstalledPluginReadRequestScope["run"]>[0],
      work: () => Promise<T>,
    ) => {
      if (input === null || typeof input !== "object" || Array.isArray(input))
        denied();
      const keys = Reflect.ownKeys(input);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            !["request", "actor", "signal", "preparation"].includes(key),
        )
      )
        denied();
      const fields = pluginSecurityRecord(input, keys as string[]);
      if (
        !Object.hasOwn(fields, "request") ||
        !Object.hasOwn(fields, "actor") ||
        (fields.preparation !== undefined &&
          fields.preparation !== "configuration")
      )
        denied();
      return run(
        {
          request: fields.request as ControlApiRequestContext,
          actor: fields.actor as ActorContext,
          ...(fields.signal === undefined
            ? {}
            : { signal: fields.signal as AbortSignal }),
          preparation: "configuration",
        },
        work,
      );
    },
    assertCurrent: owner.assertCurrent.bind(owner),
    currentActor: owner.currentActor.bind(owner),
    currentScope: owner.currentScope.bind(owner),
  });
}

export type InstalledPluginReadRequestScope = Readonly<
  Pick<
    InstalledPluginRequestOwner,
    "assertCurrent" | "currentActor" | "currentScope"
  > & {
    run<T>(
      input: Readonly<{
        request: ControlApiRequestContext;
        actor: ActorContext;
        signal?: AbortSignal;
        preparation?: "configuration";
      }>,
      work: () => Promise<T>,
    ): Promise<T>;
  }
>;

/** Optional original HTTP reader fence; legacy unbound readers retain their original local identity path. */
export function captureInstalledPluginHttpReadCommitAuthority(
  service: ExtensionReadApplicationService,
):
  | Readonly<{ assertCurrent(): Promise<void>; assertActive(): void }>
  | undefined {
  if (!(service instanceof ExtensionReadApplicationService)) denied();
  const binding = serviceOwners.get(service);
  if (binding === undefined) return undefined;
  if (binding.preparation !== "configuration") denied();
  const current = binding.owner.assertCurrent.bind(binding.owner);
  const signal = binding.owner.currentSignal.bind(binding.owner);
  return Object.freeze({
    assertCurrent: current,
    assertActive: () => {
      signal().throwIfAborted();
    },
  });
}

/** Unbound legacy instances take precisely their original path, without peer/profile/token reads. */
export async function withInstalledPluginHttpRequest<T>(
  service: object,
  request: FastifyRequest,
  reply: FastifyReply,
  actor: ActorContext,
  work: () => Promise<T>,
): Promise<T> {
  const binding = serviceOwners.get(service);
  if (binding === undefined) return work();
  const { owner } = binding;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", closed);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    return await owner.run(
      {
        request: requestContext(request),
        actor,
        signal: controller.signal,
        ...(binding.preparation === "configuration"
          ? { preparation: "configuration" as const }
          : {}),
      },
      async () => {
        const result = await work();
        // A read is not a durable mutation acknowledgement. Never return it after the
        // authenticated token/profile changed while its storage await was in flight.
        if (request.method === "GET") await owner.assertCurrent();
        return result;
      },
    );
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", closed);
  }
}

function captureRequest(
  input: ControlApiRequestContext,
): ControlApiRequestContext {
  const value = pluginSecurityRecord(input, [
    "method",
    "url",
    "remoteAddress",
    "headers",
  ]);
  if (
    typeof value.method !== "string" ||
    value.method.length > 32 ||
    typeof value.url !== "string" ||
    value.url.length > 8192 ||
    typeof value.remoteAddress !== "string" ||
    value.remoteAddress.length > 512 ||
    value.headers === null ||
    typeof value.headers !== "object"
  )
    denied();
  const fields = Reflect.ownKeys(value.headers);
  if (fields.length > 128 || fields.some((field) => typeof field !== "string"))
    denied();
  const headers = Object.create(null) as Record<
    string,
    string | string[] | undefined
  >;
  let bytes = 0;
  for (const field of fields as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value.headers, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    const item: unknown = descriptor.value;
    if (item === undefined) headers[field] = undefined;
    else if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      headers[field] = item;
    } else if (
      Array.isArray(item) &&
      Object.getPrototypeOf(item) === Array.prototype &&
      item.length <= 16 &&
      Reflect.ownKeys(item).length === item.length + 1
    ) {
      const copy: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const cell = Object.getOwnPropertyDescriptor(item, String(i));
        if (
          !cell?.enumerable ||
          !("value" in cell) ||
          typeof cell.value !== "string"
        )
          denied();
        bytes += Buffer.byteLength(cell.value);
        copy.push(cell.value);
      }
      headers[field] = Object.freeze(copy) as unknown as string[];
    } else denied();
    bytes += Buffer.byteLength(field);
    if (bytes > 64 * 1024) denied();
  }
  return Object.freeze({
    method: value.method,
    url: value.url,
    remoteAddress: value.remoteAddress,
    headers: Object.freeze(headers),
  });
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "installed_plugin_request_authority_unavailable",
  );
}
