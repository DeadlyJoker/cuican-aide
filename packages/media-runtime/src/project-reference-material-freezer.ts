import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  parseProjectReferenceMaterialFreezeRequest,
  projectReferenceMaterialFreezeIdentity,
  parseFrozenProjectReferenceMaterial,
  frozenProjectMaterialFingerprint,
  type ActorContext,
  type ProjectAssetReferenceImageQuery,
  type ProjectReferenceMaterialFreezeRequest,
  type ProjectReferenceMaterialArchivePort,
  type FrozenProjectReferenceMaterialContent,
  type FrozenProjectReferenceMaterial,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  projectAssetInputFields,
  projectAssetId,
} from "@crewon/domain";
import {
  captureProjectReferenceFreezeSource,
  type ProjectReferenceFreezeSourceInput,
} from "./project-reference-material-freezer-source.ts";
import { inspectProjectMaterialPng } from "./project-material-png.ts";

const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
/** Capture real authorized reads into the original-key archive, then reprove current ownership/source.
 * This does not upload, reserve a Run, grant execution or claim supplier-side readiness.
 */
export class ProjectReferenceMaterialFreezer {
  readonly #driver: ReturnType<typeof captureProjectReferenceFreezeSource>;
  readonly #archiveId: string;
  readonly #load: ProjectReferenceMaterialArchivePort["load"];
  readonly #save: ProjectReferenceMaterialArchivePort["save"];
  constructor(
    input: ProjectReferenceFreezeSourceInput &
      Readonly<{ archive: ProjectReferenceMaterialArchivePort }>,
  ) {
    this.#driver = captureProjectReferenceFreezeSource(input);
    const id = Object.getOwnPropertyDescriptor(input.archive, "archiveId");
    if (!id || !("value" in id)) fail("dependency_invalid");
    this.#archiveId = projectAssetId(id.value);
    this.#load = bound(input.archive, "load");
    this.#save = bound(input.archive, "save");
  }
  async freezeSelectedReference(
    actor: ActorContext,
    input: Readonly<{
      query: ProjectAssetReferenceImageQuery;
      idempotencyKey: string;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<
    Readonly<{
      disposition: "created" | "replayed";
      record: FrozenProjectReferenceMaterial;
    }>
  > {
    const request = this.#request(actor, input),
      signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const source = await this.#driver.resolve(
      request.actor,
      request.query,
      signal,
    );
    await this.#driver.grant(request, source, this.#archiveId, signal);
    const existing = await this.#load(request);
    if (existing) {
      const actual = this.#content(existing, request);
      this.#driver.assertSource(actual.record, source);
      await this.#current(request, source, signal);
      await this.#driver.grant(request, source, this.#archiveId, signal);
      return Object.freeze({ disposition: "replayed", record: actual.record });
    }
    signal.throwIfAborted();
    const captured = this.#content(
        await this.#driver.read(request, this.#archiveId, signal),
        request,
      ),
      record = captured.record;
    this.#driver.assertSource(captured.record, source);
    await this.#current(request, source, signal);
    await this.#driver.grant(request, source, this.#archiveId, signal);
    const saved = await this.#save(captured);
    if (saved.disposition !== "created" && saved.disposition !== "replayed")
      fail("receipt_invalid");
    const receipt = parseFrozenProjectReferenceMaterial(saved.record, digester);
    if (
      frozenProjectMaterialFingerprint(receipt) !==
      frozenProjectMaterialFingerprint(record)
    )
      fail("receipt_invalid");
    const verified = await this.#load(request);
    if (!verified) fail("archive_unreadable");
    const actual = this.#content(verified, request);
    if (
      frozenProjectMaterialFingerprint(actual.record) !==
      frozenProjectMaterialFingerprint(record)
    )
      fail("receipt_invalid");
    await this.#current(request, source, signal);
    await this.#driver.grant(request, source, this.#archiveId, signal);
    return Object.freeze({
      disposition: saved.disposition,
      record: actual.record,
    });
  }
  /** Host-only retrieval of exact frozen bytes. Missing or damaged archives never trigger a new source GET. */
  async readFrozenReference(
    actor: ActorContext,
    input: Readonly<{
      query: ProjectAssetReferenceImageQuery;
      idempotencyKey: string;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<FrozenProjectReferenceMaterialContent> {
    const request = this.#request(actor, input),
      signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const source = await this.#driver.resolve(
      request.actor,
      request.query,
      signal,
    );
    await this.#driver.grant(request, source, this.#archiveId, signal);
    const stored = await this.#load(request);
    if (!stored) fail("archive_missing");
    const actual = this.#content(stored, request);
    this.#driver.assertSource(actual.record, source);
    await this.#current(request, source, signal);
    await this.#driver.grant(request, source, this.#archiveId, signal);
    return actual;
  }
  #request(
    actor: ActorContext,
    input: unknown,
  ): ProjectReferenceMaterialFreezeRequest {
    if (input !== null && typeof input === "object" && types.isProxy(input))
      fail("request_invalid");
    const q = projectAssetInputFields(input, ["query", "idempotencyKey"]);
    return parseProjectReferenceMaterialFreezeRequest({
      actor,
      query: q.query,
      idempotencyKey: q.idempotencyKey,
    });
  }
  #content(
    input: FrozenProjectReferenceMaterialContent,
    request: ProjectReferenceMaterialFreezeRequest,
  ): FrozenProjectReferenceMaterialContent {
    const fields = projectAssetInputFields(input, ["record", "bytes"]),
      record = parseFrozenProjectReferenceMaterial(fields.record, digester),
      identity = projectReferenceMaterialFreezeIdentity(
        request,
        this.#archiveId,
        digester,
      );
    if (
      record.archiveId !== this.#archiveId ||
      record.materialId !== identity.materialId ||
      record.requestDigest !== identity.requestDigest ||
      !(fields.bytes instanceof Uint8Array)
    )
      fail("receipt_invalid");
    if (fields.bytes.byteLength !== record.source.byteLength)
      fail("bytes_invalid");
    const bytes = Buffer.from(fields.bytes),
      size = inspectProjectMaterialPng(bytes);
    if (
      size.width !== record.source.width ||
      size.height !== record.source.height ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        record.source.byteDigest
    )
      fail("bytes_invalid");
    return Object.freeze({ record, bytes });
  }
  async #current(
    request: ProjectReferenceMaterialFreezeRequest,
    expected: Awaited<
      ReturnType<
        ReturnType<typeof captureProjectReferenceFreezeSource>["resolve"]
      >
    >,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const actual = await this.#driver.resolve(
      request.actor,
      request.query,
      signal,
    );
    signal.throwIfAborted();
    if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
      fail("source_changed");
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
    if (!("value" in d) || typeof d.value !== "function")
      return fail("dependency_invalid");
    return d.value.bind(input) as T;
  }
  return fail("dependency_invalid");
}
function fail(code: string): never {
  throw new Error(`project_reference_material_freeze_${code}`);
}
