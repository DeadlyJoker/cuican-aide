import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  ProjectAssetMediaReferenceImageApplicationService,
  parseProjectAssetMediaReferenceImageRequest,
  projectAssetMediaReferenceImageResultRequest,
  mediaInputSame,
  materialPreparationFields,
  type ActorContext,
  type ProjectAssetReferenceImageQuery,
} from "@crewon/application";
import { ProjectMediaResultPublisher } from "./project-media-result-publisher.ts";
import { inspectProjectMaterialPng } from "./project-material-png.ts";

/** Selected V2 references read the original encrypted result, never a mutable supplier URL.
 * Host-internal bytes/provenance only; the downstream freeze and execution still need their own grants.
 */
export class ProjectAdoptedMediaReferenceReader {
  readonly #source: ProjectAssetMediaReferenceImageApplicationService["resolveSelectedReference"];
  readonly #read: ProjectMediaResultPublisher["readCandidate"];
  constructor(
    input: Readonly<{
      sources: ProjectAssetMediaReferenceImageApplicationService;
      results: ProjectMediaResultPublisher;
    }>,
  ) {
    const d = materialPreparationFields(input, ["sources", "results"]);
    if (
      !(
        d.sources instanceof ProjectAssetMediaReferenceImageApplicationService
      ) ||
      types.isProxy(d.sources) ||
      !(d.results instanceof ProjectMediaResultPublisher) ||
      types.isProxy(d.results)
    )
      fail("dependency_invalid");
    this.#source =
      ProjectAssetMediaReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
        d.sources,
      );
    this.#read = ProjectMediaResultPublisher.prototype.readCandidate.bind(
      d.results,
    );
  }
  async readSelectedReferenceBytes(
    actor: ActorContext,
    query: ProjectAssetReferenceImageQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    const request = parseProjectAssetMediaReferenceImageRequest({
        actor,
        query,
      }),
      o = materialPreparationFields(options, ["signal"]);
    if (!(o.signal instanceof AbortSignal)) fail("signal_invalid");
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const source = await this.#source(request.actor, request.query, { signal }),
      result = projectAssetMediaReferenceImageResultRequest(
        request,
        source.reference,
      );
    signal.throwIfAborted();
    const content = await this.#read(request.actor, result.query, { signal });
    signal.throwIfAborted();
    if (!content || !mediaInputSame(content.candidate, source.candidate))
      fail("candidate_changed");
    const original = source.candidate.frozen.source;
    if (
      !(content.bytes instanceof Uint8Array) ||
      content.bytes.byteLength !== original.byteLength
    )
      fail("bytes_invalid");
    const bytes = Buffer.from(content.bytes),
      dimensions = inspectProjectMaterialPng(bytes);
    if (
      dimensions.width !== original.width ||
      dimensions.height !== original.height ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        original.byteDigest
    )
      fail("bytes_invalid");
    const settled = await this.#source(request.actor, request.query, {
      signal,
    });
    signal.throwIfAborted();
    if (!mediaInputSame(source, settled)) fail("source_changed");
    return Object.freeze({ source, bytes });
  }
}
function fail(code: string): never {
  throw new Error(`project_adopted_media_reference_${code}`);
}
