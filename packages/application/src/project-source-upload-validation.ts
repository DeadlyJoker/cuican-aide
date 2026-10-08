import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  parseProjectSource,
  validateCreativeProjectActor,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  captureProjectSourceUploadPluginCommitTransaction,
  qualifyProjectSourceUploadPluginCommit,
} from "./project-source-upload-plugin-commit-authority.ts";
import {
  capturePreparedProjectSource,
  type ProjectSourcePreparationRequest,
} from "./project-source-preparation-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { captureSourceUploadPreparedPointer } from "./project-source-upload-prepared-pointer.ts";
export { captureSourceUploadPreparedPointer } from "./project-source-upload-prepared-pointer.ts";
import {
  PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_PARTS,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadInitial,
  type ProjectSourceUploadPart,
  type ProjectSourceUploadPermission,
  type ProjectSourceUploadPreparationClaim,
  type ProjectSourceUploadPreparedSource,
  type ProjectSourceUploadState,
} from "./project-source-upload-port.ts";

export function sourceUploadFields(
  input: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key)) ||
    Object.values(descriptors).some(
      (d) => !d.enumerable || !Object.hasOwn(d, "value"),
    )
  )
    invalid();
  return Object.fromEntries(
    names.map((name) => [name, descriptors[name]!.value]),
  );
}
export function sourceUploadInteger(
  input: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    invalid();
  return input;
}
function owner(input: unknown) {
  const o = sourceUploadFields(input, ["tenantId", "spaceId", "principalId"]);
  return Object.freeze({
    tenantId: creativeProjectOpaqueId(o.tenantId),
    spaceId: creativeProjectOpaqueId(o.spaceId),
    principalId: creativeProjectOpaqueId(o.principalId),
  });
}
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "validation",
      "project_source_upload_record_invalid",
      { cause: error },
    );
  }
}
export function captureSourceUploadInitial(
  input: unknown,
): ProjectSourceUploadInitial {
  return checked(() => {
    const v = sourceUploadFields(input, [
      "schemaVersion",
      "storageRealmId",
      "uploadId",
      "owner",
      "fileName",
      "format",
      "byteLength",
      "fileDigest",
      "partBytes",
      "partCount",
      "requestDigest",
      "createdByActorId",
      "createdAt",
    ]);
    const scope = owner(v.owner);
    if (
      v.schemaVersion !== "crewon.project-source-upload.v1" ||
      v.partBytes !== PROJECT_SOURCE_UPLOAD_PART_BYTES
    )
      invalid();
    const fileDigest = creativeProjectDigest(v.fileDigest);
    const source = parseProjectSource({
      schemaVersion: "crewon.project-source.v1",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      projectId: "upload-validation",
      revision: 1,
      digest: fileDigest,
      fileDigest,
      fileName: v.fileName,
      format: v.format,
      byteLength: v.byteLength,
      characterLength: 1,
      createdByActorId: v.createdByActorId,
      createdAt: v.createdAt,
    });
    const suffix = {
      txt: /\.txt$/iu,
      md: /\.(?:md|markdown)$/iu,
      html: /\.html?$/iu,
    };
    if (
      !suffix[source.format].test(source.fileName) ||
      v.partCount !==
        Math.ceil(source.byteLength / PROJECT_SOURCE_UPLOAD_PART_BYTES)
    )
      invalid();
    return Object.freeze({
      schemaVersion: "crewon.project-source-upload.v1",
      storageRealmId: creativeProjectOpaqueId(v.storageRealmId),
      uploadId: creativeProjectOpaqueId(v.uploadId),
      owner: scope,
      fileName: source.fileName,
      format: source.format,
      byteLength: source.byteLength,
      fileDigest,
      partBytes: PROJECT_SOURCE_UPLOAD_PART_BYTES,
      partCount: sourceUploadInteger(
        v.partCount,
        1,
        PROJECT_SOURCE_UPLOAD_MAX_PARTS,
      ),
      requestDigest: creativeProjectDigest(v.requestDigest),
      createdByActorId: source.createdByActorId,
      createdAt: source.createdAt,
    });
  });
}
export function captureSourceUploadPart(
  input: unknown,
  initial: ProjectSourceUploadInitial,
): ProjectSourceUploadPart {
  return checked(() => {
    const v = sourceUploadFields(input, [
      "index",
      "byteOffset",
      "byteLength",
      "rawDigest",
    ]);
    const index = sourceUploadInteger(v.index, 0, initial.partCount - 1),
      byteOffset = index * PROJECT_SOURCE_UPLOAD_PART_BYTES;
    const byteLength = Math.min(
      PROJECT_SOURCE_UPLOAD_PART_BYTES,
      initial.byteLength - byteOffset,
    );
    if (v.byteOffset !== byteOffset || v.byteLength !== byteLength) invalid();
    return Object.freeze({
      index,
      byteOffset,
      byteLength,
      rawDigest: creativeProjectDigest(v.rawDigest),
    });
  });
}
export function captureSourceUploadClaim(
  input: unknown,
): ProjectSourceUploadPreparationClaim {
  return checked(() => {
    const v = sourceUploadFields(input, [
      "claimId",
      "normalizationParserVersion",
      "expiresAt",
    ]);
    return Object.freeze({
      claimId: creativeProjectOpaqueId(v.claimId),
      normalizationParserVersion: creativeProjectOpaqueId(
        v.normalizationParserVersion,
      ),
      expiresAt: creativeProjectTimestamp(v.expiresAt),
    });
  });
}
export function captureSourceUploadState(
  input: unknown,
): ProjectSourceUploadState {
  return checked(() => {
    const v = sourceUploadFields(input, [
      "initial",
      "revision",
      "phase",
      "updatedAt",
      "parts",
      "sealed",
      "claim",
      "prepared",
      "failureCode",
    ]);
    const initial = captureSourceUploadInitial(v.initial),
      revision = creativeProjectRevision(v.revision),
      updatedAt = creativeProjectTimestamp(v.updatedAt);
    const phases = [
      "receiving",
      "raw-sealed",
      "preparing",
      "ready",
      "rejected",
      "cancelled",
      "expired",
    ];
    if (!phases.includes(v.phase as string) || updatedAt < initial.createdAt)
      invalid();
    const parts = items(v.parts, PROJECT_SOURCE_UPLOAD_MAX_PARTS).map((p) =>
      captureSourceUploadPart(p, initial),
    );
    if (parts.some((p, i) => i > 0 && p.index <= parts[i - 1]!.index))
      invalid();
    let sealed: ProjectSourceUploadState["sealed"] = null;
    if (v.sealed !== null) {
      const s = sourceUploadFields(v.sealed, ["uploadDigest", "sealedAt"]);
      sealed = Object.freeze({
        uploadDigest: creativeProjectDigest(s.uploadDigest),
        sealedAt: creativeProjectTimestamp(s.sealedAt),
      });
      if (
        parts.length !== initial.partCount ||
        sealed.sealedAt < initial.createdAt ||
        sealed.sealedAt > updatedAt
      )
        invalid();
    }
    const claim = v.claim === null ? null : captureSourceUploadClaim(v.claim);
    let prepared: ProjectSourceUploadState["prepared"] = null;
    if (v.prepared !== null) {
      const p = sourceUploadFields(v.prepared, [
        "pointer",
        "digest",
        "normalizedByteLength",
        "characterLength",
        "chunkCount",
        "chapterCount",
        "chunkManifestDigest",
        "chapterManifestDigest",
        "preparedAt",
      ]);
      const pointer = captureSourceUploadPreparedPointer(p.pointer),
        preparedAt = creativeProjectTimestamp(p.preparedAt);
      if (
        !sealed ||
        !claim ||
        pointer.storageRealmId !== initial.storageRealmId ||
        pointer.uploadId !== initial.uploadId ||
        pointer.uploadDigest !== sealed.uploadDigest ||
        pointer.normalizationParserVersion !==
          claim.normalizationParserVersion ||
        preparedAt < sealed.sealedAt ||
        preparedAt > updatedAt
      )
        invalid();
      prepared = Object.freeze({
        pointer,
        digest: creativeProjectDigest(p.digest),
        normalizedByteLength: sourceUploadInteger(
          p.normalizedByteLength,
          1,
          PROJECT_SOURCE_UPLOAD_MAX_BYTES,
        ),
        characterLength: sourceUploadInteger(
          p.characterLength,
          1,
          PROJECT_SOURCE_UPLOAD_MAX_BYTES,
        ),
        chunkCount: sourceUploadInteger(p.chunkCount, 1, 20_000),
        chapterCount: sourceUploadInteger(p.chapterCount, 0, 20_000),
        chunkManifestDigest: creativeProjectDigest(p.chunkManifestDigest),
        chapterManifestDigest: creativeProjectDigest(p.chapterManifestDigest),
        preparedAt,
      });
      if (
        prepared.characterLength > prepared.normalizedByteLength ||
        prepared.chunkCount > prepared.characterLength ||
        prepared.normalizedByteLength > prepared.chunkCount * 4_096
      )
        invalid();
    }
    const failureCode =
      v.failureCode === null ? null : creativeProjectOpaqueId(v.failureCode);
    if (
      (v.phase === "receiving" && (sealed || claim || prepared)) ||
      (v.phase === "raw-sealed" && (!sealed || claim || prepared)) ||
      (v.phase === "preparing" && (!sealed || !claim || prepared)) ||
      (v.phase === "ready" && (!sealed || !claim || !prepared)) ||
      (v.phase !== "ready" && prepared !== null) ||
      (v.phase === "rejected"
        ? !failureCode || !sealed || !claim
        : failureCode !== null)
    )
      invalid();
    if (claim && !sealed) invalid();
    if (
      revision < parts.length + 1 ||
      (sealed !== null && revision < parts.length + 2) ||
      (claim !== null &&
        (revision < parts.length + 3 || claim.expiresAt <= sealed!.sealedAt)) ||
      (prepared !== null && revision < parts.length + 4)
    )
      invalid();
    if (
      revision === 1 &&
      (v.phase !== "receiving" ||
        parts.length !== 0 ||
        updatedAt !== initial.createdAt)
    )
      invalid();
    return Object.freeze({
      initial,
      revision,
      phase: v.phase as ProjectSourceUploadState["phase"],
      updatedAt,
      parts: Object.freeze(parts),
      sealed,
      claim,
      prepared,
      failureCode,
    });
  });
}
export function captureSourceUploadPermission(
  input: unknown,
): ProjectSourceUploadPermission {
  return checked(() => {
    const v = sourceUploadFields(input, ["actor", "action", "resource"]),
      actor = validateCreativeProjectActor(v.actor),
      r = sourceUploadFields(v.resource, [
        "kind",
        "owner",
        "uploadId",
        "projectId",
      ]),
      scope = owner(r.owner);
    if (
      ![
        "projectSourceUpload:begin",
        "projectSourceUpload:write",
        "projectSourceUpload:status",
        "projectSourceUpload:prepare",
        "projectSourceUpload:cancel",
        "projectSourceUpload:adopt",
      ].includes(v.action as string) ||
      r.kind !== "projectSourceUpload" ||
      scope.tenantId !== actor.tenantId ||
      scope.spaceId !== actor.spaceId ||
      scope.principalId !== actor.principalId
    )
      invalid();
    const uploadId =
        r.uploadId === null ? null : creativeProjectOpaqueId(r.uploadId),
      projectId =
        r.projectId === null ? null : creativeProjectOpaqueId(r.projectId);
    if (
      (v.action === "projectSourceUpload:begin") !== (uploadId === null) ||
      (v.action !== "projectSourceUpload:adopt" && projectId !== null)
    )
      invalid();
    return Object.freeze({
      actor,
      action: v.action as ProjectSourceUploadPermission["action"],
      resource: Object.freeze({
        kind: "projectSourceUpload",
        owner: scope,
        uploadId,
        projectId,
      }),
    });
  });
}
export function captureSourceUploadAuthority(
  input: unknown,
): ProjectSourceUploadCommitAuthority {
  return checked(() => {
    const hasTransaction =
      input !== null &&
      typeof input === "object" &&
      Object.hasOwn(input, "transaction");
    const v = sourceUploadFields(input, [
      "version",
      "permission",
      "assertCurrent",
      "assertActive",
      ...(hasTransaction ? ["transaction"] : []),
    ]);
    if (
      v.version !== "crewon.project-source-upload-commit.v1" ||
      typeof v.assertCurrent !== "function" ||
      typeof v.assertActive !== "function"
    )
      invalid();
    const authority: ProjectSourceUploadCommitAuthority = Object.freeze({
      version: "crewon.project-source-upload-commit.v1",
      permission: captureSourceUploadPermission(v.permission),
      assertCurrent: v.assertCurrent.bind(input),
      assertActive: v.assertActive.bind(input),
      ...(v.transaction === undefined
        ? {}
        : {
            transaction: captureProjectSourceUploadPluginCommitTransaction(
              v.transaction,
            ),
          }),
    });
    qualifyProjectSourceUploadPluginCommit(authority);
    return authority;
  });
}
export async function assertSourceUploadCurrent(
  authority: ProjectSourceUploadCommitAuthority,
): Promise<void> {
  if ((await authority.assertCurrent()) !== undefined) invalid();
  assertSourceUploadActive(authority);
}
export function assertSourceUploadActive(
  authority: Pick<ProjectSourceUploadCommitAuthority, "assertActive">,
): void {
  const result: unknown = authority.assertActive();
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Never execute an arbitrary thenable. */
  }
  invalid();
}
export function captureSourceUploadPrepared(
  input: unknown,
  request: ProjectSourcePreparationRequest,
  digester: ContentDigester,
): ProjectSourceUploadPreparedSource {
  const v = sourceUploadFields(input, [
    "uploadId",
    "owner",
    "fileName",
    "format",
    "byteLength",
    "characterLength",
    "digest",
    "fileDigest",
    "chunks",
    "chapters",
    "provenance",
  ]);
  const { provenance, ...body } = v;
  const data = capturePreparedProjectSource(body, request, digester),
    pointer = captureSourceUploadPreparedPointer(provenance);
  if (pointer.uploadId !== data.uploadId) invalid();
  return Object.freeze({ ...data, provenance: pointer });
}
function items(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input),
    length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    length > maximum ||
    Reflect.ownKeys(descriptors).length !== length + 1 ||
    Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))
  )
    invalid();
  return Array.from({ length }, (_, i) => {
    const d = descriptors[String(i)];
    if (!d?.enumerable) invalid();
    return d.value;
  });
}
function invalid(): never {
  throw new ApplicationError(
    "validation",
    "project_source_upload_record_invalid",
  );
}
