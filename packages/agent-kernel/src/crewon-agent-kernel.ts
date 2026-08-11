import {
  parseCanonicalAgentEvent,
  parseProviderCheckpoint,
  parseRateLimitSnapshot,
  type ProviderCheckpoint,
} from "@crewon/contracts";
import {
  type ToolCallKind,
  type ToolCatalogPort,
  type ToolDefinition,
} from "@crewon/tool-broker";

import {
  AgentKernelError,
  type AgentHistoryItem,
  type AgentKernelPort,
  type AgentSegmentContract,
  type KernelAgentEvent,
  type SamplingRetryScheduler,
} from "./agent-kernel-port.ts";
import {
  ModelTransportError,
  type ModelInputItem,
  type ModelRequest,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "./model-transport-port.ts";

const MAX_CONTEXT_MESSAGES = 256;
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const MAX_DELTA_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TOOL_CALLS_PER_SAMPLE = 16;
const MAX_TOOL_INPUT_BYTES = 32 * 1024;
const MAX_MODEL_VISIBLE_TOOL_OUTPUT_BYTES = 40_000;
const DEFAULT_STREAM_MAX_RETRIES = 5;
const MAX_STREAM_MAX_RETRIES = 100;
const INITIAL_RETRY_DELAY_MS = 200;
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1_000;
const EMPTY_TOOL_CATALOG: ToolCatalogPort = { definitions: () => [] };
const PLAN_MODE_INSTRUCTIONS = `<collaboration_mode>
You are in Plan mode for this Run. Investigate with read-only tools only. Do not modify files, configuration, data, deployments, or external state. Resolve material ambiguities before presenting the plan. Your final answer must contain exactly one non-empty <proposed_plan>...</proposed_plan> block and no text outside that block. The plan must be decision-complete, identify affected components, ordered implementation steps, compatibility and migration concerns, tests, rollout, rollback, and remaining risks. Do not claim implementation has occurred.
</collaboration_mode>`;

export class CrewONAgentKernel implements AgentKernelPort {
  readonly #transport: ModelTransportPort;
  readonly #instructions: string | null;
  readonly #toolDefinitions: readonly ToolDefinition[];
  readonly #streamMaxRetries: number;
  readonly #retryScheduler: SamplingRetryScheduler;
  readonly #retryRandom: () => number;
  readonly modelIdentity: AgentKernelPort["modelIdentity"];

  constructor(dependencies: {
    transport: ModelTransportPort;
    instructions?: string | null;
    toolCatalog?: ToolCatalogPort;
    streamMaxRetries?: number;
    retryScheduler?: SamplingRetryScheduler;
    retryRandom?: () => number;
  }) {
    this.#transport = dependencies.transport;
    this.#instructions = optionalBoundedInstructions(dependencies.instructions);
    this.#toolDefinitions = structuredClone(
      (dependencies.toolCatalog ?? EMPTY_TOOL_CATALOG).definitions(),
    );
    this.#streamMaxRetries = nonNegativeIntegerAtMost(
      dependencies.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES,
      MAX_STREAM_MAX_RETRIES,
      "stream_max_retries_invalid",
    );
    this.#retryScheduler = dependencies.retryScheduler ?? systemRetryScheduler;
    this.#retryRandom = dependencies.retryRandom ?? Math.random;
    this.modelIdentity = Object.freeze({
      adapterName: requireNonEmpty(
        dependencies.transport.adapterName,
        "model_adapter_name_invalid",
      ),
      adapterVersion: requireNonEmpty(
        dependencies.transport.adapterVersion,
        "model_adapter_version_invalid",
      ),
      modelId: requireNonEmpty(
        dependencies.transport.modelId,
        "model_id_invalid",
      ),
    });
  }

  async *runSegment(
    contract: AgentSegmentContract,
    signal: AbortSignal,
  ): AsyncIterable<KernelAgentEvent> {
    validateContract(contract);
    if (
      contract.reconcileCheckpoint !== undefined &&
      this.#transport.supportsResponseRetrieve !== true
    ) {
      throw new AgentKernelError(
        "provider_response_retrieve_unsupported",
        false,
      );
    }
    throwIfAborted(signal);
    let sequence = 1;
    yield canonicalEvent(contract, sequence, "segment.started", {
      attempt: contract.attempt,
      model: requireNonEmpty(this.#transport.modelId, "model_id_invalid"),
    });

    const input = modelInput(contract);
    const tools = modelTools(contract, this.#toolDefinitions);
    const observedCallIds = new Set(
      contract.history
        .filter((item) => item.type === "tool_call")
        .map((item) => item.callId),
    );
    {
      let request: ModelRequest = {
        schemaVersion: "crewon.model-request.v0",
        runId: contract.runId,
        segmentId: contract.segmentId,
        agentVersionId: contract.agentVersionId,
        instructions: modelInstructions(
          this.#instructions,
          contract.collaborationMode,
        ),
        input,
        tools,
        maxOutputBytes: contract.budget.maxOutputBytes,
        ...(contract.reconcileCheckpoint === undefined
          ? {}
          : { reconcileCheckpoint: contract.reconcileCheckpoint }),
      };
      let completedOutput = "";
      let completedCheckpoint: ProviderCheckpoint | null = null;
      let completedToolCalls: ObservedToolCall[] = [];
      let completedAssistantItems: string[] = [];
      let createdCheckpoint: ProviderCheckpoint | null = null;
      let retries = 0;
      while (true) {
        let output = "";
        let usageSeen = false;
        let terminalSeen = false;
        let providerRequestsContinuation = false;
        const completedItems: ModelInputItem[] = [];
        const toolCalls: ObservedToolCall[] = [];
        try {
          for await (const event of this.#transport.stream(request, signal)) {
            throwIfAborted(signal);
            if (terminalSeen) {
              throw new AgentKernelError("model_event_after_terminal", false);
            }
            switch (event.type) {
              case "response.created":
                validateCheckpoint(event.checkpoint, this.modelIdentity);
                if (createdCheckpoint !== null) {
                  if (
                    JSON.stringify(createdCheckpoint) !==
                    JSON.stringify(event.checkpoint)
                  ) {
                    throw new AgentKernelError(
                      "provider_response_checkpoint_mismatch",
                      false,
                    );
                  }
                  break;
                }
                createdCheckpoint = event.checkpoint;
                sequence += 1;
                yield canonicalEvent(
                  contract,
                  sequence,
                  "segment.provider_response_created",
                  { checkpoint: event.checkpoint },
                );
                break;
              case "output.delta":
                validateDelta(event.delta);
                output += event.delta;
                if (byteLength(output) > contract.budget.maxOutputBytes) {
                  throw new AgentKernelError(
                    "model_output_budget_exceeded",
                    false,
                  );
                }
                sequence += 1;
                yield canonicalEvent(contract, sequence, "model.output.delta", {
                  delta: event.delta,
                });
                break;
              case "output.item.completed":
                if (event.item.type === "message") {
                  const completedAssistantOutput = completedItems
                    .filter(
                      (
                        item,
                      ): item is Extract<ModelInputItem, { type: "message" }> =>
                        item.type === "message",
                    )
                    .map((item) => item.content)
                    .join("");
                  if (
                    event.item.role !== "assistant" ||
                    completedAssistantOutput + event.item.content !== output
                  ) {
                    throw new AgentKernelError(
                      "model_output_item_completed_invalid",
                      false,
                    );
                  }
                } else if (event.item.type === "tool_call") {
                  const completedToolItem = event.item;
                  const observedToolCall: ObservedToolCall = {
                    type: "tool.call",
                    kind: completedToolItem.kind,
                    callId: completedToolItem.callId,
                    name: completedToolItem.name,
                    input: completedToolItem.input,
                  };
                  if (contract.purpose === "compaction") {
                    throw new AgentKernelError(
                      "compaction_tool_call_unsupported",
                      false,
                    );
                  }
                  validateToolCall(observedToolCall);
                  if (
                    completedItems.length >= MAX_TOOL_CALLS_PER_SAMPLE ||
                    observedCallIds.has(completedToolItem.callId) ||
                    completedItems.some(
                      (item) =>
                        item.type === "tool_call" &&
                        item.callId === completedToolItem.callId,
                    )
                  ) {
                    throw new AgentKernelError(
                      "model_tool_call_invalid",
                      false,
                    );
                  }
                  toolCalls.push(observedToolCall);
                } else {
                  throw new AgentKernelError(
                    "model_output_item_completed_invalid",
                    false,
                  );
                }
                completedItems.push(event.item);
                break;
              case "usage":
                if (usageSeen) {
                  throw new AgentKernelError("model_usage_duplicate", false);
                }
                validateUsage(event);
                usageSeen = true;
                sequence += 1;
                yield canonicalEvent(contract, sequence, "usage.recorded", {
                  inputTokens: event.inputTokens,
                  cachedInputTokens: event.cachedInputTokens ?? 0,
                  outputTokens: event.outputTokens,
                  totalTokens: event.totalTokens,
                });
                break;
              case "rate_limit":
                parseRateLimitSnapshot(event.snapshot);
                sequence += 1;
                yield canonicalEvent(contract, sequence, "rate_limit.updated", {
                  snapshot: event.snapshot,
                });
                break;
              case "transport.fallback": {
                const discardedOutput = output.length > 0;
                if (event.discardedOutput !== discardedOutput) {
                  throw new AgentKernelError(
                    "model_transport_fallback_discard_invalid",
                    false,
                  );
                }
                sequence += 1;
                yield canonicalEvent(
                  contract,
                  sequence,
                  "model.transport.fallback",
                  {
                    fromTransport: requireNonEmpty(
                      event.fromTransport,
                      "model_transport_from_invalid",
                    ),
                    toTransport: requireNonEmpty(
                      event.toTransport,
                      "model_transport_to_invalid",
                    ),
                    code: requireNonEmpty(
                      event.code,
                      "model_transport_fallback_code_invalid",
                    ),
                    discardedOutput,
                  },
                );
                output = "";
                usageSeen = false;
                toolCalls.length = 0;
                retries = 0;
                break;
              }
              case "tool.call":
                if (contract.purpose === "compaction") {
                  throw new AgentKernelError(
                    "compaction_tool_call_unsupported",
                    false,
                  );
                }
                validateToolCall(event);
                if (
                  toolCalls.length >= MAX_TOOL_CALLS_PER_SAMPLE ||
                  observedCallIds.has(event.callId) ||
                  toolCalls.some((call) => call.callId === event.callId)
                ) {
                  throw new AgentKernelError("model_tool_call_invalid", false);
                }
                toolCalls.push(event);
                break;
              case "completed":
                validateCheckpoint(event.checkpoint, this.modelIdentity);
                completedCheckpoint = event.checkpoint;
                providerRequestsContinuation = event.endTurn === false;
                terminalSeen = true;
                break;
              case "failed":
                requireNonEmpty(event.code, "model_failure_code_invalid");
                if (event.retryable) {
                  throw new AgentKernelError(event.code, true);
                }
                sequence += 1;
                yield canonicalEvent(contract, sequence, "segment.failed", {
                  code: event.code,
                  retryable: event.retryable,
                });
                return;
            }
          }
          if (!terminalSeen) {
            throw new AgentKernelError("model_stream_incomplete", true);
          }
          if (providerRequestsContinuation) {
            const completedAssistantOutput = completedItems
              .filter(
                (item): item is Extract<ModelInputItem, { type: "message" }> =>
                  item.type === "message",
              )
              .map((item) => item.content)
              .join("");
            if (
              output.length > 0 &&
              completedAssistantOutput !== output
            ) {
              throw new AgentKernelError(
                "model_end_turn_false_output_unsupported",
                false,
              );
            }
            if (
              toolCalls.length === 0 &&
              (output.length > 0 || completedItems.length > 0)
            ) {
              throw new AgentKernelError(
                "model_end_turn_false_output_unsupported",
                false,
              );
            }
            if (
              request.reconcileCheckpoint !== undefined ||
              createdCheckpoint !== null ||
              completedCheckpoint !== null
            ) {
              throw new AgentKernelError(
                "model_end_turn_false_stored_response_unsupported",
                false,
              );
            }
            completedCheckpoint = null;
            createdCheckpoint = null;
            retries = 0;
            if (toolCalls.length > 0) {
              completedOutput = output;
              completedToolCalls = toolCalls;
              completedAssistantItems = completedItems
                .filter(
                  (
                    item,
                  ): item is Extract<ModelInputItem, { type: "message" }> =>
                    item.type === "message",
                )
                .map((item) => item.content);
              break;
            }
            continue;
          }
          completedOutput = output;
          completedToolCalls = toolCalls;
          completedAssistantItems = completedItems
            .filter(
              (item): item is Extract<ModelInputItem, { type: "message" }> =>
                item.type === "message",
            )
            .map((item) => item.content);
          break;
        } catch (error) {
          const kernelError = normalizeSamplingError(error, signal);
          if (!kernelError.retryable) {
            throw kernelError;
          }
          const completedToolCalls = completedItems.filter(
            (item): item is Extract<ModelInputItem, { type: "tool_call" }> =>
              item.type === "tool_call",
          );
          if (completedToolCalls.length > 0) {
            const completedAssistantItems = completedItems
              .filter(
                (item): item is Extract<ModelInputItem, { type: "message" }> =>
                  item.type === "message",
              )
              .map((item) => item.content);
            for (const call of completedToolCalls) {
              observedCallIds.add(call.callId);
              sequence += 1;
              yield canonicalEvent(contract, sequence, "tool.requested", {
                callId: call.callId,
                kind: call.kind,
                name: call.name,
                input: call.input,
                ...(completedAssistantItems.length > 0
                  ? { completedAssistantItems: [...completedAssistantItems] }
                  : {}),
              });
              completedAssistantItems.length = 0;
            }
            return;
          }
          if (retries >= this.#streamMaxRetries) {
            if (createdCheckpoint !== null) {
              throw kernelError;
            }
            throw exhaustedSamplingError(kernelError);
          }
          retries += 1;
          if (createdCheckpoint !== null) {
            request = {
              ...request,
              reconcileCheckpoint: createdCheckpoint,
            };
          }
          if (completedItems.length > 0) {
            request = appendCompletedItems(request, completedItems);
          }
          sequence += 1;
          yield canonicalEvent(contract, sequence, "model.sampling.retry", {
            samplingAttempt: retries,
            maxRetries: this.#streamMaxRetries,
            code: kernelError.code,
            discardedOutput: output.length > 0,
          });
          try {
            await this.#retryScheduler.wait(
              retryDelayMs(kernelError, retries, this.#retryRandom),
              signal,
            );
          } catch (retryError) {
            throw normalizeSamplingError(retryError, signal);
          }
          throwIfAborted(signal);
        }
      }

      if (completedToolCalls.length === 0) {
        if (completedCheckpoint !== null) {
          sequence += 1;
          yield canonicalEvent(contract, sequence, "segment.checkpointed", {
            checkpoint: completedCheckpoint,
          });
        }
        sequence += 1;
        yield canonicalEvent(contract, sequence, "segment.completed", {
          output: completedOutput,
        });
        return;
      }
      if (
        completedOutput.length > 0 &&
        completedAssistantItems.join("") !== completedOutput
      ) {
        throw new AgentKernelError(
          "model_tool_call_with_text_unsupported",
          false,
        );
      }
      for (const call of completedToolCalls) {
        observedCallIds.add(call.callId);
        sequence += 1;
        yield canonicalEvent(contract, sequence, "tool.requested", {
          callId: call.callId,
          kind: call.kind,
          name: call.name,
          input: call.input,
          ...(completedAssistantItems.length > 0
            ? { completedAssistantItems: [...completedAssistantItems] }
            : {}),
        });
        completedAssistantItems.length = 0;
      }
      if (completedCheckpoint !== null) {
        sequence += 1;
        yield canonicalEvent(contract, sequence, "segment.checkpointed", {
          checkpoint: completedCheckpoint,
        });
      }
      return;
    }
  }
}

function appendCompletedItems(
  request: ModelRequest,
  items: readonly ModelInputItem[],
): ModelRequest {
  const input = request.input;
  return {
    ...request,
    input: { ...input, items: [...input.items, ...items] },
  };
}

function optionalBoundedInstructions(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.trim().length === 0 || byteLength(value) > MAX_INSTRUCTIONS_BYTES) {
    throw new AgentKernelError("agent_instructions_invalid", false);
  }
  return value;
}

