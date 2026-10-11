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
  parseProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiInput,
} from "@crewon/contracts/plugins";
import {
  assertProjectHistoricalQueryExecutionPublication,
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parseProjectHistoricalQueryPublication,
  type PluginTaskAdmissionPin,
  type ProjectHistoricalQueryPublication,
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
  type PluginQueryTaskRequest,
  type PluginTaskService,
  type PluginTaskServiceV2,
} from "@crewon/plugin-sdk/node";
import {
  PluginNodeHost,
  type PluginActivationCandidate,
  type PluginHostService,
} from "./plugin-node-host.ts";
import {
  projectGenerationBridgeMethod,
  projectGenerationSynchronousAvailable,
} from "./plugin-project-generation-action-bridge-support.ts";
import { assertPluginProjectGenerationQueryActionDeclaration } from "./plugin-project-generation-query-action-bridge-support.ts";
import { assertPluginProjectHistoricalQuerySource } from "./plugin-project-historical-query-action-bridge-support.ts";
import {
  capturePluginHistoricalQueryInvocationCommitAuthority,
  type PluginHistoricalQueryInvocationAuthority,
} from "@crewon/application";
import {
  bridgeFailure,
  bridgeFields,
  bridgePin,
  bridgeTaskOutput,
  bridgeQueryTaskRequest,
} from "./plugin-task-action-bridge-support.ts";

