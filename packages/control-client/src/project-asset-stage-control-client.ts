import {
  MAX_PROJECT_ASSET_STAGES_BYTES,
  parseProjectAssetStageRequest,
  parseProjectAssetStageResponse,
  parseProjectAssetStageAvailabilityResponse,
  type ProjectAssetStageAvailabilityResponse,
  projectAssetStagePath,
  type ProjectAssetStageRequest,
  type ProjectAssetStageResponse,
} from "@crewon/contracts/project-asset-stages";
import type { CreativeProjectControlTransport } from "./creative-project-control-client.ts";
export type ProjectAssetStageControlRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
/** Original authenticated transport. Neither the body nor this client creates a stage/Run grant. */
export class ProjectAssetStageControlClient {
  readonly #transport: CreativeProjectControlTransport;
  constructor(transport: CreativeProjectControlTransport) {
    this.#transport = transport;
  }
  async getAvailability(
    threadId: string,
    options: ProjectAssetStageControlRequestOptions = {},
  ): Promise<ProjectAssetStageAvailabilityResponse> {
    const path = this.#input(() => projectAssetStagePath(threadId)),
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
      parseProjectAssetStageAvailabilityResponse(value),
    );
  }
  async startStage(
    threadId: string,
    input: ProjectAssetStageRequest,
    options: ProjectAssetStageControlRequestOptions = {},
  ): Promise<ProjectAssetStageResponse> {
    const request = this.#input(() => {
      const parsed = parseProjectAssetStageRequest(input);
      if (parsed.threadId !== threadId) throw new Error("thread_mismatch");
      return parsed;
    });
    const signal = this.#signal(options);
    signal.throwIfAborted();
    const value = await this.#transport.json(
      "POST",
      projectAssetStagePath(request.threadId),
      request,
      {
        signal,
        maximumResponseBytes: MAX_PROJECT_ASSET_STAGES_BYTES,
        redirect: "manual",
        expectedStatuses: [200, 201],
        requireCsrf: true,
        requireIdempotency: true,
        idempotencyKey: request.idempotencyKey,
      },
    );
    signal.throwIfAborted();
    return this.#output(() => parseProjectAssetStageResponse(request, value));
  }
  #signal(input: ProjectAssetStageControlRequestOptions): AbortSignal {
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
        "control_client_project_asset_stage_request_invalid",
      );
    }
  }
  #output<T>(work: () => T): T {
    try {
      return work();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_asset_stage_response_invalid",
      );
    }
  }
}
