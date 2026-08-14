import {
  AgentKernelError,
  type AgentKernelPort,
} from "@crewon/agent-kernel/runtime";
import {
  CONTEXT_COMPACTION_PROMPT,
  type ContextCompactionContract,
  type ContextCompactionResult,
  type ContextCompactorPort,
} from "@crewon/context";

/** Executes one Tool-free bounded Kernel segment and returns only its compaction result. */
export class KernelContextCompactor implements ContextCompactorPort {
  readonly #kernel: AgentKernelPort;

  constructor(kernel: AgentKernelPort) {
    this.#kernel = kernel;
  }

  async compact(
    contract: ContextCompactionContract,
    signal: AbortSignal,
  ): Promise<ContextCompactionResult> {
    let history = [...contract.history];
    while (true) {
      try {
        return await this.#compactOnce({ ...contract, history }, signal);
      } catch (error) {
        if (!isContextWindowExceeded(error) || history.length === 0) {
          throw error;
        }
        history = history.slice(1);
      }
    }
  }

  async #compactOnce(
    contract: ContextCompactionContract,
    signal: AbortSignal,
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
