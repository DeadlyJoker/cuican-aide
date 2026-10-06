import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  parseProjectMediaResultRequest,
  parseFrozenProjectMediaResult,
  createProjectMediaResultCandidate,
  parseProjectMediaResultCandidate,
  projectMediaResultArchiveIdentity,
  projectMediaResultAssertVoid,
  parseProjectMediaWorkflowReview,
  mediaInputSame,
  projectMediaInputBound,
  mediaResultFail as fail,
  type ActorContext,
  type ProjectMediaResultQuery,
  type ProjectMediaResultRequest,
  type ProjectMediaResultSource,
  type ProjectMediaResultCandidate,
  type FrozenProjectMediaResultContent,
  type ProjectMediaResultAuthority,
  type ProjectMediaResultAuthorizationPort,
  type ProjectMediaWorkflowReview,
} from "@crewon/application";
import {
  SqliteProjectMediaResultStore,
  PostgresProjectMediaResultStore,
} from "@crewon/store";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
  type NetworkDnsResolver,
} from "./network-egress.ts";
import {
  PinnedNodeHttpTransport,
  type PinnedHttpPort,
} from "./pinned-node-http.ts";
import {
  inspectProjectMaterialPng,
  MAX_PROJECT_MATERIAL_BYTES,
} from "./project-material-png.ts";

