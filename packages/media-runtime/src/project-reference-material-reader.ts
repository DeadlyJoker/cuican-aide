import { createHash } from "node:crypto";
import {
  ApplicationError,
  ProjectAssetReferenceImageApplicationService,
  parseProjectAssetReferenceImageQuery,
  type ActorContext,
  type ProjectAssetReferenceImageQuery,
  type ProjectAssetReferenceImageSource,
  type ProjectReferenceMaterialObservation,
  type ProjectReferenceMaterialReadContent,
  type ProjectReferenceMaterialReadAuthorizationPort,
  type ProjectReferenceMaterialSourceAdapter,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  projectAssetInputFields,
  validateCreativeProjectActor,
} from "@crewon/domain";
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

/** Host-owned, read-only media I/O. No URL input, redirects, uploads, supplier submission or billing.
 * Observations are not prepared-material receipts: a later freeze and admission must recheck them.
 */
export class ProjectReferenceMaterialReader {
  readonly #source: ProjectAssetReferenceImageApplicationService["resolveSelectedReference"];
  readonly #derive: ProjectReferenceMaterialSourceAdapter["deriveReadDestination"];
  readonly #authorize: ProjectReferenceMaterialReadAuthorizationPort["authorize"];
  readonly #transport: PinnedHttpPort;
  readonly #egress: NetworkEgressResolver;
  readonly #now: () => string;

