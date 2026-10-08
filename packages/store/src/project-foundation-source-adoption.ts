import { createHash } from "node:crypto";
import {
  captureSourceUploadPreparedPointer,
  type ProjectSourceUploadPreparedManifest,
  type ProjectSourceUploadPreparedPointer,
  type ProjectSourceUploadState,
} from "@crewon/application";
import { projectSourceScalarLength, type ProjectSource } from "@crewon/domain";
import {
  foundationFailure,
  type FoundationPrepared,
} from "./project-foundation-store-support.ts";
import {
  sourceUploadJson,
  sourceUploadPreparedManifest,
  sourceUploadSame,
  sourceUploadSealDigest,
} from "./project-source-upload-store-support.ts";

export type FoundationSourceAdmission = "trusted-internal-recipe";
export type FoundationSourceAdoption = Readonly<{
  pointer: ProjectSourceUploadPreparedPointer;
  source: ProjectSource;
  owner: Readonly<{ tenantId: string; spaceId: string; principalId: string }>;
  metrics: Omit<ProjectSourceUploadPreparedManifest, "pointer" | "preparedAt">;
  chunks: readonly Readonly<{
    index: number;
    startOffset: number;
    characterLength: number;
    byteLength: number;
    digest: string;
  }>[];
  chapters: readonly Readonly<{
    chapterId: string;
    title: string;
    startOffset: number;
    endOffset: number;
  }>[];
  association: Readonly<{
    schemaVersion: "crewon.project-source-upload-association.v1";
    owner: Readonly<{ tenantId: string; spaceId: string; principalId: string }>;
    pointer: ProjectSourceUploadPreparedPointer;
    projectId: string;
    sourceRevision: number;
    sourceDigest: string;
    fileDigest: string;
    createdByActorId: string;
    createdAt: string;
  }>;
}>;

/** Only descriptor roots are computed here, before borrowing the committing connection. */
export function prepareFoundationSourceAdoption(
  prepared: FoundationPrepared,
  admission?: FoundationSourceAdmission,
): FoundationSourceAdoption | null {
  if (prepared.kind === "save-proposal") return null;
  const pointer = prepared.sourceUpload;
  const source = prepared.source;
  if (source === null) {
    if (pointer !== undefined)
      foundationFailure("project_foundation_source_provenance_invalid");
    return null;
  }
  if (pointer === undefined) {
    if (admission !== "trusted-internal-recipe")
      foundationFailure("project_foundation_source_provenance_required");
    return null;
  }
  const captured = captureSourceUploadPreparedPointer(pointer);
  const owner = Object.freeze({
    tenantId: prepared.actor.tenantId,
    spaceId: prepared.actor.spaceId,
    principalId: prepared.actor.principalId,
  });
  const chunkRoot = createHash("sha256").update(
    "crewon.project-source-upload.chunks.v1\n",
  );
  let normalizedByteLength = 0;
  const chunks = Object.freeze(
    prepared.chunks.map((chunk) => {
      const descriptor = Object.freeze({
        index: chunk.index,
        startOffset: chunk.startOffset,
        characterLength: projectSourceScalarLength(chunk.content),
        byteLength: Buffer.byteLength(chunk.content),
        digest: chunk.digest,
      });
      normalizedByteLength += descriptor.byteLength;
      chunkRoot.update(sourceUploadJson(descriptor)).update("\n");
      return descriptor;
    }),
  );
  const chapterRoot = createHash("sha256").update(
    "crewon.project-source-upload.chapters.v1\n",
  );
  const chapters = Object.freeze(
    prepared.chapters.map((chapter) => {
      const descriptor = Object.freeze({
        chapterId: chapter.chapterId,
        title: chapter.title,
        startOffset: chapter.startOffset,
        endOffset: chapter.endOffset,
      });
      chapterRoot.update(sourceUploadJson(descriptor)).update("\n");
      return descriptor;
    }),
  );
  const metrics = Object.freeze({
    digest: source.digest,
    normalizedByteLength,
    characterLength: source.characterLength,
    chunkCount: chunks.length,
    chapterCount: chapters.length,
    chunkManifestDigest: `sha256:${chunkRoot.digest("hex")}`,
    chapterManifestDigest: `sha256:${chapterRoot.digest("hex")}`,
  });
  return Object.freeze({
    pointer: captured,
    source,
    owner,
    metrics,
    chunks,
    chapters,
    association: Object.freeze({
      schemaVersion: "crewon.project-source-upload-association.v1" as const,
      owner,
      pointer: captured,
      projectId: source.projectId,
      sourceRevision: source.revision,
      sourceDigest: source.digest,
      fileDigest: source.fileDigest,
      createdByActorId: prepared.actor.actorId,
      createdAt: source.createdAt,
    }),
  });
}

/** A pointer is data, not authority. Match the actual immutable ledger in this transaction. */
export function assertFoundationSourceAdoptionState(
  proof: FoundationSourceAdoption,
  state: ProjectSourceUploadState | null,
): void {
  if (state === null)
    foundationFailure("project_foundation_source_upload_not_found");
  if (
    state.phase !== "ready" ||
    state.prepared === null ||
    state.sealed === null
  )
    foundationFailure("project_foundation_source_upload_not_ready");
  sourceUploadSame(proof.owner, state.initial.owner);
  sourceUploadSame(proof.pointer, state.prepared.pointer);
  sourceUploadSame(
    sourceUploadSealDigest(state.initial, state.parts),
    state.sealed.uploadDigest,
  );
  for (const field of [
    "fileName",
    "format",
    "byteLength",
    "fileDigest",
  ] as const)
    sourceUploadSame(proof.source[field], state.initial[field]);
  sourceUploadSame(
    sourceUploadPreparedManifest(
      state,
      proof.metrics,
      state.prepared.preparedAt,
    ),
    state.prepared,
  );
}

export function assertFoundationSourceAdoptionChunks(
  proof: FoundationSourceAdoption,
  actual: readonly FoundationSourceAdoption["chunks"][number][],
): void {
  if (actual.length !== proof.chunks.length)
    foundationFailure("project_foundation_source_upload_chunks_mismatch");
  actual.forEach((chunk, i) => sourceUploadSame(chunk, proof.chunks[i]));
}

export function assertFoundationSourceAdoptionChapters(
  proof: FoundationSourceAdoption,
  actual: readonly FoundationSourceAdoption["chapters"][number][],
): void {
  if (actual.length !== proof.chapters.length)
    foundationFailure("project_foundation_source_upload_chapters_mismatch");
  actual.forEach((chapter, i) => sourceUploadSame(chapter, proof.chapters[i]));
}
