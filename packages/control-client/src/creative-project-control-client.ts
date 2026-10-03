import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  parseAppendConceptAssetRevisionRequest,
  parseAppendProjectBriefRequest,
  parseConceptAssetListQuery,
  parseConceptAssetListResponse,
  parseConceptRevisionListQuery,
  parseConceptRevisionListResponse,
  parseCreateConceptAssetRequest,
  parseCreateCreativeProjectRequest,
  parseCreativeProjectId,
  parseCreativeProjectIdempotencyKey,
  parseCreativeProjectListQuery,
  parseCreativeProjectListResponse,
  parseCreativeProjectMutationResponse,
  parseCreativeProjectRevision,
  parseGetConceptAssetResponse,
  parseGetConceptRevisionResponse,
  parseConceptGenerationLocator,
  parseGetConceptGenerationResponse,
  parseGetCreativeProjectResponse,
  parseGetProjectBriefResponse,
  parseProjectBriefListQuery,
  parseProjectBriefListResponse,
  parseRenameCreativeProjectRequest,
  parseSetCreativeProjectStateRequest,
  type AppendConceptAssetRevisionRequest,
  type ConceptGenerationLocator,
  type AppendProjectBriefRequest,
  type CreateConceptAssetRequest,
  type CreateCreativeProjectRequest,
  type CreativeProjectListState,
  type RenameCreativeProjectRequest,
  type SetCreativeProjectStateRequest,
} from "@crewon/contracts";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";

export type CreativeProjectControlRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export type CreativeProjectControlClientOptions = Readonly<{
  deadlineMs?: number;
}>;
export type CreativeProjectQuery = Readonly<{
  state?: CreativeProjectListState;
  cursor?: string | null;
  limit?: number;
}>;
export type ProjectBriefQuery = Readonly<{
  afterBriefRevision?: number;
  limit?: number;
}>;
export type ConceptAssetQuery = Readonly<{
  afterAssetId?: string | null;
  limit?: number;
}>;
export type ConceptRevisionQuery = Readonly<{
  afterAssetRevision?: number;
  limit?: number;
}>;
type JsonOptions = CreativeProjectControlRequestOptions &
  Readonly<{
    expectedStatuses: readonly number[];
    maximumResponseBytes: number;
    redirect: "manual";
    requireCsrf?: boolean;
    requireIdempotency?: boolean;
    idempotencyKey?: string;
  }>;
export type CreativeProjectControlTransport = Readonly<{
  json(
    method: "GET" | "PUT" | "POST",
    path: string,
    body: unknown,
    options: JsonOptions,
  ): Promise<unknown>;
  protocolError(code: string): Error;
}>;
const PREFIX = "/api/v1/creative-projects";