export type PluginProjectHistoricalQueryExecutionAuthority = Readonly<{
  invocation: PluginHistoricalQueryInvocationAuthority;
  assertCurrent(): Promise<void>;
  /** Uses no extra Project/installation store connection while the transaction owns its locks. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export type PluginProjectHistoricalQueryExecutionInput = Readonly<{
  context: PluginUiActionContext;
  publication: ProjectHistoricalQueryPublication;
  sourcePin: PluginTaskAdmissionPin;
  executionPin: PluginTaskAdmissionPin;
  targetCandidate: PluginActivationCandidate;
  request: ProjectHistoricalQueryUiInput;
  command: CreateExtensionTaskCommand;
  authority: PluginProjectHistoricalQueryExecutionAuthority;
  commit(
    input: Readonly<{
      command: CreateExtensionTaskCommand;
      executionPin: PluginTaskAdmissionPin;
      authority: PluginProjectHistoricalQueryExecutionAuthority;
    }>,
  ): Promise<CommitExtensionTurnResult>;
}>;
export type PluginProjectHistoricalQueryExecutionResult = Readonly<{
  command: CreateExtensionTaskCommand;
  executionPin: PluginTaskAdmissionPin;
  result: CommitExtensionTurnResult;
}>;
export type PluginProjectHistoricalQueryExecutionBridgeDependencies = Readonly<{
  clock: ApplicationClock;
  ids: PluginUiOpaqueIdPort;
}>;
type Invocation = {
  instance: PluginIdentity | null;
  pin: PluginTaskAdmissionPin;
  command: CreateExtensionTaskCommand;
  authority: PluginProjectHistoricalQueryExecutionAuthority;
  commit: PluginProjectHistoricalQueryExecutionInput["commit"];
  expiresAt: number;
  open: boolean;
  pending: Promise<PluginTaskReceipt> | null;
  result: CommitExtensionTurnResult | null;
};

/** Binds the original task port to one actual execution-package borrow, not a synthetic UI context. */
export class PluginProjectHistoricalQueryExecutionBridge {
  readonly #clock: ApplicationClock["now"];
  readonly #nextId: PluginUiOpaqueIdPort["nextId"];
  readonly #invocations = new Map<string, Invocation>();
  readonly #executions = new Set<
    Promise<PluginProjectHistoricalQueryExecutionResult>
  >();
  #closed = false;

  constructor(input: PluginProjectHistoricalQueryExecutionBridgeDependencies) {
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
  ): input is PluginProjectHistoricalQueryExecutionBridge {
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
          createTask: () =>
            bridgeFailure("plugin_project_generation_query_create_unsupported"),
        }),
    });
  }

  hostServiceV2(): PluginHostService {
    return Object.freeze({
      service: CREWON_TASKS_SERVICE,
      apiVersion: CREWON_TASKS_V2_API_VERSION,
      value: Object.freeze({
        createTask: () =>
          bridgeFailure("plugin_project_generation_query_create_unsupported"),
        queryTask: () => bridgeFailure("plugin_task_port_unbound"),
      }),
      bindForPlugin: (identity: PluginIdentity): PluginTaskServiceV2 =>
        Object.freeze({
          createTask: () =>
            bridgeFailure("plugin_project_generation_query_create_unsupported"),
          queryTask: (input: PluginQueryTaskRequest) =>
            this.#boundQueryTask(identity, input),
        }),
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const invocation of this.#invocations.values())
      invocation.open = false;
    await Promise.allSettled([...this.#executions]);
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

  #boundQueryTask(
    identity: PluginIdentity,
    input: unknown,
  ): Promise<PluginTaskReceipt> {
    const task = this.#queryTask(identity, input);
    // Observe the actual promise exposed to Node code, including the async wrapper's rejection.
    void task.catch(() => {});
    return task;
  }

  async #queryTask(
    identity: PluginIdentity,
    raw: unknown,
  ): Promise<PluginTaskReceipt> {
    const input = bridgeQueryTaskRequest(raw);
    const invocation = this.#invocations.get(input.invocationRef);
    if (!invocation || invocation.instance !== identity)
      bridgeFailure("plugin_invocation_owner_mismatch");
    const command = {
      pluginId: invocation.pin.pluginId,
      threadId: input.threadId,
      expectedThreadRevision: input.expectedThreadRevision,
      idempotencyKey: input.idempotencyKey,
      intent: {
        kind: "query",
        sourceRunId: input.sourceRunId,
        operationId: input.operationId,
      },
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
    input: PluginProjectHistoricalQueryExecutionInput,
  ): Promise<PluginProjectHistoricalQueryExecutionResult> {
    return this.#run(projectExecutionHostAccess(nodeHost), input);
  }

  async executeFromBorrower(
    borrower: PluginProjectExecutionBorrower,
    input: PluginProjectHistoricalQueryExecutionInput,
  ): Promise<PluginProjectHistoricalQueryExecutionResult> {
    return this.#run(projectExecutionBorrowerAccess(borrower), input);
  }

  #run(
    source: ProjectExecutionLeaseSource,
    input: PluginProjectHistoricalQueryExecutionInput,
  ): Promise<PluginProjectHistoricalQueryExecutionResult> {
    const pending = this.#execute(source, input);
    this.#executions.add(pending);
    void pending.then(
      () => this.#executions.delete(pending),
      () => this.#executions.delete(pending),
    );
    return pending;
  }
  async #execute(
    source: ProjectExecutionLeaseSource,
    input: PluginProjectHistoricalQueryExecutionInput,
  ): Promise<PluginProjectHistoricalQueryExecutionResult> {
    if (this.#closed)
      bridgeFailure("plugin_project_generation_query_unavailable");
    if (this.#invocations.size >= 128) bridgeFailure("plugin_invocation_limit");
    // Every input, callback and historical query command is captured before activation or authorization can yield.
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
    const sourceCurrent =
      capturePluginHistoricalQueryInvocationCommitAuthority(context);
    const sourcePin = parsePluginTaskAdmissionPin(fields.sourcePin);
    if (
      extensionCanonicalJson(sourcePin) !==
      extensionCanonicalJson(bridgePin(context))
    )
      bridgeFailure("plugin_invocation_owner_mismatch");
    assertPluginProjectHistoricalQuerySource(context, sourcePin);
    const pin = parsePluginTaskAdmissionPin(fields.executionPin);
    const publication = parseProjectHistoricalQueryPublication(
      fields.publication,
    );
    assertProjectHistoricalQueryExecutionPublication({
      publication,
      sourcePin,
      executionPin: pin,
    });
    const request = parseProjectHistoricalQueryUiActionRequest({
      action: context.action,
      input: fields.request,
    }).input;
    if (
      extensionCanonicalJson(request) !==
      extensionCanonicalJson(
        parseProjectHistoricalQueryUiActionRequest({
          action: context.action,
          input: context.input,
        }).input,
      )
    )
      bridgeFailure("plugin_project_generation_query_request_mismatch");
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
      bridgeFailure("plugin_project_generation_query_target_mismatch");
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
    const intent = bridgeFields(commandFields.intent, [
      "kind",
      "sourceRunId",
      "operationId",
    ]);
    if (
      commandFields.pluginId !== pin.pluginId ||
      commandFields.threadId !== request.threadId ||
      commandFields.expectedThreadRevision !== request.expectedThreadRevision ||
      typeof commandFields.idempotencyKey !== "string" ||
      intent.kind !== "query" ||
      typeof intent.sourceRunId !== "string" ||
      intent.sourceRunId.length === 0 ||
      intent.operationId !== request.operationId
    )
      bridgeFailure("plugin_project_generation_query_command_invalid");
    const callbacks =
      fields.authority as PluginProjectHistoricalQueryExecutionAuthority;
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
      authority:
        null as unknown as PluginProjectHistoricalQueryExecutionAuthority,
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
        bridgeFailure("plugin_project_generation_query_active_check_invalid");
      }
      this.#active(invocation);
      sourceCurrent.assertActive();
    };
    invocation.authority = Object.freeze({
      invocation: sourceCurrent,
      assertActive,
      assertCurrent: async () => {
        assertActive();
        await sourceCurrent.assertCurrent();
        const result: unknown = await fullCurrent();
        if (result !== undefined)
          bridgeFailure(
            "plugin_project_generation_query_current_check_invalid",
          );
        assertActive();
      },
      assertTransactionCurrent: async () => {
        // Full source current selection reads are intentionally absent while the query transaction holds locks.
        assertActive();
        const result: unknown = await transactionCurrent();
        if (result !== undefined)
          bridgeFailure(
            "plugin_project_generation_query_current_check_invalid",
          );
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
      assertPluginProjectGenerationQueryActionDeclaration(
        service,
        descriptor,
        pin,
      );
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
              sourceRunId: intent.sourceRunId,
              operationId: intent.operationId,
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
      return bridgeFailure(
        "plugin_project_generation_query_task_not_committed",
      );
    } finally {
      invocation.open = false;
      this.#invocations.delete(ref);
      if (lease !== undefined) access.release(lease);
    }
  }
}
