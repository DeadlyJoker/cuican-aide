import { AgentKernelError } from "./agent-kernel-port.ts";
import type {
  ModelRequest,
  ModelTransportEvent,
  ModelTransportPort,
} from "./model-transport-port.ts";

export type DeterministicModelScript = Readonly<{
  expectedLastUserMessage: string;
  events: readonly ModelTransportEvent[];
}>;

export class DeterministicFakeModelTransport implements ModelTransportPort {
  readonly adapterName = "deterministic-fake";
  readonly adapterVersion = "1";
  readonly modelId = "fake-model";
  readonly #script: DeterministicModelScript;
  readonly requests: ModelRequest[] = [];

  constructor(script: DeterministicModelScript) {
    this.#script = structuredClone(script);
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelTransportEvent> {
    if (signal.aborted) {
      throw new AgentKernelError("segment_canceled", false);
    }
    if (request.input.strategy !== "manual") {
      throw new AgentKernelError("fake_model_checkpoint_unsupported", false);
    }
    const lastUserMessage = [...request.input.items]
      .reverse()
      .find(
        (
          item,
        ): item is Extract<
          (typeof request.input.items)[number],
          { type: "message" }
        > => item.type === "message" && item.role === "user",
      );
    if (lastUserMessage?.content !== this.#script.expectedLastUserMessage) {
      throw new AgentKernelError("fake_model_request_mismatch", false);
    }
    this.requests.push(structuredClone(request));
    for (const event of this.#script.events) {
      if (signal.aborted) {
        throw new AgentKernelError("segment_canceled", false);
      }
      yield structuredClone(event);
    }
  }
}
