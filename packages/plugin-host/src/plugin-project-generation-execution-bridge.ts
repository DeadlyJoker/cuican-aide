import { ownsTaskInvocationReference } from "./plugin-task-invocation-reference.ts";
import {
  projectExecutionHostAccess,
  projectExecutionBorrowerAccess,
  type ProjectExecutionLeaseSource,
  type PluginProjectExecutionBorrower,
} from "./plugin-project-execution-borrower.ts";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
  parseProjectGenerationUiActionRequest,
  type ProjectGenerationUiInput,
} from "@crewon/contracts/plugins";
import {
  assertProjectGenerationExecutionPublication,
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parseProjectGenerationPublication,
  type PluginTaskAdmissionPin,
  type ProjectGenerationPublication,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import {
  capturePluginUiInvocationCommitAuthority,
  type ApplicationClock,
  type CommitExtensionTurnResult,
  type CreateExtensionTaskCommand,
  type PluginUiActionContext,
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
} from "@crewon/plugin-sdk/node";
import {
  PluginNodeHost,
  type PluginActivationCandidate,
  type PluginHostService,
} from "./plugin-node-host.ts";
import {
  assertPluginProjectGenerationActionDeclaration,
  assertPluginProjectGenerationSource,
  projectGenerationBridgeMethod,
  projectGenerationSynchronousAvailable,
} from "./plugin-project-generation-action-bridge-support.ts";
import {
  bridgeFailure,
  bridgeFields,
  bridgePin,
  bridgeTaskOutput,
  bridgeTaskRequest,
} from "./plugin-task-action-bridge-support.ts";

export type PluginProjectGenerationExecutionAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  /** Uses no extra Project/installation store connection while the transaction owns its locks. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export type PluginProjectGenerationExecutionInput = Readonly<{
  context: PluginUiActionContext;
  publication: ProjectGenerationPublication;
  sourcePin: PluginTaskAdmissionPin;
  executionPin: PluginTaskAdmissionPin;
  targetCandidate: PluginActivationCandidate;
  request: ProjectGenerationUiInput;
  command: CreateExtensionTaskCommand;
  authority: PluginProjectGenerationExecutionAuthority;
  commit(
    input: Readonly<{
      command: CreateExtensionTaskCommand;
      executionPin: PluginTaskAdmissionPin;
      authority: PluginProjectGenerationExecutionAuthority;
    }>,
  ): Promise<CommitExtensionTurnResult>;
}>;
export type PluginProjectGenerationExecutionResult = Readonly<{
  command: CreateExtensionTaskCommand;
  executionPin: PluginTaskAdmissionPin;
  result: CommitExtensionTurnResult;
}>;
export type PluginProjectGenerationExecutionBridgeDependencies = Readonly<{
  clock: ApplicationClock;
  ids: PluginUiOpaqueIdPort;
}>;
type Invocation = {
  instance: PluginIdentity | null;
  pin: PluginTaskAdmissionPin;
  command: CreateExtensionTaskCommand;
  authority: PluginProjectGenerationExecutionAuthority;
  commit: PluginProjectGenerationExecutionInput["commit"];
  expiresAt: number;
  open: boolean;
  pending: Promise<PluginTaskReceipt> | null;
  result: CommitExtensionTurnResult | null;
};

/** Binds the original task port to one actual execution-package borrow, not a synthetic UI context. */
export class PluginProjectGenerationExecutionBridge {
  readonly #clock: ApplicationClock["now"];
  readonly #nextId: PluginUiOpaqueIdPort["nextId"];
  readonly #invocations = new Map<string, Invocation>();
  #closed = false;

  constructor(input: PluginProjectGenerationExecutionBridgeDependencies) {
    const fields = bridgeFields(input, ["clock", "ids"]);
    this.#clock = projectGenerationBridgeMethod(
      fields.clock as ApplicationClock,
      "now",
    );
    this.#nextId = projectGenerationBridgeMethod(
      fields.ids as PluginUiOpaqueIdPort,
      "nextId",
    );
  }

  static isOwner(
    input: unknown,
  ): input is PluginProjectGenerationExecutionBridge {
    return input !== null && typeof input === "object" && #invocations in input;
  }

  ownsInvocation(input: unknown): boolean {
    return ownsTaskInvocationReference(input, this.#invocations, this.#closed);
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
            this.#boundTask(identity, input),
        }),
    });
  }

  hostServiceV2(): PluginHostService {
    return Object.freeze({
      service: CREWON_TASKS_SERVICE,
      apiVersion: CREWON_TASKS_V2_API_VERSION,
      value: Object.freeze({
        createTask: () => bridgeFailure("plugin_task_port_unbound"),
        queryTask: () =>
          bridgeFailure("plugin_project_generation_query_unsupported"),
      }),
      bindForPlugin: (identity: PluginIdentity): PluginTaskServiceV2 =>
        Object.freeze({
          createTask: (input: PluginTaskRequest) =>
            this.#boundTask(identity, input),
          queryTask: () =>
            bridgeFailure("plugin_project_generation_query_unsupported"),
        }),
    });
  }

  close(): void {
    this.#closed = true;
    for (const invocation of this.#invocations.values())
      invocation.open = false;
  }

  #now(): number {
    const now = Date.parse(this.#clock());
    if (!Number.isFinite(now)) bridgeFailure("plugin_invocation_clock_invalid");
    return now;
  }

  #active(invocation: Invocation): void {
    if (this.#closed || !invocation.open || this.#now() >= invocation.expiresAt)
      bridgeFailure("plugin_invocation_unavailable");
  }

  #boundTask(
    identity: PluginIdentity,
    input: unknown,
  ): Promise<PluginTaskReceipt> {
    const task = this.#createTask(identity, input);
    // Observe the actual promise exposed to Node code, including the async wrapper's rejection.
    void task.catch(() => {});
    return task;
  }

  async #createTask(
    identity: PluginIdentity,
    raw: unknown,
  ): Promise<PluginTaskReceipt> {
    const input = bridgeTaskRequest(raw);
    const invocation = this.#invocations.get(input.invocationRef);
    if (!invocation || invocation.instance !== identity)
      bridgeFailure("plugin_invocation_owner_mismatch");
    const command = {
      pluginId: invocation.pin.pluginId,
      threadId: input.threadId,
      expectedThreadRevision: input.expectedThreadRevision,
      idempotencyKey: input.idempotencyKey,
      intent: { kind: "generate", input: input.input as WorkflowSchemaValue },
    };
    if (
      extensionCanonicalJson(command) !==
      extensionCanonicalJson(invocation.command)
    )
      bridgeFailure("plugin_invocation_task_conflict");
    if (invocation.pending !== null) return invocation.pending;
    invocation.authority.assertActive();
    invocation.pending = (async () => {
      await invocation.authority.assertCurrent();
      const rawResult = await invocation.commit(
        Object.freeze({
          command: invocation.command,
          executionPin: invocation.pin,
          authority: invocation.authority,
        }),
      );
      const result = parsePluginUiJsonValue(
        rawResult,
      ) as unknown as CommitExtensionTurnResult;
      const output = bridgeTaskOutput(result) as PluginTaskReceipt;
      invocation.result = result;
      return output;
    })();
    void invocation.pending.catch(() => {});
    return invocation.pending;
  }

  execute(
    nodeHost: PluginNodeHost,
    input: PluginProjectGenerationExecutionInput,
  ): Promise<PluginProjectGenerationExecutionResult> {
    return this.#execute(projectExecutionHostAccess(nodeHost), input);
  }

  async executeFromBorrower(
    borrower: PluginProjectExecutionBorrower,
    input: PluginProjectGenerationExecutionInput,
  ): Promise<PluginProjectGenerationExecutionResult> {
    return this.#execute(projectExecutionBorrowerAccess(borrower), input);
  }

  async #execute(
    source: ProjectExecutionLeaseSource,
    input: PluginProjectGenerationExecutionInput,
  ): Promise<PluginProjectGenerationExecutionResult> {
    if (this.#closed) bridgeFailure("plugin_project_generation_unavailable");
    if (this.#invocations.size >= 128) bridgeFailure("plugin_invocation_limit");
    // Every input, callback and saved prompt is captured before activation or authorization can yield.
    const fields = bridgeFields(input, [
      "context",
      "publication",
      "sourcePin",
      "executionPin",
      "targetCandidate",
      "request",
      "command",
      "authority",
      "commit",
    ]);
    const context = fields.context as PluginUiActionContext;
    const sourceCurrent = capturePluginUiInvocationCommitAuthority(context);
    const sourcePin = parsePluginTaskAdmissionPin(fields.sourcePin);
    if (
      extensionCanonicalJson(sourcePin) !==
      extensionCanonicalJson(bridgePin(context))
    )
      bridgeFailure("plugin_invocation_owner_mismatch");
    assertPluginProjectGenerationSource(context, sourcePin);
    const pin = parsePluginTaskAdmissionPin(fields.executionPin);
    const publication = parseProjectGenerationPublication(fields.publication);
    assertProjectGenerationExecutionPublication({
      publication,
      sourcePin,
      executionPin: pin,
    });
    const request = parseProjectGenerationUiActionRequest({
      action: context.action,
      input: fields.request,
    }).input;
    if (
      extensionCanonicalJson(request) !==
      extensionCanonicalJson(
        parseProjectGenerationUiActionRequest({
          action: context.action,
          input: context.input,
        }).input,
      )
    )
      bridgeFailure("plugin_project_generation_request_mismatch");
    const target = bridgeFields(fields.targetCandidate, [
      "descriptor",
      "packageDigest",
    ]);
    const descriptor = parsePluginPackageDescriptor(target.descriptor);
    if (
      target.packageDigest !== pin.packageDigest ||
      descriptor.pluginId !== pin.pluginId ||
      descriptor.publisherId !== pin.publisherId ||
      descriptor.version !== pin.version ||
      descriptor.entrypoints.node === null ||
      !descriptor.contributions.some((item) => item.id === pin.contributionId)
    )
      bridgeFailure("plugin_project_generation_target_mismatch");
    const command = parsePluginUiJsonValue(
      fields.command,
    ) as unknown as CreateExtensionTaskCommand;
    const commandFields = bridgeFields(command, [
      "pluginId",
      "threadId",
      "expectedThreadRevision",
      "idempotencyKey",
      "intent",
    ]);
    const intent = bridgeFields(commandFields.intent, ["kind", "input"]);
    const prompt = bridgeFields(intent.input, ["prompt"]);
    if (
      commandFields.pluginId !== pin.pluginId ||
      commandFields.threadId !== request.threadId ||
      commandFields.expectedThreadRevision !== request.expectedThreadRevision ||
      typeof commandFields.idempotencyKey !== "string" ||
      intent.kind !== "generate" ||
      typeof prompt.prompt !== "string"
    )
      bridgeFailure("plugin_project_generation_command_invalid");
    const callbacks =
      fields.authority as PluginProjectGenerationExecutionAuthority;
    const fullCurrent = projectGenerationBridgeMethod(
      callbacks,
      "assertCurrent",
    );
    const transactionCurrent = projectGenerationBridgeMethod(
      callbacks,
      "assertTransactionCurrent",
    );
    const active = projectGenerationBridgeMethod(callbacks, "assertActive");
    const commit = projectGenerationBridgeMethod(input, "commit");
    const ref = this.#nextId();
    if (
      typeof ref !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(ref) ||
      this.#invocations.has(ref)
    )
      bridgeFailure("plugin_invocation_reference_invalid");
    const invocation: Invocation = {
      instance: null,
      pin,
      command,
      commit,
      authority: null as unknown as PluginProjectGenerationExecutionAuthority,
      expiresAt: Math.min(
        this.#now() + 30_000,
        Date.parse(context.lease.expiresAt),
      ),
      open: true,
      pending: null,
      result: null,
    };
    const access = source.prepare(context, pin);
    const assertActive = () => {
      this.#active(invocation);
      sourceCurrent.assertActive();
      if (invocation.instance !== null)
        access.assertCurrent?.(invocation.instance);
      const result: unknown = active();
      if (result !== undefined) {
        projectGenerationSynchronousAvailable(result);
        bridgeFailure("plugin_project_generation_active_check_invalid");
      }
      this.#active(invocation);
      sourceCurrent.assertActive();
    };
    invocation.authority = Object.freeze({
      assertActive,
      assertCurrent: async () => {
        assertActive();
        await sourceCurrent.assertCurrent();
        const result: unknown = await fullCurrent();
        if (result !== undefined)
          bridgeFailure("plugin_project_generation_current_check_invalid");
        assertActive();
      },
      assertTransactionCurrent: async () => {
        // Full source current selection reads are intentionally absent while the paid transaction holds locks.
        assertActive();
        const result: unknown = await transactionCurrent();
        if (result !== undefined)
          bridgeFailure("plugin_project_generation_current_check_invalid");
        assertActive();
      },
    });
    this.#invocations.set(ref, invocation);
    let lease: ReturnType<PluginNodeHost["acquire"]> | undefined;
    try {
      await invocation.authority.assertCurrent();
      lease = access.acquire({
        pluginId: pin.pluginId,
        packageDigest: pin.packageDigest,
        purpose: "newOperation",
        authorizeBorrow: (identity) => {
          try {
            assertActive();
            return identity.pluginId === pin.pluginId &&
              identity.version === pin.version &&
              identity.packageDigest === pin.packageDigest
              ? "allow"
              : "deny";
          } catch {
            return "deny";
          }
        },
      });
      if (
        lease.identity.pluginId !== pin.pluginId ||
        lease.identity.version !== pin.version ||
        lease.identity.packageDigest !== pin.packageDigest
      )
        bridgeFailure("plugin_invocation_owner_mismatch");
      invocation.instance = lease.identity;
      const service = lease.getService<PluginActionsService>(pin.pluginId, "1");
      assertPluginProjectGenerationActionDeclaration(service, descriptor, pin);
      const invoke = projectGenerationBridgeMethod(service, "invoke");
      let failure: unknown = undefined;
      let failed = false;
      try {
        await invoke(
          Object.freeze({
            invocationRef: ref,
            contributionId: pin.contributionId,
            action: pin.action,
            input: parsePluginUiJsonValue({
              threadId: command.threadId,
              expectedThreadRevision: command.expectedThreadRevision,
              idempotencyKey: command.idempotencyKey,
              input:
                command.intent.kind === "generate"
                  ? command.intent.input
                  : null,
            }),
          }),
        );
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (invocation.pending !== null) await invocation.pending;
      if (invocation.result !== null)
        return Object.freeze({
          command,
          executionPin: pin,
          result: invocation.result,
        });
      if (failed) throw failure;
      return bridgeFailure("plugin_project_generation_task_not_committed");
    } finally {
      invocation.open = false;
      this.#invocations.delete(ref);
      if (lease !== undefined) access.release(lease);
    }
  }
}