type ObservedToolCall = Extract<ModelTransportEvent, { type: "tool.call" }>;

function validateToolCall(call: ObservedToolCall): void {
  requireNonEmpty(call.callId, "model_tool_call_id_invalid");
  requireNonEmpty(call.name, "model_tool_name_invalid");
  if (call.kind !== "function" && call.kind !== "custom") {
    throw new AgentKernelError("model_tool_kind_invalid", false);
  }
  if (
    typeof call.input !== "string" ||
    byteLength(call.input) > MAX_TOOL_INPUT_BYTES
  ) {
    throw new AgentKernelError("model_tool_input_invalid", false);
  }
}

function exhaustedSamplingError(error: AgentKernelError): AgentKernelError {
  return new AgentKernelError(error.code, false, {
    cause: error,
    retryAfterMs: error.retryAfterMs,
  });
}

function normalizeSamplingError(
  error: unknown,
  signal: AbortSignal,
): AgentKernelError {
  throwIfAborted(signal);
  if (error instanceof AgentKernelError) {
    return error;
  }
  if (error instanceof ModelTransportError) {
    return new AgentKernelError(error.code, error.retryable, {
      cause: error,
      retryAfterMs: error.retryAfterMs,
    });
  }
  return new AgentKernelError("model_transport_failed", true, {
    cause: error,
  });
}

