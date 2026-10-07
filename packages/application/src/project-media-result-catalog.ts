import {
  parseListProjectMediaResultsRequest,
  parseListProjectMediaResultsResponse,
  type ListProjectMediaResultsRequest,
  type ListProjectMediaResultsResponse,
} from "@crewon/contracts/project-media-results";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ProjectMediaResultCandidate } from "./project-media-result-port.ts";
import {
  mediaInputActor,
  mediaInputSame,
} from "./project-media-input-record.ts";
import { materialPreparationFields as fields } from "./project-material-preparation-record.ts";
import { projectMediaInputBound } from "./project-media-input-application-authority.ts";
import {
  mediaResultFail as fail,
  parseProjectMediaResultCandidate,
  projectMediaResultAssertVoid,
} from "./project-media-result-record.ts";

export type ProjectMediaResultCatalogRequest = Readonly<{
  actor: ActorContext;
  query: ListProjectMediaResultsRequest;
}>;
export type ProjectMediaResultCatalogPermission = Readonly<{
  actor: ActorContext;
  action: "projectMediaResult:list";
  resource: ListProjectMediaResultsRequest;
}>;
export type ProjectMediaResultCatalogAuthorizationPort = Readonly<{
  authorize(
    input: ProjectMediaResultCatalogPermission,
  ): Promise<AuthorizationDecision>;
  assertActive(input: ProjectMediaResultCatalogPermission): void;
}>;
export type ProjectMediaResultCatalogAuthority = Readonly<{
  request: ProjectMediaResultCatalogRequest;
  action: "list";
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
export interface ProjectMediaResultCatalogStore {
  listCandidates(
    request: ProjectMediaResultCatalogRequest,
    authority: ProjectMediaResultCatalogAuthority,
  ): Promise<
    Readonly<{
      candidates: readonly ProjectMediaResultCandidate[];
      nextCandidateId: string | null;
    }>
  >;
}
export function parseProjectMediaResultCatalogRequest(
  input: unknown,
): ProjectMediaResultCatalogRequest {
  const r = fields(input, ["actor", "query"]);
  return Object.freeze({
    actor: mediaInputActor(r.actor),
    query: parseListProjectMediaResultsRequest(r.query),
  });
}
export function captureProjectMediaResultCatalogAuthority(
  input: ProjectMediaResultCatalogAuthority,
  request: ProjectMediaResultCatalogRequest,
): ProjectMediaResultCatalogAuthority {
  const a = fields(input, [
    "request",
    "action",
    "assertCurrent",
    "assertActive",
  ]);
  if (
    a.action !== "list" ||
    !mediaInputSame(
      parseProjectMediaResultCatalogRequest(a.request),
      request,
    ) ||
    typeof a.assertCurrent !== "function" ||
    typeof a.assertActive !== "function"
  )
    fail("authority_invalid");
  return Object.freeze({
    request,
    action: "list",
    assertCurrent: async () =>
      projectMediaResultAssertVoid(
        await Reflect.apply(a.assertCurrent as Function, input, []),
      ),
    assertActive: () =>
      projectMediaResultAssertVoid(
        Reflect.apply(a.assertActive as Function, input, []),
      ),
  });
}
const issued = new WeakSet<object>();
export function isProjectMediaResultCatalogApplicationService(
  value: unknown,
): value is ProjectMediaResultCatalogApplicationService {
  return value !== null && typeof value === "object" && issued.has(value);
}
/** Read only, bounded discovery of recorded candidates. No archive I/O, supplier calls, execution or adoption. */
export class ProjectMediaResultCatalogApplicationService {
  readonly #list: ProjectMediaResultCatalogStore["listCandidates"];
  readonly #authorization: ProjectMediaResultCatalogAuthorizationPort;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  constructor(
    input: Readonly<{
      store: ProjectMediaResultCatalogStore;
      authorization: ProjectMediaResultCatalogAuthorizationPort;
    }>,
  ) {
    const d = fields(input, ["store", "authorization"]);
    this.#list = projectMediaInputBound(d.store, "listCandidates");
    this.#authorization = Object.freeze({
      authorize: projectMediaInputBound<
        ProjectMediaResultCatalogAuthorizationPort["authorize"]
      >(d.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        ProjectMediaResultCatalogAuthorizationPort["assertActive"]
      >(d.authorization, "assertActive"),
    });
    issued.add(this);
  }
  listCandidates(
    actor: ActorContext,
    query: ListProjectMediaResultsRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ListProjectMediaResultsResponse> {
    const work = this.#read(actor, query, options);
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }
  async #read(
    actor: ActorContext,
    query: ListProjectMediaResultsRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ListProjectMediaResultsResponse> {
    const request = parseProjectMediaResultCatalogRequest({ actor, query }),
      permission = Object.freeze({
        actor: request.actor,
        action: "projectMediaResult:list" as const,
        resource: request.query,
      }),
      signal = AbortSignal.any([this.#lifetime.signal, options.signal]);
    const active = () => {
      signal.throwIfAborted();
      projectMediaResultAssertVoid(
        this.#authorization.assertActive(permission),
      );
      signal.throwIfAborted();
    };
    const current = async () => {
      active();
      const decision = await this.#authorization.authorize(permission);
      active();
      if (decision.outcome !== "allow") fail("denied");
    };
    await current();
    const page = fields(
      await this.#list(
        request,
        Object.freeze({
          request,
          action: "list",
          assertCurrent: current,
          assertActive: active,
        }),
      ),
      ["candidates", "nextCandidateId"],
    );
    active();
    if (
      !Array.isArray(page.candidates) ||
      page.candidates.length > request.query.limit
    )
      fail("catalog_invalid");
    const candidates = page.candidates.map((entry) => {
      const candidate = parseProjectMediaResultCandidate(entry),
        { frozen } = candidate,
        { source } = frozen,
        { projection } = source,
        original = frozen.request;
      if (
        original.actor.tenantId !== request.actor.tenantId ||
        original.actor.spaceId !== request.actor.spaceId ||
        original.actor.principalId !== request.actor.principalId ||
        original.query.projectId !== request.query.projectId
      )
        fail("catalog_invalid");
      return {
        projectId: original.query.projectId,
        candidateId: candidate.candidateId,
        runId: original.query.runId,
        resultIndex: original.query.resultIndex,
        executionId: projection.reference.executionId,
        mediaInputId: projection.reference.mediaInputId,
        inputRevision: projection.reference.inputRevision,
        workflowId: projection.workflow.workflowId,
        item: projection.item,
        contentDigest: candidate.contentDigest,
        media: {
          type: source.mediaType,
          byteDigest: source.byteDigest,
          byteLength: source.byteLength,
          width: source.width,
          height: source.height,
          observedAt: source.observedAt,
        },
      };
    });
    const result = parseListProjectMediaResultsResponse(request.query, {
      candidates,
      nextCandidateId: page.nextCandidateId,
    });
    await current();
    return result;
  }
  async close(): Promise<void> {
    this.#lifetime.abort();
    await Promise.allSettled([...this.#pending]);
  }
}
