import {
  assertProjectSourceChapterIdentity,
  assertProjectSourceChunkIdentity,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  parseProjectSource,
  parseProjectSourceChapter,
  parseProjectSourceChunk,
  PROJECT_SOURCE_MAX_FILE_BYTES,
  projectSourceScalarLength,
  validateCreativeProjectActor,
  type ProjectSourceFormat,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectOwnerScope } from "./creative-project-store-port.ts";
import type {
  ProjectSourceUploadPreparedPointer,
  ProjectSourceUploadCommitAuthority,
} from "./project-source-upload-port.ts";
import { captureSourceUploadPreparedPointer } from "./project-source-upload-prepared-pointer.ts";

/** The public command names an uploaded file; it never supplies source records or owner. */
export type ProjectSourceUploadReference = Readonly<{
  uploadId: string;
  fileDigest: string;
}>;

export type ProjectSourcePreparationRequest = Readonly<{
  actor: ActorContext;
  uploadId: string;
  fileDigest: string;
  /** null for new project creation; exact existing ID for appending a source. */
  projectId: string | null;
}>;

/**
 * Internal byte-reader result. Its original-byte digest and length must come from the actual
 * uploaded bytes, not request metadata. The host binds uploader ownership before returning it.
 * This is neither a model payload nor evidence that a file has been consumed transactionally.
 */
export type PreparedProjectSource = Readonly<{
  uploadId: string;
  owner: CreativeProjectOwnerScope;
  fileName: string;
  format: ProjectSourceFormat;
  byteLength: number;
  characterLength: number;
  digest: string;
  fileDigest: string;
  chunks: readonly Readonly<{
    index: number;
    startOffset: number;
    content: string;
    digest: string;
  }>[];
  chapters: readonly Readonly<{
    chapterId: string;
    title: string;
    startOffset: number;
    endOffset: number;
  }>[];
  /** Host-issued ledger locator; not a model/public command or a transaction grant. */
  provenance?: ProjectSourceUploadPreparedPointer;
}>;

export interface ProjectSourcePreparationPort {
  /** Same principal may use a UI upload through Agent; a different owner must not see it. */
  loadPrepared(
    request: ProjectSourcePreparationRequest,
  ): Promise<PreparedProjectSource | null>;
  /** Independent live adopt PDP. Required for durable sources, never persisted in a recipe. */
  captureAdoptionAuthority?(
    request: ProjectSourcePreparationRequest,
  ): ProjectSourceUploadCommitAuthority;
}

/**
 * Detach and verify the bounded internal recipe before assigning a project identity. The Store
 * independently verifies the resulting scoped recipe. This cannot prove original bytes that
 * were not supplied: only the actual host parser/byte-reader may implement this port.
 */
