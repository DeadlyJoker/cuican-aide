import {
  parseListProjectMediaResultsRequest,
  parseListProjectMediaResultsResponse,
  MAX_MEDIA_RESULT_CATALOG_BYTES,
  type ListProjectMediaResultsRequest,
} from "@crewon/contracts/project-media-results";
import type {
  CreativeProjectControlTransport,
  CreativeProjectControlRequestOptions,
} from "./creative-project-control-client.ts";

/** Original authenticated HTTP transport, without supplier calls or automatic retries. */
export class ProjectMediaResultControlClient {
  readonly #transport: CreativeProjectControlTransport;
  constructor(transport: CreativeProjectControlTransport) {
    this.#transport = transport;
  }
  async listCandidates(
    input: ListProjectMediaResultsRequest,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const request = this.#checked("request", () =>
      parseListProjectMediaResultsRequest(input),
    );
    const signal = this.#checked("request", () => {
      if (
        options === null ||
        typeof options !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
        Reflect.ownKeys(options).some((key) => key !== "signal")
      )
        throw new Error("options_invalid");
      const d = Object.getOwnPropertyDescriptor(options, "signal");
      if (
        d &&
        (!d.enumerable ||
          !Object.hasOwn(d, "value") ||
          (d.value !== undefined && !(d.value instanceof AbortSignal)))
      )
        throw new Error("signal_invalid");
      const supplied = d?.value as AbortSignal | undefined;
      supplied?.throwIfAborted();
      return supplied
        ? AbortSignal.any([supplied, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000);
    });
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.afterCandidateId !== null)
      params.set("afterCandidateId", request.afterCandidateId);
    const value = await this.#transport.json(
      "GET",
      `/api/v1/creative-projects/${encodeURIComponent(request.projectId)}/media-results?${params}`,
      undefined,
      {
        signal,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_MEDIA_RESULT_CATALOG_BYTES,
        redirect: "manual",
      },
    );
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parseListProjectMediaResultsResponse(request, value),
    );
  }
  #checked<T>(kind: "request" | "response", work: () => T): T {
    try {
      return work();
    } catch {
      throw this.#transport.protocolError(
        `control_client_project_media_result_${kind}_invalid`,
      );
    }
  }
}