  constructor(
    input: Readonly<{
      sources: ProjectAssetReferenceImageApplicationService;
      adapter: ProjectReferenceMaterialSourceAdapter;
      authorization: ProjectReferenceMaterialReadAuthorizationPort;
      clock: Readonly<{ now(): string }>;
      dns?: NetworkDnsResolver;
      transport?: PinnedHttpPort;
    }>,
  ) {
    if (
      !(input.sources instanceof ProjectAssetReferenceImageApplicationService)
    )
      fail("source_unavailable");
    this.#source =
      ProjectAssetReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
        input.sources,
      );
    this.#derive = bound(input.adapter, "deriveReadDestination");
    this.#authorize = bound(input.authorization, "authorize");
    this.#now = bound(input.clock, "now");
    this.#transport =
      input.transport === undefined
        ? new PinnedNodeHttpTransport({ responseProfile: "imageMaterial" })
        : Object.freeze({
            request: bound<PinnedHttpPort["request"]>(
              input.transport,
              "request",
            ),
          });
    this.#egress = new NetworkEgressResolver({
      dns: input.dns,
      policy: new ProductionNetworkEgressPolicy(),
    });
  }

  async readSelectedReference(
    actorInput: ActorContext,
    queryInput: ProjectAssetReferenceImageQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectReferenceMaterialObservation> {
    const result =
      await ProjectReferenceMaterialReader.prototype.readSelectedReferenceBytes.call(
        this,
        actorInput,
        queryInput,
        options,
      );
    return result.observation;
  }

  async readSelectedReferenceBytes(
    actorInput: ActorContext,
    queryInput: ProjectAssetReferenceImageQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectReferenceMaterialReadContent> {
    const actor = validateCreativeProjectActor(
        projectAssetInputFields(actorInput, [
          "tenantId",
          "spaceId",
          "principalId",
          "actorId",
        ]),
      ),
      query = parseProjectAssetReferenceImageQuery(queryInput),
      signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const source = await this.#source(actor, query);
    signal.throwIfAborted();
    const destination = this.#destination(source);
    const permission = Object.freeze({
      actor,
      action: "projectReferenceMaterial:read" as const,
      resource: Object.freeze({
        projectId: query.projectId,
        assetId: query.assetId,
        referenceRevision: query.referenceRevision,
        referenceDigest: source.reference.contentDigest,
        resultLinkDigest: source.resultLink.contentDigest,
        sourceBindingDigest: source.resultLink.sourceBindingDigest,
        pluginId: source.resultLink.pluginId,
        pluginVersion: source.resultLink.pluginVersion,
        packageDigest: source.resultLink.packageDigest,
        configurationRevision: source.configuration.revision,
        operationId: source.resultLink.operationId,
        configurationDigest: source.configuration.contentDigest,
        origin: destination.origin,
        path: destination.path,
      }),
    });
    const authorize = async () => {
      const decision = await this.#authorize(permission);
      signal.throwIfAborted();
      if (decision.outcome !== "allow")
        throw new ApplicationError(
          "authorization",
          "project_reference_material_read_denied",
        );
    };
    const current = async () => {
      const final = await this.#source(actor, query);
      signal.throwIfAborted();
      if (extensionCanonicalJson(final) !== extensionCanonicalJson(source))
        fail("source_changed");
    };
    await authorize();
    const target = await this.#egress.resolve(
      {
        tenantId: actor.tenantId,
        scopeId: source.resultLink.sourceBindingDigest,
        endpoint: new URL(destination.path, destination.origin),
      },
      signal,
    );
    await current();
    await authorize();
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
    signal.throwIfAborted();
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
      byteDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const declared = response.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(declared) ||
        Number(declared) !== bytes.length)
    )
      fail("response_invalid");
    await current();
    await authorize();
    const observedAt = this.#now();
    if (
      typeof observedAt !== "string" ||
      new Date(observedAt).toISOString() !== observedAt
    )
      fail("clock_invalid");
    signal.throwIfAborted();
    const observation: ProjectReferenceMaterialObservation = Object.freeze({
      actor,
      projectId: query.projectId,
      assetId: query.assetId,
      assetRevision: source.asset.revision,
      contentRevision: source.content.contentRevision,
      contentDigest: source.content.contentDigest,
      referenceRevision: source.reference.referenceRevision,
      referenceDigest: source.reference.contentDigest,
      resultLinkDigest: source.resultLink.contentDigest,
      sourceBindingDigest: source.resultLink.sourceBindingDigest,
      sourceRunId: source.resultLink.sourceRunId,
      operationId: source.resultLink.operationId,
      pluginId: source.resultLink.pluginId,
      pluginVersion: source.resultLink.pluginVersion,
      packageDigest: source.resultLink.packageDigest,
      configurationRevision: source.configuration.revision,
      configurationDigest: source.configuration.contentDigest,
      origin: destination.origin,
      output: destination.output,
      byteDigest,
      byteLength: bytes.length,
      mediaType: "image/png",
      ...size,
      observedAt,
    });
    return Object.freeze({ observation, bytes });
  }

  #destination(source: ProjectAssetReferenceImageSource) {
    const d = projectAssetInputFields(this.#derive(source), [
      "origin",
      "path",
      "output",
    ]);
    if (
      typeof d.origin !== "string" ||
      typeof d.path !== "string" ||
      d.path.length > 2048
    )
      fail("destination_invalid");
    const base = new URL(d.origin);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/" ||
      base.href !== d.origin ||
      !d.path.startsWith("/") ||
      d.path.startsWith("//")
    )
      fail("destination_invalid");
    const url = new URL(d.path, base);
    if (
      url.origin !== base.origin ||
      url.hash ||
      url.username ||
      url.password ||
      url.href !== source.resultLink.image.url ||
      url.pathname + url.search !== d.path
    )
      fail("destination_invalid");
    const o = projectAssetInputFields(d.output, [
      "filename",
      "subfolder",
      "type",
    ]);
    if (
      typeof o.filename !== "string" ||
      typeof o.subfolder !== "string" ||
      o.type !== "output" ||
      o.filename !== source.resultLink.image.filename
    )
      fail("destination_invalid");
    return Object.freeze({
      origin: base.href,
      path: d.path,
      output: Object.freeze({
        filename: o.filename,
        subfolder: o.subfolder,
        type: "output" as const,
      }),
    });
  }
}

function bound<T extends (...args: never[]) => unknown>(
  input: unknown,
  key: string,
): T {
  if (!input || typeof input !== "object") return fail("dependency_invalid");
  for (
    let owner: object | null = input;
    owner;
    owner = Object.getPrototypeOf(owner)
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (!d) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function")
      return fail("dependency_invalid");
    return d.value.bind(input) as T;
  }
  return fail("dependency_invalid");
}
function fail(code: string): never {
  throw new Error(`project_reference_material_${code}`);
}