export function capturePreparedProjectSource(
  input: unknown,
  request: ProjectSourcePreparationRequest,
  digester: ContentDigester,
): PreparedProjectSource {
  try {
    const actor = validateCreativeProjectActor(request.actor);
    const uploadId = creativeProjectOpaqueId(request.uploadId);
    const requestedDigest = creativeProjectDigest(request.fileDigest);
    if (request.projectId !== null) creativeProjectOpaqueId(request.projectId);
    const value = fields(
      input,
      [
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
      ],
      ["provenance"],
    );
    const ownerFields = fields(value.owner, [
      "tenantId",
      "spaceId",
      "principalId",
    ]);
    const owner = Object.freeze({
      tenantId: creativeProjectOpaqueId(ownerFields.tenantId),
      spaceId: creativeProjectOpaqueId(ownerFields.spaceId),
      principalId: creativeProjectOpaqueId(ownerFields.principalId),
    });
    if (
      owner.tenantId !== actor.tenantId ||
      owner.spaceId !== actor.spaceId ||
      owner.principalId !== actor.principalId ||
      creativeProjectOpaqueId(value.uploadId) !== uploadId
    )
      throw new ApplicationError("notFound", "project_source_upload_not_found");
    if (creativeProjectDigest(value.fileDigest) !== requestedDigest)
      throw new ApplicationError(
        "conflict",
        "project_source_upload_digest_mismatch",
      );
    const provenance = Object.hasOwn(value, "provenance")
      ? captureSourceUploadPreparedPointer(value.provenance)
      : undefined;
    if (provenance !== undefined && provenance.uploadId !== uploadId) invalid();

    // Domain parsing validates these data shapes only; this temporary identity grants nothing.
    const scope = {
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      projectId: "source-preparation-validation",
    };
    const source = parseProjectSource({
      schemaVersion: "crewon.project-source.v1",
      ...scope,
      revision: 1,
      digest: value.digest,
      fileDigest: value.fileDigest,
      fileName: value.fileName,
      format: value.format,
      byteLength: value.byteLength,
      characterLength: value.characterLength,
      createdByActorId: actor.actorId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const suffix = {
      txt: /\.txt$/iu,
      md: /\.(?:md|markdown)$/iu,
      html: /\.html?$/iu,
    };
    if (!suffix[source.format].test(source.fileName)) invalid();

    let offset = 0;
    let bytes = 0;
    const chunks = array(value.chunks, false, (raw, index) => {
      const chunkFields = fields(raw, [
        "index",
        "startOffset",
        "content",
        "digest",
      ]);
      const chunk = parseProjectSourceChunk({
        ...chunkFields,
        ...scope,
        sourceRevision: 1,
      });
      assertProjectSourceChunkIdentity(source, chunk);
      if (
        chunk.index !== index ||
        chunk.startOffset !== offset ||
        creativeProjectDigest(digester.sha256(chunk.content)) !== chunk.digest
      )
        invalid();
      offset += projectSourceScalarLength(chunk.content);
      bytes += new TextEncoder().encode(chunk.content).length;
      if (bytes > PROJECT_SOURCE_MAX_FILE_BYTES) invalid();
      return Object.freeze({
        index: chunk.index,
        startOffset: chunk.startOffset,
        content: chunk.content,
        digest: chunk.digest,
      });
    });
    if (
      offset !== source.characterLength ||
      creativeProjectDigest(
        digester.sha256(chunks.map((chunk) => chunk.content).join("")),
      ) !== source.digest
    )
      invalid();
    let previousEnd = 0;
    const seen = new Set<string>();
    const chapters = array(value.chapters, true, (raw) => {
      const chapterFields = fields(raw, [
        "chapterId",
        "title",
        "startOffset",
        "endOffset",
      ]);
      const chapter = parseProjectSourceChapter({
        ...chapterFields,
        ...scope,
        sourceRevision: 1,
      });
      assertProjectSourceChapterIdentity(source, chapter);
      if (seen.has(chapter.chapterId) || chapter.startOffset < previousEnd)
        invalid();
      previousEnd = chapter.endOffset;
      seen.add(chapter.chapterId);
      return Object.freeze({
        chapterId: chapter.chapterId,
        title: chapter.title,
        startOffset: chapter.startOffset,
        endOffset: chapter.endOffset,
      });
    });
    return Object.freeze({
      uploadId,
      owner,
      fileName: source.fileName,
      format: source.format,
      byteLength: source.byteLength,
      characterLength: source.characterLength,
      digest: source.digest,
      fileDigest: source.fileDigest,
      chunks,
      chapters,
      ...(provenance === undefined ? {} : { provenance }),
    });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "internal",
      "project_source_preparation_invalid",
      {
        cause: error,
      },
    );
  }
}

function fields(
  input: unknown,
  names: readonly string[],
  optional: readonly string[] = [],
) {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length < names.length ||
    keys.length > names.length + optional.length ||
    keys.some(
      (key) =>
        typeof key !== "string" || ![...names, ...optional].includes(key),
    )
  )
    invalid();
  return Object.fromEntries(
    [...names, ...optional.filter((name) => Object.hasOwn(input, name))].map(
      (name) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          invalid();
        return [name, descriptor.value];
      },
    ),
  );
}

function array<T>(
  input: unknown,
  allowEmpty: boolean,
  parse: (raw: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < (allowEmpty ? 0 : 1) ||
    length > 20_000 ||
    Reflect.ownKeys(input).length !== length + 1
  )
    invalid();
  return Object.freeze(
    Array.from({ length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid();
      return parse(descriptor.value, index);
    }),
  );
}

function invalid(): never {
  throw new Error("project_source_preparation_invalid");
}
