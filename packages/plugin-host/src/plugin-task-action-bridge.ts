import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
  type PluginProfileScope,
  type PluginSelection,
  type PluginTaskAdmissionPin,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import {
  assertPluginUiInvocationCurrent,
  type ApplicationClock,
  type ExtensionTaskApplicationService,
  type PluginInstallationHostProfilePort,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiAuthorizationPort,
  type PluginUiCommittedTaskAuthority,
  type PluginUiCommittedTaskOutcome,
  type PluginUiJsonValue,
  type PluginUiOpaqueIdPort,
} from "@crewon/application";
import {
  CREWON_TASKS_API_VERSION,
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_V2_API_VERSION,
  type PluginActionsService,
  type PluginIdentity,
  type PluginTaskReceipt,
  type PluginTaskRequest,
  type PluginTaskService,
  type PluginTaskServiceV2,
  type PluginQueryTaskRequest,
} from "@crewon/plugin-sdk/node";
import {
  PluginNodeHost,
  type PluginHostService,
  type PluginNodeLease,
} from "./plugin-node-host.ts";
import { PluginCompositionCoordinator } from "./plugin-composition-coordinator.ts";
import {
  bridgeAction,
  bridgeFailure,
  bridgeFields,
  bridgePin,
  bridgeSameSelection,
  bridgeTaskOutput,
  bridgeTaskRequest,
  bridgeQueryTaskRequest,
} from "./plugin-task-action-bridge-support.ts";

type Dependencies = Readonly<{
  tasks: Pick<ExtensionTaskApplicationService, "createTaskFromPlugin"> &
    Partial<Pick<ExtensionTaskApplicationService, "createQueryTaskFromPlugin">>;
  committedTasks: PluginUiCommittedTaskAuthority;
  profiles: PluginInstallationHostProfilePort;
  authorization: PluginUiAuthorizationPort;
  /** Actual profile owner's synchronous durable projection; ownership is not permission. */
  currentSelection(
    input: Readonly<{ scope: PluginProfileScope; pluginId: string }>,
  ): PluginSelection | null;
  clock: ApplicationClock;
  ids: PluginUiOpaqueIdPort;
}>;
type Invocation = {
  context: PluginUiActionContext;
  pin: PluginTaskAdmissionPin;
  instance: PluginIdentity | null;
  kind: "read" | "generateTask" | "queryTask";
  open: boolean;
  expiresAt: number;
  request: string | null;
  pending: Promise<PluginTaskReceipt> | null;
  committed: PluginUiCommittedTaskOutcome | null;
  assertInstanceCurrent: (() => Promise<void>) | null;
  assertInstanceCurrentSync: (() => void) | null;
};
type ActionLeaseAccess = Readonly<{
  prepareLease(
    invocation: Invocation,
  ): (() => PluginNodeLease) | Promise<() => PluginNodeLease>;
  assertCurrent?(invocation: Invocation): Promise<void>;
}>;

/** Host-only bridge. Plugins receive a per-instance task port and an ephemeral invocation reference. */
export class PluginTaskActionBridge {
  readonly #dependencies: Dependencies;
  readonly #invocations = new Map<string, Invocation>();
  #closed = false;

  static isOwner(input: unknown): input is PluginTaskActionBridge {
    return (
      input !== null && typeof input === "object" && #dependencies in input
    );
  }

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  hostService(): PluginHostService {
    return Object.freeze({
      service: CREWON_TASKS_SERVICE,
      apiVersion: CREWON_TASKS_API_VERSION,
      value: Object.freeze({
        createTask: () => bridgeFailure("plugin_task_port_unbound"),
      }),
      bindForPlugin: (identity: PluginIdentity): PluginTaskService =>
        Object.freeze({
          createTask: (input: PluginTaskRequest) =>
            this.#createTask(identity, input),
        }),
    });
  }

