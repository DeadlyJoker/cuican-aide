import { isAbsolute, join, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  PluginUiCommittedTaskAuthority,
  assertPluginUiInvocationCurrent,
  type ActorContext,
  type ApplicationClock,
  type PluginInstallationHostProfilePort,
  type PluginInstallationStore,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiAuthorizationPort,
  type PluginUiCommittedTaskPort,
  type PluginUiOpaqueIdPort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import {
  PluginNodeHost,
  PluginTaskActionBridge,
  verifyLocalPluginPackage,
  type PluginActivationCandidate,
  type PluginNodePreparedActivation,
} from "@crewon/plugin-host";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import { DesktopPluginTaskServiceBinding } from "./desktop-plugin-task-service-binding.ts";

export type InstalledPluginTaskActionOwnerDependencies = Readonly<{
  installRoot: string;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  tasks: ExtensionTaskApplicationService;
  committedTasks: PluginUiCommittedTaskAuthority;
  profiles: PluginInstallationHostProfilePort;
  authorization: PluginUiAuthorizationPort;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal: AbortSignal,
  ): Promise<ActorContext | null>;
  authorizePackage(
    input: Readonly<{
      actor: ActorContext;
      scope: PluginProfileScope;
      candidate: PluginActivationCandidate;
      purpose: "read" | "submit";
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  clock: ApplicationClock;
  ids: PluginUiOpaqueIdPort;
  maximumPackages?: number;
  sharedBinding?: DesktopPluginTaskServiceBinding;
}>;
type Request = Readonly<{
  context: PluginUiActionContext;
  actor: ActorContext;
  scope: PluginProfileScope;
  selection: PluginSelection;
  package: InstalledPluginPackage;
}>;
type Entry = {
  request: Request;
  host: PluginNodeHost | null;
  bridge: PluginTaskActionBridge;
  actions: PluginUiActionPort;
  candidate: PluginActivationCandidate | null;
  selection: PluginSelection | null;
  loading: Promise<void>;
  cleanup: Promise<void> | null;
  failed: boolean;
};
const owners = new WeakSet<object>();
const ownerBindings = new WeakMap<
  object,
  Readonly<
    Pick<InstalledPluginTaskActionOwnerDependencies, "tasks" | "committedTasks">
  >
>();

/** Actual resource ownership, independent of the injected policy's decisions. */
export function isInstalledPluginTaskActionOwner(
  input: unknown,
): input is InstalledPluginTaskActionOwner {
  return input !== null && typeof input === "object" && owners.has(input);
}

/** A generation dispatcher must use the task service and receipt issuer owned by this exact owner. */
export function isInstalledPluginTaskActionOwnerBinding(
  input: Readonly<{
    owner: unknown;
    tasks: unknown;
    committedTasks: unknown;
  }>,
): boolean {
  if (!isInstalledPluginTaskActionOwner(input.owner)) return false;
  const binding = ownerBindings.get(input.owner);
  return (
    binding !== undefined &&
    binding.tasks === input.tasks &&
    binding.committedTasks === input.committedTasks
  );
}

/** Trusted same-process actions only. This owner neither creates an actor nor supplies a price. */
export class InstalledPluginTaskActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedTasks: PluginUiCommittedTaskPort;
  readonly #dependencies: InstalledPluginTaskActionOwnerDependencies;
  readonly #lifetime = new AbortController();
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #maximum: number;
  readonly #sharedBinding: DesktopPluginTaskServiceBinding | null;
  readonly #sharedBridge: PluginTaskActionBridge | null;
  readonly #selections = new Map<string, PluginSelection>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(input: InstalledPluginTaskActionOwnerDependencies) {
    if (
      typeof input.installRoot !== "string" ||
      !isAbsolute(input.installRoot) ||
      resolve(input.installRoot) !== input.installRoot ||
      input.installRoot.trim() !== input.installRoot ||
      input.installRoot.length > 4096 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.installRoot) ||
      !(input.tasks instanceof ExtensionTaskApplicationService) ||
      !(input.committedTasks instanceof PluginUiCommittedTaskAuthority)
    )
      fail("installed_plugin_task_action_configuration_invalid");
    const maximum = input.maximumPackages ?? 32;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
      fail("installed_plugin_task_action_configuration_invalid");
    this.#maximum = maximum;
    if (
      input.sharedBinding !== undefined &&
      !DesktopPluginTaskServiceBinding.isOwner(input.sharedBinding)
    )
      fail("installed_plugin_task_action_configuration_invalid");
    this.#sharedBinding = input.sharedBinding ?? null;
    this.#dependencies = Object.freeze({
      installRoot: input.installRoot,
      installations: Object.freeze({
        loadSelection: method(input.installations, "loadSelection"),
        loadPackage: method(input.installations, "loadPackage"),
      }),
      tasks: input.tasks,
      committedTasks: input.committedTasks,
      profiles: Object.freeze({ resolve: method(input.profiles, "resolve") }),
      authorization: Object.freeze({
        authorize: method(input.authorization, "authorize"),
      }),
      resolveActor: method(input, "resolveActor"),
      authorizePackage: method(input, "authorizePackage"),
      clock: Object.freeze({ now: method(input.clock, "now") }),
      ids: Object.freeze({ nextId: method(input.ids, "nextId") }),
      maximumPackages: maximum,
    });
    this.committedTasks = Object.freeze({
      isOutcome: method(input.committedTasks, "isOutcome"),
      verify: method(input.committedTasks, "verify"),
    });
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#run(context),
    });
    this.#sharedBridge =
      this.#sharedBinding === null
        ? null
        : new PluginTaskActionBridge({
            tasks: this.#dependencies.tasks,
            committedTasks: this.#dependencies.committedTasks,
            profiles: {
              resolve: async (actor) => {
                await this.#actor(actor);
                return this.#dependencies.profiles.resolve(actor);
              },
            },
            authorization: {
              authorize: (input) => {
                const entry = this.#entries.get(
                  extensionCanonicalJson([
                    {
                      tenantId: input.resource.tenantId,
                      spaceId: input.resource.spaceId,
                      profileId: input.resource.profileId,
                    },
                    input.resource.pluginId,
                    input.resource.packageDigest,
                  ]),
                );
                if (!entry) deny("installed_plugin_task_action_not_ready");
                return this.#authorizeBridge(input, entry);
              },
            },
            currentSelection: ({ scope, pluginId }) =>
              this.#selections.get(extensionCanonicalJson([scope, pluginId])) ??
              null,
            clock: this.#dependencies.clock,
            ids: this.#dependencies.ids,
          });
    owners.add(this);
    ownerBindings.set(
      this,
      Object.freeze({
        tasks: this.#dependencies.tasks,
        committedTasks: this.#dependencies.committedTasks,
      }),
    );
    Object.freeze(this);
  }

  /** Private Host wiring; a structural owner or another binding cannot obtain this bridge. */
  sharedBridge(
    binding: DesktopPluginTaskServiceBinding,
  ): PluginTaskActionBridge {
    this.#available();
    if (binding !== this.#sharedBinding || this.#sharedBridge === null)
      fail("installed_plugin_task_action_configuration_invalid");
    return this.#sharedBridge;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#lifetime.abort();
    this.#sharedBridge?.close();
    for (const entry of this.#entries.values())
      if (entry.host !== null) entry.bridge.close();
    this.#closing = (async () => {
      // Logical withdrawal does not prove that an already started task or setup has stopped.
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled(
        [...this.#entries].map(([key, entry]) => this.#dispose(key, entry)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "installed_plugin_task_action_cleanup_failed",
        );
    })();
    return this.#closing;
  }

  #available(): void {
    if (this.#closed) fail("installed_plugin_task_action_closed");
    this.#lifetime.signal.throwIfAborted();
  }

  #run(
    context: PluginUiActionContext,
  ): ReturnType<PluginUiActionPort["invoke"]> {
    this.#available();
    if (this.#pending.size >= 128) fail("installed_plugin_task_action_busy");
    const work = this.#invoke(context);
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }

  async #invoke(context: PluginUiActionContext) {
    // Only the actual live Application invocation may enter this owner, never an equivalent DTO.
    await assertPluginUiInvocationCurrent(context);
    this.#available();
    if (this.#sharedBinding !== null) {
      await this.#sharedBinding.whenReady();
      await assertPluginUiInvocationCurrent(context);
      this.#available();
    }
    const value = pluginSecurityRecord(context, [
      "actor",
      "scope",
      "selection",
      "package",
      "lease",
      "authorityEpoch",
      "action",
      "input",
    ]);
    const request: Request = Object.freeze({
      context,
      actor: pluginSecurityActor(value.actor),
      scope: parsePluginProfileScope(value.scope),
      selection: parsePluginSelection(value.selection),
      package: parseInstalledPluginPackage(value.package),
    });
    await this.#check(request, null, null);
    const entry = await this.#entry(request);
    await this.#check(request, entry.candidate, entry);
    const output = await entry.actions.invoke(context);
    // An original paid durable receipt survives withdrawal; a plain result does not.
    if (!this.committedTasks.isOutcome(output)) this.#available();
    return output;
  }

  async #actor(actor: ActorContext): Promise<ActorContext> {
    this.#available();
    const current = await this.#dependencies.resolveActor(
      Object.freeze({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      }),
      this.#lifetime.signal,
    );
    this.#available();
    if (current === null || !same(pluginSecurityActor(current), actor))
      deny("installed_plugin_task_action_identity_changed");
    return actor;
  }

  async #profile(
    actor: ActorContext,
    scope: PluginProfileScope,
  ): Promise<PluginProfileScope> {
    await this.#actor(actor);
    const current = parsePluginProfileScope(
      await this.#dependencies.profiles.resolve(actor),
    );
    this.#available();
    if (
      !same(current, scope) ||
      actor.tenantId !== current.tenantId ||
      actor.spaceId !== current.spaceId
    )
      deny("installed_plugin_task_action_profile_changed");
    return current;
  }

  async #selection(request: Request, entry: Entry | null): Promise<void> {
    await this.#refreshSelection(request, request.selection, entry);
  }

  async #refreshSelection(
    request: Pick<Request, "scope" | "package">,
    expected: PluginSelection | number,
    entry: Entry | null,
  ): Promise<void> {
    try {
      const raw = await this.#dependencies.installations.loadSelection({
        scope: request.scope,
        pluginId: request.package.pluginId,
      });
      this.#available();
      if (raw === null) deny("installed_plugin_task_action_selection_changed");
      const selection = parsePluginSelection(raw);
      if (
        selection.state !== "enabled" ||
        (typeof expected === "number"
          ? selection.revision !== expected
          : !same(selection, expected)) ||
        selection.selectedPackageDigest !== request.package.packageDigest ||
        selection.publisherId !== request.package.publisherId ||
        !sameScope(selection, request.scope)
      )
        deny("installed_plugin_task_action_selection_changed");
      const pkg = await this.#dependencies.installations.loadPackage({
        scope: request.scope,
        packageDigest: request.package.packageDigest,
      });
      this.#available();
      if (
        pkg === null ||
        !same(parseInstalledPluginPackage(pkg), request.package) ||
        !sameScope(request.package, request.scope)
      )
        deny("installed_plugin_task_action_package_changed");
      // The synchronous projection is replaced only with a successful actual storage read.
      if (entry !== null) entry.selection = selection;
      if (entry !== null)
        this.#selections.set(
          extensionCanonicalJson([request.scope, request.package.pluginId]),
          selection,
        );
    } catch (error) {
      // A pending refresh is not revocation. Failed reads do withdraw the last confirmed projection.
      if (entry !== null) entry.selection = null;
      this.#selections.delete(
        extensionCanonicalJson([request.scope, request.package.pluginId]),
      );
      throw error;
    }
  }

  async #package(
    request: Pick<Request, "actor" | "scope" | "package">,
    candidate: PluginActivationCandidate,
  ): Promise<void> {
    if (
      candidate.packageDigest !== request.package.packageDigest ||
      candidate.descriptor.pluginId !== request.package.pluginId ||
      candidate.descriptor.publisherId !== request.package.publisherId ||
      candidate.descriptor.version !== request.package.version
    )
      deny("installed_plugin_task_action_package_changed");
    await this.#verifyCandidate(candidate);
    await this.#profile(request.actor, request.scope);
    if (
      (await this.#dependencies.authorizePackage(
        Object.freeze({
          actor: request.actor,
          scope: request.scope,
          candidate,
          purpose: "submit",
        }),
        this.#lifetime.signal,
      )) !== "allow"
    )
      deny("installed_plugin_task_action_package_denied");
    this.#available();
    await this.#verifyCandidate(candidate);
  }

  async #verifyCandidate(candidate: PluginActivationCandidate): Promise<void> {
    const root = await realpath(this.#dependencies.installRoot);
    const stats = await lstat(root);
    this.#available();
    if (
      !stats.isDirectory() ||
      (stats.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    )
      deny("installed_plugin_task_action_install_root_changed");
    const directory = join(root, "packages", candidate.packageDigest.slice(7));
    const verified = await verifyLocalPluginPackage({
      directory,
      signal: this.#lifetime.signal,
    });
    this.#available();
    if (
      verified.directory !== directory ||
      verified.packageDigest !== candidate.packageDigest ||
      !same(verified.descriptor, candidate.descriptor)
    )
      deny("installed_plugin_task_action_package_changed");
  }

  async #check(
    request: Request,
    candidate: PluginActivationCandidate | null,
    entry: Entry | null,
  ): Promise<void> {
    await this.#profile(request.actor, request.scope);
    await this.#selection(request, entry);
    const decision = await this.#dependencies.authorization.authorize({
      actor: request.actor,
      action: "invoke",
      resource: {
        kind: "pluginUi",
        ...request.scope,
        pluginId: request.package.pluginId,
        packageDigest: request.package.packageDigest,
        selectionRevision: request.selection.revision,
        contributionId: request.context.lease.contributionId,
      },
    });
    this.#available();
    if (
      decision.outcome !== "allow" ||
      decision.authorityEpoch !== request.context.authorityEpoch
    )
      deny("installed_plugin_task_action_authority_changed");
    if (candidate !== null) await this.#package(request, candidate);
    await this.#profile(request.actor, request.scope);
    await this.#selection(request, entry);
    await assertPluginUiInvocationCurrent(request.context);
    this.#available();
    await this.#selection(request, entry);
  }

  async #entry(request: Request): Promise<Entry> {
    this.#available();
    const key = extensionCanonicalJson([
      request.scope,
      request.package.pluginId,
      request.package.packageDigest,
    ]);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      if (this.#entries.size >= this.#maximum)
        fail("installed_plugin_task_action_capacity_exceeded");
      // Every bridge keeps its own exact Node identity and scoped confirmed selection projection.
      let created!: Entry;
      const bridge =
        this.#sharedBridge ??
        new PluginTaskActionBridge({
          tasks: this.#dependencies.tasks,
          committedTasks: this.#dependencies.committedTasks,
          profiles: { resolve: (actor) => this.#profile(actor, request.scope) },
          authorization: {
            authorize: (input) => this.#authorizeBridge(input, created),
          },
          currentSelection: ({ scope, pluginId }) =>
            same(scope, request.scope) && pluginId === request.package.pluginId
              ? created.selection
              : null,
          clock: this.#dependencies.clock,
          ids: this.#dependencies.ids,
        });
      const host =
        this.#sharedBinding === null
          ? new PluginNodeHost({
              services: [bridge.hostService(), bridge.hostServiceV2()],
            })
          : null;
      created = {
        request,
        host,
        bridge,
        actions:
          host === null
            ? bridge.actionsFromBorrower({
                borrow: (context, authorizeBorrow) =>
                  this.#sharedBinding!.borrow(context, authorizeBorrow),
              })
            : bridge.actions(host),
        candidate: null,
        selection: null,
        loading: Promise.resolve(),
        cleanup: null,
        failed: false,
      };
      entry = created;
      this.#entries.set(key, entry);
      entry.loading = this.#load(key, entry);
    }
    if (entry.failed) fail("installed_plugin_task_action_cleanup_failed");
    await entry.loading;
    this.#available();
    return entry;
  }

  async #load(key: string, entry: Entry): Promise<void> {
    let prepared: PluginNodePreparedActivation | null = null;
    try {
      if (entry.host === null) {
        const verified = await verifyLocalPluginPackage({
          directory: join(
            this.#dependencies.installRoot,
            "packages",
            entry.request.package.packageDigest.slice(7),
          ),
          signal: this.#lifetime.signal,
        });
        entry.candidate = Object.freeze({
          descriptor: verified.descriptor,
          packageDigest: verified.packageDigest,
        });
        await this.#check(entry.request, entry.candidate, entry);
        return;
      }
      prepared = await entry.host.prepare({
        installRoot: this.#dependencies.installRoot,
        expectedPluginId: entry.request.package.pluginId,
        expectedPackageDigest: entry.request.package.packageDigest,
        authorizeActivation: async (candidate) => {
          entry.candidate = candidate;
          await this.#check(entry.request, candidate, entry);
          return "allow" as const;
        },
      });
      // setup may await arbitrary trusted Node work; all current authorities must be read again.
      await this.#check(entry.request, entry.candidate, entry);
      const identity = prepared.commit({
        authorizeCommit: (candidate) =>
          !this.#closed &&
          entry.selection !== null &&
          same(entry.selection, entry.request.selection) &&
          candidate.identity.pluginId === entry.request.package.pluginId &&
          candidate.identity.version === entry.request.package.version &&
          candidate.packageDigest === entry.request.package.packageDigest
            ? "allow"
            : "deny",
      });
      const lease = entry.host.acquire({
        pluginId: identity.pluginId,
        packageDigest: identity.packageDigest,
        purpose: "newOperation",
        authorizeBorrow: (borrowed) =>
          borrowed === identity && !this.#closed ? "allow" : "deny",
      });
      try {
        lease.getService(entry.request.package.pluginId, "1");
      } finally {
        lease.release();
      }
    } catch (error) {
      const failures: unknown[] = [];
      try {
        await prepared?.abort();
      } catch (failure) {
        failures.push(failure);
      }
      try {
        await this.#dispose(key, entry);
      } catch (failure) {
        failures.push(failure);
      }
      if (failures.length) {
        entry.failed = true;
        throw new AggregateError(
          [error, ...failures],
          "installed_plugin_task_action_start_failed",
        );
      }
      throw error;
    }
  }

  #dispose(key: string, entry: Entry): Promise<void> {
    if (entry.cleanup !== null) return entry.cleanup;
    if (entry.host !== null) entry.bridge.close();
    entry.cleanup = (entry.host?.close() ?? Promise.resolve()).then(
      () => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      },
      (error) => {
        entry.failed = true;
        throw error;
      },
    );
    return entry.cleanup;
  }

  async #authorizeBridge(
    input: Parameters<PluginUiAuthorizationPort["authorize"]>[0],
    entry: Entry,
  ) {
    const request = entry.request;
    if (
      input.action !== "invoke" ||
      !sameScope(input.resource, request.scope) ||
      input.resource.pluginId !== request.package.pluginId ||
      input.resource.packageDigest !== request.package.packageDigest ||
      input.resource.selectionRevision === null
    )
      deny("installed_plugin_task_action_scope_changed");
    const current = Object.freeze({
      ...request,
      actor: pluginSecurityActor(input.actor),
    });
    await this.#profile(current.actor, request.scope);
    await this.#refreshSelection(
      current,
      input.resource.selectionRevision,
      entry,
    );
    const decision = await this.#dependencies.authorization.authorize(input);
    this.#available();
    if (entry.candidate === null)
      fail("installed_plugin_task_action_not_ready");
    await this.#package(current, entry.candidate);
    await this.#profile(current.actor, request.scope);
    await this.#refreshSelection(
      current,
      input.resource.selectionRevision,
      entry,
    );
    return decision;
  }
}

function same(left: unknown, right: unknown): boolean {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function sameScope(
  left: PluginProfileScope,
  right: PluginProfileScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.spaceId === right.spaceId &&
    left.profileId === right.profileId
  );
}
function method<T extends object, K extends keyof T>(input: T, key: K): T[K] {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input[key] !== "function"
  )
    fail("installed_plugin_task_action_configuration_invalid");
  return (input[key] as (...args: never[]) => unknown).bind(input) as T[K];
}
function fail(code: string): never {
  throw new ApplicationError("conflict", code);
}
function deny(code: string): never {
  throw new ApplicationError("authorization", code);
}
