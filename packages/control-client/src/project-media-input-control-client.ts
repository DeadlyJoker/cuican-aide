import {
  parseSaveMediaInputRequest,
  parseLoadMediaInputRequest,
  parseSaveMediaInputResponse,
  parseLoadMediaInputResponse,
  MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES,
  type SaveMediaInputRequest,
  type LoadMediaInputRequest,
  type SaveMediaInputResponse,
  type LoadMediaInputResponse,
} from "@crewon/contracts/project-media-inputs";
import type {
  CreativeProjectControlTransport,
  CreativeProjectControlRequestOptions,
} from "./creative-project-control-client.ts";
import {
  parseMediaInputOptionsRequest,
  parseMediaInputOptionsResponse,
  type MediaInputOptionsRequest,
  type MediaInputOptionsResponse,
} from "@crewon/contracts/project-media-input-catalog";

/** Shared logical input commands over the original authenticated transport; no retry or execution grant. */
export class ProjectMediaInputControlClient {
  readonly #transport: CreativeProjectControlTransport;
  constructor(transport: CreativeProjectControlTransport) {
    this.#transport = transport;
  }
  async getOptions(
    input: MediaInputOptionsRequest,
    options: CreativeProjectControlRequestOptions = {},
  ): Promise<MediaInputOptionsResponse> {
    const query = this.#checked("request", () =>
        parseMediaInputOptionsRequest(input),
      ),
      signal = this.#signal(options);
    signal.throwIfAborted();
    const value = await this.#transport.json(
      "GET",
      `/api/v1/creative-projects/${encodeURIComponent(query.projectId)}/media-input-options`,
      null,
      {
        signal,
        expectedStatuses: [200],
        maximumResponseBytes: 1024,
        redirect: "manual",
      },
    );
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parseMediaInputOptionsResponse(value),
    );
  }
  async saveInput(
    input: SaveMediaInputRequest,
    options: CreativeProjectControlRequestOptions = {},
  ): Promise<SaveMediaInputResponse> {
    const command = this.#checked("request", () =>
        parseSaveMediaInputRequest(input),
      ),
      signal = this.#signal(options);
    signal.throwIfAborted();
    const { projectId, idempotencyKey, ...body } = command;
    const value = await this.#transport.json("POST", path(projectId), body, {
      signal,
      expectedStatuses: [200],
      maximumResponseBytes: MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES,
      redirect: "manual",
      requireCsrf: true,
      requireIdempotency: true,
      idempotencyKey,
    });
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parseSaveMediaInputResponse(command, value),
    );
  }
  async loadInput(
    input: LoadMediaInputRequest,
    options: CreativeProjectControlRequestOptions = {},
  ): Promise<LoadMediaInputResponse> {
    const query = this.#checked("request", () =>
        parseLoadMediaInputRequest(input),
      ),
      signal = this.#signal(options);
    signal.throwIfAborted();
    const url = `${path(query.projectId)}/${encodeURIComponent(query.mediaInputId)}${query.inputRevision === null ? "" : `?inputRevision=${query.inputRevision}`}`;
    const value = await this.#transport.json("GET", url, null, {
      signal,
      expectedStatuses: [200],
      maximumResponseBytes: MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES,
      redirect: "manual",
    });
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parseLoadMediaInputResponse(query, value),
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
        ? AbortSignal.timeout(30_000)
        : AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    });
  }
  #checked<T>(kind: "request" | "response", work: () => T): T {
    try {
      return work();
    } catch {
      throw this.#transport.protocolError(
        `control_client_project_media_input_${kind}_invalid`,
      );
    }
  }
}
function path(projectId: string): string {
  return `/api/v1/creative-projects/${encodeURIComponent(projectId)}/media-inputs`;
}