function retryDelayMs(
  error: AgentKernelError,
  retry: number,
  random: () => number,
): number {
  if (error.retryAfterMs !== undefined) {
    return nonNegativeIntegerAtMost(
      error.retryAfterMs,
      MAX_TIMER_DELAY_MS,
      "model_retry_after_invalid",
    );
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new AgentKernelError("sampling_retry_random_invalid", false);
  }
  const base = Math.min(
    INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, retry - 1),
    MAX_TIMER_DELAY_MS,
  );
  return Math.floor(base * (0.9 + sample * 0.2));
}

const systemRetryScheduler: SamplingRetryScheduler = {
  wait: (delayMs, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(handle);
        reject(signal.reason);
      };
      const handle = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

function canonicalEvent<T extends KernelAgentEvent["type"]>(
  contract: AgentSegmentContract,
  sequence: number,
  type: T,
  data: Extract<KernelAgentEvent, { type: T }>["data"],
): Extract<KernelAgentEvent, { type: T }> {
  const event = {
    schemaVersion: "crewon.agent-event.v0" as const,
    runId: contract.runId,
    segmentId: contract.segmentId,
    sequence,
    type,
    data,
  } as unknown as Extract<KernelAgentEvent, { type: T }>;
  parseCanonicalAgentEvent(event);
  return event;
}

function validateContract(contract: AgentSegmentContract): void {
  if (
    !isPlainObject(contract) ||
    contract.schemaVersion !== "crewon.agent-segment.v0"
  ) {
    throw new AgentKernelError("segment_contract_invalid", false);
  }
  requireNonEmpty(contract.runId, "run_id_invalid");
  if (contract.purpose !== "agent" && contract.purpose !== "compaction") {
    throw new AgentKernelError("segment_purpose_invalid", false);
  }
  requireNonEmpty(contract.segmentId, "segment_id_invalid");
  requireNonEmpty(contract.agentVersionId, "agent_version_id_invalid");
  requireNonEmpty(contract.policySnapshotId, "policy_snapshot_id_invalid");
  if (
    contract.collaborationMode !== "default" &&
    contract.collaborationMode !== "plan"
  ) {
    throw new AgentKernelError("collaboration_mode_invalid", false);
  }
  validateAllowedTools(contract.allowedTools);
  validateRuntimeTools(contract.runtimeTools ?? []);
  if (!Number.isSafeInteger(contract.attempt) || contract.attempt < 1) {
    throw new AgentKernelError("segment_attempt_invalid", false);
  }
  if (
    !isPlainObject(contract.budget) ||
    !Number.isSafeInteger(contract.budget.maxOutputBytes) ||
    contract.budget.maxOutputBytes < 1 ||
    contract.budget.maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new AgentKernelError("segment_output_budget_invalid", false);
  }
  if (
    !Array.isArray(contract.history) ||
    contract.history.length === 0 ||
    contract.history.length > MAX_CONTEXT_MESSAGES
  ) {
    throw new AgentKernelError("segment_history_invalid", false);
  }
  let totalBytes = 0;
  const pendingCalls = new Map<string, ToolCallKind>();
  const observedHistoryCallIds = new Set<string>();
  for (const item of contract.history) {
    totalBytes += validateHistoryItem(
      item,
      pendingCalls,
      observedHistoryCallIds,
    );
    if (totalBytes > MAX_CONTEXT_BYTES) {
      throw new AgentKernelError("segment_context_too_large", false);
    }
  }
  if (pendingCalls.size > 0) {
    throw new AgentKernelError("segment_history_tool_result_missing", false);
  }
  if (!isPlainObject(contract.continuation)) {
    throw new AgentKernelError("segment_continuation_invalid", false);
  }
  if (contract.continuation.kind === "manual") {
    return;
  }
  if (contract.continuation.kind !== "providerCheckpoint") {
    throw new AgentKernelError("segment_continuation_invalid", false);
  }
  try {
    parseProviderCheckpoint(contract.continuation.checkpoint);
  } catch (error) {
    throw new AgentKernelError("provider_checkpoint_invalid", false, {
      cause: error,
    });
  }
  if (
    !Number.isSafeInteger(contract.continuation.newHistoryStartIndex) ||
    contract.continuation.newHistoryStartIndex < 0 ||
    contract.continuation.newHistoryStartIndex >= contract.history.length
  ) {
    throw new AgentKernelError("new_message_start_index_invalid", false);
  }
}

function validateAllowedTools(
  tools: AgentSegmentContract["allowedTools"],
): void {
  if (tools === null) return;
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_CALLS_PER_SAMPLE) {
    throw new AgentKernelError("allowed_tools_invalid", false);
  }
  const identities = new Set<string>();
  for (const tool of tools) {
    if (
      !isPlainObject(tool) ||
      (tool.kind !== "function" && tool.kind !== "custom") ||
      typeof tool.name !== "string"
    ) {
      throw new AgentKernelError("allowed_tools_invalid", false);
    }
    requireNonEmpty(tool.name, "allowed_tools_invalid");
    const identity = `${tool.kind}:${tool.name}`;
    if (identities.has(identity)) {
      throw new AgentKernelError("allowed_tools_invalid", false);
    }
    identities.add(identity);
  }
}

