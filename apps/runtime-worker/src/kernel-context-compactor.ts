import { AgentKernelError, type AgentKernelPort } from "@crewon/agent-kernel";
import {
  CONTEXT_COMPACTION_PROMPT,
  type ContextCompactionContract,
  type ContextCompactionResult,
  type ContextCompactorPort,
} from "@crewon/context";
import {
  MAX_COMPACTION_CONTEXT_ATTEMPTS,
  nextCompactionRecoveryHistory,
  validateCompactionPrefix,
} from "./compaction-recovery-history.ts";

/** Runs Tool-free compaction with bounded recovery from context overflow. */
export class KernelContextCompactor implements ContextCompactorPort {
  readonly #kernel: AgentKernelPort;

  constructor(kernel: AgentKernelPort) {
    this.#kernel = kernel;
  }

  async compact(
    contract: ContextCompactionContract,
    signal: AbortSignal,
    options?: Parameters<ContextCompactorPort["compact"]>[2],
  ): Promise<ContextCompactionResult> {
    signal.throwIfAborted();
    const protectedPrefixLength = contract.protectedPrefixLength ?? 0;
    validateCompactionPrefix(contract.history, protectedPrefixLength);
    if (contract.history.length === protectedPrefixLength) {
      throw new AgentKernelError("compaction_source_empty", false);
    }
    let history = contract.history;
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await this.#compactOnce(
          { ...contract, history },
          signal,
          options,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (
          !isContextWindowExceeded(error) ||
          attempt >= MAX_COMPACTION_CONTEXT_ATTEMPTS
        ) {
          throw error;
        }
        const next = nextCompactionRecoveryHistory(
          history,
          protectedPrefixLength,
        );
        if (next === null) throw error;
        history = next;
      }
    }
  }

  async #compactOnce(
    contract: ContextCompactionContract,
    signal: AbortSignal,
    options?: Parameters<ContextCompactorPort["compact"]>[2],
  ): Promise<ContextCompactionResult> {
    let output = "";
    let usage: ContextCompactionResult["usage"] | null = null;
    let completed = false;
    for await (const event of this.#kernel.runSegment(
      {
        schemaVersion: "crewon.agent-segment.v0",
        purpose: "compaction",
        runId: contract.runId,
        segmentId: contract.segmentId,
        attempt: contract.attempt,
        agentVersionId: contract.agentVersionId,
        policySnapshotId: contract.policySnapshotId,
        collaborationMode: "default",
        allowedTools: null,
        history: [
          ...contract.history,
          {
            type: "message",
            role: "user",
            content: CONTEXT_COMPACTION_PROMPT,
          },
        ],
        continuation: { kind: "manual" },
        budget: { maxOutputBytes: contract.maxOutputBytes },
      },
      signal,
      options,
    )) {
      switch (event.type) {
        case "segment.started":
        case "rate_limit.updated":
        case "segment.checkpointed":
        case "segment.provider_response_created":
          break;
        case "model.sampling.retry":
          if (event.data.discardedOutput) {
            output = "";
          }
          usage = null;
          break;
        case "model.transport.fallback":
          if (event.data.discardedOutput) {
            output = "";
          }
          usage = null;
          break;
        case "model.output.delta":
          output += event.data.delta;
          break;
        case "usage.recorded":
          usage = event.data;
          break;
        case "segment.completed":
          if (event.data.output !== output) {
            throw new AgentKernelError("compaction_output_mismatch", false);
          }
          completed = true;
          break;
        case "segment.failed":
          throw new AgentKernelError(event.data.code, event.data.retryable);
        case "tool.requested":
        case "tool.completed":
          throw new AgentKernelError("compaction_tool_call_unsupported", false);
      }
    }
    if (!completed || output.trim().length === 0 || usage === null) {
      throw new AgentKernelError("compaction_result_incomplete", false);
    }
    return { summary: output, usage };
  }
}

function isContextWindowExceeded(error: unknown): boolean {
  return (
    error instanceof AgentKernelError &&
    error.code === "responses_provider_context_length_exceeded"
  );
}
