import {
  MAX_PROJECT_TEXT_RESPONSE_BYTES,
  parseGetProjectTextArtifactResponse,
  parseGetProjectTextRevisionResponse,
  parseProjectTextArtifactListQuery,
  parseProjectTextArtifactListResponse,
  parseProjectTextContentRevision,
  parseProjectTextId,
  parseProjectTextIdempotencyKey,
  parseProjectTextMutationResponse,
  parseProjectTextRevisionListQuery,
  parseProjectTextRevisionListResponse,
  parseSaveProjectOutlineCandidateRequest,
  parseSaveProjectScriptCandidateRequest,
  parseSelectProjectTextRevisionRequest,
  parseSetProjectTextArtifactLockedRequest,
  type ProjectTextMutationExpectation,
  type SaveProjectOutlineCandidateRequest,
  type SaveProjectScriptCandidateRequest,
  type SelectProjectTextRevisionRequest,
  type SetProjectTextArtifactLockedRequest,
} from "@crewon/contracts";
import type { CreativeProjectControlTransport } from "./creative-project-control-client.ts";

export type ProjectTextControlTransport = CreativeProjectControlTransport;
export type ProjectTextControlRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export type ProjectTextControlClientOptions = Readonly<{ deadlineMs?: number }>;
export type ProjectTextArtifactQuery = Readonly<{
  afterArtifactId?: string | null;
  limit?: number;
}>;
export type ProjectTextRevisionQuery = Readonly<{
  afterContentRevision?: number;
  limit?: number;
}>;