function modelTools(
  contract: AgentSegmentContract,
  definitions: readonly ToolDefinition[],
): ToolDefinition[] {
  if (contract.purpose !== "agent") return [];
  const merged = [...definitions, ...(contract.runtimeTools ?? [])];
  const identities = new Set<string>();
  for (const definition of merged) {
    const identity = `${definition.kind}:${definition.name}`;
    if (identities.has(identity)) {
      throw new AgentKernelError("runtime_tool_identity_conflict", false);
    }
    identities.add(identity);
  }
  if (contract.allowedTools === null) {
    return structuredClone(merged);
  }
  const allowed = new Set(
    contract.allowedTools.map((tool) => `${tool.kind}:${tool.name}`),
  );
  return structuredClone(
    merged.filter((tool) => allowed.has(`${tool.kind}:${tool.name}`)),
  );
}

function validateRuntimeTools(tools: readonly ToolDefinition[]): void {
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_CALLS_PER_SAMPLE) {
    throw new AgentKernelError("runtime_tools_invalid", false);
  }
  const identities = new Set<string>();
  for (const tool of tools) {
    if (
      !isPlainObject(tool) ||
      tool.schemaVersion !== "crewon.tool-definition.v0" ||
      (tool.kind !== "function" && tool.kind !== "custom") ||
      (tool.execution !== "serial" && tool.execution !== "parallel") ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      (tool.kind === "function" && !isPlainObject(tool.inputSchema)) ||
      (tool.kind === "custom" && tool.inputFormat !== "text")
    ) {
      throw new AgentKernelError("runtime_tools_invalid", false);
    }
    requireNonEmpty(tool.name, "runtime_tools_invalid");
    requireNonEmpty(tool.description, "runtime_tools_invalid");
    const identity = `${tool.kind}:${tool.name}`;
    if (identities.has(identity)) {
      throw new AgentKernelError("runtime_tools_invalid", false);
    }
    identities.add(identity);
  }
}