/** Project metadata uses the existing authenticated Control transport; no payment or execution authority is implied. */
export class CreativeProjectControlClient {
  readonly #transport: CreativeProjectControlTransport;
  readonly #deadlineMs: number;
  constructor(
    transport: CreativeProjectControlTransport,
    options: CreativeProjectControlClientOptions = {},
  ) {
    this.#transport = transport;
    const deadlineMs =
      options.deadlineMs === undefined ? 30_000 : options.deadlineMs;
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 60_000
    )
      throw transport.protocolError(
        "control_client_creative_project_deadline_invalid",
      );
    this.#deadlineMs = deadlineMs;
  }

  async listProjects(
    query: CreativeProjectQuery = {},
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const raw = this.#input(() =>
      queryFields(query, ["state", "cursor", "limit"], ["limit"], ["cursor"]),
    );
    const checked = this.#input(() => parseCreativeProjectListQuery(raw));
    const result = await this.#json(
      "GET",
      `${PREFIX}${search(raw)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseCreativeProjectListResponse(result, checked),
    );
  }
  async getProject(
    projectId: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId));
    const result = await this.#json("GET", projectPath(id), null, options);
    return this.#output(() =>
      parseGetCreativeProjectResponse(result, { projectId: id }),
    );
  }
  async createProject(
    request: CreateCreativeProjectRequest,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const checked = this.#input(() =>
      parseCreateCreativeProjectRequest(request),
    );
    const result = await this.#mutation(
      "POST",
      PREFIX,
      checked,
      idempotencyKey,
      options,
      [200, 201],
    );
    return this.#output(() =>
      parseCreativeProjectMutationResponse(result, {
        kind: "create-project",
        request: checked,
      }),
    );
  }
  async renameProject(
    projectId: string,
    request: RenameCreativeProjectRequest,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      checked = this.#input(() => parseRenameCreativeProjectRequest(request));
    const result = await this.#mutation(
      "PUT",
      `${projectPath(id)}/title`,
      checked,
      idempotencyKey,
      options,
    );
    return this.#output(() =>
      parseCreativeProjectMutationResponse(result, {
        kind: "rename-project",
        projectId: id,
        request: checked,
      }),
    );
  }
  async setProjectState(
    projectId: string,
    request: SetCreativeProjectStateRequest,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      checked = this.#input(() => parseSetCreativeProjectStateRequest(request));
    const result = await this.#mutation(
      "PUT",
      `${projectPath(id)}/state`,
      checked,
      idempotencyKey,
      options,
    );
    return this.#output(() =>
      parseCreativeProjectMutationResponse(result, {
        kind: "set-project-state",
        projectId: id,
        request: checked,
      }),
    );
  }
  async getBrief(
    projectId: string,
    briefRevision: number,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      revision = this.#input(() => numericRevision(briefRevision));
    const result = await this.#json(
      "GET",
      `${projectPath(id)}/briefs/${revision}`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetProjectBriefResponse(result, {
        projectId: id,
        briefRevision: revision,
      }),
    );
  }
  async getConceptGeneration(
    input: ConceptGenerationLocator,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const locator = this.#input(() => parseConceptGenerationLocator(input));
    const result = await this.#json(
      "GET",
      `${conceptPath(locator.projectId, locator.assetId)}/revisions/${locator.assetRevision}/generation`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetConceptGenerationResponse(result, locator),
    );
  }
  async listBriefs(
    projectId: string,
    query: ProjectBriefQuery = {},
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId));
    const raw = this.#input(() =>
      queryFields(
        query,
        ["afterBriefRevision", "limit"],
        ["afterBriefRevision", "limit"],
      ),
    );
    const checked = this.#input(() => parseProjectBriefListQuery(raw));
    const result = await this.#json(
      "GET",
      `${projectPath(id)}/briefs${search(raw)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseProjectBriefListResponse(result, { projectId: id, ...checked }),
    );
  }
  async appendBrief(
    projectId: string,
    request: AppendProjectBriefRequest,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      checked = this.#input(() => parseAppendProjectBriefRequest(request));
    const result = await this.#mutation(
      "POST",
      `${projectPath(id)}/briefs`,
      checked,
      idempotencyKey,
      options,
      [200, 201],
    );
    return this.#output(() =>
      parseCreativeProjectMutationResponse(result, {
        kind: "append-brief",
        projectId: id,
        request: checked,
      }),
    );
  }
  async getConceptAsset(
    projectId: string,
    assetId: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      asset = this.#input(() => parseCreativeProjectId(assetId));
    const result = await this.#json(
      "GET",
      conceptPath(id, asset),
      null,
      options,
    );
    return this.#output(() =>
      parseGetConceptAssetResponse(result, { projectId: id, assetId: asset }),
    );
  }
  async listConceptAssets(
    projectId: string,
    query: ConceptAssetQuery = {},
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId));
    const raw = this.#input(() =>
      queryFields(
        query,
        ["afterAssetId", "limit"],
        ["limit"],
        ["afterAssetId"],
      ),
    );
    const checked = this.#input(() => parseConceptAssetListQuery(raw));
    const result = await this.#json(
      "GET",
      `${projectPath(id)}/concepts${search(raw)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseConceptAssetListResponse(result, { projectId: id, ...checked }),
    );
  }
  async createConcept(
    projectId: string,
    request: CreateConceptAssetRequest,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      checked = this.#input(() => parseCreateConceptAssetRequest(request));
    const result = await this.#mutation(
      "POST",
      `${projectPath(id)}/concepts`,
      checked,
      idempotencyKey,
      options,
      [200, 201],
    );
    return this.#output(() =>
      parseCreativeProjectMutationResponse(result, {
        kind: "create-concept",
        projectId: id,
        request: checked,
      }),
    );
  }
  async getConceptRevision(
    projectId: string,
    assetId: string,
    assetRevision: number,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      asset = this.#input(() => parseCreativeProjectId(assetId)),
      revision = this.#input(() => numericRevision(assetRevision));
    const result = await this.#json(
      "GET",
      `${conceptPath(id, asset)}/revisions/${revision}`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetConceptRevisionResponse(result, {
        projectId: id,
        assetId: asset,
        assetRevision: revision,
      }),
    );
  }
  async listConceptRevisions(
    projectId: string,
    assetId: string,
    query: ConceptRevisionQuery = {},
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      asset = this.#input(() => parseCreativeProjectId(assetId));
    const raw = this.#input(() =>
      queryFields(
        query,
        ["afterAssetRevision", "limit"],
        ["afterAssetRevision", "limit"],
      ),
    );
    const checked = this.#input(() => parseConceptRevisionListQuery(raw));
    const result = await this.#json(
      "GET",
      `${conceptPath(id, asset)}/revisions${search(raw)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseConceptRevisionListResponse(result, {
        projectId: id,
        assetId: asset,
        ...checked,
      }),
    );
  }
  async appendConceptRevision(
    projectId: string,
    assetId: string,
    request: AppendConceptAssetRevisionRequest,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions = {},
  ) {
    const id = this.#input(() => parseCreativeProjectId(projectId)),
      asset = this.#input(() => parseCreativeProjectId(assetId)),
      checked = this.#input(() =>
        parseAppendConceptAssetRevisionRequest(request),
      );
    const result = await this.#mutation(
      "POST",
      `${conceptPath(id, asset)}/revisions`,
      checked,
      idempotencyKey,
      options,
      [200, 201],
    );
    return this.#output(() =>
      parseCreativeProjectMutationResponse(result, {
        kind: "append-concept",
        projectId: id,
        assetId: asset,
        request: checked,
      }),
    );
  }
  #mutation(
    method: "PUT" | "POST",
    path: string,
    body: unknown,
    idempotencyKey: string,
    options: CreativeProjectControlRequestOptions,
    statuses: readonly number[] = [200],
  ) {
    const key = this.#input(() =>
      parseCreativeProjectIdempotencyKey(idempotencyKey),
    );
    return this.#json(method, path, body, options, {
      requireCsrf: true,
      requireIdempotency: true,
      idempotencyKey: key,
      expectedStatuses: statuses,
    });
  }
  async #json(
    method: "GET" | "PUT" | "POST",
    path: string,
    body: unknown,
    options: CreativeProjectControlRequestOptions,
    extra: Partial<JsonOptions> = {},
  ) {
    const callerSignal = options.signal;
    callerSignal?.throwIfAborted();
    const scope = new AbortController();
    const cancelFromCaller = () => scope.abort(callerSignal!.reason);
    callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
    let abort!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(scope.signal.reason);
      scope.signal.addEventListener("abort", abort, { once: true });
    });
    void canceled.catch(() => undefined);
    const timer = setTimeout(
      () =>
        scope.abort(
          new DOMException(
            "creative_project_request_timed_out",
            "TimeoutError",
          ),
        ),
      this.#deadlineMs,
    );
    try {
      if (callerSignal?.aborted) cancelFromCaller();
      scope.signal.throwIfAborted();
      const work = Promise.resolve(
        this.#transport.json(method, path, body, {
          expectedStatuses: [200],
          maximumResponseBytes: MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
          redirect: "manual",
          ...extra,
          signal: scope.signal,
        }),
      );
      // A transport may ignore abort or reject after the caller has already received cancellation.
      // Observe that original work; a late result cannot win the ended invocation's publication fence.
      void work.catch(() => undefined);
      const result = await Promise.race([work, canceled]);
      scope.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancelFromCaller);
      scope.signal.removeEventListener("abort", abort);
    }
  }
  #input<T>(parse: () => T): T {
    try {
      return parse();
    } catch {
      throw this.#transport.protocolError(
        "control_client_creative_project_request_invalid",
      );
    }
  }
  #output<T>(parse: () => T): T {
    try {
      return parse();
    } catch {
      throw this.#transport.protocolError(
        "control_client_creative_project_response_invalid",
      );
    }
  }
}
function projectPath(id: string): string {
  return `${PREFIX}/${encodeURIComponent(id)}`;
}
function conceptPath(id: string, assetId: string): string {
  return `${projectPath(id)}/concepts/${encodeURIComponent(assetId)}`;
}
function numericRevision(input: unknown): number {
  if (typeof input !== "number")
    throw new TypeError("creative_project_revision_invalid");
  return parseCreativeProjectRevision(input);
}
function queryFields(
  input: unknown,
  keys: readonly string[],
  numeric: readonly string[],
  nullable: readonly string[] = [],
): Record<string, string> {
  const copied = parsePluginUiJsonValue(input, { maxBytes: 1024 });
  if (copied === null || typeof copied !== "object" || Array.isArray(copied))
    throw new TypeError("creative_project_query_invalid");
  const entries = Object.entries(copied);
  if (entries.some(([key]) => !keys.includes(key)))
    throw new TypeError("creative_project_query_invalid");
  return Object.fromEntries(
    entries.flatMap(([key, value]) => {
      if (value === null && nullable.includes(key)) return [];
      if (
        numeric.includes(key)
          ? typeof value !== "number" || !Number.isSafeInteger(value)
          : typeof value !== "string"
      )
        throw new TypeError("creative_project_query_invalid");
      return [[key, String(value)]];
    }),
  );
}
function search(query: Record<string, string>): string {
  const value = new URLSearchParams(query).toString();
  return value ? `?${value}` : "";
}
