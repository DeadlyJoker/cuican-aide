import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApplicationError,
  ProjectMediaResultCatalogApplicationService,
  projectMediaResultSummary,
  materialPreparationFields as fields,
  projectMediaInputBound,
  captureProjectMediaWorkflowReviews,
  mediaInputSame,
  type ActorContext,
  type ApplicationClock,
  type ProjectMediaWorkflowReview,
  type ProjectMediaResultAuthorizationPort,
  type ProjectMediaResultCatalogAuthorizationPort,
} from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { projectAssetId } from "@crewon/domain";
import {
  ProjectMediaResultPublisher,
  type ProjectMediaResultOutputApproval,
} from "@crewon/media-runtime/project-media-result-publisher";
import {
  parseListProjectMediaResultsRequest,
  parseProjectMediaResultLocator,
  parseGetProjectMediaResultResponse,
  parsePublishProjectMediaResultResponse,
  type ListProjectMediaResultsRequest,
  type ProjectMediaResultLocator,
} from "@crewon/contracts/project-media-results";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import {
  installedProjectMediaResultTaskAuthority,
  installedProjectMediaGenerationTaskAuthority,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";

/** Host configuration only. No archive keys or authority originate in a renderer or plugin. */
export type InstalledProjectMediaResultConfiguration = Readonly<{
  version: "crewon.project-media-results-control.v1";
  profileId: string;
  purposes: readonly ("read" | "publish")[];
  reviews: readonly ProjectMediaWorkflowReview[];
  authorization: ProjectMediaResultAuthorizationPort;
  catalogAuthorization: ProjectMediaResultCatalogAuthorizationPort;
  outputApproval: ProjectMediaResultOutputApproval;
  clock: ApplicationClock;
  createArchive(): FilesystemProjectMediaResultArchive;
}>;
type Invocation =
  | Readonly<{
      actor: ActorContext;
      kind: "list";
      query: ListProjectMediaResultsRequest;
    }>
  | Readonly<{
      actor: ActorContext;
      kind: "read" | "publish";
      query: ProjectMediaResultLocator;
    }>;
const issued = new WeakSet<object>();
export function isInstalledProjectMediaResultRuntime(
  value: unknown,
): value is InstalledProjectMediaResultRuntime {
  return value !== null && typeof value === "object" && issued.has(value);
}
export class InstalledProjectMediaResultRuntime {
  readonly #core: InstalledPluginTaskRuntimeCore;
  readonly #publisher: ProjectMediaResultPublisher;
  readonly #catalog: ProjectMediaResultCatalogApplicationService;
  readonly #archive: FilesystemProjectMediaResultArchive;
  readonly #invocations: AsyncLocalStorage<Invocation>;
  readonly #lifetime: AbortController;
  readonly #active: () => void;
  readonly #pending = new Set<Promise<unknown>>();
  #closing?: Promise<void>;
  private constructor(input: {
    core: InstalledPluginTaskRuntimeCore;
    publisher: ProjectMediaResultPublisher;
    catalog: ProjectMediaResultCatalogApplicationService;
    archive: FilesystemProjectMediaResultArchive;
    invocations: AsyncLocalStorage<Invocation>;
    lifetime: AbortController;
    active(): void;
  }) {
    this.#core = input.core;
    this.#publisher = input.publisher;
    this.#catalog = input.catalog;
    this.#archive = input.archive;
    this.#invocations = input.invocations;
    this.#lifetime = input.lifetime;
    this.#active = input.active;
    issued.add(this);
  }
  static async prepare(
    input: Readonly<{
      core: InstalledPluginTaskRuntimeCore;
      configuration: InstalledProjectMediaResultConfiguration;
    }>,
  ) {
    const r = fields(input, ["core", "configuration"]),
      core = r.core as InstalledPluginTaskRuntimeCore;
    const c = fields(r.configuration, [
      "version",
      "profileId",
      "purposes",
      "reviews",
      "authorization",
      "catalogAuthorization",
      "outputApproval",
      "clock",
      "createArchive",
    ]);
    if (
      c.version !== "crewon.project-media-results-control.v1" ||
      !Array.isArray(c.purposes) ||
      !c.purposes.includes("read") ||
      c.purposes.length > 2 ||
      new Set(c.purposes).size !== c.purposes.length ||
      c.purposes.some((v) => v !== "read" && v !== "publish")
    )
      denied();
    const publish = c.purposes.includes("publish"),
      profileId = projectAssetId(c.profileId),
      host = publish
        ? installedProjectMediaGenerationTaskAuthority(core)
        : installedProjectMediaResultTaskAuthority(core),
      reviews = captureProjectMediaWorkflowReviews(
        c.reviews as readonly ProjectMediaWorkflowReview[],
      ),
      lifetime = new AbortController(),
      invocations = new AsyncLocalStorage<Invocation>();
    if (
      reviews.some(
        (review) =>
          !host.publications.some(
            (p) =>
              p.pluginId === review.targetIdentity.pluginId &&
              p.packageDigest === review.targetIdentity.packageDigest,
          ),
      )
    )
      denied();
    const active = () => {
      lifetime.signal.throwIfAborted();
      host.assertActive();
    };
    const context = (actor: ActorContext) => {
      active();
      host.requests.currentSignal().throwIfAborted();
      const invocation = invocations.getStore();
      if (
        !invocation ||
        !mediaInputSame(invocation.actor, actor) ||
        !mediaInputSame(actor, host.requests.currentActor()) ||
        host.requests.currentScope().profileId !== profileId
      )
        denied();
      return invocation;
    };
    const authorize = projectMediaInputBound<
        ProjectMediaResultAuthorizationPort["authorize"]
      >(c.authorization, "authorize"),
      assertResult = projectMediaInputBound<
        ProjectMediaResultAuthorizationPort["assertActive"]
      >(c.authorization, "assertActive");
    const resultScope = (p: Parameters<typeof authorize>[0]) => {
      const i = context(p.actor);
      if (
        i.kind === "list" ||
        !mediaInputSame(i.query, p.resource) ||
        (p.action === "projectMediaResult:publish" &&
          (!publish || i.kind !== "publish"))
      )
        denied();
    };
    const catalogAuthorize = projectMediaInputBound<
        ProjectMediaResultCatalogAuthorizationPort["authorize"]
      >(c.catalogAuthorization, "authorize"),
      assertCatalog = projectMediaInputBound<
        ProjectMediaResultCatalogAuthorizationPort["assertActive"]
      >(c.catalogAuthorization, "assertActive");
    const catalogScope = (p: Parameters<typeof catalogAuthorize>[0]) => {
      const i = context(p.actor);
      if (
        i.kind !== "list" ||
        p.action !== "projectMediaResult:list" ||
        !mediaInputSame(i.query, p.resource)
      )
        denied();
    };
    const store = host.store.extensionStore().projectMediaResults();
    if (publish) {
      const operations = host.store.externalOperationStore();
      await operations.migrate();
      active();
      await operations.migrateProjectMediaOperations();
      active();
      await store.migrate();
    } else await store.enableResultReads();
    active();
    const createArchive = projectMediaInputBound<
        InstalledProjectMediaResultConfiguration["createArchive"]
      >(r.configuration, "createArchive"),
      archive = createArchive();
    let publisher: ProjectMediaResultPublisher | undefined,
      catalog: ProjectMediaResultCatalogApplicationService | undefined;
    try {
      const outputApproval = projectMediaInputBound<
        ProjectMediaResultOutputApproval["assertCurrent"]
      >(c.outputApproval, "assertCurrent");
      publisher = new ProjectMediaResultPublisher({
        store,
        archive,
        reviews,
        clock: {
          now: projectMediaInputBound<ApplicationClock["now"]>(c.clock, "now"),
        },
        authorization: {
          authorize: async (p) => {
            resultScope(p);
            const decision = await authorize(p);
            resultScope(p);
            return decision;
          },
          assertActive: (p) => {
            resultScope(p);
            const result = assertResult(p);
            resultScope(p);
            return result;
          },
        },
        outputApproval: {
          assertCurrent: async (p) => {
            const i = context(p.actor);
            if (
              i.kind !== "publish" ||
              !publish ||
              !mediaInputSame(i.query, p.source.request.query)
            )
              denied();
            const result = await outputApproval(p);
            context(p.actor);
            return result;
          },
        },
      });
      catalog = new ProjectMediaResultCatalogApplicationService({
        store,
        authorization: {
          authorize: async (p) => {
            catalogScope(p);
            const decision = await catalogAuthorize(p);
            catalogScope(p);
            return decision;
          },
          assertActive: (p) => {
            catalogScope(p);
            const result = assertCatalog(p);
            catalogScope(p);
            return result;
          },
        },
      });
      active();
      return new InstalledProjectMediaResultRuntime({
        core,
        publisher,
        catalog,
        archive,
        invocations,
        lifetime,
        active,
      });
    } catch (error) {
      lifetime.abort();
      await Promise.allSettled([publisher?.close(), catalog?.close()]);
      archive.close();
      throw error;
    }
  }
  listCandidates(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ListProjectMediaResultsRequest,
    signal: AbortSignal,
  ) {
    const query = parseListProjectMediaResultsRequest(input);
    return this.#run(request, { actor, kind: "list", query }, signal, (s) =>
      this.#catalog.listCandidates(actor, query, { signal: s }),
    );
  }
  publish(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ProjectMediaResultLocator,
    signal: AbortSignal,
  ) {
    const query = parseProjectMediaResultLocator(input);
    return this.#run(
      request,
      { actor, kind: "publish", query },
      signal,
      async (s) => {
        const result = await this.#publisher.publish(actor, query, {
          signal: s,
        });
        return parsePublishProjectMediaResultResponse(query, {
          disposition: result.disposition,
          candidate: projectMediaResultSummary(result.candidate),
        });
      },
    );
  }
  read(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ProjectMediaResultLocator,
    signal: AbortSignal,
  ) {
    const query = parseProjectMediaResultLocator(input);
    return this.#run(
      request,
      { actor, kind: "read", query },
      signal,
      async (s) => {
        const result = await this.#publisher.readCandidate(actor, query, {
          signal: s,
        });
        const summary = parseGetProjectMediaResultResponse(query, {
          candidate: result
            ? projectMediaResultSummary(result.candidate)
            : null,
        });
        return { ...summary, bytes: result?.bytes ?? null };
      },
    );
  }
  #run<T>(
    request: ControlApiRequestContext,
    invocation: Invocation,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#active();
    if (this.#pending.size >= 16)
      throw new ApplicationError("conflict", "project_media_result_busy");
    const joined = AbortSignal.any([signal, this.#lifetime.signal]);
    const pending = this.#core.requests
      .run(
        {
          request,
          actor: invocation.actor,
          signal: joined,
          preparation: "configuration",
        },
        () =>
          this.#invocations.run(invocation, async () => {
            const result = await work(joined);
            joined.throwIfAborted();
            this.#active();
            return result;
          }),
      )
      .catch((error) => {
        throw publicFailure(error);
      });
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= (async () => {
      await Promise.allSettled([...this.#pending]);
      try {
        await Promise.all([this.#publisher.close(), this.#catalog.close()]);
      } finally {
        this.#archive.close();
      }
    })());
  }
}
function denied(): never {
  throw new ApplicationError("authorization", "project_media_result_denied");
}
function publicFailure(error: unknown) {
  if (
    error instanceof ApplicationError &&
    error.message === "project_media_result_not_ready"
  )
    return new ApplicationError("conflict", error.message);
  return error;
}