function modelInstructions(
  instructions: string | null,
  collaborationMode: AgentSegmentContract["collaborationMode"],
): string | null {
  if (collaborationMode === "default") return instructions;
  return instructions === null
    ? PLAN_MODE_INSTRUCTIONS
    : `${instructions}\n\n${PLAN_MODE_INSTRUCTIONS}`;
}

function validateHistoryItem(
  item: AgentHistoryItem,
  pendingCalls: Map<string, ToolCallKind>,
  observedCallIds: Set<string>,
): number {
  if (!isPlainObject(item)) {
    throw new AgentKernelError("segment_history_item_invalid", false);
  }
  switch (item.type) {
    case "message":
      if (
        (item.role !== "user" &&
          item.role !== "assistant" &&
          item.role !== "developer" &&
          item.role !== "system") ||
        typeof item.content !== "string"
      ) {
        throw new AgentKernelError("segment_history_message_invalid", false);
      }
      requireNonEmpty(item.content, "segment_history_message_invalid");
      return byteLength(item.content);
    case "tool_call":
      if (
        (item.kind !== "function" && item.kind !== "custom") ||
        typeof item.input !== "string"
      ) {
        throw new AgentKernelError("segment_history_tool_call_invalid", false);
      }
      requireNonEmpty(item.callId, "segment_history_tool_call_invalid");
      requireNonEmpty(item.name, "segment_history_tool_call_invalid");
      if (
        byteLength(item.input) > MAX_TOOL_INPUT_BYTES ||
        observedCallIds.has(item.callId)
      ) {
        throw new AgentKernelError("segment_history_tool_call_invalid", false);
      }
      observedCallIds.add(item.callId);
      pendingCalls.set(item.callId, item.kind);
      return byteLength(item.input);
    case "tool_result": {
      if (
        (item.kind !== "function" && item.kind !== "custom") ||
        typeof item.output !== "string" ||
        byteLength(item.output) > MAX_MODEL_VISIBLE_TOOL_OUTPUT_BYTES
      ) {
        throw new AgentKernelError(
          "segment_history_tool_result_invalid",
          false,
        );
      }
      requireNonEmpty(item.callId, "segment_history_tool_result_invalid");
      const kind = pendingCalls.get(item.callId);
      if (kind === undefined || kind !== item.kind) {
        throw new AgentKernelError(
          "segment_history_tool_result_orphaned",
          false,
        );
      }
      pendingCalls.delete(item.callId);
      return byteLength(item.output);
    }
  }
}

