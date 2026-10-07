import {
  parseListProjectMediaResultsRequest,
  parseProjectMediaResultLocator,
  parseGetProjectMediaResultResponse,
  parsePublishProjectMediaResultResponse,
  type ProjectMediaResultLocator,
  type ProjectMediaResultSummary,
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
  readonly #transport: CreativeProjectControlTransport & {
    content?(path: string, signal: AbortSignal): Promise<Response>;
  };
  constructor(
    transport: CreativeProjectControlTransport & {
      content?(path: string, signal: AbortSignal): Promise<Response>;
    },
  ) {
    this.#transport = transport;
  }
  async listCandidates(
    input: ListProjectMediaResultsRequest,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const request = this.#checked("request", () =>
      parseListProjectMediaResultsRequest(input),
    );
    const signal = this.#signal(options);
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
  async publish(
    input: ProjectMediaResultLocator,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const query = this.#checked("request", () =>
        parseProjectMediaResultLocator(input),
      ),
      signal = this.#signal(options);
    const value = await this.#transport.json(
      "POST",
      resultPath(query),
      {},
      {
        signal,
        requireCsrf: true,
        expectedStatuses: [200],
        maximumResponseBytes: 8192,
        redirect: "manual",
      },
    );
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parsePublishProjectMediaResultResponse(query, value),
    );
  }
  async getCandidate(
    input: ProjectMediaResultLocator,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const query = this.#checked("request", () =>
        parseProjectMediaResultLocator(input),
      ),
      signal = this.#signal(options);
    const value = await this.#transport.json("GET", resultPath(query), null, {
      signal,
      expectedStatuses: [200],
      maximumResponseBytes: 8192,
      redirect: "manual",
    });
    signal.throwIfAborted();
    return this.#checked("response", () =>
      parseGetProjectMediaResultResponse(query, value),
    );
  }
  async readContent(
    input: ProjectMediaResultSummary,
    options: CreativeProjectControlRequestOptions = {},
  ): Promise<Uint8Array> {
    const candidate = this.#checked(
        "request",
        () =>
          parseGetProjectMediaResultResponse(
            {
              projectId: input.projectId,
              runId: input.runId,
              resultIndex: input.resultIndex,
            },
            { candidate: input },
          ).candidate!,
      ),
      signal = this.#signal(options);
    if (!this.#transport.content)
      throw this.#transport.protocolError(
        "control_client_project_media_result_content_unavailable",
      );
    const response = await this.#transport.content(
      resultPath(candidate) + "/content",
      signal,
    );
    const invalid = () =>
      this.#transport.protocolError(
        "control_client_project_media_result_content_invalid",
      );
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !==
        "image/png" ||
      response.headers.get("x-crewon-candidate-id") !== candidate.candidateId ||
      response.headers.get("x-crewon-byte-digest") !==
        candidate.media.byteDigest ||
      response.headers.get("content-length") !==
        String(candidate.media.byteLength) ||
      (response.headers.has("content-encoding") &&
        response.headers.get("content-encoding") !== "identity") ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => {});
      throw invalid();
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let total = 0;
    const cancel = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > candidate.media.byteLength) throw invalid();
        chunks.push(part.value);
      }
      if (total !== candidate.media.byteLength) throw invalid();
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      signal.throwIfAborted();
      if (
        "sha256:" +
          Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") !==
        candidate.media.byteDigest
      )
        throw invalid();
      return bytes;
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  #signal(options: CreativeProjectControlRequestOptions): AbortSignal {
    return this.#checked("request", () => {
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

function resultPath(q: ProjectMediaResultLocator): string {
  return `/api/v1/creative-projects/${encodeURIComponent(q.projectId)}/media-results/${encodeURIComponent(q.runId)}/${q.resultIndex}`;
}