/** Actual project candidates and original output bytes. No caller URLs, new Run, generation, adoption or global cancel. */
export class ProjectMediaResultPublisher {
  readonly #store: Readonly<{
    qualifyPublication: SqliteProjectMediaResultStore["qualifyPublication"];
    loadSource: SqliteProjectMediaResultStore["loadSource"];
    loadCandidate: SqliteProjectMediaResultStore["loadCandidate"];
    saveCandidate: SqliteProjectMediaResultStore["saveCandidate"];
  }>;
  readonly #archive: Readonly<{
    archiveId: string;
    load: FilesystemProjectMediaResultArchive["load"];
    save: FilesystemProjectMediaResultArchive["save"];
  }>;
  readonly #authorization: ProjectMediaResultAuthorizationPort;
  readonly #reviews: readonly ProjectMediaWorkflowReview[];
  readonly #transport: PinnedHttpPort;
  readonly #egress: NetworkEgressResolver;
  readonly #now: () => string;
  readonly #closing = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  constructor(
    input: Readonly<{
      store: SqliteProjectMediaResultStore | PostgresProjectMediaResultStore;
      archive: FilesystemProjectMediaResultArchive;
      authorization: ProjectMediaResultAuthorizationPort;
      reviews: readonly ProjectMediaWorkflowReview[];
      clock: Readonly<{ now(): string }>;
      dns?: NetworkDnsResolver;
      transport?: PinnedHttpPort;
    }>,
  ) {
    const prototype =
      input.store instanceof SqliteProjectMediaResultStore
        ? SqliteProjectMediaResultStore.prototype
        : input.store instanceof PostgresProjectMediaResultStore
          ? PostgresProjectMediaResultStore.prototype
          : null;
    if (
      !prototype ||
      !(input.archive instanceof FilesystemProjectMediaResultArchive) ||
      types.isProxy(input.store) ||
      types.isProxy(input.archive)
    )
      fail("dependency_invalid");
    this.#store = Object.freeze({
      qualifyPublication: prototype.qualifyPublication.bind(input.store),
      loadSource: prototype.loadSource.bind(input.store),
      loadCandidate: prototype.loadCandidate.bind(input.store),
      saveCandidate: prototype.saveCandidate.bind(input.store),
    });
    const p = FilesystemProjectMediaResultArchive.prototype;
    this.#archive = Object.freeze({
      archiveId: input.archive.archiveId,
      load: p.load.bind(input.archive),
      save: p.save.bind(input.archive),
    });
    this.#authorization = Object.freeze({
      authorize: projectMediaInputBound<
        ProjectMediaResultAuthorizationPort["authorize"]
      >(input.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        ProjectMediaResultAuthorizationPort["assertActive"]
      >(input.authorization, "assertActive"),
    });
    if (
      !Array.isArray(input.reviews) ||
      input.reviews.length < 1 ||
      input.reviews.length > 32 ||
      types.isProxy(input.reviews)
    )
      fail("review_invalid");
    this.#reviews = Object.freeze(
      input.reviews.map(parseProjectMediaWorkflowReview),
    );
    this.#now = projectMediaInputBound(input.clock, "now");
    this.#transport =
      input.transport === undefined
        ? new PinnedNodeHttpTransport({ responseProfile: "imageMaterial" })
        : Object.freeze({
            request: projectMediaInputBound<PinnedHttpPort["request"]>(
              input.transport,
              "request",
            ),
          });
    this.#egress = new NetworkEgressResolver({
      dns: input.dns,
      policy: new ProductionNetworkEgressPolicy(),
    });
  }
  #active(signal: AbortSignal) {
    if (this.#closed) fail("closed");
    signal.throwIfAborted();
  }
  #signal(input: Readonly<{ signal: AbortSignal }>) {
    if (!(input.signal instanceof AbortSignal)) fail("signal_invalid");
    return AbortSignal.any([
      input.signal,
      this.#closing.signal,
      AbortSignal.timeout(30_000),
    ]);
  }
  #track<T>(work: () => Promise<T>) {
    if (this.#closed) fail("closed");
    const task = work();
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }
  #authority(
    request: ProjectMediaResultRequest,
    action: "read" | "publish",
    signal: AbortSignal,
  ): ProjectMediaResultAuthority {
    const permission = Object.freeze({
      actor: request.actor,
      action:
        action === "read"
          ? ("projectMediaResult:read" as const)
          : ("projectMediaResult:publish" as const),
      resource: request.query,
    });
    const assertActive = () => {
      this.#active(signal);
      projectMediaResultAssertVoid(
        this.#authorization.assertActive(permission),
      );
      this.#active(signal);
    };
    return Object.freeze({
      request,
      action,
      assertActive,
      assertCurrent: async () => {
        assertActive();
        const decision = await this.#authorization.authorize(permission);
        assertActive();
        if (decision.outcome !== "allow") fail("denied");
      },
    });
  }
  #review(source: ProjectMediaResultSource) {
    if (
      !this.#reviews.some(
        (r) =>
          mediaInputSame(r.targetIdentity, source.targetIdentity) &&
          mediaInputSame(r.workflow, source.workflow),
      )
    )
      fail("workflow_unreviewed");
  }
  async #source(request: ProjectMediaResultRequest, signal: AbortSignal) {
    const source = await this.#store.loadSource(
      request,
      this.#authority(request, "read", signal),
    );
    this.#active(signal);
    this.#review(source);
    return source;
  }
  async #current(
    request: ProjectMediaResultRequest,
    source: ProjectMediaResultSource,
    signal: AbortSignal,
  ) {
    if (!mediaInputSame(await this.#source(request, signal), source))
      fail("source_changed");
  }
  async #publicationCurrent(
    request: ProjectMediaResultRequest,
    source: ProjectMediaResultSource,
    signal: AbortSignal,
  ) {
    await this.#current(request, source, signal);
    if (
      !mediaInputSame(
        await this.#store.qualifyPublication(
          request,
          this.#authority(request, "publish", signal),
        ),
        source,
      )
    )
      fail("source_changed");
    this.#active(signal);
  }
  #content(
    value: FrozenProjectMediaResultContent,
    source: ProjectMediaResultSource,
  ) {
    const record = parseFrozenProjectMediaResult(value.record);
    if (
      record.archiveId !== this.#archive.archiveId ||
      !mediaInputSame(record.source.projection, source) ||
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength !== record.source.byteLength
    )
      fail("archive_invalid");
    const bytes = Buffer.from(value.bytes),
      size = inspectProjectMaterialPng(bytes);
    if (
      size.width !== record.source.width ||
      size.height !== record.source.height ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        record.source.byteDigest
    )
      fail("archive_invalid");
    return Object.freeze({ record, bytes });
  }
  async #readOutput(
    request: ProjectMediaResultRequest,
    source: ProjectMediaResultSource,
    signal: AbortSignal,
  ): Promise<FrozenProjectMediaResultContent> {
    const grant = this.#authority(request, "publish", signal);
    await grant.assertCurrent();
    const target = await this.#egress.resolve(
      {
        tenantId: request.actor.tenantId,
        scopeId: source.generationDigest,
        endpoint: new URL(source.image.url),
      },
      signal,
    );
    await this.#publicationCurrent(request, source, signal);
    await grant.assertCurrent();
    grant.assertActive();
    const response = await this.#transport.request(
      {
        method: "GET",
        target,
        headers: { "accept": "image/png", "accept-encoding": "identity" },
        maxRequestBytes: 0,
        maxResponseBytes: MAX_PROJECT_MATERIAL_BYTES,
      },
      signal,
    );
    this.#active(signal);
    if (
      response.status !== 200 ||
      response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
        "image/png" ||
      (response.headers["content-encoding"] !== undefined &&
        response.headers["content-encoding"] !== "identity") ||
      !(response.body instanceof Uint8Array) ||
      response.body.byteLength > MAX_PROJECT_MATERIAL_BYTES
    )
      fail("response_invalid");
    const bytes = Buffer.from(response.body),
      size = inspectProjectMaterialPng(bytes),
      declared = response.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(declared) ||
        Number(declared) !== bytes.length)
    )
      fail("response_invalid");
    await this.#publicationCurrent(request, source, signal);
    await grant.assertCurrent();
    const record = parseFrozenProjectMediaResult({
      schemaVersion: "crewon.project-media-result-frozen.v1",
      archiveId: this.#archive.archiveId,
      ...projectMediaResultArchiveIdentity(
        source.request,
        this.#archive.archiveId,
      ),
      request: source.request,
      source: {
        projection: source,
        byteDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        byteLength: bytes.length,
        ...size,
        mediaType: "image/png",
        observedAt: this.#now(),
      },
    });
    grant.assertActive();
    return this.#content({ record, bytes }, source);
  }
  publish(
    actor: ActorContext,
    query: ProjectMediaResultQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.#track(async () => {
      const request = parseProjectMediaResultRequest({ actor, query }),
        signal = this.#signal(options),
        publish = this.#authority(request, "publish", signal);
      await publish.assertCurrent();
      const source = await this.#source(request, signal),
        candidate = await this.#store.loadCandidate(
          request,
          this.#authority(request, "read", signal),
        );
      if (candidate) {
        const frozen = await this.#archive.load(source.request);
        if (!frozen) fail("archive_missing");
        const content = this.#content(frozen, source);
        if (!mediaInputSame(content.record, candidate.frozen))
          fail("archive_invalid");
        await this.#current(request, source, signal);
        await publish.assertCurrent();
        return this.#store.saveCandidate(candidate, publish);
      }
      await this.#publicationCurrent(request, source, signal);
      let frozen = await this.#archive.load(source.request);
      if (frozen) frozen = this.#content(frozen, source);
      else {
        frozen = await this.#readOutput(request, source, signal);
        await publish.assertCurrent();
        await this.#publicationCurrent(request, source, signal);
        publish.assertActive();
        const receipt = await this.#archive.save(frozen);
        this.#active(signal);
        if (
          receipt.disposition !== "created" &&
          receipt.disposition !== "replayed"
        )
          fail("archive_invalid");
        const loaded = await this.#archive.load(source.request);
        if (!loaded) fail("archive_missing");
        frozen = this.#content(loaded, source);
        if (!mediaInputSame(receipt.record, frozen.record))
          fail("archive_invalid");
      }
      await this.#publicationCurrent(request, source, signal);
      await publish.assertCurrent();
      return this.#store.saveCandidate(
        createProjectMediaResultCandidate(frozen.record),
        publish,
      );
    });
  }
  readCandidate(
    actor: ActorContext,
    query: ProjectMediaResultQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.#track(async () => {
      const request = parseProjectMediaResultRequest({ actor, query }),
        signal = this.#signal(options),
        read = this.#authority(request, "read", signal);
      const candidate = await this.#store.loadCandidate(request, read);
      if (!candidate) return null;
      const source = await this.#source(request, signal),
        loaded = await this.#archive.load(source.request);
      if (!loaded) fail("archive_missing");
      const content = this.#content(loaded, source);
      if (!mediaInputSame(content.record, candidate.frozen))
        fail("archive_invalid");
      await this.#current(request, source, signal);
      await read.assertCurrent();
      read.assertActive();
      return Object.freeze({
        candidate: parseProjectMediaResultCandidate(candidate),
        bytes: content.bytes,
      });
    });
  }
  async close() {
    this.#closed = true;
    this.#closing.abort(new Error("project_media_result_publisher_closed"));
    await Promise.allSettled([...this.#pending]);
  }
}