function modelInput(contract: AgentSegmentContract): ModelRequest["input"] {
  const items = contract.history.map((item): ModelInputItem => ({ ...item }));
  if (contract.continuation.kind === "manual") {
    return { strategy: "manual", items };
  }
  return {
    strategy: "providerCheckpoint",
    checkpoint: structuredClone(contract.continuation.checkpoint),
    items,
    newHistoryStartIndex: contract.continuation.newHistoryStartIndex,
  };
}

function validateCheckpoint(
  checkpoint: ProviderCheckpoint | null,
  identity: AgentKernelPort["modelIdentity"],
): void {
  if (checkpoint === null) {
    return;
  }
  try {
    parseProviderCheckpoint(checkpoint);
  } catch (error) {
    throw new AgentKernelError("model_checkpoint_invalid", false, {
      cause: error,
    });
  }
  if (
    checkpoint.adapterName !== identity.adapterName ||
    checkpoint.adapterVersion !== identity.adapterVersion ||
    checkpoint.modelId !== identity.modelId
  ) {
    throw new AgentKernelError("model_checkpoint_identity_mismatch", false);
  }
}

function validateDelta(delta: string): void {
  requireNonEmpty(delta, "model_output_delta_invalid");
  if (byteLength(delta) > MAX_DELTA_BYTES) {
    throw new AgentKernelError("model_output_delta_too_large", false);
  }
}

function validateUsage(
  event: Extract<ModelTransportEvent, { type: "usage" }>,
): void {
  for (const value of [
    event.inputTokens,
    event.cachedInputTokens ?? 0,
    event.outputTokens,
    event.totalTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AgentKernelError("model_usage_invalid", false);
    }
  }
  if (event.totalTokens !== event.inputTokens + event.outputTokens) {
    throw new AgentKernelError("model_usage_total_mismatch", false);
  }
  if ((event.cachedInputTokens ?? 0) > event.inputTokens) {
    throw new AgentKernelError("model_usage_cached_input_exceeds_input", false);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AgentKernelError("segment_canceled", false, {
      cause: signal.reason,
    });
  }
}

function requireNonEmpty(value: string, code: string): string {
  if (value.trim().length === 0) {
    throw new AgentKernelError(code, false);
  }
  return value;
}

function nonNegativeIntegerAtMost(
  value: number,
  max: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new AgentKernelError(code, false);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
