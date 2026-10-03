import {
  definePlugin,
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
  type PluginExecutionService,
  type PluginExecutionServiceRequirement,
  type PluginToolRuntime,
  type PluginToolRuntimeFactory,
  type PluginToolRuntimeContext,
  type PluginToolExecutionCommand,
  type PluginToolExecutionResolution,
  type PluginAbortSignal,
} from "@crewon/plugin-sdk/node";
import type { PluginExecutionServiceRequirement as ContractsRequirement } from "@crewon/plugin-sdk/contracts";

export const requiredServiceNames: readonly PluginExecutionServiceRequirement[] =
  ["externalOperations", "jsonHttp"];
const contractsRequirements: readonly ContractsRequirement[] =
  requiredServiceNames;
void contractsRequirements;

export const contexts: PluginToolRuntimeContext[] = [];
export const signals: PluginAbortSignal[] = [];
export const events: string[] = [];

/** Contract fixture only: no provider, Store, authority or Run is created here. */
const factory: PluginToolRuntimeFactory = {
  requiredServices: [],
  async create(context) {
    contexts.push(context);
    let active = 0;
    let closed = false;
    const results = new Map<string, PluginToolExecutionResolution>();
    const commands = new Map<string, PluginToolExecutionCommand>();
    const pending = new Map<string, () => void>();
    const runtime: PluginToolRuntime = {
      definitions: () => [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "fixture_echo",
          description: "Pure SDK ABI fixture",
          execution: "serial",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      executionPolicy: (kind, name) =>
        kind === "function" && name === "fixture_echo"
          ? {
              effect: "readOnly",
              recovery: "replaySafe",
              resourceBindingId: null,
              credentialBindingId: null,
              executionTarget: {
                kind: "control",
                bindingId: "fixture-binding",
              },
              capability: "fixture.read",
              approvalRequirement: "none",
              limits: {
                timeoutMs: 1000,
                maxOutputBytes: 1024,
                maxArtifactBytes: 0,
              },
            }
          : null,
      async execute(command, signal) {
        signal.throwIfAborted();
        if (closed || command.runId !== context.run.runId)
          throw new Error("fixture_runtime_unavailable");
        signals.push(signal);
        active++;
        commands.set(command.executionId, command);
        try {
          if (command.input === "await-abort")
            await new Promise<void>((_, reject) => {
              const abort = () => {
                pending.delete(command.executionId);
                reject(signal.reason);
              };
              signal.addEventListener("abort", abort, { once: true });
              pending.set(command.executionId, () => {
                signal.removeEventListener("abort", abort);
                reject(new Error("fixture_runtime_closed"));
              });
              if (signal.aborted) abort();
            });
          const result: PluginToolExecutionResolution = {
            status: "completed",
            executionId: command.executionId,
            providerReceiptId: `fixture:${command.executionId}`,
            result: {
              schemaVersion: "crewon.tool-result.v0",
              callId: command.callId,
              output: command.input,
              isError: false,
              artifactRef: null,
            },
          };
          results.set(command.executionId, result);
          events.push(`execute:${command.executionId}`);
          return result;
        } finally {
          active--;
        }
      },
      async reconcile(command, signal) {
        signal.throwIfAborted();
        events.push(`reconcile:${command.executionId}`);
        return (
          results.get(command.executionId) ?? {
            status: "unknownOutcome",
            executionId: command.executionId,
            providerReceiptId: null,
          }
        );
      },
      async cancel(command, signal) {
        signal.throwIfAborted();
        events.push(`cancel:${command.executionId}`);
        return (
          results.get(command.executionId) ?? {
            status: "canceled",
            executionId: command.executionId,
            providerReceiptId: null,
          }
        );
      },
      reserveExecution(command, signal, options) {
        if (options?.resultOwner.tenantId !== context.scope.tenantId)
          throw new Error("fixture_result_owner_invalid");
        let released = false;
        return {
          execute() {
            if (released)
              return Promise.reject(new Error("fixture_reservation_released"));
            return runtime.execute(command, signal);
          },
          release() {
            released = true;
          },
        };
      },
      acknowledgeExecutionResult(ack) {
        if (pending.has(ack.executionId)) return false;
        results.delete(ack.executionId);
        commands.delete(ack.executionId);
        events.push(`ack:${ack.executionId}`);
        return true;
      },
      cancelRetainedExecution: (lookup) =>
        results.get(lookup.executionId) ?? null,
      readRetainedExecutionResult: (lookup) =>
        results.get(lookup.executionId) ?? null,
      retainedExecutionResults(query) {
        return [...commands.values()]
          .filter((command) => command.runId === query.runId)
          .filter(
            (command) =>
              query.visibility === "includePending" ||
              results.has(command.executionId),
          )
          .slice(0, query.limit)
          .map((command) => ({
            executionId: command.executionId,
            idempotencyKey: command.idempotencyKey,
            actionDigest: command.actionDigest,
            kind: command.kind,
            name: command.name,
            ...(results.has(command.executionId)
              ? { status: results.get(command.executionId)!.status }
              : {}),
          }));
      },
      scanRetainedExecutionResults(query) {
        return runtime.retainedExecutionResults!({
          runId: context.run.runId,
          limit: query.limit,
        }).map((result) => ({
          ...result,
          tenantId: context.scope.tenantId,
          runId: context.run.runId,
        }));
      },
      canRetire: () => !closed && active === 0 && results.size === 0,
      async close() {
        closed = true;
        for (const reject of pending.values()) reject();
        pending.clear();
        events.push("close");
      },
    };
    return runtime;
  },
};

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.execution",
  setup(context) {
    const execution = context.services.get<PluginExecutionService>(
      CREWON_EXECUTION_SERVICE,
      CREWON_EXECUTION_API_VERSION,
    );
    const registration = execution.register(factory);
    context.onDispose(() => registration.dispose());
  },
});
