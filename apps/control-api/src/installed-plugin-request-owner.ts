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
  request: ControlApiRequestContext;
  actor: ActorContext;
  scope: PluginProfileScope | null;
  prepared: InstalledPluginPeerPrepared | null;
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
  readonly #metadata:
    | InstalledPluginConfigurationMetadataPort["prepare"]
    | undefined;
  #closing: Promise<void> | null = null;

  constructor(
    input: Readonly<{
      identity: Pick<ProductionControlApiIdentity, "resolveCurrentActor">;
      profiles: PluginInstallationHostProfilePort;
      peer?: Pick<InstalledPluginPeerClient, "prepare">;
      metadata?: InstalledPluginConfigurationMetadataPort;
    }>,
  ) {
    owners.add(this);
    this.#identity = input.identity.resolveCurrentActor.bind(input.identity);
    this.#profile = input.profiles.resolve.bind(input.profiles);
    this.#prepare = input.peer?.prepare.bind(input.peer);
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
          const prepared = await this.#executionPrepared();
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
    if (this.#lifetime.signal.aborted || this.#states.size >= 128) denied();
    const controller = new AbortController();
    const state: State = {
      request: captureRequest(input.request),
      actor: pluginSecurityActor(input.actor),
      scope: null,
      prepared: null,
      metadata: null,
      preparation: input.preparation ?? "execution",
      controller,
      signal: AbortSignal.any([
        controller.signal,
        this.#lifetime.signal,
        ...(input.signal ? [input.signal] : []),
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
            if (this.#prepare === undefined) denied();
            state.prepared = await this.#prepare(
              { actor: state.actor, scope: state.scope! },
              { signal: state.signal },
            );
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

  currentSignal(): AbortSignal {
    return this.#current().signal;
  }
  currentActor(): ActorContext {
    return this.#current().actor;
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
        await this.#identity(state.request, state.signal),
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
  async #executionPrepared(): Promise<InstalledPluginPeerPrepared | null> {
    const state = this.#current();
    if (state.prepared !== null) return state.prepared;
    if (this.#prepare === undefined) return null;
    const prepared = await this.#prepare(
      { actor: state.actor, scope: state.scope! },
      { signal: state.signal },
    );
    this.#sameState(state);
    await this.assertCurrent();
    state.prepared = prepared;
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
