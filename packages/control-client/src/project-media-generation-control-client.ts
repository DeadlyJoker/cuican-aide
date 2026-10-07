import {
  parseGenerateProjectMediaRequest,
  parseGenerateProjectMediaResponse,
  MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES,
  type GenerateProjectMediaRequest,
  type GenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import {
  parseProjectMediaGenerationRecoveryRequest,
  parseProjectMediaGenerationRecoveryResponse,
} from "@crewon/contracts/project-media-generation-recovery";
import type {
  CreativeProjectControlTransport,
  CreativeProjectControlRequestOptions,
} from "./creative-project-control-client.ts";

/** Original authenticated transport, one bounded attempt. Recovery reads never dispatch a task. */
export class ProjectMediaGenerationControlClient {
  readonly #transport: CreativeProjectControlTransport;
  constructor(transport: CreativeProjectControlTransport) {
    this.#transport = transport;
  }
  async getRecovery(
    input: ReturnType<typeof parseProjectMediaGenerationRecoveryRequest>,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const command = this.#checked("request", () =>
      parseProjectMediaGenerationRecoveryRequest(input),
    );
    const signal = this.#signal(options);
    signal.throwIfAborted();
    const value = await this.#transport.json(
      "GET",
      `/api/v1/creative-projects/${encodeURIComponent(command.projectId)}/threads/${encodeURIComponent(command.threadId)}/media-generation-recovery`,
      undefined,
      {
        signal,
        expectedStatuses: [200],
        maximumResponseBytes: 4096,
        redirect: "manual",
      },
    );
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parseProjectMediaGenerationRecoveryResponse(value),
    );
  }
  async generate(
    input: GenerateProjectMediaRequest,
    options: CreativeProjectControlRequestOptions = {},
  ): Promise<GenerateProjectMediaResponse> {
    const command = this.#checked("request", () =>
        parseGenerateProjectMediaRequest(input),
      ),
      signal = this.#signal(options);
    signal.throwIfAborted();
    const { projectId, idempotencyKey, ...body } = command;
    const value = await this.#transport.json(
      "POST",
      `/api/v1/creative-projects/${encodeURIComponent(projectId)}/media-generations`,
      body,
      {
        signal,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES,
        redirect: "manual",
        requireCsrf: true,
        requireIdempotency: true,
        idempotencyKey,
      },
    );
    // A received durable receipt remains useful even if cancellation raced with delivery.
    return this.#checked("response", () =>
      parseGenerateProjectMediaResponse(command, value),
    );
  }
  #signal(input: CreativeProjectControlRequestOptions): AbortSignal {
    return this.#checked("request", () => {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some((key) => key !== "signal")
      )
        throw new Error("options_invalid");
      const d = Object.getOwnPropertyDescriptor(input, "signal");
      if (
        d &&
        (!d.enumerable ||
          !Object.hasOwn(d, "value") ||
          (d.value !== undefined && !(d.value instanceof AbortSignal)))
      )
        throw new Error("signal_invalid");
      const signal: AbortSignal | undefined = d?.value;
      signal?.throwIfAborted();
      return signal === undefined
        ? AbortSignal.timeout(90_000)
        : AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    });
  }
  #checked<T>(kind: "request" | "response", work: () => T): T {
    try {
      return work();
    } catch {
      throw this.#transport.protocolError(
        `control_client_project_media_generation_${kind}_invalid`,
      );
    }
  }
}