/** Independent metadata methods borrowing the original authenticated Control transport. */
export class ProjectTextControlClient {
  readonly #transport: ProjectTextControlTransport;
  readonly #deadlineMs: number;
  constructor(
    transport: ProjectTextControlTransport,
    options: ProjectTextControlClientOptions = {},
  ) {
    const deadline = options.deadlineMs ?? 30_000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60_000)
      throw transport.protocolError(
        "control_client_project_text_deadline_invalid",
      );
    this.#transport = transport;
    this.#deadlineMs = deadline;
  }
  async getOutline(
    projectId: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId));
    const value = await this.#json(
      "GET",
      `${rootPath(project)}/outline`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetProjectTextArtifactResponse(value, {
        projectId: project,
        kind: "outline",
        episodeId: null,
      }),
    );
  }
  async getScript(
    projectId: string,
    episodeId: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      episode = this.#input(() => parseProjectTextId(episodeId));
    const value = await this.#json(
      "GET",
      `${rootPath(project)}/scripts/${encodeURIComponent(episode)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetProjectTextArtifactResponse(value, {
        projectId: project,
        kind: "script",
        episodeId: episode,
      }),
    );
  }
  async getArtifact(
    projectId: string,
    artifactId: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      artifact = this.#input(() => parseProjectTextId(artifactId));
    const value = await this.#json(
      "GET",
      artifactPath(project, artifact),
      null,
      options,
    );
    return this.#output(() =>
      parseGetProjectTextArtifactResponse(value, {
        projectId: project,
        artifactId: artifact,
      }),
    );
  }
  async getRevision(
    projectId: string,
    artifactId: string,
    contentRevision: number,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      artifact = this.#input(() => parseProjectTextId(artifactId)),
      revision = this.#input(() =>
        parseProjectTextContentRevision(contentRevision),
      );
    const value = await this.#json(
      "GET",
      `${artifactPath(project, artifact)}/revisions/${revision}`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetProjectTextRevisionResponse(value, {
        projectId: project,
        artifactId: artifact,
        contentRevision: revision,
      }),
    );
  }
  async listArtifacts(
    projectId: string,
    query: ProjectTextArtifactQuery = {},
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      raw = this.#input(() =>
        queryFields(query, ["afterArtifactId", "limit"], ["afterArtifactId"]),
      ),
      checked = this.#input(() => parseProjectTextArtifactListQuery(raw));
    const value = await this.#json(
      "GET",
      rootPath(project) + search(raw),
      null,
      options,
    );
    return this.#output(() =>
      parseProjectTextArtifactListResponse(value, {
        projectId: project,
        ...checked,
      }),
    );
  }
  async listRevisions(
    projectId: string,
    artifactId: string,
    query: ProjectTextRevisionQuery = {},
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      artifact = this.#input(() => parseProjectTextId(artifactId)),
      raw = this.#input(() =>
        queryFields(query, ["afterContentRevision", "limit"], []),
      ),
      checked = this.#input(() => parseProjectTextRevisionListQuery(raw));
    const value = await this.#json(
      "GET",
      `${artifactPath(project, artifact)}/revisions${search(raw)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseProjectTextRevisionListResponse(value, {
        projectId: project,
        artifactId: artifact,
        ...checked,
      }),
    );
  }
  async saveOutlineCandidate(
    projectId: string,
    request: SaveProjectOutlineCandidateRequest,
    idempotencyKey: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      checked = this.#input(() =>
        parseSaveProjectOutlineCandidateRequest(request),
      );
    return this.#mutation(
      "POST",
      `${rootPath(project)}/outline/candidates`,
      checked,
      idempotencyKey,
      options,
      { kind: "save-outline", projectId: project, request: checked },
    );
  }
  async saveScriptCandidate(
    projectId: string,
    episodeId: string,
    request: SaveProjectScriptCandidateRequest,
    idempotencyKey: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      episode = this.#input(() => parseProjectTextId(episodeId)),
      checked = this.#input(() =>
        parseSaveProjectScriptCandidateRequest(request),
      );
    return this.#mutation(
      "POST",
      `${rootPath(project)}/scripts/${encodeURIComponent(episode)}/candidates`,
      checked,
      idempotencyKey,
      options,
      {
        kind: "save-script",
        projectId: project,
        episodeId: episode,
        request: checked,
      },
    );
  }
  async selectRevision(
    projectId: string,
    artifactId: string,
    request: SelectProjectTextRevisionRequest,
    idempotencyKey: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      artifact = this.#input(() => parseProjectTextId(artifactId)),
      checked = this.#input(() =>
        parseSelectProjectTextRevisionRequest(request),
      );
    return this.#mutation(
      "PUT",
      `${artifactPath(project, artifact)}/selection`,
      checked,
      idempotencyKey,
      options,
      {
        kind: "select-revision",
        projectId: project,
        artifactId: artifact,
        request: checked,
      },
    );
  }
  async setLocked(
    projectId: string,
    artifactId: string,
    request: SetProjectTextArtifactLockedRequest,
    idempotencyKey: string,
    options: ProjectTextControlRequestOptions = {},
  ) {
    const project = this.#input(() => parseProjectTextId(projectId)),
      artifact = this.#input(() => parseProjectTextId(artifactId)),
      checked = this.#input(() =>
        parseSetProjectTextArtifactLockedRequest(request),
      );
    return this.#mutation(
      "PUT",
      `${artifactPath(project, artifact)}/lock`,
      checked,
      idempotencyKey,
      options,
      {
        kind: "set-lock",
        projectId: project,
        artifactId: artifact,
        request: checked,
      },
    );
  }
  async #mutation(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    idempotencyKey: string,
    options: ProjectTextControlRequestOptions,
    expected: ProjectTextMutationExpectation,
  ) {
    const key = this.#input(() =>
      parseProjectTextIdempotencyKey(idempotencyKey),
    );
    const value = await this.#json(method, path, body, options, key);
    return this.#output(() =>
      parseProjectTextMutationResponse(value, expected),
    );
  }
  async #json(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    options: ProjectTextControlRequestOptions,
    idempotencyKey?: string,
  ) {
    const caller = options.signal;
    caller?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(caller!.reason);
    caller?.addEventListener("abort", cancel, { once: true });
    let aborted!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    void canceled.catch(() => undefined);
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("project_text_request_timed_out", "TimeoutError"),
        ),
      this.#deadlineMs,
    );
    try {
      if (caller?.aborted) cancel();
      controller.signal.throwIfAborted();
      const work = Promise.resolve(
        this.#transport.json(method, path, body, {
          expectedStatuses: [200],
          maximumResponseBytes: MAX_PROJECT_TEXT_RESPONSE_BYTES,
          redirect: "manual",
          signal: controller.signal,
          ...(idempotencyKey === undefined
            ? {}
            : { idempotencyKey, requireCsrf: true, requireIdempotency: true }),
        }),
      );
      void work.catch(() => undefined);
      const value = await Promise.race([work, canceled]);
      controller.signal.throwIfAborted();
      return value;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", aborted);
    }
  }
  #input<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_text_request_invalid",
      );
    }
  }
  #output<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_text_response_invalid",
      );
    }
  }
}
function rootPath(projectId: string): string {
  return `/api/v1/creative-projects/${encodeURIComponent(projectId)}/text-artifacts`;
}
function artifactPath(projectId: string, artifactId: string): string {
  return `${rootPath(projectId)}/items/${encodeURIComponent(artifactId)}`;
}
function queryFields(
  input: unknown,
  fields: readonly string[],
  nullable: readonly string[],
): Record<string, string> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("project_text_query_invalid");
  const result: Record<string, string> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !fields.includes(key))
      throw new Error("project_text_query_invalid");
    const own = Object.getOwnPropertyDescriptor(input, key);
    if (!own?.enumerable || !("value" in own))
      throw new Error("project_text_query_invalid");
    if (
      own.value === undefined ||
      (own.value === null && nullable.includes(key))
    )
      continue;
    if (key === "limit" || key === "afterContentRevision") {
      if (typeof own.value !== "number" || !Number.isSafeInteger(own.value))
        throw new Error("project_text_query_invalid");
    } else if (typeof own.value !== "string")
      throw new Error("project_text_query_invalid");
    result[key] = String(own.value);
  }
  return result;
}
function search(input: Record<string, string>): string {
  const value = new URLSearchParams(input).toString();
  return value ? `?${value}` : "";
}
