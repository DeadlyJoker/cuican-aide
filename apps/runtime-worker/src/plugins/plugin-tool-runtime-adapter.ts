import type {
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import {
  validateToolExecutionPolicyMatchesIntent,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicyContext,
  type ToolExecutionReservation,
  type ToolExecutionReservationOptions,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  array,
  canonical,
  checkedAcknowledgement,
  checkedCatalog,
  checkedCommand,
  checkedLookup,
  checkedMetadata,
  checkedPolicy,
  checkedPolicyContext,
  checkedQuery,
  checkedReservationOptions,
  checkedResolution,
  checkedScan,
  checkedScopedMetadata,
  invalid,
  snapshotContext,
} from "./plugin-tool-runtime-adapter-data.ts";
import {
  assertWorkerToolDispatch,
  withCheckedWorkerToolDispatch,
} from "./worker-tool-dispatch-authority.ts";
import {
  ProjectToolInputError,
  projectToolInputErrorResult,
} from "./project-tool-input-error.ts";

type Method = "execute" | "reconcile" | "cancel";
export type PluginToolRuntimeAdapterInput = Readonly<{
  runtime: PluginToolRuntime;
  context: PluginToolRuntimeContext;
  definitions: readonly ToolDefinition[];
  /** Host-only immutable Run sandbox projection; never selected by a plugin or a last policy call. */
  policyContext?: ToolExecutionPolicyContext;
  authorize(
    input: Readonly<{
      method: Method;
      command: ToolExecutionCommand;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
  /** Host I/O bridge; requires a real Worker dispatch grant, never a copied lease DTO. */
  dispatchAuthority?(
    input: Readonly<{
      method: Method;
      command: ToolExecutionCommand;
      signal: AbortSignal;
    }>,
    delegate: () => Promise<ToolExecutionResolution>,
  ): Promise<ToolExecutionResolution>;
}>;

const required = [
  "definitions",
  "executionPolicy",
  "execute",
  "reconcile",
  "cancel",
] as const;
const optional = [
  "reserveExecution",
  "acknowledgeExecutionResult",
  "cancelRetainedExecution",
  "retainedExecutionResults",
  "scanRetainedExecutionResults",
  "readRetainedExecutionResult",
  "canRetire",
  "close",
] as const;

/** Preserves original Tool execution/receipt ownership; this is not a Run admission or a sandbox. */
export function adaptPluginToolRuntime(
  input: PluginToolRuntimeAdapterInput,
): ToolRuntimePort {
  const captured = captureMethods(
    input.runtime,
    required,
    optional,
  ) as unknown as PluginToolRuntime;
  const context = snapshotContext(input.context);
  const definitions = checkedCatalog(input.definitions);
  const actual = checkedCatalog(captured.definitions());
  const expectedByKey = new Map(
    definitions.map((definition) => [
      toolKey(definition.kind, definition.name),
      canonical(definition),
    ]),
  );
  if (
    actual.length !== definitions.length ||
    actual.some(
      (definition) =>
        expectedByKey.get(toolKey(definition.kind, definition.name)) !==
        canonical(definition),
    )
  )
    invalid("plugin_tool_catalog_mismatch");
  if (typeof input.authorize !== "function")
    invalid("plugin_tool_authorization_missing");
  const owner = new AdapterOwner({
    methods: captured,
    context,
    definitions,
    policyContext: checkedPolicyContext(input.policyContext),
    authorize: input.authorize.bind(input),
    dispatchAuthority: input.dispatchAuthority?.bind(input),
  });
  return owner.port();
}

type Reservation = {
  phase: "reserved" | "authorizing" | "started" | "released";
  release(): void;
};

class AdapterOwner {
  readonly #methods: PluginToolRuntime;
  readonly #context: PluginToolRuntimeContext;
  readonly #definitions: readonly ToolDefinition[];
  readonly #allowed: ReadonlySet<string>;
  readonly #authorize: PluginToolRuntimeAdapterInput["authorize"];
  readonly #dispatchAuthority: PluginToolRuntimeAdapterInput["dispatchAuthority"];
  readonly #policyContext: ToolExecutionPolicyContext | undefined;
  readonly #active = new Set<Promise<unknown>>();
  readonly #reservations = new Set<Reservation>();
  #closing = false;
  #closeTask: Promise<void> | null = null;

  constructor(
    input: Readonly<{
      methods: PluginToolRuntime;
      context: PluginToolRuntimeContext;
      definitions: readonly ToolDefinition[];
      policyContext: ToolExecutionPolicyContext | undefined;
      authorize: PluginToolRuntimeAdapterInput["authorize"];
      dispatchAuthority: PluginToolRuntimeAdapterInput["dispatchAuthority"];
    }>,
  ) {
    this.#methods = input.methods;
    this.#context = input.context;
    this.#definitions = input.definitions;
    this.#allowed = new Set(
      input.definitions.map((definition) =>
        toolKey(definition.kind, definition.name),
      ),
    );
    this.#authorize = input.authorize;
    this.#dispatchAuthority = input.dispatchAuthority;
    this.#policyContext = input.policyContext;
  }

  port(): ToolRuntimePort {
    return Object.freeze({
      definitions: () => structuredClone(this.#definitions),
      executionPolicy: (
        kind: ToolCallKind,
        name: string,
        context?: ToolExecutionPolicyContext,
      ) => this.#policy(kind, name, context),
      execute: (command: ToolExecutionCommand, signal: AbortSignal) =>
        this.#invoke("execute", command, signal),
      reconcile: (command: ToolExecutionCommand, signal: AbortSignal) =>
        this.#invoke("reconcile", command, signal),
      cancel: (command: ToolExecutionCommand, signal: AbortSignal) =>
        this.#invoke("cancel", command, signal),
      ...(this.#methods.reserveExecution === undefined
        ? {}
        : {
            reserveExecution: (
              command: ToolExecutionCommand,
              signal: AbortSignal,
              options?: ToolExecutionReservationOptions,
            ) => this.#reserve(command, signal, options),
          }),
      ...(this.#methods.acknowledgeExecutionResult === undefined
        ? {}
        : {
            acknowledgeExecutionResult: (
              input: Parameters<
                NonNullable<ToolRuntimePort["acknowledgeExecutionResult"]>
              >[0],
            ) => {
              const value = checkedAcknowledgement(input, this.#context);
              this.#requireAllowed(
                value.actionIntent.tool.kind,
                value.actionIntent.tool.name,
              );
              const result = this.#methods.acknowledgeExecutionResult!(value);
              if (result !== undefined && typeof result !== "boolean")
                invalid("plugin_tool_acknowledgement_invalid");
              return result;
            },
          }),
      ...(this.#methods.cancelRetainedExecution === undefined
        ? {}
        : {
            cancelRetainedExecution: (
              input: Parameters<
                NonNullable<ToolRuntimePort["cancelRetainedExecution"]>
              >[0],
            ) => {
              const value = this.#lookup(input);
              const result = this.#methods.cancelRetainedExecution!(value);
              return result === null
                ? null
                : checkedResolution(result, {
                    executionId: value.executionId,
                    callId: value.actionIntent.callId,
                  });
            },
          }),
      ...(this.#methods.readRetainedExecutionResult === undefined
        ? {}
        : {
            readRetainedExecutionResult: (
              input: Parameters<
                NonNullable<ToolRuntimePort["readRetainedExecutionResult"]>
              >[0],
            ) => {
              const value = this.#lookup(input);
              const result = this.#methods.readRetainedExecutionResult!(value);
              return result === null
                ? null
                : checkedResolution(result, {
                    executionId: value.executionId,
                    callId: value.actionIntent.callId,
                  });
            },
          }),
      ...(this.#methods.retainedExecutionResults === undefined
        ? {}
        : {
            retainedExecutionResults: (
              input: Parameters<
                NonNullable<ToolRuntimePort["retainedExecutionResults"]>
              >[0],
            ) => {
              const query = checkedQuery(input, this.#context);
              return array(
                this.#methods.retainedExecutionResults!(query),
                query.limit,
              ).map((item) => {
                const result = checkedMetadata(item);
                this.#requireAllowed(result.kind, result.name);
                return result;
              });
            },
          }),
      ...(this.#methods.scanRetainedExecutionResults === undefined
        ? {}
        : {
            scanRetainedExecutionResults: (
              input: Parameters<
                NonNullable<ToolRuntimePort["scanRetainedExecutionResults"]>
              >[0],
            ) => {
              const query = checkedScan(input);
              return array(
                this.#methods.scanRetainedExecutionResults!(query),
                query.limit,
              )
                .map(checkedScopedMetadata)
                .filter((result) => {
                  if (
                    result.tenantId !== this.#context.scope.tenantId ||
                    result.runId !== this.#context.run.runId
                  )
                    return false;
                  this.#requireAllowed(result.kind, result.name);
                  return true;
                });
            },
          }),
      ...(this.#methods.canRetire === undefined
        ? {}
        : {
            canRetire: () => {
              if (
                this.#closing ||
                this.#active.size !== 0 ||
                this.#reservations.size !== 0
              )
                return false;
              const result = this.#methods.canRetire!();
              if (typeof result !== "boolean")
                invalid("plugin_tool_retirement_proof_invalid");
              return result;
            },
          }),
      ...(this.#methods.close === undefined
        ? {}
        : { close: () => this.#close() }),
    });
  }

  #lookup(
    input: Parameters<
      NonNullable<ToolRuntimePort["readRetainedExecutionResult"]>
    >[0],
  ) {
    const value = checkedLookup(input, this.#context);
    this.#requireAllowed(
      value.actionIntent.tool.kind,
      value.actionIntent.tool.name,
    );
    return value;
  }

  #policy(
    kind: ToolCallKind,
    name: string,
    context?: ToolExecutionPolicyContext,
  ) {
    if (
      (kind !== "function" && kind !== "custom") ||
      typeof name !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(name)
    )
      invalid("plugin_tool_name_invalid");
    if (!this.#allowed.has(toolKey(kind, name))) return null;
    const requested = checkedPolicyContext(context);
    if (
      requested !== undefined &&
      requested.sandboxMode !== this.#policyContext?.sandboxMode
    )
      invalid("plugin_tool_policy_context_mismatch");
    return checkedPolicy(
      this.#methods.executionPolicy(kind, name, this.#policyContext),
    );
  }

  #command(input: ToolExecutionCommand): ToolExecutionCommand {
    const command = checkedCommand(input, this.#context);
    this.#requireAllowed(command.kind, command.name);
    this.#assertPolicy(command);
    return command;
  }
  #assertPolicy(command: ToolExecutionCommand): void {
    const policy = this.#policy(command.kind, command.name);
    if (policy === null) invalid("plugin_tool_not_bound");
    validateToolExecutionPolicyMatchesIntent(policy, command.actionIntent);
  }
  #requireAllowed(kind: ToolCallKind, name: string): void {
    if (!this.#allowed.has(toolKey(kind, name)))
      invalid("plugin_tool_not_bound");
  }
  #open(): void {
    if (this.#closing) invalid("plugin_tool_runtime_closed");
  }

  #invoke(
    method: Method,
    input: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    try {
      this.#open();
      const command = this.#command(input);
      signal.throwIfAborted();
      return this.#track(async () => {
        await this.#authorize(Object.freeze({ method, command, signal }));
        this.#open();
        signal.throwIfAborted();
        this.#assertPolicy(command);
        this.#open();
        // No late abort/close fence here: a completion receipt remains stronger evidence.
        const result = await this.#dispatch(
          input,
          command,
          method,
          signal,
          () => this.#methods[method](command, signal),
        );
        return checkedResolution(result, command);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #reserve(
    input: ToolExecutionCommand,
    signal: AbortSignal,
    options?: ToolExecutionReservationOptions,
  ): ToolExecutionReservation | undefined {
    this.#open();
    if (this.#reservations.size >= 128) invalid("plugin_tool_runtime_busy");
    const command = this.#command(input);
    signal.throwIfAborted();
    const raw = this.#methods.reserveExecution!(
      command,
      signal,
      checkedReservationOptions(options, this.#context),
    );
    if (raw === undefined) return undefined;
    const cleanup = captureMethods(raw, ["release"], []) as unknown as Pick<
      ToolExecutionReservation,
      "release"
    >;
    let captured: ToolExecutionReservation;
    try {
      captured = captureMethods(
        raw,
        ["execute", "release"],
        [],
      ) as unknown as ToolExecutionReservation;
    } catch (error) {
      // Capacity already belongs to this reservation, but physical execution has not started.
      // A valid own/prototype release method can clean it even when execute violates the ABI.
      cleanup.release();
      throw error;
    }
    let started: Promise<ToolExecutionResolution> | null = null;
    const reservation: Reservation = {
      phase: "reserved",
      release: () => {
        if (reservation.phase === "started" || reservation.phase === "released")
          return;
        reservation.phase = "released";
        this.#reservations.delete(reservation);
        captured.release();
      },
    };
    this.#reservations.add(reservation);
    return Object.freeze({
      execute: () => {
        if (started !== null) return started;
        if (reservation.phase === "released")
          return Promise.reject(new Error("plugin_tool_reservation_released"));
        reservation.phase = "authorizing";
        try {
          started = this.#track(async () => {
            try {
              await this.#authorize(
                Object.freeze({ method: "execute", command, signal }),
              );
              this.#open();
              if (reservation.phase === "released")
                invalid("plugin_tool_reservation_released");
              signal.throwIfAborted();
              this.#assertPolicy(command);
              this.#open();
              const result = await this.#dispatch(
                input,
                command,
                "execute",
                signal,
                () => {
                  reservation.phase = "started";
                  this.#reservations.delete(reservation);
                  return captured.execute();
                },
              );
              if (reservation.phase !== "started") reservation.release();
              return checkedResolution(result, command);
            } catch (error) {
              // A started reservation belongs to the provider's physical operation/result, even
              // when its logical promise rejects. Never release it on behalf of the caller.
              if (reservation.phase !== "started") reservation.release();
              throw error;
            }
          });
          return started;
        } catch (error) {
          reservation.release();
          return Promise.reject(error);
        }
      },
      release: reservation.release,
    });
  }

  #dispatch(
    originalCommand: ToolExecutionCommand,
    command: ToolExecutionCommand,
    method: Method,
    signal: AbortSignal,
    delegate: () => Promise<ToolExecutionResolution>,
  ): Promise<ToolExecutionResolution> {
    if (this.#dispatchAuthority === undefined) return delegate();
    const invocation = Object.freeze({ command, method, signal });
    return withCheckedWorkerToolDispatch(
      { originalCommand, command, method, signal },
      async () => {
        let delegated = false;
        try {
          return await this.#dispatchAuthority!(invocation, () => {
            this.#open();
            this.#assertPolicy(command);
            assertWorkerToolDispatch(invocation);
            delegated = true;
            return delegate();
          });
        } catch (error) {
          // Only deterministic, pre-dispatch input failures become model feedback.
          // Authority failures and uncertain provider outcomes retain their original handling.
          if (
            delegated ||
            method === "cancel" ||
            !(error instanceof ProjectToolInputError)
          )
            throw error;
          this.#open();
          signal.throwIfAborted();
          assertWorkerToolDispatch(invocation);
          return projectToolInputErrorResult(error, command);
        }
      },
    );
  }

  #track(
    operation: () => Promise<ToolExecutionResolution>,
  ): Promise<ToolExecutionResolution> {
    if (this.#active.size >= 128) invalid("plugin_tool_runtime_busy");
    const task = Promise.resolve().then(operation);
    this.#active.add(task);
    void task.finally(() => this.#active.delete(task)).catch(() => {});
    return task;
  }

  #close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closing = true;
    this.#closeTask = (async () => {
      const failures: unknown[] = [];
      for (const reservation of [...this.#reservations]) {
        if (reservation.phase !== "reserved") continue;
        try {
          reservation.release();
        } catch (error) {
          failures.push(error);
        }
      }
      // Explicit shutdown may cancel physical operations in the original implementation. It
      // owns that policy; await both its cleanup and every already started delegate promise.
      const delegate = Promise.resolve().then(() => this.#methods.close!());
      const results = await Promise.allSettled([delegate, ...this.#active]);
      if (results[0]?.status === "rejected") failures.push(results[0].reason);
      if (failures.length !== 0)
        throw new AggregateError(failures, "plugin_tool_runtime_close_failed");
    })();
    return this.#closeTask;
  }
}

function captureMethods(
  input: object,
  requiredNames: readonly string[],
  optionalNames: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object")
    invalid("plugin_tool_runtime_invalid");
  const result: Record<string, unknown> = {};
  for (const name of [...requiredNames, ...optionalNames]) {
    let current: object | null = input;
    let descriptor: PropertyDescriptor | undefined;
    for (let depth = 0; current !== null && depth < 8; depth++) {
      descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) break;
      current = Object.getPrototypeOf(current);
    }
    if (
      descriptor === undefined ||
      ("value" in descriptor && descriptor.value === undefined)
    ) {
      if (requiredNames.includes(name))
        invalid("plugin_tool_runtime_method_invalid");
      continue;
    }
    if (!("value" in descriptor) || typeof descriptor.value !== "function")
      invalid("plugin_tool_runtime_method_invalid");
    result[name] = descriptor.value.bind(input);
  }
  return Object.freeze(result);
}
function toolKey(kind: ToolCallKind, name: string): string {
  return `${kind}:${name}`;
}
