import type {
  AgentKernelPort,
  AgentSegmentContract,
  AgentSegmentControlSink,
  KernelAgentEvent,
} from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts";
import { AgentSegmentStateMachine } from "./agent-segment-state-machine.ts";

export type AgentSegmentExecutionResult = Readonly<{
  segment: AgentSegmentStateMachine;
  canceled: boolean;
}>;

/**
 * Durable authority used while consuming one Agent kernel segment.
 *
 * Implementations fence every write to their supplied execution identity and
 * must not create a new Step or Attempt. This lets ordinary Runs and admitted
 * Workflow nodes share the exact model/event loop without sharing ownership of
 * their terminal settlement.
 */
export interface AgentSegmentExecutionAuthority {
  renewLease(): Promise<void>;
  cancellationRequested(): Promise<boolean>;
  checkpointProviderResponse(checkpoint: ProviderCheckpoint): Promise<void>;
  persistImmediateEvent(
    event: Extract<
      KernelAgentEvent,
      { type: "segment.started" | "rate_limit.updated" }
    >,
  ): Promise<void>;
  recordProviderTurnState(providerTurnState: string): Promise<void>;
}

/** Executes the provider-neutral portion of one bounded Agent segment. */
export class AgentSegmentExecutionEngine {
  async execute(input: {
    kernel: AgentKernelPort;
    contract: AgentSegmentContract;
    signal: AbortSignal;
    providerTurnState: string | null;
    authority: AgentSegmentExecutionAuthority;
    controlSink?: Pick<
      AgentSegmentControlSink,
      "modelRequestPrepared" | "dispatchBoundaryCrossed"
    >;
  }): Promise<AgentSegmentExecutionResult> {
    const segment = new AgentSegmentStateMachine(input.providerTurnState);
    for await (const event of input.kernel.runSegment(
      input.contract,
      input.signal,
      {
        controlSink: {
          ...input.controlSink,
          providerTurnStateObserved: async (providerTurnState) => {
            await input.authority.recordProviderTurnState(providerTurnState);
            segment.providerTurnState = providerTurnState;
          },
        },
      },
    )) {
      await input.authority.renewLease();
      if (await input.authority.cancellationRequested()) {
        return { segment, canceled: true };
      }
      const action = segment.accept(event);
      if (action.kind === "checkpointProviderResponse") {
        await input.authority.checkpointProviderResponse(action.checkpoint);
      } else if (action.kind === "persistEvent") {
        await input.authority.persistImmediateEvent(action.event);
      } else if (event.type === "segment.failed") {
        break;
      }
    }
    return { segment, canceled: false };
  }
}
