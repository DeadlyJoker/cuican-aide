import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  ApplicationError,
  capturePreparedProjectSource,
  captureSourceUploadAuthority,
  captureSourceUploadClaim,
  captureSourceUploadInitial,
  captureSourceUploadPart,
  captureSourceUploadState,
  sourceUploadFields,
  assertSourceUploadActive,
  assertSourceUploadCurrent,
  type ActorContext,
  type CreativeProjectOwnerScope,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadInitial,
  type ProjectSourceUploadParsedFile,
  type ProjectSourceUploadPart,
  type ProjectSourceUploadPreparedManifest,
  type ProjectSourceUploadPreparedSource,
  type ProjectSourceUploadState,
} from "@crewon/application";
import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  projectSourceScalarLength,
  validateCreativeProjectActor,
} from "@crewon/domain";

export const sourceUploadTextDigester = {
  sha256: (value: string) => sourceUploadHash(value),
};
const nativeByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const nativeSet = Uint8Array.prototype.set;

export function sourceUploadFailure(
  code: string,
  category: "validation" | "conflict" | "notFound" | "internal" = "conflict",
): never {
  throw new ApplicationError(category, code);
}
export function sourceUploadHash(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
/** Native copy ignores caller length/iterator/accessors. This never deserializes JSON bytes. */
export function sourceUploadBytes(
  input: unknown,
  maximumBytes = 20_000_000,
  expectedBytes: number | null = null,
): Uint8Array {
  if (types.isProxy(input) || !(input instanceof Uint8Array))
    sourceUploadFailure("project_source_upload_bytes_invalid", "validation");
  let length: number;
  try {
    length = nativeByteLength.call(input);
  } catch {
    return sourceUploadFailure(
      "project_source_upload_bytes_invalid",
      "validation",
    );
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 20_000_000 ||
    length < 1 ||
    length > maximumBytes ||
    (expectedBytes !== null && length !== expectedBytes)
  )
    sourceUploadFailure("project_source_upload_bytes_invalid", "validation");
  const copy = new Uint8Array(length);
  nativeSet.call(copy, input);
  return copy;
}
export function sourceUploadJson(value: unknown): string {
  // Internal records can exceed the small public JSON budget (306 part descriptors).
  // Deterministic order also survives PostgreSQL JSONB's key order normalization.
  return JSON.stringify(canonical(value, 0));
}
function canonical(value: unknown, depth: number): unknown {
  if (depth > 32)
    sourceUploadFailure("project_source_upload_ledger_mismatch", "internal");
  if (Array.isArray(value))
    return value.map((item) => canonical(item, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  return value;
}
export function sourceUploadSame(actual: unknown, expected: unknown): void {
  if (sourceUploadJson(actual) !== sourceUploadJson(expected))
    sourceUploadFailure("project_source_upload_ledger_mismatch", "internal");
}
export function sourceUploadOwner(
  actor: ActorContext,
): CreativeProjectOwnerScope {
  return Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  });
}
export function sourceUploadOwnerValues(
  owner: CreativeProjectOwnerScope,
): readonly [string, string, string] {
  return [owner.tenantId, owner.spaceId, owner.principalId];
}
export function sourceUploadRead<
  const E extends readonly string[] = readonly [],
>(input: unknown, extras: E = [] as unknown as E) {
  const raw = sourceUploadFields(input, ["owner", "uploadId", ...extras]);
  const fields = sourceUploadFields(raw.owner, [
    "tenantId",
    "spaceId",
    "principalId",
  ]);
  const owner = Object.freeze({
    tenantId: creativeProjectOpaqueId(fields.tenantId),
    spaceId: creativeProjectOpaqueId(fields.spaceId),
    principalId: creativeProjectOpaqueId(fields.principalId),
  });
  return Object.freeze({
    ...raw,
    owner,
    uploadId: creativeProjectOpaqueId(raw.uploadId),
  }) as Readonly<
    Record<E[number], unknown> & {
      owner: CreativeProjectOwnerScope;
      uploadId: string;
    }
  >;
}
export function sourceUploadMutation<
  const E extends readonly string[] = readonly [],
>(input: unknown, extras: E = [] as unknown as E) {
  const raw = sourceUploadFields(input, [
    "actor",
    "uploadId",
    "expectedRevision",
    "at",
    ...extras,
  ]);
  const actor = validateCreativeProjectActor(raw.actor);
  return Object.freeze({
    ...raw,
    actor,
    owner: sourceUploadOwner(actor),
    uploadId: creativeProjectOpaqueId(raw.uploadId),
    expectedRevision: creativeProjectRevision(raw.expectedRevision),
    at: creativeProjectTimestamp(raw.at),
  }) as Readonly<
    Record<E[number], unknown> & {
      actor: ActorContext;
      owner: CreativeProjectOwnerScope;
      uploadId: string;
      expectedRevision: number;
      at: string;
    }
  >;
}
export function sourceUploadBeginIdentity(input: unknown, withInitial = false) {
  const raw = sourceUploadFields(input, [
    "actor",
    "receipt",
    ...(withInitial ? ["initial"] : []),
  ]);
  const actor = validateCreativeProjectActor(raw.actor),
    receipt = sourceUploadFields(raw.receipt, [
      "idempotencyKey",
      "requestDigest",
    ]);
  return Object.freeze({
    actor,
    owner: sourceUploadOwner(actor),
    receipt: Object.freeze({
      idempotencyKey: creativeProjectOpaqueId(receipt.idempotencyKey),
      requestDigest: creativeProjectDigest(receipt.requestDigest),
    }),
    initial: withInitial ? captureSourceUploadInitial(raw.initial) : null,
  });
}
export function sourceUploadAuthority(
  input: unknown,
  owner: CreativeProjectOwnerScope,
  uploadId: string | null,
  actions: readonly ProjectSourceUploadCommitAuthority["permission"]["action"][],
  actor?: ActorContext,
): ProjectSourceUploadCommitAuthority {
  const authority = captureSourceUploadAuthority(input),
    permission = authority.permission;
  if (
    !actions.includes(permission.action) ||
    permission.resource.uploadId !== uploadId ||
    sourceUploadJson(permission.resource.owner) !== sourceUploadJson(owner) ||
    (actor !== undefined &&
      sourceUploadJson(permission.actor) !== sourceUploadJson(actor))
  )
    sourceUploadFailure(
      "project_source_upload_authority_mismatch",
      "validation",
    );
  return authority;
}
export { assertSourceUploadActive, assertSourceUploadCurrent };
export function sourceUploadInitialState(
  input: ProjectSourceUploadInitial,
): ProjectSourceUploadState {
  const initial = captureSourceUploadInitial(input);
  return captureSourceUploadState({
    initial,
    revision: 1,
    phase: "receiving",
    updatedAt: initial.createdAt,
    parts: [],
    sealed: null,
    claim: null,
    prepared: null,
    failureCode: null,
  });
}
export function sourceUploadAssertRevision(
  state: ProjectSourceUploadState,
  expectedRevision: number,
  at: string,
): void {
  if (state.revision !== expectedRevision)
    sourceUploadFailure("project_source_upload_revision_conflict");
  if (at < state.updatedAt)
    sourceUploadFailure("project_source_upload_time_regression");
}
export function sourceUploadAdvance(
  state: ProjectSourceUploadState,
  at: string,
  patch: Partial<
    Pick<
      ProjectSourceUploadState,
      "phase" | "parts" | "sealed" | "claim" | "prepared" | "failureCode"
    >
  >,
): ProjectSourceUploadState {
  sourceUploadAssertRevision(state, state.revision, at);
  return captureSourceUploadState({
    ...state,
    ...patch,
    revision: creativeProjectRevision(state.revision + 1),
    updatedAt: at,
  });
}
export function sourceUploadAssertPhase(
  state: ProjectSourceUploadState,
  phases: readonly ProjectSourceUploadState["phase"][],
): void {
  if (!phases.includes(state.phase))
    sourceUploadFailure("project_source_upload_state_conflict");
}
export function sourceUploadCapturePart(
  state: ProjectSourceUploadState,
  input: unknown,
  rawBytes: unknown,
) {
  const part = captureSourceUploadPart(input, state.initial),
    bytes = sourceUploadBytes(rawBytes, 65_536, part.byteLength);
  if (sourceUploadHash(bytes) !== part.rawDigest)
    sourceUploadFailure(
      "project_source_upload_part_digest_mismatch",
      "validation",
    );
  return Object.freeze({ part, bytes });
}
/** Seal binds every descriptor and the complete original-byte identity; no giant JSON body. */
export function sourceUploadSealDigest(
  initial: ProjectSourceUploadInitial,
  parts: readonly ProjectSourceUploadPart[],
): string {
  const hash = createHash("sha256").update(
    "crewon.project-source-upload.raw-manifest.v1\n",
  );
  hash
    .update(sourceUploadJson(captureSourceUploadInitial(initial)))
    .update("\n");
  for (const part of parts)
    hash
      .update(sourceUploadJson(captureSourceUploadPart(part, initial)))
      .update("\n");
  return `sha256:${hash.digest("hex")}`;
}
/** Caller reads immutable rows before calling; byte copies/full hash run outside write SQL. */
export function sourceUploadRawSnapshot(
  state: ProjectSourceUploadState,
  rows: readonly Readonly<{
    part: ProjectSourceUploadPart;
    bytes: Uint8Array;
  }>[],
): Uint8Array {
  if (
    rows.length !== state.initial.partCount ||
    state.parts.length !== rows.length
  )
    sourceUploadFailure("project_source_upload_parts_incomplete");
  const bytes = new Uint8Array(state.initial.byteLength);
  for (let index = 0; index < rows.length; index++) {
    const item = rows[index]!,
      captured = sourceUploadCapturePart(state, item.part, item.bytes);
    if (captured.part.index !== index)
      sourceUploadFailure("project_source_upload_parts_incomplete");
    sourceUploadSame(captured.part, state.parts[index]);
    nativeSet.call(bytes, captured.bytes, captured.part.byteOffset);
  }
  if (sourceUploadHash(bytes) !== state.initial.fileDigest)
    sourceUploadFailure(
      "project_source_upload_file_digest_mismatch",
      "validation",
    );
  if (
    state.sealed !== null &&
    sourceUploadSealDigest(state.initial, state.parts) !==
      state.sealed.uploadDigest
  )
    sourceUploadFailure("project_source_upload_ledger_mismatch", "internal");
  return bytes;
}
export function sourceUploadClaim(
  state: ProjectSourceUploadState,
  input: unknown,
  at: string,
) {
  const claim = captureSourceUploadClaim(input);
  if (claim.expiresAt <= at)
    sourceUploadFailure("project_source_upload_claim_expired", "validation");
  return claim;
}
export function sourceUploadAssertClaim(
  state: ProjectSourceUploadState,
  claimId: string,
  at?: string,
): void {
  sourceUploadAssertPhase(state, ["preparing"]);
  if (state.claim === null || state.claim.claimId !== claimId)
    sourceUploadFailure("project_source_upload_claim_conflict");
  if (at !== undefined && state.claim.expiresAt <= at)
    sourceUploadFailure("project_source_upload_claim_expired");
}
export type SourceUploadPreparedBundle = Readonly<{
  manifest: ProjectSourceUploadPreparedManifest;
  source: ProjectSourceUploadPreparedSource;
}>;
/** Capture a caller recipe synchronously, before PDP or database awaits can run caller code. */
export function sourceUploadParsed(
  input: unknown,
  actor: ActorContext,
  uploadId: string,
): ProjectSourceUploadParsedFile {
  const raw = sourceUploadFields(input, [
    "fileName",
    "format",
    "byteLength",
    "characterLength",
    "digest",
    "fileDigest",
    "chunks",
    "chapters",
  ]);
  const captured = capturePreparedProjectSource(
    { ...raw, owner: sourceUploadOwner(actor), uploadId },
    {
      actor,
      uploadId,
      fileDigest: creativeProjectDigest(raw.fileDigest),
      projectId: null,
    },
    sourceUploadTextDigester,
  );
  const { owner: _owner, uploadId: _uploadId, ...parsed } = captured;
  return Object.freeze(parsed);
}
/** Strict normalized recipe plus chunk/chapter roots. File digest/length refer to actual sealed bytes. */
export function sourceUploadPreparedBundle(
  state: ProjectSourceUploadState,
  input: ProjectSourceUploadParsedFile,
  preparedAt: string,
): SourceUploadPreparedBundle {
  if (state.sealed === null || state.claim === null)
    sourceUploadFailure("project_source_upload_state_conflict");
  const raw = sourceUploadFields(input, [
    "fileName",
    "format",
    "byteLength",
    "characterLength",
    "digest",
    "fileDigest",
    "chunks",
    "chapters",
  ]);
  const source = capturePreparedProjectSource(
    { ...raw, uploadId: state.initial.uploadId, owner: state.initial.owner },
    {
      actor: {
        ...state.initial.owner,
        actorId: state.initial.createdByActorId,
      },
      uploadId: state.initial.uploadId,
      fileDigest: state.initial.fileDigest,
      projectId: null,
    },
    sourceUploadTextDigester,
  );
  for (const field of [
    "fileName",
    "format",
    "byteLength",
    "fileDigest",
  ] as const)
    sourceUploadSame(source[field], state.initial[field]);
  let normalizedByteLength = 0;
  const chunks = createHash("sha256").update(
      "crewon.project-source-upload.chunks.v1\n",
    ),
    chapters = createHash("sha256").update(
      "crewon.project-source-upload.chapters.v1\n",
    );
  for (const chunk of source.chunks) {
    const byteLength = Buffer.byteLength(chunk.content);
    normalizedByteLength += byteLength;
    chunks
      .update(
        sourceUploadJson({
          index: chunk.index,
          startOffset: chunk.startOffset,
          characterLength: projectSourceScalarLength(chunk.content),
          byteLength,
          digest: chunk.digest,
        }),
      )
      .update("\n");
  }
  for (const chapter of source.chapters)
    chapters.update(sourceUploadJson(chapter)).update("\n");
  const manifest = sourceUploadPreparedManifest(
    state,
    {
      digest: source.digest,
      normalizedByteLength,
      characterLength: source.characterLength,
      chunkCount: source.chunks.length,
      chapterCount: source.chapters.length,
      chunkManifestDigest: `sha256:${chunks.digest("hex")}`,
      chapterManifestDigest: `sha256:${chapters.digest("hex")}`,
    },
    preparedAt,
  );
  return Object.freeze({
    manifest,
    source: Object.freeze({ ...source, provenance: manifest.pointer }),
  });
}
/** Rebind precomputed content roots to the original preparation time without rehashing the book. */
export function sourceUploadPreparedManifest(
  state: ProjectSourceUploadState,
  metrics: Omit<ProjectSourceUploadPreparedManifest, "pointer" | "preparedAt">,
  preparedAt: string,
): ProjectSourceUploadPreparedManifest {
  if (state.sealed === null || state.claim === null)
    sourceUploadFailure("project_source_upload_state_conflict");
  const body = {
    version: "crewon.project-source-upload-prepared.v1" as const,
    storageRealmId: state.initial.storageRealmId,
    uploadId: state.initial.uploadId,
    uploadDigest: state.sealed.uploadDigest,
    normalizationParserVersion: state.claim.normalizationParserVersion,
    ...metrics,
    preparedAt: creativeProjectTimestamp(preparedAt),
  };
  const preparedDigest = sourceUploadHash(
    "crewon.project-source-upload.prepared-manifest.v1\n" +
      sourceUploadJson(body),
  );
  const pointer = Object.freeze({
    version: body.version,
    storageRealmId: body.storageRealmId,
    uploadId: body.uploadId,
    uploadDigest: body.uploadDigest,
    preparedDigest,
    normalizationParserVersion: body.normalizationParserVersion,
  });
  const manifest = Object.freeze({
    pointer,
    digest: body.digest,
    normalizedByteLength: body.normalizedByteLength,
    characterLength: body.characterLength,
    chunkCount: body.chunkCount,
    chapterCount: body.chapterCount,
    chunkManifestDigest: body.chunkManifestDigest,
    chapterManifestDigest: body.chapterManifestDigest,
    preparedAt: body.preparedAt,
  });
  captureSourceUploadState({
    ...state,
    revision:
      state.phase === "ready"
        ? state.revision
        : creativeProjectRevision(state.revision + 1),
    phase: "ready",
    prepared: manifest,
    updatedAt: preparedAt,
  });
  return manifest;
}
export function sourceUploadVerifyPrepared(
  state: ProjectSourceUploadState,
  parsed: ProjectSourceUploadParsedFile,
): ProjectSourceUploadPreparedSource {
  sourceUploadAssertPhase(state, ["ready"]);
  const bundle = sourceUploadPreparedBundle(
    state,
    parsed,
    state.prepared!.preparedAt,
  );
  sourceUploadSame(bundle.manifest, state.prepared);
  return bundle.source;
}
