import {
  MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES,
  parseProjectMediaInputStageRequest,
  parseProjectMediaInputStageResponse,
  parseProjectMediaInputStageAvailabilityResponse,
  type ProjectMediaInputStageAvailabilityResponse,
  projectMediaInputStagePath,
  type ProjectMediaInputStageRequest,
  type ProjectMediaInputStageResponse,
} from "@crewon/contracts/project-media-input-stages";
import type { CreativeProjectControlTransport } from "./creative-project-control-client.ts";
export type ProjectMediaInputStageControlRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
/** Original authenticated transport. Neither the body nor this client creates a stage/Run grant. */
export class ProjectMediaInputStageControlClient {
  readonly #transport: CreativeProjectControlTransport;
  constructor(transport: CreativeProjectControlTransport) {
    this.#transport = transport;
  }
  async getAvailability(
    threadId: string,
    options: ProjectMediaInputStageControlRequestOptions = {},
  ): Promise<ProjectMediaInputStageAvailabilityResponse> {
    const path = this.#input(() => projectMediaInputStagePath(threadId)),
      signal = this.#signal(options);
    signal.throwIfAborted();
    const value = await this.#transport.json("GET", path, null, {
      signal,
      maximumResponseBytes: 1024,
      redirect: "manual",
      expectedStatuses: [200],
    });
    signal.throwIfAborted();
    return this.#output(() =>
      parseProjectMediaInputStageAvailabilityResponse(value),
    );
  }
  async startStage(
    threadId: string,
    input: ProjectMediaInputStageRequest,
    options: ProjectMediaInputStageControlRequestOptions = {},
  ): Promise<ProjectMediaInputStageResponse> {
    const request = this.#input(() => {
      const parsed = parseProjectMediaInputStageRequest(input);
      if (parsed.threadId !== threadId) throw new Error("thread_mismatch");
      return parsed;
    });
    const signal = this.#signal(options);
    signal.throwIfAborted();
    const value = await this.#transport.json(
      "POST",
      projectMediaInputStagePath(request.threadId),
      request,
      {
        signal,
        maximumResponseBytes: MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES,
        redirect: "manual",
        expectedStatuses: [200, 201],
        requireCsrf: true,
        requireIdempotency: true,
        idempotencyKey: request.idempotencyKey,
      },
    );
    signal.throwIfAborted();
    return this.#output(() =>
      parseProjectMediaInputStageResponse(request, value),
    );
  }
  #signal(input: ProjectMediaInputStageControlRequestOptions): AbortSignal {
    const signal = this.#input(() => {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw new Error("options_invalid");
      const fields = Object.getOwnPropertyDescriptors(input);
      if (
        Reflect.ownKeys(input).some((key) => key !== "signal") ||
        (fields.signal !== undefined &&
          (!Object.hasOwn(fields.signal, "value") || !fields.signal.enumerable))
      )
        throw new Error("options_invalid");
      const signal: unknown = fields.signal?.value;
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new Error("signal_invalid");
      return signal;
    });
    signal?.throwIfAborted();
    return signal === undefined
      ? AbortSignal.timeout(30_000)
      : AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  }
  #input<T>(work: () => T): T {
    try {
      return work();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_media_input_stage_request_invalid",
      );
    }
  }
  #output<T>(work: () => T): T {
    try {
      return work();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_media_input_stage_response_invalid",
      );
    }
  }
}