  hostServiceV2(): PluginHostService {
    return Object.freeze({
      service: CREWON_TASKS_SERVICE,
      apiVersion: CREWON_TASKS_V2_API_VERSION,
      value: Object.freeze({
        createTask: () => bridgeFailure("plugin_task_port_unbound"),
        queryTask: () => bridgeFailure("plugin_task_port_unbound"),
      }),
      bindForPlugin: (identity: PluginIdentity): PluginTaskServiceV2 =>
        Object.freeze({
          createTask: (input: PluginTaskRequest) =>
            this.#createTask(identity, input),
          queryTask: (input: PluginQueryTaskRequest) =>
            this.#queryTask(identity, input),
        }),
    });
  }

  actions(nodeHost: PluginNodeHost): PluginUiActionPort {
    const access: ActionLeaseAccess = {
      prepareLease: (invocation) => () =>
        nodeHost.acquire({
          pluginId: invocation.pin.pluginId,
          packageDigest: invocation.pin.packageDigest,
          purpose: "newOperation",
          authorizeBorrow: (identity) =>
            this.#authorizeBorrow(invocation, identity),
        }),
    };
    return Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(access, context),
    });
  }

  /** Host-only borrowing of an existing graph; never creates, activates or repairs an instance. */
  actionsFromComposition(
    input: Readonly<{
      coordinator: PluginCompositionCoordinator;
      /** Fresh owner-validated Node graph digest, without synchronizing or changing selection. */
      currentLock(
        context: PluginUiActionContext,
      ): string | null | Promise<string | null>;
    }>,
  ): PluginUiActionPort {
    const coordinator = input.coordinator;
    if (
      !PluginCompositionCoordinator.isOwner(coordinator) ||
      typeof input.currentLock !== "function"
    )
      bridgeFailure("plugin_action_composition_owner_invalid");
    const currentLock = input.currentLock.bind(input);
    const acquire = PluginCompositionCoordinator.prototype.acquireScopedCurrent;
    const prepareLease = async (
      invocation: Invocation,
    ): Promise<() => PluginNodeLease> => {
      this.#available(invocation);
      const lockDigest = await currentLock(invocation.context);
      this.#available(invocation);
      if (typeof lockDigest !== "string" || lockDigest.length === 0)
        bridgeFailure("plugin_action_composition_unavailable");
      const borrow = () =>
        acquire.call(coordinator, {
          scope: {
            ...invocation.context.scope,
            authorityEpoch: invocation.pin.authorityEpoch,
          },
          lockDigest,
          pluginId: invocation.pin.pluginId,
          authorizeBorrow: (identity) =>
            this.#authorizeBorrow(invocation, identity),
        });
      invocation.assertInstanceCurrentSync = () => {
        const current = borrow();
        try {
          if (
            invocation.instance !== null &&
            current.identity !== invocation.instance
          )
            bridgeFailure("plugin_action_composition_instance_changed");
        } finally {
          current.release();
        }
      };
      return borrow;
    };
    const access: ActionLeaseAccess = {
      prepareLease,
      assertCurrent: async (invocation) => {
        if (invocation.instance === null) return;
        await prepareLease(invocation);
        invocation.assertInstanceCurrentSync?.();
      },
    };
    return Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(access, context),
    });
  }

  close(): void {
    this.#closed = true;
    for (const invocation of this.#invocations.values())
      invocation.open = false;
    this.#invocations.clear();
  }

  #available(invocation: Invocation): void {
    if (this.#closed || !invocation.open || this.#now() >= invocation.expiresAt)
      bridgeFailure("plugin_invocation_unavailable");
  }

  #now(): number {
    const now = Date.parse(this.#dependencies.clock.now());
    if (!Number.isFinite(now)) bridgeFailure("plugin_invocation_clock_invalid");
    return now;
  }

  #selected(invocation: Invocation): boolean {
    return bridgeSameSelection(
      this.#dependencies.currentSelection({
        scope: invocation.context.scope,
        pluginId: invocation.pin.pluginId,
      }),
      invocation.pin,
    );
  }

  #authorizeBorrow(
    invocation: Invocation,
    identity: PluginIdentity,
  ): "allow" | "deny" {
    this.#available(invocation);
    return identity.pluginId === invocation.pin.pluginId &&
      identity.version === invocation.pin.version &&
      identity.packageDigest === invocation.pin.packageDigest &&
      this.#selected(invocation)
      ? "allow"
      : "deny";
  }

  #assertCurrentSync(invocation: Invocation): void {
    this.#available(invocation);
    if (!this.#selected(invocation))
      bridgeFailure("plugin_invocation_authority_changed");
    invocation.assertInstanceCurrentSync?.();
  }

  async #assertCurrent(invocation: Invocation): Promise<void> {
    this.#available(invocation);
    const { context, pin } = invocation;
    const scope = parsePluginProfileScope(
      await this.#dependencies.profiles.resolve(context.actor),
    );
    this.#available(invocation);
    if (extensionCanonicalJson(scope) !== extensionCanonicalJson(context.scope))
      bridgeFailure("plugin_invocation_scope_changed");
    const decision = await this.#dependencies.authorization.authorize({
      actor: context.actor,
      action: "invoke",
      resource: {
        kind: "pluginUi",
        ...scope,
        pluginId: pin.pluginId,
        packageDigest: pin.packageDigest,
        selectionRevision: pin.selectionRevision,
        contributionId: pin.contributionId,
      },
    });
    this.#available(invocation);
    if (
      decision.outcome !== "allow" ||
      decision.authorityEpoch !== pin.authorityEpoch ||
      !this.#selected(invocation)
    )
      bridgeFailure("plugin_invocation_authority_changed");
    await assertPluginUiInvocationCurrent(context);
    this.#available(invocation);
    if (invocation.assertInstanceCurrent !== null) {
      await invocation.assertInstanceCurrent();
      this.#available(invocation);
    }
    if (!this.#selected(invocation))
      bridgeFailure("plugin_invocation_authority_changed");
  }

  async #createTask(
    identity: PluginIdentity,
    raw: unknown,
  ): Promise<PluginTaskReceipt> {
    const input = bridgeTaskRequest(raw);
    return this.#task(identity, input, false);
  }
  async #queryTask(
    identity: PluginIdentity,
    raw: unknown,
  ): Promise<PluginTaskReceipt> {
    return this.#task(identity, bridgeQueryTaskRequest(raw), true);
  }
  async #task(
    identity: PluginIdentity,
    input:
      | ReturnType<typeof bridgeTaskRequest>
      | ReturnType<typeof bridgeQueryTaskRequest>,
    query: boolean,
  ): Promise<PluginTaskReceipt> {
    const invocation = this.#invocations.get(input.invocationRef);
    if (
      !invocation ||
      invocation.instance !== identity ||
      invocation.kind !== (query ? "queryTask" : "generateTask")
    )
      bridgeFailure("plugin_invocation_owner_mismatch");
    const command = Object.freeze({
      pluginId: invocation.pin.pluginId,
      threadId: input.threadId,
      expectedThreadRevision: input.expectedThreadRevision,
      idempotencyKey: input.idempotencyKey,
      intent: query
        ? Object.freeze({
            kind: "query" as const,
            sourceRunId: (input as ReturnType<typeof bridgeQueryTaskRequest>)
              .sourceRunId,
            operationId: (input as ReturnType<typeof bridgeQueryTaskRequest>)
              .operationId,
          })
        : Object.freeze({
            kind: "generate" as const,
            input: (input as ReturnType<typeof bridgeTaskRequest>)
              .input as WorkflowSchemaValue,
          }),
    });
    const request = extensionCanonicalJson(command);
    if (invocation.pending !== null) {
      if (invocation.request !== request)
        bridgeFailure("plugin_invocation_task_conflict");
      return invocation.pending;
    }
    this.#available(invocation);
    invocation.request = request;
    invocation.pending = (async () => {
      await this.#assertCurrent(invocation);
      this.#assertCurrentSync(invocation);
      const create = query
        ? this.#dependencies.tasks.createQueryTaskFromPlugin
        : this.#dependencies.tasks.createTaskFromPlugin;
      if (typeof create !== "function")
        bridgeFailure("plugin_query_task_port_unavailable");
      const result = await create.call(
        this.#dependencies.tasks,
        invocation.context.actor,
        command,
        invocation.pin,
        {
          assertCurrent: async ({ actor, pin }) => {
            if (
              extensionCanonicalJson(actor) !==
                extensionCanonicalJson(invocation.context.actor) ||
              extensionCanonicalJson(pin) !==
                extensionCanonicalJson(invocation.pin)
            )
              bridgeFailure("plugin_invocation_owner_mismatch");
            await this.#assertCurrent(invocation);
            this.#assertCurrentSync(invocation);
          },
          assertActive: ({ actor, pin }) => {
            if (
              extensionCanonicalJson(actor) !==
                extensionCanonicalJson(invocation.context.actor) ||
              extensionCanonicalJson(pin) !==
                extensionCanonicalJson(invocation.pin)
            )
              bridgeFailure("plugin_invocation_owner_mismatch");
            this.#assertCurrentSync(invocation);
          },
        },
      );
      // Capture the bounded SDK projection before receipt verification yields to storage.
      const output = bridgeTaskOutput(result) as PluginTaskReceipt;
      // An acknowledged commit stays acknowledged after close/revocation; no new admission occurs here.
      invocation.committed = await (query
        ? this.#dependencies.committedTasks.issueQuery({
            context: invocation.context,
            command,
            result,
          })
        : this.#dependencies.committedTasks.issue({
            context: invocation.context,
            command,
            result,
          }));
      return output;
    })();
    // The action may forget to await this promise; keep its failure observed until dispatch finishes.
    void invocation.pending.catch(() => {});
    return invocation.pending;
  }

  async #invoke(access: ActionLeaseAccess, context: PluginUiActionContext) {
    if (this.#closed) bridgeFailure("plugin_invocation_unavailable");
    if (this.#invocations.size >= 128) bridgeFailure("plugin_invocation_limit");
    const pin = bridgePin(context);
    const ref = this.#dependencies.ids.nextId();
    if (
      typeof ref !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(ref) ||
      this.#invocations.has(ref)
    )
      bridgeFailure("plugin_invocation_reference_invalid");
    const invocation: Invocation = {
      context,
      pin,
      instance: null,
      kind: "read",
      open: true,
      expiresAt: Math.min(
        this.#now() + 30_000,
        Date.parse(context.lease.expiresAt),
      ),
      request: null,
      pending: null,
      committed: null,
      assertInstanceCurrent: null,
      assertInstanceCurrentSync: null,
    };
    if (access.assertCurrent)
      invocation.assertInstanceCurrent = () =>
        access.assertCurrent!(invocation);
    this.#invocations.set(ref, invocation);
    let lease: PluginNodeLease | undefined;
    try {
      await this.#assertCurrent(invocation);
      const prepared = access.prepareLease(invocation);
      const acquire = prepared instanceof Promise ? await prepared : prepared;
      lease = acquire();
      invocation.instance = lease.identity;
      this.#assertCurrentSync(invocation);
      // The service name is the declared plugin ID, never an arbitrary action string.
      const service = lease.getService<PluginActionsService>(pin.pluginId, "1");
      const fields = bridgeFields(service, ["actions", "invoke"]);
      const declared = bridgeAction(fields.actions, context);
      if (typeof fields.invoke !== "function")
        bridgeFailure("plugin_action_service_invalid");
      const invoke = fields.invoke.bind(
        service,
      ) as PluginActionsService["invoke"];
      invocation.kind = declared.kind;
      let dispatched:
        | Readonly<{ kind: "returned"; output: PluginUiJsonValue }>
        | Readonly<{ kind: "failed"; error: unknown }>;
      try {
        this.#assertCurrentSync(invocation);
        const output = await invoke(
          Object.freeze({
            invocationRef: ref,
            contributionId: pin.contributionId,
            action: pin.action,
            input: parsePluginUiJsonValue(context.input),
          }),
        );
        dispatched = { kind: "returned", output };
      } catch (error) {
        dispatched = { kind: "failed", error };
      }
      if (invocation.pending !== null) await invocation.pending;
      if (invocation.committed !== null) return invocation.committed;
      if (dispatched.kind === "failed") throw dispatched.error;
      await this.#assertCurrent(invocation);
      this.#assertCurrentSync(invocation);
      return parsePluginUiJsonValue(dispatched.output);
    } finally {
      invocation.open = false;
      this.#invocations.delete(ref);
      lease?.release();
    }
  }
}
